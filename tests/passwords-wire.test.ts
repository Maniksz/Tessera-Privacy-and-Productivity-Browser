import { describe, expect, it } from 'vitest'
import {
  SAVE_ANSWERS,
  asFillAnswer,
  asFillOffer,
  asFillRequest,
  asFormDescriptor,
  asSaveAnswer,
  asSaveBarChrome,
  asSubmissionReport
} from '@shared/passwords/wire.js'

/**
 * What crosses the autofill channels, and what is refused.
 *
 * Two different jobs in one file, and the distinction is the point.
 *
 * `asFormDescriptor`, `asFillRequest` and `asSubmissionReport` validate a message *from a renderer*,
 * which is a trust boundary: a compromised renderer would otherwise choose the shape of the core's
 * own data structures, and the field indices these produce are what decide which control is treated
 * as the password.
 *
 * `asFillOffer`, `asFillAnswer` and `asSaveBarChrome` read a reply *from the core*, which is a
 * totality boundary rather than a trust one: `sendSync` answers `undefined` when nothing is
 * listening, and that has to become "no suggestion" instead of a throw inside a preload — which would
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
    expect(asFormDescriptor({ action: null, fields: [fieldPayload({ name: 'x'.repeat(257) })] })).toBeNull()
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
    expect(asFormDescriptor({ action: null, fields: [fieldPayload({ visible: 'yes' })] })).toBeNull()
  })
})

describe('a fill request', () => {
  it('carries the form as well as the id, so the rules can be applied again', () => {
    const request = asFillRequest({ id: 'pw-1', form: { action: null, fields: [fieldPayload()] } })
    expect(request?.id).toBe('pw-1')
    expect(request?.form.fields).toHaveLength(1)
  })

  it('refuses a request with no form, which could not be re-decided', () => {
    expect(asFillRequest({ id: 'pw-1' })).toBeNull()
  })

  it('refuses an empty or over-long id', () => {
    expect(asFillRequest({ id: '', form: { action: null, fields: [] } })).toBeNull()
    expect(asFillRequest({ id: 'x'.repeat(257), form: { action: null, fields: [] } })).toBeNull()
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
    expect(asSubmissionReport({ form: { action: null, fields: [] }, username: 1, password: 'p' })).toBeNull()
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

describe('an offer from the core', () => {
  const chrome = { styles: '.a{}', title: 'Passwords for example.com', noUsernameLabel: '(none)' }

  it('accepts a list of usernames with its wording', () => {
    const offer = asFillOffer({ entries: [{ id: 'a', username: 'alice' }], chrome })
    expect(offer?.entries[0]?.username).toBe('alice')
  })

  it('refuses an empty list, so the preload can never draw a list of nothing', () => {
    // An empty suggestion list would tell a page that the user has *no* credential for it, which is
    // itself a small fact about the user.
    expect(asFillOffer({ entries: [], chrome })).toBeNull()
  })

  it('refuses an answer from a build that has no responder', () => {
    expect(asFillOffer(undefined)).toBeNull()
    expect(asFillOffer(null)).toBeNull()
  })

  it('refuses an offer with no wording or a malformed entry', () => {
    expect(asFillOffer({ entries: [{ id: 'a', username: 'alice' }] })).toBeNull()
    expect(asFillOffer({ entries: [{ id: 'a' }], chrome })).toBeNull()
    expect(asFillOffer({ entries: 'alice', chrome })).toBeNull()
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
