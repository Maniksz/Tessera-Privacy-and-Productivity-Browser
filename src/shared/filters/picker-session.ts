import { ADD_USER_RULE_OUTCOMES, type AddUserRuleOutcome } from './user-rules.js'
import { PICKER_CHAIN_LIMIT_TAGS } from './picker-wire.js'
import type { SelectorProposal } from './picker.js'

/**
 * The element picker as a session: what a person's choices have made of an attempt to block
 * something, and what became of it.
 *
 * ## Why this is not state in `ElementPicker.ts`
 *
 * That class held a `Set` of views the core had started, and cleared it on two events out of the
 * eleven that end a picker. Escape in the page cleared the page's own overlay and told the core
 * nothing; the core went on believing the view was picking. Nothing could catch that, because
 * `ElementPicker.ts` speaks to `app.on('web-contents-created')` and a live `WebContents` — it is on
 * the coverage exclude list for exactly that reason, and the entry there says in as many words that
 * it is admitted *because* its decisions were extracted. This module is where they went. If a
 * branch settles over there again, it is in a file no test can reach.
 *
 * So what is here is the whole lifecycle: which transitions exist, which messages decide nothing,
 * and which of the eight named answers of R1 an attempt ends with. What is deliberately *not* here
 * is every effect — revoking a preview, asking the page to measure, presenting a bar. Those are the
 * wiring's, and a module that produced them would need Electron in its tests to be worth anything.
 *
 * ## At most one session in the whole program, and why the signature carries that
 *
 * KTD4 makes this a program-wide invariant rather than a per-window one, and the reason is what a
 * picker *does* to a page: it puts a provisional rule into a live document and paints a highlight
 * over it. Two sessions means two documents in that condition with one bar to explain them, and an
 * abort that resolves against "the current session" would take down whichever the caller happened
 * to be holding.
 *
 * A module cannot hold that state itself — this file is reachable from the preload as well as the
 * core, so a module-level slot would be a different slot in every process and would say nothing
 * about the program. The invariant lives in the signature instead: `pickerStep` takes **one**
 * nullable session and returns one, and a start displaces whatever it was given, in whatever
 * window, reporting it as `displaced` so its preview and its bar can be taken down. A caller
 * keeping a map keyed by window would have to work against this API rather than merely forget to
 * use it.
 *
 * ## Why the session holds a chain and not an element
 *
 * Widening and narrowing walk the ancestors of the clicked element, and the obvious shape — hold
 * the element, ask the page for its parent — cannot exist here: this module has no DOM, and the
 * core has no DOM either. So the page hands the whole walkable chain over at the moment of the
 * click, each rung already proposed and already measured in the open document, and a correction is
 * then a move along an index. Three things follow, and each is worth more than the round trip it
 * costs:
 *
 *   - **Widening is instant and total.** No state waits for an answer, so there is no window in
 *     which the bar shows one selector and the preview another.
 *   - **The chain cannot drift under the person reading it.** A page that re-renders between two
 *     presses of "wider" would otherwise offer a different ancestor the second time.
 *   - **The upper bound of KTD11 is applied once**, at the cut below, rather than being re-checked
 *     on every step against a tree that may have changed.
 *
 * The chain is at most `MAX_ANCESTOR_DEPTH` rungs (`picker-wire.ts`), so measuring all of them at
 * the click is a handful of `querySelectorAll` calls on one gesture.
 *
 * ## What is not session state
 *
 * The selector under the pointer while the picker is still `showing`. It changes many times a
 * second, no transition depends on it, and routing it through here would make every mouse move a
 * step. It travels on the existing synchronous propose channel and reaches the bar as presentation.
 *
 * Zod-free, Electron-free and Node-free, like everything the preload can reach; `tests/architecture.test.ts`
 * holds that line.
 */

/**
 * The five states of the session, in the order a successful attempt passes through them.
 *
 * The first four are `PICKER_BAR_MODES` in `overlay/picker-bar.ts`, by the same names and in the
 * same order, and the correspondence is meant to be visible rather than merely true. It is not
 * expressed as an import: that module is the *overlay* vocabulary — bar geometry, bar actions — and
 * a filters module pulling it in would drag a renderer concern into everything that reaches this
 * one, the preload included.
 *
 * `ended` has no bar mode, and that asymmetry is deliberate on both sides. Here it is a state
 * because "over" is something a session has to be able to *be* — an abort has to produce a value
 * the caller can clean up from, naming the view whose preview must come off and the window whose
 * bar must go. Over there it would be a mode meaning "not on screen", which the layer already
 * expresses by holding nothing. An ended session with an outcome is shown in the bar's `outcome`
 * mode; an ended session without one has no bar at all.
 */
export const PICKER_SESSION_STATES = ['showing', 'frozen', 'writing', 'measuring', 'ended'] as const

export type PickerSessionState = (typeof PICKER_SESSION_STATES)[number]

/**
 * Every named answer an attempt can end with, and there is no ninth.
 *
 * Derived from `ADD_USER_RULE_OUTCOMES` rather than restated, because the relationship between the
 * two lists *is* the content of R1 and writing it out as eight strings would hide it:
 *
 *   - Four of the store's answers are the picker's answers unchanged. A rule the parser refuses, a
 *     rule already present and active, one already present and switched off, and a list already at
 *     its limit are all facts about the *rule*, and the picker has nothing to add to them. A sixth
 *     answer added over there arrives here as a missing case the compiler points at, rather than as
 *     a silent gap in a hand-written list.
 *   - `added` is not an answer to the question the user asked. They asked for the thing to go away,
 *     and a rule that stored cleanly can still hide nothing in the document in front of them — that
 *     is the defect this whole feature is being rebuilt around, and it is why `added` splits into
 *     `saved-effective` and `saved-ineffective` on what the page measured afterwards.
 *   - Two more are decided before any write is attempted, and are therefore not the store's to
 *     give: a document with no host to key a rule on, and a document the blocker cannot inject
 *     into at all. Both are conditions of the *page*, known at the start.
 */
export const PICKER_OUTCOMES = [
  ...ADD_USER_RULE_OUTCOMES.filter(
    (outcome): outcome is Exclude<AddUserRuleOutcome, 'added'> => outcome !== 'added'
  ),
  /** Stored, and the elements it matched are no longer drawn. */
  'saved-effective',
  /** Stored, and the document is unchanged. Not an error — see `measured`. */
  'saved-ineffective',
  /** No registrable domain, so a rule here would be a generic one the user never asked to write. */
  'no-host',
  /** An internal page, a `file:` document, a PDF — nothing the cosmetic injector can reach. */
  'not-filterable'
] as const

export type PickerOutcome = (typeof PICKER_OUTCOMES)[number]

/**
 * The events of R11 that are not transitions in their own right, as one input.
 *
 * R11 names eleven things that must clear the picker at the same place. Two of them already have a
 * transition — confirming leads through `writing`, and a second start begins a new session — so the
 * other nine are these. One input rather than nine, because the failure R11 exists to prevent is a
 * wiring that handles them individually and handles eight: the reason names what happened without
 * the state machine having to care which it was, and a tenth cause added later is one entry here
 * and no new branch anywhere.
 *
 * `escaped` and `cancelled` are separate although they do the same thing, because they arrive from
 * different places — the page's key handler and the bar's own button — and a caller acknowledging
 * the wrong one is a real mistake this keeps visible.
 */
export const PICKER_ABORT_REASONS = [
  /** The bar's own Cancel. */
  'cancelled',
  /** Escape, in the page. */
  'escaped',
  /** The view began loading a different document. */
  'document-changed',
  /** A same-document navigation: the page moved under the selection without reloading. */
  'navigated',
  'reloaded',
  /** A higher-ranking overlay surface took the layer, so the bar is gone (AE11). */
  'displaced',
  'tab-closed',
  'window-closed',
  'app-quit'
] as const

export type PickerAbortReason = (typeof PICKER_ABORT_REASONS)[number]

/**
 * Where the chain stops, whatever the page sent.
 *
 * KTD11: a hard upper bound, not a warning. `html##html` empties the page and `body` very nearly
 * does, and neither is a mistake a person recovers from by looking at the result — the page they
 * would have to look at is blank. So the rungs at and above `body` are not offered at all, which
 * also means "wider" simply stops being available rather than becoming a thing that asks for
 * confirmation nobody can evaluate.
 *
 * Declared in `picker-wire.ts` and re-exported here, because the page applies the same cut before it
 * proposes a rung and the preload cannot reach this module's runtime — see the note there.
 */
export { PICKER_CHAIN_LIMIT_TAGS }

const CHAIN_LIMIT = new Set<string>(PICKER_CHAIN_LIMIT_TAGS)

/**
 * One rung of the chain the user can walk: the clicked element, or one of its ancestors.
 *
 * Carries the proposal whole rather than only its selector, so the bar can name the strategy and
 * the warnings of the rung actually chosen — a warning belongs to a candidate, and a session that
 * kept only the current selector would have to ask for it again on every correction.
 */
export interface PickerCandidate {
  /** Lower-cased tag name of the element this rung selects; matched against the limit above. */
  readonly tag: string
  readonly proposal: SelectorProposal
  /**
   * How many elements this rung matches **in the open document**.
   *
   * Measured in the page, not estimated from the element's own description (R9). The estimate in
   * `SelectorProposal.estimatedMatches` is taken against whatever the caller surveyed, which for a
   * hover is the target alone; a person deciding whether to hide three things or three hundred
   * needs the document's answer.
   */
  readonly matches: number
}

export interface PickerSelection {
  /** The clicked element first, then outwards. Never empty, and never reaches `body`. */
  readonly chain: readonly PickerCandidate[]
  /** Which rung is chosen: 0 is the clicked element, and widening moves outwards. */
  readonly index: number
}

interface PickerSessionIdentity {
  /**
   * Identity of this attempt, supplied by the caller.
   *
   * A pure module may not invent one, and it is not merely decorative: a late answer from a page —
   * a measurement, a store result — belongs to the attempt that asked for it, and after a second
   * start the view and the window can both be the same while the attempt is a different one.
   */
  readonly sessionId: string
  /** The view being picked in; `webContents.id` in the core. */
  readonly viewId: number
  /** The window whose bar shows this session. R2: the answer appears where the picking happened. */
  readonly windowId: number
  /** The registrable domain the rule will be scoped to. Never empty — a start without one is refused. */
  readonly host: string
}

/**
 * The session, discriminated by state so that "frozen without a selection" cannot be written down.
 *
 * The alternative — one shape with `selection: PickerSelection | null` — needs a null check in
 * every transition that moves the selection, and each of those checks is a branch that can never be
 * taken. Unreachable defensive code in a state machine is worse than absent: it looks like a case
 * somebody thought about, and it is a case the type system was already refusing.
 */
export type PickerSession =
  | (PickerSessionIdentity & { readonly state: 'showing'; readonly selection: null })
  | (PickerSessionIdentity & {
      readonly state: 'frozen' | 'writing' | 'measuring'
      readonly selection: PickerSelection
    })
  /**
   * Over. The selection is kept when there was one, because that is how the caller knows a
   * provisional rule is still in a document and which view to take it out of.
   */
  | (PickerSessionIdentity & {
      readonly state: 'ended'
      readonly selection: PickerSelection | null
    })

/**
 * What an event is about, so that a message from a page or a bar that is not the session's decides
 * nothing.
 *
 * Every renderer-originated message names what it was sent for, and the check is here rather than
 * in the wiring for the reason the whole module exists: resolved against "whatever is current", a
 * tab closing in another window would end a picker somebody is still using, and a keystroke from a
 * stale bar would confirm a selection that had moved. `program` is for the events that really are
 * about the program — the application quitting — and for the core answering itself.
 */
export type PickerScope =
  | { readonly of: 'view'; readonly viewId: number }
  | { readonly of: 'window'; readonly windowId: number }
  | { readonly of: 'program' }

/**
 * Everything that can happen to a picker session.
 *
 * `start` carries its own identity because it creates one; everything else carries `at`, which is
 * how it is matched against the session that exists.
 */
export type PickerEvent =
  | {
      readonly ask: 'start'
      readonly sessionId: string
      readonly viewId: number
      readonly windowId: number
      /** The document's registrable domain, or null when it has none. */
      readonly host: string | null
      /** Whether the cosmetic injector can reach this document at all. */
      readonly filterable: boolean
    }
  /** The click. The page has proposed and measured every rung it is offering. */
  | { readonly ask: 'freeze'; readonly at: PickerScope; readonly chain: readonly PickerCandidate[] }
  | { readonly ask: 'widen'; readonly at: PickerScope }
  | { readonly ask: 'narrow'; readonly at: PickerScope }
  | { readonly ask: 'confirm'; readonly at: PickerScope }
  /** What the mode-bound rule editor answered. */
  | { readonly ask: 'written'; readonly at: PickerScope; readonly outcome: AddUserRuleOutcome }
  /**
   * What the page found once the preview was off and the stored rule delivered.
   *
   * Two numbers rather than a verdict, because the verdict is a decision and decisions belong here:
   * `matches` is how many elements the stored selector matched, `visible` how many of those are
   * still drawn. A hidden element still matches its selector, so "it worked" is `matches > 0` with
   * none of them visible — and `matches === 0` means the element left the document, which is not
   * proof the rule did it.
   */
  | {
      readonly ask: 'measured'
      readonly at: PickerScope
      readonly matches: number
      readonly visible: number
    }
  | { readonly ask: 'abort'; readonly at: PickerScope; readonly reason: PickerAbortReason }

/**
 * What a step did, as something the caller acts on rather than something it infers.
 *
 * A union rather than a returned session and a comparison, because the five cases need five
 * different things done and telling them apart from a before-and-after would mean reimplementing
 * the machine at the call site. Nothing throws: an event that decides nothing is `ignored`, which
 * is an ordinary answer here — most of them arrive from renderers, on time, about a session that
 * has moved on.
 */
export type PickerStepResult =
  /** A session is running, in `showing`. Start the page's picker and raise the bar. */
  | {
      readonly did: 'started'
      readonly session: PickerSession
      /** The session this start took down, if any — possibly in another window. */
      readonly displaced: PickerSession | null
    }
  /** Nothing was started; the bar shows the refusal (F5). `displaced` as above. */
  | {
      readonly did: 'refused'
      readonly outcome: PickerOutcome
      readonly displaced: PickerSession | null
    }
  /** The session moved on and is still running. Present it. */
  | { readonly did: 'changed'; readonly session: PickerSession }
  /** Nothing happened, and the session — if there is one — is exactly as it was. */
  | { readonly did: 'ignored'; readonly session: PickerSession | null }
  /**
   * Over. Take the preview off `ended`'s view, stop its page's picker, and either name the outcome
   * in its window's bar or take the bar down when there is none.
   */
  | {
      readonly did: 'ended'
      readonly ended: PickerSession
      /** Null when the attempt was abandoned rather than answered. */
      readonly outcome: PickerOutcome | null
    }

/**
 * The chain, cut where KTD11 says it stops.
 *
 * Exported because the page can apply the same cut before sending — a rung that will be dropped
 * here need not be proposed or measured there — and because a bound that is the difference between
 * hiding an advert and blanking a page deserves a test of its own rather than only being observed
 * through a transition.
 */
export function pickableChain(chain: readonly PickerCandidate[]): readonly PickerCandidate[] {
  const limit = chain.findIndex((candidate) => CHAIN_LIMIT.has(candidate.tag.toLowerCase()))
  return limit === -1 ? chain : chain.slice(0, limit)
}

/** The rung currently chosen, or null while nothing has been chosen. */
export function selectedCandidate(session: PickerSession): PickerCandidate | null {
  const { selection } = session
  if (selection === null) return null
  // The index is only ever moved by `widen`/`narrow`, which refuse to leave the chain, and the
  // chain is non-empty by construction — a freeze that cut everything away does not freeze.
  return selection.chain[selection.index]!
}

/**
 * Whether the selection can still be pulled wider.
 *
 * Exported so that the bar and the transition agree by construction. Left to the presentation, the
 * rule "there is nothing above this rung" would be written twice, and the copy that drifted would
 * be the one offering a control that does nothing.
 */
export function canWidenSelection(session: PickerSession): boolean {
  if (session.state !== 'frozen') return false
  return session.selection.index < session.selection.chain.length - 1
}

/** Whether the selection can be pulled back in; false at the element the user actually clicked. */
export function canNarrowSelection(session: PickerSession): boolean {
  if (session.state !== 'frozen') return false
  return session.selection.index > 0
}

/**
 * The whole machine, as one pure step.
 *
 * Total: every event has an answer for every state, and the answer for an event that changes
 * nothing is the session it was given.
 */
export function pickerStep(current: PickerSession | null, event: PickerEvent): PickerStepResult {
  if (event.ask === 'start') return started(current, event)

  const session = liveSessionOf(current, event.at)
  // No session, an ended one, or a message about a different view or window. All three are the
  // same answer, and all three happen in ordinary use rather than only under attack.
  if (session === null) return { did: 'ignored', session: current }

  switch (event.ask) {
    case 'freeze':
      return frozen(session, event.chain)
    case 'widen':
      return moved(session, 1)
    case 'narrow':
      return moved(session, -1)
    case 'confirm':
      return confirmed(session)
    case 'written':
      return written(session, event.outcome)
    case 'measured':
      return measured(session, event.matches, event.visible)
    case 'abort':
      // From every live state, including `writing` and `measuring`. A tab whose window is closing
      // does not get to finish its measurement first.
      return { did: 'ended', ended: ending(session), outcome: null }
  }
}

// --- internals -------------------------------------------------------------

function ending(session: PickerSession): PickerSession {
  return { ...session, state: 'ended' }
}

function liveSessionOf(current: PickerSession | null, scope: PickerScope): PickerSession | null {
  if (current === null || current.state === 'ended') return null
  return concerns(current, scope) ? current : null
}

function concerns(session: PickerSession, scope: PickerScope): boolean {
  switch (scope.of) {
    case 'view':
      return scope.viewId === session.viewId
    case 'window':
      return scope.windowId === session.windowId
    case 'program':
      return true
  }
}

function started(
  current: PickerSession | null,
  event: Extract<PickerEvent, { ask: 'start' }>
): PickerStepResult {
  // A second start is one of R11's events: whatever was running ends here, whichever window it was
  // in, and it ends before the refusals below are considered — the old session must not survive a
  // start that was refused for reasons that have nothing to do with it.
  const displaced = current === null || current.state === 'ended' ? null : ending(current)

  /*
    Filterability is asked first, and the order is a wording decision rather than a technicality.

    A `file:` document and an internal page are both hostless *and* unfilterable, so one of the two
    sentences has to win. "There can be no rule on this kind of document" is the true and final one;
    "this page has no host" suggests a site that might have one on the next visit, which for
    `tessera://settings` is nonsense.
  */
  if (!event.filterable) return { did: 'refused', outcome: 'not-filterable', displaced }
  // An empty host is the same absence as a missing one, and a rule keyed on `''` would be a
  // *generic* rule: the selector hidden on every site the user ever visits.
  if (event.host === null || event.host === '') {
    return { did: 'refused', outcome: 'no-host', displaced }
  }

  return {
    did: 'started',
    session: {
      sessionId: event.sessionId,
      viewId: event.viewId,
      windowId: event.windowId,
      host: event.host,
      state: 'showing',
      selection: null
    },
    displaced
  }
}

function frozen(session: PickerSession, chain: readonly PickerCandidate[]): PickerStepResult {
  /*
    Only from `showing`, so a second click changes nothing.

    The page swallows the whole pointer sequence while the picker is up, but "swallowed" is not
    "impossible": a click can still arrive here after the bar has moved the session on. Taken as a
    re-freeze it would move the selection under somebody who is reading the selector, and from
    `writing` it would contradict a rule already on its way to the store.
  */
  if (session.state !== 'showing') return { did: 'ignored', session }

  const pickable = pickableChain(chain)
  // Nothing to offer: a click on `body` itself, or a page that described no element at all. There
  // is no selection that would be safe to make here, so the picker stays as it was rather than
  // freezing on something the user cannot back out of.
  if (pickable.length === 0) return { did: 'ignored', session }

  return {
    did: 'changed',
    session: { ...session, state: 'frozen', selection: { chain: pickable, index: 0 } }
  }
}

function moved(session: PickerSession, step: 1 | -1): PickerStepResult {
  // Corrections belong to `frozen` alone. In `writing` and `measuring` the text has already gone to
  // the editor, and a selection that moved after that would leave the bar naming one selector while
  // another was being written.
  if (session.state !== 'frozen') return { did: 'ignored', session }

  const index = session.selection.index + step
  // Off the top is KTD11 — there is deliberately nothing above the last rung — and off the bottom
  // is an element the user did not point at.
  if (index < 0 || index >= session.selection.chain.length) return { did: 'ignored', session }

  return { did: 'changed', session: { ...session, selection: { ...session.selection, index } } }
}

function confirmed(session: PickerSession): PickerStepResult {
  /*
    A second confirm is discarded, and this is the guard that cannot live in the bar.

    Writing takes a round trip through the rule store and measuring takes another, and the press
    that would write a second rule arrives *before* the first answer does — a person pressing Enter
    again because nothing has visibly happened yet is the expected case, not an odd one. A disabled
    button in the bar is a courtesy on top of this, not a substitute for it: the bar is a renderer.
  */
  if (session.state !== 'frozen') return { did: 'ignored', session }
  return { did: 'changed', session: { ...session, state: 'writing' } }
}

function written(session: PickerSession, outcome: AddUserRuleOutcome): PickerStepResult {
  if (session.state !== 'writing') return { did: 'ignored', session }

  /*
    A stored rule is not yet an answer.

    Everything else the store can say is final — the rule was refused, or it was already there, or
    there is no room — and the picker has nothing to add. `added` only means the line is on disk,
    which is precisely the claim this feature was reported for making while nothing on the page
    changed. So it leads to a measurement instead of to a result.
  */
  if (outcome === 'added') return { did: 'changed', session: { ...session, state: 'measuring' } }
  return { did: 'ended', ended: ending(session), outcome }
}

function measured(session: PickerSession, matches: number, visible: number): PickerStepResult {
  // A measurement outside `measuring` describes a document state nobody asked about — commonly one
  // taken against the *preview*, which is exactly the confusion the ordering in R13 exists to stop.
  if (session.state !== 'measuring') return { did: 'ignored', session }

  /*
    Effective means: something matched, and none of it is drawn any more.

    Both halves are load-bearing and both are easy to get wrong. A hidden element still matches its
    selector, so a count alone says nothing — `matches` stays at three when the rule works. And
    nothing matching is not success either: the element left the document, and the rule may simply
    have arrived after it went. That is `saved-ineffective` and not an error (KTD8, OQ1) — an advert
    loaded a second later can still be caught by the same rule, so the wording is "does not work
    here", not "wrong".

    Anything but exactly zero visible counts as still on screen, which errs towards reporting no
    effect. Of the two ways to be wrong, telling somebody the rule did nothing when it did is a
    thing they can check; telling them it worked when the page is unchanged is the original defect.
  */
  const effective = matches > 0 && visible === 0
  return {
    did: 'ended',
    ended: ending(session),
    outcome: effective ? 'saved-effective' : 'saved-ineffective'
  }
}
