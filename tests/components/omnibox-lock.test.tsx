import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Omnibox } from '@renderer/components/Omnibox.js'
import type { SecurityState, TabState } from '@shared/model.js'

/**
 * The lock in front of the address, which opens the site menu (U19, R33).
 *
 * It used to be a `<span>` with a label: something to look at, reachable by no key and by no screen
 * reader as a control. The menu behind it is native and drawn by the core, so what this can check is the
 * renderer's half — that the lock is a named button in the tab order, and that pressing it and pressing
 * the shield ask for the same menu (KTD13).
 */

const invocations: Array<{ channel: string; payload: unknown }> = []

function installBridge(): void {
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
}

function tab(security: SecurityState, url = 'https://example.com/'): TabState {
  return {
    id: 't1',
    url,
    pendingInput: null,
    title: 'Example',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    muted: false,
    audible: false,
    security,
    blockedRequests: 0,
    zoomPercent: null,
    tileIndex: 0,
    unloaded: false
  }
}

function renderOmnibox(state: TabState): void {
  installBridge()
  render(<Omnibox tab={state} settings={null} privateMode={false} focusRequest={0} />)
}

afterEach(() => {
  cleanup()
})

describe('the lock', () => {
  it.each([
    ['secure', 'Connection is encrypted'],
    ['insecure', 'Connection is not encrypted'],
    ['invalid-certificate', 'Certificate is not valid'],
    ['internal', 'Tessera page']
  ] as const)('is a button named for a %s connection', (security, name) => {
    renderOmnibox(tab(security))
    const lock = screen.getByRole('button', { name })
    expect(lock.tagName).toBe('BUTTON')
    expect(lock.getAttribute('type')).toBe('button')
    expect(lock.getAttribute('aria-haspopup')).toBe('menu')
  })

  it('is reachable from the keyboard', () => {
    renderOmnibox(tab('secure'))
    const lock = screen.getByRole('button', { name: 'Connection is encrypted' })
    // In the tab order: a native button, not disabled and not taken out with a negative index.
    expect(lock.tabIndex).toBe(0)
    expect(lock.hasAttribute('disabled')).toBe(false)
    lock.focus()
    expect(document.activeElement).toBe(lock)
  })

  it('opens the site menu, the same one the shield opens', () => {
    renderOmnibox(tab('secure'))
    fireEvent.click(screen.getByRole('button', { name: 'Connection is encrypted' }))
    fireEvent.click(screen.getByRole('button', { name: 'Content blocker' }))
    expect(invocations.map((call) => call.channel)).toEqual(['site:menu', 'site:menu'])
  })

  it('submits nothing when pressed inside the address form', () => {
    renderOmnibox(tab('insecure', 'http://example.com/'))
    fireEvent.click(screen.getByRole('button', { name: 'Connection is not encrypted' }))
    expect(invocations.map((call) => call.channel)).not.toContain('nav:navigate')
  })
})
