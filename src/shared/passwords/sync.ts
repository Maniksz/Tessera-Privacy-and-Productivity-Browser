import type { PasswordCredential } from './model.js'

/**
 * The seam network synchronisation will attach to. **No adapter is implemented here.**
 *
 * Defined now, and empty on purpose. The order was decided deliberately — local vault and Chrome
 * import first, network sync as its own pass — and the risk in that order is the usual one: the pass
 * that arrives second discovers that the first one's shapes cannot carry it, and something already
 * shipped has to be rebuilt. So the interface is written while the constraints are fresh, with the two
 * intended adapters named in it, and it is written *without* an implementation so that nothing here is
 * dead code pretending to work.
 *
 * ## The four decisions this seam makes, and why
 *
 * **1. Whole snapshots, not deltas.** A delta protocol needs a change log, and a change log of a
 * password vault is a record of when the user changed which password — which is exactly the metadata
 * `model.ts` refuses to keep, filed in the one place that must give up the least if it is ever read.
 * The vault is capped at `MAX_PASSWORD_CREDENTIALS`, so a whole snapshot is tens of kilobytes and the
 * cost of sending it is not worth a new class of stored data.
 *
 * **2. Merging is not the adapter's job.** An adapter reads and writes; the reconciliation is one pure
 * function above it, so a KDBX adapter and a Vaultwarden adapter cannot disagree about what "the newer
 * one wins" means. Two merges would eventually differ, and the direction they differ in is "one device
 * silently kept the wrong password".
 *
 * **3. The adapter never sees the vault key or the master password.** It is handed plaintext
 * credentials and is responsible for its own protection at rest, because both intended targets already
 * have their own and neither can use ours: a KDBX file must open in KeePass, and a Vaultwarden account
 * has its own derived key. Handing an adapter our key would put the vault key on a network path, which
 * is the one thing that must not happen for a convenience.
 *
 * **4. `describe()` must be able to say where the data goes.** `VaultSyncReach` exists because of a
 * decision recorded in `docs/STATUS.md` and left explicitly open: *a cloud instance of the same
 * software contradicts the premise of this product.* An adapter that can talk to a self-hosted
 * Vaultwarden can talk to a hosted one, and the difference is the whole argument for the product. So it
 * is not a comment or a documentation note — it is a required field on the type, which means an
 * adapter cannot be written without answering the question and the interface cannot show a target
 * without showing the answer.
 *
 * ## What each intended adapter would need from this, concretely
 *
 * **KDBX — one file on a network share, no server, no third party.** It needs (a) `pull` and `push`
 * separable, with `push` able to fail as `'stale'`, because two devices writing one file on a share is
 * the entire failure mode and the only defence is re-read, re-merge, re-write; (b) `revision` to be
 * something a *file* can produce — a modification time and a size, or a content hash — which is why it
 * is an opaque string here rather than a number that only a server could count; (c) its own passphrase
 * and its own KDF, separate from our master password, or the file will not open in KeePass; (d) a
 * field mapping that is honestly lossy — KDBX entries carry Title and Notes, and this vault
 * deliberately stores neither, so those are written empty and ignored on read. That has to be stated to
 * the user before the first push, because "the sync lost my notes" is otherwise a bug report. (e) A
 * runtime dependency: KDBX is a real format with a real cipher suite, and writing one here is exactly
 * the "write it yourself" that `docs/STATUS.md` names as the wrong answer for cryptography. One of the
 * two reserved slots.
 *
 * **Vaultwarden — a server on the user's own network.** It needs (a) an unauthenticated state that is
 * *reportable* rather than thrown, hence `status` on the description: an adapter whose every call
 * rejected until a login happened would make "not set up yet" indistinguishable from "the server is
 * down"; (b) a stable per-entry identity, because Bitwarden's model encrypts each cipher separately
 * client-side and addresses them individually — `PasswordCredential.id` already is that, which is why
 * the snapshot carries whole credentials rather than a re-keyed projection of them; (c) every request
 * through Chromium's network stack (`net.fetch`), never Node's global, for the reason
 * `FilterSubscription` gives: a request that slips past the proxy and secure DNS the user configured
 * defeats the protection they turned on, and this one carries credentials; (d) `reach` — see decision 4.
 *
 * ## The one thing this seam cannot yet express, named rather than half-built
 *
 * **Deletions.** There are no tombstones. Merge two snapshots by "the newer `updatedAt` wins" and a
 * credential deleted on one device is *restored* by the next pull from another, for ever, because
 * absence is indistinguishable from never-having-existed. That is not a detail to be discovered during
 * the sync pass; it is the first decision of it, and it is a change to the stored document
 * (`PasswordDocument` would gain a list of deleted identities and the times they went), which is
 * precisely why it is not being smuggled in now. `reveal.ts` records that the record format was
 * settled first so that the master password needed no change to it; the same discipline says a
 * tombstone list is the sync pass's own change, made deliberately, with its own retention rule — a
 * tombstone that never expires is a permanent record of every account the user ever deleted, which is
 * the sort of thing this vault exists not to keep.
 *
 * Until then `VaultSnapshot.deletions` does not exist, and `mergeVaultSnapshots` does not exist either:
 * a merge written without an answer to deletions would be a merge that resurrects them, and shipping
 * that as tested code would be worse than shipping nothing.
 */

/** Where a target physically is, and therefore who can see it. Required; see decision 4. */
export type VaultSyncReach =
  /** A file on this machine or a share reachable only from the local network. */
  | 'local-file'
  /** A server the user runs, addressed on a private network. */
  | 'private-network'
  /**
   * A host on the public internet.
   *
   * Present so that it can be *shown*, not so that it can be offered quietly. An adapter that returns
   * this is obliged by the interface to admit it, and the surface that lists targets is obliged to
   * render it, because the difference between this value and the other two is the difference between
   * this product and the thing it exists as an alternative to.
   */
  | 'internet'

export type VaultSyncStatus =
  | 'ready'
  /** Configured but not authenticated, or a passphrase not yet supplied. Reportable, not thrown. */
  | 'needs-credentials'
  /** Configured and currently unreachable — the share is not mounted, the server is down. */
  | 'unreachable'
  | 'not-configured'

export interface VaultSyncDescription {
  /** Stable identifier for the adapter kind: `'kdbx'`, `'vaultwarden'`. Never user-visible text. */
  readonly kind: string
  /**
   * Where the data goes, as the user would name it: a file path, a host.
   *
   * Shown, so it must be short and must not be a secret. A URL with credentials in it is not
   * acceptable here, and an adapter that has one must strip them before answering.
   */
  readonly target: string
  readonly reach: VaultSyncReach
  readonly status: VaultSyncStatus
}

/**
 * Everything the vault holds, as one value.
 *
 * `PasswordCredential` and not a projection: the secrets are in it, because a sync that did not carry
 * them would not be a sync. What is *not* in it is the "never here" list — that is a statement about
 * this browser's prompts on this machine, not a credential, and pushing it to a shared file would make
 * one device's dismissal another device's silence.
 *
 * `revision` is opaque and is the adapter's own: a file's modification time and size, a server's
 * revision counter, a content hash. Opaque because a number would only fit a server, and the KDBX case
 * — the one with no server at all — is the one the concurrency check matters most for.
 */
export interface VaultSnapshot {
  readonly credentials: readonly PasswordCredential[]
  readonly revision: string | null
}

/** Why a push did not happen. `'stale'` is the one a caller must handle by re-pulling and re-merging. */
export type VaultPushRefusal = 'stale' | 'needs-credentials' | 'unreachable' | 'read-only'

export type VaultPushResult =
  | { readonly pushed: true; readonly revision: string | null }
  | { readonly pushed: false; readonly reason: VaultPushRefusal }

/**
 * One synchronisation target.
 *
 * Deliberately four members. Anything more — a "sync now", a conflict callback, a progress event — is
 * the *caller's* job, and putting it here would mean every adapter reimplementing the scheduling and
 * the merge. Anything less and the stale-write case cannot be handled at all.
 *
 * Neither `pull` nor `push` may throw for a condition the type can express: `'unreachable'` is a
 * network being a network, and an adapter that rejected for it would make every caller write the same
 * `catch` and get it slightly differently wrong.
 */
export interface VaultSyncAdapter {
  describe(): VaultSyncDescription
  /** `null` when the target holds nothing yet — a share with no file on it. */
  pull(): Promise<VaultSnapshot | null>
  /**
   * Writes a snapshot, refusing if the target moved underneath it.
   *
   * `expectedRevision` is the revision the caller merged against. An adapter that cannot detect a
   * concurrent write must answer `'stale'` when it is given one it cannot verify rather than
   * overwriting — losing somebody else's password is not an acceptable default for a convenience.
   */
  push(snapshot: VaultSnapshot, expectedRevision: string | null): Promise<VaultPushResult>
  /** Releases whatever the adapter holds: a mounted share, a session token, an open handle. */
  close(): Promise<void>
}
