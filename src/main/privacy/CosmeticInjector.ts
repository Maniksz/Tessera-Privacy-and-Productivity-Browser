import { app, type WebContents } from 'electron'
import {
  COSMETIC_GENERIC_CHANNEL,
  COSMETIC_SPECIFIC_CHANNEL,
  PROCEDURAL_CHANNEL,
  SCRIPTLET_CHANNEL,
  asDocumentFeatures,
  injectableDocumentUrl
} from '@shared/filters/injection.js'
import type { ScriptletCall } from '@shared/filters/scriptlets.js'
import type { ProceduralSelector } from '@shared/filters/procedural.js'
import { filteringExemptFor } from '@shared/filters/site-exemption.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { CosmeticFeedHandle } from './FilterEngine.js'

/**
 * Answers a page's requests for the CSS that hides what the blocker could not stop at the network.
 *
 * ## Why this exists at all
 *
 * Blocking a request removes the advert; it does not remove the space it occupied. A page that asked
 * for a 300x250 banner and did not get one still has a 300x250 hole with "Advertisement" above it. The
 * cosmetic half of a filter list is what closes that hole, and it is roughly a third of what a list
 * contains — fifty thousand rules in the four this browser ships with. Without this file every one of
 * them is parsed, indexed, and never used.
 *
 * ## Why a feed per document rather than one answer
 *
 * `FilterEngine.openCosmeticFeed` hands out a handle that remembers what it has already sent. A page
 * that reports its features five times as a single-page application builds itself gets only the
 * selectors that are new each time, instead of the same stylesheet five times over. The handle is per
 * *document*, so it is dropped and reopened when a view navigates — otherwise the second page on a
 * site would be told "nothing new" about selectors it had never received.
 *
 * ## Why not through the IPC contract
 *
 * A visited page has no bridge (spec 6) and cannot reach `ipcRenderer`; only its preload can. Putting
 * these two channels in `shared/ipc/channels.ts` would add two names that every page uses to the
 * surface `sender-policy.ts` defends, and defending them would mean allowing every content view to call
 * them — which is exactly what a per-`webContents` listener already achieves without widening anything.
 * Same reasoning as `FINGERPRINT_PLAN_CHANNEL`.
 */

export interface CosmeticInjectorOptions {
  /** Reads the current settings. Cosmetic filtering is one switch (`privacy.cosmeticFiltering`). */
  readonly getSettings: () => SettingsSnapshot
  /** Host-keyed rules for a document, or `null`. `FilterEngine.cosmeticStylesFor`. */
  readonly stylesFor: (documentUrl: string) => string | null
  /** An incremental view of the generic selectors. `FilterEngine.openCosmeticFeed`. */
  readonly openFeed: (documentUrl: string) => CosmeticFeedHandle
  /**
   * The scriptlets for a document. `FilterEngine.scriptletsFor`.
   *
   * Answered from here rather than from a file of its own, because the question is the same question
   * this class already answers — *which document is this, and may it be filtered* — and that answer has
   * three parts (`injectableDocumentUrl`, the blocker switches, the per-site exemption) that must not
   * come out differently for the two halves of a filter list. A second injector would be a second copy
   * of all three.
   */
  readonly scriptletsFor: (documentUrl: string) => readonly ScriptletCall[]
  /**
   * Selectors no CSS engine can evaluate, for a document. `FilterEngine.proceduralSelectorsFor`.
   *
   * Answered from here for the same reason the scriptlets are: the question "which document is this, and
   * may it be filtered" has three parts — `injectableDocumentUrl`, the blocker switches, the per-site
   * exemption — and all three halves of a filter list have to get the same answer.
   */
  readonly proceduralFor: (documentUrl: string) => readonly ProceduralSelector[]
}

/** What one view is currently being served, so a navigation can be noticed. */
interface OpenDocument {
  readonly url: string
  readonly feed: CosmeticFeedHandle
  /**
   * The view itself, so the rules can be re-served without being asked for.
   *
   * Held rather than looked up by id at the moment of use, and it costs nothing: the entry is deleted
   * on `destroyed` either way, so this reference lives exactly as long as the one the map key stood
   * for. `webContents.fromId` would be the alternative and it can answer a *different* view — ids are
   * reused once a renderer is gone — which is a re-serve landing on somebody else's page.
   */
  readonly contents: WebContents
}

export class CosmeticInjector {
  readonly #options: CosmeticInjectorOptions
  /**
   * Keyed by web-contents id, and cleaned up when the view goes.
   *
   * A `Map` rather than a `WeakMap` because the key is a number, and the entry is removed on
   * `destroyed` rather than left to be collected — a long session with hundreds of tabs would otherwise
   * hold a feed, and therefore a set of served selector strings, for every view that ever existed.
   */
  readonly #documents = new Map<number, OpenDocument>()

  constructor(options: CosmeticInjectorOptions) {
    this.#options = options
  }

  /**
   * Starts answering. Installed once for the application, not once per session.
   *
   * Per-`webContents` listeners rather than `ipcMain` ones, so a listener dies with the view that could
   * have used it. `ipcMain.on` would accumulate nothing but would also make the sender check something
   * this file had to write; here the sender *is* the view the listener belongs to.
   */
  install(): void {
    app.on('web-contents-created', (_event, contents) => {
      contents.on('ipc-message-sync', (event, channel, ...args) => {
        if (channel === SCRIPTLET_CHANNEL) {
          event.returnValue = this.#scriptlets(contents, args[0])
          return
        }
        if (channel !== COSMETIC_SPECIFIC_CHANNEL) return
        event.returnValue = this.#specificStyles(contents, args[0])
      })

      contents.on('ipc-message', (_ipcEvent, channel, ...args) => {
        if (channel === PROCEDURAL_CHANNEL) {
          const selectors = this.#procedural(contents, args[0])
          if (selectors.length === 0 || contents.isDestroyed()) return
          contents.send(PROCEDURAL_CHANNEL, selectors)
          return
        }
        if (channel !== COSMETIC_GENERIC_CHANNEL) return
        const styles = this.#genericStyles(contents, args[0], args[1])
        if (styles === null || contents.isDestroyed()) return
        // Sent back on the same channel rather than answered: `ipc-message` is one-way, and using
        // `invoke` would put this on `ipcMain` where the sender check would have to be written by hand.
        contents.send(COSMETIC_GENERIC_CHANNEL, styles)
      })

      contents.once('destroyed', () => {
        this.#documents.delete(contents.id)
      })
    })
  }

  /** Drops a view's feed, so the next request opens a fresh one. Called on navigation. */
  forget(webContentsId: number): void {
    this.#documents.delete(webContentsId)
  }

  /**
   * Re-serves every open document, because the rules changed under it.
   *
   * ## The bug this is
   *
   * Host-specific rules were served exactly once, synchronously, before the page existed — so a rule
   * written *now* applied to the next page load and not to the page in front of the person who wrote
   * it. With the element picker that is the whole feature failing: you point at a banner, confirm the
   * selector, and the banner is still there. Reported in those words — *"blocked elemente sind nicht
   * blocked"*.
   *
   * Called when the user's own rules change. Not when a downloaded list is recompiled: that happens on
   * a timer and at startup, where nobody is watching a particular element and every open page would be
   * restyled at once for no visible gain.
   *
   * ## What it can and cannot undo
   *
   * The stylesheet is *replaced* on the other side, so this un-hides as well as hides: a rule deleted
   * or switched off stops applying in front of the person who switched it off, which is the half that
   * makes an over-eager rule recoverable. An empty string is therefore sent rather than skipped — it is
   * the instruction to stop hiding, and skipping it would leave the last stylesheet in place.
   *
   * It would carry a blocker switched off or a site exempted just as well, and nothing calls it for
   * either today: both are settings, and a settings change already restyles differently. Worth knowing
   * before somebody adds a second mechanism for it.
   *
   * The procedural half is one-way. It is re-sent so a `:has-text()` rule starts applying immediately,
   * but a procedural rule that has already hidden something cannot be taken back without a reload:
   * the matcher wrote `display: none` onto an element, and the core does not know which one.
   */
  refresh(): void {
    for (const open of this.#documents.values()) {
      const { contents } = open
      if (contents.isDestroyed()) continue
      contents.send(COSMETIC_SPECIFIC_CHANNEL, this.#specificStyles(contents, open.url) ?? '')
      const selectors = this.#procedural(contents, open.url)
      if (selectors.length > 0) contents.send(PROCEDURAL_CHANNEL, selectors)
    }
  }

  #specificStyles(contents: WebContents, reportedUrl: unknown): string | null {
    if (!this.#enabled()) return null
    const url = injectableDocumentUrl(reportedUrl, contents.getURL())
    if (url === null || this.#exempt(url)) return null
    // Opened here as well as in the generic path, so the very first request establishes the document
    // and a later generic report for the same page continues rather than restarts. It is also what
    // puts the view in the map at all, which is what `refresh` walks.
    this.#documentFor(contents, url)
    return this.#options.stylesFor(url)
  }

  /**
   * The scriptlets for a document, as plain data the preload hands to the page's world.
   *
   * Gated on `blockerEnabled` and the per-site exemption but **not** on `cosmeticFiltering`: that switch
   * means "do not alter this page's layout", and a scriptlet does not. Its own switch,
   * `privacy.scriptletInjection`, is checked one layer down in `FilterEngine.scriptletsFor` — where the
   * rules are, and where the same check also covers a document whose feed was opened before the switch
   * was flipped.
   *
   * Answers with an array rather than `null` for nothing, because the preload iterates it. `sendSync`
   * serialises this, so it has to be data all the way down — a `ScriptletCall` is two strings and an
   * array of strings, which is the reason the library is keyed by *name* rather than being functions the
   * core hands over.
   */
  #scriptlets(contents: WebContents, reportedUrl: unknown): readonly ScriptletCall[] {
    const settings = this.#options.getSettings()
    if (!settings['privacy.blockerEnabled']) return []
    const url = injectableDocumentUrl(reportedUrl, contents.getURL())
    if (url === null || this.#exempt(url)) return []
    return this.#options.scriptletsFor(url)
  }

  /**
   * The procedural selectors for a document.
   *
   * Gated exactly as the stylesheet is — `blockerEnabled`, `cosmeticFiltering` (checked one layer down in
   * the engine), and the per-site exemption. A rule that hides an element is the same promise to the user
   * whether a CSS engine or a matcher does the hiding, so the switches must not disagree about it.
   */
  #procedural(contents: WebContents, reportedUrl: unknown): readonly ProceduralSelector[] {
    if (!this.#enabled()) return []
    const url = injectableDocumentUrl(reportedUrl, contents.getURL())
    if (url === null || this.#exempt(url)) return []
    return this.#options.proceduralFor(url)
  }

  #genericStyles(
    contents: WebContents,
    reportedUrl: unknown,
    reportedFeatures: unknown
  ): string | null {
    if (!this.#enabled()) return null
    const url = injectableDocumentUrl(reportedUrl, contents.getURL())
    if (url === null || this.#exempt(url)) return null
    return this.#documentFor(contents, url).feed.take(asDocumentFeatures(reportedFeatures))
  }

  /**
   * Whether the user has switched filtering off for this site.
   *
   * Checked per request rather than per document, and after the URL is resolved rather than before: the
   * exemption is keyed on the document's host, and `injectableDocumentUrl` is what decides which
   * document a report is about at all. Doing it in `#enabled()` was the shorter route and is not
   * available — that method has no URL, only the settings.
   *
   * Answering `null` rather than an empty stylesheet matters for the specific path, which is
   * synchronous: the preload appends nothing for `null` and would append an empty rule otherwise.
   */
  #exempt(documentUrl: string): boolean {
    return filteringExemptFor(
      documentUrl,
      this.#options.getSettings()['privacy.blockerOffForSites']
    )
  }

  #documentFor(contents: WebContents, url: string): OpenDocument {
    const open = this.#documents.get(contents.id)
    if (open?.url === url) return open
    const fresh: OpenDocument = { url, feed: this.#options.openFeed(url), contents }
    this.#documents.set(contents.id, fresh)
    return fresh
  }

  #enabled(): boolean {
    const settings = this.#options.getSettings()
    // Both switches, because a user who turned the blocker off should not still have its rules hiding
    // parts of pages — and `cosmeticFiltering` alone is the one for "block requests but leave layout".
    return settings['privacy.blockerEnabled'] && settings['privacy.cosmeticFiltering']
  }
}
