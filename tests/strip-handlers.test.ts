import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent } from 'electron'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TabGroupController } from '@main/browser/TabGroupController.js'
import { TabGroupStore } from '@main/data/TabGroupStore.js'
import { registerStripHandlers, type StripHandle } from '@main/ipc/strip-handlers.js'
import { stripInvokeContract } from '@shared/strip/schema.js'
import type { StripDrop } from '@shared/strip/drop.js'

/**
 * `strip:drop` against a window whose groups are the real `TabGroupController` over a real store, so
 * "the drop reached the sender's strip" is asked of the code that reorders it (U9, KTD7).
 */

type Handler = (payload: unknown, event: IpcMainInvokeEvent) => unknown

const EVENT = undefined as unknown as IpcMainInvokeEvent

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-strip-handlers-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

async function fakeWindow(
  tabIds: readonly string[]
): Promise<{ groups: TabGroupController; order: () => string[] }> {
  const store = await TabGroupStore.open({ filePath: join(directory, 'tab-groups.json') })
  let order = [...tabIds]
  const groups = new TabGroupController({
    book: store.bookFor('normal'),
    tabOrder: () => order,
    setTabOrder: (next) => {
      order = [...next]
    },
    releaseTiles: () => false,
    activeTabId: () => null,
    activateTab: () => {},
    liveTabIds: () => order,
    broadcast: () => {},
    arrangements: () => []
  })
  return { groups, order: () => order }
}

function register(window: { groups: TabGroupController } | undefined): Map<string, Handler> {
  const handlers = new Map<string, Handler>()
  const handle = ((channel: string, handler: Handler) => {
    handlers.set(channel, handler)
  }) as unknown as StripHandle
  registerStripHandlers({ handle, windows: { resolve: () => window } })
  return handlers
}

const DROP: StripDrop = {
  subject: { kind: 'tab', tabId: 'X' },
  target: { kind: 'tab', tabId: 'b' },
  side: 'before'
}

describe('strip:drop', () => {
  it('registers every channel of the strip contract and nothing else', () => {
    expect([...register(undefined).keys()].sort()).toEqual(Object.keys(stripInvokeContract).sort())
  })

  it("resolves the drop against the sending window's strip and groups", async () => {
    const window = await fakeWindow(['X', 'a', 'b'])
    const group = window.groups.create({ tabIds: ['a', 'b'] })

    expect(register(window).get('strip:drop')?.(DROP, EVENT)).toEqual({ ok: true })

    expect(window.order()).toEqual(['a', 'X', 'b'])
    expect(window.groups.groups().find((held) => held.id === group.id)?.tabIds).toEqual([
      'a',
      'X',
      'b'
    ])
  })

  it('answers ok and moves nothing for a sender with no window', () => {
    expect(register(undefined).get('strip:drop')?.(DROP, EVENT)).toEqual({ ok: true })
  })
})
