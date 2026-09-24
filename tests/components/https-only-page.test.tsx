import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONTINUE_DELAY_MS, HttpsOnlyPage } from '@renderer-internal/HttpsOnlyPage.js'
import { BACK_URL, continueUrl, interstitialUrl } from '@shared/privacy/https-token.js'

/**
 * `tessera://https-only`, the page HTTPS-only mode sends a top-level `http://` navigation to (R7, AE1).
 *
 * Rendered against a stubbed `location` and `history`, because every way off the page is a navigation and
 * the navigation is what is asserted: which address each button replaces the page with, and that the token
 * leaves the visible address. Whether the core then honours "Continue" is `tests/https-exemptions.test.ts`.
 */

const TOKEN = 'k'.repeat(43)

interface Stubs {
  replace: ReturnType<typeof vi.fn>
  replaceState: ReturnType<typeof vi.fn>
}

function open(address: string, language = 'en-US'): Stubs {
  const replace = vi.fn()
  const replaceState = vi.fn()
  const parsed = new URL(address)
  vi.stubGlobal('location', { href: address, search: parsed.search, replace })
  vi.stubGlobal('history', { state: null, replaceState })
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true })
  render(<HttpsOnlyPage />)
  return { replace, replaceState }
}

const button = (name: string): HTMLButtonElement => screen.getByRole('button', { name })
const buttonNames = (): string[] => screen.queryAllByRole('button').map((b) => b.textContent)

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('what the interstitial offers', () => {
  it('names the host and offers all three ways when the core sent the page here', () => {
    open(interstitialUrl('http://bank.example/pfad', TOKEN, 'en'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'bank.example does not offer an encrypted connection.'
    )
    expect(buttonNames()).toEqual(['Try HTTPS', 'Continue unencrypted', 'Go back'])
    expect(document.title).toBe('bank.example does not offer an encrypted connection.')
  })

  it('offers no way to continue when the address carries no token (AE1)', () => {
    // `evil.example` answered with `302 Location: tessera://https-only?target=http://bank.example`.
    open('tessera://https-only?target=http://bank.example')
    expect(buttonNames()).toEqual(['Try HTTPS', 'Go back'])
  })

  it('offers no way to continue for a token the core could not have minted', () => {
    open(interstitialUrl('http://bank.example/', 'forged', 'en'))
    expect(buttonNames()).toEqual(['Try HTTPS', 'Go back'])
  })

  it('takes no target that is not plain http', () => {
    for (const target of ['javascript:alert(1)', 'https://bank.example/']) {
      open(interstitialUrl(target, TOKEN, 'en'))
      expect(screen.getByRole('heading', { level: 1 }).textContent, target).toBe(
        'This page was opened without an address to go to.'
      )
      expect(buttonNames(), target).toEqual(['Go back'])
      cleanup()
    }
  })

  it('shows a Cyrillic look-alike of paypal.com as Punycode', () => {
    open(interstitialUrl('http://xn--pypal-4ve.com/', TOKEN, 'en'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'xn--pypal-4ve.com does not offer an encrypted connection.'
    )
  })

  it('shows a name of one script in that script, with its port', () => {
    open(interstitialUrl('http://xn--mnchen-3ya.de:8080/', TOKEN, 'en'))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(
      'münchen.de:8080 does not offer an encrypted connection.'
    )
  })
})

describe('the ways off it', () => {
  it('replaces the page with the same address over HTTPS', () => {
    const { replace } = open(interstitialUrl('http://bank.example:8080/pfad?x=1', TOKEN, 'en'))
    expect(document.activeElement, 'the safe choice has the focus').toBe(button('Try HTTPS'))
    fireEvent.click(button('Try HTTPS'))
    expect(replace).toHaveBeenCalledWith('https://bank.example:8080/pfad?x=1')
  })

  it('enables "Continue" only after a second, and then asks the core with the token', () => {
    vi.useFakeTimers()
    const { replace } = open(interstitialUrl('http://bank.example/', TOKEN, 'en'))
    const proceed = button('Continue unencrypted')
    expect(proceed.disabled).toBe(true)
    fireEvent.click(proceed)
    expect(replace).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(CONTINUE_DELAY_MS - 1)
    })
    expect(proceed.disabled).toBe(true)
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(proceed.disabled).toBe(false)

    fireEvent.click(proceed)
    expect(replace).toHaveBeenCalledWith(continueUrl(TOKEN))
  })

  it('asks the core to go back, which alone can open the start page', () => {
    const { replace } = open('tessera://https-only?target=http://bank.example')
    fireEvent.click(button('Go back'))
    expect(replace).toHaveBeenCalledWith(BACK_URL)
  })

  it('takes the token out of the visible address, and keeps the rest', () => {
    const { replaceState } = open(interstitialUrl('http://bank.example/', TOKEN, 'de'))
    expect(replaceState).toHaveBeenCalledTimes(1)
    const shown = new URL(String(replaceState.mock.calls[0]![2]))
    expect(shown.searchParams.has('t')).toBe(false)
    expect(shown.searchParams.get('target')).toBe('http://bank.example/')
    expect(shown.searchParams.get('lang')).toBe('de')
  })

  it('leaves an address with no token alone', () => {
    const { replaceState } = open('tessera://https-only?target=http://bank.example')
    expect(replaceState).not.toHaveBeenCalled()
  })
})

describe('the language', () => {
  it('follows the `lang` the core put in the address over a masked navigator.language', () => {
    open(interstitialUrl('http://bank.example/', TOKEN, 'de'), 'en-US')
    expect(buttonNames()).toEqual(['Über HTTPS versuchen', 'Unverschlüsselt fortfahren', 'Zurück'])
    expect(document.documentElement.lang).toBe('de')
  })

  it('ignores a `lang` it has no catalogue for', () => {
    open('tessera://https-only?target=http://bank.example&lang=fr', 'de-DE')
    expect(document.documentElement.lang).toBe('de')
  })
})

describe('what the page is built from', () => {
  const html = readFileSync(join(process.cwd(), 'src/renderer/internal/https-only.html'), 'utf8')
  const sources = ['https-only.tsx', 'HttpsOnlyPage.tsx', 'bundled-i18n.ts'].map((file) =>
    readFileSync(join(process.cwd(), 'src/renderer/internal', file), 'utf8')
  )

  it('allows no remote origin, no connection, no framing and no referrer', () => {
    expect(html).toMatch(/default-src 'none'/)
    expect(html).toMatch(/connect-src 'none'/)
    expect(html).toMatch(/form-action 'none'/)
    expect(html).toMatch(/frame-ancestors 'none'/)
    expect(html).toMatch(/<meta name="referrer" content="no-referrer" \/>/)
    expect(html).not.toMatch(/https?:\/\//)
  })

  it('reaches for no bridge', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/from '\.\/(bridge|internal-calls|useInternalI18n)\.js'/)
      expect(source).not.toMatch(/tesseraInternal\s*[.?[]/)
    }
  })
})
