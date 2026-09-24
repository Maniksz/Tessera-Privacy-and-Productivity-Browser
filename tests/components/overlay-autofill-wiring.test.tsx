import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OverlaySurface } from '../../src/renderer/src/surfaces/OverlaySurface.js'
import type { AutofillSuggestPresentation, OverlayState } from '@shared/overlay/surface.js'
import { DEFAULT_LOCALE, catalogs } from '@shared/i18n/catalog.js'

/**
 * The one place the account picker is joined to a channel, and the only place it can be checked.
 *
 * `AutofillSuggestSurface` takes three callbacks and imports no bridge, deliberately: it is drawn and
 * walked in its own test without anything on the other end. That leaves exactly one line per answer
 * here, and a mistake in any of them is the shape this project has shipped before — a surface that
 * renders perfectly, reads out perfectly, and does nothing at all. Nothing else in the suite would
 * notice: the core's handler is tested against `AutofillSuggest`, and the surface is tested against
 * its props.
 *
 * So what is pinned below is the join. A choice reaches `passwords:answerSuggestion` carrying the
 * request it was shown for; Unlock reaches the same channel with the verb that raises the prompt; and
 * Escape is the ordinary `overlay:dismiss`, because the picker's *departure* is what discards the fill
 * request and takes the badge's highlight off the page — a fourth verb here would have been a second
 * way to leave both undone.
 *
 * The bridge is replaced rather than mocked at the module level, for the reason the find bar's test
 * gives: `bridge.ts` reads `window.tessera` on every call, which is the seam a sandboxed renderer
 * actually has.
 */

interface Call {
  channel: string
  payload: unknown
}

interface Harness {
  readonly calls: Call[]
  present(state: OverlayState): void
}

function installBridge(): Harness {
  const calls: Call[] = []
  const listeners = new Map<string, (payload: unknown) => void>()
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      // The two the layer reads for itself on mount. Neither is what this file is about, and both
      // have to resolve or the component logs an unhandled rejection over the real assertions.
      if (channel === 'window:getState') return Promise.resolve({ platform: 'linux' })
      if (channel === 'settings:getAll') return Promise.resolve({ 'advanced.customShortcuts': {} })
      return Promise.resolve({ ok: true })
    },
    on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })

  return {
    calls,
    present: (state) => {
      act(() => {
        listeners.get('overlay:presented')?.({ presentation: state })
      })
    }
  }
}

const messages = catalogs[DEFAULT_LOCALE] as Record<string, string>

/** The catalogue's own wording, so a reworded button does not read as a broken one. */
function t(key: string): string {
  return messages[key] ?? key
}

function picker(overrides: Partial<AutofillSuggestPresentation> = {}): AutofillSuggestPresentation {
  return {
    kind: 'autofill-suggest',
    requestId: 'suggest-1',
    tileIndex: 0,
    bounds: { x: 0, y: 0, width: 320, height: 100 },
    content: { state: 'entries', entries: [{ id: 'pw-1', username: 'alice@example.com' }] },
    ...overrides
  }
}

afterEach(cleanup)

describe('the account picker on the overlay layer', () => {
  it('sends a chosen entry to the core with the request it was shown for', async () => {
    const harness = installBridge()
    render(<OverlaySurface />)
    harness.present(picker())

    fireEvent.click(await screen.findByRole('option', { name: 'alice@example.com' }))

    expect(harness.calls).toContainEqual({
      channel: 'passwords:answerSuggestion',
      payload: { requestId: 'suggest-1', action: 'choose', entryId: 'pw-1' }
    })
  })

  it('sends Unlock as its own verb rather than raising a prompt from here', async () => {
    // R9 seen from the renderer's side: this surface asks the core to raise the master-password
    // prompt, and there is no other route to it in the page-facing half of the feature.
    const harness = installBridge()
    render(<OverlaySurface />)
    harness.present(picker({ content: { state: 'locked' } }))

    fireEvent.click(await screen.findByRole('button', { name: t('passwords.unlock') }))

    expect(harness.calls).toContainEqual({
      channel: 'passwords:answerSuggestion',
      payload: { requestId: 'suggest-1', action: 'unlock' }
    })
  })

  it('leaves on Escape as an ordinary dismissal, once', async () => {
    /*
      Once, and that is the assertion worth having. The layer's root has its own window-level Escape
      handler; the surface stops the keystroke so only one dismissal is sent. Two would arrive at a
      layer that is already empty — harmless today, and exactly the sort of thing that stops being
      harmless when something else claims the layer in between.
    */
    const harness = installBridge()
    render(<OverlaySurface />)
    harness.present(picker())

    fireEvent.keyDown(await screen.findByRole('group'), { key: 'Escape' })

    expect(harness.calls.filter((call) => call.channel === 'overlay:dismiss')).toHaveLength(1)
    expect(harness.calls.map((call) => call.channel)).not.toContain('passwords:answerSuggestion')
  })

  it('is drawn without the dismiss-on-click wrapper the menus sit in', async () => {
    /*
      The layer is cut to this list's own rectangle, so a press beside it lands in the *page view* and
      never reaches this renderer. Inside the wrapper, every press on the list's own padding would be
      a miss — and would throw away the picker as the user reached for it.
    */
    const harness = installBridge()
    const { container } = render(<OverlaySurface />)
    harness.present(picker())
    // Its own chunk, fetched the first time a picker is shown (see `OverlaySurface`).
    await screen.findByRole('group')

    expect(container.querySelector('.surface')).toBeNull()
    expect(container.querySelector('.autofill-suggest')).not.toBeNull()
  })
})
