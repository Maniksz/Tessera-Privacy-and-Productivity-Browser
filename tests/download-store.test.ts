import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DownloadStore } from '@main/data/DownloadStore.js'
import { plainJsonDocumentCodec } from '@main/data/JsonStore.js'
import type { DownloadDocument, DownloadRecord, StartedDownload } from '@shared/downloads/model.js'

/**
 * The download store: who may write, what reaches the file, and what a record found mid-flight
 * at startup means.
 *
 * Assertions about "nothing was written" read the file from disk rather than trusting the
 * in-memory answer. A private window leaving no trace is the requirement, and the trace is on
 * disk.
 */

const T0 = 1_700_000_000_000

interface Fixture {
  store: DownloadStore
  filePath: string
}

async function openStore(options: { debounceMs?: number; codec?: boolean } = {}): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-downloads-'))
  const filePath = join(dir, 'downloads.json')
  let step = 0
  const tick = (): number => {
    step += 1
    return T0 + step * 1_000
  }

  const store = await DownloadStore.open({
    filePath,
    debounceMs: options.debounceMs ?? 0,
    now: tick,
    ...(options.codec === true ? { codec: plainJsonDocumentCodec } : {})
  })
  return { store, filePath }
}

function started(overrides: Partial<StartedDownload> & { id: string }): StartedDownload {
  return {
    url: 'https://example.com/file.pdf',
    fileName: 'file.pdf',
    savePath: '/downloads/file.pdf',
    mimeType: 'application/pdf',
    totalBytes: 1000,
    startedAt: T0,
    ...overrides
  }
}

async function storedRecords(filePath: string): Promise<DownloadRecord[]> {
  const text = await readFile(filePath, 'utf8')
  return (JSON.parse(text) as DownloadDocument).downloads
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe('a download in a normal window', () => {
  it('is recorded when it starts and finished when it ends', async () => {
    const { store, filePath } = await openStore()
    const recorder = store.recorderFor('normal')

    recorder.start(started({ id: 'a' }))
    expect(store.list()).toHaveLength(1)
    expect(recorder.remembers('a')).toBe(true)

    recorder.update('a', { state: 'completed', receivedBytes: 1000 })
    await store.flush()

    const [stored] = await storedRecords(filePath)
    expect(stored).toMatchObject({ id: 'a', state: 'completed', receivedBytes: 1000 })
    // The end time comes from the store's clock, not from the caller: `DownloadItem` reports
    // seconds where everything else here is milliseconds, and one unit mistake would file every
    // download in 1970.
    expect(stored?.endedAt).toBeGreaterThan(T0)
  })

  it('ignores an update for a record that is no longer there', async () => {
    // A `done` event arriving after the user removed the row is ordinary. Asked before writing
    // so it costs neither a file write nor a woken listener.
    const { store } = await openStore()
    const recorder = store.recorderFor('normal')
    recorder.start(started({ id: 'a' }))
    store.remove('a')

    let notified = 0
    store.onChange(() => (notified += 1))
    recorder.update('a', { state: 'completed' })
    expect(notified).toBe(0)
    expect(recorder.remembers('a')).toBe(false)
  })

  it('does not stamp an end time onto a still-running record', async () => {
    const { store } = await openStore()
    const recorder = store.recorderFor('normal')
    recorder.start(started({ id: 'a' }))
    recorder.update('a', { state: 'paused', receivedBytes: 10 })
    expect(store.find('a')?.endedAt).toBeNull()
  })
})

describe('a download in a private window', () => {
  it('leaves no record anywhere', async () => {
    /*
      The requirement, checked on disk.

      The private window is handed an object with no reference to this store, so there is no
      call site that could forget a check — the guarantee is a property of what the window holds.
    */
    const { store, filePath } = await openStore()
    const recorder = store.recorderFor('private')

    recorder.start(
      started({ id: 'secret', url: 'https://leak.example/secret.pdf', fileName: 'secret.pdf' })
    )
    recorder.update('secret', { state: 'completed', receivedBytes: 4096 })
    await store.flush()

    expect(store.list()).toEqual([])
    expect(store.find('secret')).toBeUndefined()
    expect(recorder.remembers('secret')).toBe(false)

    /*
      And nothing on disk mentions it.

      Asserted against the file's text rather than against the file's *absence*: `JsonStore.flush`
      writes whatever it holds, so an empty document is written the moment anything asks it to
      flush — which shutdown does. "No file" would therefore be a test that passes for the wrong
      reason on the day flushing changes; "no trace of the download" is the actual requirement.
    */
    if (await fileExists(filePath)) {
      const text = await readFile(filePath, 'utf8')
      expect(text).not.toContain('secret.pdf')
      expect(text).not.toContain('leak.example')
      expect(await storedRecords(filePath)).toEqual([])
    }
  })

  it('does not stop it clearing the stored list', async () => {
    /*
      Deletion is deliberately not behind the mode-bound writer, exactly as in `HistoryStore`.

      Clearing the list from a private window acts on the stored list, which is what the person
      asking for it means.
    */
    const { store } = await openStore()
    store.recorderFor('normal').start(started({ id: 'a' }))
    store.recorderFor('normal').update('a', { state: 'completed' })

    expect(store.clear()).toBe(1)
    expect(store.list()).toEqual([])
  })
})

describe('forgetting', () => {
  it('clears the finished and keeps what is still running', async () => {
    const { store } = await openStore()
    const recorder = store.recorderFor('normal')
    recorder.start(started({ id: 'done' }))
    recorder.update('done', { state: 'completed' })
    recorder.start(started({ id: 'going', startedAt: T0 + 1 }))

    expect(store.clear()).toBe(1)
    expect(store.list().map((entry) => entry.id)).toEqual(['going'])
  })

  it('reports nothing removed when there was nothing to remove', async () => {
    const { store } = await openStore()
    expect(store.remove('ghost')).toBe(0)
  })
})

describe('opening a file that was written before', () => {
  it('marks a download that was still running as interrupted', async () => {
    /*
      Nothing is writing that file any more — that is what "loaded at startup" means.

      Without this the list would hold a row with a bar that never moves and a cancel button
      wired to a `DownloadItem` that does not exist.
    */
    const dir = await mkdtemp(join(tmpdir(), 'tessera-downloads-'))
    const filePath = join(dir, 'downloads.json')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        downloads: [
          {
            id: 'a',
            url: 'https://example.com/a.pdf',
            fileName: 'a.pdf',
            savePath: '/downloads/a.pdf',
            mimeType: 'application/pdf',
            totalBytes: 1000,
            receivedBytes: 400,
            state: 'progressing',
            startedAt: T0,
            endedAt: null,
            interruptReason: ''
          }
        ]
      }),
      'utf8'
    )

    const store = await DownloadStore.open({ filePath, debounceMs: 0 })
    expect(store.recoveredFromInvalidFile).toBe(false)
    expect(store.find('a')).toMatchObject({ state: 'interrupted', receivedBytes: 400 })
  })

  it('falls back to an empty list when the file is not ours', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-downloads-'))
    const filePath = join(dir, 'downloads.json')
    // A *kind* error: a string where a number belongs.
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, downloads: [{ id: 'a', totalBytes: 'lots' }] }),
      'utf8'
    )

    const store = await DownloadStore.open({ filePath, debounceMs: 0 })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
  })

  it('accepts an interrupt reason this build has never seen', async () => {
    /*
      The reasons come from Chromium and the set grows between versions.

      Validating against a list this build knows would discard the whole document the first time
      a newer Chromium invented one — losing the user's list to a string nobody reads
      programmatically.
    */
    const dir = await mkdtemp(join(tmpdir(), 'tessera-downloads-'))
    const filePath = join(dir, 'downloads.json')
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        downloads: [
          {
            id: 'a',
            url: 'https://example.com/a.pdf',
            fileName: 'a.pdf',
            savePath: '/downloads/a.pdf',
            mimeType: 'application/pdf',
            totalBytes: 0,
            receivedBytes: 0,
            state: 'interrupted',
            startedAt: T0,
            endedAt: T0 + 5,
            interruptReason: 'FILE_TRANSIENT_ERROR_FROM_A_FUTURE_CHROMIUM'
          }
        ]
      }),
      'utf8'
    )

    const store = await DownloadStore.open({ filePath, debounceMs: 0 })
    expect(store.find('a')?.interruptReason).toBe('FILE_TRANSIENT_ERROR_FROM_A_FUTURE_CHROMIUM')
  })

  it('reads back through the codec it was written with', async () => {
    const { store, filePath } = await openStore({ codec: true })
    store.recorderFor('normal').start(started({ id: 'a' }))
    await store.flush()

    const reopened = await DownloadStore.open({
      filePath,
      debounceMs: 0,
      codec: plainJsonDocumentCodec
    })
    // Interrupted rather than progressing, because that is what reopening means.
    expect(reopened.find('a')?.state).toBe('interrupted')
  })
})

describe('flushing', () => {
  it('coalesces writes and still lands them', async () => {
    const { store, filePath } = await openStore({ debounceMs: 50 })
    const recorder = store.recorderFor('normal')
    recorder.start(started({ id: 'a' }))
    recorder.start(started({ id: 'b', startedAt: T0 + 1 }))
    await store.flush()
    expect(await storedRecords(filePath)).toHaveLength(2)
  })

  it('tells listeners when the list changed, and stops when unsubscribed', async () => {
    const { store } = await openStore()
    const seen: number[] = []
    const unsubscribe = store.onChange((downloads) => seen.push(downloads.length))
    const recorder = store.recorderFor('normal')
    recorder.start(started({ id: 'a' }))
    unsubscribe()
    recorder.start(started({ id: 'b' }))
    expect(seen).toEqual([1])
  })
})
