import { MAX_MASTER_PASSWORD_LENGTH } from './vault.js'

/**
 * The master-password prompt, as pure rules: what it is asking, what a keystroke means, and what
 * the answer can be.
 *
 * ## Why a keystroke is a value in a shared module at all
 *
 * Because of the one decision this feature is built around: **the master password never reaches a
 * renderer.** Every other text field in this browser is a `<input>` whose value the renderer owns
 * and hands over when asked. That is exactly what must not happen here — an `<input>` holding the
 * master password is the master password sitting in a renderer's heap, one `executeJavaScript` or
 * one compromised surface away from leaving it, and there is no channel that could carry it back
 * without becoming a channel that *accepts a master password*.
 *
 * So the field on the overlay layer is a display: it draws one bullet per character and nothing
 * else. The characters live in the main process, which receives them from
 * `webContents.on('before-input-event')` — the browser process's own input pipeline, where the
 * keystroke already is before any renderer sees it — and takes them out of the pipeline before the
 * surface can. `OverlayLayer` does the taking; `MasterPasswordPrompt` does the accumulating; what is
 * here is the part worth testing without either: which keystroke means what.
 *
 * ## What that costs, stated rather than discovered
 *
 * A hand-driven field is not a text field. There is no selection, no caret movement, no
 * autocorrect, and — the one that matters — **no IME**. A master password typed through a
 * composition editor cannot be entered here; `isComposing` is ignored rather than half-handled,
 * because accumulating the pre-composition keystrokes would silently store a *different* password
 * from the one the user believes they chose, and they would then be locked out of their own vault.
 *
 * Paste is supported and had to be: the length floor pushes people towards passphrases they keep
 * elsewhere, and a field that cannot be pasted into is a field people work around by choosing
 * something short. It is served from the main process's own `clipboard`, so the clipboard text does
 * not travel through a renderer either.
 */

/**
 * What a whole prompt sequence is for.
 *
 * `unlock` is one question; the other three are short sequences. Kept as the *intent* rather than as
 * a list of questions so the core decides the sequence from the vault's actual state — a page asking
 * to "change" a master password that does not exist would otherwise be able to skip the step that
 * proves knowledge of the current one.
 */
export const MASTER_PASSWORD_PURPOSES = ['unlock', 'set', 'change', 'remove'] as const
export type MasterPasswordPurpose = (typeof MASTER_PASSWORD_PURPOSES)[number]

/**
 * What a caller may ask for, which is deliberately narrower than the purposes above.
 *
 * `unlock` has its own channel and its own outcome, because it is the one a locked vault needs and
 * the one the passwords page shows a panel for. The other three share `passwords:beginSetMasterPassword`.
 */
export const MASTER_PASSWORD_INTENTS = ['set', 'change', 'remove'] as const
export type MasterPasswordIntent = (typeof MASTER_PASSWORD_INTENTS)[number]

/**
 * One question of a sequence.
 *
 * Three, and never more than one on screen at a time. A single field per question rather than a form
 * with three of them, and that is not a simplification: with the characters living in the main
 * process there is exactly one buffer, so a form would need field navigation, a focus model and a
 * per-field buffer — all hand-driven, all of it code between a person and their own vault. `passwd(1)`
 * asks one thing at a time for the same reason.
 */
export const MASTER_PASSWORD_STEPS = ['current', 'new', 'repeat'] as const
export type MasterPasswordStep = (typeof MASTER_PASSWORD_STEPS)[number]

/**
 * Why the last attempt was refused. Never carries the candidate — see `UnlockOutcome`.
 *
 * `mismatch` is the one that is not about a rule: the two new-password questions disagreed. Told
 * apart from `too-short` because the next action differs — one is "type it again", the other is
 * "choose a longer one".
 */
export const MASTER_PASSWORD_PROBLEMS = [
  'wrong-password',
  'too-short',
  'too-long',
  'mismatch'
] as const
export type MasterPasswordPromptProblem = (typeof MASTER_PASSWORD_PROBLEMS)[number]

/**
 * What a request to unlock came to.
 *
 * Four words, and not one of them says whether the vault holds anything. `wrong-password` is
 * returned for a candidate that failed the derivation *and* for a vault whose key file has no
 * master password to check — see `MasterPasswordPrompt` — so a caller cannot use this channel to
 * discover whether a vault exists, which is a fact about the user that a page linking to
 * `tessera://passwords` has no business learning.
 */
export const UNLOCK_REQUEST_OUTCOMES = [
  'unlocked',
  'wrong-password',
  /** The prompt went away without an answer: Escape, a click on Cancel, a closed window. */
  'cancelled',
  /** No password can help; the key file itself cannot be opened. See `VaultStatus.unreadable`. */
  'unreadable'
] as const
export type UnlockRequestOutcome = (typeof UNLOCK_REQUEST_OUTCOMES)[number]

/** What a request to set, change or remove the master password came to. */
export const MASTER_PASSWORD_REQUEST_OUTCOMES = [
  'set',
  'changed',
  'removed',
  'wrong-password',
  'cancelled',
  /** Refused by `assessMasterPassword`; the prompt said which rule and asked again. */
  'rejected',
  /** The vault is closed, so there is no key to re-wrap. Unlock first. */
  'locked',
  /** There was no master password to change or remove. */
  'not-protected'
] as const
export type MasterPasswordRequestOutcome = (typeof MASTER_PASSWORD_REQUEST_OUTCOMES)[number]

/** What the surface's own two buttons send. Carries no password; see `passwords:answerPrompt`. */
export const PROMPT_ACTIONS = ['submit', 'cancel'] as const
export type PromptAction = (typeof PROMPT_ACTIONS)[number]

/**
 * The keystroke, as much of it as this needs.
 *
 * Structurally satisfied by Electron's `Input`, and written out here so the reducer below can be
 * tested with a plain object. Nothing about the *window* is in it: a keystroke is a keystroke, and
 * which surface it belongs to is decided by the layer that captured it.
 */
export interface PromptKey {
  readonly type: string
  readonly key: string
  readonly control: boolean
  readonly meta: boolean
  readonly alt: boolean
  readonly shift: boolean
  readonly isComposing: boolean
}

/**
 * What one keystroke does to the prompt.
 *
 * `paste` rather than `append` with the clipboard's text already in it, so this function stays free
 * of everything it would take to read a clipboard — and so a test of "Ctrl+V pastes" does not have
 * to own one.
 */
export type PromptKeyAction =
  | { readonly kind: 'append'; readonly text: string }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'clear' }
  | { readonly kind: 'paste' }
  | { readonly kind: 'submit' }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'ignore' }

const IGNORE: PromptKeyAction = { kind: 'ignore' }

/**
 * Reads one keystroke.
 *
 * The default is `ignore`, and that ordering is the whole safety property of this function: a key
 * nobody thought about does nothing, rather than landing a stray character in a master password that
 * will then be wrong for ever with no way to see why. The same reason a permission this browser has
 * not mapped is refused.
 *
 * `keyDown` only. Electron emits `keyDown`, `keyUp` and `char` for one press, and counting two of
 * them would double every character — a defect that would be invisible, because the field draws
 * bullets.
 */
export function promptKeyAction(input: PromptKey): PromptKeyAction {
  if (input.type !== 'keyDown') return IGNORE
  // Mid-composition. Ignored rather than accumulated; see the header for why half-handling this is
  // worse than not handling it.
  if (input.isComposing) return IGNORE

  if (input.key === 'Enter') return { kind: 'submit' }
  if (input.key === 'Escape') return { kind: 'cancel' }

  const accelerator = input.control || input.meta
  if (input.key === 'Backspace') return accelerator ? { kind: 'clear' } : { kind: 'backspace' }

  if (accelerator && !input.alt) {
    const letter = input.key.toLowerCase()
    if (letter === 'v') return { kind: 'paste' }
    // The readline convention for "throw the line away", which is what a person reaches for when
    // they have lost track of how many bullets they meant to type.
    if (letter === 'u') return { kind: 'clear' }
    return IGNORE
  }
  // Any remaining modified key is an accelerator for something else — a menu, a shortcut, a window
  // command — and must not become a character.
  if (accelerator || input.alt) return IGNORE

  /*
    One *character*, counted in code points rather than code units.

    `key.length === 1` would refuse an emoji or anything else outside the basic plane, whose `key` is
    a surrogate pair — and would then silently drop it, which for a password means an entry the user
    cannot reproduce. Every named key (`Tab`, `Shift`, `F5`, `ArrowLeft`) is longer than one code
    point, so this admits exactly the printable ones, the space included.
  */
  return Array.from(input.key).length === 1 ? { kind: 'append', text: input.key } : IGNORE
}

/**
 * Adds text to the buffer, bounded.
 *
 * The buffer is an array of single characters rather than a growing string, and that is a deliberate
 * choice about what stays in memory. Appending to a JavaScript string produces a new immutable one
 * every time, so typing a twelve-character password would leave eleven partial copies of it on the
 * heap for the garbage collector to get round to — every one of them a prefix of the real thing, and
 * a prefix is most of a password. One array, joined once at the moment it is used, leaves one copy.
 *
 * Bounded at `MAX_MASTER_PASSWORD_LENGTH` because a held key or a pasted file would otherwise grow
 * this without limit, and anything past that length is refused by `assessMasterPassword` anyway.
 */
export function boundedAppend(
  current: readonly string[],
  text: string,
  max: number = MAX_MASTER_PASSWORD_LENGTH
): string[] {
  const room = max - current.length
  if (room <= 0) return [...current]
  return [...current, ...Array.from(text).slice(0, room)]
}

/**
 * The questions a purpose asks, in order.
 *
 * Data rather than a chain of `if`s in the prompt, and the interesting entry is `remove`: taking a
 * master password off still has to prove knowledge of it, or "remove the lock" would be the one
 * operation that needs no key — which is the same as having no lock. `set` has no `current` step
 * because there is nothing to prove; the core refuses a `set` on a vault that already has one rather
 * than trusting the caller's word about which case it is.
 */
export const MASTER_PASSWORD_SEQUENCE = {
  unlock: ['current'],
  set: ['new', 'repeat'],
  change: ['current', 'new', 'repeat'],
  remove: ['current']
} as const satisfies Record<MasterPasswordPurpose, readonly MasterPasswordStep[]>

export function stepsFor(purpose: MasterPasswordPurpose): readonly MasterPasswordStep[] {
  return MASTER_PASSWORD_SEQUENCE[purpose]
}
