import { describe, expect, it } from 'vitest'
import {
  REVEAL_TIMEOUT_MS,
  isRevealExpired,
  isRevealed,
  nextRevealState,
  revealRemainingMs,
  revealState
} from '@shared/passwords/reveal.js'
import { isFillGestureInput } from '@shared/passwords/gesture.js'

/**
 * What the passwords page is allowed to be holding, and for how long.
 *
 * Since `safeStorage` cannot re-authenticate anybody — the argument is written out in
 * `shared/passwords/reveal.ts`, along with the master-password design that would fix it — the
 * protection this page can actually offer is a *bound*: one password at a time, for half a minute,
 * and gone the moment the document stops being visible. A bound is only worth having if it is
 * enforced by something that was tested, which is what this file is.
 */

const T0 = 1_700_000_000_000

describe('at most one password is on screen', () => {
  it('replaces the revealed entry rather than adding to it', () => {
    // There is no action that can produce two, which is the property that makes "the whole vault is
    // never on screen" true by construction rather than by every handler remembering to hide the
    // previous one.
    const first = revealState('a', T0)
    const second = nextRevealState(first, { kind: 'reveal', id: 'b', at: T0 + 10 })
    expect(second).toEqual({ id: 'b', revealedAt: T0 + 10 })
  })

  it('answers only for the entry actually revealed', () => {
    const state = revealState('a', T0)
    expect(isRevealed(state, 'a', T0)).toBe(true)
    expect(isRevealed(state, 'b', T0)).toBe(false)
    expect(isRevealed(null, 'a', T0)).toBe(false)
  })
})

describe('a reveal expires by itself', () => {
  it('survives up to the timeout', () => {
    expect(isRevealExpired(revealState('a', T0), T0 + REVEAL_TIMEOUT_MS - 1)).toBe(false)
  })

  it('is over at the timeout', () => {
    expect(isRevealExpired(revealState('a', T0), T0 + REVEAL_TIMEOUT_MS)).toBe(true)
  })

  it('is dropped by a tick past the timeout', () => {
    expect(nextRevealState(revealState('a', T0), { kind: 'tick', at: T0 + REVEAL_TIMEOUT_MS })).toBeNull()
  })

  it('is kept by a tick inside the timeout', () => {
    const state = revealState('a', T0)
    expect(nextRevealState(state, { kind: 'tick', at: T0 + 1000 })).toBe(state)
  })

  it('treats a clock that moved backwards as expired', () => {
    // An NTP correction or a resumed laptop. Erring towards hiding is the only direction where being
    // wrong costs the user a click rather than a secret.
    expect(isRevealExpired(revealState('a', T0), T0 - 1)).toBe(true)
    expect(isRevealed(revealState('a', T0), 'a', T0 - 1)).toBe(false)
  })

  it('ticks harmlessly with nothing revealed', () => {
    expect(nextRevealState(null, { kind: 'tick', at: T0 })).toBeNull()
  })
})

describe('a reveal is dropped when the document stops being visible', () => {
  it('is cleared by concealment', () => {
    // Another tab, a minimised window, a locked screen — each is a moment when a password on screen
    // has stopped being something the user is looking at.
    expect(nextRevealState(revealState('a', T0), { kind: 'concealed' })).toBeNull()
  })

  it('is cleared by an explicit hide', () => {
    expect(nextRevealState(revealState('a', T0), { kind: 'hide' })).toBeNull()
  })
})

describe('the countdown a user can be shown', () => {
  it('counts down and clamps at zero', () => {
    expect(revealRemainingMs(revealState('a', T0), T0)).toBe(REVEAL_TIMEOUT_MS)
    expect(revealRemainingMs(revealState('a', T0), T0 + 1000)).toBe(REVEAL_TIMEOUT_MS - 1000)
    expect(revealRemainingMs(revealState('a', T0), T0 + REVEAL_TIMEOUT_MS + 5000)).toBe(0)
  })
})

describe('what counts as the user asking for something', () => {
  it('accepts a press and refuses a drift', () => {
    /*
      The gesture the fill rules require, read from the core's own `input-event` record. `mouseMove` is
      excluded on purpose: a pointer crossing a page while somebody reads is not consent, and counting
      it would leave the window permanently open on any page the mouse happens to be over.
    */
    expect(isFillGestureInput({ type: 'mouseDown' })).toBe(true)
    expect(isFillGestureInput({ type: 'keyDown' })).toBe(true)
    expect(isFillGestureInput({ type: 'char' })).toBe(true)
    expect(isFillGestureInput({ type: 'mouseMove' })).toBe(false)
    expect(isFillGestureInput({ type: 'mouseWheel' })).toBe(false)
  })

  it('refuses a payload that is not an input event at all', () => {
    // `input-event` hands over an untyped payload, so recognising it safely has to be total: a throw
    // inside this path would take the fill decision with it.
    expect(isFillGestureInput(null)).toBe(false)
    expect(isFillGestureInput(undefined)).toBe(false)
    expect(isFillGestureInput('mouseDown')).toBe(false)
    expect(isFillGestureInput({})).toBe(false)
    expect(isFillGestureInput({ type: 42 })).toBe(false)
  })
})
