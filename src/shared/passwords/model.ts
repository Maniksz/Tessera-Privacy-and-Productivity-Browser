/**
 * Saved credentials: what is kept, what is deliberately not kept, and the pure rules
 * that change the collection.
 *
 * ## Why this file has no zod import
 *
 * `tessera://passwords` is a renderer, so every value import here lands in a bundle the
 * user waits for. The persistence schema therefore lives with the store in the main
 * process (`src/main/data/PasswordStore.ts`), the same split `history/model.ts` uses and
 * for the same measured reason. See
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * ## What is stored
 *
 * An origin, a username, a password, and three timestamps. That is the whole record.
 *
 * The **origin** rather than the address. A path is not an authentication boundary:
 * `https://example.com/login?session=8f1c…` and `https://example.com/signin` are the
 * same account, and keeping the first would park a session token in the vault for ever.
 * `URL.origin` also canonicalises the default port away, so `https://example.com:443`
 * and `https://example.com` cannot become two entries for one site.
 *
 * The **scheme is part of the origin, and that is load-bearing** rather than incidental.
 * `fill-policy.ts` refuses to put an `https:` credential into an `http:` page, and it can
 * only do that because the record remembers which one it was saved over.
 *
 * ## What is never stored, and why each absence is deliberate
 *
 * **No form selector, and no field names.** This is the tempting one: remembering
 * `#kc-form-login input[name=j_username]` would let a fill be precise. It is refused for
 * three reasons, in order of weight. It is a *fingerprint of the user's account page* —
 * that selector names the identity provider and often its version, so a vault that leaks
 * would say more about the user than "they have an account at example.com". It *goes
 * stale*: the site redesigns, the selector matches nothing, and autofill stops working
 * with no symptom the user can act on. And it is *unnecessary*: the fields are chosen
 * from the live document on every fill by role (`fields.ts`), which cannot go stale.
 * The cost, stated rather than discovered: a page carrying two independent password forms
 * — "log in" beside "change password" — is not distinguished, so the same credential is
 * offered to both and the user's click decides. A wrong offer costs a click; a stale
 * selector costs the feature.
 *
 * **No page title, no favicon, no URL path or query.** Same reasoning as the origin: each
 * is browsing history by another route, filed in the one place that must give up the least
 * if it is ever read.
 *
 * **No previous passwords.** A rotated password replaces the old one. Keeping history
 * would double the blast radius of a vault compromise for a value the user deliberately
 * retired.
 *
 * **No notes, and no second factor.** A TOTP seed stored beside the password makes the
 * vault a single factor wearing the costume of two.
 *
 * ## Where a password is allowed to be
 *
 * Inside a `PasswordCredential`, inside the sealed document, and in the one IPC reply
 * that answers "reveal this one entry". Nowhere else — not in a log line, not in an
 * error message, not in the offer payload autofill builds, and not in any argument to
 * `fill-policy.ts` or `save-policy.ts`, which are written so that they cannot receive one.
 */

/**
 * Entries kept at most, oldest-used dropped first.
 *
 * Two thousand is far past any real person's account count, and it bounds a document the
 * store rewrites whole on every flush and decrypts in one piece at startup — the same
 * write-cost argument as `MAX_HISTORY_ENTRIES`, with a much smaller number because a
 * credential is worth more per byte than a visit.
 */
export const MAX_PASSWORD_CREDENTIALS = 2000

/** RFC 5321's maximum for an address, which is what a username usually is. */
export const MAX_USERNAME_LENGTH = 320

/**
 * Passwords longer than this are refused rather than truncated.
 *
 * A truncated password is a password that does not work, and it would look to the user
 * like the manager remembering the wrong thing. 1024 covers every generated passphrase
 * and every site's own limit.
 */
export const MAX_PASSWORD_LENGTH = 1024

/** `https://sub.domain.example.com:65535` is 39 characters; this is generous. */
export const MAX_ORIGIN_LENGTH = 256

/** How many "never ask here again" entries are kept. */
export const MAX_NEVER_SAVED_ORIGINS = 500

/**
 * Schemes a credential may be attached to at all.
 *
 * `file:` is absent on purpose: a `file:` document has no host, so a credential saved
 * there would be keyed on nothing and offered to every local file. Everything else a tab
 * can hold — `about:`, `data:`, `blob:`, and this browser's own scheme — is either not a
 * place or not one that authenticates anybody.
 */
export const CREDENTIAL_SCHEMES: readonly string[] = ['https:', 'http:']

/**
 * Which kind of session a writer is for.
 *
 * A named pair rather than a boolean, for the reason `HistoryStore` gives: `writerFor(true)`
 * reads as nothing at all at the call site, and this is the one argument that must not be got
 * backwards.
 */
export type BrowsingMode = 'normal' | 'private'

export interface PasswordCredential {
  /** Opaque and generated; carries no meaning, so nothing can be inferred from it. */
  id: string
  /** Canonical origin, `https://host[:port]`. See `passwordOriginOf`. */
  origin: string
  /** As the user typed it, trimmed. Empty is legal: some sites authenticate on a password alone. */
  username: string
  password: string
  createdAt: number
  updatedAt: number
  /** `null` until a fill has actually used it. Never written from a private window. */
  lastUsedAt: number | null
}

/**
 * A credential with the secret taken out.
 *
 * The type the passwords page, the autofill offer and every event payload are built from.
 * It exists so that "did I just put a password on the wire?" is a question the type
 * checker answers rather than one a reviewer has to.
 */
export interface PasswordSummary {
  id: string
  origin: string
  username: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
}

export interface PasswordDocument {
  version: 1
  /** Most recently used first, then most recently changed. See `byUsefulness`. */
  credentials: PasswordCredential[]
  /**
   * Origins where the user answered "never here".
   *
   * Kept, because without it the save bar becomes nagware: a site the user has decided
   * not to trust the manager with would ask again on every sign-in, and a prompt that
   * cannot be turned off is a prompt people learn to dismiss without reading — which is
   * the failure mode that makes every *other* prompt in the browser worth less.
   */
  neverSaved: string[]
}

export function emptyPasswordDocument(): PasswordDocument {
  return { version: 1, credentials: [], neverSaved: [] }
}

/** Drops the secret. The only conversion from a record to something safe to hand out. */
export function withoutSecret(credential: PasswordCredential): PasswordSummary {
  return {
    id: credential.id,
    origin: credential.origin,
    username: credential.username,
    createdAt: credential.createdAt,
    updatedAt: credential.updatedAt,
    lastUsedAt: credential.lastUsedAt
  }
}

// --- normalisation -----------------------------------------------------------

/**
 * The origin a credential is filed under, or `null` when there is none.
 *
 * `URL.origin` rather than a hand-built `scheme://host:port`: it drops a default port and
 * lower-cases the host, so `https://EXAMPLE.com:443` and `https://example.com` cannot become
 * two entries for one site — which is the shape "it saved my password twice" arrives in.
 *
 * There is deliberately no separate guard for an empty host or for the opaque-origin string
 * `"null"`. Both are unreachable while `CREDENTIAL_SCHEMES` holds only `http:` and `https:`:
 * the URL parser refuses a special scheme with no host, and a special scheme always has a
 * tuple origin. A guard nothing can reach reads like a case somebody thought about, and the
 * scheme check above is what actually makes it true.
 */
export function passwordOriginOf(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }
  if (!CREDENTIAL_SCHEMES.includes(parsed.protocol)) return null
  const origin = parsed.origin
  // A bound rather than a truncation: half an origin is a key that could match the wrong site.
  if (origin.length > MAX_ORIGIN_LENGTH) return null
  return origin
}

/**
 * Usernames as compared, which is not the same as usernames as shown.
 *
 * Trimmed and case-folded for *identity* only — `Alice@example.com` and
 * `alice@example.com` are one account at every site that uses an address as a name, and
 * two entries for them is the bug people report as "it saved my password twice". The
 * stored form keeps the user's own capitalisation, because that is what they will read
 * back and what some sites do care about on submission.
 */
export function usernameKey(username: string): string {
  return username.trim().toLowerCase()
}

/** Trimmed to what is stored and shown. Whitespace around a typed name is never meant. */
export function normalizeUsername(username: string): string {
  return username.trim().slice(0, MAX_USERNAME_LENGTH)
}

// --- ordering ----------------------------------------------------------------

/**
 * Most recently used first, then most recently changed, then by name.
 *
 * The order the offer list and the page are drawn in, and the order pruning drops from
 * the end of. A never-used entry sorts by when it was written, so a credential saved
 * five minutes ago is not buried beneath one used last year.
 */
function byUsefulness(left: PasswordCredential, right: PasswordCredential): number {
  const leftUsed = left.lastUsedAt ?? 0
  const rightUsed = right.lastUsedAt ?? 0
  if (leftUsed !== rightUsed) return rightUsed - leftUsed
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  return left.username.localeCompare(right.username)
}

// --- writes ------------------------------------------------------------------

export interface SaveCredentialInput {
  /** Any address; reduced to its origin here so no caller can file a path by accident. */
  url: string
  username: string
  password: string
}

export interface SaveContext {
  now: number
  /** Injected so this stays pure and a test does not have to guess an identifier. */
  newId: () => string
}

/**
 * Why a save changed nothing, so a caller can say so instead of appearing to work.
 *
 * `unchanged` is not an error: it is the answer for "this exact pair is already stored",
 * and it is what keeps a second sign-in from rewriting the document and waking every
 * listener for nothing.
 */
export type SaveOutcome = 'created' | 'updated' | 'unchanged' | 'rejected'

export interface SaveResult {
  credentials: PasswordCredential[]
  outcome: SaveOutcome
}

/**
 * Stores a credential, replacing the password of an existing (origin, username) pair.
 *
 * The pair is the identity, not the id: a user signing in again with a new password means
 * "this is the password now", and inserting a second row would leave autofill offering two
 * entries with the same name, one of which no longer works. That is the single most
 * confusing thing a password manager can do, so it is made impossible here rather than
 * cleaned up later.
 *
 * An empty password is refused. There is nothing to fill, and an entry that fills nothing
 * is worse than none: it appears in the list, looks stored, and does not work.
 */
export function saveCredential(
  credentials: readonly PasswordCredential[],
  input: SaveCredentialInput,
  context: SaveContext
): SaveResult {
  const origin = passwordOriginOf(input.url)
  const username = normalizeUsername(input.username)
  if (
    origin === null ||
    input.password === '' ||
    input.password.length > MAX_PASSWORD_LENGTH ||
    // Refused rather than shortened. A cut username is a username that does not sign in,
    // and it would look to the user like the manager remembering the wrong thing.
    input.username.trim().length > MAX_USERNAME_LENGTH
  ) {
    return { credentials: [...credentials], outcome: 'rejected' }
  }

  const key = usernameKey(username)
  const existing = credentials.find(
    (candidate) => candidate.origin === origin && usernameKey(candidate.username) === key
  )

  if (existing === undefined) {
    const created: PasswordCredential = {
      id: context.newId(),
      origin,
      username,
      password: input.password,
      createdAt: context.now,
      updatedAt: context.now,
      lastUsedAt: null
    }
    return {
      credentials: pruneToLimit([created, ...credentials].sort(byUsefulness)),
      outcome: 'created'
    }
  }

  if (existing.password === input.password && existing.username === username) {
    return { credentials: [...credentials], outcome: 'unchanged' }
  }

  return {
    credentials: credentials
      .map((candidate) =>
        candidate.id === existing.id
          ? { ...candidate, username, password: input.password, updatedAt: context.now }
          : candidate
      )
      .sort(byUsefulness),
    outcome: 'updated'
  }
}

export interface UpdateCredentialPatch {
  username?: string
  password?: string
}

/**
 * Edits one entry from the passwords page.
 *
 * Separate from `saveCredential` because the two are different acts: one is "the browser
 * observed a sign-in", the other is "the user is correcting the record". This one cannot
 * move an entry to another origin — that is not a correction, it is a new credential, and
 * allowing it here would let a mistyped edit silently re-point a stored password at a
 * different site.
 */
export function updateCredential(
  credentials: readonly PasswordCredential[],
  id: string,
  patch: UpdateCredentialPatch,
  context: { now: number }
): PasswordCredential[] {
  // A blank password is refused here for the same reason as in `saveCredential`: an entry
  // that fills nothing looks stored and is not.
  if (patch.password !== undefined && (patch.password === '' || patch.password.length > MAX_PASSWORD_LENGTH)) {
    return [...credentials]
  }
  /*
    Measured on the *raw* patch, not on the normalised form.

    `normalizeUsername` slices to the limit, so checking its result could never fail — and the
    over-long name would be quietly truncated instead of refused. A cut username is a username that
    does not sign in, which would look like the manager remembering the wrong thing.
  */
  if (patch.username !== undefined && patch.username.trim().length > MAX_USERNAME_LENGTH) {
    return [...credentials]
  }
  const username = patch.username === undefined ? undefined : normalizeUsername(patch.username)

  return credentials
    .map((candidate) =>
      candidate.id === id
        ? {
            ...candidate,
            ...(username === undefined ? {} : { username }),
            ...(patch.password === undefined ? {} : { password: patch.password }),
            updatedAt: context.now
          }
        : candidate
    )
    .sort(byUsefulness)
}

export function removeCredential(
  credentials: readonly PasswordCredential[],
  id: string
): PasswordCredential[] {
  return credentials.filter((candidate) => candidate.id !== id)
}

/**
 * Records that a credential was actually used, which is what orders the offer list.
 *
 * Only ever reached through a writer bound to the normal browsing mode. A private window
 * that moved this timestamp would leave a trace of a private sign-in in a file on disk —
 * the exact thing a private window exists not to do, arriving through a field nobody
 * thinks of as history. See `PasswordWriter`.
 */
export function noteCredentialUsed(
  credentials: readonly PasswordCredential[],
  id: string,
  context: { now: number }
): PasswordCredential[] {
  if (!credentials.some((candidate) => candidate.id === id)) return [...credentials]
  return credentials
    .map((candidate) => (candidate.id === id ? { ...candidate, lastUsedAt: context.now } : candidate))
    .sort(byUsefulness)
}

// --- "never here" ------------------------------------------------------------

export function neverSaveOrigin(neverSaved: readonly string[], rawUrl: string): string[] {
  const origin = passwordOriginOf(rawUrl)
  if (origin === null || neverSaved.includes(origin)) return [...neverSaved]
  return [origin, ...neverSaved].slice(0, MAX_NEVER_SAVED_ORIGINS)
}

export function forgetNeverSavedOrigin(neverSaved: readonly string[], rawUrl: string): string[] {
  const origin = passwordOriginOf(rawUrl)
  if (origin === null) return [...neverSaved]
  return neverSaved.filter((candidate) => candidate !== origin)
}

// --- the write side ----------------------------------------------------------

/**
 * Everything that changes the vault, and the only thing a caller is ever handed.
 *
 * A private window gets `discardingPasswordWriter`, an object with no reference to any
 * store — so a private window physically holds no path to the file rather than holding
 * one it is expected to leave alone. Same construction as `HistoryStore.recorderFor` and
 * `UserRuleStore.editorFor`, and for the same reason: no call site can forget a check it
 * does not have to make.
 *
 * Reading is deliberately *not* behind this. Filling a saved password in a private window
 * is allowed — a private window is about leaving no trace, not about being a different
 * person — and every trace-leaving operation is on this interface instead.
 */
export interface PasswordWriter {
  save(input: SaveCredentialInput): SaveOutcome
  neverSaveFor(url: string): void
  noteUsed(id: string): void
}

/**
 * A writer that keeps nothing.
 *
 * It holds no store, which is the point: a forgotten `privateMode` check cannot leak a
 * credential, because there is nothing here to leak it into. `save` reports `rejected`
 * rather than pretending, so a caller that does surface an outcome cannot claim a private
 * window saved something.
 */
export const discardingPasswordWriter: PasswordWriter = {
  save: (_input: SaveCredentialInput) => 'rejected',
  neverSaveFor: (_url: string) => {},
  noteUsed: (_id: string) => {}
}

// --- reads -------------------------------------------------------------------

export function listSummaries(credentials: readonly PasswordCredential[]): PasswordSummary[] {
  return [...credentials].sort(byUsefulness).map(withoutSecret)
}

/**
 * Entries whose origin or username contains `text`.
 *
 * Matched on the summary rather than on the record, so there is no path here through which
 * a search could ever be run against a password — which is what a "search everything"
 * convenience would quietly become.
 */
export function searchSummaries(
  summaries: readonly PasswordSummary[],
  text: string
): PasswordSummary[] {
  const needle = text.trim().toLowerCase()
  if (needle === '') return [...summaries]
  return summaries.filter(
    (summary) =>
      summary.origin.toLowerCase().includes(needle) ||
      summary.username.toLowerCase().includes(needle)
  )
}

/**
 * Which account a submission with no username field belongs to.
 *
 * A change-password form usually has no name field at all, so a submission from one reports an
 * empty username. Saved as-is, that creates a second nameless entry beside the real one, and the
 * user is then offered two credentials for the site — one of which no longer works. That is the
 * confusion this feature exists to remove.
 *
 * So when the site has exactly *one* stored credential, an empty submitted name is read as "that
 * one". With none there is nothing to guess at, and with two or more guessing would be worse than
 * the nameless entry: it would silently overwrite one of two accounts the user actually has.
 */
export function resolveSubmittedUsername(
  summaries: readonly PasswordSummary[],
  origin: string,
  submitted: string
): string {
  const trimmed = normalizeUsername(submitted)
  if (trimmed !== '') return trimmed
  const forOrigin = summaries.filter((summary) => summary.origin === origin)
  const [only] = forOrigin.slice(0, 1)
  return forOrigin.length === 1 && only !== undefined ? only.username : ''
}

// --- repair ------------------------------------------------------------------

function pruneToLimit(credentials: readonly PasswordCredential[]): PasswordCredential[] {
  return credentials.slice(0, MAX_PASSWORD_CREDENTIALS)
}

/**
 * Makes a loaded document obey what the write path maintains: one entry per (origin,
 * username), a usable ordering, no duplicate ids, and no more than the cap.
 *
 * Duplicates are resolved in favour of the most recently updated entry rather than merged.
 * There is no sensible merge of two different passwords for one account — one of them is
 * simply wrong — and "the newer one" is the only answer that matches what the user last
 * did.
 *
 * Deliberately *not* done here: dropping entries whose origin this build would now refuse.
 * Narrowing `CREDENTIAL_SCHEMES` later would then silently delete every affected
 * credential on the next start, which is data loss disguised as a cleanup. An unfillable
 * entry stays visible on the page, where the user can see it and act.
 */
export function repairPasswords(credentials: readonly PasswordCredential[]): PasswordCredential[] {
  const byPair = new Map<string, PasswordCredential>()
  const seenIds = new Set<string>()

  for (const credential of [...credentials].sort(byUsefulness)) {
    // An empty password cannot be filled, so an entry holding one is a row that looks
    // stored and is not. Dropped rather than kept, because unlike a narrowed scheme this
    // is not a rule that might widen again.
    if (credential.password === '') continue
    // A repeated id would make "reveal this one" ambiguous, which is the one place
    // ambiguity would hand back the wrong secret.
    if (seenIds.has(credential.id)) continue
    const key = `${credential.origin}\u0000${usernameKey(credential.username)}`
    if (byPair.has(key)) continue
    seenIds.add(credential.id)
    byPair.set(key, credential)
  }

  return pruneToLimit([...byPair.values()].sort(byUsefulness))
}

/** Duplicate and unusable "never here" entries removed, and the list capped. */
export function repairNeverSaved(neverSaved: readonly string[]): string[] {
  const kept: string[] = []
  for (const candidate of neverSaved) {
    const origin = passwordOriginOf(candidate)
    if (origin === null || kept.includes(origin)) continue
    kept.push(origin)
  }
  return kept.slice(0, MAX_NEVER_SAVED_ORIGINS)
}
