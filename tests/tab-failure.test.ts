import { describe, expect, it } from 'vitest'
import {
  BLOCK_SOURCES,
  blockSourceOf,
  classifyFailure,
  failureMessage,
  offersNetworkSettings,
  offersOpenAnyway,
  type TabFailure
} from '@shared/browser/tab-failure.js'
import { placeView, planViews } from '@shared/browser/view-visibility.js'
import { eventContract } from '@shared/ipc/contract.js'
import type { TabState } from '@shared/model.js'
import { captureWindow } from '@shared/session/model.js'

/**
 * What a failed page or a gone renderer looks like to the tile that shows it (U9, R9, R10, KTD4).
 *
 * The classification decides whether a tile loses its page to a failure panel, and both of its
 * mistakes are visible: a state where none belongs (the browser's own HTTPS redirect, an advert frame
 * the blocker refused) covers a page that is fine, and a missing one leaves Chromium's grey error page
 * standing where the reason and the way out were meant to be.
 */

const load = (
  code: number,
  overrides: Partial<{
    isMainFrame: boolean
    url: string
    blockedBy: TabFailure['source'] | null
  }> = {}
) =>
  classifyFailure({
    event: 'did-fail-load',
    code,
    isMainFrame: overrides.isMainFrame ?? true,
    url: overrides.url ?? 'https://example.com/page',
    blockedBy: overrides.blockedBy ?? null
  })

const gone = (reason: string, unloading = false) =>
  classifyFailure({
    event: 'render-process-gone',
    reason,
    exitCode: 11,
    url: 'https://example.com/page',
    unloading
  })

describe('classifyFailure: loads', () => {
  it('gives a subframe that failed no state, whatever the code', () => {
    expect(load(-105, { isMainFrame: false })).toBeNull()
    expect(load(-20, { isMainFrame: false, blockedBy: 'blocker' })).toBeNull()
    expect(load(-130, { isMainFrame: false })).toBeNull()
  })

  it('keeps -3 silent in the main frame, so the own HTTPS redirect, a stop and a download stay quiet', () => {
    expect(load(-3)).toBeNull()
  })

  it('keeps a non-error code silent', () => {
    expect(load(0)).toBeNull()
  })

  it('gives -20 from the blocker a blocked state that offers a way through', () => {
    const failure = load(-20, { blockedBy: 'blocker' })
    expect(failure).toEqual({ kind: 'blocked', code: -20, host: 'example.com', source: 'blocker' })
    expect(offersOpenAnyway(failure!)).toBe(true)
  })

  it('gives -20 from the telemetry stage a blocked state without one', () => {
    const failure = load(-20, { blockedBy: 'telemetry' })
    expect(failure).toEqual({
      kind: 'blocked',
      code: -20,
      host: 'example.com',
      source: 'telemetry'
    })
    expect(offersOpenAnyway(failure!)).toBe(false)
  })

  it('offers nothing for the kill switch or the redirect stage either', () => {
    expect(offersOpenAnyway(load(-20, { blockedBy: 'killSwitch' })!)).toBe(false)
    expect(offersOpenAnyway(load(-20, { blockedBy: 'redirect' })!)).toBe(false)
  })

  it('explains a kill-switch stop with the direct route, and offers the network settings (U13)', () => {
    const stopped = load(-20, { blockedBy: 'killSwitch' })!
    expect(failureMessage(stopped).key).toBe('error.killSwitch')
    expect(offersNetworkSettings(stopped)).toBe(true)
    // Only there: a blocker's refusal, a dead proxy and a crash have other ways out.
    expect(offersNetworkSettings(load(-20, { blockedBy: 'blocker' })!)).toBe(false)
    expect(offersNetworkSettings(load(-130)!)).toBe(false)
    expect(
      offersNetworkSettings({ kind: 'crashed', code: 1, host: '', source: 'killSwitch' })
    ).toBe(false)
  })

  it('shows a dead proxy under the kill switch as the proxy state (AE6)', () => {
    // Manual mode with the kill switch on: Chromium fails closed with -130, and that is the tile.
    const failure = load(-130)!
    expect(failure.kind).toBe('proxy')
    expect(failureMessage(failure).key).toBe('error.proxy')
  })

  it('names no source, and offers no way through, for a -20 nobody recorded', () => {
    const failure = load(-20)
    expect(failure).toEqual({ kind: 'blocked', code: -20, host: 'example.com' })
    expect(offersOpenAnyway(failure!)).toBe(false)
  })

  it.each([-111, -120, -121, -130, -131])('gives the proxy code %i a proxy state', (code) => {
    expect(load(code)).toEqual({ kind: 'proxy', code, host: 'example.com' })
  })

  it('gives -105 a network state', () => {
    expect(load(-105)).toEqual({ kind: 'network', code: -105, host: 'example.com' })
  })

  it.each([-200, -201, -202, -299])('gives the certificate code %i a certificate state', (code) => {
    const failure = load(code)
    expect(failure).toEqual({ kind: 'certificate', code, host: 'example.com' })
    // "Zertifikat ohne Weiter": there is no way past a certificate the browser rejected.
    expect(offersOpenAnyway(failure!)).toBe(false)
  })

  it('treats the codes just outside the certificate range as network failures', () => {
    expect(load(-199)?.kind).toBe('network')
    expect(load(-300)?.kind).toBe('network')
  })

  it('never offers a way through for anything but a blocked page', () => {
    expect(offersOpenAnyway(load(-105)!)).toBe(false)
    expect(offersOpenAnyway({ kind: 'crashed', code: 1, host: '', source: 'blocker' })).toBe(false)
  })

  it('reads the host from the address, and an empty one from an address without one', () => {
    expect(load(-105, { url: 'https://WWW.Example.org:8443/x' })?.host).toBe('www.example.org')
    expect(load(-105, { url: 'not a url' })?.host).toBe('')
    expect(load(-105, { url: '' })?.host).toBe('')
  })

  it('carries no address of its own, so the tab state keeps naming the real page', () => {
    // The failure is kind, code, host and source — never a URL a caller could mistake for the page's.
    expect(Object.keys(load(-105)!).sort()).toEqual(['code', 'host', 'kind'])
    expect(Object.keys(load(-20, { blockedBy: 'blocker' })!).sort()).toEqual([
      'code',
      'host',
      'kind',
      'source'
    ])
  })
})

describe('classifyFailure: renderer gone', () => {
  it('gives a crash a crashed state with the exit code', () => {
    expect(gone('crashed')).toEqual({ kind: 'crashed', code: 11, host: 'example.com' })
  })

  it('keeps a clean exit silent', () => {
    expect(gone('clean-exit')).toBeNull()
  })

  it.each(['abnormal-exit', 'killed', 'oom', 'launch-failed', 'integrity-failure'])(
    'treats %s as a crash',
    (reason) => {
      expect(gone(reason)?.kind).toBe('crashed')
    }
  )

  it('does not call a memory eviction a crash while the tab is being unloaded', () => {
    expect(gone('memory-eviction', true)).toBeNull()
  })

  it('does call it one when nothing asked for the tab to be unloaded', () => {
    expect(gone('memory-eviction', false)?.kind).toBe('crashed')
  })
})

describe('blockSourceOf', () => {
  it('maps every pipeline stage that cancels to its source', () => {
    expect(blockSourceOf('blocker')).toBe('blocker')
    expect(blockSourceOf('telemetry')).toBe('telemetry')
    expect(blockSourceOf('redirect')).toBe('redirect')
    expect(blockSourceOf('kill-switch')).toBe('killSwitch')
  })

  it('knows nothing of a stage that only rewrites, or of one it has never heard of', () => {
    expect(blockSourceOf('https-upgrade')).toBeNull()
    expect(blockSourceOf('tracking-params')).toBeNull()
    expect(blockSourceOf('toString')).toBeNull()
  })

  it('lists exactly the sources the mapping can produce', () => {
    expect([...BLOCK_SOURCES].sort()).toEqual(['blocker', 'killSwitch', 'redirect', 'telemetry'])
  })
})

describe('failureMessage', () => {
  const failure = (kind: TabFailure['kind'], code: number): TabFailure => ({
    kind,
    code,
    host: 'example.com'
  })

  it('reuses the existing wording for DNS, offline, certificate and blocked', () => {
    expect(failureMessage(failure('network', -105)).key).toBe('error.dnsFailed')
    expect(failureMessage(failure('network', -137)).key).toBe('error.dnsFailed')
    expect(failureMessage(failure('network', -106)).key).toBe('error.offline')
    expect(failureMessage(failure('certificate', -202)).key).toBe('error.certificate')
    expect(failureMessage(failure('blocked', -20)).key).toBe('error.blocked')
  })

  it('has its own wording for the rest of the network, the proxy and a crash', () => {
    expect(failureMessage(failure('network', -102)).key).toBe('error.network')
    expect(failureMessage(failure('proxy', -130)).key).toBe('error.proxy')
    expect(failureMessage(failure('crashed', 11)).key).toBe('error.crashed')
  })

  it('hands the host to the sentence', () => {
    expect(failureMessage(failure('network', -105)).params).toEqual({ host: 'example.com' })
  })
})

describe('view visibility (KTD22)', () => {
  const rect = { x: 0, y: 0, width: 400, height: 300 }
  const crashed: TabFailure = { kind: 'crashed', code: 11, host: 'example.com' }

  it('shows a healthy tab in its tile and draws nothing over it', () => {
    expect(placeView(rect, {})).toEqual({ visible: true, rect, showsFailure: false })
  })

  it('hides a failed tab and draws the failure in the same rectangle', () => {
    expect(placeView(rect, { failure: crashed })).toEqual({
      visible: false,
      rect,
      showsFailure: true
    })
  })

  it('shows nothing for a tab without a tile', () => {
    expect(placeView(null, { failure: crashed })).toEqual({
      visible: false,
      rect: null,
      showsFailure: false
    })
  })

  it('keeps a failed view hidden through a layout change', () => {
    const tabs = new Map([
      ['a', { failure: crashed }],
      ['b', {}]
    ])
    const before = planViews(
      [
        { tabId: 'a', rect },
        { tabId: 'b', rect: { ...rect, x: 404 } }
      ],
      tabs
    )
    // The layout changes: `a` moves into the other half and grows.
    const moved = { x: 0, y: 0, width: 808, height: 150 }
    const after = planViews(
      [
        { tabId: 'b', rect },
        { tabId: 'a', rect: moved }
      ],
      tabs
    )
    expect(before.get('a')).toEqual({ visible: false, rect })
    expect(after.get('a')).toEqual({ visible: false, rect: moved })
    expect(after.get('b')).toEqual({ visible: true, rect })
  })

  it('hides every tab no tile holds, and ignores a tile without a tab or a rectangle', () => {
    const tabs = new Map([
      ['a', {}],
      ['off', {}]
    ])
    const plan = planViews(
      [
        { tabId: 'a', rect },
        { tabId: null, rect },
        { tabId: 'gone', rect },
        { tabId: 'off', rect: null }
      ],
      tabs
    )
    expect([...plan.keys()]).toEqual(['a', 'off'])
    expect(plan.get('a')).toEqual({ visible: true, rect })
    expect(plan.get('off')).toEqual({ visible: false, rect: null })
  })

  it('hides both tiles when two tabs of one renderer crash', () => {
    const tabs = new Map([
      ['a', { failure: crashed }],
      ['b', { failure: crashed }]
    ])
    const plan = planViews(
      [
        { tabId: 'a', rect },
        { tabId: 'b', rect: { ...rect, x: 404 } }
      ],
      tabs
    )
    expect(plan.get('a')?.visible).toBe(false)
    expect(plan.get('b')?.visible).toBe(false)
  })
})

describe('TabState.failure at the boundary', () => {
  const state: TabState = {
    id: 'tab-1',
    url: 'https://example.com/page',
    pendingInput: null,
    title: 'Example',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    muted: false,
    audible: false,
    security: 'secure',
    blockedRequests: 0,
    zoomPercent: null,
    tileIndex: 0,
    unloaded: false
  }
  const failed: TabState = {
    ...state,
    failure: { kind: 'blocked', code: -20, host: 'example.com', source: 'blocker' }
  }

  it('lets a tab state without a failure through the contract', () => {
    const parsed = eventContract['tabs:changed'].parse({ tabs: [state], activeTabId: 'tab-1' })
    expect(parsed.tabs[0]).not.toHaveProperty('failure')
  })

  it('lets a tab state with one through, still naming the real page', () => {
    const parsed = eventContract['tabs:changed'].parse({ tabs: [failed], activeTabId: 'tab-1' })
    expect(parsed.tabs[0]?.failure).toEqual(failed.failure)
    // What Strg+D bookmarks is this address, and a failure never replaces it.
    expect(parsed.tabs[0]?.url).toBe('https://example.com/page')
  })

  it('refuses a failure of a kind nobody draws', () => {
    const wrong = { ...state, failure: { kind: 'sad', code: 1, host: '' } }
    expect(() =>
      eventContract['tabs:changed'].parse({ tabs: [wrong], activeTabId: null })
    ).toThrow()
  })

  it('never writes the failure into the session', () => {
    const slot = captureWindow('w1', {
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: [failed]
    })
    expect(JSON.stringify(slot)).not.toContain('failure')
    expect(slot.tabs[0]?.url).toBe('https://example.com/page')
  })
})
