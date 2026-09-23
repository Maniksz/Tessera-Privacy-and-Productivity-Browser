import { describe, expect, it } from 'vitest'
import type { DownloadEntry, DownloadState } from '@shared/downloads/model.js'
import { summarizeWindowDownloads } from '@shared/downloads/summary.js'

/**
 * What the toolbar's download button says, for one window.
 *
 * The decision table in the plan (KTD6) is the specification: progress while anything runs,
 * otherwise the heaviest outcome not yet seen — failed before paused before completed — and a
 * download the user cancelled is not an outcome worth marking. Every row of that table has a
 * test here, because the button has room for exactly one statement and a wrong precedence is
 * invisible until the one download that matters is the one it hides.
 */

let nextId = 0

function entry(overrides: Partial<DownloadEntry> & { state: DownloadState }): DownloadEntry {
  nextId += 1
  return {
    id: `d${String(nextId)}`,
    url: 'https://example.com/file.zip',
    fileName: 'file.zip',
    savePath: '/downloads/file.zip',
    mimeType: 'application/zip',
    totalBytes: 100,
    receivedBytes: 0,
    startedAt: 1_000,
    endedAt: null,
    interruptReason: '',
    onDisk: true,
    canPause: false,
    ...overrides
  }
}

function startedHere(...entries: DownloadEntry[]): ReadonlySet<string> {
  return new Set(entries.map((each) => each.id))
}

describe('summarizeWindowDownloads', () => {
  it('hides the button when nothing was started in this window, however long the stored list', () => {
    const stored = [
      entry({ state: 'completed', receivedBytes: 100, endedAt: 2_000 }),
      entry({ state: 'interrupted', endedAt: 2_000 })
    ]
    expect(summarizeWindowDownloads(stored, new Set(), null)).toEqual({
      visible: false,
      activity: null,
      marker: null
    })
  })

  it('ignores downloads another window started, even while they run', () => {
    const mine = entry({ state: 'completed', receivedBytes: 100, endedAt: 2_000 })
    const theirs = entry({ state: 'progressing', totalBytes: 0, receivedBytes: 5 })
    expect(summarizeWindowDownloads([theirs, mine], startedHere(mine), null)).toEqual({
      visible: true,
      activity: null,
      marker: 'completed'
    })
  })

  it('hides the button once the list no longer holds anything this window started', () => {
    // The ids are remembered for the window's session; the list was cleared under them.
    const gone = entry({ state: 'completed', endedAt: 2_000 })
    expect(summarizeWindowDownloads([], startedHere(gone), null).visible).toBe(false)
  })

  it('adds up the bytes of every running download into one fraction', () => {
    const first = entry({ state: 'progressing', receivedBytes: 10, totalBytes: 100 })
    const second = entry({ state: 'progressing', receivedBytes: 30, totalBytes: 100 })
    expect(summarizeWindowDownloads([first, second], startedHere(first, second), null)).toEqual({
      visible: true,
      activity: { kind: 'fraction', fraction: 0.2 },
      marker: null
    })
  })

  it('weights the fraction by size rather than averaging the downloads', () => {
    const small = entry({ state: 'progressing', receivedBytes: 10, totalBytes: 10 })
    const large = entry({ state: 'progressing', receivedBytes: 0, totalBytes: 90 })
    expect(
      summarizeWindowDownloads([small, large], startedHere(small, large), null).activity
    ).toEqual({ kind: 'fraction', fraction: 0.1 })
  })

  it('clamps a download that overran its declared total, so the ring cannot pass full', () => {
    const overrun = entry({ state: 'progressing', receivedBytes: 150, totalBytes: 100 })
    const other = entry({ state: 'progressing', receivedBytes: 0, totalBytes: 100 })
    expect(
      summarizeWindowDownloads([overrun, other], startedHere(overrun, other), null).activity
    ).toEqual({ kind: 'fraction', fraction: 0.5 })
  })

  it('shows activity without a fraction when one running download has no known size', () => {
    const known = entry({ state: 'progressing', receivedBytes: 50, totalBytes: 100 })
    const unknown = entry({ state: 'progressing', receivedBytes: 50, totalBytes: 0 })
    expect(summarizeWindowDownloads([known, unknown], startedHere(known, unknown), null)).toEqual({
      visible: true,
      activity: { kind: 'indeterminate' },
      marker: null
    })
  })

  it('shows progress rather than an outcome while anything runs', () => {
    const running = entry({ state: 'progressing', receivedBytes: 50, totalBytes: 100 })
    const failed = entry({ state: 'interrupted', endedAt: 2_000 })
    expect(summarizeWindowDownloads([running, failed], startedHere(running, failed), null)).toEqual({
      visible: true,
      activity: { kind: 'fraction', fraction: 0.5 },
      marker: null
    })
  })

  it('leaves a paused download out of the running total', () => {
    const running = entry({ state: 'progressing', receivedBytes: 50, totalBytes: 100 })
    const paused = entry({ state: 'paused', receivedBytes: 0, totalBytes: 0 })
    expect(
      summarizeWindowDownloads([running, paused], startedHere(running, paused), null).activity
    ).toEqual({ kind: 'fraction', fraction: 0.5 })
  })

  it('marks a failure over a completion when nothing runs', () => {
    const failed = entry({ state: 'interrupted', endedAt: 2_000 })
    const done = entry({ state: 'completed', receivedBytes: 100, endedAt: 2_000 })
    expect(summarizeWindowDownloads([done, failed], startedHere(done, failed), null)).toEqual({
      visible: true,
      activity: null,
      marker: 'failed'
    })
  })

  it('marks a failure over a pause', () => {
    const failed = entry({ state: 'interrupted', endedAt: 2_000 })
    const paused = entry({ state: 'paused' })
    expect(summarizeWindowDownloads([paused, failed], startedHere(paused, failed), null).marker).toBe(
      'failed'
    )
  })

  it('marks a pause over a completion when nothing failed', () => {
    const paused = entry({ state: 'paused', receivedBytes: 40 })
    const done = entry({ state: 'completed', receivedBytes: 100, endedAt: 2_000 })
    expect(summarizeWindowDownloads([done, paused], startedHere(done, paused), null)).toEqual({
      visible: true,
      activity: null,
      marker: 'paused'
    })
  })

  it('marks a completion when that is the only unseen outcome', () => {
    const done = entry({ state: 'completed', receivedBytes: 100, endedAt: 2_000 })
    expect(summarizeWindowDownloads([done], startedHere(done), null).marker).toBe('completed')
  })

  it('does not mark a download the user cancelled, and keeps the button quiet but present', () => {
    const cancelled = entry({ state: 'cancelled', endedAt: 2_000 })
    expect(summarizeWindowDownloads([cancelled], startedHere(cancelled), null)).toEqual({
      visible: true,
      activity: null,
      marker: null
    })
  })

  it('does not let a cancellation outrank a completion', () => {
    const cancelled = entry({ state: 'cancelled', endedAt: 3_000 })
    const done = entry({ state: 'completed', receivedBytes: 100, endedAt: 2_000 })
    expect(
      summarizeWindowDownloads([cancelled, done], startedHere(cancelled, done), null).marker
    ).toBe('completed')
  })

  it('marks nothing when every outcome ended before the panel was last presented', () => {
    const failed = entry({ state: 'interrupted', startedAt: 1_000, endedAt: 2_000 })
    const done = entry({ state: 'completed', startedAt: 1_000, endedAt: 2_500 })
    const paused = entry({ state: 'paused', startedAt: 1_500 })
    expect(
      summarizeWindowDownloads([failed, done, paused], startedHere(failed, done, paused), 3_000)
    ).toEqual({ visible: true, activity: null, marker: null })
  })

  it('counts an outcome at the very moment of presenting as seen', () => {
    const done = entry({ state: 'completed', endedAt: 3_000 })
    expect(summarizeWindowDownloads([done], startedHere(done), 3_000).marker).toBeNull()
  })

  it('marks only what ended after the panel was last presented', () => {
    const seenFailure = entry({ state: 'interrupted', endedAt: 2_000 })
    const newCompletion = entry({ state: 'completed', endedAt: 4_000 })
    expect(
      summarizeWindowDownloads(
        [newCompletion, seenFailure],
        startedHere(newCompletion, seenFailure),
        3_000
      ).marker
    ).toBe('completed')
  })

  it('treats a pause of a download started after the last presentation as unseen', () => {
    // No observed time given, so the start stands in for the pause; see the module's note.
    const paused = entry({ state: 'paused', startedAt: 4_000 })
    expect(summarizeWindowDownloads([paused], startedHere(paused), 3_000).marker).toBe('paused')
  })

  it('marks a pause that happened after the last presentation, given when the state changed', () => {
    // Started before the panel was presented and paused afterwards: the start alone would call
    // this seen. The time the caller saw the state change is what closes that gap.
    const paused = entry({ state: 'paused', startedAt: 1_000 })
    const changedAt = new Map([[paused.id, 4_000]])
    expect(summarizeWindowDownloads([paused], startedHere(paused), 3_000, changedAt).marker).toBe(
      'paused'
    )
  })

  it('counts a pause observed before the last presentation as seen', () => {
    const paused = entry({ state: 'paused', startedAt: 1_000 })
    const changedAt = new Map([[paused.id, 2_000]])
    expect(
      summarizeWindowDownloads([paused], startedHere(paused), 3_000, changedAt).marker
    ).toBeNull()
  })

  it('keeps the end time as the moment of a terminal outcome, whatever the caller observed', () => {
    // The record's own end is exact; an observation can only be later, by up to a coalescing tick
    // — or by much more, for a download a closing window handed to this one.
    const done = entry({ state: 'completed', startedAt: 1_000, endedAt: 2_000 })
    const changedAt = new Map([[done.id, 4_000]])
    expect(summarizeWindowDownloads([done], startedHere(done), 3_000, changedAt).marker).toBeNull()
  })

  it('falls back to the start for a pause the caller has no time for', () => {
    const paused = entry({ state: 'paused', startedAt: 1_000 })
    expect(
      summarizeWindowDownloads([paused], startedHere(paused), 3_000, new Map()).marker
    ).toBeNull()
  })

  it('falls back to the start for a finished record that lost its end time', () => {
    // `patchDownload` never produces this, but the summary must not throw on it or mark it
    // for ever: the start is the latest moment the record can vouch for.
    const done = entry({ state: 'completed', startedAt: 1_000, endedAt: null })
    expect(summarizeWindowDownloads([done], startedHere(done), 3_000).marker).toBeNull()
  })
})
