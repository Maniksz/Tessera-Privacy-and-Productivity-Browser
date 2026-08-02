import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TileBarSurface } from '../../src/renderer/overlay/TileBarSurface.js'
import type { TileBarPresentation } from '@shared/overlay/surface.js'
import { TILE_BAR_HEIGHT, TILE_BAR_POINTER_AWAY } from '@shared/split/tile-bar.js'
import { HOME_URL } from '@shared/url/omnibox.js'

/**
 * One tile's navigation bar, rendered.
 *
 * Two things can only be checked here. The first is the one the whole feature turns on: each
 * button has to carry *its own* tile's tab id. Without it the call is identical in every visible
 * respect and acts on the active tile — so the bar in tile 2 would send tile 1 back, which is the
 * complaint the feature exists to answer. Nothing but reading the payload can see that. Close is
 * the case with no way back — a misdirected one shuts a page the user is reading in another pane —
 * so it is asserted the same way as the four that only cost a back-press. Maximise is the same
 * assertion about a different name: it is addressed by `tileIndex`, because it moves a rectangle
 * rather than a page, and an omitted index means the active tile exactly as an omitted tab id does.
 *
 * The second is the keyboard route. A hover-revealed bar is a mouse-only control and fails spec 7,
 * so the same bar can be asked for by key: focus starts in the address field, Tab stays inside the
 * bar, and Escape dismisses. All three are properties of the DOM, invisible to a unit test of the
 * geometry and unreachable from the smoke test.
 *
 * The bridge is replaced rather than mocked at the module level, for the same reason as the tab
 * strip's test: `bridge.ts` reads `window.tessera` on every call, which is the seam a sandboxed
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

function presentation(overrides: Partial<TileBarPresentation> = {}): TileBarPresentation {
  return {
    kind: 'tile-bar',
    tileIndex: 1,
    bounds: { x: 720, y: 88, width: 720, height: TILE_BAR_HEIGHT },
    tabId: 't2',
    url: 'https://example.com/two',
    canGoBack: true,
    canGoForward: true,
    loading: false,
    zoomPercent: 100,
    zoomed: false,
    invokedBy: 'pointer',
    ...overrides
  }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the bar acts on its own tile', () => {
  it('sends its own tab back, not the active one', () => {
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ tabId: 't2' })} />)

    screen.getByRole('button', { name: /back/i }).click()
    expect(calls).toEqual([{ channel: 'nav:goBack', payload: { tabId: 't2' } }])
  })

  it('sends its own tab forward', () => {
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ tabId: 't3' })} />)

    screen.getByRole('button', { name: /forward/i }).click()
    expect(calls).toEqual([{ channel: 'nav:goForward', payload: { tabId: 't3' } }])
  })

  it('reloads its own tab', () => {
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ tabId: 't2' })} />)

    screen.getByRole('button', { name: /reload/i }).click()
    expect(calls).toEqual([{ channel: 'nav:reload', payload: { tabId: 't2' } }])
  })

  it('stops its own tab while it is loading', () => {
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ loading: true })} />)

    screen.getByRole('button', { name: /stop/i }).click()
    expect(calls).toEqual([{ channel: 'nav:stop', payload: { tabId: 't2' } }])
  })

  it('sends its own tab home, not the active one', () => {
    // The main toolbar's home button omits `tabId` on purpose — one active tab, no ambiguity. Copying
    // it here would send whichever tile happens to be active to the start page while the tile the
    // pointer is over stayed put, and both would look like the button worked.
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ tabId: 't2' })} />)

    screen.getByRole('button', { name: /home/i }).click()
    expect(calls).toEqual([{ channel: 'nav:navigate', payload: { input: HOME_URL, tabId: 't2' } }])
  })

  it('maximises its own tile by index, not the active one, and not by tab id', () => {
    /*
      The one payload in this bar that is not a `tabId`, which is the whole reason it is asserted.

      `split:toggleTileMaximized` makes `tileIndex` *optional*, so the mistake this catches is not a
      type error: `{}` compiles, is what the main toolbar sends, and means the active tile — which
      under the pointer is routinely not this one. A `tabId` here would be the other plausible slip,
      copied from the six controls around it, and the channel would reject it. `toEqual` on the whole
      payload is what pins both: the exact keys, not merely the presence of an index.
    */
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ tileIndex: 1, tabId: 't2' })} />)

    screen.getByRole('button', { name: /maximize/i }).click()
    expect(calls).toEqual([{ channel: 'split:toggleTileMaximized', payload: { tileIndex: 1 } }])
  })

  it('closes its own tab, not the active one', () => {
    // The one action in this bar with no way back, so this is the assertion that matters most in the
    // file: a close that reached the active tile would shut a page the user is looking at in a
    // different pane, and there is no back button for that.
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ tabId: 't2' })} />)

    screen.getByRole('button', { name: /close/i }).click()
    expect(calls).toEqual([{ channel: 'tabs:close', payload: { tabId: 't2' } }])
  })

  it('navigates its own tab from the address field', () => {
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation()} />)

    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'other.example' } })
    fireEvent.submit(field)

    // Raw text, not a URL: the address-versus-search decision belongs to the core (spec 1).
    expect(calls).toEqual([
      { channel: 'nav:navigate', payload: { input: 'other.example', tabId: 't2' } }
    ])
  })

  it('shows its own address', () => {
    installBridge()
    render(<TileBarSurface presentation={presentation({ url: 'https://two.example/' })} />)
    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('https://two.example/')
  })

  it('names the tile it belongs to, so a screen reader can tell two bars apart', () => {
    installBridge()
    render(<TileBarSurface presentation={presentation({ tileIndex: 2 })} />)
    // One-based in the label; zero-based in the payload. The user counts from one.
    expect(screen.getByRole('group', { name: /tile 3/i })).toBeTruthy()
  })

  it('offers no back button to press when there is no history behind it', () => {
    installBridge()
    render(<TileBarSurface presentation={presentation({ canGoBack: false, canGoForward: false })} />)
    expect(screen.getByRole('button', { name: /back/i }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: /forward/i }).hasAttribute('disabled')).toBe(true)
  })
})

describe('the pointer leaving', () => {
  it('reports its own departure, because nothing else can see it', () => {
    /*
      The bar covers the strip the core watches for pointer moves, so once it is up the core cannot
      see the pointer leave — it can only be told. Without this the bar would stay up until
      something unrelated took the layer down.
    */
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ tileIndex: 1 })} />)

    fireEvent.pointerLeave(screen.getByRole('group'))
    expect(calls).toEqual([
      { channel: 'tiles:pointerAt', payload: { tileIndex: 1, y: TILE_BAR_POINTER_AWAY } }
    ])
  })
})

describe('the keyboard route', () => {
  it('puts the caret in the address field when it was asked for by key', () => {
    installBridge()
    render(<TileBarSurface presentation={presentation({ invokedBy: 'keyboard' })} />)
    expect(document.activeElement).toBe(screen.getByRole('textbox'))
  })

  it('selects the address, because replacing it is what happens next', () => {
    installBridge()
    render(<TileBarSurface presentation={presentation({ invokedBy: 'keyboard' })} />)
    const field = screen.getByRole<HTMLInputElement>('textbox')
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(field.value.length)
  })

  it('leaves the keyboard alone when the pointer revealed it', () => {
    /*
      The layer is a real web contents; focusing it takes focus off the page. A bar that grabbed the
      caret because the pointer drifted near a tile's top edge would interrupt whatever was being
      typed underneath, and do it silently.
    */
    installBridge()
    render(<TileBarSurface presentation={presentation({ invokedBy: 'pointer' })} />)
    expect(document.activeElement).not.toBe(screen.getByRole('textbox'))
  })

  it('dismisses on Escape', () => {
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ invokedBy: 'keyboard' })} />)

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(calls).toEqual([{ channel: 'overlay:dismiss', payload: undefined }])
  })

  it('keeps Tab inside the bar', () => {
    /*
      Trapped rather than merely ordered. The layer holds nothing but this bar, so past the last
      control the browser would move focus into a transparent surface with nothing in it — and a
      keyboard user would be somewhere they cannot see, with no way back.
    */
    installBridge()
    render(<TileBarSurface presentation={presentation({ invokedBy: 'keyboard' })} />)
    const field = screen.getByRole<HTMLInputElement>('textbox')
    const close = screen.getByRole('button', { name: /close/i })

    // Close sits after the field, so it is the next stop forward and the last control in the bar.
    fireEvent.keyDown(field, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    // The wrap, which is what "trapped" means: past the last control focus comes back to the first
    // rather than leaving for a transparent layer with nothing on it.
    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /back/i }))

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(close)

    /*
      The middle of the ring, which the three assertions above cannot see.

      They pin the first stop and the last one, and a seventh control leaves both green wherever it
      landed — after close, or wedged among the four that mirror the toolbar. Maximise belongs between
      home and the address field, and that is a claim about order rather than about membership, so it
      needs the walk. Added rather than substituted: the wrap and the reverse step are still asserted
      exactly as they were, and this only says more about what lies between them.
    */
    screen.getByRole('button', { name: /back/i }).focus()
    // The zoom cluster sits between maximise and the address field: out, the level, in. Its level
    // button is disabled at the default zoom this fixture uses, so it is not a stop — which is the
    // same rule the disabled back button is held to two tests down.
    for (const name of [/forward/i, /reload/i, /home/i, /maximize/i, /zoom out/i, /zoom in/i]) {
      fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
      expect(document.activeElement).toBe(screen.getByRole('button', { name }))
    }
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(field)
  })

  it('skips a button it would be pointless to reach', () => {
    /*
      A disabled back button is not a focus stop, so the wrap goes to reload rather than to a control
      that cannot be pressed.

      Checked from the far end of the bar rather than backwards out of the address field, which is
      where it used to be checked. Home now sits between reload and the field, so Shift+Tab from the
      field lands on home whether the disabled pair is filtered out or not — the assertion would have
      stayed green while proving nothing. Maximise, added between home and the field, puts a second
      control in the way and makes the old form emptier still; the wrap forward from close is the only
      route to the filtered pair that stays direct however many controls the middle of the bar grows.
    */
    installBridge()
    render(
      <TileBarSurface
        presentation={presentation({ invokedBy: 'keyboard', canGoBack: false, canGoForward: false })}
      />
    )
    const close = screen.getByRole('button', { name: /close/i })
    close.focus()

    fireEvent.keyDown(close, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /reload/i }))
  })

  it('does not send a navigation for a keystroke that is not Enter', () => {
    const calls = installBridge()
    render(<TileBarSurface presentation={presentation({ invokedBy: 'keyboard' })} />)
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'a' })
    expect(calls).toEqual([])
  })
})

describe('typing while the page moves under you', () => {
  it('keeps what the user has typed when the presentation is re-sent', () => {
    /*
      The core re-sends the presentation whenever the tab navigates, and a bar that took its value
      straight from the message would erase a half-typed address because the page behind it finished
      loading.
    */
    installBridge()
    const { rerender } = render(<TileBarSurface presentation={presentation()} />)

    const field = screen.getByRole<HTMLInputElement>('textbox')
    fireEvent.change(field, { target: { value: 'half-typed.example' } })
    rerender(<TileBarSurface presentation={presentation({ url: 'https://moved.example/' })} />)

    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('half-typed.example')
  })

  it('shows the new address again once the field has been submitted', () => {
    installBridge()
    const { rerender } = render(<TileBarSurface presentation={presentation()} />)

    const field = screen.getByRole('textbox')
    fireEvent.change(field, { target: { value: 'half-typed.example' } })
    fireEvent.submit(field)
    rerender(<TileBarSurface presentation={presentation({ url: 'https://moved.example/' })} />)

    expect(screen.getByRole<HTMLInputElement>('textbox').value).toBe('https://moved.example/')
  })
})
