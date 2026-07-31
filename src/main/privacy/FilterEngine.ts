import { compileFilterLists, type CompiledFilters } from '@shared/filters/compile.js'
import {
  cancelledSelectorsFor,
  cosmeticCss,
  cosmeticSelectorsFor,
  openCosmeticFeed,
  type CosmeticSelectors
} from '@shared/filters/cosmetic.js'
import type { DocumentFeatures } from '@shared/filters/features.js'
import {
  filterResourceTypeOf,
  hostnameOfUrl,
  type FilterListDiagnostics
} from '@shared/filters/model.js'
import { matchNetworkRequest } from '@shared/filters/network.js'
import { scriptletsFor, type ScriptletCall } from '@shared/filters/scriptlets.js'
import { proceduralSelectorsFor } from '@shared/filters/procedural-index.js'
import type { ProceduralSelector } from '@shared/filters/procedural.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { FilterListEngine, RequestContext } from './RequestPipeline.js'

/**
 * The `FilterListEngine` the blocker stage asks (spec 4).
 *
 * Everything decided here is a translation, not a policy: Electron's resource names
 * into the list vocabulary, a document URL into a hostname, a selector list into a
 * stylesheet. The matching itself is in `src/shared/filters/`, where it is pure and
 * directly testable and where a renderer can reach the cosmetic half.
 *
 * `privacy.blockerEnabled` is *not* consulted here — the pipeline stage already
 * checks it per request, and checking it twice would make it ambiguous which one
 * governs. `privacy.cosmeticFiltering` is consulted here, because nothing else is
 * positioned to.
 *
 * The user's own rules are compiled separately from the downloaded lists rather than
 * appended to them. Adding one picker rule would otherwise reparse 117 000 lines on
 * the main process's own thread while the user waits — and the user's rules change far
 * more often than the lists do. What the separation costs is one place where the two
 * have to be combined by hand: a user `#@#` exception has to be able to cancel a
 * selector a *list* contributed, because that is the whole escape hatch for a list
 * that breaks a page.
 */

const NO_SELECTORS: CosmeticSelectors = { specific: [], generic: [] }

export interface FilterEngineOptions {
  /** Raw list bodies, in the order the user configured them. */
  readonly lists: readonly string[]
  readonly getSettings: () => SettingsSnapshot
  /** The user's own rules as one list body; see `UserRuleStore.enabledText`. */
  readonly userRules?: string
}

/**
 * One document's incremental view of the generic selectors, as CSS.
 *
 * Held by whoever injects for as long as that document lives. `take` answers with the
 * stylesheet for features that have not been reported before, and with null when there
 * is nothing new — so an injector can survey the page as often as it likes and pay
 * only for what changed.
 */
export interface CosmeticFeedHandle {
  take(features: DocumentFeatures): string | null
  readonly servedSelectorCount: number
  readonly servedByteCount: number
}

/** For a document with no host, or with cosmetic filtering switched off. */
const INERT_FEED: CosmeticFeedHandle = {
  take: () => null,
  servedSelectorCount: 0,
  servedByteCount: 0
}

export class FilterEngine implements FilterListEngine {
  #filters: CompiledFilters
  #userFilters: CompiledFilters
  readonly #getSettings: () => SettingsSnapshot

  constructor(options: FilterEngineOptions) {
    this.#filters = compileFilterLists(options.lists)
    this.#userFilters = compileFilterLists([options.userRules ?? ''])
    this.#getSettings = options.getSettings
  }

  /**
   * What the parser could and could not make of the lists.
   *
   * The counters are the honest half of a hand-written engine: `unsupported`
   * against `network` is how much of the user's own lists this build declines to
   * act on, and `unsupportedByReason` says which syntax. Without it the blocker
   * would understand less than the user believes and nothing would say so.
   */
  get diagnostics(): FilterListDiagnostics {
    return this.#filters.diagnostics
  }

  get networkRuleCount(): number {
    return this.#filters.network.ruleCount
  }

  get cosmeticRuleCount(): number {
    return this.#filters.cosmetic.ruleCount
  }

  get userRuleCount(): number {
    return this.#userFilters.cosmetic.ruleCount
  }

  get scriptletRuleCount(): number {
    return this.#filters.scriptlet.ruleCount
  }

  get proceduralRuleCount(): number {
    return this.#filters.procedural.ruleCount + this.#userFilters.procedural.ruleCount
  }

  /**
   * Procedural selectors for a document — the user's own as well as the lists'.
   *
   * Both, and the user's *last*, which is the one ordering decision here: a rule the user wrote is the one
   * they will be looking for when they ask why a page still shows something, so it runs after the lists
   * rather than being lost among them.
   *
   * Gated on `privacy.cosmeticFiltering` and not on a switch of its own. A procedural rule hides or
   * restyles an element, which is exactly what that setting is about — it costs more to evaluate, but the
   * *promise* to the user is the same one, and a second switch would mean somebody who turned cosmetic
   * filtering off still had script rearranging their pages.
   */
  proceduralSelectorsFor(documentUrl: string): ProceduralSelector[] {
    if (!this.#getSettings()['privacy.cosmeticFiltering']) return []
    const host = hostnameOfUrl(documentUrl)
    if (host === null) return []
    return [
      ...proceduralSelectorsFor(this.#filters.procedural, host),
      ...proceduralSelectorsFor(this.#userFilters.procedural, host)
    ]
  }

  /**
   * The scriptlets to run in a document, or an empty list.
   *
   * Its own switch (`privacy.scriptletInjection`) rather than `privacy.cosmeticFiltering`, because they
   * are different powers: one hides an element, the other runs code in the page. A user who is willing to
   * have their layout altered has not thereby agreed to the second, and the settings screen has to be able
   * to ask about them separately.
   *
   * The user's own rules contribute nothing here and cannot. `describeUserRule` refuses anything but a
   * hiding rule — the element picker must not be able to write a line that executes code — so
   * `#userFilters` has no scriptlets to add and asking it would be asking a question with one possible
   * answer.
   */
  scriptletsFor(documentUrl: string): ScriptletCall[] {
    if (!this.#getSettings()['privacy.scriptletInjection']) return []
    const host = hostnameOfUrl(documentUrl)
    if (host === null) return []
    return scriptletsFor(this.#filters.scriptlet, host)
  }

  /**
   * Bytes of generic selector text the lists hold, and how much of it no survey can
   * narrow.
   *
   * Reported because it is the number that justifies the whole feature-keyed path: a
   * settings page can say "526 kB of generic rules, of which 16 kB apply to every page
   * regardless" instead of the user discovering the cost as slowness.
   */
  get genericSelectorBytes(): number {
    return this.#filters.cosmetic.genericFeatures.byteCount
  }

  get unkeyedSelectorBytes(): number {
    return this.#filters.cosmetic.genericFeatures.unkeyedByteCount
  }

  /**
   * Recompiles in place.
   *
   * `privacy.blockerLists` applies live, and the pipeline captures the engine once
   * when it installs its single `webRequest` listener. Replacing the contents of
   * the object the pipeline already holds is what makes a list change take effect
   * without reinstalling — and reinstalling would silently replace the listener,
   * which is the failure mode `RequestPipeline` exists to prevent.
   */
  replaceLists(lists: readonly string[]): void {
    this.#filters = compileFilterLists(lists)
  }

  /**
   * Recompiles the user's own rules, leaving the downloaded lists alone.
   *
   * Called whenever `UserRuleStore` changes. Documents already open keep the feed they
   * were given — a rule added now applies to the next document, or to this one after
   * the injector opens a new feed, and nothing has to be un-injected.
   */
  replaceUserRules(text: string): void {
    this.#userFilters = compileFilterLists([text])
  }

  matches(context: RequestContext): boolean {
    const match = matchNetworkRequest(this.#filters.network, {
      url: context.url,
      documentUrl: context.documentUrl,
      type: filterResourceTypeOf(context.resourceType)
    })
    return match?.blocked === true
  }

  /**
   * Selectors for a document, split into host-specific and generic.
   *
   * Both halves are returned because the injector has a decision to make that this
   * class must not make for it: the generic set is 28 914 selectors from the default
   * lists, and handing all of it to every page is 526 kB of CSS per load.
   * `openCosmeticFeed` is the other way to get at the generic half, keyed by what the
   * document actually contains.
   */
  cosmeticSelectorsFor(documentUrl: string): CosmeticSelectors {
    if (!this.#getSettings()['privacy.cosmeticFiltering']) return NO_SELECTORS
    const host = hostnameOfUrl(documentUrl)
    if (host === null) return NO_SELECTORS
    const fromLists = cosmeticSelectorsFor(this.#filters.cosmetic, host)
    const fromUser = cosmeticSelectorsFor(this.#userFilters.cosmetic, host)
    const cancelled = cancelledSelectorsFor(this.#userFilters.cosmetic, host)
    return {
      specific: [...withoutCancelled(fromLists.specific, cancelled), ...fromUser.specific],
      generic: [...withoutCancelled(fromLists.generic, cancelled), ...fromUser.generic]
    }
  }

  /**
   * Host-specific selectors as a stylesheet, safe to inject on every document.
   *
   * Deliberately excludes the generic set. See `cosmeticSelectorsFor`.
   */
  cosmeticStylesFor(documentUrl: string): string | null {
    return cosmeticCss(this.cosmeticSelectorsFor(documentUrl).specific)
  }

  /**
   * A feed of generic selectors for one document, keyed by the features it reports.
   *
   * Opened once per document and dropped when it navigates. The setting is checked on
   * every `take` rather than only here, so switching cosmetic filtering off stops
   * further injection into documents that are already open instead of only affecting
   * the next one.
   */
  openCosmeticFeed(documentUrl: string): CosmeticFeedHandle {
    const host = hostnameOfUrl(documentUrl)
    if (host === null) return INERT_FEED

    const feeds = [
      openCosmeticFeed(this.#filters.cosmetic, host),
      openCosmeticFeed(this.#userFilters.cosmetic, host)
    ]
    const cancelledByUser = cancelledSelectorsFor(this.#userFilters.cosmetic, host)
    const getSettings = this.#getSettings
    // Counted from what actually left rather than from what the shared feeds handed
    // over: a selector the user cancelled is served by the feed and not by this handle,
    // and a figure shown to the user has to be the one that reached the page.
    let selectorCount = 0
    let byteCount = 0

    return {
      take: (features: DocumentFeatures): string | null => {
        if (!getSettings()['privacy.cosmeticFiltering']) return null
        const selectors = feeds.flatMap((feed) =>
          withoutCancelled(feed.take(features), cancelledByUser)
        )
        const css = cosmeticCss(selectors)
        if (css === null) return null
        selectorCount += selectors.length
        byteCount += css.length
        return css
      },
      get servedSelectorCount(): number {
        return selectorCount
      },
      get servedByteCount(): number {
        return byteCount
      }
    }
  }
}

/**
 * A user `#@#` line cancels the selector, not the rule that produced it.
 *
 * Applied to the lists' output here because the two sets are compiled apart. The
 * cancellation is one-directional on purpose: a list's exception has no business
 * cancelling a rule the user wrote themselves.
 */
function withoutCancelled(
  selectors: readonly string[],
  cancelled: ReadonlySet<string>
): readonly string[] {
  return cancelled.size === 0 ? selectors : selectors.filter((selector) => !cancelled.has(selector))
}
