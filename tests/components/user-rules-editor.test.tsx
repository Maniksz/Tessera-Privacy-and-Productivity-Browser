import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  UserRulesEditor,
  type EditableUserRule,
  type UserRulesHost
} from '@renderer-shared/UserRulesEditor.js'

/**
 * The box the user types filter rules into, and the list of what they have typed.
 *
 * ## What this is the other half of
 *
 * `user-rules.ts` states the requirement: *"The three operations that matter are not 'add': they are see,
 * disable, delete."* All three had core handlers and no caller, and there was no add channel at all — so the
 * element picker was the only writer in the browser and nothing could show a rule back. Asked for as being
 * able to enter procedural selectors *"wie bei uBlock origin selber"*, which needs somewhere to type.
 *
 * ## What is asserted
 *
 * The three answers, because two of them are not failures and each has to reach the user differently: a rule
 * is stored, a rule is already there, or the line is not one this build can honour. A surface that treated the
 * last two as errors — or as success — would be the defect the whole channel shape was chosen to avoid.
 *
 * The words are stubbed rather than real, and that is deliberate: they come from the core (see
 * `main/settings/user-rules-text.ts`, and `tests/settings-describe.test.ts` holds the two locales to each
 * other). What this file is about is the behaviour around them.
 */

const TEXT: Record<string, string> = {
  heading: 'My filter rules',
  hint: 'One rule per line.',
  placeholder: 'example.com##.banner-ad',
  add: 'Add rule',
  empty: 'No rules of your own yet.',
  invalid: 'This is not a rule this browser can apply.',
  duplicate: 'You already have that rule.',
  toggle: 'Apply this rule',
  remove: 'Delete this rule',
  kindDeclarative: 'CSS',
  kindProcedural: 'matched by script',
  originPicker: 'from the element picker',
  originManual: 'typed',
  disabled: 'not applied'
}

function rule(overrides: Partial<EditableUserRule> = {}): EditableUserRule {
  return {
    id: 'r1',
    text: 'example.com##.banner-ad',
    enabled: true,
    createdAt: 10,
    origin: 'manual',
    kind: 'declarative',
    ...overrides
  }
}

interface Harness {
  host: UserRulesHost
  added: string[]
  toggled: Array<{ id: string; enabled: boolean }>
  removed: string[]
}

function harness(options: {
  rules?: EditableUserRule[]
  outcome?: 'added' | 'invalid' | 'duplicate'
  /** Refuses the initial read, which is a different path from a refused write. */
  refuseList?: string
  refuseRemove?: string
} = {}): Harness {
  const added: string[] = []
  const toggled: Array<{ id: string; enabled: boolean }> = []
  const removed: string[] = []
  let rules = options.rules ?? []

  return {
    added,
    toggled,
    removed,
    host: {
      list: () =>
        options.refuseList === undefined
          ? Promise.resolve({ rules, text: TEXT })
          : Promise.reject(new Error(options.refuseList)),
      add: (text) => {
        added.push(text)
        const outcome = options.outcome ?? 'added'
        // Stored on success, so the re-read the editor does afterwards shows it — which is the behaviour
        // being tested rather than a convenience of the stub.
        if (outcome === 'added') rules = [...rules, rule({ id: `r${rules.length + 1}`, text })]
        return Promise.resolve(outcome)
      },
      setEnabled: (id, enabled) => {
        toggled.push({ id, enabled })
        rules = rules.map((entry) => (entry.id === id ? { ...entry, enabled } : entry))
        return Promise.resolve()
      },
      remove: (id) => {
        removed.push(id)
        if (options.refuseRemove !== undefined) return Promise.reject(new Error(options.refuseRemove))
        rules = rules.filter((entry) => entry.id !== id)
        return Promise.resolve()
      }
    }
  }
}

/**
 * Renders and waits for the words to arrive.
 *
 * The editor renders nothing until they do — the labels come from the core with the rules, and a text box with
 * no accessible name is a control nobody can identify. So every test here goes through this rather than
 * querying synchronously and finding an empty section.
 */
async function editor(host: UserRulesHost): Promise<void> {
  render(<UserRulesEditor host={host} />)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add rule' })).toBeTruthy())
}

afterEach(cleanup)

describe('typing a rule', () => {
  it('sends the line and clears the box', async () => {
    const { host, added } = harness()
    await editor(host)

    fireEvent.change(screen.getByLabelText('My filter rules'), {
      target: { value: '  example.com##.box:has-text(Anzeige)  ' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))

    // Trimmed: a trailing space in a filter rule is not part of the selector, and the store would keep it.
    return waitFor(() => {
      expect(added).toEqual(['example.com##.box:has-text(Anzeige)'])
      expect(screen.getByLabelText('My filter rules')).toHaveProperty('value', '')
    })
  })

  it('submits on Enter, which is how a one-line box is used', async () => {
    const { host, added } = harness()
    await editor(host)
    const box = screen.getByLabelText('My filter rules')
    fireEvent.change(box, { target: { value: 'example.com##.ad' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    await waitFor(() => expect(added).toEqual(['example.com##.ad']))
  })

  it('sends nothing for an empty box', async () => {
    const { host, added } = harness()
    await editor(host)
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    expect(added).toEqual([])
  })

  it('says why a line was refused and keeps it for correcting', async () => {
    /*
      The box is deliberately *not* cleared here. A refused line is usually one character wrong — a missing
      `#`, a host with a typo — and clearing it would mean typing the whole rule again to fix it.
    */
    const { host } = harness({ outcome: 'invalid' })
    await editor(host)
    fireEvent.change(screen.getByLabelText('My filter rules'), {
      target: { value: '||ads.example.com^' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))

    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'This is not a rule this browser can apply.'
      )
    )
    expect(screen.getByLabelText('My filter rules')).toHaveProperty('value', '||ads.example.com^')
  })

  it('says a rule is already there, and does not call it an error', async () => {
    // A duplicate is an answer, not a failure: the rule the user wants exists. `role="status"` rather than
    // `role="alert"` is the difference between telling them and alarming them.
    const { host } = harness({ outcome: 'duplicate', rules: [rule()] })
    await editor(host)
    fireEvent.change(screen.getByLabelText('My filter rules'), {
      target: { value: 'example.com##.banner-ad' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))

    await waitFor(() =>
      expect(screen.getByRole('status').textContent).toBe('You already have that rule.')
    )
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('drops the verdict as soon as the line changes', async () => {
    // It belonged to the line that produced it. Left up, it is a refusal of something already corrected.
    const { host } = harness({ outcome: 'invalid' })
    await editor(host)
    const box = screen.getByLabelText('My filter rules')
    fireEvent.change(box, { target: { value: 'bad' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }))
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy())

    fireEvent.change(box, { target: { value: 'example.com##.ad' } })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('the rules already stored', () => {
  it('shows each rule as written, with how it will be applied', async () => {
    /*
      The line verbatim, because it is the only form the user can recognise — a rule reconstructed from a
      parsed chain would be *a* correct spelling and not the one they typed.

      And `kind`, because the two are not the same promise: a declarative rule is a line in a stylesheet the
      browser matches, a procedural one is script re-run on every mutation burst.
    */
    const { host } = harness({
      rules: [
        rule({ id: 'a', text: 'example.com##.banner-ad', kind: 'declarative', origin: 'picker' }),
        rule({ id: 'b', text: 'shop.example##.box:has-text(Anzeige)', kind: 'procedural' })
      ]
    })
    await editor(host)

    await waitFor(() => expect(screen.getByText('example.com##.banner-ad')).toBeTruthy())
    expect(screen.getByText('shop.example##.box:has-text(Anzeige)')).toBeTruthy()
    expect(screen.getByText(/matched by script/)).toBeTruthy()
    expect(screen.getByText(/from the element picker/)).toBeTruthy()
  })

  it('switches one off without deleting it', async () => {
    /*
      Disable rather than delete is the operation for a page that broke: it keeps the line so the list can
      still be read, which is why `enabled` is stored rather than implied by presence.
    */
    const { host, toggled } = harness({ rules: [rule()] })
    await editor(host)
    await waitFor(() => expect(screen.getByText('example.com##.banner-ad')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Apply this rule: example.com##.banner-ad'))
    await waitFor(() => expect(toggled).toEqual([{ id: 'r1', enabled: false }]))
    // Re-read after the write, so the row shows what was stored rather than what was sent.
    await waitFor(() => expect(screen.getByText(/not applied/)).toBeTruthy())
  })

  it('deletes the rule it was asked to', async () => {
    const { host, removed } = harness({ rules: [rule()] })
    await editor(host)
    await waitFor(() => expect(screen.getByText('example.com##.banner-ad')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Delete this rule: example.com##.banner-ad'))
    await waitFor(() => expect(removed).toEqual(['r1']))
    await waitFor(() => expect(screen.getByText('No rules of your own yet.')).toBeTruthy())
  })

  it('names the rule in every control, so the list is usable without sight', async () => {
    // Two checkboxes labelled "Apply this rule" would be two identical announcements for different rules.
    const { host } = harness({
      rules: [rule({ id: 'a', text: 'a.example##.x' }), rule({ id: 'b', text: 'b.example##.y' })]
    })
    await editor(host)
    await waitFor(() => expect(screen.getByLabelText('Apply this rule: a.example##.x')).toBeTruthy())
    expect(screen.getByLabelText('Apply this rule: b.example##.y')).toBeTruthy()
  })

  it('says the list could not be read rather than showing an empty one', async () => {
    /*
      The failure `useCoreCall` exists for. "You have no rules" and "the browser would not say" are the same
      picture otherwise, and one of them is a reason to write a rule while the other is a reason to look at
      the log.
    */
    const { host } = harness({ refuseList: 'core is not ready' })
    render(<UserRulesEditor host={host} />)
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('core is not ready'))
  })

  it('says a refused deletion was refused, and keeps the rule listed', async () => {
    const { host } = harness({ rules: [rule()], refuseRemove: 'the rules are locked' })
    await editor(host)
    await waitFor(() => expect(screen.getByText('example.com##.banner-ad')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Delete this rule: example.com##.banner-ad'))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('the rules are locked')
    )
    // Still there, which is the truth: nothing was deleted.
    expect(screen.getByText('example.com##.banner-ad')).toBeTruthy()
  })

  it('reads the list once for a stable host', async () => {
    // The effect is keyed on the host, so a host that keeps its identity must not refetch on every render —
    // the settings page memoises its host for exactly this reason.
    const list = vi.fn(() => Promise.resolve({ rules: [] as EditableUserRule[], text: TEXT }))
    const host: UserRulesHost = {
      list,
      add: () => Promise.resolve('added'),
      setEnabled: () => Promise.resolve(),
      remove: () => Promise.resolve()
    }
    const { rerender } = render(<UserRulesEditor host={host} />)
    await waitFor(() => expect(screen.getByText('No rules of your own yet.')).toBeTruthy())
    rerender(<UserRulesEditor host={host} />)
    expect(list).toHaveBeenCalledTimes(1)
  })
})

/**
 * The block's answer to the settings search box.
 *
 * It used to have none: `SettingsView` rendered it only while the box was empty. The argument was
 * consistent — the search filters setting descriptors by label and key, and a block it cannot filter
 * would sit there while everything around it disappeared — but the consequence inverted the block's
 * whole purpose. Somebody looking for their filter rules types the word for them, and typing the word
 * made the only screen that shows them go away. It was reported as there being no field for the rules
 * at all, and from outside the code that is exactly what it was.
 *
 * So there are two ways in, and they answer different questions: *where is this feature* is matched
 * against the heading and the explanation, and *which rule broke this site* is matched against the
 * rules themselves. The second is the one the plain list could not do — five hundred rules is a
 * scroll, and the one that broke a page is findable by typing its host.
 */
describe('searching the settings page', () => {
  async function editorWithQuery(host: UserRulesHost, query: string): Promise<void> {
    render(<UserRulesEditor host={host} query={query} />)
    // Awaited on the *rules* rather than on the add button: a query that matches nothing renders no
    // section at all, and there would be nothing to wait for.
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
  }

  it('shows the whole block when the search names the feature', async () => {
    const { host } = harness({ rules: [rule()] })
    await editorWithQuery(host, 'filter')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add rule' })).toBeTruthy())
    expect(screen.getByText('example.com##.banner-ad')).toBeTruthy()
  })

  it('narrows to the rule when the search names a site', async () => {
    const { host } = harness({
      rules: [rule(), rule({ id: 'r2', text: 'other.test##.promo' })]
    })
    await editorWithQuery(host, 'other.test')
    await waitFor(() => expect(screen.getByText('other.test##.promo')).toBeTruthy())
    // The point of narrowing: the rule that is not being looked for is gone rather than merely below.
    expect(screen.queryByText('example.com##.banner-ad')).toBeNull()
  })

  it('matches a rule whatever case it was typed in', async () => {
    const { host } = harness({ rules: [rule({ text: 'Example.COM##.banner-ad' })] })
    await editorWithQuery(host, 'example.com')
    await waitFor(() => expect(screen.getByText('Example.COM##.banner-ad')).toBeTruthy())
  })

  it('disappears entirely when nothing here answers what was typed', async () => {
    /*
      Rather than a heading with an empty list under it, which would read as "you have no rules" — a
      statement that is false and that would send somebody off to write one they already have.
    */
    const { host } = harness({ rules: [rule()] })
    /*
      Rendered with no query first and then re-rendered with one, rather than asserting an absence
      straight away: the block renders nothing until the words arrive from the core either, so a test
      that only looked for it to be missing would pass before the load had finished and would go on
      passing if the search stopped working entirely.
    */
    const { rerender } = render(<UserRulesEditor host={host} query="" />)
    await waitFor(() => expect(screen.getByText('My filter rules')).toBeTruthy())

    rerender(<UserRulesEditor host={host} query="proxy" />)
    expect(screen.queryByText('My filter rules')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add rule' })).toBeNull()
  })

  it('is there in full when nothing is being searched for', async () => {
    const { host } = harness({ rules: [rule()] })
    await editorWithQuery(host, '   ')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add rule' })).toBeTruthy())
    expect(screen.getByText('example.com##.banner-ad')).toBeTruthy()
  })
})
