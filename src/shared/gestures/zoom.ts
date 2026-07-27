/**
 * Zoom in steps a person recognises, for the gesture that produces a great many of them.
 *
 * ## Why a ladder rather than arithmetic
 *
 * The menu's zoom used `percent ± 10`, which is fine for a key press and wrong for a trackpad: a
 * pinch sends a stream of events, so ten per notch either crawls or overshoots, and it lands on values
 * — 83 %, 117 % — that no browser shows and that make text reflow at sizes nobody chose. The stops
 * below are Chromium's own, which is also what makes "100 %" reachable by pinching rather than
 * something the user has to hit exactly.
 *
 * ## Why both routes share it
 *
 * Because otherwise `Ctrl` and the gesture disagree. Two ladders in one browser means zooming in with
 * the keyboard and out with the trackpad does not return to where it started, and that is the kind of
 * drift nobody reports as a bug and everybody feels.
 *
 * ## What this deliberately does not decide
 *
 * Which tab is zoomed. Unlike the navigation gestures — where the event carries no position and the
 * pointer's tile has to be worked out (see `navigation.ts`) — a zoom gesture arrives as an event on the
 * `webContents` that received it, so the tile is already known and cannot be guessed wrong. And where
 * the value is *stored* is not a gesture's business either: zoom is per domain (spec 1), so the same
 * site in two tiles looks the same in both, and this returns a percentage rather than applying one.
 */

export type ZoomDirection = 'in' | 'out'

/**
 * The stops, ascending.
 *
 * The ends are the clamp `Tab.setZoomPercent` already applies, so the ladder cannot walk out of the
 * range the rest of the browser believes in.
 */
export const ZOOM_STOPS: readonly number[] = [
  30, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300
]

/*
  The ends, as their own literals rather than read off the ladder.

  `ZOOM_STOPS[0]` needs a fallback for the type checker, and a fallback on a non-empty literal three
  lines up is a branch no test can reach — which in this project is not a stylistic matter: the coverage
  gate for this directory is absolute, so an unreachable branch makes the gate unachievable and invites
  somebody to lower it instead. Named here and held to the ladder by a test, the guarantee is stronger
  than the fallback was and there is nothing dead left behind.
*/
const LOWEST_STOP = 30
const HIGHEST_STOP = 300

/**
 * One stop from where it is now, in the direction asked for.
 *
 * `current` is not assumed to be *on* the ladder: the menu spent a long time moving in tens, a stored
 * per-domain value from that period is something like 120, and a page can be at a percentage the user
 * typed. So the answer is the nearest stop *past* the current value in the direction of travel, which
 * makes the first press off-ladder a step rather than a jump backwards.
 *
 * At either end the current value is returned unchanged rather than clamped to the last stop, so a
 * caller can tell "already at the limit" from "moved" without a second comparison.
 */
export function nextZoomPercent(current: number, direction: ZoomDirection): number {
  if (direction === 'in') {
    const above = ZOOM_STOPS.filter((stop) => stop > current)
    const [first] = above.slice(0, 1)
    return first ?? Math.max(current, HIGHEST_STOP)
  }

  const below = ZOOM_STOPS.filter((stop) => stop < current)
  const [last] = below.slice(below.length - 1, below.length)
  return last ?? Math.min(current, LOWEST_STOP)
}
