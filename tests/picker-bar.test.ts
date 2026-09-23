import { describe, expect, it } from 'vitest'
import {
  PICKER_BAR_ACTIONS,
  PICKER_BAR_HEIGHT,
  PICKER_BAR_INSET,
  PICKER_BAR_MODES,
  PICKER_BAR_WIDTH,
  pickerBarBounds
} from '@shared/overlay/picker-bar.js'
import {
  departureMatters,
  marksThePage,
  mayPresentOver,
  overlayBounds,
  regionOf,
  surfaceIdentity,
  takesFocus,
  type PickerBarPresentation
} from '@shared/overlay/surface.js'
import { notifyOverlayVacancy, onOverlayVacancy } from '@main/permissions/vacancy.js'
import { invokeContract } from '@shared/ipc/contract.js'

/**
 * The confirmation bar, as a claim on the window's topmost layer.
 *
 * Two things are decided here and neither is cosmetic. The bar's rectangle comes from the *tile being
 * picked in*, so a bar computed from the window would count matches in one page while floating over
 * another — the same defect the find bar's corner exists to avoid, arriving from the same direction.
 * And the bar's departure is not free: while it is up a provisional rule is injected into the page and
 * an element is outlined, so a surface that vanished without a word would leave a document with part of
 * itself hidden and nothing on screen to explain it.
 */

const WINDOW = { width: 1440, height: 900 }
const CONTENT = { x: 0, y: 88, width: 1440, height: 812 }
/** The right-hand tile of a `1x2` split, in window coordinates. */
const TILE = { x: 720, y: 88, width: 720, height: 812 }

function pickerBarSample(overrides: Partial<PickerBarPresentation> = {}): PickerBarPresentation {
  return {
    kind: 'picker-bar',
    sessionId: 'pick-1',
    tileIndex: 1,
    bounds: pickerBarBounds(TILE),
    tabId: 't2',
    mode: 'frozen',
    selector: '.ad-slot',
    matches: 3,
    canWiden: true,
    canNarrow: true,
    outcome: null,
    canUndo: false,
    text: {},
    ...overrides
  }
}

describe('where the confirmation bar sits', () => {
  it('puts the bar in the picked tile, inset from its edges', () => {
    expect(pickerBarBounds(TILE)).toEqual({
      x: 720 + 720 - PICKER_BAR_WIDTH - PICKER_BAR_INSET,
      y: 88 + PICKER_BAR_INSET,
      width: PICKER_BAR_WIDTH,
      height: PICKER_BAR_HEIGHT
    })
  })

  it('keeps the bar inside a tile too narrow to hold it', () => {
    /*
      Clamped to the *inset* tile rather than to the whole one, exactly as the find bar is. Clamped to
      the full width, a narrow tile would put the bar's left edge over its neighbour's page — the one
      thing a per-tile surface may never do, because the layer swallows every pointer event inside its
      own bounds.
    */
    const narrow = { x: 100, y: 200, width: 200, height: 400 }
    const bounds = pickerBarBounds(narrow)
    expect(bounds.width).toBe(200 - PICKER_BAR_INSET * 2)
    expect(bounds.x).toBe(narrow.x + PICKER_BAR_INSET)
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(narrow.x + narrow.width)
  })

  it('yields nothing to show for a tile too small to hold anything', () => {
    // What a grid computed before the first paint produces. A zero-sized surface would hold the layer
    // against everything else while drawing nothing, so the core refuses it rather than presenting it.
    const bounds = pickerBarBounds({ x: 0, y: 0, width: 4, height: 4 })
    expect(bounds.width).toBe(0)
    expect(bounds.height).toBe(0)
  })

  it('follows the tile rather than the window', () => {
    /*
      The assertion that says `tile` was the right region. The same bar, presented for the left tile and
      for the right one, must be two different rectangles — and neither may be the window.
    */
    const left = pickerBarBounds({ x: 0, y: 88, width: 720, height: 812 })
    const right = pickerBarBounds(TILE)
    expect(left.x).not.toBe(right.x)
    expect(regionOf('picker-bar')).toBe('tile')
    expect(overlayBounds(pickerBarSample(), WINDOW, CONTENT)).toEqual(pickerBarBounds(TILE))
    expect(overlayBounds(pickerBarSample(), WINDOW, CONTENT)).not.toEqual(CONTENT)
  })
})

describe('the confirmation bar on a contested layer', () => {
  it('gives way to a permission prompt, which ends the picking session', () => {
    /*
      R11 names this as one of the events that end a session, and the ranking is what makes it happen:
      a page can raise a consent dialogue at any moment, and while one is up the window is for answering
      it. The bar loses the layer, the layer announces the departure, and the session that owns the
      provisional rule takes it back off the page.
    */
    expect(mayPresentOver('permission-request', pickerBarSample())).toBe(true)
    expect(mayPresentOver('master-password', pickerBarSample())).toBe(true)
    expect(mayPresentOver('navigation-request', pickerBarSample())).toBe(true)
  })

  it('cannot be destroyed by a pointer drifting towards a tile', () => {
    // The find bar's rank, for the find bar's reason: the bar holds a selection somebody chose, and a
    // hover-revealed tile bar must not be what throws it away.
    expect(mayPresentOver('tile-bar', pickerBarSample())).toBe(false)
  })

  it('updates itself in place as the selection and the measurement change', () => {
    // Equal replaces, which is how a match count and a mode reach the layer at all.
    expect(mayPresentOver('picker-bar', pickerBarSample())).toBe(true)
  })

  it('takes the keyboard, because its whole contract is keys', () => {
    // Up and down widen and narrow, Return confirms, Escape cancels. A bar that did not hold the
    // keyboard would offer that contract and receive none of it.
    expect(takesFocus(pickerBarSample())).toBe(true)
  })
})

describe('the confirmation bar as a mark on the page', () => {
  it('is announced when it leaves, because it leaves something behind', () => {
    /*
      The find bar's problem, one step worse. A find bar that vanishes leaves a highlight; this one
      leaves a *provisional rule injected into the document* — part of the page hidden, with nothing on
      screen to say why or how to get it back. So the departure is announced and the session undoes it.
    */
    expect(marksThePage(pickerBarSample())).toBe(true)
    expect(departureMatters(pickerBarSample())).toBe(true)
  })

  it('carries the departed bar to whoever owns the consequence', () => {
    // The route itself: the layer hands the presentation to the vacancy registry, and the session finds
    // its own by `sessionId` — the same way a find session finds the search a departed bar belonged to.
    const seen: Array<[string, string]> = []
    const off = onOverlayVacancy((presentation, reason) => {
      if (presentation.kind !== 'picker-bar') return
      seen.push([presentation.sessionId, reason])
    })
    notifyOverlayVacancy(pickerBarSample(), 'replaced')
    off()
    expect(seen).toEqual([['pick-1', 'replaced']])
  })

  it('does not read its own update as a departure', () => {
    /*
      The defect this repo has already shipped once, from the permission prompt's side: the layer is
      also how a surface's contents change, so a re-presentation went down the same path as a real
      replacement and announced the surface that was still on screen as gone. Here that would end the
      session on its own first match count — the bar would take itself down the moment it had something
      to say.
    */
    const measured = pickerBarSample({ mode: 'measuring', matches: 7, canWiden: false })
    expect(surfaceIdentity(measured)).toBe(surfaceIdentity(pickerBarSample()))
  })

  it('reads a second picking session as a different surface', () => {
    // A second start ends the first (R11) and opens a new bar; keyed only by kind, the new session's
    // bar would look like an update of the old one and the old one would never be cleaned up.
    expect(surfaceIdentity(pickerBarSample({ sessionId: 'pick-2' }))).not.toBe(
      surfaceIdentity(pickerBarSample())
    )
  })
})

describe('the word the bar sends back', () => {
  const request = invokeContract['picker:barAction'].request

  it('takes a session and one of the six words', () => {
    expect(request.safeParse({ sessionId: 'pick-1', action: 'confirm' }).success).toBe(true)
    for (const action of PICKER_BAR_ACTIONS) {
      expect(request.safeParse({ sessionId: 'pick-1', action }).success, action).toBe(true)
    }
  })

  it('refuses a word that is not one of them, and a press with no session', () => {
    // The validation happens in the main process before a handler sees it, so this is the boundary
    // itself rather than a convention the renderer is trusted to keep.
    expect(request.safeParse({ sessionId: 'pick-1', action: 'commit' }).success).toBe(false)
    expect(request.safeParse({ sessionId: '', action: 'confirm' }).success).toBe(false)
    expect(request.safeParse({ action: 'confirm' }).success).toBe(false)
  })

  it('cannot carry a selector or a rule, whatever the sender puts in it', () => {
    /*
      The guarantee the shape exists for. The core proposed the selector and the core will write the
      rule, so a message able to carry either would let a renderer choose what goes into the user's own
      filter list. Asserted on the parsed value rather than on the schema's text, because that is what a
      handler actually receives.
    */
    const parsed = request.parse({
      sessionId: 'pick-1',
      action: 'confirm',
      selector: 'body',
      rule: 'example.com##body'
    })
    expect(Object.keys(parsed).sort()).toEqual(['action', 'sessionId'])
  })
})

describe('the bar on the wire', () => {
  const schema = invokeContract['overlay:present'].request

  it('carries the words the bar is said in, and refuses a bar without them', () => {
    /*
      The words travel on the presentation because they are not in the renderer's catalogue any more
      (see `main/privacy/picker-bar-text.ts`). A schema that let them be left out would deliver a bar
      whose every label is a bare key — legible to a developer and to nobody else.
    */
    const words = { confirm: 'Block it', 'outcome.saved-effective': 'Blocked.' }
    const parsed = schema.parse(pickerBarSample({ text: words }))
    expect(parsed.kind === 'picker-bar' && parsed.text).toEqual(words)

    const { text: _dropped, ...wordless } = pickerBarSample()
    expect(schema.safeParse(wordless).success).toBe(false)
  })
})

describe('what the bar can be told and what it can say back', () => {
  it('names every state the session can show, and no more', () => {
    /*
      The bar renders what it is given and holds no opinion of its own, so this list is the whole of
      what it can be: pointing at elements, frozen on one, writing the rule, measuring the result, and
      showing the outcome. `ended` is deliberately absent — an ended session has no bar on the layer.
    */
    expect([...PICKER_BAR_MODES]).toEqual(['showing', 'frozen', 'writing', 'measuring', 'outcome'])
  })

  it('names every action a person can take on it', () => {
    // One word each and nothing else on the wire: the selector and the rule text stay in the core,
    // which already knows them, so a forged call can only ever mean one of these six things.
    expect([...PICKER_BAR_ACTIONS]).toEqual([
      'confirm',
      'cancel',
      'widen',
      'narrow',
      'undo',
      'open-rules'
    ])
  })
})
