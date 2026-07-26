import type { Rect } from '../split/layout.js'
import type { Point } from '../split/dropzones.js'

/**
 * Back and forward from the hardware that has its own buttons for it: the two extra buttons on a
 * mouse (Windows and Linux report them as `app-command`) and the trackpad swipe on macOS.
 *
 * ## Why this is a pure function and not a pair of event handlers
 *
 * Both arrive as events on the `BrowserWindow`, and both carry a single string. That makes them
 * look like two lines of wiring, which is exactly how they end up wrong: the mapping from a swipe
 * *direction* to a navigation *direction* is a convention, not a derivation, and the obvious
 * reading of it is backwards. A swipe to the right goes **back** — the page follows your fingers,
 * so pushing the content rightwards uncovers what was to its left, which is where you came from.
 * Written inline in a subscription, that decision is untestable and one negation away from a
 * browser whose gestures both go the wrong way.
 *
 * ## Why the pointer decides which tile, and not the active tile
 *
 * The events say nothing about position, so *something* has to choose the tile. "The active tile"
 * is wrong for the case these gestures exist for: with four pages on screen, the hand is on the
 * mouse over the tile being read, which is frequently not the tile that last had focus — and a
 * thumb button that navigates a different tile from the one under the cursor is indistinguishable
 * from a bug. It also matches what the platform already does with the pointer: Chromium routes
 * wheel and swipe input to the view under the cursor rather than to the focused one, so taking the
 * cursor's tile makes the gesture agree with scrolling in the same window.
 *
 * The active tile stays as the fallback for a pointer that is over no tile at all — the toolbar,
 * the gutter between tiles, or outside the window entirely. Refusing the gesture there would make
 * the eight-pixel gutter a dead zone where the mouse button silently does nothing.
 *
 * Pure and dependency-free, like the geometry it consults.
 */

export type NavigationIntent = 'back' | 'forward'

/** Which event produced the gesture. Kept apart because the two vocabularies do not overlap. */
export type GestureSource = 'app-command' | 'swipe'

export interface GestureDecision {
  intent: NavigationIntent
  /** The tile to navigate; the caller resolves the tab in it and does nothing if there is none. */
  tileIndex: number
}

/**
 * The `app-command` names that mean navigation.
 *
 * Only these two. A mouse can send `browser-refresh`, `browser-home`, `browser-search` and half a
 * dozen media commands, and each of them would be a decision of its own about which tile it
 * applies to and whether the browser should honour it at all — `browser-search`, for instance,
 * would have to open a search page somewhere. Claiming them here for symmetry would be claiming
 * behaviour nobody has specified; they fall through to "no gesture" and stay available.
 */
export const APP_COMMAND_INTENTS: Readonly<Record<string, NavigationIntent>> = {
  'browser-backward': 'back',
  'browser-forward': 'forward'
}

/**
 * Swipe directions that mean navigation, in the platform's own sense of the word.
 *
 * `up` and `down` are absent deliberately: macOS uses vertical three-finger swipes for Mission
 * Control and Exposé, and a browser that also acted on them would fight the window manager for a
 * gesture the user aimed at the desktop.
 */
export const SWIPE_INTENTS: Readonly<Record<string, NavigationIntent>> = {
  right: 'back',
  left: 'forward'
}

/** What a gesture means, or `null` when it means nothing to this browser. */
export function gestureIntent(source: GestureSource, name: string): NavigationIntent | null {
  const table = source === 'app-command' ? APP_COMMAND_INTENTS : SWIPE_INTENTS
  return table[name] ?? null
}

/**
 * The tile containing a point, or `null` when none does.
 *
 * Half-open on the far edges, so the pixel where two tiles meet belongs to exactly one of them.
 * `null` entries are the tiles a maximised neighbour has collapsed — they have no rectangle and
 * cannot contain anything.
 */
export function tileUnderPointer(rects: ReadonlyArray<Rect | null>, point: Point): number | null {
  const index = rects.findIndex(
    (rect) =>
      rect !== null &&
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height
  )
  return index === -1 ? null : index
}

/**
 * The whole decision: what this gesture does, and to which tile.
 *
 * Returns `null` for every input that is not one of the four navigation gestures, so the caller
 * has one branch and no vocabulary of its own.
 */
export function decideNavigationGesture(input: {
  source: GestureSource
  name: string
  /** The cursor in the same coordinate space as `tiles`, or `null` when it is not known. */
  pointer: Point | null
  tiles: ReadonlyArray<Rect | null>
  /** Where the gesture goes when the pointer is over no tile. */
  activeTile: number
}): GestureDecision | null {
  const intent = gestureIntent(input.source, input.name)
  if (intent === null) return null

  const pointed = input.pointer === null ? null : tileUnderPointer(input.tiles, input.pointer)
  return { intent, tileIndex: pointed ?? input.activeTile }
}
