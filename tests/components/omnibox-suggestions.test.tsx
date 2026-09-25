import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { Omnibox } from '@renderer/components/Omnibox.js'
import { OverlaySurface } from '@renderer/surfaces/OverlaySurface.js'
import { OmniboxSuggestionsSurface } from '@renderer/surfaces/OmniboxSuggestionsSurface.js'
import { DEFAULT_LOCALE, catalogs, interpolate } from '@shared/i18n/catalog.js'
import type { TabState } from '@shared/model.js'
import type { OmniboxSuggestionsPresentation } from '@shared/omnibox/model.js'
import type { OverlayState } from '@shared/overlay/surface.js'
import { omniboxDisplayValue } from '@shared/url/omnibox.js'

/**
 * The address bar's suggestion list, both halves (U18, R28–R30, KTD12).
 *
 * The field sends text with a running number and walks the list with the arrow keys; the overlay draws
 * the list and chooses on `pointerdown`. What the core ranks is `tests/omnibox-handlers.test.ts`; here it
 * is the keyboard, the stale number, the choice and what does *not* close the list.
 *
 * One fake bridge for both renderers, as the core would be: every `overlay:presented` reaches every
 * subscriber, which is how the field and the layer come to hold the same presentation.
 */

interface Call {
  channel: string
  payload: unknown
}

function installBridge(): { calls: Call[]; present: (next: OverlayState) => void } {
  const calls: Call[] = []
  const listeners: Array<(payload: { presentation: OverlayState }) => void> = []
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      if (channel === 'window:getState') return Promise.resolve({ platform: 'linux' })
      if (channel === 'settings:getAll') return Promise.resolve({ 'advanced.customShortcuts': {} })
      if (channel === 'nav:navigate') return Promise.resolve({ url: '' })
      return Promise.resolve({ ok: true })
    },
    on: (channel: string, listener: (payload: never) => void): (() => void) => {
      if (channel !== 'overlay:presented') return () => {}
      const typed = listener as (payload: { presentation: OverlayState }) => void
      listeners.push(typed)
      return () => listeners.splice(listeners.indexOf(typed), 1)
    },
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
  return {
    calls,
    present: (next) => {
      void act(() => {
        for (const listener of [...listeners]) listener({ presentation: next })
      })
    }
  }
}

const messages = catalogs[DEFAULT_LOCALE] as Record<string, string>
const t = (key: string, params?: Record<string, string | number>): string =>
  interpolate(messages[key] ?? key, params)

const TAB: TabState = {
  id: 'front',
  url: 'https://front.example/',
  pendingInput: null,
  title: 'Front',
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
  tileIndex: 0,
  unloaded: false
}

function list(
  overrides: Partial<OmniboxSuggestionsPresentation> = {}
): OmniboxSuggestionsPresentation {
  return {
    kind: 'omnibox-suggestions',
    seq: 4,
    bounds: { x: 200, y: 76, width: 600, height: 110 },
    text: 'wiki',
    lead: { action: 'search', engine: 'DuckDuckGo' },
    rows: [
      { source: 'tab', title: 'Team wiki', url: 'https://wiki.team.example/', tabId: 't2' },
      { source: 'history', title: 'Wikipedia', url: 'https://en.wikipedia.org/', tabId: null }
    ],
    selected: 0,
    ...overrides
  }
}

function renderField(): ReturnType<typeof installBridge> & { input: HTMLInputElement } {
  const bridge = installBridge()
  render(<Omnibox tab={TAB} settings={null} privateMode={false} focusRequest={0} />)
  const input = screen.getByRole<HTMLInputElement>('textbox', { name: t('omnibox.placeholder') })
  return { ...bridge, input }
}

/** Types `text` one character at a time, the way a person does: one request per keystroke. */
function type(input: HTMLInputElement, text: string): void {
  input.focus()
  for (let end = 1; end <= text.length; end += 1) {
    fireEvent.change(input, { target: { value: text.slice(0, end) } })
  }
}

const suggestions = (calls: readonly Call[]): Array<Record<string, unknown>> =>
  calls
    .filter((call) => call.channel === 'omnibox:suggest')
    .map((call) => call.payload as Record<string, unknown>)

const channels = (calls: readonly Call[]): string[] => calls.map((call) => call.channel)

afterEach(() => {
  cleanup()
})

describe('the address bar asks, with a running number', () => {
  it('sends the text, the field and a new number on every keystroke, and never rows', () => {
    const { calls, input } = renderField()
    type(input, 'wiki')
    const sent = suggestions(calls)
    expect(sent.map((request) => [request['seq'], request['text'], request['selected']])).toEqual([
      [1, 'w', 0],
      [2, 'wi', 0],
      [3, 'wik', 0],
      [4, 'wiki', 0]
    ])
    expect(Object.keys(sent[3]!).sort()).toEqual(['anchor', 'selected', 'seq', 'text'])
  })

  it('closes the list rather than asking when the field is emptied', () => {
    const { calls, input } = renderField()
    type(input, 'w')
    fireEvent.change(input, { target: { value: '' } })
    expect(channels(calls).at(-1)).toBe('omnibox:close')
  })

  it('no longer draws the hint behind the page', () => {
    const { input } = renderField()
    type(input, 'wiki')
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(t('omnibox.searchWith', { engine: 'DuckDuckGo' }))).toBeNull()
  })
})

describe('the keyboard walks the list the core presented', () => {
  it('opens the chosen row: ArrowDown and Enter on an open tab switches to it', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(suggestions(calls).at(-1)).toMatchObject({ seq: 5, text: 'wiki', selected: 1 })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls.at(-1)).toEqual({ channel: 'tabs:activate', payload: { tabId: 't2' } })
    expect(channels(calls)).not.toContain('nav:navigate')
  })

  it('navigates to a history row by its address', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(calls.at(-1)).toEqual({
      channel: 'nav:navigate',
      payload: { input: 'https://en.wikipedia.org/' }
    })
  })

  it('stops at the ends of the list, and ArrowUp goes back to the typed text', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(suggestions(calls)).toHaveLength(4)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(suggestions(calls).at(-1)).toMatchObject({ selected: 0 })
    fireEvent.submit(input.form!)
    expect(calls.at(-1)).toEqual({ channel: 'nav:navigate', payload: { input: 'wiki' } })
  })

  it('opens the typed text on Enter with nothing chosen (R30)', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    fireEvent.submit(input.form!)
    expect(calls.at(-1)).toEqual({ channel: 'nav:navigate', payload: { input: 'wiki' } })
  })

  it('does not walk a list that answers an older number', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    // The answer to "wik", arriving after "wiki" was sent: it describes text the field no longer holds.
    present(list({ seq: 3, text: 'wik' }))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(suggestions(calls)).toHaveLength(4)
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(channels(calls)).not.toContain('tabs:activate')

    present(list({ seq: 4 }))
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(suggestions(calls).at(-1)).toMatchObject({ seq: 5, selected: 1 })
  })

  it('forgets the list once the layer shows something else', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    present(null)
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(suggestions(calls)).toHaveLength(4)
  })

  it('never picks a row with Enter during an IME composition', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true })
    fireEvent.keyDown(input, { key: 'Process' })
    expect(channels(calls)).not.toContain('tabs:activate')
    expect(channels(calls)).not.toContain('nav:navigate')
    // Nor do the arrows move while the composition has them.
    fireEvent.keyDown(input, { key: 'ArrowDown', isComposing: true })
    expect(suggestions(calls)).toHaveLength(5)
  })

  it('closes the list on the first Escape and puts the address back on the second', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(channels(calls).at(-1)).toBe('omnibox:close')
    expect(input.value).toBe('wiki')
    present(null)
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input.value).toBe(omniboxDisplayValue(TAB.url))
  })

  it('does not close the list when the field loses focus', () => {
    const { calls, input, present } = renderField()
    type(input, 'wiki')
    present(list())
    fireEvent.blur(input)
    expect(channels(calls)).not.toContain('omnibox:close')
  })
})

describe('the list on the layer', () => {
  it('draws row zero and every row, and marks the one reached', () => {
    render(<OmniboxSuggestionsSurface presentation={list({ selected: 2 })} onChoose={() => {}} />)
    const box = screen.getByRole('listbox', { name: t('omnibox.suggestions') })
    const options = within(box).getAllByRole('option')
    expect(options).toHaveLength(3)
    expect(options[0]!.textContent).toContain(t('omnibox.searchWith', { engine: 'DuckDuckGo' }))
    expect(options[1]!.textContent).toContain(t('omnibox.switchToTab'))
    expect(options[2]!.textContent).toContain('https://en.wikipedia.org/')
    expect(options.map((option) => option.getAttribute('aria-selected'))).toEqual([
      'false',
      'false',
      'true'
    ])
  })

  it('says which address row zero opens', () => {
    render(
      <OmniboxSuggestionsSurface
        presentation={list({
          text: 'example.com',
          lead: { action: 'open', url: 'https://example.com' }
        })}
        onChoose={() => {}}
      />
    )
    expect(screen.getAllByRole('option')[0]!.textContent).toContain(
      t('omnibox.openUrl', { url: 'https://example.com' })
    )
  })

  it('chooses on the press of the main button, and not on any other', () => {
    const chosen: number[] = []
    render(
      <OmniboxSuggestionsSurface presentation={list()} onChoose={(index) => chosen.push(index)} />
    )
    const options = screen.getAllByRole('option')
    fireEvent.pointerDown(options[1]!, { button: 2 })
    fireEvent.pointerDown(options[1]!, { button: 0 })
    fireEvent.pointerDown(options[0]!, { button: 0 })
    expect(chosen).toEqual([1, 0])
  })
})

describe('a press on a row, with the field losing focus to the layer', () => {
  it('opens the row although the field blurs, and nothing closes the list on the blur', async () => {
    const { calls, input, present } = renderField()
    render(<OverlaySurface />)
    type(input, 'wiki')
    present(list())
    const row = await screen.findByRole('option', { name: /Team wiki/ })
    // What a press on another web contents does to the field, before any click could arrive.
    fireEvent.pointerDown(row, { button: 0 })
    fireEvent.blur(input)
    expect(calls.filter((call) => call.channel === 'tabs:activate')).toEqual([
      { channel: 'tabs:activate', payload: { tabId: 't2' } }
    ])
    expect(channels(calls)).not.toContain('omnibox:close')
  })

  it('navigates a history row from the layer by its address', async () => {
    const { calls, input, present } = renderField()
    render(<OverlaySurface />)
    type(input, 'wiki')
    present(list())
    fireEvent.pointerDown(await screen.findByRole('option', { name: /Wikipedia/ }), { button: 0 })
    expect(calls.at(-1)).toEqual({
      channel: 'nav:navigate',
      payload: { input: 'https://en.wikipedia.org/' }
    })
  })
})
