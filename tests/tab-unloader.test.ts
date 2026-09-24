import type { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import { captureWindow } from '@shared/session/model.js'
import { discardingFaviconCache } from '@shared/favicons/model.js'
import { discardingThumbnailCapturer } from '@shared/thumbnails/model.js'
import { UNSAVED_INPUT_CHANNEL } from '@shared/session/unload-policy.js'
import type { OverlayPresentation } from '@shared/overlay/surface.js'
import {
  TabDiscards,
  TabUnloader,
  UNLOAD_SWEEP_MS,
  installTabUnloading,
  unfoldGroupOf,
  unloadFactsOf,
  type DiscardableTab,
  type DiscardContract,
  type HistoryEntry,
  type TabDiscardsHost,
  type UnloadContents,
  type UnloadWindow,
  type UnloadableTab
} from '@main/browser/tab-unloader.js'
import { PermissionTabs } from '@main/browser/permission-tabs.js'
import { PermissionArbiter, type PermissionHost } from '@main/permissions/PermissionArbiter.js'
import { forgetfulSitePermissions } from '@main/permissions/model.js'
import { CloseContract, closesAtOnce, type CloseContractHost } from '@main/browser/unload-guard.js'
import { windowOfTab } from '@main/browser/sender-window.js'
import { Tab, type TabCallbacks, type TabWiring } from '@main/browser/Tab.js'

/**
 * Tab unloading (U15, KTD9): the one timer, the discard, and the way back.
 *
 * Three layers, each against the real code of the layer below where that is possible:
 *
 *   - `TabUnloader` with fake windows: which tabs a sweep sends away, and that there is one timer.
 *   - `TabDiscards` with fake tabs: the snapshot, the removal, the new view at index 0 and `restore()`.
 *   - The real `Tab` and the real `CloseContract` over a `webContents` made of an `EventEmitter`, so the
 *     listener count, the close that must not become a close, and the snapshot that must not reach the
 *     session are read off the objects the browser uses.
 */

// --- Electron, as much of it as `Tab`, `tab-view` and `unload-guard` touch -----------------------------

const electron = await vi.hoisted(async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  let nextId = 100

  interface Entry {
    url: string
    title: string
    pageState?: string
  }

  /** A renderer: an emitter that answers the calls a tab makes, and closes the way Electron does. */
  class FakeContents extends Emitter {
    readonly id = ++nextId
    destroyed = false
    url = ''
    title = ''
    audioMuted = false
    webRtcPolicy = ''
    /** The page has a `beforeunload` that objects. */
    objects = false
    entries: Entry[] = []
    index = -1
    readonly restored: Array<{ entries: Entry[]; index?: number }> = []
    readonly loaded: string[] = []
    restoreFails = false
    readonly navigationHistory = {
      canGoBack: (): boolean => false,
      canGoForward: (): boolean => false,
      goBack: (): void => undefined,
      goForward: (): void => undefined,
      getAllEntries: (): Entry[] => this.entries.map((entry) => ({ ...entry })),
      getActiveIndex: (): number => this.index,
      restore: (options: { entries: Entry[]; index?: number }): Promise<void> => {
        this.restored.push(options)
        return this.restoreFails ? Promise.reject(new Error('refused')) : Promise.resolve()
      }
    }
    isDestroyed(): boolean {
      return this.destroyed
    }
    getURL(): string {
      return this.url
    }
    getTitle(): string {
      return this.title
    }
    isLoading(): boolean {
      return false
    }
    isAudioMuted(): boolean {
      return this.audioMuted
    }
    setAudioMuted(muted: boolean): void {
      this.audioMuted = muted
    }
    isCurrentlyAudible(): boolean {
      return false
    }
    isDevToolsOpened(): boolean {
      return false
    }
    setWindowOpenHandler(): void {}
    setWebRTCIPHandlingPolicy(policy: string): void {
      this.webRtcPolicy = policy
    }
    setVisualZoomLevelLimits(): Promise<void> {
      return Promise.resolve()
    }
    setZoomFactor(): void {}
    loadURL(url: string): Promise<void> {
      this.loaded.push(url)
      return Promise.resolve()
    }
    /** Electron's order on the way out: `close` from `CloseContents`, then `destroyed`. */
    close(options?: { waitForBeforeUnload: boolean }): void {
      if (options?.waitForBeforeUnload === true && this.objects) {
        this.emit('will-prevent-unload', { preventDefault: () => undefined })
        return
      }
      this.emit('close')
      this.destroyed = true
      this.emit('destroyed')
    }
  }

  const views: FakeView[] = []

  /**
   * A view as Electron 43 has one: its `webContents` getter reads a weak pointer, and gives `undefined`
   * once the contents are destroyed — already while `destroyed` is being emitted. A fake that went on
   * handing back the destroyed contents is what let every `view.webContents.isDestroyed()` pass here and
   * throw in the browser (`view-contents.ts`).
   */
  class FakeView {
    readonly #contents = new FakeContents()
    constructor(readonly options: { webPreferences: Record<string, unknown> }) {
      views.push(this)
    }
    get webContents(): FakeContents | undefined {
      return this.#contents.destroyed ? undefined : this.#contents
    }
    /** The contents the view had, gone or not; what a test reads a closed page's state off. */
    get heldContents(): FakeContents {
      return this.#contents
    }
    setBounds(): void {}
    setVisible(): void {}
  }

  return {
    WebContentsView: FakeView,
    views,
    app: Object.assign(new Emitter(), { getLocale: () => 'en-US', isPackaged: false }),
    autoUpdater: new Emitter(),
    dialog: { showMessageBoxSync: vi.fn<(...args: unknown[]) => number>(() => 0) }
  }
})

vi.mock('electron', () => electron)

type FakeView = (typeof electron.views)[number]
type FakeContents = FakeView['heldContents']

// --- fakes for the two upper layers ---------------------------------------------------------------------

const MINUTE = 60_000
const NOW = 10_000 * MINUTE

interface FakeTabContents {
  id: number
  destroyed: boolean
  title: string
  muted: boolean
  audible: boolean
  devtools: boolean
  entries: HistoryEntry[]
  index: number
  restored: Array<{ entries: HistoryEntry[]; index?: number }>
  restoreFails: boolean
}

let fakeId = 1

function fakeContents(overrides: Partial<FakeTabContents> = {}): FakeTabContents & {
  isDestroyed(): boolean
  getTitle(): string
  isAudioMuted(): boolean
  isCurrentlyAudible(): boolean
  isDevToolsOpened(): boolean
  navigationHistory: UnloadContents['navigationHistory']
} {
  const state: FakeTabContents = {
    id: fakeId++,
    destroyed: false,
    title: 'A page',
    muted: false,
    audible: false,
    devtools: false,
    entries: [
      { url: 'https://a.example/', title: 'A' },
      { url: 'https://a.example/2', title: 'A2', pageState: 'scrolled' }
    ],
    index: 1,
    restored: [],
    restoreFails: false,
    ...overrides
  }
  return Object.assign(state, {
    isDestroyed: () => state.destroyed,
    getTitle: () => state.title,
    isAudioMuted: () => state.muted,
    isCurrentlyAudible: () => state.audible,
    isDevToolsOpened: () => state.devtools,
    navigationHistory: {
      getAllEntries: () => state.entries.map((entry) => ({ ...entry })),
      getActiveIndex: () => state.index,
      restore: (options: { entries: HistoryEntry[]; index?: number }) => {
        state.restored.push(options)
        return state.restoreFails ? Promise.reject(new Error('refused')) : Promise.resolve()
      }
    }
  })
}

type FakeTab = UnloadableTab & {
  view: { webContents: ReturnType<typeof fakeContents> }
  lastActiveAt: number
  pinned: boolean
  tileIndex: number | null
  unloaded: boolean
  objected: boolean
  hasMedia: boolean
  unsavedInput: boolean
  htmlFullscreen: boolean
  failure: unknown
  currentUrl: string
  calls: string[]
  endedWith: Array<unknown>
  loadedUrls: string[]
}

function fakeTab(id: string, overrides: Partial<FakeTab> = {}): FakeTab {
  const tab: FakeTab = {
    id,
    view: { webContents: fakeContents() },
    currentUrl: 'https://a.example/2',
    lastActiveAt: NOW - 45 * MINUTE,
    pinned: false,
    tileIndex: null,
    loading: false,
    failure: undefined,
    hasMedia: false,
    unsavedInput: false,
    htmlFullscreen: false,
    objected: false,
    unloaded: false,
    calls: [],
    endedWith: [],
    loadedUrls: [],
    markActive: () => {
      tab.calls.push('markActive')
    },
    beginDiscard: () => {
      tab.calls.push('beginDiscard')
    },
    endDiscard: (page) => {
      tab.calls.push('endDiscard')
      tab.endedWith.push(page)
      if (page !== null) tab.unloaded = true
    },
    revive: () => {
      tab.calls.push('revive')
      tab.unloaded = false
      tab.view = { webContents: fakeContents({ entries: [], index: -1 }) }
    },
    loadIfDeferred: () => {
      tab.calls.push('loadIfDeferred')
    },
    loadUrl: (url) => {
      tab.loadedUrls.push(url)
    },
    ...overrides
  }
  return tab
}

/** The window's half of the contract, answering when the test says so. */
function fakeContract(): DiscardContract & {
  answer(gone: boolean): void
  tracked: string[]
  asked: string[]
} {
  const waiting: Array<(gone: boolean) => void> = []
  return {
    tracked: [],
    asked: [],
    discard(tabId, settled) {
      this.asked.push(tabId)
      waiting.push(settled)
    },
    track(tabId) {
      this.tracked.push(tabId)
    },
    answer(gone) {
      waiting.shift()?.(gone)
    }
  }
}

interface Harness<T extends DiscardableTab> {
  discards: TabDiscards<T>
  children: Array<{ op: 'add' | 'remove'; view: T['view']; index?: number }>
  replaced: Array<[string, number, number]>
  groups: Array<{ id: string; collapsed: boolean; tabIds: string[] }>
}

function harnessWith<T extends DiscardableTab>(tabs: T[], contract: DiscardContract): Harness<T> {
  const children: Harness<T>['children'] = []
  const replaced: Harness<T>['replaced'] = []
  const groups: Harness<T>['groups'] = []
  const host: TabDiscardsHost<T> = {
    tab: (tabId) => tabs.find((tab) => tab.id === tabId),
    contract,
    contentView: {
      addChildView: (view, index) => {
        children.push({ op: 'add', view, ...(index === undefined ? {} : { index }) })
      },
      removeChildView: (view) => {
        children.push({ op: 'remove', view })
      }
    },
    groups: {
      groups: () => groups,
      setCollapsed: (id, collapsed) => {
        const group = groups.find((candidate) => candidate.id === id)
        if (group !== undefined) group.collapsed = collapsed
      }
    },
    onViewReplaced: (tab, oldId, newId) => {
      replaced.push([tab.id, oldId, newId])
    }
  }
  return { discards: new TabDiscards(host), children, replaced, groups }
}

function harness<T extends DiscardableTab>(
  tabs: T[]
): Harness<T> & { contract: ReturnType<typeof fakeContract> } {
  const contract = fakeContract()
  return { ...harnessWith(tabs, contract), contract }
}

function fakeWindow(
  tabs: FakeTab[],
  presentation: OverlayPresentation | null = null
): UnloadWindow & { discarded: string[] } {
  const discarded: string[] = []
  return {
    tabs,
    discarded,
    overlayPresentation: () => presentation,
    discardTab: (tabId) => {
      discarded.push(tabId)
    }
  }
}

function unloader(
  windows: Array<ReturnType<typeof fakeWindow>>,
  options: {
    settings?: Partial<SettingsSnapshot>
    waiting?: Array<{ waitsOn(id: number): boolean } | null>
    quitting?: () => boolean
  } = {}
): TabUnloader {
  return new TabUnloader({
    windows: () => windows,
    settings: { snapshot: () => ({ ...defaultSettings(), ...options.settings }) },
    waiting: options.waiting ?? [],
    quitting: options.quitting ?? (() => false),
    now: () => NOW,
    every: () => () => undefined
  })
}

// --- the timer ------------------------------------------------------------------------------------------

describe('TabUnloader', () => {
  it('runs one timer for the whole program, once a minute, however many windows there are', () => {
    const every = vi.fn<(ms: number, run: () => void) => () => void>(() => () => undefined)
    const windows = [fakeWindow([fakeTab('a')]), fakeWindow([fakeTab('b')])]
    const first = new TabUnloader({
      windows: () => windows,
      settings: { snapshot: defaultSettings },
      waiting: [],
      quitting: () => false,
      now: () => NOW,
      every
    })
    expect(every).toHaveBeenCalledTimes(1)
    expect(every.mock.calls[0]?.[0]).toBe(UNLOAD_SWEEP_MS)
    expect(UNLOAD_SWEEP_MS).toBe(MINUTE)

    // The timer's tick is the sweep.
    every.mock.calls[0]?.[1]()
    expect(windows.map((window) => window.discarded)).toEqual([['a'], ['b']])
    first.dispose()
  })

  it('stops its timer when disposed', () => {
    const stop = vi.fn()
    const every = vi.fn<(ms: number, run: () => void) => () => void>(() => stop)
    new TabUnloader({
      windows: () => [],
      settings: { snapshot: defaultSettings },
      waiting: [],
      quitting: () => false,
      every
    }).dispose()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('starts once per process, however often it is installed', () => {
    const options = {
      windows: () => [],
      settings: { snapshot: defaultSettings },
      waiting: [],
      quitting: () => false
    }
    const first = installTabUnloading(options)
    expect(installTabUnloading(options)).toBe(first)
    first.dispose()
  })

  it('sends every candidate of every window to its window, and nobody else', () => {
    const one = fakeWindow([fakeTab('a'), fakeTab('b', { pinned: true })])
    const two = fakeWindow([fakeTab('c', { lastActiveAt: NOW - 5 * MINUTE }), fakeTab('d')])
    unloader([one, two]).sweep()
    expect(one.discarded).toEqual(['a'])
    expect(two.discarded).toEqual(['d'])
  })

  it('unloads nothing with `advanced.unloadInactiveTabs` off', () => {
    const window = fakeWindow([fakeTab('a', { lastActiveAt: 0 })])
    unloader([window], { settings: { 'advanced.unloadInactiveTabs': false } }).sweep()
    expect(window.discarded).toEqual([])
  })

  it('gathers no facts about any tab with `advanced.unloadInactiveTabs` off', () => {
    const window = fakeWindow([fakeTab('a', { lastActiveAt: 0 })])
    const overlayPresentation = vi.spyOn(window, 'overlayPresentation')
    const windows = vi.fn(() => [window])
    new TabUnloader({
      windows,
      settings: {
        snapshot: () => ({ ...defaultSettings(), 'advanced.unloadInactiveTabs': false })
      },
      waiting: [],
      quitting: () => false,
      now: () => NOW,
      every: () => () => undefined
    }).sweep()
    expect(windows).not.toHaveBeenCalled()
    expect(overlayPresentation).not.toHaveBeenCalled()
  })

  it('waits as long as `advanced.unloadAfterMinutes` says', () => {
    const window = fakeWindow([fakeTab('a', { lastActiveAt: NOW - 45 * MINUTE })])
    unloader([window], { settings: { 'advanced.unloadAfterMinutes': 60 } }).sweep()
    expect(window.discarded).toEqual([])
    unloader([window], { settings: { 'advanced.unloadAfterMinutes': 45 } }).sweep()
    expect(window.discarded).toEqual(['a'])
  })

  it('unloads nothing once a quit has begun', () => {
    const window = fakeWindow([fakeTab('a')])
    unloader([window], { quitting: () => true }).sweep()
    expect(window.discarded).toEqual([])
  })

  it('keeps a tab something outside the window is waiting on: autofill, a permission, the picker', () => {
    const waited = fakeTab('a')
    const free = fakeTab('b')
    const window = fakeWindow([waited, free])
    const waitsOn = (id: number): boolean => id === waited.view.webContents.id
    unloader([window], { waiting: [null, { waitsOn }] }).sweep()
    expect(window.discarded).toEqual(['b'])
  })

  it('keeps every tab of a window whose popup-or-redirect question is on screen', () => {
    const asking = fakeWindow([fakeTab('a')], {
      kind: 'navigation-request',
      requestId: 'nav-1',
      navigationKind: 'popup',
      url: 'https://b.example/',
      host: 'b.example'
    })
    const other = fakeWindow([fakeTab('b')], null)
    unloader([asking, other]).sweep()
    expect(asking.discarded).toEqual([])
    expect(other.discarded).toEqual(['b'])
  })
})

describe('unloadFactsOf', () => {
  it('reads each fact off the tab and its view', () => {
    const tab = fakeTab('a', {
      tileIndex: 2,
      pinned: true,
      hasMedia: true,
      unsavedInput: true,
      htmlFullscreen: true,
      objected: true,
      failure: { kind: 'crashed' },
      currentUrl: 'tessera://settings'
    })
    tab.view.webContents.audible = true
    tab.view.webContents.devtools = true
    expect(unloadFactsOf(tab, { asking: false, waiting: [] })).toEqual({
      tabId: 'a',
      lastActiveAt: tab.lastActiveAt,
      tile: true,
      audible: true,
      media: true,
      pinned: true,
      loading: false,
      devtools: true,
      fullscreen: true,
      prompt: false,
      input: true,
      internal: true,
      failure: true,
      objected: true,
      unloaded: false
    })
  })

  it('counts a tab whose view is gone as unloaded, and asks the gone view nothing', () => {
    const tab = fakeTab('a')
    tab.view.webContents.destroyed = true
    tab.view.webContents.audible = true
    const facts = unloadFactsOf(tab, { asking: false, waiting: [{ waitsOn: () => true }] })
    expect(facts).toMatchObject({ unloaded: true, audible: false, devtools: false, prompt: false })
  })

  it.each([
    ['https://a.example/', false],
    ['http://a.example/', false],
    ['file:///home/me/page.html', false],
    ['', true],
    ['about:blank', true],
    ['tessera://history', true],
    ['data:text/html,x', true]
  ])('calls %j internal: %s', (url, internal) => {
    expect(
      unloadFactsOf(fakeTab('a', { currentUrl: url }), { asking: false, waiting: [] })
    ).toMatchObject({
      internal
    })
  })
})

// --- the discard and the way back -----------------------------------------------------------------------

describe('TabDiscards', () => {
  it('takes the snapshot, asks the contract, and removes the view once it is gone', () => {
    const tab = fakeTab('a')
    tab.view.webContents.muted = true
    const old = tab.view
    const { discards, contract, children } = harness([tab])

    discards.discard('a')
    expect(tab.calls).toEqual(['beginDiscard'])
    expect(contract.asked).toEqual(['a'])
    expect(children).toEqual([])

    contract.answer(true)
    expect(children).toEqual([{ op: 'remove', view: old }])
    expect(tab.endedWith).toEqual([{ url: 'https://a.example/2', title: 'A page', muted: true }])
  })

  it('leaves a tab whose page objected exactly as it was', () => {
    const tab = fakeTab('a')
    const { discards, contract, children } = harness([tab])
    discards.discard('a')
    contract.answer(false)
    expect(tab.endedWith).toEqual([null])
    expect(children).toEqual([])
    // Nothing was kept for it, so activating it is an ordinary activation.
    discards.wake('a')
    expect(tab.calls).toEqual(['beginDiscard', 'endDiscard', 'markActive', 'loadIfDeferred'])
  })

  it('does nothing for a tab it does not know, or one whose view is already gone', () => {
    const gone = fakeTab('gone')
    gone.view.webContents.destroyed = true
    const { discards, contract } = harness([gone])
    discards.discard('nobody')
    discards.discard('gone')
    discards.wake('nobody')
    expect(contract.asked).toEqual([])
    expect(gone.calls).toEqual([])
  })

  it('brings a discarded tab back in a new view at index 0, restored at the index it was left at', () => {
    const tab = fakeTab('a')
    const oldId = tab.view.webContents.id
    const { discards, contract, children, replaced } = harness([tab])
    discards.discard('a')
    contract.answer(true)

    discards.wake('a')
    expect(tab.calls).toEqual(['beginDiscard', 'endDiscard', 'markActive', 'revive'])
    expect(children.at(-1)).toEqual({ op: 'add', view: tab.view, index: 0 })
    expect(contract.tracked).toEqual(['a'])
    expect(replaced).toEqual([['a', oldId, tab.view.webContents.id]])
    expect(tab.view.webContents.restored).toEqual([
      {
        entries: [
          { url: 'https://a.example/', title: 'A' },
          { url: 'https://a.example/2', title: 'A2', pageState: 'scrolled' }
        ],
        index: 1
      }
    ])
  })

  it('brings it back once: a second activation is an ordinary one', () => {
    const tab = fakeTab('a')
    const { discards, contract } = harness([tab])
    discards.discard('a')
    contract.answer(true)
    discards.wake('a')
    discards.wake('a')
    expect(tab.calls.slice(-2)).toEqual(['markActive', 'loadIfDeferred'])
  })

  it('loads the address when the history cannot be restored', async () => {
    const tab = fakeTab('a')
    const { discards, contract } = harness([tab])
    discards.discard('a')
    contract.answer(true)
    tab.revive = () => {
      tab.view = { webContents: fakeContents({ restoreFails: true }) }
    }
    discards.wake('a')
    await vi.waitFor(() => expect(tab.loadedUrls).toEqual(['https://a.example/2']))
  })

  it('attaches, guards and restores nothing when the revived tab has no live page', () => {
    const tab = fakeTab('a')
    const { discards, contract, children, replaced } = harness([tab])
    discards.discard('a')
    contract.answer(true)
    // A view whose getter already gives no contents, as Electron's does for a page that has gone.
    tab.revive = () => Object.assign(tab, { view: { webContents: undefined } })
    discards.wake('a')
    expect(children.filter((child) => child.op === 'add')).toEqual([])
    expect(contract.tracked).toEqual([])
    expect(replaced).toEqual([])
  })

  it('lets a tab restored as deferred load into the view it has', () => {
    const tab = fakeTab('a', { unloaded: true })
    const { discards, children, contract } = harness([tab])
    discards.wake('a')
    expect(tab.calls).toEqual(['markActive', 'loadIfDeferred'])
    expect(children).toEqual([])
    expect(contract.tracked).toEqual([])
  })

  it('brings a tab back at once when it was activated while its page was still going', () => {
    const tab = fakeTab('a')
    const { discards, contract } = harness([tab])
    discards.discard('a')
    // Clicked, and put in a tile, in the moment between the request and the view going.
    tab.tileIndex = 0
    contract.answer(true)
    expect(tab.calls).toEqual(['beginDiscard', 'endDiscard', 'markActive', 'revive'])
    expect(contract.tracked).toEqual(['a'])
  })

  it('opens the folded group of the tab it brings back', () => {
    const tab = fakeTab('a')
    const { discards, contract, groups } = harness([tab])
    groups.push(
      { id: 'g1', collapsed: true, tabIds: ['a', 'b'] },
      { id: 'g2', collapsed: true, tabIds: ['c'] }
    )
    discards.discard('a')
    contract.answer(true)
    discards.wake('a')
    expect(groups.map((group) => group.collapsed)).toEqual([false, true])
  })

  it('forgets what it held for a tab that closed', () => {
    const tab = fakeTab('a')
    const { discards, contract } = harness([tab])
    discards.discard('a')
    contract.answer(true)
    discards.forget('a')
    discards.wake('a')
    expect(tab.calls.at(-1)).toBe('loadIfDeferred')
  })
})

describe('unfoldGroupOf', () => {
  it('opens only a folded group that holds the tab', () => {
    const calls: Array<[string, boolean]> = []
    const groups = {
      groups: () => [
        { id: 'open', collapsed: false, tabIds: ['a'] },
        { id: 'other', collapsed: true, tabIds: ['b'] }
      ],
      setCollapsed: (id: string, collapsed: boolean) => calls.push([id, collapsed])
    }
    unfoldGroupOf(groups, 'a')
    unfoldGroupOf(groups, 'z')
    expect(calls).toEqual([])
    unfoldGroupOf(groups, 'b')
    expect(calls).toEqual([['other', false]])
  })
})

// --- the real tab ---------------------------------------------------------------------------------------

function callbacks(): TabCallbacks & { closeRequests: number } {
  const recorded = {
    closeRequests: 0,
    onStateChanged: vi.fn(),
    onFailureChanged: vi.fn(),
    onFocused: vi.fn(),
    onOpenNewTab: vi.fn(() => false),
    onAutomaticNavigation: vi.fn(),
    onEnterHtmlFullscreen: vi.fn(),
    onLeaveHtmlFullscreen: vi.fn(),
    onCloseRequested: () => {
      recorded.closeRequests += 1
    },
    onContextMenu: vi.fn(),
    onPointerMoved: vi.fn(),
    onZoomGesture: vi.fn(),
    onPageKeystroke: vi.fn()
  }
  return recorded
}

const wiring: TabWiring = {
  history: { recordVisit: () => undefined, noteTitle: () => undefined },
  favicons: discardingFaviconCache,
  thumbnails: discardingThumbnailCapturer,
  thumbnailSettleDelayMs: 0
}

function realTab(settings: Partial<SettingsSnapshot> = {}): {
  tab: Tab
  calls: ReturnType<typeof callbacks>
} {
  const calls = callbacks()
  const tab = new Tab({
    id: `tab-${fakeId++}`,
    session: {} as unknown as ConstructorParameters<typeof Tab>[0]['session'],
    getSettings: () => ({ ...defaultSettings(), ...settings }),
    callbacks: calls,
    wiring
  })
  return { tab, calls }
}

/** The contents of the tab's current view, gone or not: the test's view of it, not the tab's. */
function contentsOf(tab: Tab): FakeContents {
  return (tab.view as unknown as FakeView).heldContents
}

/** Every event a view is subscribed to, with how many listeners each has. */
function listenerCounts(contents: EventEmitter): Record<string, number> {
  return Object.fromEntries(
    contents
      .eventNames()
      .map((name) => [String(name), contents.listenerCount(name)] as const)
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

/** A page with history, as the real tab reads it. */
function visit(tab: Tab, url = 'https://a.example/2'): void {
  const contents = contentsOf(tab)
  contents.url = url
  contents.title = 'A2'
  contents.entries = [
    { url: 'https://a.example/', title: 'A' },
    { url, title: 'A2', pageState: 'scrolled-to-700' }
  ]
  contents.index = 1
  contents.emit('did-navigate')
}

function closeHost(tabs: Tab[]): CloseContractHost & { finished: string[] } {
  const finished: string[] = []
  return {
    finished,
    on: () => undefined,
    tab: (tabId) => tabs.find((tab) => tab.id === tabId),
    groups: {
      displayOrder: () => tabs.map((tab) => tab.id),
      groups: () => [],
      setCollapsed: () => undefined
    },
    activateTab: () => undefined,
    confirm: () => {
      throw new Error('a discard asked the user')
    },
    finish: (tabId) => {
      finished.push(tabId)
    },
    closeWindow: () => undefined,
    shutdown: { begun: false },
    after: () => () => undefined
  }
}

function realHarness(tab: Tab): {
  discards: TabDiscards<Tab>
  close: CloseContract
  host: ReturnType<typeof closeHost>
  children: Harness<Tab>['children']
  replaced: Harness<Tab>['replaced']
} {
  const host = closeHost([tab])
  const close = new CloseContract(host)
  close.track(tab.id)
  const { discards, children, replaced } = harnessWith([tab], close)
  return { discards, close, host, children, replaced }
}

describe('a real tab, discarded and brought back', () => {
  it('builds its view sandboxed, in the content role, with the WebRTC policy applied', () => {
    const { tab } = realTab({ 'splitView.autoplayInTiles': 'allow' })
    const view = tab.view as unknown as FakeView
    expect(view.options.webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required'
    })
    expect(contentsOf(tab).webRtcPolicy).not.toBe('')
    const { tab: gated } = realTab({ 'splitView.autoplayInTiles': 'block' })
    expect((gated.view as unknown as FakeView).options.webPreferences['autoplayPolicy']).toBe(
      'user-gesture-required'
    )
  })

  it('never asks the page to close and never finishes a close', () => {
    const { tab, calls } = realTab()
    visit(tab)
    const { discards, host } = realHarness(tab)
    discards.discard(tab.id)
    // The fake closed the way Electron does, `close` first — which a tab normally reports upwards.
    expect(contentsOf(tab).destroyed).toBe(true)
    expect(calls.closeRequests).toBe(0)
    expect(host.finished).toEqual([])
    expect(tab.toState()).toMatchObject({ url: 'https://a.example/2', title: 'A2', unloaded: true })
  })

  it('stays loaded, without a dialogue, when the page objects', () => {
    const { tab } = realTab()
    visit(tab)
    contentsOf(tab).objects = true
    const { discards, children } = realHarness(tab)
    electron.dialog.showMessageBoxSync.mockClear()
    discards.discard(tab.id)
    expect(electron.dialog.showMessageBoxSync).not.toHaveBeenCalled()
    expect(contentsOf(tab).destroyed).toBe(false)
    expect(children).toEqual([])
    expect(tab.toState().unloaded).toBe(false)
    // And it is not asked again until it navigates.
    expect(tab.objected).toBe(true)
    visit(tab, 'https://a.example/3')
    expect(tab.objected).toBe(false)
  })

  it('gives the new view the same listeners the old one had, and leaves none on the old one', () => {
    const { tab } = realTab()
    visit(tab)
    const first = contentsOf(tab)
    const { discards, children, replaced } = realHarness(tab)
    const before = listenerCounts(first)
    expect(Object.keys(before).length).toBeGreaterThan(15)

    discards.discard(tab.id)
    expect(first.eventNames()).toEqual([])

    discards.wake(tab.id)
    const second = contentsOf(tab)
    expect(second).not.toBe(first)
    expect(listenerCounts(second)).toEqual(before)
    expect(children.at(-1)).toEqual({ op: 'add', view: tab.view, index: 0 })
    expect(replaced).toEqual([[tab.id, first.id, second.id]])
    expect(second.restored).toEqual([
      {
        entries: [
          { url: 'https://a.example/', title: 'A' },
          { url: 'https://a.example/2', title: 'A2', pageState: 'scrolled-to-700' }
        ],
        index: 1
      }
    ])
    expect(second.loaded).toEqual([])
    expect(tab.toState()).toMatchObject({ unloaded: false, pendingInput: 'https://a.example/2' })
  })

  it('brings a muted tab back muted', () => {
    const { tab } = realTab()
    visit(tab)
    tab.setMuted(true)
    const { discards } = realHarness(tab)
    discards.discard(tab.id)
    // A discarded tab has no view to mute; asking must not throw.
    expect(tab.muted).toBe(false)
    tab.setMuted(false)
    discards.wake(tab.id)
    expect(contentsOf(tab).audioMuted).toBe(true)
  })

  it('keeps the snapshot out of the tab state and out of the session file', () => {
    const { tab } = realTab()
    visit(tab)
    const { discards } = realHarness(tab)
    discards.discard(tab.id)
    const state = tab.toState()
    const saved = JSON.stringify(
      captureWindow('w1', { layout: '1x1', fractions: {}, activeTile: 0, tabs: [state] })
    )
    for (const text of [JSON.stringify(state), saved]) {
      expect(text).not.toContain('scrolled-to-700')
      expect(text).not.toContain('pageState')
      expect(text).not.toContain('entries')
    }
    expect(saved).toContain('https://a.example/2')
  })

  it('lets a restore-deferred tab load into its own view, and gives a discarded one a new view', () => {
    const { tab: deferred } = realTab()
    deferred.deferLoad({ url: 'https://d.example/', title: 'D' })
    const deferredView = deferred.view
    const one = realHarness(deferred)
    one.discards.wake(deferred.id)
    expect(deferred.view).toBe(deferredView)
    expect(contentsOf(deferred).loaded).toEqual(['https://d.example/'])
    expect(one.children).toEqual([])

    const { tab: discarded } = realTab()
    visit(discarded)
    const discardedView = discarded.view
    const two = realHarness(discarded)
    two.discards.discard(discarded.id)
    two.discards.wake(discarded.id)
    expect(discarded.view).not.toBe(discardedView)
    expect(contentsOf(discarded).loaded).toEqual([])
    expect(contentsOf(discarded).restored).toHaveLength(1)
  })

  it('reads a renderer that goes during the unload as no failure', () => {
    const { tab, calls } = realTab()
    visit(tab)
    const contents = contentsOf(tab)
    contents.close = () => {
      contents.emit('render-process-gone', {}, { reason: 'memory-eviction', exitCode: 0 })
      contents.destroyed = true
      contents.emit('destroyed')
    }
    realHarness(tab).discards.discard(tab.id)
    expect(tab.failure).toBeUndefined()
    expect(calls.onFailureChanged).not.toHaveBeenCalled()
  })

  it('knows about typing nobody sent, until the page submits or navigates', () => {
    const { tab } = realTab()
    visit(tab)
    const contents = contentsOf(tab)
    contents.emit('ipc-message', {}, UNSAVED_INPUT_CHANNEL, true)
    expect(tab.unsavedInput).toBe(true)
    contents.emit('ipc-message', {}, UNSAVED_INPUT_CHANNEL, false)
    expect(tab.unsavedInput).toBe(false)
    contents.emit('ipc-message', {}, UNSAVED_INPUT_CHANNEL, true)
    visit(tab, 'https://a.example/3')
    expect(tab.unsavedInput).toBe(false)
    // Another channel says nothing about it.
    contents.emit('ipc-message', {}, 'tessera:zoom-gesture', true)
    expect(tab.unsavedInput).toBe(false)
  })

  it('counts paused media and fullscreen as use, and a navigation as activity', () => {
    const { tab } = realTab()
    visit(tab)
    const contents = contentsOf(tab)
    contents.emit('media-started-playing')
    contents.emit('media-paused')
    expect(tab.hasMedia).toBe(true)
    contents.emit('enter-html-full-screen')
    expect(tab.htmlFullscreen).toBe(true)
    contents.emit('leave-html-full-screen')
    expect(tab.htmlFullscreen).toBe(false)

    const before = tab.lastActiveAt
    vi.useFakeTimers({ now: before + 5 * MINUTE })
    try {
      visit(tab, 'https://a.example/4')
      expect(tab.hasMedia).toBe(false)
      expect(tab.lastActiveAt).toBe(before + 5 * MINUTE)
      contents.emit('focus')
      tab.markActive()
      expect(tab.lastActiveAt).toBe(before + 5 * MINUTE)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still closes a tab whose page calls window.close()', () => {
    const { tab, calls } = realTab()
    contentsOf(tab).emit('close')
    expect(calls.closeRequests).toBe(1)
  })

  it('answers for a discarded tab without touching the view that is gone', () => {
    const { tab } = realTab()
    visit(tab)
    realHarness(tab).discards.discard(tab.id)
    expect(() => {
      tab.goBack()
      tab.goForward()
      tab.reload(false)
      tab.reload(true)
      tab.stop()
      tab.toggleDevTools()
      tab.loadUrl('https://b.example/')
      tab.destroy()
    }).not.toThrow()
    expect(tab.loading).toBe(false)
  })
})

// --- the view Electron has emptied ---------------------------------------------------------------------

/*
  Electron's getter gives `undefined` for the contents of a view whose page has gone, and it does so before
  `destroyed` reaches anybody (`view-contents.ts`). These are the two ways a tab gets there: a close that is
  finished from that very listener, and a discard that leaves the tab holding the empty view until it is woken.
  Each is driven the way the window drives it, with the real `Tab` and the real contract.
*/
describe('a real tab whose view Electron has emptied', () => {
  it("closes from the tile bar's ×, finished from `destroyed`, without reading the emptied view", () => {
    // The tile bar sends `tabs:close`, the window's `closeTab` hands it to the contract, and the page is
    // asked: a web page in a split, which is what the bar is on and what does not close at once.
    const { tab } = realTab()
    visit(tab)
    const { tab: neighbour } = realTab()
    visit(neighbour, 'https://b.example/')
    const tabs = [tab, neighbour]
    const host = closeHost(tabs)
    const close = new CloseContract(host)
    for (const each of tabs) close.track(each.id)
    const laidOut: string[] = []
    // `#finishClose`, reduced to what it asks of the tabs: the closed one destroyed, the rest laid out anew.
    host.finish = (tabId) => {
      host.finished.push(tabId)
      const [closed] = tabs.splice(
        tabs.findIndex((candidate) => candidate.id === tabId),
        1
      )
      closed?.destroy()
      for (const kept of tabs) {
        kept.setBounds({ x: 0, y: 0, width: 800, height: 600 })
        kept.setVisible(true)
        laidOut.push(kept.toState().url)
      }
    }

    expect(() => close.closeTab(tab.id)).not.toThrow()

    expect(contentsOf(tab).destroyed).toBe(true)
    expect(tab.view.webContents).toBeUndefined()
    expect(host.finished).toEqual([tab.id])
    expect(laidOut).toEqual(['https://b.example/'])
    // Whatever still holds the closed tab gets an answer rather than an exception.
    expect(tab.toState()).toMatchObject({ url: '', title: '', muted: false, security: 'internal' })
    expect(tab.loading).toBe(false)
  })

  it('answers for a discarded tab in every pass the window and the sweep make over it', () => {
    const { tab } = realTab()
    visit(tab)
    const { discards, close, host } = realHarness(tab)
    const gone = contentsOf(tab)
    discards.discard(tab.id)
    expect(tab.view.webContents).toBeUndefined()

    expect(() => {
      tab.setBounds({ x: 0, y: 0, width: 800, height: 600 })
      tab.setVisible(false)
      tab.applyZoom()
      tab.applyVisualZoomLimits()
      tab.setZoomPercent(120)
    }).not.toThrow()
    expect(tab.toState()).toMatchObject({
      url: 'https://a.example/2',
      unloaded: true,
      muted: false
    })
    expect(unloadFactsOf(tab, { asking: false, waiting: [{ waitsOn: () => true }] })).toMatchObject(
      { unloaded: true, prompt: false, audible: false, devtools: false }
    )
    expect(closesAtOnce(tab)).toBe(true)
    const window = {
      window: { isDestroyed: () => false },
      ownsChromeWebContents: () => false,
      tabs: [tab]
    }
    expect(windowOfTab([window], gone.id)).toBeUndefined()

    // The strip's × on it: at once, with nothing to ask, and the tab destroyed in the same pass.
    host.finish = (tabId) => {
      host.finished.push(tabId)
      tab.destroy()
    }
    expect(() => close.closeTab(tab.id)).not.toThrow()
    expect(host.finished).toEqual([tab.id])
  })
})

// --- the permission dialogue after the view changed -----------------------------------------------------

describe('a permission request from a restored view', () => {
  it('reaches the dialogue over its tile, because the window knows the new id', async () => {
    const book = new PermissionTabs<Tab>()
    const { tab } = realTab()
    visit(tab)
    book.add(tab, tab.view.webContents.id, tab.currentUrl)

    const presented: OverlayPresentation[] = []
    const host: PermissionHost = {
      privateMode: false,
      presentOverlay: (presentation) => {
        presented.push(presentation)
      },
      dismissOverlay: () => undefined,
      activeTabWebContentsId: () => book.idOf(tab),
      onPermissionTabChange: (listener) => book.subscribe(listener)
    }
    const arbiter = new PermissionArbiter({
      rulesFor: () => forgetfulSitePermissions,
      getSettings: () => ({ ...defaultSettings(), 'permissions.geolocation': 'ask' })
    })

    const { discards } = realHarness(tab)
    discards.discard(tab.id)
    // What the window's `onViewReplaced` does, through the same book.
    const oldId = book.idOf(tab)
    discards.wake(tab.id)
    book.replaced(tab, tab.view.webContents.id)
    expect(book.idOf(tab)).not.toBe(oldId)

    const answer = arbiter.ask(
      { permission: 'geolocation', mediaTypes: [], origin: 'https://a.example' },
      host,
      tab.view.webContents.id
    )
    expect(presented.map((presentation) => presentation.kind)).toEqual(['permission-request'])
    expect(arbiter.waitsOn(tab.view.webContents.id)).toBe(true)
    expect(arbiter.waitsOn(oldId ?? -1)).toBe(false)
    arbiter.answer(
      (presented[0] as Extract<OverlayPresentation, { kind: 'permission-request' }>).requestId,
      'allow-once'
    )
    await expect(answer).resolves.toBe(true)
  })
})
