import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FindBarSurface } from '../../src/renderer/overlay/FindBarSurface.js'
import type { FindBarPresentation } from '@shared/overlay/surface.js'
import { DEFAULT_LOCALE, catalogs, interpolate } from '@shared/i18n/catalog.js'
import { FIND_BAR_HEIGHT, FIND_BAR_WIDTH } from '@shared/find/bar.js'

/**
 * The find bar, rendered.
 *
 * Four things can only be checked here, and each of them looks correct without being correct.
 *
 * The first is the wording of the count. "0 of 0" and "1 of 1" are what falls out of rendering the two
 * numbers Chromium reports, and they are the two wordings a find bar must not use — the first tells
 * somebody who has mistyped a word to read a fraction, the second offers a position where there is
 * nothing to move through. Only the rendered text can show which one the bar chose.
 *
 * The second is that every message names the bar's own tab. Without the id the call is identical in
 * every visible respect and searches whichever tile is active — so typing into a bar over tile 2
 * would highlight tile 1, on a page whose bar nobody can close.
 *
 * The third is that the field keeps what is being typed. The core answers every keystroke with a
 * count, so the presentation arrives again mid-word; a field rendering it directly would drop
 * characters and move the caret.
 *
 * The fourth is the keyboard, all of it: the caret starting in the field, Return walking forward,
 * Shift+Return back, Tab staying inside the bar, and Escape leaving as a plain overlay dismissal
 * rather than a message of its own.
 *
 * The bridge is replaced rather than mocked at the module level, for the same reason as the tile
 * bar's test: `bridge.ts` reads `window.tessera` on every call, which is the seam a sandboxed
 * renderer actually has.
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

/**
 * The same lookup the component performs with no provider above it — including the fallback to the
 * key itself, which is what `I18nContext`'s default value does.
 *
 * Compared against the catalogue rather than against English text, so what is pinned is the *mapping*
 * — which key, with which parameters — rather than a wording the catalogue is allowed to change. The
 * key is a plain string here on purpose: the compiler already checks that these keys exist, in the
 * component that uses them.
 */
function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(messages[key] ?? key, params)
}

function presentation(overrides: Partial<FindBarPresentation> = {}): FindBarPresentation {
  return {
    kind: 'find-bar',
    sessionId: 'find-1',
    tileIndex: 1,
    bounds: { x: 1112, y: 96, width: FIND_BAR_WIDTH, height: FIND_BAR_HEIGHT },
    tabId: 't2',
    query: 'needle',
    matches: 3,
    activeMatch: 2,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('wording the count', () => {
  it('says there are none rather than "0 of 0"', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation({ matches: 0, activeMatch: 0 })} />)
    expect(screen.getByRole('status').textContent).toBe(t('find.noMatches'))
  })

  it('states a single match rather than giving it a position', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation({ matches: 1, activeMatch: 1 })} />)
    expect(screen.getByRole('status').textContent).toBe(t('find.oneMatch'))
  })

  it('gives a position among many', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation({ matches: 12, activeMatch: 3 })} />)
    expect(screen.getByRole('status').textContent).toBe(
      t('find.ordinal', { active: 3, total: 12 })
    )
  })

  it('says a search is running rather than showing a zero', () => {
    // The distinction that stops the flicker: treated as zero, a search in flight would announce "no
    // matches" on every keystroke and correct itself a moment later.
    installBridge()
    render(<FindBarSurface presentation={presentation({ matches: null, activeMatch: 0 })} />)
    expect(screen.getByRole('status').textContent).toBe(t('find.searching'))
  })

  it('claims nothing at all while the field is empty', () => {
    installBridge()
    render(
      <FindBarSurface presentation={presentation({ query: '', matches: null, activeMatch: 0 })} />
    )
    expect(screen.getByRole('status').textContent).toBe('')
  })

  it('keeps the live region in the tree even while it is empty', () => {
    /*
      Rendered conditionally it would be inserted at the same moment as its text, and a live region
      that appears with its content is not announced — so the one user who most needs the count would
      be the one who never hears it.
    */
    installBridge()
    const { rerender } = render(
      <FindBarSurface presentation={presentation({ query: '', matches: null })} />
    )
    const region = screen.getByRole('status')
    rerender(<FindBarSurface presentation={presentation({ matches: 4, activeMatch: 1 })} />)
    expect(screen.getByRole('status')).toBe(region)
  })
})

describe('the bar searches its own tile', () => {
  it('sends what is typed with its own tab id', () => {
    const calls = installBridge()
    render(<FindBarSurface presentation={presentation({ tabId: 't2', query: '' })} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'needle' } })
    expect(calls).toEqual([{ channel: 'find:query', payload: { tabId: 't2', query: 'needle' } }])
  })

  it('steps its own tab', () => {
    const calls = installBridge()
    render(<FindBarSurface presentation={presentation({ tabId: 't3' })} />)

    screen.getByRole('button', { name: t('find.next') }).click()
    expect(calls).toEqual([{ channel: 'find:step', payload: { tabId: 't3', forward: true } }])
  })

  it('walks backwards from the previous button', () => {
    const calls = installBridge()
    render(<FindBarSurface presentation={presentation()} />)

    screen.getByRole('button', { name: t('find.previous') }).click()
    expect(calls).toEqual([{ channel: 'find:step', payload: { tabId: 't2', forward: false } }])
  })

  it('names the tile it belongs to, so a screen reader can tell two bars apart', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation({ tileIndex: 2 })} />)
    // One-based in the label, zero-based in the payload. The user counts from one.
    expect(screen.getByRole('group', { name: t('find.label', { index: 3 }) })).toBeTruthy()
  })

  it('offers nothing to step through until the page has reported a match', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation({ matches: null })} />)
    expect(screen.getByRole('button', { name: t('find.next') }).hasAttribute('disabled')).toBe(true)
    expect(
      screen.getByRole('button', { name: t('find.previous') }).hasAttribute('disabled')
    ).toBe(true)
  })

  it('offers nothing to step through when there are no matches', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation({ matches: 0, activeMatch: 0 })} />)
    expect(screen.getByRole('button', { name: t('find.next') }).hasAttribute('disabled')).toBe(true)
  })
})

describe('typing while the page answers', () => {
  it('keeps what the user has typed when the count comes back', () => {
    /*
      Every keystroke goes to the core and the core answers with a count, so the presentation arrives
      again while the word is half typed. A field rendering `presentation.query` directly would make
      its own contents round-trip through another process on every letter.
    */
    installBridge()
    const { rerender } = render(<FindBarSurface presentation={presentation({ query: '' })} />)

    const field = screen.getByRole<HTMLInputElement>('textbox')
    fireEvent.change(field, { target: { value: 'needl' } })
    rerender(
      <FindBarSurface presentation={presentation({ query: 'need', matches: 9, activeMatch: 1 })} />
    )

    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('needl')
  })

  it("takes the core's query when a new search begins", () => {
    // The shortcut pressed again is a new session, and it restores the term the bar was last used
    // with — which is the whole reason the core remembers it.
    installBridge()
    const { rerender } = render(<FindBarSurface presentation={presentation({ query: '' })} />)

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'scratch' } })
    rerender(
      <FindBarSurface presentation={presentation({ sessionId: 'find-2', query: 'needle' })} />
    )

    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('needle')
  })
})

describe('the keyboard', () => {
  it('puts the caret in the field', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation()} />)
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('selects the term, because replacing it is what happens next', () => {
    installBridge()
    render(<FindBarSurface presentation={presentation()} />)
    const field = screen.getByRole<HTMLInputElement>('textbox')
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(field.value.length)
  })

  it('walks forward on Return and back on Shift+Return', () => {
    const calls = installBridge()
    render(<FindBarSurface presentation={presentation()} />)
    const field = screen.getByRole('textbox')

    fireEvent.keyDown(field, { key: 'Enter' })
    fireEvent.keyDown(field, { key: 'Enter', shiftKey: true })

    expect(calls).toEqual([
      { channel: 'find:step', payload: { tabId: 't2', forward: true } },
      { channel: 'find:step', payload: { tabId: 't2', forward: false } }
    ])
  })

  it('leaves as a plain overlay dismissal on Escape', () => {
    /*
      Not a "close find" message of its own. The page's highlight is taken off when the bar *leaves the
      layer*, which is also what a window resize and a permission prompt do — one path out rather than
      one per exit.
    */
    const calls = installBridge()
    render(<FindBarSurface presentation={presentation()} />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(calls).toEqual([{ channel: 'overlay:dismiss', payload: undefined }])
  })

  it('dismisses from the close button too', () => {
    const calls = installBridge()
    render(<FindBarSurface presentation={presentation()} />)

    screen.getByRole('button', { name: t('find.close') }).click()
    expect(calls).toEqual([{ channel: 'overlay:dismiss', payload: undefined }])
  })

  it('keeps Tab inside the bar', () => {
    /*
      Trapped rather than merely ordered. The layer holds nothing but this bar, so past the last control
      the browser would move focus into a transparent surface with nothing in it — and a keyboard user
      would be somewhere they cannot see, with no way back.
    */
    installBridge()
    render(<FindBarSurface presentation={presentation()} />)
    const field = screen.getByRole<HTMLInputElement>('textbox')

    fireEvent.keyDown(field, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('find.previous') }))

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(field)
  })

  it('skips a button it would be pointless to reach', () => {
    // With nothing to step through, Tab from the field lands on close rather than on a control that
    // cannot be pressed.
    installBridge()
    render(<FindBarSurface presentation={presentation({ matches: 0, activeMatch: 0 })} />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('find.close') }))
  })

  it('sends nothing for an ordinary keystroke', () => {
    const calls = installBridge()
    render(<FindBarSurface presentation={presentation()} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'ArrowLeft' })
    expect(calls).toEqual([])
  })
})
