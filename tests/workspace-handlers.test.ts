import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import { SplitController } from '@main/browser/SplitController.js'
import { TileOccupancyController } from '@main/browser/TileOccupancyController.js'
import { plainJsonDocumentCodec } from '@main/data/JsonStore.js'
import { WorkspaceStore } from '@main/data/WorkspaceStore.js'
import {
  registerWorkspaceHandlers,
  type WorkspaceHandle,
  type WorkspaceWindow
} from '@main/ipc/workspace-handlers.js'
import type { LayoutId } from '@shared/split/layout.js'
import { workspaceInvokeContract } from '@shared/workspaces/schema.js'

/**
 * The layout menu's four channels (U21), against a real store and a window whose tiles are the real
 * `SplitController` and `TileOccupancyController` — so "opening closes no tab" is asked of the code
 * that closes the browser's own fillers on a shrink, not of a stand-in.
 *
 * Every answer is parsed with its channel's response schema, so what is pinned is what the menu gets.
 */

type Handler = (payload: unknown, event: IpcMainInvokeEvent) => unknown

const EVENT = undefined as unknown as IpcMainInvokeEvent
const CONTENT = { x: 0, y: 0, width: 1600, height: 1000 }

interface FakeTab {
  readonly id: string
  url: string
  ephemeral: boolean
}

/** A window as the handlers see it, with the grid run by the real controllers. */
class FakeWindow implements WorkspaceWindow {
  readonly split: SplitController
  readonly occupancy: TileOccupancyController
  readonly hidden = new Set<string>()
  readonly groups = { isHidden: (tabId: string): boolean => this.hidden.has(tabId) }
  readonly closed: string[] = []
  readonly dismissed: string[] = []
  /** The tiles as they stood each time the visible tiled view was put away. */
  readonly putAway: Array<Array<string | null>> = []
  /** Tabs that belong to a tiled view, which a workspace may not take (KTD10). */
  readonly members = new Set<string>()
  readonly arrangements = {
    putAway: (): void => {
      this.putAway.push(this.tileUrls())
    },
    isMember: (tabId: string): boolean => this.members.has(tabId)
  }
  /** How each tab the handlers asked for was to be opened. */
  readonly created: Array<{ background: boolean; tileIndex: null }> = []
  readonly #tabs = new Map<string, FakeTab>()
  #next = 0

  constructor(
    readonly privateMode = false,
    layout: LayoutId = '1x1'
  ) {
    this.split = new SplitController({ layout })
    this.occupancy = new TileOccupancyController({
      split: this.split,
      adaptEnabled: () => true,
      tabOrder: () => [...this.#tabs.keys()],
      setTabOrder: () => {},
      isEphemeral: (tabId) => this.#tabs.get(tabId)?.ephemeral === true,
      isStartPage: () => false,
      isHiddenByCollapse: (tabId) => this.hidden.has(tabId),
      isArrangementMember: (tabId) => this.members.has(tabId),
      restoreFirstArrangement: () => {},
      unassign: () => {},
      assignTabToTile: (tabId, tileIndex) => this.assignTabToTile(tabId, tileIndex),
      closeTab: (tabId) => {
        this.closed.push(tabId)
        this.#tabs.delete(tabId)
        this.split.forgetTab(tabId)
      },
      setActiveTile: (tileIndex) => this.split.setActiveTile(tileIndex),
      openFiller: (tileIndex) => {
        this.assignTabToTile(this.open('tessera://start', true), tileIndex)
      },
      applyLayout: (next, options) => {
        this.occupancy.afterLayoutChange(this.split.setLayout(next), options)
      },
      putAway: () => {},
      endTiling: () => {}
    })
  }

  get tabs(): Array<{ id: string; toState(): { url: string } }> {
    return [...this.#tabs.values()].map((tab) => ({
      id: tab.id,
      toState: () => ({ url: tab.url })
    }))
  }

  open(url: string, ephemeral = false): string {
    this.#next += 1
    const id = `t${this.#next}`
    this.#tabs.set(id, { id, url, ephemeral })
    return id
  }

  createTab(options: { url: string; background: boolean; tileIndex: null }): { id: string } {
    this.created.push({ background: options.background, tileIndex: options.tileIndex })
    return { id: this.open(options.url) }
  }

  assignTabToTile(tabId: string, tileIndex: number | null): void {
    this.split.assignTab(tabId, tileIndex)
  }

  setFractions(fractions: Readonly<Record<string, number>>): void {
    this.split.setFractions(fractions, CONTENT)
  }

  dismissOverlayKind(kind: 'layout-menu'): boolean {
    this.dismissed.push(kind)
    return true
  }

  /** Tiles as the addresses they show. */
  tileUrls(): Array<string | null> {
    return this.split
      .toState()
      .tileTabIds.map((tabId) => (tabId === null ? null : (this.#tabs.get(tabId)?.url ?? '?')))
  }

  tabIds(): string[] {
    return [...this.#tabs.keys()]
  }

  /** Puts pages in tiles, in order, switching to `layout` first. */
  tile(layout: LayoutId, urls: ReadonlyArray<string | null>): string[] {
    this.split.setLayout(layout)
    return urls.map((url, index) => {
      if (url === null) return ''
      const id = this.open(url)
      this.assignTabToTile(id, index)
      return id
    })
  }
}

let handlers: Map<string, Handler>
let window: FakeWindow | undefined
let store: WorkspaceStore

const handle: WorkspaceHandle = (channel, handler) => {
  handlers.set(channel, handler as Handler)
}

async function call(channel: keyof typeof workspaceInvokeContract, payload?: unknown) {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} is not registered`)
  const answer = await handler(payload, EVENT)
  return workspaceInvokeContract[channel].response.parse(answer) as Record<string, unknown>
}

async function openStore(document?: unknown): Promise<WorkspaceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-workspace-handlers-'))
  const filePath = join(dir, 'workspaces.json')
  if (document !== undefined) await writeFile(filePath, JSON.stringify(document), 'utf8')
  let ids = 0
  return WorkspaceStore.open({
    filePath,
    debounceMs: 0,
    codec: plainJsonDocumentCodec,
    generateId: () => `ws${(ids += 1)}`,
    now: () => 1
  })
}

function register(): void {
  handlers = new Map()
  registerWorkspaceHandlers({ handle, windows: { resolve: () => window }, workspaces: store })
}

beforeEach(async () => {
  store = await openStore()
  window = new FakeWindow()
  register()
})

describe('saving', () => {
  it('keeps a 2×2 with three occupied tiles as four seats, one empty, with its dividers', async () => {
    const current = new FakeWindow(false)
    window = current
    current.tile('2x2', ['https://a.example/', null, 'https://c.example/', 'https://d.example/'])
    current.setFractions({ v: 0.3, h: 0.6 })

    expect(await call('workspaces:save', { name: '  Research ', replace: false })).toEqual({
      outcome: 'saved'
    })
    expect(store.list()).toEqual([
      {
        id: 'ws1',
        name: 'Research',
        layoutId: '2x2',
        fractions: { v: 0.3, h: 0.6 },
        seats: ['https://a.example/', null, 'https://c.example/', 'https://d.example/'],
        savedAt: 1
      }
    ])
  })

  it('asks before overwriting a name that is taken, and overwrites once confirmed', async () => {
    window?.tile('1x2', ['https://a.example/', 'https://b.example/'])
    await call('workspaces:save', { name: 'Mail', replace: false })
    window?.tile('1x1', ['https://z.example/'])

    expect(await call('workspaces:save', { name: 'mail', replace: false })).toEqual({
      outcome: 'exists'
    })
    expect(store.get('ws1')?.seats).toEqual(['https://a.example/', 'https://b.example/'])

    expect(await call('workspaces:save', { name: 'mail', replace: true })).toEqual({
      outcome: 'saved'
    })
    expect(store.get('ws1')).toMatchObject({ name: 'mail', seats: ['https://z.example/'] })
  })

  it('refuses in a private window and stores nothing', async () => {
    window = new FakeWindow(true)
    window.tile('1x1', ['https://secret.example/'])
    expect(await call('workspaces:save', { name: 'Secret', replace: false })).toEqual({
      outcome: 'private'
    })
    expect(store.list()).toEqual([])
  })

  it('refuses a name with nothing in it, and a window that is gone', async () => {
    expect(await call('workspaces:save', { name: '   ', replace: false })).toEqual({
      outcome: 'invalid'
    })
    window = undefined
    expect(await call('workspaces:save', { name: 'Gone', replace: false })).toEqual({
      outcome: 'invalid'
    })
    expect(store.list()).toEqual([])
  })

  it('reports a newer version’s file as read-only, and the menu knows before it tries', async () => {
    store = await openStore({ version: 2, workspaces: [] })
    register()
    expect(await call('workspaces:save', { name: 'Late', replace: false })).toEqual({
      outcome: 'read-only'
    })
    expect(await call('workspaces:list')).toEqual({
      workspaces: [],
      canSave: true,
      readOnly: true
    })
  })
})

describe('the list', () => {
  it('lists by name and lets an ordinary window save', async () => {
    window?.tile('1x1', ['https://a.example/'])
    await call('workspaces:save', { name: 'Zeta', replace: false })
    await call('workspaces:save', { name: 'Alpha', replace: false })
    expect(await call('workspaces:list')).toEqual({
      workspaces: [
        { id: 'ws2', name: 'Alpha', layoutId: '1x1' },
        { id: 'ws1', name: 'Zeta', layoutId: '1x1' }
      ],
      canSave: true,
      readOnly: false
    })
  })

  it('shows save disabled to a private window, and to a window that is gone', async () => {
    window = new FakeWindow(true)
    expect(await call('workspaces:list')).toMatchObject({ canSave: false })
    window = undefined
    expect(await call('workspaces:list')).toMatchObject({ canSave: false })
  })
})

describe('opening', () => {
  async function saved(layout: LayoutId, seats: Array<string | null>): Promise<string> {
    const author = new FakeWindow()
    author.tile(layout, seats)
    author.setFractions({ v: 0.3, h: 0.7 })
    window = author
    await call('workspaces:save', { name: `W${layout}`, replace: false })
    return store.list().at(-1)?.id ?? ''
  }

  it('builds the layout, takes a matching open tab and opens the rest, with its dividers', async () => {
    const id = await saved('2x2', ['https://a.example/', null, 'https://c.example/', 'https://d/'])
    const target = new FakeWindow()
    const kept = target.tile('1x1', ['https://c.example/'])[0]
    window = target

    expect(await call('workspaces:open', { id })).toEqual({ outcome: 'opened' })
    expect(target.split.layout).toBe('2x2')
    expect(target.tileUrls()).toEqual([
      'https://a.example/',
      null,
      'https://c.example/',
      'https://d/'
    ])
    expect(target.split.tabIdAt(2)).toBe(kept)
    expect(target.tabIds()).toHaveLength(3)
    // In the background and in no tile, so a new tab does not put the grid away first.
    expect(target.created).toEqual([
      { background: true, tileIndex: null },
      { background: true, tileIndex: null }
    ])
    expect(target.split.toState().fractions).toEqual({ v: 0.3, h: 0.7 })
    expect(target.split.activeTabId()).toBe(target.split.tabIdAt(0))
    expect(target.dismissed).toEqual(['layout-menu'])
  })

  it('puts the visible tiled view away before it touches a tile (U2)', async () => {
    // Otherwise the workspace's seating would be read as a change to that view and written into it.
    const id = await saved('1x2', ['https://a.example/', 'https://b.example/'])
    const target = new FakeWindow()
    window = target
    target.tile('1x2', ['https://x.example/', 'https://y.example/'])

    await call('workspaces:open', { id })

    expect(target.putAway).toEqual([['https://x.example/', 'https://y.example/']])
  })

  it('closes no tab: what gets no seat leaves the grid and stays open, the browser’s fillers too', async () => {
    const id = await saved('1x2', ['https://a.example/', 'https://b.example/'])
    const target = new FakeWindow()
    window = target
    target.tile('1x4', ['https://x.example/', 'https://b.example/', null, null])
    const filler = target.open('tessera://start', true)
    target.assignTabToTile(filler, 3)
    const before = target.tabIds()

    await call('workspaces:open', { id })
    expect(target.closed).toEqual([])
    expect(target.tabIds()).toEqual(expect.arrayContaining(before))
    expect(target.tileUrls()).toEqual(['https://a.example/', 'https://b.example/'])
    expect(target.split.tileOfTab(filler)).toBeNull()
  })

  it('empties a tile whose seat is empty, in a window already in that layout', async () => {
    const id = await saved('1x2', [null, 'https://b.example/'])
    const target = new FakeWindow()
    window = target
    const [left] = target.tile('1x2', ['https://left.example/', 'https://b.example/'])
    await call('workspaces:open', { id })
    expect(target.tileUrls()).toEqual([null, 'https://b.example/'])
    expect(target.tabIds()).toContain(left)
  })

  it('does not seat a tab a collapsed group hides, and opens the page instead', async () => {
    const id = await saved('1x1', ['https://a.example/'])
    const target = new FakeWindow()
    window = target
    const folded = target.open('https://a.example/')
    target.hidden.add(folded)
    await call('workspaces:open', { id })
    expect(target.split.tabIdAt(0)).not.toBe(folded)
    expect(target.tileUrls()).toEqual(['https://a.example/'])
  })

  it('opens a new tab for an address a member of a tiled view shows, and the member stays (KTD10)', async () => {
    /*
      Taking it would move a page out of its view's entry and into the workspace's tiling unasked —
      and since the settle after it could neither adopt nor create an entry over a mixed seating,
      the workspace would be left with no entry of its own either (R16).
    */
    const id = await saved('1x2', ['https://a.example/', 'https://b.example/'])
    const target = new FakeWindow()
    window = target
    const member = target.open('https://a.example/')
    target.members.add(member)

    await call('workspaces:open', { id })

    expect(target.split.tileOfTab(member)).toBeNull()
    expect(target.tileUrls()).toEqual(['https://a.example/', 'https://b.example/'])
    expect(target.created).toHaveLength(2)
  })

  it('opens in a private window, which may open and not save', async () => {
    const id = await saved('1x1', ['https://a.example/'])
    const target = new FakeWindow(true)
    window = target
    expect(await call('workspaces:open', { id })).toEqual({ outcome: 'opened' })
    expect(target.tileUrls()).toEqual(['https://a.example/'])
  })

  it('opens a workspace with no page in it as its layout alone', async () => {
    const id = await saved('1x2', [null, null])
    const target = new FakeWindow()
    window = target
    await call('workspaces:open', { id })
    expect(target.split.layout).toBe('1x2')
    expect(target.tileUrls()).toEqual([null, null])
  })

  it('answers missing for an id nobody has, or a window that is gone', async () => {
    expect(await call('workspaces:open', { id: 'nope' })).toEqual({ outcome: 'missing' })
    const id = await saved('1x1', ['https://a.example/'])
    window = undefined
    expect(await call('workspaces:open', { id })).toEqual({ outcome: 'missing' })
  })
})

describe('removing', () => {
  it('removes, and reports a newer version’s file as read-only', async () => {
    window?.tile('1x1', ['https://a.example/'])
    await call('workspaces:save', { name: 'Gone soon', replace: false })
    expect(await call('workspaces:remove', { id: 'ws1' })).toEqual({ outcome: 'removed' })
    expect(store.list()).toEqual([])

    store = await openStore({ version: 2, workspaces: [] })
    register()
    expect(await call('workspaces:remove', { id: 'ws1' })).toEqual({ outcome: 'read-only' })
  })
})
