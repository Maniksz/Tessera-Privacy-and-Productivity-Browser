import { describe, expect, it } from 'vitest'
import {
  chooseFillTargets,
  chooseSaveTargets,
  type FieldDescriptor,
  type FormDescriptor
} from '@shared/passwords/fields.js'

/**
 * Which field is the password and which is the username.
 *
 * These are the rules that replace a stored selector, so the thing to check is not only that they
 * pick sensibly on an ordinary login form but that they pick *differently* for a fill and for a save.
 * A fill must never put the existing password into a "choose a new password" box; a save must prefer
 * exactly that box, because it is where the password the user will need next was typed.
 *
 * Getting that asymmetry backwards on a change-password form would store the password the user has
 * just replaced — the single most damaging outcome this feature has available — so both directions
 * are pinned here.
 */

function field(overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return {
    index: 0,
    type: 'text',
    name: '',
    id: '',
    autocomplete: '',
    visible: true,
    editable: true,
    hasValue: false,
    ...overrides
  }
}

/** Indices are assigned from position, exactly as `wire.ts` does when a report arrives. */
function form(fields: Array<Partial<FieldDescriptor>>, action: string | null = null): FormDescriptor {
  return { action, fields: fields.map((overrides, index) => field({ ...overrides, index })) }
}

describe('an ordinary sign-in form', () => {
  it('takes the password field and the text field before it', () => {
    const targets = chooseFillTargets(form([{ type: 'text', name: 'user' }, { type: 'password' }]))
    expect(targets?.password.index).toBe(1)
    expect(targets?.username?.index).toBe(0)
  })

  it('prefers a field the site declared as the username, wherever it sits', () => {
    // A site that bothered to write `autocomplete="username"` is telling the truth about its own
    // form, and source order is only a fallback.
    const targets = chooseFillTargets(
      form([
        { type: 'text', name: 'captcha' },
        { type: 'password' },
        { type: 'text', autocomplete: 'username' }
      ])
    )
    expect(targets?.username?.index).toBe(2)
  })

  it('takes the nearest preceding text field rather than the first one', () => {
    // The field after a password is a confirmation box or a search far more often than a login name,
    // and the field farthest before it is usually something else entirely.
    const targets = chooseFillTargets(
      form([{ type: 'text', name: 'search' }, { type: 'email', name: 'login' }, { type: 'password' }])
    )
    expect(targets?.username?.index).toBe(1)
  })

  it('accepts an email or a telephone field as the name', () => {
    expect(chooseFillTargets(form([{ type: 'email' }, { type: 'password' }]))?.username?.index).toBe(0)
    expect(chooseFillTargets(form([{ type: 'tel' }, { type: 'password' }]))?.username?.index).toBe(0)
  })

  it('does not take a search box as the name', () => {
    // A search field in the same form as a password is a page layout accident, not a login name.
    expect(chooseFillTargets(form([{ type: 'search' }, { type: 'password' }]))?.username).toBeNull()
  })

  it('fills a password-only second step, where there is no name field at all', () => {
    // A real case rather than a defensive branch: two-step sign-in asks for the address first.
    const targets = chooseFillTargets(form([{ type: 'password' }]))
    expect(targets?.password.index).toBe(0)
    expect(targets?.username).toBeNull()
  })
})

describe('a form that must not be filled', () => {
  it('refuses a form with no password field', () => {
    expect(chooseFillTargets(form([{ type: 'text' }, { type: 'email' }]))).toBeNull()
  })

  it('refuses a hidden password field', () => {
    expect(chooseFillTargets(form([{ type: 'password', visible: false }]))).toBeNull()
  })

  it('refuses a disabled or read-only password field', () => {
    expect(chooseFillTargets(form([{ type: 'password', editable: false }]))).toBeNull()
  })

  it('refuses a form whose only password field is a new-password box', () => {
    /*
      A sign-up or "choose a new password" form. Putting the *existing* password there is wrong in a
      way that destroys something: the user submits without looking and the account's password has
      been set back to the old one.
    */
    expect(chooseFillTargets(form([{ type: 'password', autocomplete: 'new-password' }]))).toBeNull()
  })

  it('fills the current-password box of a change-password form and leaves the new one alone', () => {
    const targets = chooseFillTargets(
      form([
        { type: 'password', autocomplete: 'current-password' },
        { type: 'password', autocomplete: 'new-password' },
        { type: 'password', autocomplete: 'new-password' }
      ])
    )
    expect(targets?.password.index).toBe(0)
  })

  it('prefers the declared current-password box over the first password field', () => {
    const targets = chooseFillTargets(
      form([{ type: 'password' }, { type: 'password', autocomplete: 'current-password' }])
    )
    expect(targets?.password.index).toBe(1)
  })

  it('reads a multi-token autocomplete attribute', () => {
    // `autocomplete="section-login current-password"` is valid and common.
    const targets = chooseFillTargets(
      form([{ type: 'password' }, { type: 'password', autocomplete: 'section-login current-password' }])
    )
    expect(targets?.password.index).toBe(1)
  })
})

describe('what a save reads, which is not what a fill writes', () => {
  it('takes the new password on a change-password form, never the one being replaced', () => {
    /*
      The asymmetry that matters. Taking the first field with a value here would store the password
      the user has just retired — and the manager would then confidently offer a password that no
      longer works, with the correct one nowhere.
    */
    const targets = chooseSaveTargets(
      form([
        { type: 'password', autocomplete: 'current-password', hasValue: true },
        { type: 'password', autocomplete: 'new-password', hasValue: true }
      ])
    )
    expect(targets?.password.index).toBe(1)
  })

  it('takes the new password on a sign-up form', () => {
    const targets = chooseSaveTargets(
      form([
        { type: 'email', hasValue: true },
        { type: 'password', autocomplete: 'new-password', hasValue: true },
        { type: 'password', autocomplete: 'new-password', hasValue: true }
      ])
    )
    expect(targets?.password.index).toBe(1)
    expect(targets?.username?.index).toBe(0)
  })

  it('takes the only password on a sign-in form', () => {
    const targets = chooseSaveTargets(
      form([{ type: 'text', hasValue: true }, { type: 'password', hasValue: true }])
    )
    expect(targets?.password.index).toBe(1)
    expect(targets?.username?.index).toBe(0)
  })

  it('ignores a confirmation box the user never filled in', () => {
    const targets = chooseSaveTargets(
      form([
        { type: 'password', hasValue: true },
        { type: 'password', hasValue: false, autocomplete: 'new-password' }
      ])
    )
    expect(targets?.password.index).toBe(0)
  })

  it('refuses a submission with no filled password at all', () => {
    expect(chooseSaveTargets(form([{ type: 'text', hasValue: true }, { type: 'password' }]))).toBeNull()
  })

  it('prefers a declared username field over the nearest preceding one', () => {
    const targets = chooseSaveTargets(
      form([
        { type: 'text', hasValue: true, name: 'other' },
        { type: 'password', hasValue: true },
        { type: 'email', hasValue: true, autocomplete: 'email' }
      ])
    )
    expect(targets?.username?.index).toBe(2)
  })

  it('reports no username when a change-password form has none', () => {
    const targets = chooseSaveTargets(form([{ type: 'password', hasValue: true }]))
    expect(targets?.username).toBeNull()
  })

  it('does not read a field the user cannot see, even when it holds something', () => {
    // A hidden field pre-filled by the page is the page's value, not the user's.
    expect(chooseSaveTargets(form([{ type: 'password', hasValue: true, visible: false }]))).toBeNull()
  })
})
