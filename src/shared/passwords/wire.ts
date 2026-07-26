import type { FieldDescriptor, FormDescriptor } from './fields.js'

/**
 * The autofill messages, and how to recognise one.
 *
 * ## Why these channels are not in the IPC contract
 *
 * A visited page has no bridge (spec 6) and cannot reach `ipcRenderer`; only its preload can.
 * Putting these names in `shared/ipc/channels.ts` would add channels that *every* content view
 * uses to the surface `sender-policy.ts` defends, and defending them would mean allowing web
 * content to call them — which is exactly what a per-`webContents` listener already achieves
 * without widening anything. Same reasoning as `FINGERPRINT_PLAN_CHANNEL` and the cosmetic
 * channels.
 *
 * ## Why nothing here imports the eTLD table
 *
 * The preload imports this file, and the preload runs in every renderer, so every byte of it is
 * parse work on every page load. `fill-policy.ts` — which does need `registrableDomain`, and
 * therefore the public-suffix table — is imported by the *core* only. An architecture test checks
 * the built preload for `co.uk`.
 *
 * ## Where a password appears on these channels, and where it must not
 *
 * Exactly twice, both times for one credential:
 *
 *   - `AUTOFILL_FILL_CHANNEL`'s **reply**, after the core has authorised the fill;
 *   - `AUTOFILL_SUBMIT_CHANNEL`'s **request**, which reports what the user just typed into the
 *     page they were on.
 *
 * Every other message is deliberately secret-free. The offer carries usernames; the save answer
 * carries a verb. That is not decoration: it means the busy paths — a focus, a dismissal, a page
 * that keeps refocusing a field — cannot leak anything even if they are noisy.
 */

/** Preload -> core, synchronous: "what could be filled into this form?" Answers a `FillOffer`. */
export const AUTOFILL_OFFER_CHANNEL = 'tessera:autofill-offer'

/** Preload -> core, synchronous: "the user chose this entry." Answers a `FillAnswer` or null. */
export const AUTOFILL_FILL_CHANNEL = 'tessera:autofill-fill'

/** Preload -> core: "a form with a password in it was submitted." */
export const AUTOFILL_SUBMIT_CHANNEL = 'tessera:autofill-submitted'

/** Core -> preload: "put the save bar up", with its wording already translated. */
export const AUTOFILL_SAVE_PROMPT_CHANNEL = 'tessera:autofill-save-prompt'

/** Preload -> core: what the user pressed on the save bar. */
export const AUTOFILL_SAVE_ANSWER_CHANNEL = 'tessera:autofill-save-answer'

/**
 * The suggestion list's own appearance and wording.
 *
 * Sent with the offer rather than fetched separately, and built by the core from the catalogue in
 * force *now* — so the preload never carries translations and a language change reaches the next
 * suggestion rather than the next restart. Same construction as `PickerChrome`.
 */
export interface FillChrome {
  readonly styles: string
  /** Heading, already interpolated with the site. */
  readonly title: string
  /** Stands in for a credential saved without one; an empty row would look like a bug. */
  readonly noUsernameLabel: string
}

export interface FillOfferEntry {
  readonly id: string
  /** May be empty: some sites authenticate on a password alone. */
  readonly username: string
}

export interface FillOffer {
  /** Never empty — the core answers `null` rather than an offer of nothing. */
  readonly entries: readonly FillOfferEntry[]
  readonly chrome: FillChrome
}

/**
 * "The user picked this entry for this form."
 *
 * The form travels with the request, and that is the point: the core re-runs every rule against the
 * form *as it is now* rather than treating the earlier offer as a token that can be spent later. A
 * page that moved the form into a frame, rewrote its action, or navigated between the suggestion
 * appearing and the click gets a refusal.
 */
export interface FillRequest {
  readonly id: string
  readonly form: FormDescriptor
}

/** The one reply that carries a secret, for one credential, after the core said yes. */
export interface FillAnswer {
  readonly username: string
  readonly password: string
}

/** What the preload reports when a form carrying a password is submitted. */
export interface SubmissionReport {
  readonly form: FormDescriptor
  readonly username: string
  readonly password: string
}

export interface SaveBarChrome {
  readonly styles: string
  /** "Save the password for example.com?", already interpolated and translated. */
  readonly message: string
  /** The username the bar is about, or empty when the form had none. Shown, never editable. */
  readonly username: string
  readonly saveLabel: string
  readonly neverLabel: string
  readonly dismissLabel: string
}

export const SAVE_ANSWERS = ['save', 'never', 'dismiss'] as const
export type SaveAnswer = (typeof SAVE_ANSWERS)[number]

// --- recognising what arrived -------------------------------------------------

/*
  Hand-written guards rather than schemas, for the reason `channels.ts` gives: the preload cannot
  carry zod, and the two directions are different problems anyway.

  Preload-bound: `sendSync` answers `undefined` when nothing is listening, so `asFillOffer` and
  `asFillAnswer` exist to turn a build mismatch into "no suggestion" instead of a thrown error
  inside a preload — which would take the whole page down with it. That is a totality boundary.

  Core-bound: `asFormDescriptor` and `asSubmissionReport` validate a message from a renderer,
  which *is* a trust boundary. Everything is length-capped and type-checked here, because the
  alternative is a compromised renderer choosing the shape of the core's own data structures.
*/

/** Fields per form. A login form has two; a thousand is a renderer doing something else. */
const MAX_REPORTED_FIELDS = 200
/** Attribute values are capped so a report cannot be used to grow the core's memory. */
const MAX_ATTRIBUTE_LENGTH = 256
/** `action` is a URL; the same bound history uses for an address. */
const MAX_ACTION_LENGTH = 2048
/** Matches `MAX_USERNAME_LENGTH` and `MAX_PASSWORD_LENGTH`; restated to keep the model out. */
const MAX_REPORTED_USERNAME = 320
const MAX_REPORTED_PASSWORD = 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length > limit) return null
  return value
}

function asFieldDescriptor(value: unknown, index: number): FieldDescriptor | null {
  if (!isRecord(value)) return null
  const type = boundedString(value['type'], MAX_ATTRIBUTE_LENGTH)
  const name = boundedString(value['name'], MAX_ATTRIBUTE_LENGTH)
  const id = boundedString(value['id'], MAX_ATTRIBUTE_LENGTH)
  const autocomplete = boundedString(value['autocomplete'], MAX_ATTRIBUTE_LENGTH)
  if (type === null || name === null || id === null || autocomplete === null) return null
  if (
    typeof value['visible'] !== 'boolean' ||
    typeof value['editable'] !== 'boolean' ||
    typeof value['hasValue'] !== 'boolean'
  ) {
    return null
  }
  return {
    // Taken from the position in the array rather than from the message. A renderer that sent
    // its own indices could make two descriptors claim the same field, and `fields.ts` compares
    // indices to decide which name field precedes which password field.
    index,
    type: type.toLowerCase(),
    name,
    id,
    autocomplete: autocomplete.toLowerCase(),
    visible: value['visible'],
    editable: value['editable'],
    hasValue: value['hasValue']
  }
}

export function asFormDescriptor(value: unknown): FormDescriptor | null {
  if (!isRecord(value)) return null
  const rawAction = value['action']
  if (rawAction !== null && boundedString(rawAction, MAX_ACTION_LENGTH) === null) return null
  const rawFields = value['fields']
  if (!Array.isArray(rawFields) || rawFields.length > MAX_REPORTED_FIELDS) return null

  const fields: FieldDescriptor[] = []
  for (const [index, raw] of rawFields.entries()) {
    const field = asFieldDescriptor(raw, index)
    // One malformed control invalidates the report rather than being skipped: a partial form is
    // a form whose shape the core would be guessing at, and the roles are derived from shape.
    if (field === null) return null
    fields.push(field)
  }
  return { action: rawAction === null ? null : boundedString(rawAction, MAX_ACTION_LENGTH), fields }
}

export function asSubmissionReport(value: unknown): SubmissionReport | null {
  if (!isRecord(value)) return null
  const form = asFormDescriptor(value['form'])
  const username = boundedString(value['username'], MAX_REPORTED_USERNAME)
  const password = boundedString(value['password'], MAX_REPORTED_PASSWORD)
  if (form === null || username === null || password === null) return null
  return { form, username, password }
}

export function asFillRequest(value: unknown): FillRequest | null {
  if (!isRecord(value)) return null
  // An id this browser generated is short; a longer one is not an id we would ever match, so the
  // bound costs nothing and removes a way to hand the core a large string.
  const id = boundedString(value['id'], MAX_ATTRIBUTE_LENGTH)
  const form = asFormDescriptor(value['form'])
  if (id === null || id === '' || form === null) return null
  return { id, form }
}

export function asSaveAnswer(value: unknown): SaveAnswer | null {
  if (typeof value !== 'string') return null
  const found = SAVE_ANSWERS.find((answer) => answer === value)
  return found ?? null
}

function asFillChrome(value: unknown): FillChrome | null {
  if (!isRecord(value)) return null
  const { styles, title, noUsernameLabel } = value
  if (
    typeof styles !== 'string' ||
    typeof title !== 'string' ||
    typeof noUsernameLabel !== 'string'
  ) {
    return null
  }
  return { styles, title, noUsernameLabel }
}

export function asFillOffer(value: unknown): FillOffer | null {
  if (!isRecord(value)) return null
  const chrome = asFillChrome(value['chrome'])
  const rawEntries = value['entries']
  if (chrome === null || !Array.isArray(rawEntries) || rawEntries.length === 0) return null

  const entries: FillOfferEntry[] = []
  for (const raw of rawEntries) {
    if (!isRecord(raw)) return null
    const { id, username } = raw
    if (typeof id !== 'string' || typeof username !== 'string') return null
    entries.push({ id, username })
  }
  return { entries, chrome }
}

export function asFillAnswer(value: unknown): FillAnswer | null {
  if (!isRecord(value)) return null
  const { username, password } = value
  if (typeof username !== 'string' || typeof password !== 'string') return null
  // An empty password would clear a field the user had typed into and look like a bug in the
  // page. The core never sends one; refusing it here means a build mismatch cannot either.
  if (password === '') return null
  return { username, password }
}

export function asSaveBarChrome(value: unknown): SaveBarChrome | null {
  if (!isRecord(value)) return null
  const { styles, message, username, saveLabel, neverLabel, dismissLabel } = value
  if (
    typeof styles !== 'string' ||
    typeof message !== 'string' ||
    typeof username !== 'string' ||
    typeof saveLabel !== 'string' ||
    typeof neverLabel !== 'string' ||
    typeof dismissLabel !== 'string'
  ) {
    return null
  }
  return { styles, message, username, saveLabel, neverLabel, dismissLabel }
}
