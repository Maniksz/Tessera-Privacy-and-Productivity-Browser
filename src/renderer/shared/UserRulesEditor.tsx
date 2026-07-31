import { useCallback, useEffect, useState } from 'react'
import type { UserRule } from '@shared/filters/user-rules.js'
import { useCoreCall } from './useCoreCall.js'

/**
 * The user's own filter rules: see them, write them, switch one off, delete it.
 *
 * ## What was missing, and it was the whole feature
 *
 * `user-rules.ts` states the requirement in its own docblock: *"The three operations that matter are not
 * 'add': they are see, disable, delete."* All three had core handlers and **no caller**, and there was no
 * `userrules:add` channel at all — so the element picker was the only thing in the browser that could write
 * a rule, and nothing could show one. A rule that hid the wrong element was permanent and unfindable.
 *
 * The blocker menu now lists the rules for the site in front of the user, which answers *"why is this page
 * broken"*. This is the other half: the whole list, and a box to type into. Asked for as wanting to enter
 * procedural selectors *"wie bei uBlock origin selber"* — uBO's own filter box is exactly this shape.
 *
 * ## Why one line at a time rather than uBO's whole-textarea
 *
 * uBO edits its filters as one document and saves the lot. That is the right shape when the browser can
 * accept any line and report on the file afterwards; here every line goes through `describeUserRule`, which
 * refuses request-blocking syntax and scriptlets outright. A whole-document save would therefore need a
 * per-line error report next to a textarea — several messages about lines the user has to count to find.
 * One line at a time puts the refusal beside the thing refused, and the stored rules are still individually
 * editable below because each is its own row.
 *
 * ## Where the words come from
 *
 * The core, on the same answer as the rules. `main/settings/user-rules-text.ts` explains why: the shared
 * message catalogue is one chunk that every internal page fetches before first paint, it is held to a
 * measured budget, and fourteen sentences about filter syntax should not be downloaded by the start page.
 */

/** A rule with what the core worked out about it. `kind` decides which cost the row reports. */
export interface EditableUserRule extends UserRule {
  readonly kind: 'declarative' | 'procedural'
}

export type AddRuleOutcome = 'added' | 'invalid' | 'duplicate'

/**
 * What this component needs from the browser.
 *
 * Named operations rather than a generic `invoke`, for the reason `SettingsHost` gives: it is what lets a
 * test drive the editor without a bridge, and it keeps a channel union out of a component that has no
 * business knowing one.
 */
export interface UserRulesHost {
  list(): Promise<{ rules: EditableUserRule[]; text: Record<string, string> }>
  add(text: string): Promise<AddRuleOutcome>
  setEnabled(id: string, enabled: boolean): Promise<void>
  remove(id: string): Promise<void>
}

export function UserRulesEditor({ host }: { host: UserRulesHost }): React.ReactNode {
  const [rules, setRules] = useState<EditableUserRule[]>([])
  const [text, setText] = useState<Record<string, string>>({})
  const [draft, setDraft] = useState('')
  const [outcome, setOutcome] = useState<AddRuleOutcome | null>(null)
  /*
    Every call goes through `useCoreCall`, which holds the refusal and the try/catch.

    Not a convenience. That hook exists because four surfaces here surfaced a *write* refusal and dropped
    every other one — including the first load, which rendered an empty screen for "the core refused". An
    empty rule list and a refused `userrules:list` look identical, and one of them means "you have no rules"
    while the other means the browser would not say.
  */
  const { error, run } = useCoreCall()

  const word = (key: string): string => text[key] ?? ''

  /*
    One re-read after every write, rather than patching the local array.

    The store repairs, deduplicates and trims to a maximum on the way in, so what it kept is not always what
    was sent. This is the same rule the settings page follows for the same reason — a screen that displayed
    what it *sent* disagrees with what was stored, and the disagreement survives until a reload.
  */
  const refresh = useCallback(async () => {
    const answer = await host.list()
    setRules(answer.rules)
    setText(answer.text)
  }, [host])

  /*
    An async body inside `run`, with a cancellation flag, rather than `void refresh()`.

    The same shape `SettingsView`'s first load uses and for the reason written there: a state write attached
    to a promise in an effect body has no relationship to the effect's own cleanup, which is what the
    `react-hooks` rule flags — and the flag is what stops a late answer from writing into an unmounted tree.
  */
  useEffect(() => {
    let cancelled = false
    void run(async () => {
      const answer = await host.list()
      if (cancelled) return
      setRules(answer.rules)
      setText(answer.text)
    })
    return () => {
      cancelled = true
    }
  }, [host, run])

  const submit = async (): Promise<void> => {
    const line = draft.trim()
    if (line === '') return
    await run(async () => {
      const result = await host.add(line)
      setOutcome(result)
      // The box is cleared only on success, so a refused line stays there to be corrected rather than
      // having to be typed again.
      if (result === 'added') setDraft('')
      await refresh()
    })
  }

  const act = (action: () => Promise<void>): void => {
    void run(async () => {
      await action()
      await refresh()
    })
  }

  /*
    Nothing is rendered before the words arrive, and a test is what made that explicit.

    The words come from the core with the rules, so on the first pass `text` is empty — and the version that
    rendered anyway produced a text box with no accessible name and a button with no label. `PermissionSurface`
    states the principle for a prompt: *"the one thing a consent dialogue may never do is present a button
    before it can say what the button agrees to"*. It is weaker here, because nothing irreversible is behind
    the button, but it is the same defect: a control nobody can identify, including a screen reader.

    The refusal is the exception and has to be, or a failed first read would render nothing at all — which is
    the "empty surface instead of an error" failure `useCoreCall` exists to prevent.
  */
  if (Object.keys(text).length === 0) {
    return error === null ? null : (
      <section className="panel__section userrules">
        <p className="panel__error" role="alert">
          {error}
        </p>
      </section>
    )
  }

  return (
    <section className="panel__section userrules">
      <h3 className="panel__sectionTitle">{word('heading')}</h3>
      {/*
        Its own class rather than `field__description`, which was the first attempt and was wrong twice over.
        That class belongs to a *setting's* explanatory sentence, so reusing it made a strict test fail — the
        one asserting that a setting with no description renders no description element — and it would have
        made a future change to how settings explain themselves silently restyle this.
      */}
      <p className="userrules__hint" id="userrules-hint">
        {word('hint')}
      </p>

      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}

      <div className="userrules__add">
        <input
          className="field__text userrules__input"
          value={draft}
          placeholder={word('placeholder')}
          aria-label={word('heading')}
          aria-describedby="userrules-hint"
          spellCheck={false}
          onChange={(event) => {
            setDraft(event.target.value)
            // The verdict belongs to the line that produced it. Left up while the text changes, it would be
            // a refusal of something the user has already corrected.
            setOutcome(null)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            void submit()
          }}
        />
        <button type="button" className="dialog__button" onClick={() => void submit()}>
          {word('add')}
        </button>
      </div>

      {outcome === 'invalid' && (
        <p className="panel__error" role="alert">
          {word('invalid')}
        </p>
      )}
      {outcome === 'duplicate' && (
        <p className="panel__notice" role="status">
          {word('duplicate')}
        </p>
      )}

      {rules.length === 0 ? (
        <p className="panel__empty">{word('empty')}</p>
      ) : (
        <ul className="userrules__list">
          {rules.map((rule) => (
            <li className="userrules__rule" key={rule.id}>
              <input
                type="checkbox"
                className="field__toggle"
                checked={rule.enabled}
                aria-label={`${word('toggle')}: ${rule.text}`}
                onChange={(event) => act(() => host.setEnabled(rule.id, event.target.checked))}
              />
              <div className="userrules__body">
                {/* The line as written, never reformatted: it is the only form the user can recognise. */}
                <code className="userrules__text">{rule.text}</code>
                <span className="userrules__meta">
                  {[
                    rule.kind === 'procedural' ? word('kindProcedural') : word('kindDeclarative'),
                    rule.origin === 'picker' ? word('originPicker') : word('originManual'),
                    rule.enabled ? null : word('disabled')
                  ]
                    .filter((part) => part !== null && part !== '')
                    .join(' · ')}
                </span>
              </div>
              <button
                type="button"
                className="field__reset"
                aria-label={`${word('remove')}: ${rule.text}`}
                onClick={() => act(() => host.remove(rule.id))}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
