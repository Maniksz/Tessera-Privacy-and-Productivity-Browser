import { describe, expect, it } from 'vitest'
import { ADD_USER_RULE_OUTCOMES, type AddUserRuleOutcome } from '@shared/filters/user-rules.js'
import type { SelectorProposal } from '@shared/filters/picker.js'
import {
  PICKER_ABORT_REASONS,
  PICKER_CHAIN_LIMIT_TAGS,
  PICKER_OUTCOMES,
  PICKER_SESSION_STATES,
  canNarrowSelection,
  canWidenSelection,
  pickableChain,
  pickerStep,
  selectedCandidate,
  type PickerAbortReason,
  type PickerCandidate,
  type PickerEvent,
  type PickerOutcome,
  type PickerScope,
  type PickerSession,
  type PickerSessionState,
  type PickerStepResult
} from '@shared/filters/picker-session.js'

/**
 * The element picker's session, without a browser.
 *
 * This is the only place the session's rules can be checked at all: `ElementPicker.ts` is on the
 * coverage exclude list because it needs a browser process, and the whole point of extracting the
 * session was that what it decides should be reachable from a test. Every rule here is one that
 * fails silently when it is wrong — a second confirm that writes a second rule, a measurement folded
 * into a session it does not belong to, a picker in one window left running when another starts one
 * — and none of them throws.
 */

function proposalFor(selector: string): SelectorProposal {
  return {
    selector,
    strategy: 'class',
    estimatedMatches: 1,
    warnings: [],
    refused: []
  }
}

function candidate(tag: string, selector: string, matches = 1): PickerCandidate {
  return { tag, proposal: proposalFor(selector), matches }
}

/** The clicked element first, then outwards — an advert inside a rail inside the page's main. */
const CHAIN: readonly PickerCandidate[] = [
  candidate('div', '.ad-slot', 1),
  candidate('aside', '#rail', 1),
  candidate('main', 'main', 1)
]

const VIEW_ID = 7
const WINDOW_ID = 3

const AT_VIEW: PickerScope = { of: 'view', viewId: VIEW_ID }
const AT_WINDOW: PickerScope = { of: 'window', windowId: WINDOW_ID }
const AT_PROGRAM: PickerScope = { of: 'program' }

function startEvent(overrides: Partial<Extract<PickerEvent, { ask: 'start' }>> = {}): PickerEvent {
  return {
    ask: 'start',
    sessionId: 'pick-1',
    viewId: VIEW_ID,
    windowId: WINDOW_ID,
    host: 'example.com',
    filterable: true,
    ...overrides
  }
}

/** The session a caller would be holding after a step; the reference wiring for the core half. */
function sessionAfter(result: PickerStepResult): PickerSession | null {
  switch (result.did) {
    case 'started':
      return result.session
    case 'changed':
      return result.session
    case 'ignored':
      return result.session
    case 'refused':
      return null
    case 'ended':
      return null
  }
}

interface Run {
  readonly session: PickerSession | null
  readonly last: PickerStepResult
}

function run(events: readonly PickerEvent[]): Run {
  let session: PickerSession | null = null
  let last: PickerStepResult = { did: 'ignored', session: null }
  for (const event of events) {
    last = pickerStep(session, event)
    session = sessionAfter(last)
  }
  return { session, last }
}

const FREEZE: PickerEvent = { ask: 'freeze', at: AT_VIEW, chain: CHAIN }
const CONFIRM: PickerEvent = { ask: 'confirm', at: AT_WINDOW }
const WRITTEN_ADDED: PickerEvent = { ask: 'written', at: AT_PROGRAM, outcome: 'added' }

/** A live session in each state, built the only way one can be: by stepping into it. */
function sessionIn(state: Exclude<PickerSessionState, 'ended'>): PickerSession {
  const events: PickerEvent[] = [startEvent()]
  if (state !== 'showing') events.push(FREEZE)
  if (state === 'writing' || state === 'measuring') events.push(CONFIRM)
  if (state === 'measuring') events.push(WRITTEN_ADDED)
  const session = run(events).session
  expect(session?.state, `could not reach ${state}`).toBe(state)
  return session!
}

describe('the state vocabulary', () => {
  it('names the five states of the diagram', () => {
    // The first four are the bar's modes in `overlay/picker-bar.ts`, in the same order and by the
    // same names, so the correspondence is one a reader can see rather than one they must trust.
    expect(PICKER_SESSION_STATES).toEqual(['showing', 'frozen', 'writing', 'measuring', 'ended'])
  })

  it('names every event of R11 that is not a start or a confirm', () => {
    // R11 lists eleven events. Two of them — confirming and a second start — are transitions of
    // their own, and the other nine are these: one input, so the wiring cannot forget one of them
    // by handling them individually.
    expect([...PICKER_ABORT_REASONS]).toEqual([
      'cancelled',
      'escaped',
      'document-changed',
      'navigated',
      'reloaded',
      'displaced',
      'tab-closed',
      'window-closed',
      'app-quit'
    ])
  })
})

describe('the eight outcomes of R1', () => {
  it('has exactly eight', () => {
    expect(PICKER_OUTCOMES).toHaveLength(8)
    expect(new Set(PICKER_OUTCOMES).size).toBe(8)
  })

  it('passes through every answer the rule store can give except the one that needs measuring', () => {
    // Derived from `ADD_USER_RULE_OUTCOMES` rather than restated, so a sixth answer over there
    // cannot arrive here as a missing case nobody notices.
    const passedThrough = ADD_USER_RULE_OUTCOMES.filter((outcome) => outcome !== 'added')
    for (const outcome of passedThrough) {
      expect(PICKER_OUTCOMES, `${outcome} is not an outcome the picker can report`).toContain(
        outcome
      )
    }
    expect(PICKER_OUTCOMES).not.toContain('added')
  })

  it('splits a stored rule in two and decides two more before any write', () => {
    expect(PICKER_OUTCOMES).toContain('saved-effective')
    expect(PICKER_OUTCOMES).toContain('saved-ineffective')
    expect(PICKER_OUTCOMES).toContain('no-host')
    expect(PICKER_OUTCOMES).toContain('not-filterable')
  })
})

describe('starting', () => {
  it('shows the picker on a document that can carry a rule', () => {
    const result = pickerStep(null, startEvent())

    expect(result.did).toBe('started')
    expect(sessionAfter(result)).toEqual({
      sessionId: 'pick-1',
      viewId: VIEW_ID,
      windowId: WINDOW_ID,
      host: 'example.com',
      state: 'showing',
      selection: null
    })
  })

  it('takes nothing down when nothing was running', () => {
    const result = pickerStep(null, startEvent())
    expect(result.did === 'started' && result.displaced).toBeNull()
  })

  it('refuses a document the blocker cannot inject into, before anything is shown', () => {
    // F5/AE2: a `file:` document or an internal page. The user gets an answer instead of a picker
    // waiting for a click nobody can redeem.
    const result = pickerStep(null, startEvent({ filterable: false }))

    expect(result.did).toBe('refused')
    expect(result.did === 'refused' && result.outcome).toBe('not-filterable')
    expect(sessionAfter(result)).toBeNull()
  })

  it('refuses a document with no host', () => {
    const result = pickerStep(null, startEvent({ host: null }))
    expect(result.did === 'refused' && result.outcome).toBe('no-host')
  })

  it('treats an empty host as no host', () => {
    const result = pickerStep(null, startEvent({ host: '' }))
    expect(result.did === 'refused' && result.outcome).toBe('no-host')
  })

  it('says the document cannot be filtered when it is also hostless', () => {
    // Both are true of `file:` and of an internal page, and "there can be no rule on this kind of
    // document" is the truer of the two sentences: "no host" would suggest a site that might have
    // one tomorrow.
    const result = pickerStep(null, startEvent({ host: null, filterable: false }))
    expect(result.did === 'refused' && result.outcome).toBe('not-filterable')
  })

  it('ends the running session and begins again, in another window', () => {
    // KTD4: at most one session in the whole program. A second start is one of R11's events, so
    // the first session has to be reported as ended — its preview and its bar are in a window the
    // new session knows nothing about.
    const first = sessionIn('frozen')
    const result = pickerStep(
      first,
      startEvent({ sessionId: 'pick-2', viewId: 11, windowId: 4, host: 'other.example' })
    )

    expect(result.did).toBe('started')
    const displaced = result.did === 'started' ? result.displaced : null
    expect(displaced?.state).toBe('ended')
    expect(displaced?.sessionId).toBe('pick-1')
    // The selection is still on it, which is how the caller knows a preview has to come off.
    expect(displaced?.selection).not.toBeNull()
    expect(sessionAfter(result)?.windowId).toBe(4)
  })

  it('reports the displaced session even when the second start is refused', () => {
    const first = sessionIn('showing')
    const result = pickerStep(first, startEvent({ sessionId: 'pick-2', filterable: false }))

    expect(result.did).toBe('refused')
    expect(result.did === 'refused' && result.displaced?.state).toBe('ended')
  })

  it('displaces nothing when the session it is given has already ended', () => {
    const ended = run([startEvent(), { ask: 'abort', at: AT_PROGRAM, reason: 'escaped' }]).last
    const stale = ended.did === 'ended' ? ended.ended : null

    const result = pickerStep(stale, startEvent({ sessionId: 'pick-2' }))
    expect(result.did === 'started' && result.displaced).toBeNull()
  })
})

describe('freezing', () => {
  it('fixes the selection on the clicked element and carries its selector', () => {
    const result = pickerStep(sessionIn('showing'), FREEZE)

    expect(result.did).toBe('changed')
    const session = sessionAfter(result)
    expect(session?.state).toBe('frozen')
    expect(selectedCandidate(session!)?.proposal.selector).toBe('.ad-slot')
    expect(session?.selection?.index).toBe(0)
  })

  it('keeps the whole chain, so widening needs no second round trip to the page', () => {
    const session = sessionIn('frozen')
    expect(session.selection?.chain).toEqual(CHAIN)
  })

  it('stops the chain below body', () => {
    // KTD11. `html` as a selector empties the page, and `body` very nearly does; this is a hard
    // upper bound rather than a warning, so the rungs above are not offered at all.
    const withRoot = [...CHAIN, candidate('body', 'body'), candidate('html', 'html')]
    const result = pickerStep(sessionIn('showing'), { ask: 'freeze', at: AT_VIEW, chain: withRoot })

    expect(sessionAfter(result)?.selection?.chain).toEqual(CHAIN)
    expect(PICKER_CHAIN_LIMIT_TAGS).toEqual(['body', 'html'])
  })

  it('reads the tag whatever case the page reported it in', () => {
    const withRoot = [...CHAIN, candidate('BODY', 'body')]
    const result = pickerStep(sessionIn('showing'), { ask: 'freeze', at: AT_VIEW, chain: withRoot })
    expect(sessionAfter(result)?.selection?.chain).toEqual(CHAIN)
  })

  it('does not freeze on body itself', () => {
    const result = pickerStep(sessionIn('showing'), {
      ask: 'freeze',
      at: AT_VIEW,
      chain: [candidate('body', 'body')]
    })

    expect(result.did).toBe('ignored')
    expect(sessionAfter(result)?.state).toBe('showing')
  })

  it('ignores a click that describes nothing', () => {
    const result = pickerStep(sessionIn('showing'), { ask: 'freeze', at: AT_VIEW, chain: [] })
    expect(result.did).toBe('ignored')
  })

  it('ignores a click from a view that is not the one being picked in', () => {
    // Every message from a page is a message from a renderer, and a renderer can be compromised.
    const result = pickerStep(sessionIn('showing'), {
      ask: 'freeze',
      at: { of: 'view', viewId: VIEW_ID + 1 },
      chain: CHAIN
    })

    expect(result.did).toBe('ignored')
    expect(sessionAfter(result)?.state).toBe('showing')
  })

  it('ignores a second click once the selection is frozen', () => {
    // The diagram has no second click: correcting the selection is the bar's job from here on, and
    // a click that re-froze somewhere else would move the selection under a person reading it.
    const frozen = sessionIn('frozen')
    const result = pickerStep(frozen, {
      ask: 'freeze',
      at: AT_VIEW,
      chain: [candidate('span', '.other')]
    })

    expect(result.did).toBe('ignored')
    expect(selectedCandidate(sessionAfter(result)!)?.proposal.selector).toBe('.ad-slot')
  })
})

describe('correcting the selection', () => {
  it('widens along the chain and stays frozen', () => {
    const result = pickerStep(sessionIn('frozen'), { ask: 'widen', at: AT_WINDOW })

    expect(result.did).toBe('changed')
    const session = sessionAfter(result)
    expect(session?.state).toBe('frozen')
    expect(session?.selection?.index).toBe(1)
    expect(selectedCandidate(session!)?.proposal.selector).toBe('#rail')
  })

  it('narrows back again', () => {
    const widened = sessionAfter(pickerStep(sessionIn('frozen'), { ask: 'widen', at: AT_WINDOW }))!
    const result = pickerStep(widened, { ask: 'narrow', at: AT_WINDOW })

    expect(sessionAfter(result)?.selection?.index).toBe(0)
    expect(selectedCandidate(sessionAfter(result)!)?.proposal.selector).toBe('.ad-slot')
  })

  it('will not widen past the top of the chain', () => {
    let session = sessionIn('frozen')
    for (const _step of CHAIN.slice(1)) {
      session = sessionAfter(pickerStep(session, { ask: 'widen', at: AT_WINDOW }))!
    }
    expect(canWidenSelection(session)).toBe(false)

    const result = pickerStep(session, { ask: 'widen', at: AT_WINDOW })
    expect(result.did).toBe('ignored')
    expect(sessionAfter(result)?.selection?.index).toBe(CHAIN.length - 1)
  })

  it('will not narrow below the element that was clicked', () => {
    const session = sessionIn('frozen')
    expect(canNarrowSelection(session)).toBe(false)

    const result = pickerStep(session, { ask: 'narrow', at: AT_WINDOW })
    expect(result.did).toBe('ignored')
    expect(sessionAfter(result)?.selection?.index).toBe(0)
  })

  it('offers both corrections in the middle of the chain', () => {
    const session = sessionAfter(pickerStep(sessionIn('frozen'), { ask: 'widen', at: AT_WINDOW }))!
    expect(canWidenSelection(session)).toBe(true)
    expect(canNarrowSelection(session)).toBe(true)
  })

  it('offers no correction while the rule is being written or measured', () => {
    for (const state of ['writing', 'measuring'] as const) {
      const session = sessionIn(state)
      expect(canWidenSelection(session), state).toBe(false)
      expect(canNarrowSelection(session), state).toBe(false)
    }
  })

  it('offers no correction while the pointer is still walking the page', () => {
    const session = sessionIn('showing')
    expect(canWidenSelection(session)).toBe(false)
    expect(canNarrowSelection(session)).toBe(false)
    expect(selectedCandidate(session)).toBeNull()
  })

  it('ignores a correction that arrives once the rule is on its way to the store', () => {
    // The text has already gone to the editor. Moving the selection now would leave the bar naming
    // one selector while another was being written.
    for (const state of ['writing', 'measuring'] as const) {
      const session = sessionIn(state)
      const result = pickerStep(session, { ask: 'widen', at: AT_WINDOW })
      expect(result.did, state).toBe('ignored')
      expect(sessionAfter(result)?.selection?.index, state).toBe(0)
    }
  })

  it('ignores a correction from a window that is not the one the bar is in', () => {
    const result = pickerStep(sessionIn('frozen'), {
      ask: 'widen',
      at: { of: 'window', windowId: WINDOW_ID + 1 }
    })

    expect(result.did).toBe('ignored')
    expect(sessionAfter(result)?.selection?.index).toBe(0)
  })
})

describe('confirming', () => {
  it('sends the frozen selection to be written', () => {
    const result = pickerStep(sessionIn('frozen'), CONFIRM)

    expect(result.did).toBe('changed')
    expect(sessionAfter(result)?.state).toBe('writing')
    // The selection survives, because the rule text and the undo both need it.
    expect(selectedCandidate(sessionAfter(result)!)?.proposal.selector).toBe('.ad-slot')
  })

  it('confirms nothing while there is nothing chosen', () => {
    const result = pickerStep(sessionIn('showing'), CONFIRM)
    expect(result.did).toBe('ignored')
    expect(sessionAfter(result)?.state).toBe('showing')
  })

  it('discards a second confirm while writing and while measuring', () => {
    // The defect this guards is a rule written twice by an impatient second press, which the bar
    // cannot prevent on its own: the press arrives before the first answer does.
    for (const state of ['writing', 'measuring'] as const) {
      const result = pickerStep(sessionIn(state), CONFIRM)
      expect(result.did, state).toBe('ignored')
      expect(sessionAfter(result)?.state, state).toBe(state)
    }
  })
})

describe('what the store answered', () => {
  it('goes on to measure when the rule was stored', () => {
    const result = pickerStep(sessionIn('writing'), WRITTEN_ADDED)

    expect(result.did).toBe('changed')
    expect(sessionAfter(result)?.state).toBe('measuring')
  })

  it('ends with the store’s own answer when nothing was stored', () => {
    const refusals: readonly Exclude<AddUserRuleOutcome, 'added'>[] = [
      'invalid',
      'duplicate-active',
      'duplicate-disabled',
      'limit-reached'
    ]

    for (const outcome of refusals) {
      const result = pickerStep(sessionIn('writing'), { ask: 'written', at: AT_PROGRAM, outcome })
      expect(result.did, outcome).toBe('ended')
      expect(result.did === 'ended' && result.outcome, outcome).toBe(outcome)
      expect(result.did === 'ended' && result.ended.state, outcome).toBe('ended')
    }
  })

  it('discards an answer that arrives in any other state', () => {
    for (const state of ['showing', 'frozen', 'measuring'] as const) {
      const result = pickerStep(sessionIn(state), WRITTEN_ADDED)
      expect(result.did, state).toBe('ignored')
      expect(sessionAfter(result)?.state, state).toBe(state)
    }
  })
})

describe('what the page measured', () => {
  it('reports success only when the matched elements are gone from view', () => {
    const result = pickerStep(sessionIn('measuring'), {
      ask: 'measured',
      at: AT_VIEW,
      matches: 3,
      visible: 0
    })

    expect(result.did).toBe('ended')
    expect(result.did === 'ended' && result.outcome).toBe('saved-effective')
  })

  it('reports no effect when the rule matched nothing at the moment of measuring', () => {
    // OQ1: nothing to match is "does not work here", not "wrong" — a slot loaded a second later
    // may still be hidden by the same rule.
    const result = pickerStep(sessionIn('measuring'), {
      ask: 'measured',
      at: AT_VIEW,
      matches: 0,
      visible: 0
    })

    expect(result.did === 'ended' && result.outcome).toBe('saved-ineffective')
  })

  it('reports no effect when the matched elements are still on screen', () => {
    // AE4: the rule stored and the page unchanged are two different things, and the whole feature
    // is being rebuilt because they used to look identical.
    const result = pickerStep(sessionIn('measuring'), {
      ask: 'measured',
      at: AT_VIEW,
      matches: 3,
      visible: 3
    })

    expect(result.did === 'ended' && result.outcome).toBe('saved-ineffective')
  })

  it('discards a measurement taken outside the measuring state', () => {
    for (const state of ['showing', 'frozen', 'writing'] as const) {
      const result = pickerStep(sessionIn(state), {
        ask: 'measured',
        at: AT_VIEW,
        matches: 3,
        visible: 0
      })
      expect(result.did, state).toBe('ignored')
      expect(sessionAfter(result)?.state, state).toBe(state)
    }
  })

  it('discards a measurement from another view', () => {
    const result = pickerStep(sessionIn('measuring'), {
      ask: 'measured',
      at: { of: 'view', viewId: VIEW_ID + 1 },
      matches: 3,
      visible: 0
    })

    expect(result.did).toBe('ignored')
  })
})

describe('ending', () => {
  const live: readonly Exclude<PickerSessionState, 'ended'>[] = [
    'showing',
    'frozen',
    'writing',
    'measuring'
  ]

  it('takes every event of R11 out of every state, including writing and measuring', () => {
    for (const state of live) {
      for (const reason of PICKER_ABORT_REASONS) {
        const result = pickerStep(sessionIn(state), { ask: 'abort', at: AT_PROGRAM, reason })
        expect(result.did, `${reason} in ${state}`).toBe('ended')
        expect(result.did === 'ended' && result.ended.state).toBe('ended')
        // No outcome: nobody was told anything, because the attempt was abandoned rather than
        // answered. R1 is about attempts that reach the store.
        expect(result.did === 'ended' && result.outcome, `${reason} in ${state}`).toBeNull()
        expect(sessionAfter(result)).toBeNull()
      }
    }
  })

  it('hands back the selection that was live, so the preview can be taken off', () => {
    const result = pickerStep(sessionIn('frozen'), {
      ask: 'abort',
      at: AT_WINDOW,
      reason: 'cancelled'
    })
    expect(result.did === 'ended' && result.ended.selection).not.toBeNull()

    const early = pickerStep(sessionIn('showing'), {
      ask: 'abort',
      at: AT_VIEW,
      reason: 'escaped'
    })
    expect(early.did === 'ended' && early.ended.selection).toBeNull()
  })

  it('ignores an abort for a tab or a window that is not the session’s', () => {
    // A tab closing in another window is one of R11's events happening to somebody else. Applied
    // to whatever session is current, it would take down a picker the user is still using.
    const frozen = sessionIn('frozen')
    for (const at of [
      { of: 'view', viewId: VIEW_ID + 1 },
      { of: 'window', windowId: WINDOW_ID + 1 }
    ] as const) {
      const result = pickerStep(frozen, { ask: 'abort', at, reason: 'tab-closed' })
      expect(result.did, at.of).toBe('ignored')
      expect(sessionAfter(result)?.state, at.of).toBe('frozen')
    }
  })

  it('ignores an event when no session is running at all', () => {
    const result = pickerStep(null, { ask: 'abort', at: AT_PROGRAM, reason: 'app-quit' })
    expect(result.did).toBe('ignored')
    expect(sessionAfter(result)).toBeNull()
  })

  it('takes no transition once it has ended', () => {
    const ended = pickerStep(sessionIn('frozen'), {
      ask: 'abort',
      at: AT_PROGRAM,
      reason: 'cancelled'
    })
    const stale = ended.did === 'ended' ? ended.ended : null

    const events: readonly PickerEvent[] = [
      FREEZE,
      { ask: 'widen', at: AT_WINDOW },
      { ask: 'narrow', at: AT_WINDOW },
      CONFIRM,
      WRITTEN_ADDED,
      { ask: 'measured', at: AT_VIEW, matches: 3, visible: 0 },
      { ask: 'abort', at: AT_PROGRAM, reason: 'window-closed' }
    ]

    for (const event of events) {
      const result = pickerStep(stale, event)
      expect(result.did, event.ask).toBe('ignored')
      expect(sessionAfter(result)?.state, event.ask).toBe('ended')
    }
  })
})

describe('every outcome of R1 is reachable and terminal', () => {
  /** One shortest path to each named answer, from nothing running. */
  const paths: Record<PickerOutcome, readonly PickerEvent[]> = {
    'saved-effective': [
      startEvent(),
      FREEZE,
      CONFIRM,
      WRITTEN_ADDED,
      { ask: 'measured', at: AT_VIEW, matches: 1, visible: 0 }
    ],
    'saved-ineffective': [
      startEvent(),
      FREEZE,
      CONFIRM,
      WRITTEN_ADDED,
      { ask: 'measured', at: AT_VIEW, matches: 1, visible: 1 }
    ],
    'duplicate-active': [
      startEvent(),
      FREEZE,
      CONFIRM,
      { ask: 'written', at: AT_PROGRAM, outcome: 'duplicate-active' }
    ],
    'duplicate-disabled': [
      startEvent(),
      FREEZE,
      CONFIRM,
      { ask: 'written', at: AT_PROGRAM, outcome: 'duplicate-disabled' }
    ],
    invalid: [
      startEvent(),
      FREEZE,
      CONFIRM,
      { ask: 'written', at: AT_PROGRAM, outcome: 'invalid' }
    ],
    'limit-reached': [
      startEvent(),
      FREEZE,
      CONFIRM,
      { ask: 'written', at: AT_PROGRAM, outcome: 'limit-reached' }
    ],
    'no-host': [startEvent({ host: null })],
    'not-filterable': [startEvent({ filterable: false })]
  }

  for (const outcome of PICKER_OUTCOMES) {
    it(`reaches ${outcome} and stops there`, () => {
      const { last, session } = run(paths[outcome])

      const reported =
        last.did === 'ended' ? last.outcome : last.did === 'refused' ? last.outcome : null
      expect(reported).toBe(outcome)
      // Terminal: nothing is left running, so nothing further can be decided.
      expect(session).toBeNull()
      expect(pickerStep(session, CONFIRM).did).toBe('ignored')
    })
  }

  it('reaches the two measured answers only from measuring', () => {
    // The whole reason "stored" and "works here" are two words: the write succeeding says nothing
    // about the document. Neither answer can be produced by any other transition.
    const measuredOnly: readonly PickerOutcome[] = ['saved-effective', 'saved-ineffective']
    for (const outcome of measuredOnly) {
      const path = paths[outcome]
      const beforeMeasuring = run(path.slice(0, -1))
      expect(beforeMeasuring.session?.state).toBe('measuring')
    }
  })
})

describe('the chain cut', () => {
  it('keeps a chain that never reaches the document root', () => {
    expect(pickableChain(CHAIN)).toEqual(CHAIN)
  })

  it('cuts at the first rung that is body or above', () => {
    expect(pickableChain([...CHAIN, candidate('body', 'body'), candidate('html', 'html')])).toEqual(
      CHAIN
    )
  })
})

describe('an abort reason is not a state', () => {
  it('keeps the two vocabularies apart', () => {
    // Named so the wiring can pass an event straight through without a translation table, which is
    // the point of R11 having one input.
    const states: readonly string[] = PICKER_SESSION_STATES
    for (const reason of PICKER_ABORT_REASONS satisfies readonly PickerAbortReason[]) {
      expect(states, reason).not.toContain(reason)
    }
  })
})
