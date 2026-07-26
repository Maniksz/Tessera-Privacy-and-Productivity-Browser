import {
  MAX_REPORTED_CONFLICTS,
  type ChromeImportParse,
  type ChromeImportResult
} from '@shared/passwords/chrome-import.js'
import {
  MAX_PASSWORD_CREDENTIALS,
  usernameKey,
  type SaveCredentialInput,
  type SaveOutcome
} from '@shared/passwords/model.js'
import type { StoredCredentialState } from '@shared/passwords/save-policy.js'

/**
 * Putting a parsed export into the vault, and what happens when it collides.
 *
 * ## The duplicate rule, and why it is this way round
 *
 * **The vault wins. An import never overwrites a stored password.**
 *
 * The tempting alternative is "the file wins, it is newer" — and it is wrong, because the file
 * usually is not newer. A person migrating exported their old browser days or weeks ago, has since
 * changed a password *here*, and then finds the file in their downloads folder and imports it. The
 * failure mode of the other rule is total and silent: the working password is replaced by a stale
 * one, hundreds of rows at a time, with nothing to compare against afterwards because the old value
 * is gone. Skipping is recoverable — the credential the user already had still signs in — and the
 * ones that disagree are *named back*, without their secrets, so the two can be reconciled by hand.
 *
 * A duplicate *within the file* needs no separate rule and gets none: by the time the second row is
 * considered the first is already stored, so it is a collision with the vault like any other and the
 * earlier row wins. One rule, and file order is the only tiebreak a file offers anyway.
 *
 * ## Why "already stored" is split in two
 *
 * `same-password` is noise — the user has that credential, the file agrees, nothing to see.
 * `different-password` is the only thing in an import report worth acting on. Reporting one number
 * for both would bury the handful of rows that matter under the hundreds that do not.
 *
 * ## Why the cap is checked rather than left to the model
 *
 * `saveCredential` prunes to `MAX_PASSWORD_CREDENTIALS` by dropping the least useful entry, which is
 * right for a save the user just performed and wrong for a bulk import: a two-thousand-row file would
 * evict every credential the user already had, one row at a time, and report success. So the room is
 * measured first and the rows that do not fit are counted. An import must not be able to delete
 * anything.
 *
 * ## Two things this deliberately does not consult
 *
 * **The "never here" list.** That list means "stop asking me on this site", which is a statement about
 * the save prompt, not about the vault's contents. An explicit import is a stronger and more recent
 * instruction than a past dismissal, and silently omitting rows the user can see in their own file
 * would be the kind of surprise that makes people distrust the count. The passwords page's own
 * "add entry" does not consult it either, for the same reason.
 *
 * **The browsing mode.** Imports go through `create`, not through a mode-bound writer, exactly as
 * `PasswordStore.create` explains: the writer exists to stop a private window recording what was
 * *browsed*, and refusing a person's explicit "import this file" because the passwords tab happens to
 * be in a private window would be a rule protecting nobody from anything.
 */

/**
 * The slice of the vault an import touches.
 *
 * Written out rather than importing the class, for the reason `AutofillVault` exists: a test supplies
 * a fake and the real decision path runs. The absence is again the point — there is no method here
 * that can *change* an existing credential, so "an import cannot overwrite" is a property of this
 * interface rather than a rule somebody remembered to follow.
 */
export interface ImportTarget {
  /** How many credentials are stored now, so the room left can be measured before writing. */
  count(): number
  /** Answers "is this already here, and is it the same?" without letting a secret out. */
  compareStored(url: string, username: string, password: string): StoredCredentialState
  create(input: SaveCredentialInput): SaveOutcome
}

/**
 * Writes a parsed export into the vault.
 *
 * Every row goes through `target.create`, which is `saveCredential` — so the length limits, the
 * origin normalisation and the one-entry-per-account rule apply to imported data exactly as to a
 * credential the user typed. An import that wrote records directly would be a second write path, and
 * the first file that exercised a rule it had forgotten would be the one that corrupted the document.
 */
export function applyChromeImport(
  target: ImportTarget,
  parse: ChromeImportParse
): ChromeImportResult {
  const result: ChromeImportResult = {
    imported: 0,
    duplicatesIdentical: 0,
    duplicatesConflicting: 0,
    conflicts: [],
    skipped: parse.skipped,
    full: 0,
    refusedByVault: 0,
    notesDropped: parse.notesDropped,
    refusal: parse.refusal
  }
  if (parse.refusal !== null) return result

  /*
    Measured once and then tracked, rather than asked on every row.

    `count()` reaches into the document, and calling it two thousand times would be two thousand
    walks of the credential list. The number only moves when this loop moves it, so keeping it here is
    exact — and it is the number the cap is checked against, so it has to be.
  */
  let stored = target.count()
  /*
    What this run has already written, so a file containing the same account twice does not report the
    second row as a fresh import.

    Needed *in addition to* `compareStored` rather than instead of it: `create` may answer `unchanged`
    for a row identical to one this loop just wrote, and `unchanged` is indistinguishable at that point
    from "the vault already had it". Keeping the keys makes the report say which it was.
  */
  const writtenHere = new Set<string>()

  for (const credential of parse.credentials) {
    const key = `${credential.url} ${usernameKey(credential.username)}`
    const existing = target.compareStored(
      credential.url,
      credential.username,
      credential.password
    )

    if (existing !== 'none') {
      if (existing === 'same-password') {
        result.duplicatesIdentical += 1
        continue
      }
      result.duplicatesConflicting += 1
      if (!writtenHere.has(key) && result.conflicts.length < MAX_REPORTED_CONFLICTS) {
        result.conflicts.push({ origin: credential.url, username: credential.username })
      }
      continue
    }

    if (stored >= MAX_PASSWORD_CREDENTIALS) {
      result.full += 1
      continue
    }

    const outcome = target.create(credential)
    if (outcome === 'created') {
      result.imported += 1
      stored += 1
      writtenHere.add(key)
      continue
    }
    // `updated` and `unchanged` are unreachable — the pair was checked a moment ago — and `rejected`
    // means the parser let through something the model refuses. Counted, not thrown: an import that
    // crashes halfway leaves a vault nobody can reason about.
    result.refusedByVault += 1
  }

  return result
}
