import { access, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionStore } from '@main/data/SessionStore.js'
import { plainJsonDocumentCodec, type DocumentCodec } from '@main/data/JsonStore.js'
import {
  MAX_UNFINISHED_RESTORES,
  type CapturedWindow,
  type SessionDocument
} from '@shared/session/model.js'
import type { RestoreSettings } from '@shared/session/restore.js'

/**
 * The session store: who may write, what reaches the disk, and when.
 *
 * Slot ids are injected in every test but the one that is *about* the default generator,
 * so nothing depends on how many tests ran before it.
 *
 * Assertions about "nothing was written" read the filesystem rather than trusting the
 * in-memory answer: a private window leaving no trace is the requirement, and the trace
 * would be on disk. Note that `JsonStore.flush` writes whether or not anything changed,
 * so the private-mode tests deliberately do not call it — the absence of the file *is*
 * the assertion.
 */

const RESTORE: RestoreSettings = {
  wantsRestore: true,
  afterCrash: true,
  restoreLayout: true,
  defaultLayout: '1x1'
}

interface Fixture {
  store: SessionStore
  filePath: string
}

async function openStore(
  options: {
    seed?: unknown
    debounceMs?: number
    settleMs?: number
    codec?: DocumentCodec
    defaults?: boolean
  } = {}
): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-session-'))
  const filePath = join(dir, 'session.json')
  if (options.seed !== undefined) {
    await writeFile(filePath, JSON.stringify(options.seed), 'utf8')
  }

  let sequence = 0
  const store = await SessionStore.open({
    filePath,
    /*
      No debounce by default: every write is queued the moment it is made, and the tests
      await `flush` before reading. `defaults` leaves it out entirely, which is the one
      case that exercises the store's own coalescing interval.
    */
    ...(options.defaults === true
      ? {}
      : {
          debounceMs: options.debounceMs ?? 0,
          generateId: () => {
            sequence += 1
            return `slot${sequence}`
          }
        }),
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    ...(options.codec === undefined ? {} : { codec: options.codec })
  })
  return { store, filePath }
}

async function stored(filePath: string): Promise<SessionDocument> {
  return JSON.parse(await readFile(filePath, 'utf8')) as SessionDocument
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function settle(ms = 20): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A window as a live one reports itself.
 *
 * The tab id is a parameter because it has to differ between windows: a session holds one
 * tab id at most once across the whole document, so two windows built from the same
 * fixture would have the second one repaired away — which is the invariant working, and
 * exactly the trap a shared fixture hides.
 */
function live(tabId: string, overrides: Partial<CapturedWindow> = {}): CapturedWindow {
  return {
    layout: '1x2',
    fractions: { v: 0.4 },
    activeTile: 1,
    tabs: [
      {
        id: tabId,
        url: `https://example.com/${tabId}`,
        pendingInput: null,
        title: 'Example',
        pinned: false,
        tileIndex: 0
      }
    ],
    ...overrides
  }
}

/** A saved document as the file holds one, so a fixture can be deliberately broken. */
function savedFile(windows: unknown[], pendingRestores = 0): unknown {
  return { version: 1, windows, pendingRestores }
}

const SAVED_TAB = {
  id: 'tab-4',
  url: 'https://saved.example/',
  pendingUrl: null,
  title: 'Saved',
  pinned: true,
  tileIndex: 1
}

const SAVED_WINDOW = {
  id: 'slot-old',
  open: true,
  layout: '1x2',
  fractions: { v: 0.25 },
  activeTile: 1,
  tabs: [SAVED_TAB]
}

describe('SessionStore basics', () => {
  it('starts with nothing when there is no file yet', async () => {
    const { store, filePath } = await openStore()
    const plan = await store.beginRun(RESTORE)
    expect(plan).toEqual({ kind: 'skip', reason: 'nothing-to-restore' })
    expect(store.recoveredFromInvalidFile).toBe(false)
    expect(await stored(filePath)).toEqual({ version: 1, windows: [], pendingRestores: 0 })
  })

  it('writes a window a normal recorder is given', async () => {
    const { store, filePath } = await openStore()
    store.recorderFor('normal').record(live('tab-1'))
    await store.flush()

    const document = await stored(filePath)
    expect(document.windows.length).toBe(1)
    expect(document.windows[0]?.id).toBe('slot1')
    expect(document.windows[0]?.tabs[0]?.url).toBe('https://example.com/tab-1')
    expect(document.windows[0]?.activeTile).toBe(1)
  })

  it('binds a recorder to one slot for its lifetime', async () => {
    /*
      Recording twice from the same recorder must not accumulate slots, and two recorders
      must not write into each other's — which is why the slot id is allocated inside
      `recorderFor` rather than passed in by a caller who could get it wrong.
    */
    const { store, filePath } = await openStore()
    const first = store.recorderFor('normal')
    const second = store.recorderFor('normal')
    first.record(live('tab-1'))
    first.record(live('tab-1', { activeTile: 0 }))
    second.record(live('tab-2'))
    await store.flush()

    const document = await stored(filePath)
    expect(document.windows.map((window) => window.id)).toEqual(['slot1', 'slot2'])
    expect(document.windows[0]?.activeTile).toBe(0)
  })

  it('generates readable slot ids by itself when none is injected', async () => {
    const { store, filePath } = await openStore({ defaults: true })
    store.recorderFor('normal').record(live('tab-1'))
    await store.flush()
    expect((await stored(filePath)).windows[0]?.id).toMatch(/^win-[0-9a-z]+-[0-9a-z]+$/)
  })

  it('flushes what a debounce is still holding', async () => {
    const { store, filePath } = await openStore({ debounceMs: 5_000 })
    store.recorderFor('normal').record(live('tab-1'))
    expect(await exists(filePath), 'the write is still waiting on the timer').toBe(false)
    await store.flush()
    expect((await stored(filePath)).windows.length).toBe(1)
  })

  it('stores through the codec it is given', async () => {
    // The encryption seam. A codec that mangles the bytes proves nothing reaches the file
    // except through it.
    const codec: DocumentCodec = {
      encode: (data) => reverse(plainJsonDocumentCodec.encode(data)),
      decode: (bytes) => plainJsonDocumentCodec.decode(reverse(bytes))
    }
    const { store, filePath } = await openStore({ codec })
    store.recorderFor('normal').record(live('tab-1'))
    await store.flush()

    const raw = await readFile(filePath, 'utf8')
    expect(raw.includes('https://example.com/'), 'the address must not be readable').toBe(false)

    const reopened = await SessionStore.open({ filePath, codec, debounceMs: 0 })
    const plan = await reopened.beginRun(RESTORE)
    expect(plan.kind === 'restore' && plan.windows[0]?.tabs[0]?.url).toBe(
      'https://example.com/tab-1'
    )
  })
})

describe('a private window', () => {
  it('records nothing, not even that it existed', async () => {
    /*
      Both halves of the requirement. No address on disk, and no slot either — a recorder
      that wrote an empty slot would satisfy the first and still put the number of private
      windows in the file.
    */
    const { store, filePath } = await openStore()
    const recorder = store.recorderFor('private')
    recorder.record(live('tab-1'))
    recorder.record(live('tab-2', { tabs: [] }))
    recorder.close()
    await settle(5)

    expect(await exists(filePath), 'a private window must leave no file at all').toBe(false)
  })

  it('leaves the normal session untouched while it runs', async () => {
    const { store, filePath } = await openStore()
    store.recorderFor('normal').record(live('tab-1'))
    const privately = store.recorderFor('private')
    privately.record(
      live('tab-2', {
        tabs: [
          {
            id: 'tab-2',
            url: 'https://secret.example/',
            pendingInput: 'https://also-secret.example/',
            title: 'Secret',
            pinned: false,
            tileIndex: 0
          }
        ]
      })
    )
    privately.close()
    await store.flush()

    const raw = await readFile(filePath, 'utf8')
    expect(raw.includes('secret.example')).toBe(false)
    expect((await stored(filePath)).windows.length).toBe(1)
  })

  it('does not consume a slot id, so the normal windows keep counting from one', async () => {
    // A private window that took `slot1` would be visible in the gap it left behind.
    const { store, filePath } = await openStore()
    store.recorderFor('private')
    store.recorderFor('normal').record(live('tab-1'))
    await store.flush()
    expect((await stored(filePath)).windows[0]?.id).toBe('slot1')
  })
})

describe('a window closing', () => {
  it('takes its slot away while another window is open', async () => {
    const { store, filePath } = await openStore()
    const first = store.recorderFor('normal')
    const second = store.recorderFor('normal')
    first.record(live('tab-1'))
    second.record(live('tab-2'))
    first.close()
    await store.flush()

    expect((await stored(filePath)).windows.map((window) => window.id)).toEqual(['slot2'])
  })

  it('keeps the last slot so quitting by closing it does not lose the session', async () => {
    const { store, filePath } = await openStore()
    const only = store.recorderFor('normal')
    only.record(live('tab-1'))
    only.close()
    await store.flush()

    const document = await stored(filePath)
    expect(document.windows.length).toBe(1)
    expect(document.windows[0]?.open).toBe(false)
  })
})

describe('a run beginning', () => {
  it("hands the previous run's windows over and then clears them", async () => {
    /*
      Both halves in one call on purpose: reading after clearing would yield an empty plan
      — a restore that silently does nothing — and clearing late would leave the old slots
      beside the new ones, so the launch after that would open every window twice.
    */
    const { store, filePath } = await openStore({
      seed: savedFile([SAVED_WINDOW]),
      settleMs: 60_000
    })
    const plan = await store.beginRun(RESTORE)

    expect(plan.kind === 'restore' && plan.windows[0]?.tabs[0]?.id).toBe('tab-4')
    expect((await stored(filePath)).windows).toEqual([])
    store.seal()
  })

  it('puts the unfinished-restore count on disk before it returns', async () => {
    /*
      The whole guard rests on this. A counter incremented after the pages loaded would be
      written by every launch that survives and by none that does not — precisely
      backwards.
    */
    const { store, filePath } = await openStore({
      seed: savedFile([SAVED_WINDOW]),
      settleMs: 60_000
    })
    const plan = await store.beginRun(RESTORE)
    expect(plan.kind).toBe('restore')
    expect((await stored(filePath)).pendingRestores).toBe(1)
    store.seal()
  })

  it('does not count a launch that restores nothing', async () => {
    const { store, filePath } = await openStore({ seed: savedFile([SAVED_WINDOW], 1) })
    await store.beginRun({ ...RESTORE, wantsRestore: false })
    expect((await stored(filePath)).pendingRestores).toBe(0)
  })

  it('refuses a session that has failed to bring the browser up twice, and clears the count', async () => {
    /*
      The refusal resets the counter so the guard cannot lock a user out of restore
      permanently. It does not need to hold: this launch's own window records itself over
      the document within a second, so the session that crashed twice is simply gone. That
      costs a tab list, and the alternative costs the browser.
    */
    const { store, filePath } = await openStore({
      seed: savedFile([SAVED_WINDOW], MAX_UNFINISHED_RESTORES)
    })
    const plan = await store.beginRun(RESTORE)
    expect(plan).toEqual({ kind: 'skip', reason: 'restore-keeps-crashing' })
    expect((await stored(filePath)).pendingRestores).toBe(0)
  })

  it('clears the count once the browser has stayed up', async () => {
    const { store, filePath } = await openStore({ seed: savedFile([SAVED_WINDOW]), settleMs: 1 })
    await store.beginRun(RESTORE)
    expect((await stored(filePath)).pendingRestores).toBe(1)

    await settle()
    expect((await stored(filePath)).pendingRestores).toBe(0)
  })

  it('schedules nothing to clear when nothing was restored', async () => {
    // A launch that did not restore has nothing to report as healthy, and a timer that
    // wrote anyway would keep the process on its feet for no reason.
    const { store, filePath } = await openStore({ settleMs: 1 })
    await store.beginRun(RESTORE)
    const before = await stored(filePath)
    await settle()
    expect(await stored(filePath)).toEqual(before)
  })
})

describe('sealing at shutdown', () => {
  it('stops accepting writes', async () => {
    /*
      `before-quit` flushes while every window is still open; the windows then close and
      would each ask to drop their slot. Those writes belong to a session that is over,
      and whether they landed would come down to whether the process outlived a debounce
      timer — a shutdown that behaves differently on a slow machine.
    */
    const { store, filePath } = await openStore()
    const first = store.recorderFor('normal')
    const second = store.recorderFor('normal')
    first.record(live('tab-1'))
    second.record(live('tab-2'))

    store.seal()
    first.close()
    second.close()
    second.record(live('tab-2', { activeTile: 0 }))
    await store.flush()

    const document = await stored(filePath)
    expect(document.windows.map((window) => window.id)).toEqual(['slot1', 'slot2'])
    expect(document.windows[1]?.activeTile).toBe(1)
  })

  it('cancels a settle that has not fired', async () => {
    const { store, filePath } = await openStore({ seed: savedFile([SAVED_WINDOW]), settleMs: 1 })
    await store.beginRun(RESTORE)
    store.seal()

    await settle()
    expect((await stored(filePath)).pendingRestores).toBe(1)
  })
})

describe('a file this build did not write', () => {
  it('loads one from an older build that is missing half the fields', async () => {
    /*
      Wrong *kinds* of data are rejected, wrong *values* are healed. Every field left out
      below is one an older build could plausibly not have written, and none of them
      identifies a tab — so losing the whole session over any of them would be the worst
      possible reading of "this file is a bit different".
    */
    const { store } = await openStore({
      seed: {
        version: 1,
        windows: [
          {
            id: 'slot-old',
            // no `open`, no `activeTile`, no `fractions`
            layout: '3x3',
            unknownFutureField: { anything: true },
            tabs: [
              { id: 'tab-2', url: 'https://kept.example/' },
              { id: 'tab-5', url: 'https://also.example/', tileIndex: 7, title: 42 }
            ]
          }
        ]
      },
      settleMs: 60_000
    })

    expect(store.recoveredFromInvalidFile, 'this file is usable, not corrupt').toBe(false)

    const plan = await store.beginRun(RESTORE)
    store.seal()
    expect(plan.kind).toBe('restore')
    if (plan.kind !== 'restore') return
    const [window] = plan.windows
    // The unknown layout heals to a known one rather than taking the tabs with it.
    expect(window?.layout).toBe('1x1')
    expect(window?.tabs.map((tab) => tab.url)).toEqual([
      'https://kept.example/',
      'https://also.example/'
    ])
    expect(window?.tabs.map((tab) => tab.pinned)).toEqual([false, false])
    expect(window?.tabs.map((tab) => tab.title)).toEqual(['', ''])
    // Tile 7 exists in no layout this build has, so that tab comes back detached; the
    // first one takes tile 0 because a window showing nothing is indistinguishable from a
    // restore that failed.
    expect(window?.tabs.map((tab) => tab.tileIndex)).toEqual([0, null])
  })

  it('heals divider positions it cannot use', async () => {
    const { store } = await openStore({
      seed: savedFile([{ ...SAVED_WINDOW, fractions: { v: 'half', h: 0.5 } }]),
      settleMs: 60_000
    })
    const plan = await store.beginRun(RESTORE)
    store.seal()
    expect(plan.kind === 'restore' && plan.windows[0]?.fractions).toEqual({ v: 0.5 })
  })

  it('starts clean from a document whose shape is not ours at all', async () => {
    // A window id that is a number is not a document this browser wrote, and an id is
    // exactly the field that could otherwise produce two tabs answering to one name.
    const { store } = await openStore({ seed: savedFile([{ ...SAVED_WINDOW, id: 7 }]) })
    expect(store.recoveredFromInvalidFile).toBe(true)
    expect(await store.beginRun(RESTORE)).toEqual({ kind: 'skip', reason: 'nothing-to-restore' })
  })

  it('starts clean from a version it does not know', async () => {
    const { store } = await openStore({ seed: { version: 2, windows: [SAVED_WINDOW] } })
    expect(store.recoveredFromInvalidFile).toBe(true)
  })

  it('refuses to let two tabs share an id across two windows', async () => {
    /*
      The repair that matters most once ids come back across a restart: two tabs answering
      to one name would have the split layout, the tab groups and the drag controller all
      quietly disagree about which page is which.
    */
    const { store } = await openStore({
      seed: savedFile([
        { ...SAVED_WINDOW, id: 'slot-a' },
        { ...SAVED_WINDOW, id: 'slot-b', tabs: [SAVED_TAB, { ...SAVED_TAB, id: 'tab-9' }] }
      ]),
      settleMs: 60_000
    })
    const plan = await store.beginRun(RESTORE)
    store.seal()
    if (plan.kind !== 'restore') throw new Error('expected a restore')
    const ids = plan.windows.flatMap((window) => window.tabs.map((tab) => tab.id))
    expect(ids).toEqual(['tab-4', 'tab-9'])
  })
})

function reverse(bytes: Uint8Array | Promise<Uint8Array>): Uint8Array {
  if (bytes instanceof Promise) throw new Error('the plain codec is synchronous')
  return new Uint8Array([...bytes].reverse())
}
