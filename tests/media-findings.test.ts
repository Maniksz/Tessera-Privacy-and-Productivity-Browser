import { describe, expect, it } from 'vitest'
import {
  MAX_FINDINGS_PER_TAB,
  emptyMediaFindings,
  findFinding,
  findingsForTab,
  forgetTabFindings,
  recordMediaFinding,
  setManifestState
} from '@shared/media/findings.js'
import type { MediaFinding } from '@shared/media/model.js'

/**
 * The per-tab collection, as pure state.
 *
 * Two properties are load-bearing beyond "the right entries come out". Findings
 * are keyed per tab, because a window with four tiles is four pages playing at
 * once and a pooled list would offer a download from a video the user is not
 * looking at. And every function returns the *same object* when nothing changed,
 * which is what lets the registry decide by identity whether to wake the
 * interface — a player re-requesting its playlist on every seek would otherwise
 * redraw the panel dozens of times a minute.
 */

function finding(overrides: Partial<MediaFinding> = {}): MediaFinding {
  return {
    id: 'media-1',
    tabId: 'tab-1',
    url: 'https://example.com/clip.mp4',
    documentUrl: 'https://example.com/watch',
    kind: 'progressive',
    container: 'mp4',
    contentType: null,
    byteLength: null,
    label: 'clip.mp4',
    discoveredAt: 1000,
    manifest: null,
    ...overrides
  }
}

describe('findings per tab', () => {
  it('keeps each tab’s findings to itself', () => {
    let state = emptyMediaFindings()
    state = recordMediaFinding(state, finding({ id: 'a', tabId: 'tab-1' }), MAX_FINDINGS_PER_TAB)
    state = recordMediaFinding(
      state,
      finding({ id: 'b', tabId: 'tab-2', url: 'https://other.example/other.mp4' }),
      MAX_FINDINGS_PER_TAB
    )

    expect(findingsForTab(state, 'tab-1').map((one) => one.id)).toEqual(['a'])
    expect(findingsForTab(state, 'tab-2').map((one) => one.id)).toEqual(['b'])
    expect(findingsForTab(state, 'tab-3')).toEqual([])
  })

  it('records the same address in two tabs as two findings', () => {
    // Four tiles on the same site is the case split view exists for.
    let state = emptyMediaFindings()
    state = recordMediaFinding(state, finding({ id: 'a', tabId: 'tab-1' }), MAX_FINDINGS_PER_TAB)
    state = recordMediaFinding(state, finding({ id: 'b', tabId: 'tab-2' }), MAX_FINDINGS_PER_TAB)
    expect(findingsForTab(state, 'tab-1')).toHaveLength(1)
    expect(findingsForTab(state, 'tab-2')).toHaveLength(1)
  })

  it('finds a finding by id, within its tab only', () => {
    const state = recordMediaFinding(emptyMediaFindings(), finding({ id: 'a' }), 40)
    expect(findFinding(state, 'tab-1', 'a')?.url).toBe('https://example.com/clip.mp4')
    expect(findFinding(state, 'tab-2', 'a')).toBeNull()
    expect(findFinding(state, 'tab-1', 'nope')).toBeNull()
  })

  it('discards a tab’s findings and leaves no key behind', () => {
    // Findings name the addresses a page fetched, which is browsing history by
    // another route. It has no business outliving the page.
    let state = recordMediaFinding(emptyMediaFindings(), finding(), 40)
    state = forgetTabFindings(state, 'tab-1')
    expect(state.byTab).toEqual({})
  })

  it('returns the same state when there is nothing to forget', () => {
    const state = emptyMediaFindings()
    expect(forgetTabFindings(state, 'tab-9')).toBe(state)
  })

  it('drops the oldest when a tab reaches the ceiling', () => {
    // Unbounded input: a page assembling its own buffer can ask for a great many
    // distinct addresses, and the newest is the one the user just started playing.
    let state = emptyMediaFindings()
    for (let index = 0; index < 5; index += 1) {
      state = recordMediaFinding(
        state,
        finding({ id: `m${index}`, url: `https://example.com/${index}.mp4` }),
        3
      )
    }
    expect(findingsForTab(state, 'tab-1').map((one) => one.id)).toEqual(['m2', 'm3', 'm4'])
  })
})

describe('one address seen twice', () => {
  it('folds a response observation into the request that preceded it', () => {
    // The two moments know different things: the request has the address, the
    // response has the content type and the length.
    let state = recordMediaFinding(
      emptyMediaFindings(),
      finding({ id: 'a', url: 'https://cdn.example.com/v/9d2f', container: 'unknown' }),
      40
    )
    state = recordMediaFinding(
      state,
      finding({
        id: 'b',
        url: 'https://cdn.example.com/v/9d2f',
        container: 'mp4',
        contentType: 'video/mp4',
        byteLength: 4096
      }),
      40
    )

    const found = findingsForTab(state, 'tab-1')
    expect(found).toHaveLength(1)
    // The identity the finding was first given survives, so an interface holding
    // a reference to it does not lose its place.
    expect(found[0]!.id).toBe('a')
    expect(found[0]!.container).toBe('mp4')
    expect(found[0]!.contentType).toBe('video/mp4')
    expect(found[0]!.byteLength).toBe(4096)
  })

  it('lets a content type correct a kind guessed from the extension', () => {
    let state = recordMediaFinding(
      emptyMediaFindings(),
      finding({ url: 'https://example.com/stream.mp4', kind: 'progressive', container: 'mp4' }),
      40
    )
    state = recordMediaFinding(
      state,
      finding({
        url: 'https://example.com/stream.mp4',
        kind: 'hls',
        container: 'unknown',
        contentType: 'application/x-mpegurl'
      }),
      40
    )

    const found = findingsForTab(state, 'tab-1')[0]!
    expect(found.kind).toBe('hls')
    // The kind that flipped needs somewhere to record its manifest.
    expect(found.manifest).toEqual({ status: 'not-loaded' })
    // The container the extension suggested is kept: the later observation said
    // `unknown`, which is not more knowledge.
    expect(found.container).toBe('mp4')
  })

  it('does not let a later observation without a content type change the kind', () => {
    let state = recordMediaFinding(
      emptyMediaFindings(),
      finding({
        url: 'https://example.com/x',
        kind: 'hls',
        container: 'unknown',
        contentType: 'application/x-mpegurl',
        manifest: { status: 'not-loaded' }
      }),
      40
    )
    state = recordMediaFinding(
      state,
      finding({ url: 'https://example.com/x', kind: 'progressive', container: 'mp4' }),
      40
    )
    expect(findingsForTab(state, 'tab-1')[0]!.kind).toBe('hls')
  })

  it('keeps a manifest that has already been read', () => {
    const ready = {
      status: 'ready' as const,
      variants: [],
      durationSeconds: 21,
      live: false,
      drm: { protected: false as const }
    }
    let state = recordMediaFinding(
      emptyMediaFindings(),
      finding({ url: 'https://example.com/p.m3u8', kind: 'hls', manifest: ready }),
      40
    )
    state = recordMediaFinding(
      state,
      finding({
        url: 'https://example.com/p.m3u8',
        kind: 'hls',
        contentType: 'application/x-mpegurl',
        manifest: { status: 'not-loaded' }
      }),
      40
    )
    expect(findingsForTab(state, 'tab-1')[0]!.manifest).toBe(ready)
  })

  it('leaves the tab’s other findings untouched when one is enriched', () => {
    let state = recordMediaFinding(
      emptyMediaFindings(),
      finding({ id: 'a', url: 'https://example.com/a.mp4' }),
      40
    )
    state = recordMediaFinding(state, finding({ id: 'b', url: 'https://example.com/b.mp4' }), 40)
    const untouched = findFinding(state, 'tab-1', 'b')
    state = recordMediaFinding(
      state,
      finding({ url: 'https://example.com/a.mp4', contentType: 'video/mp4' }),
      40
    )
    expect(findFinding(state, 'tab-1', 'b')).toBe(untouched)
    expect(findFinding(state, 'tab-1', 'a')?.contentType).toBe('video/mp4')
  })

  it('keeps the document URL it first learned', () => {
    let state = recordMediaFinding(
      emptyMediaFindings(),
      finding({ documentUrl: 'https://example.com/watch' }),
      40
    )
    state = recordMediaFinding(state, finding({ documentUrl: null }), 40)
    expect(findingsForTab(state, 'tab-1')[0]!.documentUrl).toBe('https://example.com/watch')
  })

  it('learns a document URL that the first observation lacked', () => {
    let state = recordMediaFinding(emptyMediaFindings(), finding({ documentUrl: null }), 40)
    state = recordMediaFinding(state, finding({ documentUrl: 'https://example.com/watch' }), 40)
    expect(findingsForTab(state, 'tab-1')[0]!.documentUrl).toBe('https://example.com/watch')
  })

  it('returns the very same state when a repeat observation adds nothing', () => {
    // This is the identity the registry relies on to stay quiet.
    const first = recordMediaFinding(emptyMediaFindings(), finding(), 40)
    const second = recordMediaFinding(first, finding({ id: 'other' }), 40)
    expect(second).toBe(first)
  })
})

describe('recording what a manifest turned out to be', () => {
  const pending = { status: 'pending' as const }

  it('stores the manifest against its finding', () => {
    const state = setManifestState(
      recordMediaFinding(
        emptyMediaFindings(),
        finding({ id: 'a', kind: 'hls', manifest: { status: 'not-loaded' } }),
        40
      ),
      'tab-1',
      'a',
      pending
    )
    expect(findFinding(state, 'tab-1', 'a')?.manifest).toBe(pending)
  })

  it('drops a result whose finding has gone', () => {
    // The load is asynchronous and the tab may have navigated while it was in
    // flight. Handling that in the write means no caller has to check first and
    // race anyway.
    const state = emptyMediaFindings()
    expect(setManifestState(state, 'tab-1', 'a', pending)).toBe(state)
  })

  it('leaves the other findings of the same tab untouched', () => {
    let state = recordMediaFinding(
      emptyMediaFindings(),
      finding({ id: 'a', url: 'https://example.com/a.m3u8', kind: 'hls' }),
      40
    )
    state = recordMediaFinding(
      state,
      finding({ id: 'b', url: 'https://example.com/b.m3u8', kind: 'hls' }),
      40
    )
    const before = findFinding(state, 'tab-1', 'b')
    state = setManifestState(state, 'tab-1', 'a', pending)
    expect(findFinding(state, 'tab-1', 'b')).toBe(before)
  })
})
