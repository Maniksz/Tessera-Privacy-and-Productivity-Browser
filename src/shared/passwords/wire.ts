import type { FieldDescriptor, FormDescriptor } from './fields.js'
import type { ReportedFieldRect } from './suggest-bounds.js'

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
 * Every other message is deliberately secret-free — and since the account picker moved to the
 * overlay layer, no message here carries a *username* either. What the page gets is a badge, a
 * one-time token and one credential it asked for by pressing that badge. That is not decoration:
 * it means the busy paths — a focus, a dismissal, a page that keeps refocusing a field — cannot
 * leak anything even if they are noisy.
 */

/**
 * Preload -> core: "a fillable password field has focus here", or "it no longer has".
 *
 * One boolean, no form, no address, no reply. It exists for one job: to be the gate the core attaches
 * its `input-event` listener behind, so the subscription costs nothing in the tabs that will never
 * fill anything. That gate used to be a non-null offer — which `decideFill` refused for want of the
 * gesture the listener was there to record, so no view ever got a listener and autofill could not
 * fill anything at all. The gate has to be answerable *before* any rule has been applied, and the
 * shape of the form in front of the user is the only fact that qualifies.
 *
 * It is not consent and it is not trusted: a page that lies here is granted an input listener and
 * nothing whatever else. See `AutofillService.noteFillableForm`.
 */
export const AUTOFILL_FILLABLE_CHANNEL = 'tessera:autofill-fillable'

/**
 * Core -> preload: how the badge looks and what it is called.
 *
 * Sent in answer to `AUTOFILL_FILLABLE_CHANNEL`, and only when the core would actually answer a
 * press — so a build where autofill is switched off draws no badge at all rather than a control
 * that does nothing. Asynchronous, and it asks the vault nothing (R2): the whole payload is a
 * stylesheet and one translated label, neither of which says anything about what is saved.
 *
 * The wording is here rather than in the preload for `chrome.ts`'s reason: a preload cannot read
 * the catalogue without carrying every translation into a bundle parsed before every page.
 */
export const AUTOFILL_BADGE_CHANNEL = 'tessera:autofill-badge'

/**
 * Preload -> core: "the user pressed the badge on this field."
 *
 * The message that replaced the offer round trip on focus (KTD7). It carries the shape of the form
 * and the field's rectangle — never a request for anything about the vault — and it is *not*
 * consent: the core answers it only if the browser process itself saw a real input event in this
 * view, which is a fact no renderer can manufacture. See `AutofillService.badgePressed`.
 */
export const AUTOFILL_PRESS_CHANNEL = 'tessera:autofill-press'

/**
 * Preload -> core: "take the list down."
 *
 * A pointer press beside the field and the badge, a scroll, a pinch, a resize. The page reports the
 * event; the core takes the surface off the layer, which is what discards the open request. No
 * payload, because there is exactly one list per view and the sender names it.
 */
export const AUTOFILL_CLOSE_CHANNEL = 'tessera:autofill-close'

/**
 * Core -> preload: "the user asked for a fill from browser chrome; describe your form."
 *
 * The toolbar key, the shortcut and the context menu (R11, R12). The page answers the way a badge
 * press does, on `AUTOFILL_PRESS_CHANNEL`, and the core accepts that answer as chrome consent only
 * because it asked, once, a moment ago — a page that sends the same press unasked is a badge press
 * the browser process saw no input for, and gets nothing (AE3). No payload in either direction that
 * a page could not already have.
 */
export const AUTOFILL_DESCRIBE_CHANNEL = 'tessera:autofill-describe'

/**
 * Core -> preload: "the list has gone", and what to do about it.
 *
 * The payload is the one-time token or `null`, and one message covers both endings because a chosen
 * entry *is* a departure: `null` means the list simply left and the badge's open state goes back, a
 * token means the user chose and this is the proof of it (KTD8). Two channels would have been two
 * ways to forget to take the badge's highlight back off.
 */
export const AUTOFILL_SUGGEST_END_CHANNEL = 'tessera:autofill-end'

/** Preload -> core, synchronous: "the user chose this entry." Answers a `FillAnswer` or null. */
export const AUTOFILL_FILL_CHANNEL = 'tessera:autofill-fill'

/** Preload -> core: "a form with a password in it was submitted." */
export const AUTOFILL_SUBMIT_CHANNEL = 'tessera:autofill-submitted'

/** Core -> preload: "put the save bar up", with its wording already translated. */
export const AUTOFILL_SAVE_PROMPT_CHANNEL = 'tessera:autofill-save-prompt'

/** Preload -> core: what the user pressed on the save bar. */
export const AUTOFILL_SAVE_ANSWER_CHANNEL = 'tessera:autofill-save-answer'

/**
 * The badge's appearance and its accessible name.
 *
 * Built by the core from the catalogue in force *now*, so the preload never carries translations
 * and a language change reaches the next focused field rather than the next restart. Same
 * construction as `PickerChrome`, and the same reason the save bar's wording travels this way.
 *
 * Two strings and nothing else: this is the only thing the page is told before the badge is pressed
 * (R2), so there is nothing in it to learn from.
 */
export interface BadgeChrome {
  readonly styles: string
  /** What a screen reader reads out for the badge. There is no visible text on it. */
  readonly label: string
}

/**
 * What the page reports when the badge is pressed.
 *
 * The form, so the core can decide, and the field's rectangle, so the core can work out where to put
 * the list (`suggest-bounds.ts`). Every number in the rectangle is a *claim*: the worst a page can do
 * by lying is move our own list around its own document.
 */
export interface SuggestPress {
  readonly form: FormDescriptor
  readonly field: ReportedFieldRect
}

/**
 * "The user picked an entry; here is the proof, and here is the form as it is now."
 *
 * The token is not the entry's id, and that is KTD8: an id would be a durable reference the page
 * could redeem again later, while a token is minted for one choice and burned when it is redeemed.
 * The form travels with it for the reason it always has — the core re-runs every rule against the
 * document *as it is now* rather than treating the earlier answer as a licence.
 */
export interface FillRequest {
  readonly token: string
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

  Preload-bound: `sendSync` answers `undefined` when nothing is listening, so `asFillAnswer`,
  `asBadgeChrome` and `asSuggestEnd` exist to turn a build mismatch into "no badge" instead of a
  thrown error inside a preload — which would take the whole page down with it. That is a totality
  boundary.

  Core-bound: `asFormDescriptor`, `asSubmissionReport` and `asSuggestPress` validate a message from
  a renderer, which *is* a trust boundary. Everything is length-capped and type-checked here,
  because the alternative is a compromised renderer choosing the shape of the core's own data
  structures.
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
/**
 * The furthest a reported field rectangle may sit from the viewport's origin, in CSS pixels.
 *
 * Generous — a very long page zoomed out still fits — and finite, which is the point: `Infinity` and
 * `NaN` are both numbers to `typeof`, and either would travel through the placement arithmetic and
 * come out as a surface with no bounds at all.
 */
const MAX_REPORTED_PIXELS = 1_000_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function boundedString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string' || value.length > limit) return null
  return value
}

/** A finite number within reach of a screen, or `null`. Rejects `NaN` and both infinities. */
function boundedNumber(value: unknown, limit: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.abs(value) > limit ? null : value
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
  // A token this browser minted is short; a longer one is not one we would ever match, so the bound
  // costs nothing and removes a way to hand the core a large string.
  const token = boundedString(value['token'], MAX_ATTRIBUTE_LENGTH)
  const form = asFormDescriptor(value['form'])
  if (token === null || token === '' || form === null) return null
  return { token, form }
}

/**
 * The badge press, as the core is willing to read it.
 *
 * The rectangle is validated as hard as the form is, and for a reason that is not obvious: it does
 * not reach any decision about *whether* to fill, only about where to draw — but it does reach
 * arithmetic, and a `NaN` width there produces a surface whose bounds are `NaN`, which the layer
 * takes and then covers the window with. A refusal is a press that does nothing, which is the same
 * thing the user gets from a press the browser process never saw.
 */
export function asSuggestPress(value: unknown): SuggestPress | null {
  if (!isRecord(value)) return null
  const form = asFormDescriptor(value['form'])
  const raw = value['field']
  if (form === null || !isRecord(raw)) return null

  const rect = raw['rect']
  if (!isRecord(rect)) return null
  const x = boundedNumber(rect['x'], MAX_REPORTED_PIXELS)
  const y = boundedNumber(rect['y'], MAX_REPORTED_PIXELS)
  const width = boundedNumber(rect['width'], MAX_REPORTED_PIXELS)
  const height = boundedNumber(rect['height'], MAX_REPORTED_PIXELS)
  const scale = boundedNumber(raw['scale'], MAX_REPORTED_PIXELS)
  const offsetX = boundedNumber(raw['offsetX'], MAX_REPORTED_PIXELS)
  const offsetY = boundedNumber(raw['offsetY'], MAX_REPORTED_PIXELS)
  if (x === null || y === null || width === null || height === null) return null
  if (scale === null || offsetX === null || offsetY === null) return null
  // A field with no area is not one the user is standing in, and a negative scale would flip the
  // whole placement. `suggest-bounds.ts` refuses a non-positive factor too; this refuses earlier.
  if (width <= 0 || height <= 0 || scale <= 0) return null

  return { form, field: { rect: { x, y, width, height }, scale, offsetX, offsetY } }
}

export function asSaveAnswer(value: unknown): SaveAnswer | null {
  if (typeof value !== 'string') return null
  const found = SAVE_ANSWERS.find((answer) => answer === value)
  return found ?? null
}

/**
 * The named text fields of a message, copied out — or `null` when any of them is missing or not text.
 *
 * One loop for the three shapes the core sends into a page, which is the preload's bundle paying for
 * one check rather than three. Copied rather than passed through, so nothing else the message carried
 * rides along into a document.
 */
function textFields<K extends string>(
  value: unknown,
  keys: readonly K[]
): Record<K, string> | null {
  if (!isRecord(value)) return null
  const fields: Partial<Record<K, string>> = {}
  for (const key of keys) {
    const field = value[key]
    if (typeof field !== 'string') return null
    fields[key] = field
  }
  return fields as Record<K, string>
}

export function asBadgeChrome(value: unknown): BadgeChrome | null {
  const chrome = textFields(value, ['styles', 'label'])
  // No label, no badge. A control a screen reader cannot name is one a keyboard user cannot use,
  // and drawing it anyway would put an unreachable button over somebody's password field.
  return chrome === null || chrome.label === '' ? null : chrome
}

/**
 * The one-time proof of a choice, or `null` for "the list simply left".
 *
 * Anything unreadable reads as `null`, and that is right rather than lax: the consequence is that
 * the badge stops looking open, which is what a build mismatch should produce. A token is only ever
 * worth anything to the core, which minted it and will refuse one it did not.
 */
export function asFillToken(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

export function asFillAnswer(value: unknown): FillAnswer | null {
  const answer = textFields(value, ['username', 'password'])
  // An empty password would clear a field the user had typed into and look like a bug in the
  // page. The core never sends one; refusing it here means a build mismatch cannot either.
  return answer === null || answer.password === '' ? null : answer
}

export function asSaveBarChrome(value: unknown): SaveBarChrome | null {
  return textFields(value, [
    'styles',
    'message',
    'username',
    'saveLabel',
    'neverLabel',
    'dismissLabel'
  ])
}
