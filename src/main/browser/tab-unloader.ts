import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import {
  unloadCandidates,
  unloadSettingsOf,
  type UnloadFacts
} from '@shared/session/unload-policy.js'

/**
 * Tab unloading, carried out (U15, KTD9): one timer for the program, and per window the discard and the way back.
 *
 * Electron 43 has no discard, so unloading means destroying the view. What makes the tab come back is kept
 * here, in memory: its navigation entries and the index it was at, handed to `navigationHistory.restore()` in
 * a new view when the tab is activated. Never in `TabState` and never in the session file — an entry's
 * `pageState` can be megabytes, and the session reads the tab's address either way.
 *
 * Two kinds of "unloaded", and they stay apart. A tab **restored deferred** keeps its view and loads its address
 * into it when activated (`Tab.loadIfDeferred`, `loadTimingFor`). A tab **discarded** here has no view until it
 * is activated, and then a new one. Which one a tab is decides itself: only a discarded tab has a history here.
 *
 * ## Who decides, who asks, who knows the id
 *
 * Which tab goes is `unload-policy.ts`, and nothing here second-guesses it. Whether its page lets it go is the
 * close contract's discard mode, which never shows a dialogue and reads an objection as "stay loaded"
 * (`unload-guard.ts`, KTD5) — and it finishes nothing, because a discarded tab is still in the strip. The new
 * view has a new `webContents` id, which `onViewReplaced` reports; everything else keyed by id drops the old one
 * on `destroyed` and picks the new one up in `web-contents-created`.
 *
 * No Electron here, so each half runs in a test against fakes and against the real `Tab`.
 */

/** How often the one timer looks, in milliseconds. */
export const UNLOAD_SWEEP_MS = 60_000

/** A navigation entry as `restore()` takes it back. Electron's `NavigationEntry` is one. */
export interface HistoryEntry {
  readonly url: string
  readonly title: string
  readonly pageState?: string
}

/** The part of a `webContents` unloading reads. `WebContents` satisfies it as it stands. */
export interface UnloadContents {
  readonly id: number
  isDestroyed(): boolean
  getTitle(): string
  isAudioMuted(): boolean
  isCurrentlyAudible(): boolean
  isDevToolsOpened(): boolean
  readonly navigationHistory: {
    getAllEntries(): HistoryEntry[]
    getActiveIndex(): number
    restore(options: { entries: HistoryEntry[]; index?: number }): Promise<void>
  }
}

/** What a discarded tab still shows in the strip, and whether it comes back muted. */
export interface DiscardedPage {
  readonly url: string
  readonly title: string
  readonly muted: boolean
}

/** A tab as the discard reads it. `Tab` satisfies it. */
export interface DiscardableTab {
  readonly id: string
  readonly view: { readonly webContents: UnloadContents }
  /** The committed address, which is also where a tab goes when its history cannot be restored. */
  readonly currentUrl: string
  readonly tileIndex: number | null
  /** The user is using it now: it was activated or put in a tile. */
  markActive(): void
  /** A discard is in flight: its page closing is not a close request, its renderer going is not a crash. */
  beginDiscard(): void
  /** The view went (`page`), or the page kept it (`null`). */
  endDiscard(page: DiscardedPage | null): void
  /** A new view with the whole wiring, in place of the one discarded. */
  revive(): void
  loadIfDeferred(): void
  loadUrl(url: string): void
}

/** A tab as the timer reads it. `Tab` satisfies it. */
export interface UnloadableTab extends DiscardableTab {
  readonly lastActiveAt: number
  readonly pinned: boolean
  readonly loading: boolean
  readonly failure: unknown
  /** A page's media started since its last commit, playing or paused, muted or not. */
  readonly hasMedia: boolean
  readonly unsavedInput: boolean
  readonly htmlFullscreen: boolean
  /** Its page refused the last discard and has not navigated since. */
  readonly objected: boolean
  /** Restored deferred, or discarded: either way nothing is loaded. */
  readonly unloaded: boolean
}

/** Something outside the window that may be waiting on a view: autofill, the permission arbiter, the picker. */
export interface ViewWaiter {
  waitsOn(webContentsId: number): boolean
}

/** Only these schemes are pages worth unloading; everything else is internal or nothing at all. */
const WEB_PAGE = /^(?:https?|file):/i

/** One tab's facts for the policy. `asking` is a question about a popup or redirect on this tab's window. */
export function unloadFactsOf(
  tab: UnloadableTab,
  context: { asking: boolean; waiting: ReadonlyArray<ViewWaiter | null> }
): UnloadFacts {
  const contents = tab.view.webContents
  const live = !contents.isDestroyed()
  const waited = live && context.waiting.some((waiter) => waiter?.waitsOn(contents.id) === true)
  return {
    tabId: tab.id,
    lastActiveAt: tab.lastActiveAt,
    tile: tab.tileIndex !== null,
    audible: live && contents.isCurrentlyAudible(),
    media: tab.hasMedia,
    pinned: tab.pinned,
    loading: tab.loading,
    devtools: live && contents.isDevToolsOpened(),
    fullscreen: tab.htmlFullscreen,
    prompt: context.asking || waited,
    input: tab.unsavedInput,
    internal: !WEB_PAGE.test(tab.currentUrl),
    failure: tab.failure !== undefined,
    objected: tab.objected,
    unloaded: tab.unloaded || !live
  }
}

// --- the timer ------------------------------------------------------------------------------------------

/** One window as the timer sees it. `BrowserWindowController` satisfies it. */
export interface UnloadWindow {
  readonly tabs: readonly UnloadableTab[]
  overlayPresentation(): { readonly kind: string } | null
  discardTab(tabId: string): void
}

type UnloadSettingKeys = 'advanced.unloadInactiveTabs' | 'advanced.unloadAfterMinutes'

export interface TabUnloaderOptions {
  windows(): Iterable<UnloadWindow>
  /** Read on every sweep, so switching the setting off stops the next one. The settings store is one. */
  settings: { snapshot(): Pick<SettingsSnapshot, UnloadSettingKeys> }
  waiting: ReadonlyArray<ViewWaiter | null>
  /** A quit has begun; nothing is unloaded from a browser on its way out. */
  quitting(): boolean
  now?: () => number
  /** Starts the repeating timer and hands back what stops it. */
  every?: (ms: number, run: () => void) => () => void
}

function defaultEvery(ms: number, run: () => void): () => void {
  const timer = setInterval(run, ms)
  // A timer that kept the process alive would hold a quit open for up to a minute.
  timer.unref()
  return () => clearInterval(timer)
}

/**
 * The one timer, for every window at once (KTD9). A timer per window would multiply the sweeps and outlive a
 * private window's tabs; one for the program is the `PasswordVault` idle sweep's shape.
 */
export class TabUnloader {
  readonly #options: TabUnloaderOptions
  readonly #now: () => number
  readonly #stop: () => void

  constructor(options: TabUnloaderOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.#stop = (options.every ?? defaultEvery)(UNLOAD_SWEEP_MS, () => this.sweep())
  }

  /** Sends every idle tab of every window that nothing keeps to its window's discard. */
  sweep(): void {
    if (this.#options.quitting()) return
    const settings = unloadSettingsOf(this.#options.settings.snapshot())
    const now = this.#now()
    const waiting = this.#options.waiting
    for (const window of this.#options.windows()) {
      /*
        The popup-or-redirect question does not say which tab asked, so it keeps the window's tabs until it is
        answered. The find bar and the picker bar are tile surfaces: their tab holds a tile, which keeps it.
      */
      const asking = window.overlayPresentation()?.kind === 'navigation-request'
      const facts = window.tabs.map((tab) => unloadFactsOf(tab, { asking, waiting }))
      for (const tabId of unloadCandidates(facts, now, settings)) window.discardTab(tabId)
    }
  }

  dispose(): void {
    this.#stop()
  }
}

let installed: TabUnloader | null = null

/** Starts the program's one unloading timer. A second call hands back the first. */
export function installTabUnloading(options: TabUnloaderOptions): TabUnloader {
  installed ??= new TabUnloader(options)
  return installed
}

// --- the discard and the way back, per window -----------------------------------------------------------

/** The window's half of the close contract that a discard uses. `CloseContract` satisfies it. */
export interface DiscardContract {
  discard(tabId: string, settled: (discarded: boolean) => void): void
  /** Starts guarding a view; a new view needs its own guard. */
  track(tabId: string): void
}

/** The groups as unfolding reads them. `TabGroupController` satisfies it. */
export interface FoldableGroups {
  groups(): ReadonlyArray<{
    readonly id: string
    readonly collapsed: boolean
    readonly tabIds: readonly string[]
  }>
  setCollapsed(id: string, collapsed: boolean): void
}

/** Opens the folded group a tab is in, so a tab brought to the front is not one the strip hides. */
export function unfoldGroupOf(groups: FoldableGroups, tabId: string): void {
  const folded = groups.groups().find((group) => group.collapsed && group.tabIds.includes(tabId))
  if (folded !== undefined) groups.setCollapsed(folded.id, false)
}

export interface TabDiscardsHost<T extends DiscardableTab> {
  tab(tabId: string): T | undefined
  contract: DiscardContract
  /** The window's views. A new view goes in at index 0, below the overlay layer, as every tab's does. */
  contentView: {
    addChildView(view: T['view'], index?: number): void
    removeChildView(view: T['view']): void
  }
  groups: FoldableGroups
  /** The tab's view has a new `webContents` id; whatever the window keys by id follows it. */
  onViewReplaced(tab: T, oldWebContentsId: number, newWebContentsId: number): void
}

interface HeldHistory {
  readonly entries: HistoryEntry[]
  readonly index: number
  readonly webContentsId: number
}

/** One window's discarded tabs: what each needs to come back, and the two moves. */
export class TabDiscards<T extends DiscardableTab> {
  readonly #host: TabDiscardsHost<T>
  /** The history of every discarded tab, in memory only (KTD9). */
  readonly #held = new Map<string, HeldHistory>()

  constructor(host: TabDiscardsHost<T>) {
    this.#host = host
  }

  /**
   * Unloads a tab: the history first, then the page is asked, and only a view that really went is removed.
   *
   * A tab activated in the moment between the request and the answer comes straight back, rather than leaving
   * its tile blank until it is activated a second time.
   */
  discard(tabId: string): void {
    const tab = this.#host.tab(tabId)
    if (tab === undefined) return
    const view = tab.view
    const contents = view.webContents
    if (contents.isDestroyed()) return
    const history = contents.navigationHistory
    const held: HeldHistory = {
      entries: history.getAllEntries(),
      index: history.getActiveIndex(),
      webContentsId: contents.id
    }
    const page: DiscardedPage = {
      url: tab.currentUrl,
      title: contents.getTitle(),
      muted: contents.isAudioMuted()
    }
    tab.beginDiscard()
    this.#host.contract.discard(tabId, (gone) => {
      if (!gone) {
        tab.endDiscard(null)
        return
      }
      this.#held.set(tabId, held)
      this.#host.contentView.removeChildView(view)
      tab.endDiscard(page)
      if (tab.tileIndex !== null) this.wake(tabId)
    })
  }

  /**
   * The tab is coming to the front: activated, or put in a tile. A discarded one gets a new view at index 0,
   * guarded, reported, and restored at the index it was left at; any other one loads if it was deferred.
   */
  wake(tabId: string): void {
    const tab = this.#host.tab(tabId)
    if (tab === undefined) return
    unfoldGroupOf(this.#host.groups, tabId)
    tab.markActive()
    const held = this.#held.get(tabId)
    if (held === undefined) {
      tab.loadIfDeferred()
      return
    }
    this.#held.delete(tabId)
    const url = tab.currentUrl
    tab.revive()
    const contents = tab.view.webContents
    this.#host.contentView.addChildView(tab.view, 0)
    this.#host.contract.track(tabId)
    this.#host.onViewReplaced(tab, held.webContentsId, contents.id)
    // A history the new renderer refuses still leaves the page it was on.
    void contents.navigationHistory
      .restore({ entries: held.entries, index: held.index })
      .catch(() => tab.loadUrl(url))
  }

  /** The tab closed; nothing of it is kept. */
  forget(tabId: string): void {
    this.#held.delete(tabId)
  }
}
