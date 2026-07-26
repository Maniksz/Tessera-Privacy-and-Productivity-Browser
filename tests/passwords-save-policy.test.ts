import { describe, expect, it } from 'vitest'
import { MAX_PASSWORD_LENGTH } from '@shared/passwords/model.js'
import { decideSaveOffer, type SaveOfferContext } from '@shared/passwords/save-policy.js'

/**
 * Whether the browser may *offer* to remember a credential.
 *
 * The headline requirement here is the private window: it must not save, and it must not offer to
 * save. Both halves are tested — this file for the offer, `tests/password-store.test.ts` for the
 * writer that keeps nothing — because one of them alone would be a convention rather than an
 * invariant.
 *
 * The signature is the other thing worth pinning: this function receives a password *length* and a
 * three-valued "what is already stored", never a secret. A test cannot prove a negative about future
 * edits, but it can record the shape, so a change that started passing passwords in would have to
 * rewrite these fixtures and be seen.
 */

function context(overrides: Partial<SaveOfferContext> = {}): SaveOfferContext {
  return {
    mode: 'normal',
    frameUrl: 'https://example.com/login',
    isTopLevelFrame: true,
    topLevelUrl: 'https://example.com/login',
    passwordLength: 12,
    neverSaved: [],
    existing: 'none',
    ...overrides
  }
}

describe('a private window must not save and must not offer to save', () => {
  it('refuses to offer, even for a credential it would otherwise have asked about', () => {
    /*
      Refused *first*, before any other rule can be the reason. If the order were reversed, a private
      window on an https page with a brand-new credential would be refused by accident — and the day
      one of the other rules changed, the guarantee would quietly go with it.
    */
    expect(decideSaveOffer(context({ mode: 'private' }))).toEqual({
      offer: 'none',
      reason: 'private-window'
    })
  })

  it('refuses to offer even where a normal window would offer an update', () => {
    expect(decideSaveOffer(context({ mode: 'private', existing: 'different-password' }))).toEqual({
      offer: 'none',
      reason: 'private-window'
    })
  })
})

describe('the ordinary cases', () => {
  it('offers to create for a site with nothing stored', () => {
    expect(decideSaveOffer(context())).toEqual({ offer: 'create' })
  })

  it('offers to update when the stored password differs', () => {
    // A different question with a different consequence, so the bar has to be able to say which.
    expect(decideSaveOffer(context({ existing: 'different-password' }))).toEqual({ offer: 'update' })
  })

  it('asks nothing at all when the same password is already stored', () => {
    // What keeps the bar from appearing on every single sign-in — the reason people leave it enabled.
    expect(decideSaveOffer(context({ existing: 'same-password' }))).toEqual({
      offer: 'none',
      reason: 'unchanged'
    })
  })
})

describe('nothing is collected that could never be filled back', () => {
  it('refuses to offer on a plain-http page', () => {
    /*
      A credential the fill policy would always refuse is a row that looks like a working entry and is
      not — and collecting it would put a password the user has just sent in clear text into a second
      place. The passwords page can still add such an entry by hand, where the choice is explicit.
    */
    expect(
      decideSaveOffer(
        context({ frameUrl: 'http://example.com/login', topLevelUrl: 'http://example.com/login' })
      )
    ).toEqual({ offer: 'none', reason: 'insecure-page' })
  })

  it('offers on http loopback, where a fill would also be allowed', () => {
    expect(
      decideSaveOffer(
        context({ frameUrl: 'http://localhost:3000/login', topLevelUrl: 'http://localhost:3000/login' })
      )
    ).toEqual({ offer: 'create' })
  })

  it('refuses a document with no origin to file a credential under', () => {
    expect(
      decideSaveOffer(context({ frameUrl: 'file:///tmp/x.html', topLevelUrl: 'file:///tmp/x.html' }))
    ).toEqual({ offer: 'none', reason: 'unsupported-scheme' })
  })
})

describe('a framed form is not offered either', () => {
  it('refuses a submission from a subframe', () => {
    /*
      The mirror of the fill rule. A framed form whose credential could get remembered would let an
      embedding page teach the manager that its own harvested credential belongs to the framed site —
      and from then on the manager would offer it there.
    */
    expect(decideSaveOffer(context({ isTopLevelFrame: false }))).toEqual({
      offer: 'none',
      reason: 'cross-origin-frame'
    })
  })

  it('refuses a top-level claim that disagrees with the frame tree', () => {
    expect(decideSaveOffer(context({ topLevelUrl: 'https://evil.example/' }))).toEqual({
      offer: 'none',
      reason: 'cross-origin-frame'
    })
  })

  it('refuses when the top-level address cannot be read', () => {
    expect(decideSaveOffer(context({ topLevelUrl: null }))).toEqual({
      offer: 'none',
      reason: 'cross-origin-frame'
    })
  })

  it('refuses when the top-level address is not parseable', () => {
    expect(decideSaveOffer(context({ topLevelUrl: 'about:blank' }))).toEqual({
      offer: 'none',
      reason: 'cross-origin-frame'
    })
  })
})

describe('what the user has already answered', () => {
  it('never asks again on a site the user said "never" for', () => {
    // Without this the bar is nagware, and a prompt that cannot be turned off teaches people to
    // dismiss prompts without reading them — which makes every other prompt in the browser worth
    // less.
    expect(decideSaveOffer(context({ neverSaved: ['https://example.com'] }))).toEqual({
      offer: 'none',
      reason: 'never-here'
    })
  })

  it('still asks on a different origin of the same site', () => {
    // "Never here" is per origin, deliberately: `https://example.com` and
    // `https://intranet.example.com` are different sign-ins, and a site-wide refusal would be a
    // much larger answer than the user gave.
    expect(
      decideSaveOffer(
        context({
          neverSaved: ['https://intranet.example.com'],
          frameUrl: 'https://example.com/login'
        })
      )
    ).toEqual({ offer: 'create' })
  })
})

describe('an implausible password', () => {
  it('refuses an empty one', () => {
    expect(decideSaveOffer(context({ passwordLength: 0 }))).toEqual({
      offer: 'none',
      reason: 'no-password'
    })
  })

  it('refuses one longer than the store would accept, rather than truncating it', () => {
    // A megabyte in a password field is not a password; it is a page seeing what the browser does
    // with one. Truncating would store something that cannot sign in.
    expect(decideSaveOffer(context({ passwordLength: MAX_PASSWORD_LENGTH + 1 }))).toEqual({
      offer: 'none',
      reason: 'password-too-long'
    })
  })

  it('accepts one exactly at the limit', () => {
    expect(decideSaveOffer(context({ passwordLength: MAX_PASSWORD_LENGTH }))).toEqual({ offer: 'create' })
  })
})
