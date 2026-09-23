import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CASCADE_STEP,
  DEFAULT_WINDOW_SIZE,
  MIN_WINDOW_SIZE,
  placeNewWindow,
  samePlacement,
  storablePlacement,
  type WindowBounds,
  type WindowPlacement
} from '@shared/window-placement/model.js'
import { WindowPlacementStore } from '@main/data/WindowPlacementStore.js'

/**
 * Where a new window opens.
 *
 * The failure worth guarding is not "opened at the wrong spot" but "opened where nobody can see it": a
 * stored position from a monitor that is no longer there. Every case below is a way the stored rectangle
 * can have stopped being true.
 */

/** A 1920 × 1080 laptop screen with a 25-pixel menu bar, the primary display. */
const LAPTOP: WindowBounds = { x: 0, y: 25, width: 1920, height: 1055 }
/** A second screen to the right of it. */
const EXTERNAL: WindowBounds = { x: 1920, y: 0, width: 2560, height: 1440 }

function saved(bounds: WindowBounds, maximized = false): WindowPlacement {
  return { bounds, maximized }
}

describe('placing a new window', () => {
  it('opens at the default size, centred, when nothing was stored', () => {
    // No position at all: Electron centres a window it is not given one for.
    expect(placeNewWindow(null, [LAPTOP], [])).toEqual({
      bounds: { ...DEFAULT_WINDOW_SIZE },
      maximized: false
    })
  })

  it('opens exactly where the last window was', () => {
    const last = { x: 200, y: 120, width: 1200, height: 800 }
    expect(placeNewWindow(saved(last), [LAPTOP], [])).toEqual({ bounds: last, maximized: false })
  })

  it('opens maximised when the last window was', () => {
    expect(
      placeNewWindow(saved({ x: 10, y: 40, width: 1000, height: 700 }, true), [LAPTOP], [])
        .maximized
    ).toBe(true)
  })

  it('finds a window on the second screen while that screen is there', () => {
    const last = { x: 2200, y: 100, width: 1600, height: 1000 }
    expect(placeNewWindow(saved(last), [LAPTOP, EXTERNAL], []).bounds).toEqual(last)
  })

  it('brings a window back to the primary screen once the one it was on is gone', () => {
    // The user unplugged the monitor. The size is still theirs; the place no longer exists.
    const last = { x: 2200, y: 100, width: 1600, height: 1000 }
    expect(placeNewWindow(saved(last), [LAPTOP], []).bounds).toEqual({ width: 1600, height: 1000 })
  })

  it('treats a window whose title strip is off screen as unreachable', () => {
    // Most of it would be visible, but the part the user grabs is above the top of the display.
    const last = { x: 100, y: -500, width: 1200, height: 900 }
    expect(placeNewWindow(saved(last), [LAPTOP], []).bounds).not.toHaveProperty('y')
  })

  it('pulls a window that hung over an edge back inside the screen', () => {
    const last = { x: 1500, y: 300, width: 1000, height: 900 }
    expect(placeNewWindow(saved(last), [LAPTOP], []).bounds).toEqual({
      x: 1920 - 1000,
      y: 25 + 1055 - 900,
      width: 1000,
      height: 900
    })
  })

  it('shrinks a window that is larger than the screen it opens on', () => {
    // A 4K-sized window remembered, and the external display gone.
    const last = { x: 0, y: 25, width: 3000, height: 2000 }
    expect(placeNewWindow(saved(last), [LAPTOP], []).bounds).toEqual({
      x: 0,
      y: 25,
      width: 1920,
      height: 1055
    })
  })

  it('fits even the default size to a small screen', () => {
    const small = { x: 0, y: 0, width: 1280, height: 720 }
    expect(placeNewWindow(null, [small], []).bounds).toEqual({ width: 1280, height: 720 })
  })

  it('never makes a window smaller than its own minimum on a screen that has the room', () => {
    const last = { x: 0, y: 25, width: 200, height: 100 }
    expect(placeNewWindow(saved(last), [LAPTOP], []).bounds).toMatchObject({
      width: MIN_WINDOW_SIZE.width,
      height: MIN_WINDOW_SIZE.height
    })
  })

  it('steps a second window off the first, so it is visibly a new one', () => {
    const last = { x: 200, y: 120, width: 1200, height: 800 }
    expect(placeNewWindow(saved(last), [LAPTOP], [last]).bounds).toMatchObject({
      x: 200 + CASCADE_STEP,
      y: 120 + CASCADE_STEP
    })
  })

  it('keeps stepping past every window already on the cascade', () => {
    const last = { x: 200, y: 120, width: 1200, height: 800 }
    const open = [0, 1, 2].map((n) => ({
      ...last,
      x: last.x + n * CASCADE_STEP,
      y: last.y + n * CASCADE_STEP
    }))
    expect(placeNewWindow(saved(last), [LAPTOP], open).bounds).toMatchObject({
      x: 200 + 3 * CASCADE_STEP,
      y: 120 + 3 * CASCADE_STEP
    })
  })

  it('wraps the cascade to the corner of the screen rather than walking off it', () => {
    const last = { x: 1920 - 1000, y: 1080 - 800, width: 1000, height: 800 }
    expect(placeNewWindow(saved(last), [LAPTOP], [last]).bounds).toMatchObject({ x: 0, y: 25 })
  })

  it('still opens a window when no display is reported at all', () => {
    expect(placeNewWindow(null, [], []).bounds).toEqual({ ...DEFAULT_WINDOW_SIZE })
  })
})

describe('what is worth storing', () => {
  it('rounds the fractional pixels of a scaled display', () => {
    expect(storablePlacement({ x: 10.4, y: 20.6, width: 1000.5, height: 700.2 }, false)).toEqual({
      bounds: { x: 10, y: 21, width: 1001, height: 700 },
      maximized: false
    })
  })

  it('refuses a rectangle no window can be put at', () => {
    expect(storablePlacement({ x: Number.NaN, y: 0, width: 800, height: 600 }, false)).toBeNull()
    expect(storablePlacement({ x: 0, y: 0, width: 0, height: 600 }, false)).toBeNull()
  })

  it('tells an unchanged placement from a moved one', () => {
    const a = saved({ x: 1, y: 2, width: 800, height: 600 })
    expect(samePlacement(a, { bounds: { ...a.bounds }, maximized: false })).toBe(true)
    expect(samePlacement(a, { ...a, maximized: true })).toBe(false)
    expect(samePlacement(a, null)).toBe(false)
    expect(samePlacement(null, null)).toBe(true)
  })
})

describe('the placement store', () => {
  async function open(): Promise<{ store: WindowPlacementStore; filePath: string }> {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-placement-'))
    const filePath = join(dir, 'window-placement.json')
    return { store: await WindowPlacementStore.open({ filePath, debounceMs: 0 }), filePath }
  }

  it('remembers the last normal window across a restart', async () => {
    const { store, filePath } = await open()
    const placement = saved({ x: 40, y: 60, width: 1300, height: 850 }, true)
    store.recorderFor('normal').record(placement)
    await store.flush()

    const reopened = await WindowPlacementStore.open({ filePath })
    expect(reopened.last()).toEqual(placement)
  })

  it('writes nothing for a private window', async () => {
    // Read from disk: "a private window leaves no trace" is a statement about the file.
    const { store, filePath } = await open()
    store.recorderFor('private').record(saved({ x: 40, y: 60, width: 1300, height: 850 }))
    await store.flush()
    expect(store.last()).toBeNull()
    if (existsSync(filePath)) {
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toMatchObject({ last: null })
    }
  })

  it('starts from nothing stored when the file holds a rectangle it cannot use', async () => {
    const { filePath } = await open()
    await writeFile(
      filePath,
      JSON.stringify({ version: 1, last: { bounds: { x: 0, y: 0, width: -5 }, maximized: true } })
    )
    const store = await WindowPlacementStore.open({ filePath })
    expect(store.last()).toBeNull()
  })
})
