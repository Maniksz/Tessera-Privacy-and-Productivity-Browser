import { describe, expect, it } from 'vitest'
import {
  DOWNLOAD_STATES,
  MAX_DOWNLOAD_RECORDS,
  MAX_DOWNLOAD_URL_LENGTH,
  addDownload,
  canOpenDownload,
  clearFinishedDownloads,
  discardingDownloadRecorder,
  downloadFraction,
  downloadSourceHost,
  emptyDownloadDocument,
  fileWentMissing,
  isActiveDownload,
  isDownloadState,
  isTerminalDownloadState,
  patchDownload,
  recordFor,
  removeDownload,
  repairDownloads,
  type DownloadEntry,
  type DownloadRecord
} from '@shared/downloads/model.js'

/**
 * The download list as data.
 *
 * Downloads differ from every other list in this project in being *events over time* rather
 * than something the user edits, and most of what is tested here follows from that: which
 * states are terminal, what a record found mid-flight at startup means, and why presence on
 * disk is not part of the record at all.
 */

const T0 = 1_700_000_000_000

function record(overrides: Partial<DownloadRecord> & { id: string }): DownloadRecord {
  return {
    url: 'https://example.com/file.pdf',
    fileName: 'file.pdf',
    savePath: '/downloads/file.pdf',
    mimeType: 'application/pdf',
    totalBytes: 1000,
    receivedBytes: 0,
    state: 'progressing',
    startedAt: T0,
    endedAt: null,
    interruptReason: '',
    ...overrides
  }
}

function entry(overrides: Partial<DownloadEntry> & { id: string }): DownloadEntry {
  return { ...record(overrides), onDisk: false, ...overrides }
}

describe('states', () => {
  it('treats paused as still going, and only the three ends as ends', () => {
    /*
      `paused` is deliberately not terminal.

      A paused download still has a partial file on disk and can be resumed; treating it as
      finished is how the resume button disappears from the one row that needs it.
    */
    expect(isTerminalDownloadState('paused')).toBe(false)
    expect(isTerminalDownloadState('progressing')).toBe(false)
    expect(isTerminalDownloadState('completed')).toBe(true)
    expect(isTerminalDownloadState('cancelled')).toBe(true)
    expect(isTerminalDownloadState('interrupted')).toBe(true)
  })

  it('recognises its own states and nothing else', () => {
    for (const state of DOWNLOAD_STATES) expect(isDownloadState(state)).toBe(true)
    expect(isDownloadState('finished')).toBe(false)
    expect(isDownloadState(3)).toBe(false)
  })

  it('offers pause and cancel exactly while something can still happen', () => {
    expect(isActiveDownload(record({ id: 'a', state: 'progressing' }))).toBe(true)
    expect(isActiveDownload(record({ id: 'a', state: 'paused' }))).toBe(true)
    expect(isActiveDownload(record({ id: 'a', state: 'completed' }))).toBe(false)
  })
})

describe('a file the user has since deleted', () => {
  it('is not offered as if it were there', () => {
    /*
      The requirement stated plainly.

      A download completes, and three weeks later the user deletes the file. Nothing tells the
      browser. So presence is probed when somebody looks and is *not* part of the record — and
      the row for a completed download whose file is gone offers no Open button.
    */
    expect(canOpenDownload(entry({ id: 'a', state: 'completed', onDisk: true }))).toBe(true)
    expect(canOpenDownload(entry({ id: 'a', state: 'completed', onDisk: false }))).toBe(false)
  })

  it('says the file went missing only when a finished download produced one', () => {
    /*
      Distinct from `!onDisk`, which is also true of a download the user cancelled.

      Saying "the file was moved or deleted" about a cancellation would be nonsense — it never
      wrote a file at all.
    */
    expect(fileWentMissing(entry({ id: 'a', state: 'completed', onDisk: false }))).toBe(true)
    expect(fileWentMissing(entry({ id: 'a', state: 'completed', onDisk: true }))).toBe(false)
    expect(fileWentMissing(entry({ id: 'a', state: 'cancelled', onDisk: false }))).toBe(false)
    expect(fileWentMissing(entry({ id: 'a', state: 'progressing', onDisk: false }))).toBe(false)
  })

  it('keeps presence out of the stored document entirely', () => {
    // `onDisk` is not a field of `DownloadRecord`, which is what makes it impossible to
    // persist by accident. A derived value that can only ever be wrong does not belong in a
    // file — the same reasoning `quickLinkCardSchema` gives for picture addresses.
    const stored = recordFor({
      id: 'a',
      url: 'https://example.com/a.pdf',
      fileName: 'a.pdf',
      savePath: '/downloads/a.pdf',
      mimeType: 'application/pdf',
      totalBytes: 10,
      startedAt: T0
    })
    expect(Object.keys(stored)).not.toContain('onDisk')
  })
})

describe('progress', () => {
  it('reports an unknown total as unknown, not as zero', () => {
    /*
      The two mean different things to a progress bar: unknown has to be drawn indeterminate,
      and drawing it as 0 % would show a bar that never moves for the whole download — the same
      picture as a stalled one.
    */
    expect(downloadFraction(record({ id: 'a', totalBytes: 0, receivedBytes: 500 }))).toBeNull()
    expect(downloadFraction(record({ id: 'a', totalBytes: 1000, receivedBytes: 250 }))).toBe(0.25)
  })

  it('clamps a total the server understated', () => {
    // Servers do send a `Content-Length` smaller than what arrives. Without the clamp the bar
    // overruns its track.
    expect(downloadFraction(record({ id: 'a', totalBytes: 100, receivedBytes: 500 }))).toBe(1)
  })

  it('names the source host, and says nothing for an address it cannot read', () => {
    expect(downloadSourceHost(record({ id: 'a', url: 'https://files.example.com/x' }))).toBe(
      'files.example.com'
    )
    expect(downloadSourceHost(record({ id: 'a', url: 'not a url' }))).toBe('')
  })
})

describe('the write path', () => {
  it('starts a record as progressing, with nothing received and no end', () => {
    const started = recordFor({
      id: 'a',
      url: 'https://example.com/a.pdf',
      fileName: 'a.pdf',
      savePath: '/downloads/a.pdf',
      mimeType: 'application/pdf',
      totalBytes: 1024,
      startedAt: T0
    })
    expect(started).toMatchObject({ state: 'progressing', receivedBytes: 0, endedAt: null })
  })

  it('bounds an absurd address and an absurd byte count', () => {
    const started = recordFor({
      id: 'a',
      url: `https://example.com/${'a'.repeat(MAX_DOWNLOAD_URL_LENGTH * 2)}`,
      fileName: 'a.pdf',
      savePath: '/downloads/a.pdf',
      mimeType: 'application/pdf',
      totalBytes: -5,
      startedAt: T0
    })
    expect(started.url).toHaveLength(MAX_DOWNLOAD_URL_LENGTH)
    expect(started.totalBytes).toBe(0)
  })

  it('puts a new download at the front and replaces a repeated id', () => {
    const first = addDownload([], record({ id: 'a' }))
    const second = addDownload(first, record({ id: 'b', startedAt: T0 + 1 }))
    expect(second.map((entry) => entry.id)).toEqual(['b', 'a'])

    const again = addDownload(second, record({ id: 'a', fileName: 'other.pdf' }))
    expect(again.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect(again).toHaveLength(2)
  })

  it('drops the oldest past the cap', () => {
    // A download record's value decays, where a bookmark's does not — which is why this drops
    // the oldest and `repairBookmarks` drops the newest.
    const many = Array.from({ length: MAX_DOWNLOAD_RECORDS }, (_unused, index) =>
      record({ id: `n${index}`, startedAt: T0 - index })
    )
    const after = addDownload(many, record({ id: 'fresh', startedAt: T0 + 1 }))
    expect(after).toHaveLength(MAX_DOWNLOAD_RECORDS)
    expect(after[0]?.id).toBe('fresh')
    expect(after.some((entry) => entry.id === `n${MAX_DOWNLOAD_RECORDS - 1}`)).toBe(false)
  })

  it('always gives a terminal record an end time, even when the caller forgot', () => {
    /*
      Without this a row could sit in the list as "completed" with no end time, and every
      consumer would need its own opinion about what to show — which is how one view shows a
      date and another shows nothing for the same row.
    */
    const [patched] = patchDownload([record({ id: 'a' })], 'a', { state: 'completed' })
    expect(patched?.endedAt).toBe(T0)

    const [explicit] = patchDownload([record({ id: 'a' })], 'a', {
      state: 'completed',
      endedAt: T0 + 99
    })
    expect(explicit?.endedAt).toBe(T0 + 99)
  })

  it('leaves a still-running record without an end time', () => {
    const [patched] = patchDownload([record({ id: 'a' })], 'a', { receivedBytes: 10 })
    expect(patched?.endedAt).toBeNull()
    expect(patched?.receivedBytes).toBe(10)
  })

  it('ignores a patch for an id it does not have', () => {
    // A `done` event for a download the user already removed from the list is ordinary, not a
    // fault — the same judgement `noteTitle` makes about a title arriving after its entry went.
    const before = [record({ id: 'a' })]
    expect(patchDownload(before, 'ghost', { state: 'completed' })).toEqual(before)
  })

  it('rounds and floors the numbers a patch carries', () => {
    const [patched] = patchDownload([record({ id: 'a' })], 'a', {
      receivedBytes: -4,
      totalBytes: 10.7
    })
    expect(patched?.receivedBytes).toBe(0)
    expect(patched?.totalBytes).toBe(10)
  })

  it('can move the path and the name after the fact', () => {
    // The save-dialogue path only learns where the file went once the user has chosen.
    const [patched] = patchDownload([record({ id: 'a', savePath: '' })], 'a', {
      savePath: '/elsewhere/renamed.pdf',
      fileName: 'renamed.pdf'
    })
    expect(patched?.savePath).toBe('/elsewhere/renamed.pdf')
    expect(patched?.fileName).toBe('renamed.pdf')
  })
})

describe('forgetting', () => {
  it('removes one record and leaves the rest', () => {
    const before = [record({ id: 'a' }), record({ id: 'b' })]
    expect(removeDownload(before, 'a').map((entry) => entry.id)).toEqual(['b'])
    expect(removeDownload(before, 'ghost')).toHaveLength(2)
  })

  it('clears the finished and keeps anything still running', () => {
    /*
      What "clear the list" has to mean.

      Removing the record of a download in flight would leave a file being written that nothing
      in the interface admits to, and no way to cancel it.
    */
    const before = [
      record({ id: 'done', state: 'completed' }),
      record({ id: 'failed', state: 'interrupted' }),
      record({ id: 'going', state: 'progressing' }),
      record({ id: 'held', state: 'paused' })
    ]
    expect(clearFinishedDownloads(before).map((entry) => entry.id)).toEqual(['going', 'held'])
  })
})

describe('a private window', () => {
  it('is handed a recorder that keeps nothing and admits to nothing', () => {
    /*
      The discarding recorder holds no reference to any store, which is the point: forgetting a
      `privateMode` check cannot leak a download because there is nothing here to leak it into.
      `remembers` answers false for the same reason — code that asks must not be told a private
      download was filed.
    */
    expect(() =>
      discardingDownloadRecorder.start({
        id: 'a',
        url: 'https://example.com/a.pdf',
        fileName: 'a.pdf',
        savePath: '/downloads/a.pdf',
        mimeType: 'application/pdf',
        totalBytes: 10,
        startedAt: T0
      })
    ).not.toThrow()
    expect(() => discardingDownloadRecorder.update('a', { state: 'completed' })).not.toThrow()
    expect(discardingDownloadRecorder.remembers('a')).toBe(false)
  })
})

describe('repairing a document that arrived wrong', () => {
  it('resolves a download that was still running when the browser closed', () => {
    /*
      The repair that matters.

      A record loaded as progressing is one whose writer is gone — that is what "read from disk
      at startup" means. Leaving it alone would put a row in the list with a bar that never moves
      and a cancel button wired to a `DownloadItem` that does not exist, for ever.
    */
    const repaired = repairDownloads([
      record({ id: 'a', state: 'progressing', receivedBytes: 500 }),
      record({ id: 'b', state: 'paused' })
    ])
    expect(repaired.map((entry) => entry.state)).toEqual(['interrupted', 'interrupted'])
    expect(repaired[0]?.endedAt).toBe(T0)
    // And no invented reason: the browser closing is genuinely an unexplained failure, and
    // making one up would dress it up as a diagnosed one.
    expect(repaired[0]?.interruptReason).toBe('')
  })

  it('keeps the received bytes of an interrupted download', () => {
    // The partial file is on disk, so how much of it arrived is the one number that explains it.
    const [repaired] = repairDownloads([record({ id: 'a', receivedBytes: 512 })])
    expect(repaired?.receivedBytes).toBe(512)
  })

  it('leaves a finished download exactly as it was', () => {
    const done = record({ id: 'a', state: 'completed', endedAt: T0 + 10, receivedBytes: 1000 })
    expect(repairDownloads([done])).toEqual([done])
  })

  it('drops a duplicate id, keeping the first', () => {
    const repaired = repairDownloads([
      record({ id: 'a', state: 'completed', fileName: 'first.pdf' }),
      record({ id: 'a', state: 'completed', fileName: 'second.pdf' })
    ])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.fileName).toBe('first.pdf')
  })

  it('restores newest-first order and the cap', () => {
    const repaired = repairDownloads([
      record({ id: 'old', state: 'completed', startedAt: T0 }),
      record({ id: 'new', state: 'completed', startedAt: T0 + 1000 })
    ])
    expect(repaired.map((entry) => entry.id)).toEqual(['new', 'old'])

    const many = Array.from({ length: MAX_DOWNLOAD_RECORDS + 5 }, (_unused, index) =>
      record({ id: `n${index}`, state: 'completed', startedAt: T0 + index })
    )
    expect(repairDownloads(many)).toHaveLength(MAX_DOWNLOAD_RECORDS)
  })

  it('starts from an empty document', () => {
    expect(emptyDownloadDocument()).toEqual({ version: 1, downloads: [] })
    expect(repairDownloads([])).toEqual([])
  })
})
