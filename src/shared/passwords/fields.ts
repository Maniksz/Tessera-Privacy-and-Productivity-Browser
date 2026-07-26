/**
 * Which field is the password and which is the username, decided from the form's *shape*
 * rather than from anything remembered.
 *
 * ## Why this is not a stored selector
 *
 * The obvious design is to remember, per site, which input to fill. `model.ts` explains at
 * length why that is refused: a stored selector fingerprints the user's account page and goes
 * stale on a redesign. This file is the alternative — the roles are derived fresh from the
 * live document on every offer, so there is nothing to become wrong.
 *
 * ## Why it is pure, and DOM-free
 *
 * The preload transcribes each control into a `FieldDescriptor` and calls in here, exactly as
 * the element picker transcribes an element into a `PickerElement`. That is what makes "a
 * change-password form is not offered the old password" a unit test rather than something only
 * a running browser can be asked — and it keeps this module out of the eTLD table, which the
 * preload bundle must not carry.
 */

/** One form control, reduced to what a role decision needs. */
export interface FieldDescriptor {
  /**
   * Position in the descriptor's own list, so the preload can find the element again.
   *
   * An index rather than a selector, for the same reason nothing is stored: it is valid for
   * exactly the one round trip that produced it and cannot be mistaken for a durable name.
   */
  readonly index: number
  /** `type` as the browser resolved it, lower-cased. An unknown `type` resolves to `text`. */
  readonly type: string
  readonly name: string
  readonly id: string
  /** `autocomplete`, lower-cased. The one hint sites give on purpose. */
  readonly autocomplete: string
  /** False for `hidden`, `display:none`, zero-sized and off-screen fields. */
  readonly visible: boolean
  /** False when `disabled` or `readonly`: a field the user could not type into. */
  readonly editable: boolean
  /** Whether the field currently holds anything. Never the value itself. */
  readonly hasValue: boolean
}

export interface FormDescriptor {
  /**
   * The `action` attribute exactly as written, or `null` when the form has none.
   *
   * Unresolved on purpose — `fill-policy.ts` resolves it, because how a relative, a
   * protocol-relative and a scheme-bearing action each resolve is part of what that file is
   * tested on.
   */
  readonly action: string | null
  readonly fields: readonly FieldDescriptor[]
}

/**
 * Types that can hold a username.
 *
 * `tel` is in because phone-number sign-in exists. `search` is deliberately out: a search box
 * in the same form as a password field is a page layout accident, not a login name.
 */
const USERNAME_TYPES: ReadonlySet<string> = new Set(['text', 'email', 'tel'])

/** Autocomplete tokens that name a login field. `nickname` is not one of them. */
const USERNAME_TOKENS: ReadonlySet<string> = new Set(['username', 'email'])

function tokens(autocomplete: string): string[] {
  return autocomplete
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((token) => token !== '')
}

function hasToken(field: FieldDescriptor, token: string): boolean {
  return tokens(field.autocomplete).includes(token)
}

function isUsable(field: FieldDescriptor): boolean {
  return field.visible && field.editable
}

function isPassword(field: FieldDescriptor): boolean {
  return field.type === 'password'
}

export interface FillTargets {
  readonly password: FieldDescriptor
  /**
   * `null` when the form has no field to put a name in.
   *
   * A real case rather than a defensive branch: a two-step sign-in asks for the address on one
   * page and the password on the next, so the second page has a password field and nothing
   * else. The fill still works; only the name has nowhere to go.
   */
  readonly username: FieldDescriptor | null
}

/**
 * The fields a fill would write to, or `null` when this form is not one to fill.
 *
 * Two refusals, and the second is the one worth arguing about:
 *
 *   - no usable password field at all — not a sign-in form, so nothing is offered;
 *   - every password field marked `autocomplete="new-password"`. That is a "choose a new
 *     password" box, and putting the *existing* password there is wrong in a way that can
 *     destroy something: the user submits without looking and the account's password has been
 *     set back to the old one. Refusing costs nothing, because a new password is not something
 *     the manager knows.
 *
 * A form with both — `current-password` and `new-password`, the change-password shape — fills
 * the current one and leaves the new one alone, which is exactly right.
 */
export function chooseFillTargets(form: FormDescriptor): FillTargets | null {
  const usable = form.fields.filter(isUsable)
  const passwords = usable.filter(isPassword).filter((field) => !hasToken(field, 'new-password'))
  const [preferred] = passwords.filter((field) => hasToken(field, 'current-password'))
  const [firstPassword] = passwords
  const password = preferred ?? firstPassword
  if (password === undefined) return null

  return { password, username: chooseUsernameField(usable, password) }
}

/**
 * The name field for a given password field.
 *
 * An explicit `autocomplete` hint wins wherever it sits, because a site that bothered to
 * declare it is telling the truth about its own form. Failing that, the *nearest preceding*
 * usable text field is taken: source order is how login forms are built, and the field after
 * the password is a "confirm" or a search box far more often than it is a login name.
 */
function chooseUsernameField(
  usable: readonly FieldDescriptor[],
  password: FieldDescriptor
): FieldDescriptor | null {
  const [declared] = usable.filter(
    (field) => !isPassword(field) && tokens(field.autocomplete).some((token) => USERNAME_TOKENS.has(token))
  )
  if (declared !== undefined) return declared

  const before = usable.filter(
    (field) => field.index < password.index && USERNAME_TYPES.has(field.type)
  )
  // The last one before the password, hence the reverse read rather than `[0]`.
  const [nearest] = before.slice(-1)
  return nearest ?? null
}

export interface SaveTargets {
  readonly password: FieldDescriptor
  readonly username: FieldDescriptor | null
}

/**
 * The fields a *save* would read, which is not the same choice as a fill.
 *
 * A fill refuses `new-password`; a save prefers it. That asymmetry is the whole point of two
 * functions:
 *
 *   - signing up (`new-password`, often twice) — the new password is the one to remember;
 *   - changing a password (`current-password` then `new-password`) — likewise the new one, and
 *     taking the first field with a value would store the password the user just replaced,
 *     which is the single most damaging thing this feature could get wrong;
 *   - signing in (one field, no hint or `current-password`) — the only one there is.
 *
 * Only fields that actually hold something are considered, so an untouched confirmation box
 * cannot win.
 */
export function chooseSaveTargets(form: FormDescriptor): SaveTargets | null {
  const filled = form.fields.filter((field) => field.visible && field.hasValue)
  const passwords = filled.filter(isPassword)
  const [fresh] = passwords.filter((field) => hasToken(field, 'new-password'))
  const [first] = passwords
  const password = fresh ?? first
  if (password === undefined) return null

  const [declared] = filled.filter(
    (field) => !isPassword(field) && tokens(field.autocomplete).some((token) => USERNAME_TOKENS.has(token))
  )
  if (declared !== undefined) return { password, username: declared }

  const before = filled.filter(
    (field) => field.index < password.index && USERNAME_TYPES.has(field.type)
  )
  const [nearest] = before.slice(-1)
  return { password, username: nearest ?? null }
}
