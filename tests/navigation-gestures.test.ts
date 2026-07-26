import { describe, expect, it } from 'vitest'
import {
  APP_COMMAND_INTENTS,
  SWIPE_INTENTS,
  decideNavigationGesture,
  gestureIntent,
  tileUnderPointer,
  type GestureSource
} from '@shared/gestures/navigation.js'
import { mouseMoveY } from '@shared/gestures/pointer.js'
import { computeTileRects, type Rect } from '@shared/split/layout.js'

/**
 * Back and forward from a mouse's extra buttons and from a trackpad swipe.
 *
 * Two things here are conventions rather than derivations, which is exactly why they are tested
 * against a table instead of being two lines inside an event subscription:
 *
 *  - **Which direction means what.** A swipe to the right goes *back*: the page follows your
 *    fingers, so pushing it rightwards uncovers what was to its left. One negation the other way
 *    and every gesture in the browser is wrong, with nothing to catch it.
 *  - **Which tile it applies to.** The events carry no position, so something has to choose. With
 *    four pages on screen, the tile under the cursor is the one being read; the tile that last had
 *    focus frequently is not.
 */

const CONTENT: Rect = { x: 0, y: 88, width: 1440, height: 812 }
const COLUMNS = computeTileRects('1x2', {}, CONTENT, { gutter: 8 })

const decide = (
  source: GestureSource,
  name: string,
  pointer: { x: number; y: number } | null,
  activeTile = 0
): ReturnType<typeof decideNavigationGesture> =>
  decideNavigationGesture({ source, name, pointer, tiles: COLUMNS, activeTile })

describe('what a mouse button means', () => {
  it('reads the two navigation commands', () => {
    expect(gestureIntent('app-command', 'browser-backward')).toBe('back')
    expect(gestureIntent('app-command', 'browser-forward')).toBe('forward')
  })

  it('claims nothing else the mouse can send', () => {
    /*
      A five-button mouse sends refresh, home, search and a row of media keys. Each would be a
      separate decision about which tile it applies to and whether the browser should act at all,
      so they fall through rather than being claimed for symmetry.
    */
    for (const name of ['browser-refresh', 'browser-home', 'browser-search', 'media-play-pause']) {
      expect(gestureIntent('app-command', name), name).toBeNull()
    }
  })

  it('does not read a swipe direction as a command', () => {
    // The two vocabularies are separate tables on purpose: `left` is not an `app-command`.
    expect(gestureIntent('app-command', 'left')).toBeNull()
  })
})

describe('what a swipe means', () => {
  it('goes back when the page is pushed to the right', () => {
    // The content follows the fingers, so a rightward push uncovers the page to its left — the one
    // you came from. This is the convention every desktop browser uses and the one that reads
    // backwards when written from first principles.
    expect(gestureIntent('swipe', 'right')).toBe('back')
  })

  it('goes forward when the page is pushed to the left', () => {
    expect(gestureIntent('swipe', 'left')).toBe('forward')
  })

  it('leaves vertical swipes to the window manager', () => {
    // macOS uses three-finger up and down for Mission Control and Exposé. A browser that also acted
    // on them would fight the desktop for a gesture aimed at it.
    expect(gestureIntent('swipe', 'up')).toBeNull()
    expect(gestureIntent('swipe', 'down')).toBeNull()
  })

  it('does not read a mouse command as a direction', () => {
    expect(gestureIntent('swipe', 'browser-backward')).toBeNull()
  })

  it('maps every name in both tables to something', () => {
    // So a table entry cannot be added without a meaning, and the two cannot start overlapping.
    for (const [name, intent] of Object.entries(APP_COMMAND_INTENTS)) {
      expect(gestureIntent('app-command', name), name).toBe(intent)
      expect(gestureIntent('swipe', name), name).toBeNull()
    }
    for (const [name, intent] of Object.entries(SWIPE_INTENTS)) {
      expect(gestureIntent('swipe', name), name).toBe(intent)
      expect(gestureIntent('app-command', name), name).toBeNull()
    }
  })
})

describe('which tile the pointer is in', () => {
  it('finds the tile containing the point', () => {
    expect(tileUnderPointer(COLUMNS, { x: 10, y: 500 })).toBe(0)
    expect(tileUnderPointer(COLUMNS, { x: 1400, y: 500 })).toBe(1)
  })

  it('gives no tile for the toolbar above the grid', () => {
    expect(tileUnderPointer(COLUMNS, { x: 10, y: 10 })).toBeNull()
  })

  it('gives no tile for the gutter between two of them', () => {
    // Eight pixels that no view covers. It exists so the divider can be dragged at all.
    const [left] = COLUMNS.slice(0, 1)
    expect(tileUnderPointer(COLUMNS, { x: left!.x + left!.width + 1, y: 500 })).toBeNull()
  })

  it('gives the pixel where two tiles meet to exactly one of them', () => {
    const single = computeTileRects('1x2', {}, CONTENT)
    const [first] = single.slice(0, 1)
    const boundary = first!.x + first!.width
    expect(tileUnderPointer(single, { x: boundary - 1, y: 500 })).toBe(0)
    expect(tileUnderPointer(single, { x: boundary, y: 500 })).toBe(1)
  })

  it('skips a tile a maximised neighbour has collapsed', () => {
    // `tileRects` reports those as null: no rectangle, so nothing can be inside them.
    const collapsed: Array<Rect | null> = [null, COLUMNS[1] ?? null]
    expect(tileUnderPointer(collapsed, { x: 1400, y: 500 })).toBe(1)
    expect(tileUnderPointer(collapsed, { x: 10, y: 500 })).toBeNull()
  })
})

describe('the whole decision', () => {
  it('navigates the tile under the pointer, not the active one', () => {
    /*
      The property that makes these gestures usable in a split layout. The hand is on the mouse over
      the tile being read, which is frequently not the tile that last had focus — and a thumb button
      that navigates the neighbour is indistinguishable from a bug.
    */
    expect(decide('app-command', 'browser-backward', { x: 1400, y: 500 }, 0)).toEqual({
      intent: 'back',
      tileIndex: 1
    })
  })

  it('falls back to the active tile when the pointer is over no tile', () => {
    // The gutter, the toolbar, or a trackpad swipe with the cursor parked outside the window.
    // Refusing here would make the eight-pixel gutter a place where the mouse button does nothing.
    expect(decide('swipe', 'right', { x: 10, y: 10 }, 1)).toEqual({ intent: 'back', tileIndex: 1 })
  })

  it('falls back to the active tile when there is no pointer at all', () => {
    expect(decide('swipe', 'left', null, 1)).toEqual({ intent: 'forward', tileIndex: 1 })
  })

  it('decides nothing for a gesture that means nothing', () => {
    expect(decide('swipe', 'up', { x: 10, y: 500 })).toBeNull()
    expect(decide('app-command', 'browser-refresh', { x: 10, y: 500 })).toBeNull()
  })

  it('answers for every input either side of the table', () => {
    // Both intents, both sources, both tile resolutions: the whole cross product this decides over.
    const cases: Array<[GestureSource, string, 'back' | 'forward']> = [
      ['app-command', 'browser-backward', 'back'],
      ['app-command', 'browser-forward', 'forward'],
      ['swipe', 'right', 'back'],
      ['swipe', 'left', 'forward']
    ]
    for (const [source, name, intent] of cases) {
      expect(decide(source, name, { x: 10, y: 500 }, 1), `${source} ${name}`).toEqual({
        intent,
        tileIndex: 0
      })
    }
  })
})

describe('reading a pointer position off a raw input event', () => {
  it('reads the vertical position of a mouse move', () => {
    expect(mouseMoveY({ type: 'mouseMove', x: 40, y: 3 })).toBe(3)
  })

  it('reads a position at the very top edge', () => {
    // Zero is the interesting value: it is the reveal band, and a falsy-check would drop it.
    expect(mouseMoveY({ type: 'mouseMove', y: 0 })).toBe(0)
  })

  it('ignores the leave event, whose obvious reading makes the bar strobe', () => {
    /*
      Revealing the bar puts the overlay layer under the pointer, inside the page view's bounds, so
      Chromium delivers `mouseLeave` to the page at once. Treated as a departure it hides the bar,
      which uncovers the page, which reports the same position again — the bar would flicker for as
      long as the pointer rested on it.
    */
    expect(mouseMoveY({ type: 'mouseLeave', y: 0 })).toBeNull()
    expect(mouseMoveY({ type: 'mouseEnter', y: 0 })).toBeNull()
  })

  it('ignores every event with no position in it', () => {
    // The same subscription carries the keyboard and the wheel.
    expect(mouseMoveY({ type: 'keyDown' })).toBeNull()
    expect(mouseMoveY({ type: 'mouseWheel' })).toBeNull()
    expect(mouseMoveY({ type: 'mouseMove' })).toBeNull()
  })

  it('refuses a position that is not a usable number', () => {
    expect(mouseMoveY({ type: 'mouseMove', y: Number.NaN })).toBeNull()
    expect(mouseMoveY({ type: 'mouseMove', y: '3' })).toBeNull()
  })

  it('refuses anything that is not an event at all', () => {
    // The payload's declared type promises neither the field nor the object.
    expect(mouseMoveY(null)).toBeNull()
    expect(mouseMoveY(undefined)).toBeNull()
    expect(mouseMoveY('mouseMove')).toBeNull()
    expect(mouseMoveY(7)).toBeNull()
  })
})
