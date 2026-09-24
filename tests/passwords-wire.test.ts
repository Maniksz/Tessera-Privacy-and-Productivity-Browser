import { describe, expect, it } from 'vitest'
import {
  SAVE_ANSWERS,
  asBadgeChrome,
  asFillAnswer,
  asFillRequest,
  asFillToken,
  asFormDescriptor,
  asSaveAnswer,
  asSaveBarChrome,
  asSubmissionReport,
  asSuggestPress
} from '@shared/passwords/wire.js'

/**
 * What crosses the autofill channels, and what is refused.
 *
 * Two different jobs in one file, and the distinction is the point.
 *
 * `asFormDescriptor`, `asFillRequest`, `asSuggestPress` and `asSubmissionReport` validate a message
 * *from a renderer*, which is a trust boundary: a compromised renderer would otherwise choose the
 * shape of the core's own data structures, and the field indices these produce are what decide which
 * control is treated as the password. `asSuggestPress` is the odd one in that group — its numbers
 * decide only *where a surface is drawn* — and it is validated as hard as the rest because the
 * arithmetic they reach turns a `NaN` into a surface with no bounds, which the layer then lays over
 * the whole window.
 *
 * `asBadgeChrome`, `asFillToken`, `asFillAnswer` and `asSaveBarChrome` read a reply *from the core*,
 * which is a totality boundary rather than a trust one: `sendSync` answers `undefined` when nothing
 * is listening, and that has to become "no badge" instead of a throw inside a preload — which would
 * take the whole page down with it.
 */

function fieldPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'password',
    name: 'pw',
    id: '',
    autocomplete: 'current-password',
    visible: true,
    editable: true,
    hasValue: false,
    ...overrides
  }
}

describe('a form description from a renderer', () => {
  it('accepts an ordinary one and lower-cases what a decision reads', () => {
    const form = asFormDescriptor({
      action: '/session',
      fields: [fieldPayload({ type: 'PASSWORD', autocomplete: 'Current-Password' })]
    })
    expect(form?.fields[0]?.type).toBe('password')
    expect(form?.fields[0]?.autocomplete).toBe('current-password')
  })

  it('assigns indices from position rather than taking them from the message', () => {
    /*
      Load-bearing. `fields.ts` compares indices to decide which name field precedes which password
      field, so a renderer that supplied its own could make two descriptors claim one control — and
      then choose which element a fill writes into.
    */
    const form = asFormDescriptor({
      action: null,
      fields: [fieldPayload({ type: 'text', index: 99 }), fieldPayload({ index: 99 })]
    })
    expect(form?.fields.map((entry) => entry.index)).toEqual([0, 1])
  })

  it('accepts a form with no action', () => {
    expect(asFormDescriptor({ action: null, fields: [fieldPayload()] })?.action).toBeNull()
  })

  it('refuses a description that is not an object', () => {
    expect(asFormDescriptor(undefined)).toBeNull()
    expect(asFormDescriptor('form')).toBeNull()
    expect(asFormDescriptor(null)).toBeNull()
  })

  it('refuses a field list that is not a list', () => {
    expect(asFormDescriptor({ action: null, fields: 'lots' })).toBeNull()
  })

  it('refuses an absurd number of fields', () => {
    const many = Array.from({ length: 201 }, () => fieldPayload())
    expect(asFormDescriptor({ action: null, fields: many })).toBeNull()
  })

  it('refuses an over-long action or attribute rather than trimming it', () => {
    expect(asFormDescriptor({ action: 'x'.repeat(2049), fields: [] })).toBeNull()
    expect(
      asFormDescriptor({ action: null, fields: [fieldPayload({ name: 'x'.repeat(257) })] })
    ).toBeNull()
  })

  it('refuses the whole report when one control is malformed', () => {
    /*
      Rather than skipping the bad one. A partial form is a form whose shape the core would be guessing
      at — and the roles are derived entirely from shape, so a missing control could turn the field
      after the password into "the username".
    */
    expect(
      asFormDescriptor({ action: null, fields: [fieldPayload(), { type: 'password' }] })
    ).toBeNull()
    expect(
      asFormDescriptor({ action: null, fields: [fieldPayload({ visible: 'yes' })] })
    ).toBeNull()
  })
})

describe('a fill request', () => {
  it('carries the form as well as the token, so the rules can be applied again', () => {
    const request = asFillRequest({
      token: 'tok-1',
      form: { action: null, fields: [fieldPayload()] }
    })
    expect(request?.token).toBe('tok-1')
    expect(request?.form.fields).toHaveLength(1)
  })

  it('refuses a request with no form, which could not be re-decided', () => {
    expect(asFillRequest({ token: 'tok-1' })).toBeNull()
  })

  it('refuses a request carrying an entry id where the token belongs', () => {
    // The shape the page used to send. A build that still sent one must be refused rather than
    // quietly matched against the vault: the whole of KTD8 is that the page never holds an entry id.
    expect(asFillRequest({ id: 'pw-1', form: { action: null, fields: [] } })).toBeNull()
  })

  it('refuses an empty or over-long token', () => {
    expect(asFillRequest({ token: '', form: { action: null, fields: [] } })).toBeNull()
    expect(asFillRequest({ token: 'x'.repeat(257), form: { action: null, fields: [] } })).toBeNull()
  })
})

describe('a badge press', () => {
  const field = { rect: { x: 10, y: 20, width: 200, height: 24 }, scale: 1, offsetX: 0, offsetY: 0 }
  const form = { action: null, fields: [fieldPayload()] }

  it('accepts a rectangle and the visual viewport the page reported', () => {
    const press = asSuggestPress({ form, field: { ...field, scale: 2, offsetX: 5, offsetY: 7 } })
    expect(press?.field).toEqual({
      rect: { x: 10, y: 20, width: 200, height: 24 },
      scale: 2,
      offsetX: 5,
      offsetY: 7
    })
  })

  it('accepts a field scrolled above the viewport, which is an ordinary negative rectangle', () => {
    expect(
      asSuggestPress({ form, field: { ...field, rect: { ...field.rect, y: -400 } } })
    ).not.toBeNull()
  })

  it('refuses a rectangle carrying NaN or an infinity', () => {
    /*
      The failure this exists for is not a leak: it is a surface. Every one of these travels through
      the placement arithmetic in `suggest-bounds.ts` and comes out as bounds that are not numbers,
      and the overlay layer would take them and cover the window with a view nothing can click past.
    */
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(
        asSuggestPress({ form, field: { ...field, rect: { ...field.rect, x: bad } } })
      ).toBeNull()
      expect(asSuggestPress({ form, field: { ...field, scale: bad } })).toBeNull()
    }
  })

  it('refuses a rectangle further away than any screen', () => {
    expect(
      asSuggestPress({ form, field: { ...field, rect: { ...field.rect, y: 1_000_001 } } })
    ).toBeNull()
  })

  it('refuses a field with no area and a scale that would flip the placement', () => {
    expect(
      asSuggestPress({ form, field: { ...field, rect: { ...field.rect, width: 0 } } })
    ).toBeNull()
    expect(
      asSuggestPress({ form, field: { ...field, rect: { ...field.rect, height: 0 } } })
    ).toBeNull()
    expect(asSuggestPress({ form, field: { ...field, scale: -1 } })).toBeNull()
    expect(asSuggestPress({ form, field: { ...field, scale: 0 } })).toBeNull()
  })

  it('refuses a press with no form, no field, or numbers that are not numbers', () => {
    expect(asSuggestPress({ field })).toBeNull()
    expect(asSuggestPress({ form })).toBeNull()
    expect(asSuggestPress({ form, field: { ...field, rect: '10,20' } })).toBeNull()
    expect(asSuggestPress({ form, field: { ...field, offsetX: '0' } })).toBeNull()
    expect(asSuggestPress(undefined)).toBeNull()
  })
})

describe('a submission report', () => {
  it('accepts a credential the user typed', () => {
    const report = asSubmissionReport({
      form: { action: null, fields: [fieldPayload({ hasValue: true })] },
      username: 'alice',
      password: 'hunter2'
    })
    expect(report?.username).toBe('alice')
  })

  it('accepts an empty username, which a change-password form produces', () => {
    const report = asSubmissionReport({
      form: { action: null, fields: [fieldPayload({ hasValue: true })] },
      username: '',
      password: 'hunter2'
    })
    expect(report?.username).toBe('')
  })

  it('refuses an over-long username or password rather than storing a truncated one', () => {
    const form = { action: null, fields: [fieldPayload({ hasValue: true })] }
    expect(asSubmissionReport({ form, username: 'x'.repeat(321), password: 'p' })).toBeNull()
    expect(asSubmissionReport({ form, username: 'a', password: 'x'.repeat(1025) })).toBeNull()
  })

  it('refuses a report with no form or wrong types', () => {
    expect(asSubmissionReport({ username: 'a', password: 'p' })).toBeNull()
    expect(
      asSubmissionReport({ form: { action: null, fields: [] }, username: 1, password: 'p' })
    ).toBeNull()
    expect(asSubmissionReport(null)).toBeNull()
  })
})

describe('a save answer', () => {
  it('accepts only the three verbs', () => {
    for (const answer of SAVE_ANSWERS) {
      expect(asSaveAnswer(answer)).toBe(answer)
    }
    expect(asSaveAnswer('always')).toBeNull()
    expect(asSaveAnswer(1)).toBeNull()
    expect(asSaveAnswer(undefined)).toBeNull()
  })
})

describe('the badge’s wording from the core', () => {
  it('accepts a stylesheet and a label', () => {
    expect(asBadgeChrome({ styles: '.badge{}', label: 'Fill in a saved password' })).toEqual({
      styles: '.badge{}',
      label: 'Fill in a saved password'
    })
  })

  it('refuses a badge with no name, which nothing could read out', () => {
    // A control a screen reader cannot name is one a keyboard user cannot use, and drawing it anyway
    // would put an unreachable button on top of somebody's password field.
    expect(asBadgeChrome({ styles: '.badge{}', label: '' })).toBeNull()
    expect(asBadgeChrome({ styles: '.badge{}' })).toBeNull()
  })

  it('refuses an answer from a build that has no responder, so no badge is drawn at all', () => {
    expect(asBadgeChrome(undefined)).toBeNull()
    expect(asBadgeChrome(null)).toBeNull()
  })

  it('copies out the named fields and nothing else the message carried', () => {
    // What reaches a page's document is the shape, not whatever else rode along with it.
    expect(asBadgeChrome({ styles: '', label: 'Fill', site: 'example.com' })).toEqual({
      styles: '',
      label: 'Fill'
    })
  })
})

describe('the end of a list', () => {
  it('accepts a token', () => {
    expect(asFillToken('tok-1')).toBe('tok-1')
  })

  it('reads every other value as "the list simply left"', () => {
    // Including a malformed one. The consequence is that the badge stops looking open, which is
    // exactly what a build mismatch should produce — and a token is worth nothing except to the
    // core that minted it.
    expect(asFillToken(null)).toBeNull()
    expect(asFillToken('')).toBeNull()
    expect(asFillToken(undefined)).toBeNull()
    expect(asFillToken({ token: 'tok-1' })).toBeNull()
  })
})

describe('a fill answer from the core', () => {
  it('accepts a credential', () => {
    expect(asFillAnswer({ username: 'alice', password: 'hunter2' })).toEqual({
      username: 'alice',
      password: 'hunter2'
    })
  })

  it('accepts an empty username', () => {
    expect(asFillAnswer({ username: '', password: 'hunter2' })?.username).toBe('')
  })

  it('refuses an empty password, which would clear a field the user had typed into', () => {
    // The core never sends one; refusing here means a build mismatch cannot either, and the failure
    // then looks like "autofill did nothing" rather than "autofill wiped my password field".
    expect(asFillAnswer({ username: 'alice', password: '' })).toBeNull()
  })

  it('refuses a refusal, which is what the core answers when a rule said no', () => {
    expect(asFillAnswer(null)).toBeNull()
    expect(asFillAnswer(undefined)).toBeNull()
  })
})

describe('the save bar’s wording', () => {
  it('accepts a complete set', () => {
    const chrome = {
      styles: '.a{}',
      message: 'Save?',
      username: 'alice',
      saveLabel: 'Save',
      neverLabel: 'Never',
      dismissLabel: 'Not now'
    }
    expect(asSaveBarChrome(chrome)).toEqual(chrome)
  })

  it('refuses an incomplete set, so no bar is drawn with a blank button', () => {
    // A wordless prompt about the user's password is worse than none: they would be answering a
    // question they cannot read.
    expect(asSaveBarChrome({ styles: '.a{}', message: 'Save?' })).toBeNull()
    expect(asSaveBarChrome(undefined)).toBeNull()
  })
})
