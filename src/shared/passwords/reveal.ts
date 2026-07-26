/**
 * What `tessera://passwords` is allowed to be holding, and for how long.
 *
 * ## The problem this file exists for
 *
 * A list of saved credentials is itself a secret. An unlocked passwords tab left open on a desk,
 * shared in a screen call, or caught by a screenshot tool is — in every other browser's design —
 * the whole vault. The usual answer is "re-authenticate before revealing", and the honest
 * position on that has to be stated before any code is written:
 *
 * **`safeStorage` cannot provide re-authentication, and nothing built on it alone can.** It wraps
 * a key with the platform's key store: Keychain, DPAPI, libsecret or KWallet. Every one of those
 * unwraps for whoever is logged in as the user, without asking. There is no "prove it is you"
 * primitive in it, and Electron 43 exposes no cross-platform one either — `promptTouchID` is
 * macOS-only and needs the hardware, and there is no Windows Hello or polkit equivalent on the
 * API surface. A dialogue that asked for the OS password and then checked it against nothing
 * would be theatre, and shipping theatre in the most security-sensitive part of a browser is
 * worse than shipping an honest limitation.
 *
 * **So this needs a master password to be meaningful, and here is the design.** It is not in this
 * change, and the reasons are stated at the end.
 *
 *   - *Threat it closes.* Anyone who is already the logged-in user: malware running as them, a
 *     person at an unlocked laptop, a profile directory restored on another machine together with
 *     an exported keychain. `safeStorage` closes none of those, because the OS cooperates with all
 *     of them.
 *   - *Where it goes.* The vault gets its own key, separate from the local-data key, so switching
 *     the master password on does not re-encrypt history, settings and favicons. `passwords.key`
 *     holds that key wrapped twice: by the OS key store as today, and by a key derived from the
 *     master password. This is the seam `crypto/local-data-key.ts` already names — "one more
 *     layer over the same 32 bytes".
 *   - *Derivation.* `scrypt` from `node:crypto`, N = 2¹⁷, r = 8, p = 1, a 16-byte random salt
 *     stored beside the wrapped key. Roughly 128 MB and half a second per attempt, which is the
 *     point. Argon2id would be better and is not available without a runtime dependency, and this
 *     project's dependency budget is two — a metric enforces it. scrypt in the standard library is
 *     the strongest thing reachable without spending that budget here.
 *   - *Lifetime.* The vault key exists in main-process memory only while unlocked, and is dropped
 *     on explicit lock, after an idle timeout, and when the last window closes. Autofill then asks
 *     for the master password on the first fill after a lock, which is the cost the user is buying
 *     the guarantee with.
 *   - *What it costs.* A forgotten master password means the vault is gone. That is not a bug to
 *     be worked around with a recovery key stored locally, which would put the protection back
 *     where it started.
 *   - *Why not now.* It needs a modal prompt that can appear over content views — the overlay
 *     layer — plus an unlock state machine in the application entry point and a migration for an
 *     existing vault. Those are three files this change does not own. The record format needs no
 *     change when it arrives, which is why the format was settled first.
 *
 * ## What is done instead, and what it actually buys
 *
 * Given that re-authentication is unavailable, the exposure is bounded instead of gated:
 *
 *   1. The page is never sent a password. `passwords:list` answers with summaries — origin,
 *      username, timestamps — and nothing else. There is no payload anywhere that carries the
 *      vault's secrets as a set.
 *   2. Revealing is one credential at a time, fetched by id when the user asks. The state machine
 *      below makes "two revealed at once" unrepresentable rather than merely unlikely.
 *   3. A revealed password is hidden again after `REVEAL_TIMEOUT_MS`, and immediately when the
 *      document stops being visible — switching tabs, minimising, or the screen locking.
 *
 * The result is that a passwords tab left open holds a list of *sites and usernames*, plus at
 * most one password for at most half a minute. That is a real and checkable reduction, and it is
 * as far as this can honestly be taken without a master password.
 */

/**
 * How long a revealed password stays on screen.
 *
 * Long enough to read a generated passphrase out loud once; short enough that walking away from
 * the desk is not the same as publishing it. A value the user can raise is deliberately absent —
 * a setting here would be a setting whose only effect is to weaken the one bound this page has.
 */
export const REVEAL_TIMEOUT_MS = 30_000

/** The one credential currently on screen. `null` is the resting state. */
export interface RevealState {
  readonly id: string
  readonly revealedAt: number
}

/**
 * The state a fresh reveal starts in.
 *
 * Exported so a caller that has just fetched a secret can build the state directly, rather than
 * calling the reducer with a `reveal` action and then having to handle a `null` the reducer cannot
 * return for that action. A defensive branch nothing can reach is worse than none: it looks like a
 * case somebody thought about.
 */
export function revealState(id: string, at: number): RevealState {
  return { id, revealedAt: at }
}

export type RevealAction =
  | { readonly kind: 'reveal'; readonly id: string; readonly at: number }
  | { readonly kind: 'hide' }
  /** A timer or a re-render asking whether the reveal has outlived its welcome. */
  | { readonly kind: 'tick'; readonly at: number }
  /** The document stopped being visible: another tab, a minimised window, a locked screen. */
  | { readonly kind: 'concealed' }

/**
 * The next reveal state.
 *
 * A reducer rather than three booleans in a component, because the invariant that matters —
 * *at most one password is on screen, and never for longer than the timeout* — is the kind that
 * survives being written once and tested, and does not survive being spread across four event
 * handlers.
 *
 * Revealing a second credential replaces the first rather than adding to it; there is no action
 * that can produce two.
 */
export function nextRevealState(current: RevealState | null, action: RevealAction): RevealState | null {
  switch (action.kind) {
    case 'reveal':
      return revealState(action.id, action.at)
    case 'hide':
    case 'concealed':
      return null
    case 'tick':
      if (current === null) return null
      return isRevealExpired(current, action.at) ? null : current
  }
}

/**
 * Whether a reveal has run out.
 *
 * A timestamp *before* the reveal means the clock moved backwards — an NTP correction, a resumed
 * laptop. That counts as expired: erring towards hiding is the only direction where being wrong
 * costs the user a click instead of a secret.
 */
export function isRevealExpired(state: RevealState, now: number): boolean {
  if (now < state.revealedAt) return true
  return now - state.revealedAt >= REVEAL_TIMEOUT_MS
}

/** Milliseconds left, clamped to zero, for a countdown the user can see. */
export function revealRemainingMs(state: RevealState, now: number): number {
  if (isRevealExpired(state, now)) return 0
  return REVEAL_TIMEOUT_MS - (now - state.revealedAt)
}

/** Whether *this* credential is the revealed one. The only question a row needs to ask. */
export function isRevealed(state: RevealState | null, id: string, now: number): boolean {
  // Two guards rather than one disjunction: the second needs `state` narrowed, and an optional
  // chain — which is what a single `||` invites the linter to suggest — would not narrow it.
  if (state === null) return false
  if (state.id !== id) return false
  return !isRevealExpired(state, now)
}
