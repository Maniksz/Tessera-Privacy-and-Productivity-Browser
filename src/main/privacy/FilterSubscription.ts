import { FilterEngine } from './FilterEngine.js'
import { FilterListStore, type RefreshOutcome } from './FilterListStore.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
// The wire type, derived from the schema the contract validates against — so what this returns and
// what crosses the boundary cannot drift apart.
import type { FilterStatus } from '@shared/filters/status.js'

/**
 * Keeps the blocker's rules in step with the user's list of lists.
 *
 * The engine and the on-disk cache each existed and were tested; nothing joined them to the setting
 * that says which lists to use. This does, and it is the piece with the interesting failure modes:
 *
 *   - **Startup must not wait for the network.** The browser opens with whatever is cached, then
 *     replaces the rules once a refresh finishes. Awaiting a download before the first window would
 *     make a slow connection look like a slow browser, and an offline start look like a broken one.
 *   - **A failed download must never leave the blocker empty.** `FilterListStore.refresh` keeps the
 *     previous copy on disk when a fetch fails, and this only ever calls `replaceLists` with what
 *     `load` actually returned — so the worst case is stale rules, never none.
 *   - **A list the user removes has to stop applying**, which means recompiling on a settings change
 *     rather than only at startup.
 *
 * One engine for every session, including private ones. The rules are a property of the user's
 * configuration, not of a window, and a private window that blocked less than a normal one would be
 * both surprising and a way to tell the two apart from the outside.
 */

export interface FilterSubscriptionOptions {
  /** `join(cacheDir(), FILTER_LIST_CACHE_DIRNAME)` at the call site. */
  readonly directory: string
  /**
   * Downloads one list body.
   *
   * Electron's `net.fetch` at the call site, never Node's global. A list is fetched over the same
   * network stack as the pages it protects, which means the same proxy, the same DNS — including
   * secure DNS — and the same certificate store. Node's fetch would quietly bypass all of it, and
   * the one request per list per five days is precisely the request a user has configured a proxy
   * for.
   */
  readonly fetchList: (url: string) => Promise<string>
  readonly getSettings: () => SettingsSnapshot
  /** The user's own rules as one list body; `UserRuleStore.enabledText`. */
  readonly userRules?: () => string
  /** Injected in tests so expiry does not depend on when the test ran. */
  readonly now?: () => number
  readonly maxAgeMs?: number
}

export class FilterSubscription {
  readonly #store: FilterListStore
  readonly #engine: FilterEngine
  readonly #getSettings: () => SettingsSnapshot
  readonly #userRules: () => string
  #loadedCount = 0
  #lastRefresh: readonly RefreshOutcome[] | null = null

  /**
   * The refresh currently running, so a second one waits rather than joining in.
   *
   * Two refreshes at once corrupt the cache, and reaching that state is trivial rather than exotic:
   * `start()` kicks one off in the background on purpose, and a user who changes their lists a second
   * later starts another. Both read the manifest, both decide what to prune from what they read, and
   * whichever finishes second deletes files the first had just written and then overwrites the manifest
   * that named them. The visible result is a blocker that has fewer lists than it downloaded, with
   * nothing anywhere saying why.
   *
   * Chained rather than coalesced, because the second caller's list configuration may differ from the
   * first's — dropping their refresh would silently ignore the change they just made.
   */
  #inFlight: Promise<unknown> = Promise.resolve()

  constructor(options: FilterSubscriptionOptions) {
    this.#getSettings = options.getSettings
    this.#userRules = options.userRules ?? ((): string => '')
    this.#store = new FilterListStore({
      directory: options.directory,
      fetchList: options.fetchList,
      // `now` is required by the store rather than defaulted there, on purpose — so the default is
      // chosen here, once, where it is visible.
      now: options.now ?? ((): number => Date.now()),
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs })
    })
    // Empty to begin with, and that is why `installRequestPipeline` may be handed it immediately: an
    // engine with no rules matches nothing, so the pipeline is correct before the first list arrives
    // rather than being switched on later.
    this.#engine = new FilterEngine({
      lists: [],
      getSettings: options.getSettings,
      userRules: this.#userRules()
    })
  }

  /** Handed to `installRequestPipeline`. Never replaced, so no session has to be re-prepared. */
  get engine(): FilterEngine {
    return this.#engine
  }

  /**
   * Compiles whatever is cached, then refreshes in the background.
   *
   * The two halves are deliberately not awaited together. `load` is a disk read and finishes before
   * the first window paints; the refresh may take seconds or never finish at all, and the browser
   * must not be waiting for it.
   */
  async start(): Promise<void> {
    await this.#compileFromCache()
    void this.refresh()
  }

  /**
   * Fetches what is missing or stale and recompiles.
   *
   * Returns the per-list outcomes so a settings page can say "one of four could not be downloaded"
   * instead of leaving the user to guess why a site still shows adverts.
   */
  refresh(): Promise<readonly RefreshOutcome[]> {
    // The configured lists are read *inside* the chained work rather than here, so a refresh queued
    // behind another one uses the settings as they are when it runs rather than as they were when it
    // was asked for.
    const next = this.#inFlight.then(() => this.#refreshNow())
    // `catch` on the chain, not on what is returned: a failed refresh must not stop the next one, and
    // the caller still gets the rejection.
    this.#inFlight = next.catch(() => undefined)
    return next
  }

  async #refreshNow(): Promise<readonly RefreshOutcome[]> {
    const urls = this.#configuredLists()
    const outcomes = await this.#store.refresh(urls)
    this.#lastRefresh = outcomes
    await this.#compileFromCache()
    return outcomes
  }

  /**
   * Resolves once no refresh is running.
   *
   * Exists for two callers with the same need. A test has to be able to wait for work `start()`
   * deliberately does not await; and a shutdown has to let a half-written cache finish, because
   * interrupting `writeAtomically` between its write and its rename leaves a `.tmp` file and no
   * manifest — which the next launch reads as "nothing cached" and re-downloads every list.
   */
  async whenIdle(): Promise<void> {
    // Awaited twice: the first await lets a refresh that was queued *by* the one we just waited for
    // settle as well, which is the state `start()` produces.
    await this.#inFlight
    await this.#inFlight
  }

  /**
   * Reacts to a settings change.
   *
   * Only two keys matter, and checking them rather than recompiling on every change is not
   * micro-optimisation: compiling a hundred thousand rules takes long enough to be felt, and this
   * runs on the main process's own thread while the user is moving a slider.
   */
  onSettingsChanged(changed: Readonly<Record<string, unknown>>): void {
    if (!('privacy.blockerLists' in changed) && !('privacy.blockerEnabled' in changed)) return
    // A list added by the user has no cached copy yet, so this has to be the fetching path rather
    // than the reading one — otherwise the new list would apply only after a restart.
    void this.refresh()
  }

  /** Recompiles the user's own rules alone. See `FilterEngine` for why they are separate. */
  reloadUserRules(): void {
    this.#engine.replaceUserRules(this.#userRules())
  }

  status(): FilterStatus {
    return {
      configured: this.#configuredLists().length,
      loaded: this.#loadedCount,
      networkRules: this.#engine.networkRuleCount,
      cosmeticRules: this.#engine.cosmeticRuleCount,
      userRules: this.#engine.userRuleCount,
      // Copied rather than handed out: the counters are a snapshot, and a caller holding the array
      // this class keeps could reorder the outcomes the settings page is about to render.
      diagnostics: { ...this.#engine.diagnostics },
      lastRefresh: this.#lastRefresh === null ? null : [...this.#lastRefresh]
    }
  }

  /**
   * The lists to use, or none at all when the blocker is switched off.
   *
   * Returning an empty list rather than skipping the compile is what makes "off" mean off: the engine
   * ends up with no rules, so nothing is matched and nothing is hidden. Leaving the rules compiled and
   * relying on a check elsewhere would be one forgotten check away from a blocker that still blocks
   * after the user turned it off.
   */
  #configuredLists(): readonly string[] {
    const settings = this.#getSettings()
    if (!settings['privacy.blockerEnabled']) return []
    return settings['privacy.blockerLists']
  }

  async #compileFromCache(): Promise<void> {
    const urls = this.#configuredLists()
    const cached = await this.#store.load(urls)
    this.#loadedCount = cached.length
    this.#engine.replaceLists(cached.map((list) => list.text))
    // The user's rules are compiled separately and are not touched by a list reload, but the engine
    // was rebuilt from scratch here, so they have to be put back.
    this.#engine.replaceUserRules(this.#userRules())
  }
}
