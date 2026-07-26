import { describe, expect, it } from 'vitest'
import { chromeWindowOptions } from '@main/browser/window-options.js'

/**
 * How a browser window is built.
 *
 * These invariants sat inside a constructor until now, which meant nothing checked them: every one is
 * a requirement that could be undone by an edit that still compiles and still opens a window.
 */

const base = {
  privateMode: false,
  platform: 'linux' as const,
  preload: '/app/out/preload/index.cjs',
  roleArgument: '--tessera-role=chrome'
}

describe('the renderer a window hosts', () => {
  it('is sandboxed, isolated and has no Node', () => {
    // Spec 6. The chrome UI is trusted, which is exactly why its process must not be: a bug in it
    // would otherwise be a bug with filesystem access.
    const { webPreferences } = chromeWindowOptions(base)
    expect(webPreferences?.sandbox).toBe(true)
    expect(webPreferences?.contextIsolation).toBe(true)
    expect(webPreferences?.nodeIntegration).toBe(false)
  })

  it('is never throttled', () => {
    // The chrome UI is always visible. Throttled, the toolbar would feel dead while the user works
    // in a tab — and it would look like slowness rather than like a setting.
    expect(chromeWindowOptions(base).webPreferences?.backgroundThrottling).toBe(false)
  })

  it('carries the role argument the preload reads', () => {
    /*
      The role decides whether the full bridge is exposed. It is passed as a process argument rather
      than inferred from the URL because page content cannot influence an argument — a dev server or a
      crafted address can make a URL ambiguous.
    */
    expect(chromeWindowOptions(base).webPreferences?.additionalArguments).toEqual([
      '--tessera-role=chrome'
    ])
  })

  it('loads the preload it was given rather than resolving one itself', () => {
    expect(chromeWindowOptions(base).webPreferences?.preload).toBe('/app/out/preload/index.cjs')
  })
})

describe('telling a private window apart', () => {
  it('gives it a different background colour', () => {
    // Spec 4: the two must never be confused. The colour is the only cue present before anything has
    // rendered, which is when a mistaken window is most likely to be typed into.
    const normal = chromeWindowOptions(base)
    const priv = chromeWindowOptions({ ...base, privateMode: true })
    expect(priv.backgroundColor).not.toBe(normal.backgroundColor)
  })

  it('carries the same colour into the title-bar overlay, so the window is one colour', () => {
    // Two different colours in one window frame reads as a rendering fault rather than as a mode.
    const priv = chromeWindowOptions({ ...base, privateMode: true, platform: 'win32' })
    expect(priv.titleBarOverlay).toMatchObject({ color: priv.backgroundColor })
  })
})

describe('window controls per platform', () => {
  it('positions the traffic lights on macOS and nowhere else', () => {
    // Spec 10: each platform's own corner. `trafficLightPosition` on Linux or Windows is meaningless,
    // and a `titleBarOverlay` on macOS is ignored — so setting either everywhere hides which one is
    // actually doing the work.
    expect(chromeWindowOptions({ ...base, platform: 'darwin' }).trafficLightPosition).toEqual({
      x: 14,
      y: 15
    })
    for (const platform of ['linux', 'win32'] as const) {
      expect(chromeWindowOptions({ ...base, platform }).trafficLightPosition, platform).toBeUndefined()
    }
  })

  it('sets the title-bar overlay off macOS and nowhere else', () => {
    expect(chromeWindowOptions({ ...base, platform: 'darwin' }).titleBarOverlay).toBeUndefined()
    for (const platform of ['linux', 'win32'] as const) {
      expect(chromeWindowOptions({ ...base, platform }).titleBarOverlay, platform).toBeDefined()
    }
  })

  it('hides the title bar but keeps real OS controls on every platform', () => {
    // Not frameless. A browser that draws its own close button gets it subtly wrong on all three
    // platforms at once, and the chrome UI reserves space for the real ones instead.
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      expect(chromeWindowOptions({ ...base, platform }).titleBarStyle, platform).toBe('hidden')
    }
  })
})

describe('the first frame', () => {
  it('does not show the window until something has painted', () => {
    // `show: false` plus `did-finish-load`. Without it the first thing the user sees is an empty
    // rectangle in the OS's default colour, which reads as a slow launch.
    expect(chromeWindowOptions(base).show).toBe(false)
  })

  it('is usable at a small size', () => {
    // A minimum small enough for a side-by-side window on a laptop, and large enough that the split
    // layouts still have room: two tiles at 720 px are 360 px each.
    const options = chromeWindowOptions(base)
    expect(options.minWidth).toBeLessThanOrEqual(720)
    expect(options.minHeight).toBeLessThanOrEqual(480)
    expect(options.width).toBeGreaterThan(options.minWidth ?? 0)
  })
})
