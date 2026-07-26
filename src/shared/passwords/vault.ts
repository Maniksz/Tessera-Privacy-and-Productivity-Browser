/**
 * The vault's lock, as pure rules: what protects the key, when it is dropped, and what a master
 * password has to be.
 *
 * ## Why this file has no zod import and no `node:crypto` import
 *
 * `tessera://passwords` draws the lock panel, so every value import here lands in a bundle the user
 * waits for — the same split `model.ts` explains. The derivation itself lives in
 * `main/crypto/vault-key.ts`, which is the only place that ever holds a key; what is here is the
 * *reasoning* about the lock, which both the page and the core have to agree on and which is worth
 * testing without a filesystem.
 *
 * ## What a master password buys, and what it does not
 *
 * The whole argument is in `reveal.ts` and is not repeated here, only its conclusion:
 * `safeStorage` cannot re-authenticate anybody. It wraps a key with the platform key store, and
 * every one of those unwraps for whoever is logged in as the user, without asking. So the threat a
 * master password closes is precisely *the logged-in user who is not the owner* — malware running
 * as them, a person at an unlocked laptop, a profile directory restored somewhere else alongside an
 * exported keychain.
 *
 * The two wrappings compose rather than alternate, and that distinction is the design. A file
 * openable by *either* the key store or the master password would add nothing at all: the attacker
 * above already has the key store. `main/crypto/vault-key.ts` nests them, so opening the vault needs
 * both, and the interesting consequence is what happens when one is missing — a Linux desktop with
 * no keyring degrades to *master-password-only*, which is real protection, rather than to nothing.
 *
 * ## Why the idle timeout is not a setting
 *
 * `reveal.ts` makes the argument for `REVEAL_TIMEOUT_MS` and it holds here unchanged: a setting
 * whose only effect is to weaken the one bound the lock provides is a setting whose only users are
 * the ones who should not have it. A user who finds fifteen minutes short can lock explicitly less
 * often; a user who sets it to a day has bought nothing and does not know it.
 */

/**
 * How long the vault stays open with nobody using it.
 *
 * Fifteen minutes is a compromise with a cost that has to be stated: a person who signs in to four
 * sites over a morning types the master password once, and a person who signs in to one site an hour
 * types it four times. The alternative — a session-long unlock — makes the lock a formality that is
 * satisfied once per boot, which is the same as not having one.
 */
export const VAULT_IDLE_TIMEOUT_MS = 15 * 60_000

/**
 * How often the lock checks whether it has gone idle.
 *
 * A timer rather than a check on the next read, because the promise is that the key *is dropped*
 * after this long — not that it is refused after this long. A key still in memory that would be
 * refused if asked is exactly what a memory dump gets hold of.
 */
export const VAULT_IDLE_SWEEP_MS = 30_000

/**
 * The floor on a master password's length, and the honest reading of it.
 *
 * At N = 2¹⁷ a guess costs roughly half a second, so a determined attacker with the profile
 * directory and the keychain manages a few guesses a second per core. Twelve characters of
 * human-chosen text does not survive that against a motivated adversary, and pretending otherwise
 * would be the same theatre this feature exists to avoid. What the floor does buy is the exclusion
 * of the hopeless: a four-digit PIN, a repeated letter, the site's own name.
 *
 * There are deliberately **no composition rules** — no "must contain a digit and a symbol". Those
 * are measured to push people towards `Password1!`, which is shorter in real entropy than four
 * ordinary words, and they make the one thing that actually helps — length — feel optional.
 */
export const MIN_MASTER_PASSWORD_LENGTH = 12

/** The same bound a stored password gets, for the same reason: past this it is not a password. */
export const MAX_MASTER_PASSWORD_LENGTH = 1024

/**
 * How `passwords.key` is protected on this machine.
 *
 * Four values rather than a pair of booleans, because these are the four sentences the passwords
 * page has to be able to say, and a boolean pair invites a fifth that means nothing.
 *
 *   - `keystore+master` — both layers. What the design is for.
 *   - `master` — a master password and no key store. The Linux-without-a-keyring case, and the one
 *     where a master password matters most: it is the only thing between the profile directory and
 *     the vault.
 *   - `keystore` — the key store alone. Today's protection, and the honest description of it is
 *     that anyone already logged in as this user can read the vault.
 *   - `plain` — neither. The key sits in the profile directory in readable form beside the document
 *     it protects, which is to say the vault is not protected at all. It is still *offered*, because
 *     a browser that refuses to run on a keyring-less desktop is not private, only unavailable —
 *     the same trade `local-data-protection.ts` makes, and it has to be said out loud in the same
 *     way.
 */
export type VaultKeyProtection = 'keystore+master' | 'master' | 'keystore' | 'plain'

export function vaultKeyProtection(options: {
  readonly keystore: boolean
  readonly masterPassword: boolean
}): VaultKeyProtection {
  if (options.masterPassword) return options.keystore ? 'keystore+master' : 'master'
  return options.keystore ? 'keystore' : 'plain'
}

/** Whether a master password guards the key. The one question the lock panel turns on. */
export function vaultHasMasterPassword(protection: VaultKeyProtection): boolean {
  return protection === 'keystore+master' || protection === 'master'
}

/**
 * Whether the vault's own key is readable by anyone who can read the profile directory.
 *
 * Separate from `protection === 'plain'` at the call site on purpose: this is the predicate the page
 * uses to decide whether to shout, and writing it as a comparison in the component would make the
 * page the place that knows which of four values is the bad one.
 */
export function vaultKeyIsExposed(protection: VaultKeyProtection): boolean {
  return protection === 'plain'
}

/**
 * What the core tells the page about the lock.
 *
 * Deliberately carries no count of entries and no origins: it is answered while the vault is
 * *closed*, and a status reply that leaked "you have 43 saved passwords, one of them for your bank"
 * would hand a locked vault's contents to anything that could ask.
 */
export interface VaultStatus {
  readonly protection: VaultKeyProtection
  readonly unlocked: boolean
  /**
   * True when the key file exists but cannot be opened at all — the key store that wrapped it is
   * gone, or the file is damaged.
   *
   * Distinct from `unlocked: false`, and the distinction is the whole point of the field: one means
   * "type your master password", the other means "no master password will help, and nothing here
   * will silently overwrite your vault to make the browser start". A single boolean would make the
   * lock panel ask for a password that cannot work.
   */
  readonly unreadable: boolean
  /** Shown to the user, so a vault that locks itself is not read as a fault. */
  readonly idleTimeoutMs: number
}

/** Why a proposed master password was refused. Never carries the candidate. */
export type MasterPasswordProblem = 'too-short' | 'too-long'

/**
 * Whether a proposed master password is usable, without the caller having to know the rules.
 *
 * Returns the problem or `null`. `null` for "fine" rather than a boolean, so the page can say which
 * rule was broken — a refusal with no reason is a form the user retries at random.
 */
export function assessMasterPassword(candidate: string): MasterPasswordProblem | null {
  // Length in code units, not in grapheme clusters. The derivation consumes bytes, so this is the
  // number that bounds the work; a rule about "characters" would disagree with it for emoji.
  if (candidate.length < MIN_MASTER_PASSWORD_LENGTH) return 'too-short'
  if (candidate.length > MAX_MASTER_PASSWORD_LENGTH) return 'too-long'
  return null
}

/**
 * Whether an open vault has been idle long enough to be closed.
 *
 * Two cases err towards locking, and both are deliberate:
 *
 *   - `null` — nothing has ever counted as activity, so there is nothing to keep the vault open.
 *   - a timestamp in the *future* — the clock moved, an NTP correction or a resumed laptop. Read as
 *     activity it would make the window unbounded, which is the one direction where being wrong
 *     costs a secret instead of a re-entry. Same rule, same reason, as `isRevealExpired`.
 */
export function isVaultIdle(
  lastActivityAt: number | null,
  now: number,
  timeoutMs: number = VAULT_IDLE_TIMEOUT_MS
): boolean {
  if (lastActivityAt === null) return true
  if (now < lastActivityAt) return true
  return now - lastActivityAt >= timeoutMs
}

/**
 * What an unlock attempt did.
 *
 * `wrong-password` is a value rather than a thrown error, and the reason is narrow: an error's
 * message travels, gets logged, and gets shown — and the one thing that must never appear in any of
 * those is the candidate. A value carries no text at all.
 */
export type UnlockOutcome =
  | 'unlocked'
  | 'wrong-password'
  /** There is no master password to check, so the vault was already open. */
  | 'not-protected'
  /** See `VaultStatus.unreadable`. No password can fix this one. */
  | 'unreadable'

/** What a master-password change did. Same reasoning as `UnlockOutcome` for carrying no text. */
export type MasterPasswordOutcome =
  | 'set'
  | 'changed'
  | 'removed'
  | 'wrong-password'
  /** Refused by `assessMasterPassword`. The page already knows the rules and can say which. */
  | 'rejected'
  /** The vault is closed, so there is no key to re-wrap. Unlock first. */
  | 'locked'
  /** Nothing to remove, or nothing to change. */
  | 'not-protected'

/**
 * The word a caller must send to destroy the vault.
 *
 * Not user-visible and therefore not translated — it is a token in a payload, so that
 * `passwords:resetVault` cannot be reached by an empty invoke. The *sentence* the user reads and the
 * confirmation they give are separate, translated, and on the page.
 *
 * Why the operation exists at all: a user who has forgotten the master password is otherwise left
 * with a browser that asks, on every sign-in, for something they do not have, and no way to start
 * again. Deleting the document and the key **together** is the load-bearing part — deleting only the
 * key would leave a sealed document nothing can open, which is the shape that makes every subsequent
 * start fail.
 */
export const RESET_VAULT_CONFIRMATION = 'delete-vault'
