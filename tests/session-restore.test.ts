import { describe, expect, it } from 'vitest'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import { DEFAULT_FRACTIONS, TILE_COUNT } from '@shared/split/layout.js'
import {
  MAX_SESSION_URL_LENGTH,
  MAX_UNFINISHED_RESTORES,
  type SessionDocument,
  type SessionTab,
  type SessionWindow
} from '@shared/session/model.js'
import {
  loadTimingFor,
  planRestore,
  restorableAddressOf,
  type PlannedTab,
  type PlannedWindow,
  type RestoreSettings
} from '@shared/session/restore.js'
import { applySessionRestore, type RestoreTarget } from '@main/session-restore/apply.js'
import { restoreSettingsFrom } from '@main/session-restore/settings.js'

/**
 * What a saved session becomes under the settings in force right now.
 *
 * Three of these tests are about rules that fail silently rather than loudly: a start
 * page restored as if it were a page, the wrong one of a mid-navigation tab's two
 * addresses, and a layout smaller than the one the file describes. In each case the
 * browser opens, looks plausible, and is wrong — which is why they are pinned here rather
 * than left to the smoke test.
 */

const T_SETTINGS: RestoreSettings = {
  wantsRestore: true,
  afterCrash: true,
  restoreLayout: true,
  defaultLayout: '1x1'
}

function tab(id: string, overrides: Partial<SessionTab> = {}): SessionTab {
  return {
    id,
    url: `https://example.com/${id}`,
    pendingUrl: null,
    title: id,
    pinned: false,
    tileIndex: null,
    zoomPercent: null,
    ...overrides
  }
}

function window_(overrides: Partial<SessionWindow> = {}): SessionWindow {
  return {
    id: 'win-1',
    open: true,
    layout: '1x1',
    fractions: {},
    activeTile: 0,
    tabs: [tab('tab-1')],
    ...overrides
  }
}

function documentOf(...windows: SessionWindow[]): SessionDocument {
  return { version: 1, windows, pendingRestores: 0 }
}

/** The planned windows, or a failure that names the reason instead of an empty array. */
function plannedWindows(
  document: SessionDocument,
  settings: RestoreSettings = T_SETTINGS
): PlannedWindow[] {
  const plan = planRestore(document, settings)
  if (plan.kind === 'skip') throw new Error(`expected a restore, got ${plan.reason}`)
  return plan.windows
}

function firstWindow(document: SessionDocument, settings?: RestoreSettings): PlannedWindow {
  const [only] = plannedWindows(document, settings)
  if (only === undefined) throw new Error('expected one planned window')
  return only
}

describe('which address a tab comes back at', () => {
  it('takes the committed address', () => {
    expect(restorableAddressOf(tab('tab-1', { url: 'https://example.com/a' }))).toBe(
      'https://example.com/a'
    )
  })

  it('does not restore the start page, pinned or not', () => {
    /*
      It is the new-tab page: restoring it produces exactly what a window produces by
      itself. Pinning it is worse than useless — a pinned tile holding the new-tab page is
      a slot the user has to unpin before they can use it.
    */
    for (const url of ['tessera://start', 'tessera://start/', '', 'about:blank']) {
      expect(restorableAddressOf(tab('tab-1', { url })), url).toBe(null)
      expect(restorableAddressOf(tab('tab-1', { url, pinned: true })), `pinned ${url}`).toBe(null)
    }
  })

  it('does restore an internal page that is not the start page', () => {
    // `tessera://history` is somewhere you navigated to and can copy the address of, so a
    // tab holding it is a tab the user put there.
    expect(restorableAddressOf(tab('tab-1', { url: 'tessera://history' }))).toBe(
      'tessera://history'
    )
  })

  it('refuses an address that is not a place to return to', () => {
    for (const url of [
      'data:text/html,hi',
      'blob:https://example.com/x',
      'javascript:alert(1)',
      'chrome-error://chromewebdata/',
      'not a url at all'
    ]) {
      expect(restorableAddressOf(tab('tab-1', { url })), url).toBe(null)
    }
  })

  it('refuses an address longer than the cap rather than cutting it short', () => {
    // Capture already drops one, so this is the hand-edited file — and a truncated URL is
    // an address that resolves nowhere, which is worse than a tab that does not come back.
    const long = `https://example.com/${'x'.repeat(MAX_SESSION_URL_LENGTH)}`
    expect(restorableAddressOf(tab('tab-1', { url: long }))).toBe(null)
  })

  it('prefers the committed address over the one a navigation was in flight to', () => {
    /*
      The pending address is unverified, has no title to label the strip with, and is the
      likeliest reason the browser is being restarted at all — a page that brought a tab
      down was, at that moment, a navigation in flight. Preferring it would walk back into
      the crash this feature has to survive.
    */
    const caught = tab('tab-1', {
      url: 'https://old.example/',
      pendingUrl: 'https://new.example/'
    })
    expect(restorableAddressOf(caught)).toBe('https://old.example/')
  })

  it('falls back to the pending address when nothing had committed', () => {
    // A tab opened straight onto a link has committed nothing; dropping it would lose the
    // tab rather than restore it one page behind.
    const fresh = tab('tab-1', { url: '', pendingUrl: 'https://new.example/' })
    expect(restorableAddressOf(fresh)).toBe('https://new.example/')
  })

  it('restores nothing for a tab with neither address usable', () => {
    expect(restorableAddressOf(tab('tab-1', { url: 'about:blank', pendingUrl: 'data:,x' }))).toBe(
      null
    )
  })
})

describe('when a restored tab fetches', () => {
  it('loads a tab a tile is about to show and defers the rest', () => {
    expect(loadTimingFor(0)).toBe('now')
    expect(loadTimingFor(3)).toBe('now')
    expect(loadTimingFor(null)).toBe('on-activation')
  })

  it('makes a restore cost at most one request per tile', () => {
    /*
      Restoring must not fetch. Twenty tabs that all loaded would be twenty requests
      nobody asked for and twenty renderer processes at once; the tabs a tile displays are
      the exception because a tile is a visible pane, and there are at most four of those.
    */
    const tabs = Array.from({ length: 20 }, (_, index) =>
      tab(`tab-${index}`, { tileIndex: index < 4 ? index : null })
    )
    const planned = firstWindow(documentOf(window_({ layout: '2x2', tabs })))

    const fetching = planned.tabs.filter((entry) => entry.load === 'now')
    expect(fetching.length).toBe(TILE_COUNT['2x2'])
    expect(planned.tabs.length).toBe(20)
  })
})

describe('reconciling a layout the settings no longer allow', () => {
  const saved = window_({
    layout: '2x2',
    fractions: { v: 0.3, h: 0.7 },
    activeTile: 2,
    tabs: [
      tab('tab-1', { tileIndex: 0 }),
      tab('tab-2', { tileIndex: 1 }),
      tab('tab-3', { tileIndex: 2 }),
      tab('tab-4', { tileIndex: 3 })
    ]
  })

  it('brings the saved layout back when the setting allows it', () => {
    const planned = firstWindow(documentOf(saved))
    expect(planned.layout).toBe('2x2')
    expect(planned.fractions).toEqual({ v: 0.3, h: 0.7 })
    expect(planned.activeTile).toBe(2)
    expect(planned.tabs.map((entry) => entry.tileIndex)).toEqual([0, 1, 2, 3])
  })

  it('detaches the tabs whose tiles the smaller layout does not have', () => {
    /*
      `SplitController.assignTab` clamps an out-of-range tile index rather than refusing
      it, so without this every one of the four tabs would claim tile 0 and the last would
      win — three tabs loaded and unreachable in a window that looks like it restored one.
      Spec 2 settled the principle: a tab that loses its place is detached, never closed.
    */
    const planned = firstWindow(documentOf(saved), { ...T_SETTINGS, restoreLayout: false })
    expect(planned.layout).toBe('1x1')
    expect(planned.tabs.map((entry) => entry.tileIndex)).toEqual([0, null, null, null])
    expect(planned.tabs.length, 'no tab is lost').toBe(4)
  })

  it('keeps each pane zoom with its tab when the tiles are dealt out again', () => {
    /*
      The mistake this rules out is the one that looks most natural: "per view" written as "per
      tile". A tile is an index, not an identity — `SplitController.setLayout` throws its maximised
      and fullscreen tiles away on a layout change for exactly that reason, and a drop walks every
      page one tile along — so a zoom kept per tile would be handed to whichever page landed in that
      slot. Here the layout shrinks to `1x1` and three of the four tiles cease to exist; every zoom
      still arrives with the tab it was set on.
    */
    const zoomed = window_({
      layout: '2x2',
      tabs: [
        tab('tab-1', { tileIndex: 0, zoomPercent: 110 }),
        tab('tab-2', { tileIndex: 1, zoomPercent: 200 }),
        tab('tab-3', { tileIndex: 2, zoomPercent: null }),
        tab('tab-4', { tileIndex: 3, zoomPercent: 50 })
      ]
    })
    const planned = firstWindow(documentOf(zoomed), { ...T_SETTINGS, restoreLayout: false })
    expect(planned.tabs.map((entry) => entry.tileIndex)).toEqual([0, null, null, null])
    expect(planned.tabs.map((entry) => [entry.id, entry.zoomPercent])).toEqual([
      ['tab-1', 110],
      ['tab-2', 200],
      ['tab-3', null],
      ['tab-4', 50]
    ])
  })

  it('defers the tabs that lost their tile, so a shrink costs no requests', () => {
    const planned = firstWindow(documentOf(saved), { ...T_SETTINGS, restoreLayout: false })
    expect(planned.tabs.map((entry) => entry.load)).toEqual([
      'now',
      'on-activation',
      'on-activation',
      'on-activation'
    ])
  })

  it('keeps the dividers the new layout shares and defaults the others', () => {
    const wide = window_({
      layout: '1x4',
      fractions: { v: 0.2, v2: 0.4, v3: 0.6 },
      tabs: [tab('tab-1', { tileIndex: 0 })]
    })
    const planned = firstWindow(documentOf(wide), {
      ...T_SETTINGS,
      restoreLayout: false,
      defaultLayout: '1x2'
    })
    expect(planned.fractions).toEqual({ v: 0.5 })
  })

  it("uses the new layout's own defaults, not the saved values, when the layout is not restored", () => {
    const planned = firstWindow(documentOf(saved), {
      ...T_SETTINGS,
      restoreLayout: false,
      defaultLayout: '1+2'
    })
    expect(planned.fractions).toEqual(DEFAULT_FRACTIONS['1+2'])
  })

  it('moves the active tile to one that has a tab', () => {
    /*
      Clamping alone lands on an empty tile, and then the toolbar, the address bar and
      every keyboard command act on no tab at all — which reads as a browser that has
      stopped responding.
    */
    const sparse = window_({
      layout: '2x2',
      activeTile: 3,
      tabs: [tab('tab-1', { tileIndex: 1 }), tab('tab-2', { tileIndex: 2 })]
    })
    expect(firstWindow(documentOf(sparse)).activeTile).toBe(1)
  })

  it('keeps the saved active tile when it still holds a tab', () => {
    const sparse = window_({
      layout: '2x2',
      activeTile: 2,
      tabs: [tab('tab-1', { tileIndex: 1 }), tab('tab-2', { tileIndex: 2 })]
    })
    expect(firstWindow(documentOf(sparse)).activeTile).toBe(2)
  })

  it('puts the first tab in a tile when the file left every tab unassigned', () => {
    // What a window whose only group was collapsed at quit looks like. Restored as saved
    // it would come up blank, which is indistinguishable from a restore that failed.
    const hidden = window_({
      layout: '1x2',
      activeTile: 1,
      tabs: [tab('tab-1'), tab('tab-2')]
    })
    const planned = firstWindow(documentOf(hidden))
    expect(planned.tabs.map((entry) => entry.tileIndex)).toEqual([0, null])
    expect(planned.tabs[0]?.load).toBe('now')
    expect(planned.activeTile).toBe(0)
  })
})

describe('when nothing is restored', () => {
  it('does not restore unless the user asked', () => {
    const plan = planRestore(documentOf(window_()), { ...T_SETTINGS, wantsRestore: false })
    expect(plan).toEqual({ kind: 'skip', reason: 'not-requested' })
  })

  it('has nothing to restore from an empty file', () => {
    expect(planRestore(documentOf(), T_SETTINGS)).toEqual({
      kind: 'skip',
      reason: 'nothing-to-restore'
    })
  })

  it('has nothing to restore from a session of start pages only', () => {
    const blank = window_({ tabs: [tab('tab-1', { url: 'tessera://start' })] })
    expect(planRestore(documentOf(blank), T_SETTINGS)).toEqual({
      kind: 'skip',
      reason: 'nothing-to-restore'
    })
  })

  it('drops one empty window and keeps the other', () => {
    const blank = window_({ id: 'win-1', tabs: [tab('tab-1', { url: 'about:blank' })] })
    const real = window_({ id: 'win-2', tabs: [tab('tab-2')] })
    const windows = plannedWindows(documentOf(blank, real))
    expect(windows.length).toBe(1)
    expect(windows[0]?.tabs[0]?.id).toBe('tab-2')
  })
})

describe('the crash-loop guard', () => {
  it('restores after a single unfinished attempt', () => {
    // One crash is very often unrelated to the pages that were open; abandoning the
    // session over it would mean losing it regularly.
    const document: SessionDocument = { version: 1, windows: [window_()], pendingRestores: 1 }
    expect(planRestore(document, T_SETTINGS).kind).toBe('restore')
  })

  it('refuses once restoring has failed to bring the browser up twice', () => {
    /*
      If restoring the session is what crashes the browser, restoring it again next launch
      means the user can never start — and the more tabs they had, the more certain it is
      that they cannot get in to close the offending one.
    */
    const document: SessionDocument = {
      version: 1,
      windows: [window_()],
      pendingRestores: MAX_UNFINISHED_RESTORES
    }
    expect(planRestore(document, T_SETTINGS)).toEqual({
      kind: 'skip',
      reason: 'restore-keeps-crashing'
    })
  })

  it('refuses after any crash when the user asked it not to try', () => {
    const document: SessionDocument = { version: 1, windows: [window_()], pendingRestores: 1 }
    expect(planRestore(document, { ...T_SETTINGS, afterCrash: false })).toEqual({
      kind: 'skip',
      reason: 'previous-launch-crashed'
    })
  })

  it('restores on a clean launch even with that setting off', () => {
    expect(planRestore(documentOf(window_()), { ...T_SETTINGS, afterCrash: false }).kind).toBe(
      'restore'
    )
  })
})

describe('reading the settings', () => {
  function snapshot(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
    return { ...defaultSettings(), ...overrides }
  }

  it('does not restore on a fresh profile', () => {
    expect(restoreSettingsFrom(snapshot()).wantsRestore).toBe(false)
  })

  it('honours the startup behaviour on its own', () => {
    expect(
      restoreSettingsFrom(snapshot({ 'session.startupBehaviour': 'restore' })).wantsRestore
    ).toBe(true)
  })

  it('honours the standalone switch on its own', () => {
    /*
      Two settings say this one thing, and they did so before restore existed. Honouring
      only one of them would leave the other flipping and doing nothing — the failure spec
      5 forbids, and the one this project already found in `Strg+L`.
    */
    expect(restoreSettingsFrom(snapshot({ 'session.restoreOnStart': true })).wantsRestore).toBe(
      true
    )
  })

  it('carries the layout settings across', () => {
    const settings = restoreSettingsFrom(
      snapshot({ 'splitView.restoreLayoutOnStart': false, 'splitView.defaultLayout': '2x2' })
    )
    expect(settings.restoreLayout).toBe(false)
    expect(settings.defaultLayout).toBe('2x2')
    expect(settings.afterCrash).toBe(true)
  })
})

// --- carrying the plan out ---------------------------------------------------

interface Recorded {
  calls: string[]
  retained: string[]
}

function fakeHost(): { host: Parameters<typeof applySessionRestore>[1]; log: Recorded } {
  const log: Recorded = { calls: [], retained: [] }
  const target = (index: number): RestoreTarget => ({
    openTab: (entry: PlannedTab) =>
      log.calls.push(
        // The zoom is in the log line rather than in a test of its own, so every assertion about
        // what a restore creates has to account for it: a field the plan carries and the caller
        // silently drops is exactly how a pane comes back at 100 % with nothing looking wrong.
        `w${index}:tab=${entry.id}@${String(entry.tileIndex)}/${entry.load}/zoom=${String(entry.zoomPercent)}`
      ),
    setActiveTile: (tile) => log.calls.push(`w${index}:active=${tile}`)
  })

  let windows = 0
  return {
    host: {
      openWindow: (layout, fractions) => {
        windows += 1
        log.calls.push(`w${windows}:open=${layout}/${JSON.stringify(fractions)}`)
        return target(windows)
      },
      retainTabs: (ids) => {
        log.calls.push(`retain=${ids.join(',')}`)
        log.retained = [...ids]
      }
    },
    log
  }
}

describe('carrying a plan out', () => {
  const planned: PlannedWindow = {
    layout: '1x2',
    fractions: { v: 0.4 },
    activeTile: 1,
    tabs: [
      {
        id: 'tab-3',
        url: 'https://a.example/',
        title: 'A',
        pinned: false,
        tileIndex: 0,
        zoomPercent: 175,
        load: 'now'
      },
      {
        id: 'tab-7',
        url: 'https://b.example/',
        title: 'B',
        pinned: false,
        tileIndex: null,
        zoomPercent: null,
        load: 'on-activation'
      }
    ]
  }

  it('opens the window already in its layout, before any tab exists', () => {
    /*
      The layout is part of creating the window rather than something set afterwards,
      because two separate mistakes become unreachable that way. `assignTab` clamps into
      the *current* layout, so tabs arriving at a window still in `1x1` would all land in
      tile 0, each displacing the last. And `setLayout` fills empty tiles with new
      start-page tabs by default, so growing the layout afterwards would fetch pages nobody
      asked for — the exact cost the deferred loading exists to avoid.
    */
    const { host, log } = fakeHost()
    applySessionRestore([planned], host)
    expect(log.calls[0]).toBe('w1:open=1x2/{"v":0.4}')
  })

  it('creates the tabs in strip order and hands each its id, tile, load timing and zoom', () => {
    const { host, log } = fakeHost()
    applySessionRestore([planned], host)
    expect(log.calls).toEqual([
      'w1:open=1x2/{"v":0.4}',
      'w1:tab=tab-3@0/now/zoom=175',
      'w1:tab=tab-7@null/on-activation/zoom=null',
      'w1:active=1',
      'retain=tab-3,tab-7'
    ])
  })

  it('reconciles the tab groups once, with every id from every window', () => {
    /*
      Normal windows share one tab-group document on purpose, so a `retainTabs` per window
      would have the second window's restore empty the first window's groups. The launch
      would end with one window's groups intact and no sign of what happened to the rest.
    */
    const second: PlannedWindow = {
      ...planned,
      tabs: [
        {
          id: 'tab-9',
          url: 'https://c.example/',
          title: 'C',
          pinned: false,
          tileIndex: 0,
          zoomPercent: null,
          load: 'now'
        }
      ]
    }
    const { host, log } = fakeHost()
    const restored = applySessionRestore([planned, second], host)

    expect(log.calls.filter((call) => call.startsWith('retain=')).length).toBe(1)
    expect(log.retained).toEqual(['tab-3', 'tab-7', 'tab-9'])
    expect(restored).toEqual(['tab-3', 'tab-7', 'tab-9'])
  })

  it('reconciles after every tab exists, never before', () => {
    // A group naming a tab that has not been created yet would be emptied, which is
    // precisely the loss this feature exists to stop.
    const { host, log } = fakeHost()
    applySessionRestore([planned], host)
    const retain = log.calls.findIndex((call) => call.startsWith('retain='))
    const lastTab = log.calls.map((call) => call.includes(':tab=')).lastIndexOf(true)
    expect(retain).toBeGreaterThan(lastTab)
  })

  it('still reconciles when the plan turns out to hold no windows', () => {
    // Otherwise a launch that restored nothing would leave the stored groups untouched and
    // the next one would find members that never existed in this run.
    const { host, log } = fakeHost()
    expect(applySessionRestore([], host)).toEqual([])
    expect(log.calls).toEqual(['retain='])
  })
})
