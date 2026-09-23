/**
 * Where a window was, and where the next one opens.
 *
 * ## What is remembered
 *
 * One placement: the size and position of the normal window the user last moved, resized or focused,
 * and whether it was maximised. That is what a desktop application is expected to do — open where it
 * was left — and it holds whether or not session restore is on. The session file is the wrong home for
 * it for exactly that reason: `planRestore` reads nothing when restore is off, and "the window is the
 * size I left it" is not a promise that should depend on "bring my tabs back".
 *
 * The *normal* bounds are what is stored — the rectangle a maximised window returns to — beside the
 * flag, so a window maximised when it closed comes back maximised and still has a sensible size to
 * un-maximise to. Fullscreen is not remembered at all: a browser that launched into fullscreen would
 * look like it had hung.
 *
 * ## Why every rule lives here
 *
 * Opening a window at a stored rectangle is the easy half. The hard half is the rectangle being wrong
 * now: a monitor unplugged since, a laptop that moved from a desk to a lap, a resolution that went
 * down. A window opened off every screen is not a small defect — the user cannot see it, reach it or
 * close it. So what the stored value is *allowed* to do is decided here, against the displays the
 * caller reports, and can be tested without one.
 *
 * No zod and no Electron in this file, for the reasons `session/model.ts` gives: the renderer imports
 * from `shared`, and the displays arrive as plain rectangles.
 */

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What is stored: see the module docblock for why normal bounds and a flag rather than current bounds. */
export interface WindowPlacement {
  bounds: WindowBounds
  maximized: boolean
}

export interface WindowPlacementDocument {
  version: 1
  /** `null` until a normal window has been placed once. */
  last: WindowPlacement | null
}

/**
 * What a new window is built with.
 *
 * `x` and `y` are absent rather than guessed when there is nowhere trustworthy to put the window:
 * Electron centres a window it is given no position for, on the primary display, and that is the
 * right fallback on every platform.
 */
export interface OpeningPlacement {
  bounds: { x?: number; y?: number; width: number; height: number }
  maximized: boolean
}

/** The size a first window opens at. Fitted to the screen, so a small display does not get 1440 wide. */
export const DEFAULT_WINDOW_SIZE = { width: 1440, height: 900 } as const

/** Below this the toolbar and a split layout stop fitting. `window-options.ts` sets it on the window too. */
export const MIN_WINDOW_SIZE = { width: 720, height: 480 } as const

/**
 * How far a window is moved when another already sits exactly where it would open.
 *
 * Opening a second window on top of the first is indistinguishable from nothing happening, so it is
 * stepped down and right the way every platform's own cascade does it.
 */
export const CASCADE_STEP = 24

/**
 * How much of a window's top edge has to lie on a screen for the stored position to be used.
 *
 * The top edge rather than the area, because the title strip is what the user grabs: a window with
 * most of its body on screen and its title bar above the top of it cannot be moved. The strip is the
 * height of the tab row; the width is enough to take hold of.
 */
const GRAB_STRIP_HEIGHT = 40
const GRAB_STRIP_MIN_WIDTH = 120

export function emptyWindowPlacementDocument(): WindowPlacementDocument {
  return { version: 1, last: null }
}

/**
 * The placement worth storing, or `null` for one that is not.
 *
 * Rounded, because a scaled display reports fractional pixels and the file should not grow decimals.
 * Refused rather than repaired when a value is not a finite number or the size is not positive: a
 * window reporting that is in a state nobody wants reproduced on the next launch.
 */
export function storablePlacement(
  bounds: WindowBounds,
  maximized: boolean
): WindowPlacement | null {
  const values = [bounds.x, bounds.y, bounds.width, bounds.height]
  if (!values.every(Number.isFinite)) return null
  const rounded = {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height)
  }
  if (rounded.width <= 0 || rounded.height <= 0) return null
  return { bounds: rounded, maximized }
}

/** True when the two would write the same file; recording an unchanged placement is a wasted write. */
export function samePlacement(a: WindowPlacement | null, b: WindowPlacement | null): boolean {
  if (a === null || b === null) return a === b
  return (
    a.maximized === b.maximized &&
    a.bounds.x === b.bounds.x &&
    a.bounds.y === b.bounds.y &&
    a.bounds.width === b.bounds.width &&
    a.bounds.height === b.bounds.height
  )
}

/**
 * Where a new window opens.
 *
 * `workAreas` are the displays' usable rectangles — without the menu bar, dock or taskbar — with the
 * **primary display first**, which is the one a window with no usable position is sized for.
 * `occupied` are the bounds of the windows already open, and only their corners matter.
 *
 * In order:
 *
 *   1. **Nothing stored** — the default size, fitted to the primary display, and no position.
 *   2. **Stored, but its title strip is on no screen** — the stored size fitted to the primary display,
 *      and no position. The size is still the user's; only the place has stopped existing.
 *   3. **Stored and reachable** — the stored rectangle, shrunk to fit the display it is mostly on and
 *      pushed inside it. A window that hung a little off the edge comes back whole.
 *   4. In the third case, **stepped** past any window already sitting at that corner, so a second window
 *      is visibly a second window. Stepping wraps to the display's corner rather than walking off it.
 *      The first two give no position to step from; the window is centred instead.
 *
 * `maximized` travels unchanged: it is the user's choice, and the size under it is fitted anyway.
 */
export function placeNewWindow(
  saved: WindowPlacement | null,
  workAreas: readonly WindowBounds[],
  occupied: readonly WindowBounds[]
): OpeningPlacement {
  const primary = workAreas[0]
  const maximized = saved?.maximized ?? false
  const wanted = saved?.bounds ?? null

  if (primary === undefined) {
    // No display reported. Nothing to fit against, so the stored size — or the default — as it is.
    return {
      bounds: {
        width: wanted?.width ?? DEFAULT_WINDOW_SIZE.width,
        height: wanted?.height ?? DEFAULT_WINDOW_SIZE.height
      },
      maximized
    }
  }

  if (wanted === null) {
    return { bounds: fitSize(DEFAULT_WINDOW_SIZE, primary), maximized }
  }

  const display = displayHolding(wanted, workAreas)
  if (display === null) {
    return { bounds: fitSize(wanted, primary), maximized }
  }

  const size = fitSize(wanted, display)
  const placed = cascade(
    {
      x: clamp(wanted.x, display.x, display.x + display.width - size.width),
      y: clamp(wanted.y, display.y, display.y + display.height - size.height),
      ...size
    },
    display,
    occupied
  )
  return { bounds: placed, maximized }
}

/**
 * The display a window belongs to: the one its title strip overlaps most, or `null` for none it can
 * be grabbed on. See `GRAB_STRIP_HEIGHT`.
 */
function displayHolding(
  bounds: WindowBounds,
  workAreas: readonly WindowBounds[]
): WindowBounds | null {
  const strip: WindowBounds = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: Math.min(GRAB_STRIP_HEIGHT, bounds.height)
  }
  let best: WindowBounds | null = null
  let bestWidth = 0
  for (const area of workAreas) {
    const overlap = intersection(strip, area)
    if (overlap === null || overlap.width < Math.min(GRAB_STRIP_MIN_WIDTH, bounds.width)) continue
    if (overlap.width > bestWidth) {
      best = area
      bestWidth = overlap.width
    }
  }
  return best
}

/**
 * A size that fits the work area and is not below the window's own minimum.
 *
 * The minimum loses to the display when the two disagree: on a screen smaller than 720 × 480 the
 * window is as large as the screen, not larger than it.
 */
function fitSize(
  size: { width: number; height: number },
  area: WindowBounds
): { width: number; height: number } {
  return {
    width: Math.min(Math.max(size.width, MIN_WINDOW_SIZE.width), area.width),
    height: Math.min(Math.max(size.height, MIN_WINDOW_SIZE.height), area.height)
  }
}

/**
 * Steps a window past every open window sitting at the same corner.
 *
 * Bounded by the number of windows open, which is the most steps that can ever be needed — each step
 * clears at least one of them or wraps. The bound is also what keeps a display too small to step on
 * from turning this into a loop.
 */
function cascade(
  bounds: WindowBounds,
  area: WindowBounds,
  occupied: readonly WindowBounds[]
): WindowBounds {
  let { x, y } = bounds
  for (let step = 0; step <= occupied.length; step += 1) {
    if (!occupied.some((other) => other.x === x && other.y === y)) break
    x += CASCADE_STEP
    y += CASCADE_STEP
    if (x + bounds.width > area.x + area.width || y + bounds.height > area.y + area.height) {
      x = area.x
      y = area.y
    }
  }
  return { ...bounds, x, y }
}

function intersection(a: WindowBounds, b: WindowBounds): WindowBounds | null {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.width, b.x + b.width)
  const bottom = Math.min(a.y + a.height, b.y + b.height)
  if (right <= x || bottom <= y) return null
  return { x, y, width: right - x, height: bottom - y }
}

/** `value` held inside `[min, max]`; `min` wins when the range is empty, so the window's corner stays on screen. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max))
}
