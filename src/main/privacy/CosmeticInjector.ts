import { app, type WebContents } from 'electron'
import {
  COSMETIC_GENERIC_CHANNEL,
  COSMETIC_SPECIFIC_CHANNEL,
  asDocumentFeatures,
  injectableDocumentUrl
} from '@shared/filters/injection.js'
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
}

/** What one view is currently being served, so a navigation can be noticed. */
interface OpenDocument {
  readonly url: string
  readonly feed: CosmeticFeedHandle
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
        if (channel !== COSMETIC_SPECIFIC_CHANNEL) return
        event.returnValue = this.#specificStyles(contents, args[0])
      })

      contents.on('ipc-message', (_ipcEvent, channel, ...args) => {
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

  #specificStyles(contents: WebContents, reportedUrl: unknown): string | null {
    if (!this.#enabled()) return null
    const url = injectableDocumentUrl(reportedUrl, contents.getURL())
    if (url === null) return null
    // Opened here as well as in the generic path, so the very first request establishes the document
    // and a later generic report for the same page continues rather than restarts.
    this.#documentFor(contents.id, url)
    return this.#options.stylesFor(url)
  }

  #genericStyles(contents: WebContents, reportedUrl: unknown, reportedFeatures: unknown): string | null {
    if (!this.#enabled()) return null
    const url = injectableDocumentUrl(reportedUrl, contents.getURL())
    if (url === null) return null
    return this.#documentFor(contents.id, url).feed.take(asDocumentFeatures(reportedFeatures))
  }

  #documentFor(webContentsId: number, url: string): OpenDocument {
    const open = this.#documents.get(webContentsId)
    if (open?.url === url) return open
    const fresh: OpenDocument = { url, feed: this.#options.openFeed(url) }
    this.#documents.set(webContentsId, fresh)
    return fresh
  }

  #enabled(): boolean {
    const settings = this.#options.getSettings()
    // Both switches, because a user who turned the blocker off should not still have its rules hiding
    // parts of pages — and `cosmeticFiltering` alone is the one for "block requests but leave layout".
    return settings['privacy.blockerEnabled'] && settings['privacy.cosmeticFiltering']
  }
}
