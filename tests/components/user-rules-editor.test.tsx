import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UserRulesEditor,
  type EditableUserRule,
  type UserRulesAnswer,
  type UserRulesHost
} from '@renderer-shared/UserRulesEditor.js'
import { describeUserRule, type UserRule } from '@shared/filters/user-rules.js'
import {
  applyUserRuleSource,
  projectUserRuleSource,
  type ApplyUserRuleSourceOutcome
} from '@shared/filters/user-rules-source.js'

/**
 * The user's own filter rules, as one text (U8, R17).
 *
 * ## What changed, and what this file asserts because of it
 *
 * This was a one-line box and a list with a switch and a delete button per rule. The list was chosen over
 * a text because a whole-document save would need "a per-line error report next to a textarea" — messages
 * about lines the user has to count to find. The user asked for the text anyway, like uBlock Origin's own
 * filter box, and the answer to the objection is the thing tested most here: **a refused line is marked
 * where it stands**, the lines around it are saved, and the mark follows the line rather than a line number.
 *
 * ## Why the harness runs the real projection
 *
 * The core's half — which line is which rule, what a comment may become — is pure and tested on its own in
 * `tests/filter-user-rules-source.test.ts`. The fake core here runs those same functions rather than
 * hand-written answers, so what this file sees after a save is what the core would really send back: a
 * collapsed duplicate, a kept note, a refused line kept in place. A stub that answered what each test
 * expected would pass while the editor and the core disagreed.
 *
 * The words are stubbed rather than real: they come from the core (`main/settings/user-rules-text.ts`),
 * and what this file is about is the behaviour around them.
 */

const TEXT: Record<string, string> = {
  heading: 'My filter rules',
  hint: 'One rule per line.',
  placeholder: 'example.com##.banner-ad',
  save: 'Save rules',
  discard: 'Discard changes',
  saved: 'Saved.',
  rejected: 'The marked lines are not applied.',
  rejectedMark: 'not applied',
  rejectedLines: 'Lines not applied:',
  limitReached: 'This text holds more rules than this browser will keep.',
  sessionNote: 'This is a private window.',
  kindProcedural: 'matched by script',
  originPicker: 'from the element picker'
}

function rule(overrides: Partial<UserRule> = {}): UserRule {
  return {
    id: 'r1',
    text: 'example.com##.banner-ad',
    enabled: true,
    createdAt: 10,
    origin: 'manual',
    ...overrides
  }
}

interface Harness {
  host: UserRulesHost
  applied: string[]
  rules: () => UserRule[]
  /** A rule written behind the page's back — the element picker in another window. */
  write: (entry: UserRule) => void
}

/** A core with the real projection in it; see the file's docblock for why. */
function harness(
  options: {
    rules?: UserRule[]
    source?: string
    session?: boolean
    /** Answers every save with this instead of applying it. */
    outcome?: ApplyUserRuleSourceOutcome
    refuseList?: string
    refuseApply?: string
  } = {}
): Harness {
  let rules = options.rules ?? []
  let source = options.source
  let ids = 0
  const applied: string[] = []

  const answer = (): UserRulesAnswer => {
    const view = projectUserRuleSource(rules, source)
    return {
      rules: rules.map((entry): EditableUserRule => ({
        ...entry,
        kind: describeUserRule(entry.text)?.kind ?? 'declarative'
      })),
      text: TEXT,
      source: view.source,
      rejected: view.rejected,
      session: options.session ?? false
    }
  }

  return {
    applied,
    rules: () => rules,
    write: (entry) => {
      rules = [...rules, entry]
    },
    host: {
      list: () =>
        options.refuseList === undefined
          ? Promise.resolve(answer())
          : Promise.reject(new Error(options.refuseList)),
      apply: (text, loadedIds) => {
        applied.push(text)
        if (options.refuseApply !== undefined) return Promise.reject(new Error(options.refuseApply))
        if (options.outcome !== undefined) return Promise.resolve(options.outcome)
        const result = applyUserRuleSource({ rules, source }, text, {
          nextId: () => `n${(ids += 1)}`,
          now: 99,
          loaded: new Set(loadedIds)
        })
        rules = result.rules
        source = result.source
        return Promise.resolve(result.outcome)
      }
    }
  }
}

/**
 * Renders and waits for the words to arrive.
 *
 * The editor renders nothing until they do — the labels come from the core with the rules, and a text box
 * with no accessible name is a control nobody can identify.
 */
async function editor(host: UserRulesHost): Promise<HTMLTextAreaElement> {
  render(<UserRulesEditor host={host} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save rules' })).toBeTruthy())
  return box()
}

function box(): HTMLTextAreaElement {
  return screen.getByLabelText<HTMLTextAreaElement>('My filter rules')
}

function type(text: string): void {
  fireEvent.change(box(), { target: { value: text } })
}

function save(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Save rules' }))
}

/** The line drawn under the box, with the marks beside it — what the user sees in place. */
function drawnLines(): Array<{ text: string; marks: string; rejected: boolean; match: boolean }> {
  return [...document.querySelectorAll('.userrules__line')].map((line) => ({
    text: line.querySelector('.userrules__ghost')?.textContent ?? '',
    marks: line.querySelector('.userrules__tag')?.textContent ?? '',
    rejected: line.classList.contains('userrules__line--rejected'),
    match: line.classList.contains('userrules__line--match')
  }))
}

afterEach(cleanup)

describe('the rules as one text', () => {
  it('shows every rule as a line, a switched-off one commented out', async () => {
    const { host } = harness({
      rules: [rule(), rule({ id: 'r2', text: 'shop.example##.promo', enabled: false })]
    })
    expect((await editor(host)).value).toBe('example.com##.banner-ad\n! shop.example##.promo')
    // A text box, not a row of controls per rule.
    expect(box().tagName).toBe('TEXTAREA')
    expect(screen.queryByRole('checkbox')).toBeNull()
  })

  it('sends the whole text and shows what the core kept', async () => {
    /*
      Re-read after the save rather than left as typed: the core folds a repeated rule onto its first line
      and writes a rule in its plain form, and a box that went on showing what was *sent* would disagree
      with what was stored until the next reload.
    */
    const { host, applied } = harness({ rules: [rule()] })
    await editor(host)
    type('example.com##.banner-ad\n   new.example##.x   \nnew.example##.x\n')
    save()

    await waitFor(() => expect(box().value).toBe('example.com##.banner-ad\nnew.example##.x'))
    expect(applied).toEqual(['example.com##.banner-ad\n   new.example##.x   \nnew.example##.x\n'])
    expect(screen.getByRole('status').textContent).toBe('Saved.')
  })

  it('keeps a rule written while the page was open, and shows it after the save', async () => {
    /*
      The page's text has no line for a rule the picker wrote after it loaded, because there was none to
      show. Saving that text must not read the missing line as a deletion — the rule would be gone without
      the user ever having seen it.
    */
    const { host, rules, write } = harness({
      rules: [rule(), rule({ id: 'r2', text: 'shop.example##.promo' })]
    })
    await editor(host)
    write(rule({ id: 'late', text: 'late.example##.x', origin: 'picker' }))
    type('example.com##.banner-ad')
    save()

    await waitFor(() => expect(box().value).toBe('example.com##.banner-ad\nlate.example##.x'))
    expect(rules().map((entry) => entry.id)).toEqual(['r1', 'late'])
  })

  it('keeps notes and blank lines through a save', async () => {
    const { host } = harness()
    await editor(host)
    type('! the shop\nshop.example##.promo\n\n! the news site\nnews.example##.ad')
    save()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(box().value).toBe(
      '! the shop\nshop.example##.promo\n\n! the news site\nnews.example##.ad'
    )
  })

  it('offers to save or discard only once something has changed', async () => {
    const { host } = harness({ rules: [rule()] })
    await editor(host)
    const saveButton = screen.getByRole<HTMLButtonElement>('button', { name: 'Save rules' })
    const discard = screen.getByRole<HTMLButtonElement>('button', { name: 'Discard changes' })
    expect([saveButton.disabled, discard.disabled]).toEqual([true, true])

    type('example.com##.banner-ad\nother.example##.x')
    expect([saveButton.disabled, discard.disabled]).toEqual([false, false])
  })

  it('puts the saved text back when the changes are discarded', async () => {
    const { host, applied } = harness({ rules: [rule()] })
    await editor(host)
    type('')
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }))
    expect(box().value).toBe('example.com##.banner-ad')
    expect(applied).toEqual([])
  })

  it('says which lines are matched by script and which the picker wrote', async () => {
    // The two costs are not the same promise, and a text box would otherwise show them identically.
    const { host } = harness({
      rules: [
        rule({ id: 'a', text: 'shop.example##.box:has-text(Anzeige)' }),
        rule({ id: 'b', text: 'example.com##.banner-ad', origin: 'picker', enabled: false })
      ]
    })
    await editor(host)
    expect(drawnLines()).toEqual([
      {
        text: 'shop.example##.box:has-text(Anzeige)',
        marks: 'matched by script',
        rejected: false,
        match: false
      },
      {
        text: '! example.com##.banner-ad',
        marks: 'from the element picker',
        rejected: false,
        match: false
      }
    ])
  })
})

describe('a line the browser refuses', () => {
  it('is marked where it stands, and the other lines are saved', async () => {
    const { host, rules } = harness({ rules: [rule()] })
    await editor(host)
    type('example.com##.banner-ad\n||ads.example^\nnew.example##.x')
    save()

    await waitFor(() => expect(drawnLines()[1]?.rejected).toBe(true))
    expect(drawnLines().map((line) => [line.rejected, line.marks])).toEqual([
      [false, ''],
      [true, 'not applied'],
      [false, '']
    ])
    // Not blocking the rest: both rules are stored, and the refused line is still there to be corrected.
    expect(rules().map((entry) => entry.text)).toEqual([
      'example.com##.banner-ad',
      'new.example##.x'
    ])
    expect(box().value).toBe('example.com##.banner-ad\n||ads.example^\nnew.example##.x')
    expect(box().getAttribute('aria-invalid')).toBe('true')
  })

  it('explains the mark once, and tells a screen reader which lines it is on', async () => {
    const { host } = harness()
    await editor(host)
    type('a.example##.x\n||ads.example^\nb.example##.y\nnonsense')
    save()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe('The marked lines are not applied. Lines not applied: 2, 4')
    // Not "Saved." as well: the sentence above is the answer to this save.
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('is marked again when the page is opened later', async () => {
    // The refused line is kept in the saved text, so it does not vanish on the first save and take the
    // only copy of whatever the user was trying to write with it.
    const { host } = harness({ source: 'example.com##.banner-ad\n||ads.example^', rules: [rule()] })
    await editor(host)
    expect(drawnLines().map((line) => line.rejected)).toEqual([false, true])
  })

  it('loses its mark as soon as the line is edited, wherever it has moved to', async () => {
    const { host } = harness({ source: '||ads.example^' })
    await editor(host)
    type('! a note above it\n||ads.example^')
    // Moved down one line, still the same text, still marked.
    expect(drawnLines().map((line) => line.rejected)).toEqual([false, true])

    type('! a note above it\n||ads.example^$third-party')
    // Corrected: a line nobody has judged yet.
    expect(drawnLines().map((line) => line.rejected)).toEqual([false, false])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stays a note when it is commented out, and a commented network rule is no rule', async () => {
    const { host, rules } = harness()
    await editor(host)
    type('! ||ads.example^')
    save()
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Saved.'))
    expect(rules()).toEqual([])
    expect(drawnLines().map((line) => line.rejected)).toEqual([false])
  })
})

describe('a text over the limit', () => {
  it('is refused as a whole, and the text stays for trimming', async () => {
    /*
      Nothing written, nothing deleted (R18). The box is deliberately not reset to what is stored: the
      user's text is the thing they have to shorten, and replacing it would lose every line they added.
    */
    const { host } = harness({ rules: [rule()], outcome: 'limit-reached' })
    await editor(host)
    type('example.com##.banner-ad\none.too.many##.x')
    save()

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This text holds more rules than this browser will keep.'
      )
    )
    expect(box().value).toBe('example.com##.banner-ad\none.too.many##.x')
  })

  it('drops the refusal as soon as the text changes', async () => {
    // It belonged to the text that produced it. Left up, it is a refusal of something already corrected.
    const { host } = harness({ outcome: 'limit-reached' })
    await editor(host)
    type('a.example##.x')
    save()
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())
    type('b.example##.x')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('in a private window', () => {
  it('says what a change here does and does not do', async () => {
    // The limitation is surfaced rather than papered over: a stored rule switched off here keeps
    // applying in this window, because stored rules reach every window through the engine's one slot.
    const { host } = harness({ session: true })
    await editor(host)
    expect(screen.getByRole('note').textContent).toBe('This is a private window.')
  })

  it('says nothing of the kind in a normal one', async () => {
    const { host } = harness()
    await editor(host)
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('when the core refuses', () => {
  it('says the list could not be read rather than showing an empty one', async () => {
    /*
      The failure `useCoreCall` exists for. "You have no rules" and "the browser would not say" are the same
      picture otherwise, and one of them is a reason to write a rule while the other is a reason to look at
      the log.
    */
    const { host } = harness({ refuseList: 'core is not ready' })
    render(<UserRulesEditor host={host} />)
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('core is not ready')
    )
  })

  it('says a refused save was refused, and keeps the text', async () => {
    const { host } = harness({ rules: [rule()], refuseApply: 'the rules are locked' })
    await editor(host)
    type('')
    save()
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('the rules are locked')
    )
    expect(box().value).toBe('')
  })

  it('reads the list once for a stable host', async () => {
    // The effect is keyed on the host, so a host that keeps its identity must not refetch on every render —
    // the settings page memoises its host for exactly this reason.
    const { host: real } = harness()
    const list = vi.fn(real.list)
    const host: UserRulesHost = { list, apply: real.apply }
    const { rerender } = render(<UserRulesEditor host={host} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save rules' })).toBeTruthy())
    rerender(<UserRulesEditor host={host} />)
    expect(list).toHaveBeenCalledTimes(1)
  })
})

/**
 * The block's answer to the settings search box.
 *
 * Two ways in, because they answer different questions: *where is this feature* is matched against the
 * heading and the explanation, and *which rule broke this site* against the lines of the text. The list
 * used to narrow to the matching rule; a text cannot hide lines without losing them from the save, so it
 * marks them instead — the rule that broke a page is still findable by typing its host.
 */
describe('searching the settings page', () => {
  async function editorWithQuery(host: UserRulesHost, query: string): Promise<void> {
    const { rerender } = render(<UserRulesEditor host={host} query="" />)
    await waitFor(() => expect(screen.getByText('My filter rules')).toBeTruthy())
    rerender(<UserRulesEditor host={host} query={query} />)
  }

  it('shows the whole block when the search names the feature', async () => {
    const { host } = harness({ rules: [rule()] })
    await editorWithQuery(host, 'filter')
    expect(box().value).toBe('example.com##.banner-ad')
    expect(drawnLines().map((line) => line.match)).toEqual([false])
  })

  it('marks the rule when the search names a site, whatever case it was typed in', async () => {
    const { host } = harness({
      rules: [
        rule({ text: 'Example.COM##.banner-ad' }),
        rule({ id: 'r2', text: 'other.test##.promo' })
      ]
    })
    await editorWithQuery(host, 'example.com')
    expect(drawnLines().map((line) => line.match)).toEqual([true, false])
  })

  it('disappears entirely when nothing here answers what was typed', async () => {
    /*
      Rather than a heading over a text with nothing marked in it, which would read as "none of your rules
      is about this" — true, but an answer the sections that *do* match are better placed to give.
    */
    const { host } = harness({ rules: [rule()] })
    await editorWithQuery(host, 'proxy')
    expect(screen.queryByText('My filter rules')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save rules' })).toBeNull()
  })

  it('is there in full when nothing is being searched for', async () => {
    const { host } = harness({ rules: [rule()] })
    await editorWithQuery(host, '   ')
    expect(box().value).toBe('example.com##.banner-ad')
  })
})
