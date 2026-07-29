import { describe, expect, it } from 'vitest'
import {
  MAX_SESSION_TABS_PER_WINDOW,
  MAX_SESSION_TITLE_LENGTH,
  MAX_SESSION_URL_LENGTH,
  MAX_SESSION_WINDOWS,
  MAX_UNFINISHED_RESTORES,
  captureWindow,
  claimTile,
  clampTile,
  discardingSessionRecorder,
  emptySessionDocument,
  finishedRestore,
  forgetWindow,
  keepKnownFractions,
  recordWindow,
  repairSession,
  startedRun,
  type CapturedTab,
  type SessionDocument,
  type SessionTab,
  type SessionWindow
} from '@shared/session/model.js'
import { sequenceOfTabId, tabIdForSequence } from '@shared/session/tab-ids.js'

/**
 * What a saved session is, and what happens to one.
 *
 * Pure throughout, so none of this needs a clock or a filesystem: identity is handed in,
 * which is the whole reason the store is a separate object. What is being pinned down is
 * the set of invariants a restore and the tab groups both depend on — one tab id in the
 * whole document, one tab per tile, no window with nothing in it, and a slot per window
 * that survives the way people actually quit.
 */

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

function window_(id: string, overrides: Partial<SessionWindow> = {}): SessionWindow {
  return {
    id,
    open: true,
    layout: '1x1',
    fractions: {},
    activeTile: 0,
    tabs: [tab(`${id}-a`)],
    ...overrides
  }
}

function documentOf(...windows: SessionWindow[]): SessionDocument {
  return { version: 1, windows, pendingRestores: 0 }
}

describe('an empty session', () => {
  it('starts with no windows and no unfinished restore', () => {
    expect(emptySessionDocument()).toEqual({ version: 1, windows: [], pendingRestores: 0 })
  })
})

describe('capturing a window', () => {
  const captured: CapturedTab = {
    id: 'tab-1',
    url: 'https://example.com/',
    pendingInput: null,
    title: 'Example',
    pinned: true,
    tileIndex: 0,
    zoomPercent: 150
  }

  it('records the address, the title, the pin, the tile and the pane zoom', () => {
    const slot = captureWindow('win-1', {
      layout: '1x2',
      fractions: { v: 0.4 },
      activeTile: 1,
      tabs: [captured]
    })

    expect(slot).toEqual({
      id: 'win-1',
      open: true,
      layout: '1x2',
      fractions: { v: 0.4 },
      activeTile: 1,
      tabs: [
        {
          id: 'tab-1',
          url: 'https://example.com/',
          pendingUrl: null,
          title: 'Example',
          pinned: true,
          tileIndex: 0,
          zoomPercent: 150
        }
      ]
    })
  })

  it('keeps "never zoomed" as itself rather than writing the default down', () => {
    /*
      The one field where storing the obvious number would be a bug. `null` means the pane follows
      `appearance.defaultZoom`; a capture that turned it into 100 would pin every restored pane to
      today's setting, and the user could never change the default for their existing windows again.
    */
    const slot = captureWindow('win-1', {
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: [{ ...captured, zoomPercent: null }]
    })
    expect(slot.tabs[0]?.zoomPercent).toBeNull()
  })

  it('keeps both addresses of a tab caught mid-navigation', () => {
    // Which of the two comes back is a restore-time decision; capture must not throw
    // either of them away or that decision cannot be made.
    const slot = captureWindow('win-1', {
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: [{ ...captured, url: 'https://old.example/', pendingInput: 'https://new.example/' }]
    })
    const [only] = slot.tabs
    expect(only?.url).toBe('https://old.example/')
    expect(only?.pendingUrl).toBe('https://new.example/')
  })

  it('stores a start-page tab faithfully rather than judging it here', () => {
    // The rule that drops it belongs to `planRestore`: the settings can change between
    // being written and being read, so capture stays a record and not a decision.
    const slot = captureWindow('win-1', {
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: [{ ...captured, url: 'tessera://start' }]
    })
    expect(slot.tabs[0]?.url).toBe('tessera://start')
  })

  it('collapses a title onto one line and cuts it to the cap', () => {
    const slot = captureWindow('win-1', {
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: [{ ...captured, title: `  a\n\tb  ${'x'.repeat(400)}` }]
    })
    const title = slot.tabs[0]?.title ?? ''
    expect(title.startsWith('a b x')).toBe(true)
    expect(title.length).toBe(MAX_SESSION_TITLE_LENGTH)
  })

  it('drops an address too long to be worth keeping rather than cutting it', () => {
    // A cut URL is an address that no longer resolves, so half of one is worse than none.
    const long = `https://example.com/${'x'.repeat(MAX_SESSION_URL_LENGTH)}`
    const slot = captureWindow('win-1', {
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: [{ ...captured, url: long, pendingInput: long }]
    })
    expect(slot.tabs[0]?.url).toBe('')
    expect(slot.tabs[0]?.pendingUrl).toBe('')
  })

  it("copies the fractions rather than holding the window's own object", () => {
    const live = { v: 0.5 }
    const slot = captureWindow('win-1', {
      layout: '1x2',
      fractions: live,
      activeTile: 0,
      tabs: [captured]
    })
    live.v = 0.9
    expect(slot.fractions).toEqual({ v: 0.5 })
  })
})

describe('recording a window', () => {
  it('replaces a slot in place, so the restore order does not shuffle', () => {
    const document = documentOf(window_('a'), window_('b'))
    const next = recordWindow(document, window_('a', { tabs: [tab('a-z')] }))
    expect(next.windows.map((window) => window.id)).toEqual(['a', 'b'])
    expect(next.windows[0]?.tabs.map((entry) => entry.id)).toEqual(['a-z'])
  })

  it('adds a slot for a window it has not seen', () => {
    const next = recordWindow(documentOf(window_('a')), window_('b'))
    expect(next.windows.map((window) => window.id)).toEqual(['a', 'b'])
  })

  it('drops closed slots when a new window opens', () => {
    /*
      The macOS path: the last window closed, its slot was kept as the session to come
      back to, and then the user opened a fresh window in the same run. Keeping the old
      slot would restore a phantom window beside the real one on the next launch.
    */
    const document = documentOf(window_('a', { open: false }))
    const next = recordWindow(document, window_('b'))
    expect(next.windows.map((window) => window.id)).toEqual(['b'])
  })

  it('keeps open slots when a new window opens', () => {
    const document = documentOf(window_('a'))
    const next = recordWindow(document, window_('b'))
    expect(next.windows.map((window) => window.id)).toEqual(['a', 'b'])
  })

  it('keeps only the newest windows once the cap is passed', () => {
    let document = emptySessionDocument()
    for (let index = 0; index < MAX_SESSION_WINDOWS + 3; index++) {
      document = recordWindow(document, window_(`w${index}`))
    }
    expect(document.windows.length).toBe(MAX_SESSION_WINDOWS)
    expect(document.windows[0]?.id).toBe('w3')
  })
})

describe('a window closing', () => {
  it('removes the slot while another window is still open', () => {
    const document = documentOf(window_('a'), window_('b'))
    expect(forgetWindow(document, 'a').windows.map((window) => window.id)).toEqual(['b'])
  })

  it('keeps the last slot and marks it closed', () => {
    /*
      This is what makes quitting work on Windows and Linux, where closing the final
      window *is* how the application ends: that close arrives before `before-quit`, so a
      rule that removed the slot would empty the session on the commonest exit path.
    */
    const next = forgetWindow(documentOf(window_('a')), 'a')
    expect(next.windows.map((window) => window.id)).toEqual(['a'])
    expect(next.windows[0]?.open).toBe(false)
  })

  it('ignores a slot it does not have', () => {
    const document = documentOf(window_('a'))
    expect(forgetWindow(document, 'nope')).toEqual(document)
  })

  it('leaves an already-closed slot alone when the last open one goes', () => {
    // A hand-edited or hand-repaired file can hold a closed slot beside an open one; the
    // write path cannot produce it. The closed slot must come through untouched rather
    // than be reopened or dropped by the rule that keeps the last one.
    const document = documentOf(window_('a', { open: false }), window_('b'))
    const next = forgetWindow(document, 'b')
    expect(next.windows.map((window) => window.id)).toEqual(['a', 'b'])
    expect(next.windows.map((window) => window.open)).toEqual([false, false])
  })
})

describe('the crash-loop counter', () => {
  it('counts a launch that restores and hands the previous slots over', () => {
    const document = documentOf(window_('a'))
    const next = startedRun(document, true)
    expect(next.windows).toEqual([])
    expect(next.pendingRestores).toBe(1)
  })

  it('accumulates across launches that never report success', () => {
    let document = emptySessionDocument()
    for (let launch = 0; launch < MAX_UNFINISHED_RESTORES; launch++) {
      document = startedRun(document, true)
    }
    expect(document.pendingRestores).toBe(MAX_UNFINISHED_RESTORES)
  })

  it('resets when a launch does not restore, so the guard cannot lock anyone out', () => {
    const document: SessionDocument = { version: 1, windows: [], pendingRestores: 7 }
    expect(startedRun(document, false).pendingRestores).toBe(0)
  })

  it('resets when the browser has stayed up', () => {
    const document: SessionDocument = { version: 1, windows: [window_('a')], pendingRestores: 2 }
    const next = finishedRestore(document)
    expect(next.pendingRestores).toBe(0)
    expect(next.windows.map((window) => window.id)).toEqual(['a'])
  })
})

describe('repairing a loaded document', () => {
  it('drops a duplicate window id rather than shadowing the first', () => {
    const document = documentOf(window_('a'), window_('a', { tabs: [tab('other')] }))
    expect(repairSession(document).windows.length).toBe(1)
  })

  it('lets the first claim on a tab id win, everywhere in the document', () => {
    /*
      The most consequential repair here. Two tabs answering to one id is exactly the
      failure `tab-ids.ts` exists to prevent, and a document carrying it would reproduce
      it on every launch until someone deleted the file.
    */
    const document = documentOf(
      window_('a', { tabs: [tab('tab-1'), tab('tab-2')] }),
      window_('b', { tabs: [tab('tab-1'), tab('tab-3')] })
    )
    const repaired = repairSession(document)
    expect(repaired.windows[0]?.tabs.map((entry) => entry.id)).toEqual(['tab-1', 'tab-2'])
    expect(repaired.windows[1]?.tabs.map((entry) => entry.id)).toEqual(['tab-3'])
  })

  it('drops a window left with no tabs at all', () => {
    const document = documentOf(
      window_('a', { tabs: [tab('tab-1')] }),
      window_('b', { tabs: [tab('tab-1')] })
    )
    expect(repairSession(document).windows.map((window) => window.id)).toEqual(['a'])
  })

  it('unassigns a tile the layout does not have', () => {
    // Spec 2: a tab that loses its place is detached, never closed.
    const document = documentOf(
      window_('a', { layout: '1x1', tabs: [tab('tab-1', { tileIndex: 3 })] })
    )
    expect(repairSession(document).windows[0]?.tabs[0]?.tileIndex).toBe(null)
  })

  it('unassigns a negative tile', () => {
    const document = documentOf(window_('a', { tabs: [tab('tab-1', { tileIndex: -1 })] }))
    expect(repairSession(document).windows[0]?.tabs[0]?.tileIndex).toBe(null)
  })

  it('lets the first tab claim a tile that two of them name', () => {
    const document = documentOf(
      window_('a', {
        layout: '1x2',
        tabs: [tab('tab-1', { tileIndex: 1 }), tab('tab-2', { tileIndex: 1 })]
      })
    )
    const tabs = repairSession(document).windows[0]?.tabs ?? []
    expect(tabs.map((entry) => entry.tileIndex)).toEqual([1, null])
  })

  it('clamps a zoom the browser could not apply, rather than dropping it', () => {
    /*
      A hand-edited 5000 is a pane the user cannot read their way out of — the menu item that would
      rescue it is off screen with everything else. Healed to the largest step rather than to
      `null`, because those are different statements: `null` would quietly put the pane back under
      `appearance.defaultZoom`, which is precisely the state it was taken out of.
    */
    const document = documentOf(window_('a', { tabs: [tab('tab-1', { zoomPercent: 5000 })] }))
    expect(repairSession(document).windows[0]?.tabs[0]?.zoomPercent).toBe(300)
  })

  it('leaves "never zoomed" alone, because it is not a value to be healed', () => {
    const document = documentOf(window_('a', { tabs: [tab('tab-1', { zoomPercent: null })] }))
    expect(repairSession(document).windows[0]?.tabs[0]?.zoomPercent).toBeNull()
  })

  it('clamps an active tile outside the layout', () => {
    const document = documentOf(window_('a', { layout: '1x2', activeTile: 9 }))
    expect(repairSession(document).windows[0]?.activeTile).toBe(1)
  })

  it('keeps only the dividers the layout has, filling the rest in from its defaults', () => {
    const document = documentOf(window_('a', { layout: '2x2', fractions: { v: 0.3, vRight: 0.8 } }))
    expect(repairSession(document).windows[0]?.fractions).toEqual({ v: 0.3, h: 0.5 })
  })

  it('discards a divider position that would leave a tile with no size', () => {
    const document = documentOf(window_('a', { layout: '1x2', fractions: { v: 0 } }))
    expect(repairSession(document).windows[0]?.fractions).toEqual({ v: 0.5 })
  })

  it('discards a divider position that is not a number at all', () => {
    const document = documentOf(
      window_('a', { layout: '1x2', fractions: { v: Number.POSITIVE_INFINITY } })
    )
    expect(repairSession(document).windows[0]?.fractions).toEqual({ v: 0.5 })
  })

  it('trims a window that holds more tabs than the cap', () => {
    const many = Array.from({ length: MAX_SESSION_TABS_PER_WINDOW + 5 }, (_, index) =>
      tab(`tab-${index}`)
    )
    const repaired = repairSession(documentOf(window_('a', { tabs: many })))
    expect(repaired.windows[0]?.tabs.length).toBe(MAX_SESSION_TABS_PER_WINDOW)
  })

  it('trims a document that holds more windows than the cap', () => {
    const many = Array.from({ length: MAX_SESSION_WINDOWS + 4 }, (_, index) =>
      window_(`w${index}`, { tabs: [tab(`tab-${index}`)] })
    )
    const repaired = repairSession(documentOf(...many))
    expect(repaired.windows.length).toBe(MAX_SESSION_WINDOWS)
    expect(repaired.windows[0]?.id).toBe('w4')
  })

  it('collapses a title it finds with newlines in it', () => {
    const document = documentOf(window_('a', { tabs: [tab('tab-1', { title: 'a\n b' })] }))
    expect(repairSession(document).windows[0]?.tabs[0]?.title).toBe('a b')
  })

  it('leaves the unfinished-restore count alone', () => {
    const document: SessionDocument = { version: 1, windows: [window_('a')], pendingRestores: 1 }
    expect(repairSession(document).pendingRestores).toBe(1)
  })
})

describe('the tile helpers', () => {
  it('refuses a tile that is already taken', () => {
    const taken = new Set<number>([0])
    expect(claimTile(0, 2, taken)).toBe(null)
    expect(claimTile(1, 2, taken)).toBe(1)
  })

  it('treats a non-numeric active tile as the first one', () => {
    expect(clampTile(Number.NaN, 4)).toBe(0)
  })

  it('answers the only tile there is for a single-tile layout', () => {
    expect(clampTile(3, 1)).toBe(0)
  })

  it('never answers below zero, even for a layout with no tiles', () => {
    expect(clampTile(2, 0)).toBe(0)
  })

  it('fills in a divider the file has no value for rather than leaving it at zero', () => {
    // A missing fraction is not a position of zero; it is a divider in the middle.
    expect(keepKnownFractions({}, '2x2')).toEqual({ v: 0.5, h: 0.5 })
  })
})

describe('the recorder a private window is handed', () => {
  it('accepts both calls and holds nothing', () => {
    /*
      No slot is allocated for it either, which is the second half of the requirement: a
      recorder that wrote an empty slot would store no addresses and still put the number
      of private windows on disk.
    */
    expect(() => {
      discardingSessionRecorder.record({
        layout: '2x2',
        fractions: { v: 0.5 },
        activeTile: 0,
        tabs: [
          {
            id: 'tab-1',
            url: 'https://secret.example/',
            pendingInput: null,
            title: 'Secret',
            pinned: false,
            tileIndex: 0,
            zoomPercent: null
          }
        ]
      })
      discardingSessionRecorder.close()
    }).not.toThrow()
  })
})

describe('tab ids across a restart', () => {
  it('reads the sequence out of an id the counter produced', () => {
    expect(sequenceOfTabId(tabIdForSequence(42))).toBe(42)
  })

  it('answers zero for an id this counter did not produce', () => {
    // A hand-edited or foreign id contributes nothing to the high-water mark, and cannot
    // collide either: every id the counter produces ends in digits.
    expect(sequenceOfTabId('tab-abc')).toBe(0)
    expect(sequenceOfTabId('restored-7')).toBe(0)
    expect(sequenceOfTabId('tab-')).toBe(0)
    expect(sequenceOfTabId('tab-7x')).toBe(0)
    expect(sequenceOfTabId('')).toBe(0)
  })

  it('answers zero for a number too large to count with', () => {
    /*
      Returning it would set the counter to an unsafe integer, where `+= 1` stops changing
      the value — so the next two fresh tabs would share an id. The guard against the
      collision must not be the thing that causes one.
    */
    expect(sequenceOfTabId(`tab-${'9'.repeat(25)}`)).toBe(0)
  })

  it('cannot hand a fresh tab an id a restored tab already has', () => {
    /*
      The three lines this mirrors are `nextTabId` and `adoptTabId` in
      `src/main/browser/Tab.ts`: a module-level counter, `+= 1` then `tabIdForSequence`,
      and `Math.max(sequence, sequenceOfTabId(id))` on adoption. That file cannot run
      outside a browser process, so the arithmetic lives in `shared/session/tab-ids.ts`
      and this is where the invariant is held.

      The restored set is deliberately gappy and out of order — closed tabs leave holes,
      and a second window's ids interleave with the first's.
    */
    const restored = ['tab-9', 'tab-2', 'tab-abc', 'tab-4']
    let sequence = 0
    for (const id of restored) sequence = Math.max(sequence, sequenceOfTabId(id))

    const fresh: string[] = []
    for (let index = 0; index < 5; index++) {
      sequence += 1
      fresh.push(tabIdForSequence(sequence))
    }

    expect(fresh).toEqual(['tab-10', 'tab-11', 'tab-12', 'tab-13', 'tab-14'])
    for (const id of fresh) {
      expect(restored, `fresh id ${id} collides with a restored one`).not.toContain(id)
    }
  })
})
