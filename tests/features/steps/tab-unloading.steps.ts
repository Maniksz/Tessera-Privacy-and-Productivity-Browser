import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import {
  TabDiscards,
  TabUnloader,
  type HistoryEntry,
  type UnloadableTab,
  type UnloadContents
} from '@main/browser/tab-unloader.js'
import { scope } from './world.js'

/**
 * Steps for `tab-unloading.feature`.
 *
 * The real policy, the real timer and the real discard, over a window of one tab whose view is a record of
 * what was done to it. The close contract answers at once — "gone", or "kept" for a page that objects —
 * which is its discard mode's whole behaviour. That the real contract asks nobody while doing so, and the
 * real `Tab` over a fake `webContents`, are `tests/tab-unloader.test.ts`: this file is loaded for every
 * scenario, so it imports nothing that needs Electron.
 */

const MINUTE = 60_000
const NOW = 100_000 * MINUTE

interface FakeView {
  readonly webContents: UnloadContents & {
    restored: Array<{ entries: HistoryEntry[]; index?: number }>
  }
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

interface UnloadingWorld {
  tab: Mutable<UnloadableTab> & {
    view: FakeView
    audible: boolean
    deferred: boolean
    loads: string[]
  }
  entries: HistoryEntry[]
  index: number
  objects: boolean
  waitedOn: boolean
  children: Array<{ op: 'add' | 'remove'; view: FakeView; index?: number }>
  discards: TabDiscards<UnloadingWorld['tab']>
  minutes: number | null
}

const KEY = 'unloadingWorld'

let nextId = 1

function view(world: () => UnloadingWorld): FakeView {
  const id = nextId++
  const restored: Array<{ entries: HistoryEntry[]; index?: number }> = []
  return {
    webContents: {
      id,
      restored,
      isDestroyed: () => false,
      getTitle: () => 'Page',
      isAudioMuted: () => false,
      isCurrentlyAudible: () => world().tab.audible,
      isDevToolsOpened: () => false,
      navigationHistory: {
        getAllEntries: () => world().entries,
        getActiveIndex: () => world().index,
        restore: (options) => {
          restored.push(options)
          return Promise.resolve()
        }
      }
    }
  }
}

function unloadingWorld(state: unknown): UnloadingWorld {
  const held = scope(state).scratch[KEY] as UnloadingWorld | undefined
  if (held === undefined) throw new Error('this scenario has no tab; add a Given for it')
  return held
}

function freshWorld(state: unknown, idleMinutes: number): UnloadingWorld {
  const get = (): UnloadingWorld => unloadingWorld(state)
  const tab: UnloadingWorld['tab'] = {
    id: 'tab-1',
    view: view(get),
    currentUrl: 'https://a.example/2',
    lastActiveAt: NOW - idleMinutes * MINUTE,
    tileIndex: null,
    pinned: false,
    loading: false,
    failure: undefined,
    hasMedia: false,
    unsavedInput: false,
    htmlFullscreen: false,
    objected: false,
    unloaded: false,
    deferred: false,
    audible: false,
    loads: [],
    markActive: () => undefined,
    beginDiscard: () => undefined,
    endDiscard: (page) => {
      if (page !== null) tab.unloaded = true
    },
    revive: () => {
      tab.unloaded = false
      tab.view = view(get)
    },
    loadIfDeferred: () => {
      if (!tab.deferred) return
      tab.deferred = tab.unloaded = false
      tab.loads.push(tab.currentUrl)
    },
    loadUrl: (url) => tab.loads.push(url)
  }
  const children: UnloadingWorld['children'] = []
  const world: UnloadingWorld = {
    tab,
    entries: [{ url: 'https://a.example/2', title: 'A2' }],
    index: 0,
    objects: false,
    waitedOn: false,
    children,
    minutes: null,
    discards: new TabDiscards({
      tab: (tabId) => (tabId === tab.id ? tab : undefined),
      contract: {
        discard: (_tabId, settled) => settled(!get().objects),
        track: () => undefined
      },
      contentView: {
        addChildView: (added, index) => {
          children.push({ op: 'add', view: added, ...(index === undefined ? {} : { index }) })
        },
        removeChildView: (removed) => {
          children.push({ op: 'remove', view: removed })
        }
      },
      groups: { groups: () => [], setCollapsed: () => undefined },
      onViewReplaced: () => undefined
    })
  }
  scope(state).scratch[KEY] = world
  return world
}

Given('a background tab left alone for {int} minutes', (state: unknown, minutes: number) => {
  freshWorld(state, minutes)
})

Given('the tab has a paused video', (state: unknown) => {
  unloadingWorld(state).tab.hasMedia = true
})

const CONDITIONS: Record<string, (world: UnloadingWorld) => void> = {
  'is shown in a tile': (world) => {
    world.tab.tileIndex = 0
  },
  'is playing sound': (world) => {
    world.tab.audible = true
  },
  'is pinned': (world) => {
    world.tab.pinned = true
  },
  'is still loading': (world) => {
    world.tab.loading = true
  },
  'has typing nobody sent': (world) => {
    world.tab.unsavedInput = true
  },
  'shows an internal page': (world) => {
    world.tab.currentUrl = 'tessera://history'
  },
  'shows a failure': (world) => {
    world.tab.failure = { kind: 'offline', code: -106, host: 'a.example' }
  },
  'has a permission question waiting': (world) => {
    world.waitedOn = true
  }
}

Given(
  new RegExp(`^the tab (${Object.keys(CONDITIONS).join('|')})$`),
  (state: unknown, condition: string) => {
    const apply = CONDITIONS[condition]
    if (apply === undefined) throw new Error(`no such condition: ${condition}`)
    apply(unloadingWorld(state))
  }
)

Given('tabs unload after {int} minutes', (state: unknown, minutes: number) => {
  unloadingWorld(state).minutes = minutes
})

Given('its page objects to being unloaded', (state: unknown) => {
  unloadingWorld(state).objects = true
})

Given('the tab was on the second of two pages', (state: unknown) => {
  const world = unloadingWorld(state)
  world.entries = [
    { url: 'https://a.example/', title: 'A' },
    { url: 'https://a.example/2', title: 'A2', pageState: 'scrolled' }
  ]
  world.index = 1
})

Given('a tab session restore brought back unfetched', (state: unknown) => {
  const world = freshWorld(state, 0)
  world.tab.deferred = world.tab.unloaded = true
})

When('the unloading timer runs', (state: unknown) => {
  const world = unloadingWorld(state)
  const settings = scope(state).settings
  const unloader = new TabUnloader({
    windows: () => [
      {
        tabs: [world.tab],
        overlayPresentation: () => null,
        discardTab: (tabId) => world.discards.discard(tabId)
      }
    ],
    settings: {
      snapshot: () => ({
        ...settings,
        ...(world.minutes === null ? {} : { 'advanced.unloadAfterMinutes': world.minutes })
      })
    },
    waiting: [{ waitsOn: () => world.waitedOn }],
    quitting: () => false,
    now: () => NOW,
    every: () => () => undefined
  })
  unloader.sweep()
  unloader.dispose()
})

When('the tab is activated', (state: unknown) => {
  const world = unloadingWorld(state)
  world.discards.wake(world.tab.id)
})

Then('the tab is unloaded', (state: unknown) => {
  const world = unloadingWorld(state)
  expect(world.tab.unloaded).toBe(true)
  expect(world.children.map((child) => child.op)).toEqual(['remove'])
})

Then('the tab is still loaded', (state: unknown) => {
  const world = unloadingWorld(state)
  expect(world.tab.unloaded).toBe(false)
  expect(world.children).toEqual([])
})

Then('the tab has a new view at the bottom of the window', (state: unknown) => {
  const world = unloadingWorld(state)
  const [removed, added] = world.children
  expect(removed?.op).toBe('remove')
  expect(added).toEqual({ op: 'add', view: world.tab.view, index: 0 })
  expect(added?.view).not.toBe(removed?.view)
})

Then('its history is restored at the second page', (state: unknown) => {
  const world = unloadingWorld(state)
  expect(world.tab.view.webContents.restored).toEqual([
    {
      entries: [
        { url: 'https://a.example/', title: 'A' },
        { url: 'https://a.example/2', title: 'A2', pageState: 'scrolled' }
      ],
      index: 1
    }
  ])
})

Then('the tab keeps its view and loads its address', (state: unknown) => {
  const world = unloadingWorld(state)
  expect(world.children).toEqual([])
  expect(world.tab.loads).toEqual(['https://a.example/2'])
  expect(world.tab.unloaded).toBe(false)
})
