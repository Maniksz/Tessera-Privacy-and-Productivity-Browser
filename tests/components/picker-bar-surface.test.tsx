import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PickerBarSurface } from '../../src/renderer/overlay/PickerBarSurface.js'
import { OverlaySurface } from '../../src/renderer/src/surfaces/OverlaySurface.js'
import type { PickerBarPresentation, OverlayPresentation } from '@shared/overlay/surface.js'
import { PICKER_OUTCOMES } from '@shared/filters/picker-session.js'
import {
  PICKER_BAR_HEIGHT,
  PICKER_BAR_WIDTH,
  type PickerBarMode
} from '@shared/overlay/picker-bar.js'
import { interpolate } from '@shared/i18n/catalog.js'

/**
 * The element picker's confirmation bar, rendered.
 *
 * ## What this is the other half of
 *
 * The defect the whole plan is a repair for is a picker that closed and said nothing: a click could be
 * refused five different ways and every one of them looked identical from outside. Everything upstream
 * of this file now produces a named answer — the session, the outcome set, the presentation — and none
 * of it is worth anything until an answer is *on screen*. This is the only place that can be shown.
 *
 * It is also the only place the surface is proved at all. `OverlaySurface` picks a surface by kind with
 * an `if`-chain rather than an exhaustive `switch`, so a missing branch compiles cleanly and renders an
 * empty layer — a bar that says nothing, which is the original defect wearing new clothes. The last
 * describe block below is that branch.
 *
 * ## What is asserted
 *
 * Four things, each of which looks right while being wrong.
 *
 * That every one of the eight outcomes reaches the screen, *including* one the surface has never heard
 * of. The bar receives an opaque key and resolves it against the words the core sent with it; a ninth
 * outcome added later must render its own name rather than an empty bar, because a blank is the one
 * thing that reads as reassuring while meaning nothing was said.
 *
 * That the waiting states cannot be confirmed. `writing` and `measuring` are the window in which a
 * second press would write a second rule, and a button that merely *looks* pressed-out still fires.
 *
 * That the count distinguishes "nothing matches" from "not counted yet". They are the same picture and
 * opposite findings — one is a reportable result, the other is the absence of a result.
 *
 * That the keyboard contract of KTD10 is wired to the four actions, and that arrows past the ends of the
 * ancestor chain send nothing. A key that reports an action the core would refuse is the same silence
 * this feature exists to remove.
 *
 * The bridge is replaced rather than mocked at the module level, for the find bar's reason: `bridge.ts`
 * reads `window.tessera` on every call, which is the seam a sandboxed renderer actually has.
 *
 * The words are stubbed rather than real, on the rule editor's precedent: they come from the core, on the
 * presentation (see `main/privacy/picker-bar-text.ts`), and `tests/picker-presentation.test.ts` holds the
 * two languages to each other and to the eight outcomes. What this file pins is which word each mode reads,
 * with which parameters — and that it is the presentation's word, not a catalogue's.
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
      /*
        The two reads `OverlaySurface` makes for itself, answered so the integration block below can
        render the real layer rather than a stub of it. Every other channel answers with the shape the
        bar ignores.
      */
      if (channel === 'window:getState') return Promise.resolve({ platform: 'linux' })
      if (channel === 'settings:getAll') return Promise.resolve({ 'advanced.customShortcuts': {} })
      return Promise.resolve({ taken: true })
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
  return calls
}

/**
 * Stand-in words, one for every key the core sends.
 *
 * Deliberately not the real sentences: a component that still read the catalogue would render the
 * catalogue's wording, and a fixture equal to it could not tell the two routes apart.
 */
const TEXT: Record<string, string> = {
  label: 'Pick in tile {index}',
  choosing: 'Point at something.',
  counting: 'Counting.',
  matchesNone: 'Hits nothing.',
  matchesOne: 'Hits one.',
  matches: 'Hits {count}.',
  writing: 'Writing.',
  measuring: 'Measuring.',
  widen: 'Wider',
  narrow: 'Narrower',
  confirm: 'Do it',
  cancel: 'Stop',
  close: 'Done',
  undo: 'Take back',
  openRules: 'Rules',
  ...Object.fromEntries(
    PICKER_OUTCOMES.map((outcome) => [`outcome.${outcome}`, `Said: ${outcome}.`])
  )
}

/**
 * The lookup the component performs, fallback to the key included.
 *
 * Compared against the fixture rather than against literal text, so what is pinned is the *mapping* —
 * which key, with which parameters — and not a wording the core is free to improve.
 */
function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(TEXT[key] ?? key, params)
}

function presentation(overrides: Partial<PickerBarPresentation> = {}): PickerBarPresentation {
  return {
    kind: 'picker-bar',
    sessionId: 'pick-1',
    tileIndex: 1,
    bounds: { x: 900, y: 8, width: PICKER_BAR_WIDTH, height: PICKER_BAR_HEIGHT },
    tabId: 't2',
    mode: 'frozen',
    selector: 'example.com##.banner-ad',
    matches: 3,
    canWiden: true,
    canNarrow: true,
    outcome: null,
    canUndo: false,
    text: TEXT,
    ...overrides
  }
}

/** The bar as the core presents it once an attempt is over. */
function ended(outcome: string, canUndo = false): PickerBarPresentation {
  return presentation({
    mode: 'outcome',
    outcome,
    canUndo,
    matches: null,
    canWiden: false,
    canNarrow: false
  })
}

const button = (name: string): HTMLElement => screen.getByRole('button', { name })
const noButton = (name: string): HTMLElement | null => screen.queryByRole('button', { name })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('what the bar offers in each mode', () => {
  it('names the selector under the pointer and offers nothing to confirm', () => {
    /*
      `showing` is the pointer walking the page. The selector is on screen because a person cannot judge
      a choice they cannot see — but there is nothing chosen yet, so a Confirm here would write a rule
      for whatever happened to be under the pointer when it was pressed.
    */
    installBridge()
    render(
      <PickerBarSurface
        presentation={presentation({
          mode: 'showing',
          selector: 'example.com##.promo',
          matches: null,
          canWiden: false,
          canNarrow: false
        })}
      />
    )

    expect(screen.getByText('example.com##.promo')).toBeTruthy()
    expect(noButton(t('confirm'))).toBeNull()
    expect(noButton(t('widen'))).toBeNull()
    // Cancel is the one control every mode has: the way out must never depend on the state.
    expect(button(t('cancel'))).toBeTruthy()
  })

  it('offers the count and all four controls once the click has frozen a selection', () => {
    installBridge()
    render(<PickerBarSurface presentation={presentation({ matches: 3 })} />)

    expect(screen.getByRole('status').textContent).toBe(t('matches', { count: 3 }))
    expect(button(t('widen'))).toBeTruthy()
    expect(button(t('narrow'))).toBeTruthy()
    expect(button(t('confirm'))).toBeTruthy()
    expect(button(t('cancel'))).toBeTruthy()
  })

  it('dims the end of the ancestor chain rather than hiding the control', () => {
    // A control that vanishes changes the bar's shape as the selection is refined, and the user is
    // pressing at a moving target. Dimmed, the bar says "not from here" and stays still.
    installBridge()
    render(<PickerBarSurface presentation={presentation({ canWiden: false, canNarrow: true })} />)

    expect(button(t('widen')).hasAttribute('disabled')).toBe(true)
    expect(button(t('narrow')).hasAttribute('disabled')).toBe(false)
  })

  it('shows the whole selector however long it is', () => {
    /*
      Elided in CSS, never in the DOM. A confirmation that hides half of what it is confirming is not
      one — and the elision has to be the kind a person can defeat, which is why the full text is also
      the control's title.
    */
    installBridge()
    const selector = `shop.example.com##div.wrapper > section.column-right div[data-testid="advertisement-slot-below-the-fold"] > .frame`
    render(<PickerBarSurface presentation={presentation({ selector })} />)

    const shown = screen.getByText(selector)
    expect(shown.textContent).toBe(selector)
    expect(shown.getAttribute('title')).toBe(selector)
  })
})

describe('the waiting states', () => {
  const waiting: PickerBarMode[] = ['writing', 'measuring']

  it.each(waiting)('says work is under way in %s rather than showing a stale count', (mode) => {
    installBridge()
    render(<PickerBarSurface presentation={presentation({ mode })} />)
    expect(screen.getByRole('status').textContent).toBe(t(mode))
  })

  it.each(waiting)('cannot be confirmed a second time in %s', (mode) => {
    /*
      The window a double press would write two rules in. Both routes are checked, because they are
      different code: a disabled button ignores a click, and the keyboard contract has to refuse Return
      on its own — a bar that trapped focus and answered Return would confirm from a state that has
      already confirmed.
    */
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation({ mode })} />)

    const confirm = button(t('confirm'))
    expect(confirm.hasAttribute('disabled')).toBe(true)
    fireEvent.click(confirm)
    fireEvent.keyDown(confirm, { key: 'Enter' })

    expect(calls).toEqual([])
  })

  it.each(waiting)('refuses to refine the selection in %s', (mode) => {
    // The rule being written is the one that was frozen. Widening after the write has begun would
    // describe a selection that no longer decides anything.
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation({ mode })} />)

    fireEvent.keyDown(screen.getByRole('group'), { key: 'ArrowUp' })
    fireEvent.keyDown(screen.getByRole('group'), { key: 'ArrowDown' })
    expect(calls).toEqual([])
  })

  it('leaves cancelling open while the core is working', () => {
    // Escape has to mean the same thing in every state, including the two the user cannot otherwise
    // act in. A session that could not be abandoned mid-write is a bar with no way out.
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation({ mode: 'writing' })} />)

    fireEvent.click(button(t('cancel')))
    expect(calls).toEqual([
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'cancel' } }
    ])
  })
})

describe('the measured count', () => {
  it('tells "not counted yet" apart from "matches nothing"', () => {
    /*
      The distinction the whole measurement exists for. Zero is the finding "this rule changes nothing
      here", which R6 requires the user to see *before* confirming; `null` is the absence of a finding.
      Rendered as the same "0", a measurement in flight would announce a result nobody had reached.
    */
    installBridge()
    const { rerender } = render(<PickerBarSurface presentation={presentation({ matches: null })} />)
    expect(screen.getByRole('status').textContent).toBe(t('counting'))

    rerender(<PickerBarSurface presentation={presentation({ matches: 0 })} />)
    expect(screen.getByRole('status').textContent).toBe(t('matchesNone'))
  })

  it('does not offer a single element a plural', () => {
    installBridge()
    render(<PickerBarSurface presentation={presentation({ matches: 1 })} />)
    expect(screen.getByRole('status').textContent).toBe(t('matchesOne'))
  })

  it('keeps the live region in the tree while it is being refined', () => {
    /*
      A live region inserted at the same moment as its text is not announced at all, so the one user who
      most needs the count would be the one who never hears it. The count changes on every widen, which
      is exactly when it has to be spoken.
    */
    installBridge()
    const { rerender } = render(<PickerBarSurface presentation={presentation({ matches: null })} />)
    const region = screen.getByRole('status')
    rerender(<PickerBarSurface presentation={presentation({ matches: 7 })} />)
    expect(screen.getByRole('status')).toBe(region)
  })
})

describe('the eight answers', () => {
  it.each(PICKER_OUTCOMES)('says what became of the attempt for %s', (outcome) => {
    // R1 and R3 from the surface's side: no path ends without a sentence, and each sentence is the
    // core's rather than one assembled here.
    installBridge()
    render(<PickerBarSurface presentation={ended(outcome)} />)
    expect(screen.getByRole('status').textContent).toBe(t(`outcome.${outcome}`))
  })

  it('renders the key of an outcome it has never heard of', () => {
    /*
      The bar holds no list of the eight — that list belongs to the session, where it is held to being
      exhaustive. A ninth outcome therefore arrives here as an unknown key, and it renders as its own
      name: visible in testing, and never a reassuring blank in front of a user.
    */
    installBridge()
    render(<PickerBarSurface presentation={ended('reticulating-splines')} />)
    expect(screen.getByRole('status').textContent).toBe('outcome.reticulating-splines')
  })

  it('renders the key of a word the core did not send', () => {
    // The same rule for the chrome as for the outcomes: a word missing from the presentation is a name on
    // screen, never an unlabelled button — which a screen reader would announce as nothing at all.
    installBridge()
    render(<PickerBarSurface presentation={presentation({ text: {} })} />)
    expect(button('confirm')).toBeTruthy()
    expect(screen.getByRole('status').textContent).toBe('matches')
  })

  it('says what the presentation says, in whatever language it arrived in', () => {
    /*
      The words are the core's, resolved for the language the interface is in. A bar that still reached
      for a catalogue of its own would say English over a German presentation — exactly the mismatch
      that looks fine to everybody testing in English.
    */
    installBridge()
    const german = { ...TEXT, confirm: 'Blocken', 'outcome.saved-effective': 'Geblockt.' }
    const { rerender } = render(<PickerBarSurface presentation={presentation({ text: german })} />)
    expect(button('Blocken')).toBeTruthy()

    rerender(<PickerBarSurface presentation={{ ...ended('saved-effective'), text: german }} />)
    expect(screen.getByRole('status').textContent).toBe('Geblockt.')
  })

  it('offers the way back and the way to the rules after a rule was written', () => {
    // R15. Both, and neither is optional: a block that cannot be undone in the moment is one the user
    // has to go and hunt for, and the rules list is where every later correction happens.
    installBridge()
    render(<PickerBarSurface presentation={ended('saved-effective', true)} />)

    expect(button(t('undo'))).toBeTruthy()
    expect(button(t('openRules'))).toBeTruthy()
  })

  it('offers no undo when this attempt wrote nothing', () => {
    /*
      "Already there, switched off" names a rule that exists and one this attempt did not write. Undo
      here would delete a rule the user made earlier and never asked to lose — the refusals and the
      duplicates are exactly the outcomes where the button would do harm.
    */
    installBridge()
    render(<PickerBarSurface presentation={ended('duplicate-disabled', false)} />)

    expect(noButton(t('undo'))).toBeNull()
    // Still the way to the rules: the sentence for this outcome tells the user to switch it back on
    // there, and a next step named without a way to take it is half an answer.
    expect(button(t('openRules'))).toBeTruthy()
  })

  it('sends the two follow-up actions for its own session', () => {
    const calls = installBridge()
    render(<PickerBarSurface presentation={ended('saved-effective', true)} />)

    fireEvent.click(button(t('undo')))
    fireEvent.click(button(t('openRules')))

    expect(calls).toEqual([
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'undo' } },
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'open-rules' } }
    ])
  })

  it('closes rather than cancels once there is nothing left to cancel', () => {
    // The same action, worded for what it now does. "Cancel" over a rule that was just saved reads as
    // an offer to take it back, which is the button beside it.
    const calls = installBridge()
    render(<PickerBarSurface presentation={ended('saved-effective', true)} />)

    expect(noButton(t('cancel'))).toBeNull()
    fireEvent.click(button(t('close')))
    expect(calls).toEqual([
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'cancel' } }
    ])
  })
})

describe('the keyboard contract', () => {
  it('takes focus so the four keys reach it', () => {
    // Like the find bar, and for the same reason: the bar is raised by a gesture that has nothing to do
    // with the pointer's position, and a keyboard contract nobody is focused for is not one.
    installBridge()
    render(<PickerBarSurface presentation={presentation()} />)
    expect(document.activeElement).toBe(screen.getByRole('group'))
  })

  it('pulls the selection wider and narrower with the arrows', () => {
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation()} />)
    const bar = screen.getByRole('group')

    fireEvent.keyDown(bar, { key: 'ArrowUp' })
    fireEvent.keyDown(bar, { key: 'ArrowDown' })

    expect(calls).toEqual([
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'widen' } },
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'narrow' } }
    ])
  })

  it('sends nothing for an arrow past the end of the chain', () => {
    // KTD11 stops the chain below `body`. A key that reported an action the core would refuse would be
    // the silent no-op this feature is being rebuilt to remove, reproduced on the keyboard.
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation({ canWiden: false, canNarrow: false })} />)
    const bar = screen.getByRole('group')

    fireEvent.keyDown(bar, { key: 'ArrowUp' })
    fireEvent.keyDown(bar, { key: 'ArrowDown' })

    expect(calls).toEqual([])
  })

  it('confirms on Return and cancels on Escape', () => {
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation()} />)
    const bar = screen.getByRole('group')

    fireEvent.keyDown(bar, { key: 'Enter' })
    fireEvent.keyDown(bar, { key: 'Escape' })

    expect(calls).toEqual([
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'confirm' } },
      { channel: 'picker:barAction', payload: { sessionId: 'pick-1', action: 'cancel' } }
    ])
  })

  it('cancels by name rather than dismissing the layer', () => {
    /*
      A dismissal takes down whatever is up. A cancel that arrived a moment after a consent dialogue had
      claimed the layer would take the dialogue down, and the safe default turns that into a refusal
      nobody gave. Named, it can only ever end the bar.
    */
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation()} />)

    fireEvent.keyDown(screen.getByRole('group'), { key: 'Escape' })
    expect(calls.map((call) => call.channel)).not.toContain('overlay:dismiss')
  })

  it('leaves Return on a focused control to the control', () => {
    /*
      A focused button activates itself on Return. The bar answering the same keystroke as well would
      press Wider *and* confirm — a rule written for a selection the user was still in the middle of
      moving. The browser's own activation is not something happy-dom performs on a keydown, so what is
      pinned here is the half that is the bar's: it sends nothing.
    */
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation()} />)

    fireEvent.keyDown(button(t('widen')), { key: 'Enter' })
    expect(calls).toEqual([])
  })

  it('refuses Return while nothing is frozen', () => {
    // There is no keyboard path from `showing` into `frozen` — selecting is pointer-only by decision —
    // so Return here would confirm a selection that does not exist.
    const calls = installBridge()
    render(
      <PickerBarSurface
        presentation={presentation({ mode: 'showing', canWiden: false, canNarrow: false })}
      />
    )

    fireEvent.keyDown(screen.getByRole('group'), { key: 'Enter' })
    expect(calls).toEqual([])
  })

  it('sends nothing for an ordinary keystroke', () => {
    const calls = installBridge()
    render(<PickerBarSurface presentation={presentation()} />)
    fireEvent.keyDown(screen.getByRole('group'), { key: 'ArrowLeft' })
    expect(calls).toEqual([])
  })

  it('keeps Tab inside the bar', () => {
    /*
      Trapped rather than merely ordered, for the find bar's reason: the layer holds nothing but this
      bar, so past the last control the browser would move focus into a transparent surface with nothing
      in it, and a keyboard user would be somewhere they cannot see.
    */
    installBridge()
    render(<PickerBarSurface presentation={presentation()} />)
    const bar = screen.getByRole('group')

    fireEvent.keyDown(bar, { key: 'Tab' })
    expect(document.activeElement).toBe(button(t('widen')))

    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(button(t('cancel')))
  })

  it('names the tile it belongs to, so a screen reader can place it', () => {
    installBridge()
    render(<PickerBarSurface presentation={presentation({ tileIndex: 2 })} />)
    // One-based in the label, zero-based in the payload. The user counts from one.
    expect(screen.getByRole('group', { name: t('label', { index: 3 }) })).toBeTruthy()
  })
})

/**
 * The branch the compiler cannot check.
 *
 * `OverlaySurface` selects by kind with an `if`-chain, so a missing branch type-checks and renders an
 * empty layer. That is precisely the failure this feature exists to remove — a picker that says nothing
 * — and nothing but this block would notice it.
 */
describe('the layer choosing this surface', () => {
  function layer(): (next: OverlayPresentation) => void {
    let deliver: ((payload: { presentation: OverlayPresentation }) => void) | null = null
    const calls: Call[] = []
    const bridge = {
      invoke: (channel: string, payload?: unknown): Promise<unknown> => {
        calls.push({ channel, payload })
        if (channel === 'window:getState') return Promise.resolve({ platform: 'linux' })
        if (channel === 'settings:getAll')
          return Promise.resolve({ 'advanced.customShortcuts': {} })
        return Promise.resolve({ taken: true })
      },
      on: (channel: string, listener: (payload: never) => void): (() => void) => {
        if (channel === 'overlay:presented')
          deliver = listener as (payload: { presentation: OverlayPresentation }) => void
        return () => {}
      },
      channels: { invoke: [], event: [] }
    }
    Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
    render(<OverlaySurface />)
    return (next) => {
      if (deliver === null) throw new Error('the layer never subscribed')
      deliver({ presentation: next })
    }
  }

  it('draws the bar when the core presents one', async () => {
    const present = layer()
    present(presentation())
    await waitFor(() =>
      expect(screen.getByRole('group', { name: t('label', { index: 2 }) })).toBeTruthy()
    )
    expect(button(t('confirm'))).toBeTruthy()
  })

  it('holds the consent dialogue instead while one is up', async () => {
    /*
      AE11 from the layer's side. One presentation is on the layer at a time and the consent dialogue
      outranks the bar, so a picking session cannot put a bar over a question the user is being asked —
      and the core ends the session when the layer is taken.
    */
    const present = layer()
    present(presentation())
    await waitFor(() => expect(screen.getByRole('group')).toBeTruthy())

    present({
      kind: 'permission-request',
      requestId: 'perm-1',
      origin: 'https://example.com',
      subject: 'geolocation',
      devices: [],
      waiting: 0
    })

    await waitFor(() =>
      expect(screen.queryByRole('group', { name: t('label', { index: 2 }) })).toBeNull()
    )
    expect(noButton(t('confirm'))).toBeNull()
  })
})
