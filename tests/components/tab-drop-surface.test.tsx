import { cleanup, fireEvent, render } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { TabDropSurface } from '../../src/renderer/src/surfaces/TabDropSurface.js'
import type { TabDropPresentation } from '@shared/overlay/surface.js'

/**
 * The drop indicator's report of the pointer, and the one conversion it owns: from the layer's own
 * coordinates, whose origin is the tile area's corner, into the window's, which the core and the strip
 * reason in.
 *
 * It matters most for a drag begun at a tile bar's grip (U10, KTD14). That press began on this layer,
 * so if the platform keeps a held button with the view it was pressed on, this layer goes on hearing the
 * pointer after it has left the tile area for the strip — at a negative `clientY`, over no element of
 * this document. The report has to reach the core anyway, converted, because the strip is placed by that
 * point: a release there is a release from the tiled view, at the place under the point. Listening on the
 * window rather than on the surface's own element is what catches a sample with no element under it.
 */

interface Call {
  channel: string
  payload: unknown
}

function installBridge(): Call[] {
  const calls: Call[] = []
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return Promise.resolve({ ok: true })
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
  return calls
}

/** The tile area starts 88 px down the window: below the tab strip and the toolbar. */
const ORIGIN = { x: 0, y: 88 }

function presentation(): TabDropPresentation {
  return { kind: 'tab-drop', origin: ORIGIN, zones: [], activeZoneId: null, title: 'Example' }
}

afterEach(() => {
  cleanup()
})

describe('the pointer, reported in window coordinates', () => {
  it('adds the layer’s origin to a sample over the tiles', () => {
    const calls = installBridge()
    const { container } = render(<TabDropSurface presentation={presentation()} />)

    fireEvent.pointerMove(container.querySelector('.surface--drop')!, { clientX: 40, clientY: 100 })

    expect(calls).toEqual([{ channel: 'drag:move', payload: { x: 40, y: 188 } }])
  })

  it('reports a sample above the layer, over the strip, as a point above the tile area', () => {
    const calls = installBridge()
    render(<TabDropSurface presentation={presentation()} />)

    // Over the strip, 70 px above the tile area: no element of this document is under it.
    fireEvent.pointerMove(window, { clientX: 250, clientY: -70 })
    fireEvent.pointerUp(window, { clientX: 250, clientY: -70 })

    expect(calls).toEqual([
      { channel: 'drag:move', payload: { x: 250, y: 18 } },
      { channel: 'drag:end', payload: { x: 250, y: 18, commit: true } }
    ])
  })

  it('reports a cancelled drag as one that moves nothing', () => {
    const calls = installBridge()
    render(<TabDropSurface presentation={presentation()} />)

    fireEvent.pointerCancel(window, { clientX: 10, clientY: 10 })

    expect(calls).toEqual([{ channel: 'drag:end', payload: { x: 10, y: 98, commit: false } }])
  })

  it('stops listening once the indicator has gone', () => {
    const calls = installBridge()
    const { unmount } = render(<TabDropSurface presentation={presentation()} />)
    unmount()

    fireEvent.pointerMove(window, { clientX: 10, clientY: 10 })
    fireEvent.pointerUp(window, { clientX: 10, clientY: 10 })

    expect(calls).toEqual([])
  })
})
