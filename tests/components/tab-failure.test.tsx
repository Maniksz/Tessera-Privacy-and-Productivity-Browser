import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { TabFailure, TileFailures } from '@renderer/components/TabFailure.js'
import type { TabFailure as Failure } from '@shared/browser/tab-failure.js'
import type { SplitState, TabState } from '@shared/model.js'
import { PRODUCT_NAME } from '@shared/product.js'

/**
 * The failure panel a tile draws over its hidden view (U9).
 *
 * What is asserted is what the user can do from it: reload always, and "open anyway" only where it
 * would actually let the page through — the blocker's per-site exemption.
 */

const invocations: Array<{ channel: string; payload: unknown }> = []

beforeEach(() => {
  invocations.length = 0
  const bridge = {
    invoke: (channel: string, payload: unknown): Promise<unknown> => {
      invocations.push({ channel, payload })
      return Promise.resolve({ ok: true })
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
})

afterEach(cleanup)

const failure = (overrides: Partial<Failure> = {}): Failure => ({
  kind: 'network',
  code: -105,
  host: 'example.com',
  ...overrides
})

function tab(id: string, tileIndex: number, failed?: Failure): TabState {
  return {
    id,
    url: `https://${id}.example/`,
    pendingInput: null,
    title: id,
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
    ...(failed === undefined ? {} : { failure: failed })
  }
}

function split(tileTabIds: Array<string | null>, maximizedTile: number | null = null): SplitState {
  return {
    layout: tileTabIds.length === 1 ? '1x1' : '1x2',
    fractions: {},
    tileTabIds,
    tileAudio: [],
    activeTile: 0,
    maximizedTile,
    fullscreenTile: null,
    escalation: 'none'
  }
}

const rects = [
  { x: 0, y: 0, width: 400, height: 300 },
  { x: 404, y: 0, width: 400, height: 300 }
]

describe('TabFailure', () => {
  it('says why, in the existing wording, and names the code', () => {
    render(<TabFailure tabId="t1" failure={failure()} exemptSites={[]} />)
    expect(screen.getByRole('alert').textContent).toContain(
      'Could not find the server for example.com.'
    )
    expect(screen.getByText('-105')).toBeTruthy()
  })

  it('reloads the same tab', () => {
    render(<TabFailure tabId="t1" failure={failure()} exemptSites={[]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(invocations).toEqual([{ channel: 'nav:reload', payload: { tabId: 't1' } }])
  })

  it('offers "open anyway" for the blocker, through the per-site exemption, then reloads', async () => {
    render(
      <TabFailure
        tabId="t1"
        failure={failure({ kind: 'blocked', code: -20, source: 'blocker' })}
        exemptSites={['other.example']}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain(`${PRODUCT_NAME} blocked this request.`)
    fireEvent.click(screen.getByRole('button', { name: 'Open anyway' }))
    await waitFor(() => expect(invocations).toHaveLength(2))
    expect(invocations).toEqual([
      {
        channel: 'settings:set',
        payload: { key: 'privacy.blockerOffForSites', value: ['other.example', 'example.com'] }
      },
      { channel: 'nav:reload', payload: { tabId: 't1' } }
    ])
  })

  it('only reloads when the site is already exempt', async () => {
    render(
      <TabFailure
        tabId="t1"
        failure={failure({ kind: 'blocked', code: -20, source: 'blocker' })}
        exemptSites={['example.com']}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open anyway' }))
    await waitFor(() => expect(invocations).toHaveLength(1))
    expect(invocations[0]?.channel).toBe('nav:reload')
  })

  it.each(['telemetry', 'killSwitch', 'redirect'] as const)(
    'offers no way through for %s',
    (source) => {
      render(
        <TabFailure
          tabId="t1"
          failure={failure({ kind: 'blocked', code: -20, source })}
          exemptSites={[]}
        />
      )
      expect(screen.queryByRole('button', { name: 'Open anyway' })).toBeNull()
      expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    }
  )

  it('takes a page the kill switch stopped to the network settings, in a new tab (U13)', async () => {
    render(
      <TabFailure
        tabId="t1"
        failure={failure({ kind: 'blocked', code: -20, source: 'killSwitch' })}
        exemptSites={[]}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain(
      'The kill switch stopped this page: the system setting allows a direct route.'
    )
    fireEvent.click(screen.getByRole('button', { name: 'Network settings' }))
    await waitFor(() => expect(invocations).toHaveLength(1))
    expect(invocations[0]).toEqual({
      channel: 'tabs:create',
      payload: { url: 'tessera://settings?q=network.' }
    })
  })

  it('offers no network settings for any other failure', () => {
    render(
      <TabFailure
        tabId="t1"
        failure={failure({ kind: 'blocked', code: -20, source: 'blocker' })}
        exemptSites={[]}
      />
    )
    expect(screen.queryByRole('button', { name: 'Network settings' })).toBeNull()
  })

  it('offers no way past a rejected certificate', () => {
    render(
      <TabFailure
        tabId="t1"
        failure={failure({ kind: 'certificate', code: -202 })}
        exemptSites={[]}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain(
      'The certificate for example.com could not be verified.'
    )
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })
})

describe('TileFailures', () => {
  const crashed = failure({ kind: 'crashed', code: 11 })

  it('draws one panel per failed tile, each in its own rectangle', () => {
    const { container } = render(
      <TileFailures
        split={split(['a', 'b'])}
        tabs={[tab('a', 0, crashed), tab('b', 1, crashed)]}
        rects={rects}
        exemptSites={[]}
      />
    )
    expect(screen.getAllByRole('alert')).toHaveLength(2)
    const tiles = [...container.querySelectorAll<HTMLElement>('.content__tile')]
    expect(tiles.map((tile) => tile.dataset.tileIndex)).toEqual(['0', '1'])
    expect(tiles[1]?.style.left).toBe('404px')
    expect(screen.getAllByText('This page stopped working.')).toHaveLength(2)
  })

  it('draws nothing over a healthy tile, an empty one, or before the tiles are measured', () => {
    const { rerender } = render(
      <TileFailures
        split={split(['a', null])}
        tabs={[tab('a', 0)]}
        rects={rects}
        exemptSites={[]}
      />
    )
    expect(screen.queryByRole('alert')).toBeNull()
    rerender(
      <TileFailures
        split={split(['a', 'gone'])}
        tabs={[tab('a', 0, crashed)]}
        rects={[]}
        exemptSites={[]}
      />
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('covers the whole area for a maximised tile and nothing for the ones behind it', () => {
    const { container } = render(
      <TileFailures
        split={split(['a', 'b'], 1)}
        tabs={[tab('a', 0, crashed), tab('b', 1, crashed)]}
        rects={rects}
        exemptSites={[]}
      />
    )
    const tiles = [...container.querySelectorAll<HTMLElement>('.content__tile')]
    expect(tiles).toHaveLength(1)
    expect(tiles[0]?.dataset.tileIndex).toBe('1')
    expect(tiles[0]?.style.left).toBe('')
  })

  it('draws in the view rectangle below a tile header, where the core hid the view (U20)', () => {
    const { container } = render(
      <TileFailures
        split={split(['a', 'b'])}
        tabs={[tab('a', 0, crashed), tab('b', 1)]}
        rects={rects}
        headers={[true, true]}
        exemptSites={[]}
      />
    )
    const [panel] = [...container.querySelectorAll<HTMLElement>('.content__tile')]
    const tile = rects[0]!
    expect(panel?.style.top).toBe(`${tile.y + 28}px`)
    expect(panel?.style.height).toBe(`${tile.height - 28}px`)
  })
})
