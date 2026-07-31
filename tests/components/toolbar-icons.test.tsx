import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Toolbar } from '@renderer/components/Toolbar.js'
import type { SplitState, TabState } from '@shared/model.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * What the toolbar's icons draw, where drawing the wrong thing is a wrong statement.
 *
 * Only one button is checked here, and it earns the file. The settings icon was a circle with eight
 * straight rays leaving it — a brightness icon — and it shipped, because nothing about it is wrong in
 * a way a type, a lint rule or a snapshot of the DOM tree can see: the button is a button, its label
 * says Settings, its tooltip names the right key, and the 24 numbers in its `d` attribute are a
 * drawing nobody reads. It was reported as *"das settings icon ist eine sonne?"*, and the question
 * mark is the cost: a reader could not tell whether the browser meant a theme switch.
 *
 * ## What is asserted, and why it is not the path itself
 *
 * Not the coordinates. A test carrying a copy of the `d` attribute fails on every nudge to the tooth
 * depth and says nothing about what the icon *is* — it would have passed happily on the sun.
 *
 * The property asserted is the one that separates the two drawings for real: **a cog is a single
 * closed outline; a sun cannot be.** A ray meets the circle at one point, so eight of them need eight
 * subpaths, and the shape of the whole icon is therefore readable from the number of `M` and `Z`
 * commands without knowing where any of them are. That is a structural fact about a class of drawing
 * rather than a fingerprint of one, so it survives the icon being redrawn and still refuses the icon
 * being replaced by rays.
 */

function installBridge(): void {
  const bridge = {
    invoke: (): Promise<unknown> => Promise.resolve({ ok: true }),
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
}

function tab(): TabState {
  return {
    id: 't1',
    url: 'https://example.com/',
    pendingInput: null,
    title: 'Example',
    faviconUrl: null,
    loading: false,
    canGoBack: true,
    canGoForward: true,
    pinned: false,
    muted: false,
    audible: false,
    security: 'secure',
    blockedRequests: 0,
    zoomPercent: 100,
    tileIndex: 0,
    unloaded: false
  }
}

function split(): SplitState {
  return {
    layout: '1x1',
    fractions: {},
    tileTabIds: ['t1'],
    tileAudio: [],
    activeTile: 0,
    maximizedTile: null,
    fullscreenTile: null,
    escalation: 'none'
  }
}

function renderToolbar(): void {
  installBridge()
  render(
    <Toolbar
      tab={tab()}
      split={split()}
      settings={null}
      privateMode={false}
      layoutMenuOpen={false}
      focusRequest={0}
      onOpenSettings={() => {}}
      onOpenExtensions={() => {}}
      titleWithShortcut={shortcutTitles('win32')}
    />
  )
}

/** Every `d` attribute the named button draws, joined — the button's whole outline geometry. */
function pathDataOf(name: RegExp): string {
  const button = screen.getByRole('button', { name })
  return [...button.querySelectorAll('path')].map((path) => path.getAttribute('d') ?? '').join(' ')
}

const countOf = (value: string, command: RegExp): number => (value.match(command) ?? []).length

afterEach(cleanup)

describe('the settings button draws a cog', () => {
  it('draws one closed outline rather than a bundle of rays', () => {
    renderToolbar()
    const d = pathDataOf(/^Settings/)

    // One `M`, one `Z`: a single closed figure. Eight rays would need eight of the first and none of
    // the second, which is exactly what was there.
    expect(countOf(d, /M/g)).toBe(1)
    expect(countOf(d, /Z/g)).toBe(1)
  })

  it('gives that outline the teeth that make it a cog rather than a disc', () => {
    /*
      A closed outline alone is not enough — `M4 4h12v12H4z` is closed too, and it is the maximize
      button. Six teeth means twelve alternations between tip radius and root radius, so the outline
      has 24 vertices; a circle or a rectangle has at most four. Asserted as a floor rather than an
      exact count so the tooth count can change without this failing, while a disc still cannot pass.
    */
    renderToolbar()
    const d = pathDataOf(/^Settings/)
    expect(countOf(d, /L/g)).toBeGreaterThanOrEqual(12)
  })

  it('keeps the hub, because a cog without one reads as a flower', () => {
    renderToolbar()
    const button = screen.getByRole('button', { name: /^Settings/ })
    expect(button.querySelectorAll('circle')).toHaveLength(1)
  })
})
