import { useEffect, useRef, useState } from 'react'
import type { UserRule } from '@shared/filters/user-rules.js'
import {
  USER_RULE_LINE_REFUSALS,
  annotateSourceLines,
  type AnnotatedLine,
  type RejectedUserRuleLine,
  type UserRuleLineRefusal
} from '@shared/filters/user-rules-lines.js'
import type { ApplyUserRuleSourceOutcome } from '@shared/filters/user-rules-source.js'
import { useCoreCall } from './useCoreCall.js'

/**
 * The user's own filter rules, as one text.
 *
 * ## What was missing, and it was the whole feature
 *
 * `user-rules.ts` states the requirement in its own docblock: *"The three operations that matter are not
 * 'add': they are see, disable, delete."* All three had core handlers and **no caller**, and there was no
 * way to write a rule at all — so the element picker was the only thing in the browser that could write a
 * rule, and nothing could show one. A rule that hid the wrong element was permanent and unfindable.
 *
 * The blocker menu lists the rules for the site in front of the user, which answers *"why is this page
 * broken"*. This is the other half: every rule, in a box to type into. Asked for as wanting to enter
 * procedural selectors *"wie bei uBlock origin selber"* — and uBO's own filter box is exactly this shape.
 *
 * ## Why a text after all, when this used to argue for one line at a time
 *
 * It did, and the argument was sound as far as it went. Every line goes through `describeUserRule`, which
 * refuses request-blocking syntax and scriptlets outright, so a whole-document save needs "a per-line error
 * report next to a textarea" — several messages about lines the user has to count to find. One line at a
 * time put the refusal beside the thing refused, and each stored rule had its own switch and delete button.
 *
 * The user asked for the text regardless (R17), and the objection is answered rather than overruled: **the
 * refusal is drawn on the refused line**, in the text, where the user is already looking. Nothing has to be
 * counted. The mark is found by the line's text rather than its number (see `annotateSourceLines`), so it
 * stays with its line while lines are inserted above it and goes the moment the line is corrected. A refused
 * line does not refuse the text: everything around it is saved.
 *
 * The two per-row controls become the two things uBO's box does with a line — `!` in front switches a rule
 * off, deleting the line deletes it — and the core keeps each rule's id, age and origin through the round
 * trip by tracing unchanged lines back to their rules (KTD7). What the list could do and a text cannot is
 * *narrow*: hiding lines of a document that is saved whole would lose them. So the settings search marks
 * the lines it matches instead of hiding the others.
 *
 * ## How the marks are drawn in place
 *
 * A `<textarea>` cannot style one of its lines. So the text is drawn twice: once by the text box, on top,
 * with a transparent background, and once underneath by a mirror with the same font, padding and scroll
 * position, in which the text itself is transparent and only the marks show — a tint behind a refused or
 * matched line, and a short tag after it. Both use `white-space: pre` so neither wraps and the two cannot
 * disagree about where a line is. The mirror is `aria-hidden`; a screen reader gets `aria-invalid` on the
 * box and the line numbers in the explanation, which is the one place a number is the right answer.
 *
 * ## Where the words come from
 *
 * The core, on the same answer as the rules. `main/settings/user-rules-text.ts` explains why: the shared
 * message catalogue is one chunk that every internal page fetches before first paint, it is held to a
 * measured budget, and a dozen sentences about filter syntax should not be downloaded by the start page.
 */

/** A rule with what the core worked out about it. `kind` decides which cost its line reports. */
export interface EditableUserRule extends UserRule {
  readonly kind: 'declarative' | 'procedural'
}

/** Everything the core says about the rules on one read. */
export interface UserRulesAnswer {
  rules: EditableUserRule[]
  /** The editor's words, resolved in the core for the interface language. */
  text: Record<string, string>
  /** The rules as the text to edit, merged with the notes last saved. */
  source: string
  /** The lines of `source` the browser refuses, trimmed, and why — marked where they stand. */
  rejected: RejectedUserRuleLine[]
  /** True in a private window, whose changes last for the session and which cannot switch off a stored rule. */
  session: boolean
}

/**
 * What this component needs from the browser.
 *
 * Named operations rather than a generic `invoke`, for the reason `SettingsHost` gives: it is what lets a
 * test drive the editor without a bridge, and it keeps a channel union out of a component that has no
 * business knowing one.
 */
export interface UserRulesHost {
  list(): Promise<UserRulesAnswer>
  /**
   * `loadedIds` are the rules the text was written against: the ones on the answer the box was filled from.
   * A missing line deletes only those, so a rule written while this page was open survives its save.
   */
  apply(text: string, loadedIds: readonly string[]): Promise<ApplyUserRuleSourceOutcome>
}

/**
 * The words for each reason a line is refused: the tag drawn on the line, and the sentence that explains it.
 *
 * One pair per reason because the remedies differ — a line to correct, a line to write in a normal window,
 * a rule to change in a normal window — and one sentence covering all three would give nobody their next
 * step. The keys are the core's (`main/settings/user-rules-text.ts`).
 */
const REFUSAL_WORDS: Record<UserRuleLineRefusal, { mark: string; explanation: string }> = {
  unsupported: { mark: 'rejectedMark', explanation: 'rejected' },
  'private-window': { mark: 'rejectedMarkPrivate', explanation: 'rejectedPrivate' },
  'normal-profile': { mark: 'rejectedMarkProfile', explanation: 'rejectedProfile' }
}

/** The tags after a line, in the order a reader wants them: the refusal first, then what the rule costs. */
function tagsOf(line: AnnotatedLine, word: (key: string) => string): string {
  if (line.refusal !== null) return word(REFUSAL_WORDS[line.refusal].mark)
  return [line.procedural ? word('kindProcedural') : '', line.picked ? word('originPicker') : '']
    .filter((part) => part !== '')
    .join(' · ')
}

export function UserRulesEditor({
  host,
  query = ''
}: {
  host: UserRulesHost
  /**
   * What the settings page's search box currently holds.
   *
   * Optional, and the default is what "nobody is searching" means — which is also what a test that only
   * cares about the rules gets. See `matchesSearch` below for why this block takes part in the search at
   * all rather than being hidden while one runs.
   */
  query?: string
}): React.ReactNode {
  const [answer, setAnswer] = useState<UserRulesAnswer | null>(null)
  const [draft, setDraft] = useState('')
  /**
   * The answer to the last save, and the text it is an answer about.
   *
   * Kept with its text rather than on its own, because a save is two round trips and the box stays open
   * for typing through both: "Saved." arriving for the text that was sent, over a text the user has
   * since changed, would call unsaved lines saved. It is shown only while the box still holds that text.
   */
  const [verdict, setVerdict] = useState<{
    readonly outcome: ApplyUserRuleSourceOutcome
    readonly text: string
  } | null>(null)
  /** A save on its way. Save and Discard wait for it; the text box does not. */
  const [saving, setSaving] = useState(false)
  const mirror = useRef<HTMLDivElement>(null)
  /*
    Every call goes through `useCoreCall`, which holds the refusal and the try/catch.

    Not a convenience. That hook exists because four surfaces here surfaced a *write* refusal and dropped
    every other one — including the first load, which rendered an empty screen for "the core refused". An
    empty rule text and a refused `userrules:list` look identical, and one of them means "you have no rules"
    while the other means the browser would not say.
  */
  const { error, run } = useCoreCall()

  /*
    An async body inside `run`, with a cancellation flag, rather than `void host.list().then(...)`.

    The same shape `SettingsView`'s first load uses and for the reason written there: a state write attached
    to a promise in an effect body has no relationship to the effect's own cleanup, which is what the
    `react-hooks` rule flags — and the flag is what stops a late answer from writing into an unmounted tree.
  */
  useEffect(() => {
    let cancelled = false
    void run(async () => {
      const first = await host.list()
      if (cancelled) return
      setAnswer(first)
      setDraft(first.source)
    })
    return () => {
      cancelled = true
    }
  }, [host, run])

  const text = answer?.text ?? {}
  const word = (key: string): string => text[key] ?? ''

  /*
    Nothing is rendered before the words arrive, and a test is what made that explicit.

    The words come from the core with the rules, so on the first pass there are none — and the version that
    rendered anyway produced a text box with no accessible name and a button with no label. `PermissionSurface`
    states the principle for a prompt: *"the one thing a consent dialogue may never do is present a button
    before it can say what the button agrees to"*. It is weaker here, because nothing irreversible is behind
    the button, but it is the same defect: a control nobody can identify, including a screen reader.

    The refusal is the exception and has to be, or a failed first read would render nothing at all — which is
    the "empty surface instead of an error" failure `useCoreCall` exists to prevent.
  */
  if (answer === null || Object.keys(text).length === 0) {
    return error === null ? null : (
      <section className="panel__section userrules">
        <p className="panel__error" role="alert">
          {error}
        </p>
      </section>
    )
  }

  /*
    The search, and the reason this block is in it at all.

    It used to be *hidden* whenever the box had anything in it, and a person looking for their filter rules
    who typed "Regeln" made the only screen that shows them go away — reported as there being no field for
    the rules at all. So it answers the search instead, two ways:

      - The **heading and the explanation** match, which is somebody looking for the feature. The whole
        block appears.
      - A **line of the text** matches, which is somebody looking for one rule — almost always by the site
        it broke. The block appears and those lines are marked.

    Matched on the words the *core* sent rather than on a keyword list kept here, so the German interface
    answers German searches without a second table to forget to translate.
  */
  const term = query.trim().toLowerCase()
  const lines = annotateSourceLines(draft, { rules: answer.rules, rejected: answer.rejected, term })
  const matchesSearch =
    term === '' ||
    word('heading').toLowerCase().includes(term) ||
    word('hint').toLowerCase().includes(term) ||
    lines.some((line) => line.match)
  // Nothing here answers what was typed: leave the results to the sections that do.
  if (!matchesSearch) return null

  const saved = answer
  const dirty = draft !== saved.source
  const said = verdict?.text === draft ? verdict.outcome : null
  /** 1-based, because these are said to a person: "line 2". */
  const refusedAt = lines.flatMap((line, index) => (line.rejected ? [index + 1] : []))
  /** One sentence per reason on screen, in a fixed order, so the explanation reads the same every time. */
  const explanation = USER_RULE_LINE_REFUSALS.filter((reason) =>
    lines.some((line) => line.refusal === reason)
  )
    .map((reason) => word(REFUSAL_WORDS[reason].explanation))
    .join(' ')

  const save = async (): Promise<void> => {
    // The text this save is about, held apart from `draft`: the user can go on typing while it is away.
    const sent = draft
    setSaving(true)
    await run(async () => {
      /*
        With the ids of the rules the box was filled from. The element picker can write a rule while this page
        is open, and the draft has no line for it — not because the user deleted one, but because there was
        none to show. Sent the ids, the core deletes only the rules this page showed and the user took out.
      */
      const outcome = await host.apply(
        sent,
        saved.rules.map((entry) => entry.id)
      )
      setVerdict({ outcome, text: sent })
      /*
        Re-read after a save, and put what the core kept into the box — the same rule every write on this
        page follows: the core folds a repeated rule, writes a rule in its plain form and keeps a refused
        line where it was, and a box showing what was *sent* would disagree with what was stored.

        Not after a refusal. Nothing was written, and the user's text is the thing they now have to shorten;
        replacing it with the stored one would throw away every line they added.

        And only over the text that was sent. Anything typed since is newer than the answer, and replacing it
        would throw those keystrokes away and leave the box looking saved with nothing to press. Kept, it
        reads against the new stored text — dirty, with Save offered — which is what it is.
      */
      if (outcome !== 'applied') return
      const next = await host.list()
      setAnswer(next)
      setDraft((current) => (current === sent ? next.source : current))
      setVerdict((current) => (current?.text === sent ? { outcome, text: next.source } : current))
    })
    setSaving(false)
  }

  const discard = (): void => {
    setDraft(saved.source)
    setVerdict(null)
  }

  /*
    Kept in step by hand because the mirror has no scrollbar of its own to follow: it is `overflow: hidden`
    and moves only when told. Horizontal as well as vertical, since neither layer wraps.
  */
  const follow = (box: HTMLTextAreaElement): void => {
    if (mirror.current === null) return
    mirror.current.scrollTop = box.scrollTop
    mirror.current.scrollLeft = box.scrollLeft
  }

  return (
    <section className="panel__section userrules">
      <h3 className="panel__sectionTitle" id="userrules-heading">
        {word('heading')}
      </h3>
      {/*
        Its own class rather than `field__description`, which was the first attempt and was wrong twice over.
        That class belongs to a *setting's* explanatory sentence, so reusing it made a strict test fail — the
        one asserting that a setting with no description renders no description element — and it would have
        made a future change to how settings explain themselves silently restyle this.
      */}
      <p className="userrules__hint" id="userrules-hint">
        {word('hint')}
      </p>

      {/*
        The known limit of a private window, said where it applies rather than left for somebody to find.
        See `SessionUserRuleEditor` for why a stored rule can be switched on here and not off: it reaches this
        window through the engine's global slot, and a private window can only add to what its pages get.
      */}
      {saved.session && (
        <p className="panel__notice" role="note">
          {word('sessionNote')}
        </p>
      )}

      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}

      <div className="userrules__editor">
        <div className="userrules__mirror" ref={mirror} aria-hidden="true">
          {lines.map((line, index) => {
            const tags = tagsOf(line, word)
            return (
              <div
                // Positional on purpose: the mirror is a picture of the lines as they stand, line for line.
                key={index}
                className={[
                  'userrules__line',
                  line.rejected ? 'userrules__line--rejected' : '',
                  line.match ? 'userrules__line--match' : ''
                ]
                  .filter((name) => name !== '')
                  .join(' ')}
              >
                <span className="userrules__ghost">{line.text}</span>
                {tags !== '' && <span className="userrules__tag">{tags}</span>}
              </div>
            )
          })}
        </div>
        <textarea
          className="userrules__source"
          value={draft}
          placeholder={word('placeholder')}
          aria-labelledby="userrules-heading"
          aria-describedby={
            refusedAt.length > 0 ? 'userrules-hint userrules-refused' : 'userrules-hint'
          }
          aria-invalid={refusedAt.length > 0}
          spellcheck={false}
          wrap="off"
          rows={Math.min(24, Math.max(8, lines.length + 1))}
          onScroll={(event) => follow(event.currentTarget)}
          onChange={(event) => {
            setDraft(event.currentTarget.value)
            // The verdict belongs to the text that produced it. Left up while the text changes, it would
            // be a refusal of something the user has already corrected — and dropped rather than merely
            // hidden, so typing the old text back does not bring back an answer about a different save.
            setVerdict(null)
          }}
        />
      </div>

      <div className="userrules__actions">
        {/*
          Both wait for a save on its way. A second Save would send a text written against rules the first is
          still changing, and Discard would put back a stored text the answer is about to replace.
        */}
        <button
          type="button"
          className="dialog__button"
          disabled={!dirty || saving}
          onClick={() => void save()}
        >
          {word('save')}
        </button>
        <button
          type="button"
          className="dialog__button"
          disabled={!dirty || saving}
          onClick={discard}
        >
          {word('discard')}
        </button>
      </div>

      {/*
        One explanation for each kind of mark on screen, and it follows the marks rather than the last save: a
        refused line kept in the saved text is marked again on every visit, so the sentence that says what the
        mark means is there whenever a mark is.
      */}
      {refusedAt.length > 0 ? (
        <p className="panel__error" role="alert" id="userrules-refused">
          {explanation}
          <span className="userrules__spoken">
            {` ${word('rejectedLines')} ${refusedAt.join(', ')}`}
          </span>
        </p>
      ) : said === 'limit-reached' ? (
        <p className="panel__error" role="alert">
          {word('limitReached')}
        </p>
      ) : said === 'applied' ? (
        <p className="panel__notice" role="status">
          {word('saved')}
        </p>
      ) : null}
    </section>
  )
}
