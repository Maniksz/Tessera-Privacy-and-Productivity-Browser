import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { plainJsonDocumentCodec } from '@main/data/JsonStore.js'
import { WORKSPACE_MIGRATIONS, WorkspaceStore } from '@main/data/WorkspaceStore.js'
import type { WorkspaceDraft } from '@shared/workspaces/model.js'

/**
 * The workspace store (U21): identity, the clock and the file, for workspaces the user saved by name.
 *
 * `critical`, like bookmarks: a file a newer version wrote is listed and refused for every write, rather
 * than run on defaults and a save silently lost at exit. What was written is read back from disk.
 */

const T0 = 1_700_000_000_000

const research: WorkspaceDraft = {
  name: 'Research',
  layoutId: '2x2',
  fractions: { v: 0.3, h: 0.6 },
  seats: ['https://a.example/', null, 'https://c.example/', 'https://d.example/']
}

async function fileIn(document?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-workspaces-'))
  const filePath = join(dir, 'workspaces.json')
  if (document !== undefined) await writeFile(filePath, JSON.stringify(document), 'utf8')
  return filePath
}

async function open(filePath: string): Promise<WorkspaceStore> {
  let ids = 0
  let clock = T0
  return WorkspaceStore.open({
    filePath,
    debounceMs: 0,
    codec: plainJsonDocumentCodec,
    generateId: () => `ws${(ids += 1)}`,
    now: () => (clock += 1_000)
  })
}

async function onDisk(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
}

describe('saving and opening again', () => {
  it('keeps a 2×2 with three occupied tiles as four seats, one empty, across a restart', async () => {
    const filePath = await fileIn()
    const store = await open(filePath)
    expect(store.save(research, false)).toBe('saved')
    await store.flush()

    const again = await open(filePath)
    expect(again.get('ws1')).toEqual({ ...research, id: 'ws1', savedAt: T0 + 1_000 })
    expect(again.summaries()).toEqual([{ id: 'ws1', name: 'Research', layoutId: '2x2' }])
    expect(await onDisk(filePath)).toMatchObject({ version: 1, workspaces: [{ id: 'ws1' }] })
  })

  it('hands out copies, so changing one changes nothing stored', async () => {
    const store = await open(await fileIn())
    store.save(research, false)
    store.get('ws1')?.seats.splice(0, 4)
    store.list()[0]?.seats.splice(0, 4)
    expect(store.get('ws1')?.seats).toHaveLength(4)
    expect(store.get('nope')).toBeUndefined()
  })
})

describe('a name that is taken', () => {
  it('overwrites the old workspace only after confirmation, and leaves it alone without', async () => {
    const filePath = await fileIn()
    const store = await open(filePath)
    store.save(research, false)
    await store.flush()
    const before = await onDisk(filePath)

    const narrower: WorkspaceDraft = {
      ...research,
      name: 'research',
      layoutId: '1x1',
      seats: [null]
    }
    expect(store.save(narrower, false)).toBe('exists')
    await store.flush()
    expect(await onDisk(filePath)).toEqual(before)
    expect(store.get('ws1')?.layoutId).toBe('2x2')

    expect(store.save(narrower, true)).toBe('saved')
    await store.flush()
    expect(store.list()).toEqual([{ ...narrower, id: 'ws1', savedAt: T0 + 3_000 }])
  })
})

describe('removing', () => {
  it('removes the workspace from the file', async () => {
    const filePath = await fileIn()
    const store = await open(filePath)
    store.save(research, false)
    expect(store.remove('ws1')).toBe('removed')
    await store.flush()
    expect(await onDisk(filePath)).toEqual({ version: 1, workspaces: [] })
  })
})

describe('a file this build did not write', () => {
  const stored = { ...research, id: 'kept', savedAt: 5 }

  it('lists a newer version’s workspaces read-only, refuses every write, and leaves the file', async () => {
    const newer = { version: 2, workspaces: [stored] }
    const filePath = await fileIn(newer)
    const store = await open(filePath)

    expect(store.readOnly).toBe(true)
    expect(store.summaries()).toEqual([{ id: 'kept', name: 'Research', layoutId: '2x2' }])
    expect(store.loadReport).toEqual({
      outcome: { kind: 'newer', version: 2 },
      criticality: 'critical'
    })
    expect(store.save({ ...research, name: 'Other' }, false)).toBe('read-only')
    expect(store.remove('kept')).toBe('read-only')
    await store.flush()
    expect(await readFile(filePath, 'utf8')).toBe(JSON.stringify(newer))
  })

  it('keeps a workspace with a layout it does not know, unlisted, when it writes', async () => {
    const future = { ...stored, id: 'future', name: 'Wide', layoutId: '2x3' }
    const filePath = await fileIn({ version: 1, workspaces: [future, stored] })
    const store = await open(filePath)
    expect(store.readOnly).toBe(false)
    expect(store.summaries().map((entry) => entry.id)).toEqual(['kept'])

    store.save({ ...research, name: 'Mail' }, false)
    await store.flush()
    const written = (await onDisk(filePath))['workspaces'] as Array<Record<string, unknown>>
    expect(written.map((entry) => entry['id'])).toEqual(['future', 'kept', 'ws1'])
  })

  it('heals what it can read: the seats and dividers to the layout, a name trimmed', async () => {
    const loose = { ...stored, name: '  Loose ', seats: ['https://a.example/'], fractions: {} }
    const store = await open(await fileIn({ version: 1, workspaces: [loose] }))
    expect(store.get('kept')).toEqual({
      ...stored,
      name: 'Loose',
      seats: ['https://a.example/', null, null, null],
      fractions: { v: 0.5, h: 0.5 }
    })
  })
})

describe('the store’s conventions', () => {
  it('is at version 1, with no step before it', () => {
    expect(WORKSPACE_MIGRATIONS).toEqual([])
  })

  it('names its own ids when none are injected, starts empty, and a flush writes what waits', async () => {
    const filePath = await fileIn()
    const store = await WorkspaceStore.open({ filePath })
    expect(store.list()).toEqual([])
    store.save(research, false)
    expect(store.list()[0]?.id).toMatch(/^ws-[0-9a-z]+-[0-9a-z]+$/)
    expect(store.list()[0]?.savedAt).toBeGreaterThan(T0)
    expect(store.loadReport.criticality).toBe('critical')
    // Debounced by default, so what is on disk is what the flush at exit wrote.
    await store.flush()
    expect(await onDisk(filePath)).toMatchObject({ workspaces: [{ name: 'Research' }] })
  })
})
