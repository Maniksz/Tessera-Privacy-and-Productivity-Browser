import { cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { AutofillSuggestSurface } from '../../src/renderer/src/surfaces/AutofillSuggestSurface.js'
import type {
  AutofillSuggestContent,
  AutofillSuggestPresentation
} from '@shared/overlay/surface.js'
import { FILL_REFUSALS, type FillRefusal } from '@shared/passwords/fill-policy.js'
import { DEFAULT_LOCALE, catalogs, interpolate } from '@shared/i18n/catalog.js'
import { AUTOFILL_SUGGEST_WIDTH, autofillSuggestHeight } from '@shared/passwords/suggest-bounds.js'

/**
 * The account picker, rendered.
 *
 * Five things can only be checked here, and each of them looks correct in a code review without
 * being correct on screen.
 *
 * The first is that every branch of the decision tree says *something*. The whole point of moving
 * this surface into the chrome is that pressing the badge always produces a visible answer, and the
 * failure this replaces is a browser that does nothing at all. A state that renders an empty box is
 * indistinguishable from a broken one, so each state is asserted against the sentence it draws.
 *
 * The second is that a refusal keeps its reason. `insecure-page` and `different-site` are different
 * conversations with the user — "this page is not encrypted" against "this is not the site the
 * password was saved for" — and collapsing eight reasons onto one wording is the exact regression
 * KTD6 exists to prevent. It would still compile, still render, and still be a lie.
 *
 * The third is that a choice carries two opaque ids and nothing else. A username in the answer would
 * be invisible in the UI and would put an account name back on the wire the surface exists to keep
 * it off; the assertion is on the whole payload, not on the fields it happens to check.
 *
 * The fourth is the keyboard, all of it: arrows walking the list, Return choosing what is focused,
 * Escape leaving. R3 requires this surface to be usable without a pointer, and a listbox that renders
 * beautifully and cannot be walked is unusable for exactly the user who most needs a password manager.
 *
 * The fifth is a negative: **no dismissal on a click outside.** With region `tile` the layer is cut to
 * the list's own rectangle, so a click beside the list lands in the page view and never arrives here.
 * A handler for it would be dead code that reads as the thing closing the list — and closing from
 * outside belongs to the core, which is also the only place that can take the badge's open state back.
 */

const messages = catalogs[DEFAULT_LOCALE] as Record<string, string>

/**
 * The same lookup the component performs with no provider above it, including the fallback to the
 * key, which is what `I18nContext`'s default value does.
 *
 * Compared against the catalogue rather than against English prose, so what is pinned is the
 * *mapping* — which key for which state — rather than a wording the catalogue may reword.
 */
function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(messages[key] ?? key, params)
}

/** The state → key mapping, written out here so a re-pointed sentence fails rather than passes. */
const REFUSAL_KEYS: Record<FillRefusal, string> = {
  'no-user-gesture': 'autofill.refusal.noUserGesture',
  'unsupported-scheme': 'autofill.refusal.unsupportedScheme',
  'insecure-page': 'autofill.refusal.insecurePage',
  'scheme-downgrade': 'autofill.refusal.schemeDowngrade',
  'different-site': 'autofill.refusal.differentSite',
  'cross-origin-frame': 'autofill.refusal.crossOriginFrame',
  'cross-origin-form-action': 'autofill.refusal.crossOriginFormAction',
  'no-password-field': 'autofill.refusal.noPasswordField'
}

const STATE_KEYS = [
  'autofill.suggest.locked',
  'autofill.suggest.empty',
  'autofill.suggest.disabled'
]

const ENTRIES: AutofillSuggestContent = {
  state: 'entries',
  entries: [
    { id: 'e1', username: 'ada@example.com' },
    { id: 'e2', username: 'grace@example.com' },
    { id: 'e3', username: 'lin@example.com' }
  ]
}

function presentation(
  content: AutofillSuggestContent = ENTRIES,
  overrides: Partial<AutofillSuggestPresentation> = {}
): AutofillSuggestPresentation {
  return {
    kind: 'autofill-suggest',
    requestId: 'fill-7',
    tileIndex: 1,
    bounds: {
      x: 320,
      y: 240,
      width: AUTOFILL_SUGGEST_WIDTH,
      height: autofillSuggestHeight(content)
    },
    content,
    ...overrides
  }
}

interface Handlers {
  chosen: Array<{ requestId: string; entryId: string }>
  unlocked: Array<{ requestId: string }>
  dismissed: Array<{ requestId: string }>
}

function draw(
  content: AutofillSuggestContent = ENTRIES,
  overrides: Partial<AutofillSuggestPresentation> = {}
): Handlers & { rerender: (next: AutofillSuggestPresentation) => void } {
  const handlers: Handlers = { chosen: [], unlocked: [], dismissed: [] }
  const props = {
    onChoose: (choice: { requestId: string; entryId: string }) => handlers.chosen.push(choice),
    onUnlock: (request: { requestId: string }) => handlers.unlocked.push(request),
    onDismiss: (request: { requestId: string }) => handlers.dismissed.push(request)
  }
  const { rerender } = render(
    <AutofillSuggestSurface presentation={presentation(content, overrides)} {...props} />
  )
  return {
    ...handlers,
    rerender: (next) => rerender(<AutofillSuggestSurface presentation={next} {...props} />)
  }
}

afterEach(cleanup)

describe('every state says something', () => {
  it('lists the saved accounts by name', () => {
    draw()
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'ada@example.com',
      'grace@example.com',
      'lin@example.com'
    ])
  })

  it('says an entry has no user name rather than drawing a blank row', () => {
    // Some sites authenticate on a password alone. A blank row is a row the user cannot choose
    // between and cannot tell from a rendering fault.
    draw({ state: 'entries', entries: [{ id: 'e1', username: '' }] })
    expect(screen.getByRole('option').textContent).toBe(t('autofill.suggest.noUsername'))
  })

  it('offers to unlock the vault rather than the list (AE1)', () => {
    draw({ state: 'locked' })
    expect(screen.getByRole('status').textContent).toBe(t('autofill.suggest.locked'))
    expect(screen.getByRole('button', { name: t('passwords.unlock') })).toBeTruthy()
    expect(screen.queryByRole('listbox')).toBe(null)
  })

  it('says nothing is saved for this site (AE2)', () => {
    draw({ state: 'empty' })
    expect(screen.getByRole('status').textContent).toBe(t('autofill.suggest.empty'))
    expect(screen.queryByRole('listbox')).toBe(null)
  })

  it('names the setting rather than doing nothing (AE9)', () => {
    draw({ state: 'disabled' })
    expect(screen.getByRole('status').textContent).toBe(t('autofill.suggest.disabled'))
  })

  it('names the rule that refused, one sentence per rule (AE4, KTD6)', () => {
    const drawn = new Set<string>()
    for (const reason of FILL_REFUSALS) {
      draw({ state: 'refused', reason })
      const said = screen.getByRole('status').textContent
      expect(said, `${reason} renders its own sentence`).toBe(t(REFUSAL_KEYS[reason]))
      expect(said.length, `${reason} has a wording at all`).toBeGreaterThan(0)
      expect(drawn.has(said), `${reason} shares its wording with another refusal`).toBe(false)
      drawn.add(said)
      cleanup()
    }
    expect(drawn.size).toBe(FILL_REFUSALS.length)
  })

  it("names the page's encryption rather than 'nothing found' (AE4)", () => {
    // The one refusal the acceptance example names, asserted on its own so the table above cannot
    // pass by mapping every reason to the same honest-looking sentence.
    draw({ state: 'refused', reason: 'insecure-page' })
    expect(screen.getByRole('status').textContent).toBe(t('autofill.refusal.insecurePage'))
    expect(screen.getByRole('status').textContent).not.toBe(t('autofill.suggest.empty'))
  })

  it('draws the notice, not an empty box, when an offer arrives with no entries', () => {
    /*
      The core sends `empty` for "nothing saved", so this is a shape that should not occur — which is
      why it is here. An `entries` state that happens to be empty must not render a listbox with no
      options: that is a surface holding the layer while saying nothing, the one outcome R8 forbids.
    */
    draw({ state: 'entries', entries: [] })
    expect(screen.queryByRole('listbox')).toBe(null)
    expect(screen.getByRole('status').textContent).toBe(t('autofill.suggest.empty'))
  })
})

describe('what a choice sends back', () => {
  it('sends the request id and the entry id, and nothing else', () => {
    const handlers = draw()
    screen.getAllByRole('option')[1]!.click()
    expect(handlers.chosen).toEqual([{ requestId: 'fill-7', entryId: 'e2' }])
    // The whole payload, not the two fields it happens to carry: a username here would be an
    // account name back on the wire this surface exists to keep it off.
    expect(Object.keys(handlers.chosen[0]!).sort()).toEqual(['entryId', 'requestId'])
  })

  it('echoes the request it was shown for, not the one before it', () => {
    const handlers = draw(ENTRIES, { requestId: 'fill-9' })
    screen.getAllByRole('option')[0]!.click()
    expect(handlers.chosen).toEqual([{ requestId: 'fill-9', entryId: 'e1' }])
  })

  it('asks for the vault to be unlocked and chooses nothing (AE1)', () => {
    const handlers = draw({ state: 'locked' })
    screen.getByRole('button', { name: t('passwords.unlock') }).click()
    expect(handlers.unlocked).toEqual([{ requestId: 'fill-7' }])
    expect(handlers.chosen).toEqual([])
    expect(handlers.dismissed).toEqual([])
  })
})

describe('the keyboard (AE10, KTD12)', () => {
  it('starts on the first account, so Return is a choice and not a guess', () => {
    draw()
    expect(document.activeElement).toBe(screen.getAllByRole('option')[0])
  })

  it('walks down and back up with the arrow keys', () => {
    draw()
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[1])

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[2])

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(options[1])
  })

  it('wraps rather than sticking at either end', () => {
    // A list of three is walked with three presses of one key; stopping at the end makes the user
    // find out which key they should have pressed instead.
    draw()
    const options = screen.getAllByRole('option')

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    expect(document.activeElement).toBe(options[2])

    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(options[0])
  })

  it('chooses the focused account on Return', () => {
    const handlers = draw()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    fireEvent.keyDown(document.activeElement!, { key: 'Enter' })
    expect(handlers.chosen).toEqual([{ requestId: 'fill-7', entryId: 'e2' }])
  })

  it('marks the walked-to option as the selected one', () => {
    draw()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    const selected = screen
      .getAllByRole('option')
      .map((option) => option.getAttribute('aria-selected'))
    expect(selected).toEqual(['false', 'true', 'false'])
  })

  it('leaves on Escape', () => {
    const handlers = draw()
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(handlers.dismissed).toEqual([{ requestId: 'fill-7' }])
    expect(handlers.chosen).toEqual([])
  })

  it('leaves on Escape from a state that has no list either', () => {
    // The notice states have nothing to walk, so Escape is the only way out of them from the
    // keyboard — and it is the state the user is most likely to want out of.
    const handlers = draw({ state: 'empty' })
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    expect(handlers.dismissed).toEqual([{ requestId: 'fill-7' }])
  })

  it('puts the focus on the unlock button, because it is the only thing to do here', () => {
    draw({ state: 'locked' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: t('passwords.unlock') }))
  })

  it('sends nothing for a keystroke that means nothing here', () => {
    const handlers = draw()
    fireEvent.keyDown(document.activeElement!, { key: 'a' })
    expect(handlers).toMatchObject({ chosen: [], unlocked: [], dismissed: [] })
  })

  it('starts again at the top when a new request replaces this one', () => {
    /*
      The core replaces the presentation in place — unlocking the vault turns `locked` into `entries`
      under the same component. Without a reset the second list would inherit the first's position,
      and a user one Return away from filling in an account they never looked at.
    */
    const handlers = draw()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
    handlers.rerender(presentation(ENTRIES, { requestId: 'fill-8' }))
    expect(document.activeElement).toBe(screen.getAllByRole('option')[0])
  })

  it('keeps its place inside a rectangle whose list has shrunk', () => {
    // Not a reset: the same request with fewer entries must not focus an option that is gone.
    const handlers = draw()
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
    handlers.rerender(
      presentation({ state: 'entries', entries: [{ id: 'e1', username: 'ada@example.com' }] })
    )
    expect(document.activeElement).toBe(screen.getByRole('option'))
  })
})

describe('what a screen reader is told', () => {
  it('gives the list listbox semantics with option entries', () => {
    draw()
    expect(screen.getByRole('listbox')).toBeTruthy()
    expect(screen.getAllByRole('option').length).toBe(3)
  })

  it('names the tile the field is in, so two lists are not the same list', () => {
    draw(ENTRIES, { tileIndex: 2 })
    // One-based for the user, zero-based in the presentation.
    expect(
      screen.getByRole('group', { name: t('autofill.suggest.label', { index: 3 }) })
    ).toBeTruthy()
  })

  it('announces each informational state politely', () => {
    for (const content of [
      { state: 'locked' },
      { state: 'empty' },
      { state: 'disabled' },
      { state: 'refused', reason: 'different-site' }
    ] satisfies AutofillSuggestContent[]) {
      draw(content)
      const region = screen.getByRole('status')
      expect(region.getAttribute('aria-live'), `${content.state} is announced`).toBe('polite')
      expect(region.textContent.length).toBeGreaterThan(0)
      cleanup()
    }
  })

  it('keeps the live region in the tree while the list is showing', () => {
    /*
      Inserted along with its text, a live region is not announced at all — so the state change the
      user most needs to hear, "the vault is locked" arriving where a list used to be, would be the
      one that is silent. It stays, empty, while there is a list.
    */
    const handlers = draw()
    const region = screen.getByRole('status')
    expect(region.textContent).toBe('')
    handlers.rerender(presentation({ state: 'locked' }))
    expect(screen.getByRole('status')).toBe(region)
    expect(region.textContent).toBe(t('autofill.suggest.locked'))
  })
})

describe('the list does not close itself', () => {
  it('ignores a pointer press outside it', () => {
    /*
      Region `tile` cuts the layer to this rectangle, so a press beside the list lands in the page
      view and never reaches this component at all. A handler for it would look like the thing that
      closes the list while never running, and the real closing — which also has to take the badge's
      open state back in the page — belongs to the core.
    */
    const handlers = draw()
    fireEvent.pointerDown(document.body)
    fireEvent.click(document.body)
    expect(handlers.dismissed).toEqual([])
  })

  it('does not dismiss when a press lands on its own padding', () => {
    const handlers = draw()
    fireEvent.pointerDown(
      screen.getByRole('group', { name: t('autofill.suggest.label', { index: 2 }) })
    )
    expect(handlers.dismissed).toEqual([])
  })
})

describe('both catalogues carry the wording', () => {
  it('has every key this surface renders, in German and in English', () => {
    const keys = [
      'autofill.suggest.label',
      'autofill.suggest.accounts',
      'autofill.suggest.noUsername',
      'passwords.unlock',
      ...STATE_KEYS,
      ...Object.values(REFUSAL_KEYS)
    ]
    for (const key of keys) {
      for (const locale of ['de', 'en'] as const) {
        const message = (catalogs[locale] as Record<string, string>)[key]
        expect(message, `${key} is missing from ${locale}`).toBeTruthy()
      }
    }
  })

  it('translates the refusals rather than repeating the English', () => {
    // Eight sentences copied across is the shape a machine-filled catalogue has, and it would pass
    // the presence check above while leaving a German user reading English.
    for (const key of Object.values(REFUSAL_KEYS)) {
      expect((catalogs.de as Record<string, string>)[key], `${key} was not translated`).not.toBe(
        (catalogs.en as Record<string, string>)[key]
      )
    }
  })
})
