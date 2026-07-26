import { registrableDomainOfUrl } from '../url/domain.js'
import { originMayReceiveCredentials } from './fill-policy.js'
import { MAX_PASSWORD_LENGTH, passwordOriginOf, type BrowsingMode } from './model.js'

/**
 * Whether the browser may *offer* to remember a credential it just watched being submitted.
 *
 * ## Why offering and saving are separate questions
 *
 * Silently saving every password typed anywhere would collect the one the user entered into a
 * phishing page as eagerly as the real one, and would make the vault a record of every login
 * attempt rather than of the user's accounts. So a save is always the answer to a question,
 * and this file decides whether the question may be asked.
 *
 * ## Why it takes no password
 *
 * A length, not a value. Everything this file needs to decide is expressible without the
 * secret — whether there is one, whether it is absurd, and whether the store already holds the
 * same one — so the signature is written to make holding it impossible. The store answers
 * "same or different" by comparing inside itself; see `PasswordStore.compareStored`.
 *
 * ## The private-window rule, twice over
 *
 * A private window must not save and must not offer to save. Both are enforced, in two
 * independent places, on purpose:
 *
 *   1. here, so the prompt never appears — a dialogue offering to remember something in a
 *      private window is a broken promise even if the user says no;
 *   2. in `PasswordStore.writerFor('private')`, which hands back a writer holding no
 *      reference to any store, so there is nothing for a forgotten check to write into.
 *
 * One of them would be a convention. Two of them, in different layers, is an invariant.
 */

/**
 * What the vault already holds for one (origin, username), without saying what it is.
 *
 * A three-valued enumeration rather than the stored password, so this file can decide whether to
 * ask without ever receiving a secret. `PasswordStore.compareStored` computes it, because the store
 * is the only place allowed to look.
 */
export type StoredCredentialState = 'none' | 'same-password' | 'different-password'

export interface SaveOfferContext {
  readonly mode: BrowsingMode
  /** The core's own view of the frame that submitted, never the renderer's claim about it. */
  readonly frameUrl: string
  readonly isTopLevelFrame: boolean
  readonly topLevelUrl: string | null
  /** Length only. See the note above on why this file never receives the password itself. */
  readonly passwordLength: number
  /** Origins where the user answered "never here". */
  readonly neverSaved: readonly string[]
  /**
   * What the vault already holds for this (origin, username).
   *
   * `same-password` is the common case on every subsequent sign-in, and it is the reason the
   * bar does not appear every single time somebody logs in.
   */
  readonly existing: StoredCredentialState
}

export type SaveRefusal =
  | 'private-window'
  | 'unsupported-scheme'
  | 'insecure-page'
  | 'cross-origin-frame'
  | 'no-password'
  | 'password-too-long'
  | 'never-here'
  | 'unchanged'

export type SaveOffer =
  | { readonly offer: 'create' }
  | { readonly offer: 'update' }
  | { readonly offer: 'none'; readonly reason: SaveRefusal }

function refuse(reason: SaveRefusal): SaveOffer {
  return { offer: 'none', reason }
}

/**
 * Whether to put the "save this password?" bar up, and what it should say.
 *
 * The private-window refusal comes first so that no other branch can ever be the reason a
 * private window did not offer — if the order were reversed, a private window on an https page
 * with a new credential would be refused for the right reason by accident, and the day
 * something changed about the other rules the guarantee would quietly go.
 */
export function decideSaveOffer(context: SaveOfferContext): SaveOffer {
  if (context.mode === 'private') return refuse('private-window')

  if (context.passwordLength === 0) return refuse('no-password')
  /*
    An implausible length is refused rather than truncated.

    A megabyte in a password field is not a password; it is a page filling a field to see what
    the browser does with it. Truncating would store something that cannot sign in.
  */
  if (context.passwordLength > MAX_PASSWORD_LENGTH) return refuse('password-too-long')

  const origin = passwordOriginOf(context.frameUrl)
  if (origin === null) return refuse('unsupported-scheme')

  /*
    Nothing is collected that could never be filled back.

    A credential the fill policy would always refuse is a row in the vault that looks like a
    working entry and is not — and, worse, one whose collection put a password the user had
    just sent in clear text into a second place. The user can still add such an entry by hand
    on the passwords page, where the choice is explicit.
  */
  if (!originMayReceiveCredentials(context.frameUrl)) return refuse('insecure-page')

  /*
    A submission from a frame is not offered, for the same reason a frame is never filled: the
    document the user believes they are signing in to is the top-level one. A framed form that
    could get its credential remembered would let an embedding page teach the manager that its
    own harvested credential belongs to the framed site.
  */
  if (!context.isTopLevelFrame) return refuse('cross-origin-frame')
  if (context.topLevelUrl === null) return refuse('cross-origin-frame')
  const frameSite = registrableDomainOfUrl(context.frameUrl)
  const topSite = registrableDomainOfUrl(context.topLevelUrl)
  if (frameSite === null || topSite === null || frameSite !== topSite) {
    return refuse('cross-origin-frame')
  }

  if (context.neverSaved.includes(origin)) return refuse('never-here')

  if (context.existing === 'same-password') return refuse('unchanged')
  return context.existing === 'none' ? { offer: 'create' } : { offer: 'update' }
}
