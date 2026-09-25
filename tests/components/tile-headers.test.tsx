import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TileHeaders } from '@renderer/components/TileHeaders.js'
import { useTileRects } from '@renderer/useTileRects.js'
import type { SplitState, TabState } from '@shared/model.js'
import { tileHeaders, viewRects } from '@shared/split/tile-header.js'
import { TILE_GUTTER, computeTileRects, type Rect } from '@shared/split/layout.js'

/**
 * The header strip above each tile's page (U20, R34).
 *
 * Chrome DOM in the gap the core leaves above each view, so what it shows is asserted here and where
 * it goes is asserted against the core: the view rectangles the renderer derives must be the ones
 * `SplitController` hands `relayout`, to the pixel. This project cannot import the core, so `core()`
 * below is the shared pipeline `SplitController.viewRects` is — and `split-controller.test.ts` pins that
 * the controller answers exactly this, which closes the loop.
 */

const SIZE = { width: 1200, height: 700 }

let observers: Array<() => void> = []

beforeEach(() => {
  observers = []
  class FakeResizeObserver {
    readonly #callback: () => void
    constructor(callback: () => void) {
      this.#callback = callback
      observers.push(callback)
    }
    observe(): void {}
    disconnect(): void {
      observers = observers.filter((callback) => callback !== this.#callback)
    }
  }
  Object.defineProperty(window, 'ResizeObserver', {
    value: FakeResizeObserver,
    configurable: true,
    writable: true
  })
  HTMLElement.prototype.getBoundingClientRect = function (): DOMRect {
    const rect: DOMRect = {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: SIZE.width,
      bottom: SIZE.height,
      ...SIZE,
      toJSON: () => ({})
    }
    return rect
  }
  const bridge = {
    invoke: (): Promise<unknown> => Promise.resolve({ ok: true }),
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
})

afterEach(cleanup)

function tab(id: string, tileIndex: number, overrides: Partial<TabState> = {}): TabState {
  return {
    id,
    url: `https://${id}.example/`,
    pendingInput: null,
    title: `Page ${id}`,
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    muted: false,
    audible: false,
    security: 'secure',
    blockedRequests: 0,
    zoomPercent: null,
    tileIndex,
    unloaded: false,
    ...overrides
  }
}

function split(
  layout: SplitState['layout'],
  tileTabIds: Array<string | null>,
  overrides: Partial<SplitState> = {}
): SplitState {
  return {
    layout,
    fractions: {},
    tileTabIds,
    tileAudio: [],
    activeTile: 0,
    maximizedTile: null,
    fullscreenTile: null,
    escalation: 'none',
    ...overrides
  }
}

/** What the core places the views in for this split, at the content element's size. */
function core(state: SplitState, enabled: boolean): Array<Rect | null> {
  const tiles = computeTileRects(
    state.layout,
    state.fractions,
    { x: 0, y: 0, ...SIZE },
    { gutter: TILE_GUTTER }
  )
  return viewRects(tiles, tileHeaders(enabled, state))
}

const RECTS: Rect[] = [
  { x: 0, y: 0, width: 400, height: 300 },
  { x: 408, y: 0, width: 400, height: 300 }
]

describe('what a header shows', () => {
  it('names the page in its tile, with its icon, in the strip above the view', () => {
    const { container } = render(
      <TileHeaders
        split={split('1x2', ['a', 'b'])}
        tabs={[tab('a', 0, { faviconUrl: 'tessera://favicon?site=a' }), tab('b', 1)]}
        rects={RECTS}
        headers={[true, true]}
      />
    )
    const headers = [...container.querySelectorAll<HTMLElement>('.tile-header')]
    expect(headers.map((header) => header.textContent)).toEqual(['Page a', 'Page b'])
    expect(headers[1]?.style.left).toBe('408px')
    expect(headers[1]?.style.top).toBe('0px')
    expect(headers[1]?.style.height).toBe('28px')
    expect(headers[1]?.style.width).toBe('400px')
    expect(headers[0]?.querySelector('img')?.getAttribute('src')).toBe('tessera://favicon?site=a')
    expect(headers[1]?.querySelector('img')).toBeNull()

    // An icon the cache has not got answers 204; the placeholder square shows instead of a broken glyph.
    const icon = headers[0]!.querySelector('img')!
    fireEvent.error(icon)
    expect(icon.hidden).toBe(true)
  })

  it('marks a muted tab, and only a muted one', () => {
    render(
      <TileHeaders
        split={split('1x2', ['a', 'b'])}
        tabs={[tab('a', 0, { muted: true }), tab('b', 1)]}
        rects={RECTS}
        headers={[true, true]}
      />
    )
    expect(screen.getAllByRole('img', { name: 'Muted' })).toHaveLength(1)
  })

  it('falls back to the untitled label for a page with no title yet', () => {
    const { container } = render(
      <TileHeaders
        split={split('1x2', ['a', null])}
        tabs={[tab('a', 0, { title: '' })]}
        rects={RECTS}
        headers={[true, true]}
      />
    )
    expect(container.querySelector('.tile-header')?.textContent).toBe('Untitled')
  })

  it('draws nothing for an empty tile, a missing tab, a tile without a header or a rectangle', () => {
    const { container } = render(
      <TileHeaders
        split={split('2x2', [null, 'gone', 'c', 'd'])}
        tabs={[tab('c', 2), tab('d', 3)]}
        rects={[...RECTS, { x: 0, y: 308, width: 400, height: 300 }]}
        headers={[true, true, false, true]}
      />
    )
    expect(container.querySelectorAll('.tile-header')).toHaveLength(0)
  })
})

/** What `App` does: one measured element, and the headers drawn from what it measured. */
function Harness({ state, enabled }: { state: SplitState; enabled: boolean }): React.ReactNode {
  const { ref, rects, headers } = useTileRects(state, enabled)
  return (
    <div ref={ref} className="content">
      <TileHeaders
        split={state}
        tabs={state.tileTabIds.flatMap((id, index) => (id === null ? [] : [tab(id, index)]))}
        rects={rects}
        headers={headers}
      />
      <output data-testid="views">{JSON.stringify(viewRects(rects, headers))}</output>
    </div>
  )
}

function renderedViews(): Array<Rect | null> {
  return JSON.parse(screen.getByTestId('views').textContent) as Array<Rect | null>
}

describe('where the renderer puts the headers', () => {
  it('derives the same view rectangles the core places the views in', () => {
    const state = split('2x1', ['a', 'b'], { fractions: { h: 0.4 } })
    render(<Harness state={state} enabled />)

    expect(renderedViews()).toEqual(core(state, true))
    expect(renderedViews()[1]!.y).toBe(Math.round(SIZE.height * 0.4) + 4 + 28)
    expect(document.querySelectorAll('.tile-header')).toHaveLength(2)
  })

  it('shows none for 1x1, then shows them once the window splits', () => {
    /*
      The lesson of the removed active-tile ring: its measurement was installed once, against an
      element that was not there yet, and a split arriving later was never measured. The headers are
      drawn from the one element `App` always renders, so a layout change is enough to bring them.
    */
    const { rerender } = render(<Harness state={split('1x1', ['a'])} enabled />)
    expect(document.querySelectorAll('.tile-header')).toHaveLength(0)

    rerender(<Harness state={split('1x2', ['a', 'b'])} enabled />)
    expect(document.querySelectorAll('.tile-header')).toHaveLength(2)

    // And a resize keeps them where the core puts the views.
    SIZE.width = 1000
    void act(() => observers.forEach((callback) => callback()))
    expect(renderedViews()).toEqual(core(split('1x2', ['a', 'b']), true))
    expect(renderedViews()[1]!.width).toBe(1000 / 2 - 4)
    SIZE.width = 1200
  })

  it('shows none for a maximised tile, and none with the setting off', () => {
    const { rerender } = render(
      <Harness state={split('1x2', ['a', 'b'], { maximizedTile: 0 })} enabled />
    )
    expect(document.querySelectorAll('.tile-header')).toHaveLength(0)

    rerender(<Harness state={split('1x2', ['a', 'b'])} enabled={false} />)
    expect(document.querySelectorAll('.tile-header')).toHaveLength(0)
    expect(renderedViews()).toEqual(
      computeTileRects('1x2', {}, { x: 0, y: 0, ...SIZE }, { gutter: TILE_GUTTER })
    )
  })

  it('has nothing to draw before there is a split or a measurement', () => {
    function Bare(): React.ReactNode {
      const { rects, headers } = useTileRects(null, true)
      return <output data-testid="views">{JSON.stringify([rects, headers])}</output>
    }
    render(<Bare />)
    expect(JSON.parse(screen.getByTestId('views').textContent)).toEqual([[], []])
  })
})
