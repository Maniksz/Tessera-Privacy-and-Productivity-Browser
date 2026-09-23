import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DOWNLOADS_PANEL_KIND,
  DownloadsButton,
  isDownloadsPanel,
  useDownloadSummary
} from '@renderer/components/DownloadsButton.js'
import type { DownloadButtonSummary } from '@shared/downloads/summary.js'
import type { OverlayState } from '@shared/overlay/surface.js'

/**
 * The toolbar's download button: when it is there, what it says, and what pressing it does.
 *
 * The button is fed a summary the core computes — numbers and states, never a file name — and it has
 * room for exactly one statement (KTD6): progress while something runs, otherwise the heaviest outcome
 * nobody has looked at yet. What is asserted here is that each of those statements reaches the
 * accessible name as well as the drawing, because a mark only a sighted user can read is half a mark,
 * and that the button opens the panel and gets the focus back when the panel goes.
 */

const calls: Array<{ channel: string; payload?: unknown }> = []
const listeners = new Map<string, (payload: unknown) => void>()

function installBridge(pulled: DownloadButtonSummary = HIDDEN): void {
  calls.length = 0
  listeners.clear()
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return Promise.resolve(channel === 'downloads:summary' ? pulled : { ok: true })
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      calls.push({ channel: `on:${channel}` })
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
}

const HIDDEN: DownloadButtonSummary = { visible: false, activity: null, marker: null }
const summary = (overrides: Partial<DownloadButtonSummary>): DownloadButtonSummary => ({
  visible: true,
  activity: null,
  marker: null,
  ...overrides
})

const theButton = (): HTMLElement => screen.getByRole('button', { name: /^Downloads/ })

afterEach(cleanup)

describe('whether the button is there', () => {
  it('is absent until a download starts, then shows how far it has got (AE1)', () => {
    installBridge()
    const { rerender } = render(<DownloadsButton summary={HIDDEN} open={false} />)
    expect(screen.queryByRole('button', { name: /^Downloads/ })).toBeNull()

    rerender(
      <DownloadsButton
        summary={summary({ activity: { kind: 'fraction', fraction: 0.4 } })}
        open={false}
      />
    )
    const button = theButton()
    expect(button.getAttribute('aria-label')).toBe('Downloads: 40%')
    expect(button.dataset.activity).toBe('fraction')
    // The bar is drawn to the same share the name states, so the two cannot tell different stories.
    const fill = button.querySelector('[data-part="fill"]')
    expect(fill?.getAttribute('stroke-dasharray')).toBe('0.4 1')
  })

  it('never claims a download is finished while it is still running', () => {
    installBridge()
    render(
      <DownloadsButton
        summary={summary({ activity: { kind: 'fraction', fraction: 0.998 } })}
        open={false}
      />
    )
    expect(theButton().getAttribute('aria-label')).toBe('Downloads: 99%')
  })

  it('shows activity without a share when a size is unknown (AE2)', () => {
    installBridge()
    render(
      <DownloadsButton summary={summary({ activity: { kind: 'indeterminate' } })} open={false} />
    )
    const button = theButton()
    expect(button.getAttribute('aria-label')).toBe('Downloads: Downloading')
    expect(button.getAttribute('aria-label')).not.toMatch(/%|\d/)
    expect(button.dataset.activity).toBe('indeterminate')
    // No share to draw, so no fill: a bar stuck at some value would be a number nobody measured.
    expect(button.querySelector('[data-part="fill"]')).toBeNull()
    expect(button.querySelector('[data-part="sweep"]')).not.toBeNull()
  })

  it('stays as a quiet button once everything has been seen', () => {
    installBridge()
    render(<DownloadsButton summary={summary({})} open={false} />)
    const button = theButton()
    expect(button.getAttribute('aria-label')).toBe('Downloads')
    expect(button.dataset.marker).toBeUndefined()
    expect(button.querySelector('[data-part="badge"]')).toBeNull()
  })
})

describe('the marks', () => {
  it('names a failure and opens nothing (AE3)', () => {
    installBridge()
    render(<DownloadsButton summary={summary({ marker: 'failed' })} open={false} />)
    const button = theButton()
    expect(button.getAttribute('aria-label')).toBe('Downloads: Failed')
    expect(button.dataset.marker).toBe('failed')
    // Quiet rather than intrusive: the outcome is on the button, and nothing was asked to appear.
    expect(calls.filter(({ channel }) => channel.startsWith('overlay:'))).toEqual([])
  })

  it('tells failed, paused and finished apart by name and by shape, not by colour alone', () => {
    installBridge()
    const glyphs = new Set<string>()
    const names = new Set<string>()
    for (const marker of ['failed', 'paused', 'completed'] as const) {
      const { unmount } = render(<DownloadsButton summary={summary({ marker })} open={false} />)
      const button = theButton()
      names.add(button.getAttribute('aria-label') ?? '')
      const glyph = button.querySelector('[data-part="glyph"]')
      glyphs.add(glyph?.getAttribute('d') ?? '')
      unmount()
    }
    expect([...names]).toEqual(['Downloads: Failed', 'Downloads: Paused', 'Downloads: Finished'])
    expect(glyphs.size).toBe(3)
    expect(glyphs.has('')).toBe(false)
  })
})

describe('opening and closing the panel', () => {
  it('is a disclosure whose state is whatever the overlay layer says', () => {
    installBridge()
    const { rerender } = render(<DownloadsButton summary={summary({})} open={false} />)
    expect(theButton().getAttribute('aria-expanded')).toBe('false')
    rerender(<DownloadsButton summary={summary({})} open />)
    expect(theButton().getAttribute('aria-expanded')).toBe('true')
  })

  it('reads the downloads panel, and nothing else, as its own', () => {
    const layoutMenu: OverlayState = {
      kind: 'layout-menu',
      anchor: { x: 0, y: 0, width: 32, height: 32 },
      current: '1x1'
    }
    expect(isDownloadsPanel(null)).toBe(false)
    expect(isDownloadsPanel(layoutMenu)).toBe(false)
    const panel: OverlayState = {
      kind: DOWNLOADS_PANEL_KIND,
      anchor: { x: 0, y: 0, width: 32, height: 32 },
      downloads: []
    }
    expect(isDownloadsPanel(panel)).toBe(true)
  })

  it('dismisses the panel when it is already open', () => {
    installBridge()
    render(<DownloadsButton summary={summary({})} open />)
    fireEvent.click(theButton())
    expect(calls).toEqual([{ channel: 'overlay:dismiss', payload: undefined }])
  })

  it('asks the overlay layer for the downloads panel, anchored to the button, when it is closed', () => {
    installBridge()
    render(<DownloadsButton summary={summary({})} open={false} />)
    const button = theButton()
    button.getBoundingClientRect = () => new DOMRect(1200, 44, 32, 28)
    fireEvent.click(button)
    /*
      Kind and anchor, and nothing else. The chrome UI is never sent the list, so it has no rows to
      give — the core puts them in, and `overlay:present` refuses a request that brings its own (KTD2).
    */
    expect(calls).toEqual([
      {
        channel: 'overlay:present',
        payload: { kind: 'downloads-panel', anchor: { x: 1200, y: 44, width: 32, height: 28 } }
      }
    ])
  })

  it('takes the focus back when the panel goes', () => {
    installBridge()
    const { rerender } = render(<DownloadsButton summary={summary({})} open />)
    // The overlay view had the focus; the chrome document is left with nothing focused.
    expect(document.activeElement).toBe(document.body)
    rerender(<DownloadsButton summary={summary({})} open={false} />)
    expect(document.activeElement).toBe(theButton())
  })

  it('does not take the focus from something the user has moved it to', () => {
    installBridge()
    const other = document.createElement('input')
    document.body.append(other)
    const { rerender } = render(<DownloadsButton summary={summary({})} open />)
    other.focus()
    rerender(<DownloadsButton summary={summary({})} open={false} />)
    expect(document.activeElement).toBe(other)
    other.remove()
  })

  it('does not reach for the focus when it was never open', () => {
    installBridge()
    const { rerender } = render(<DownloadsButton summary={summary({})} open={false} />)
    rerender(<DownloadsButton summary={summary({ marker: 'completed' })} open={false} />)
    expect(document.activeElement).toBe(document.body)
  })
})

describe('where the summary comes from', () => {
  function Harness(): React.ReactNode {
    return <DownloadsButton summary={useDownloadSummary()} open={false} />
  }

  it('asks for the summary as it stands before listening for changes', async () => {
    /*
      A chrome UI that mounts or reloads after a download began would otherwise draw nothing until the
      next change, because the push carries changes only — the pairing `window:getState` has with
      `window:stateChanged`.
    */
    installBridge(summary({ activity: { kind: 'fraction', fraction: 0.4 } }))
    render(<Harness />)
    expect(calls.map(({ channel }) => channel)).toEqual([
      'downloads:summary',
      'on:downloads:summaryChanged'
    ])
    expect(
      (await screen.findByRole('button', { name: /^Downloads/ })).getAttribute('aria-label')
    ).toBe('Downloads: 40%')
  })

  it('follows every pushed summary after that, including the one that takes it away', async () => {
    installBridge()
    render(<Harness />)
    await act(async () => {})
    expect(screen.queryByRole('button', { name: /^Downloads/ })).toBeNull()

    act(() => listeners.get('downloads:summaryChanged')?.(summary({ marker: 'failed' })))
    expect(theButton().getAttribute('aria-label')).toBe('Downloads: Failed')

    act(() => listeners.get('downloads:summaryChanged')?.(HIDDEN))
    expect(screen.queryByRole('button', { name: /^Downloads/ })).toBeNull()
  })

  it('stops listening when it goes', async () => {
    installBridge()
    const { unmount } = render(<Harness />)
    await act(async () => {})
    unmount()
    expect(listeners.has('downloads:summaryChanged')).toBe(false)
  })
})

describe('the source', () => {
  it('carries no text literal and no literal accessible name', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/DownloadsButton.tsx'),
      'utf8'
    )
    /*
      Narrower than the architecture tests that hold every component to the same rule, on purpose:
      those let a single word through, and a single word — `>Downloads<` — is exactly what this button
      would be tempted to print. Text between tags on one line, that is not an expression, is refused.
    */
    expect(source).not.toMatch(/aria-label=\{?"/)
    expect(source).not.toMatch(/>[ \t]*[A-Za-z][^<>{}\n]*</)
  })
})
