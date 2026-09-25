import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import {
  NavigationRequestSurface,
  shortAddress
} from '../../src/renderer/src/surfaces/NavigationRequestSurface.js'
import type { NavigationRequestPresentation } from '@shared/overlay/surface.js'
import { DEFAULT_LOCALE, catalogs, interpolate } from '@shared/i18n/catalog.js'

/**
 * The popup-or-redirect dialogue, with an address of the length tracking parameters make ordinary.
 *
 * Shown whole, such an address pushed the dialogue's buttons off the bottom of the window, so it is shown cut
 * after its host with a button for the rest. Two things about that can only be checked rendered: that the cut
 * never reaches into the host, which is what the answer turns on, and that the buttons are still there and
 * still answer with the whole address on screen. That the whole address scrolls in its own box is the
 * stylesheet's (`.prompt__site--full`); here it is the class being applied.
 *
 * The bridge is replaced rather than mocked at the module level, for the reason the find bar's test gives:
 * `bridge.ts` reads `window.tessera` on every call.
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
  Object.defineProperty(window, 'tessera', {
    value: bridge,
    configurable: true,
    writable: true
  })
  return calls
}

const messages = catalogs[DEFAULT_LOCALE] as Record<string, string>

function label(key: string, params?: Record<string, string>): string {
  return interpolate(messages[key] ?? key, params)
}

const HOST = 'shop.example.com'
const LONG = `https://${HOST}/checkout/confirm?${Array.from({ length: 40 }, (_, i) => `utm_p${i}=abcdef`).join('&')}`

function presentation(
  overrides: Partial<NavigationRequestPresentation> = {}
): NavigationRequestPresentation {
  return {
    kind: 'navigation-request',
    requestId: 'nav-1',
    navigationKind: 'navigation',
    url: LONG,
    host: HOST,
    ...overrides
  }
}

function address(): HTMLElement {
  const element = document.getElementById('navigation-url')
  if (element === null) throw new Error('no address on screen')
  return element
}

function answers(calls: readonly Call[]): unknown[] {
  return calls.filter((call) => call.channel === 'navigation:answer').map((call) => call.payload)
}

afterEach(() => {
  cleanup()
})

describe('shortAddress', () => {
  it('leaves an address that fits alone', () => {
    expect(shortAddress(`https://${HOST}/`)).toBeNull()
    expect(shortAddress(`https://${HOST}/`.padEnd(120, 'x'))).toBeNull()
  })

  it('keeps the start of a long address', () => {
    const cut = shortAddress(LONG)
    expect(cut).toBe(LONG.slice(0, 100))
  })

  it('never cuts inside the host, however long the host is', () => {
    const host = `${'sub.'.repeat(40)}example.com:8443`
    const url = `https://user@${host}/path?${'q=1&'.repeat(20)}`
    expect(shortAddress(url)).toBe(`https://user@${host}`)
    // An address that is nothing but its host has nothing left to cut.
    expect(shortAddress(`https://${host}`)).toBeNull()
  })

  it('cuts an address without a host at the ordinary length', () => {
    const url = `data:text/html,${'<p>http://x</p>'.repeat(30)}`
    expect(shortAddress(url)).toBe(url.slice(0, 100))
  })
})

describe('a long address', () => {
  it('is shown cut, with its host whole, and the buttons are there', () => {
    installBridge()
    render(<NavigationRequestSurface presentation={presentation()} />)

    const shown = address().textContent
    expect(shown).toBe(`${LONG.slice(0, 100)}…`)
    expect(shown.startsWith(`https://${HOST}/`)).toBe(true)
    expect(screen.getByRole('heading').textContent).toBe(
      label('navigation.wantsToLeave', { host: HOST })
    )
    expect(screen.getByRole('button', { name: label('navigation.stay') })).toBeTruthy()
    expect(screen.getByRole('button', { name: label('navigation.follow') })).toBeTruthy()
  })

  it('opens and closes on the toggle, with focus starting on the refusing button', () => {
    installBridge()
    render(<NavigationRequestSurface presentation={presentation()} />)
    const stay = screen.getByRole('button', { name: label('navigation.stay') })
    expect(document.activeElement).toBe(stay)

    const more = screen.getByRole('button', { name: label('navigation.fullAddress') })
    expect(more.getAttribute('aria-expanded')).toBe('false')
    expect(more.getAttribute('aria-controls')).toBe('navigation-url')
    fireEvent.click(more)

    expect(address().textContent).toBe(LONG)
    expect(address().classList.contains('prompt__site--full')).toBe(true)
    const less = screen.getByRole('button', { name: label('navigation.lessAddress') })
    expect(less.getAttribute('aria-expanded')).toBe('true')

    fireEvent.click(less)
    expect(address().textContent).toBe(`${LONG.slice(0, 100)}…`)
    expect(address().classList.contains('prompt__site--full')).toBe(false)
  })

  it('can still be answered either way with the whole address on screen', () => {
    const calls = installBridge()
    render(<NavigationRequestSurface presentation={presentation()} />)
    fireEvent.click(screen.getByRole('button', { name: label('navigation.fullAddress') }))

    fireEvent.click(screen.getByRole('button', { name: label('navigation.follow') }))
    fireEvent.click(screen.getByRole('button', { name: label('navigation.stay') }))
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(answers(calls)).toEqual([
      { requestId: 'nav-1', permitted: true },
      { requestId: 'nav-1', permitted: false },
      { requestId: 'nav-1', permitted: false }
    ])
  })

  it('takes the toggle into the focus trap after the two answers', () => {
    installBridge()
    render(<NavigationRequestSurface presentation={presentation()} />)
    const more = screen.getByRole('button', { name: label('navigation.fullAddress') })
    const stay = screen.getByRole('button', { name: label('navigation.stay') })
    const follow = screen.getByRole('button', { name: label('navigation.follow') })

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(follow)
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(more)
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement).toBe(stay)
  })

  it('starts cut again for the next question', () => {
    installBridge()
    const { rerender } = render(<NavigationRequestSurface presentation={presentation()} />)
    fireEvent.click(screen.getByRole('button', { name: label('navigation.fullAddress') }))
    expect(address().textContent).toBe(LONG)

    rerender(<NavigationRequestSurface presentation={presentation({ requestId: 'nav-2' })} />)
    expect(address().textContent).toBe(`${LONG.slice(0, 100)}…`)
  })

  it('names the cut address in the title when there is no host to name', () => {
    installBridge()
    const url = `data:text/html,${'<p>x</p>'.repeat(40)}`
    render(
      <NavigationRequestSurface
        presentation={presentation({ navigationKind: 'popup', url, host: '' })}
      />
    )

    expect(screen.getByRole('heading').textContent).toBe(
      label('navigation.wantsToOpen', { host: `${url.slice(0, 100)}…` })
    )
  })
})

describe('a short address', () => {
  it('is shown whole, with no toggle', () => {
    installBridge()
    const url = `https://${HOST}/cart`
    render(<NavigationRequestSurface presentation={presentation({ url })} />)

    expect(address().textContent).toBe(url)
    expect(screen.queryByRole('button', { name: label('navigation.fullAddress') })).toBeNull()
    expect(screen.getAllByRole('button')).toHaveLength(2)
  })
})
