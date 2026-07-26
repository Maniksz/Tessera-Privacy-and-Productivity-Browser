import { z } from 'zod'
import {
  discardingPasswordWriter,
  emptyPasswordDocument,
  forgetNeverSavedOrigin,
  listSummaries,
  neverSaveOrigin,
  noteCredentialUsed,
  passwordOriginOf,
  removeCredential,
  repairNeverSaved,
  repairPasswords,
  saveCredential,
  updateCredential,
  usernameKey,
  withoutSecret,
  type BrowsingMode,
  type PasswordCredential,
  type PasswordDocument,
  type PasswordSummary,
  type PasswordWriter,
  type SaveCredentialInput,
  type SaveOutcome,
  type UpdateCredentialPatch
} from '@shared/passwords/model.js'
import type { StoredCredentialState } from '@shared/passwords/save-policy.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'

/**
 * Persistence for saved passwords.
 *
 * All the rules live in `@shared/passwords/model.ts` as pure functions; this class supplies the
 * clock and the identifiers, decides who may write, and puts the result on disk — the same
 * division `HistoryStore` and `QuickLinkStore` use.
 *
 * ## The cipher is the same one; the key is not
 *
 * The `codec` handed in is `createVaultDocumentCodec` — the same AES-256-GCM envelope every other
 * document gets, under the vault's *own* key rather than the profile's. There is deliberately **no
 * second crypto scheme here**: a bespoke envelope for the vault would be one more thing to get wrong
 * — a reused nonce, an unauthenticated mode, a key derived from the machine id — in exchange for
 * nothing, because the threat that matters was never "the file is readable by a different key".
 *
 * A separate *key* does buy something, and it is not confidentiality: it is that the master password,
 * the idle lock and a forgotten passphrase all cost the credentials and nothing else. See
 * `main/crypto/vault-key.ts` for the two wrappings over that key and `main/passwords/vault-codec.ts`
 * for the one-startup migration off the local-data key.
 *
 * One consequence worth naming rather than discovering: with no OS key store and no master password
 * the vault key sits in the profile directory in readable form, so this file's contents are readable
 * too. That is the same trade the rest of the profile makes, documented in
 * `LOCAL-DATA-NOT-ENCRYPTED.txt` — but for a password vault it is worse than for a quick link, and
 * the honest mitigation is a master password, which in that configuration is the *only* thing
 * protecting the vault and is therefore worth the most.
 *
 * ## Why `secretOf` is the only way out
 *
 * Every read on this class answers with `PasswordSummary` — no password — except `secretOf`,
 * which takes one id and returns one string. So "where can a password leave the store?" has a
 * single, greppable answer, and the autofill path is structurally unable to hold a secret while
 * it is still deciding whether it is allowed to.
 */

/**
 * What the file must look like to be usable.
 *
 * The same line `HistoryStore` draws: wrong *kinds* of data are rejected, wrong *amounts* are
 * healed. A number where a string belongs means the file is not ours and defaults are the only
 * safe answer. Too many entries, or a duplicate, is a quantity — and since a validation failure
 * throws the whole document away, a `.max()` here would turn "grew larger than expected" into
 * "lost every password the user had". Those go to `repairPasswords` instead.
 *
 * `password: z.string().min(1)` is the one exception, and it is a kind rather than an amount: an
 * entry with an empty password cannot be filled, so it is not a smaller credential but a
 * different thing. `repairPasswords` drops those, so this only has to be strict enough to stop a
 * hand-written `null` becoming a credential.
 */
const credentialSchema = z.object({
  id: z.string().min(1),
  origin: z.string().min(1),
  username: z.string(),
  password: z.string().min(1),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative().nullable()
})

const passwordDocumentSchema = z.object({
  version: z.literal(1),
  credentials: z.array(credentialSchema),
  /*
    Defaulted rather than required.

    A vault written before the "never here" list existed is a perfectly good vault, and rejecting
    it would replace every saved password with an empty document — the worst possible reading of
    "this file is one field older than the code".
  */
  neverSaved: z.array(z.string()).default([])
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — two assignments
 * per shape, one each way. A single one would only catch drift one way, and the schema cannot
 * live next to the interface because the passwords page is a renderer and zod must not reach its
 * bundle.
 */
type SchemaCredential = z.output<typeof credentialSchema>
type SchemaDocument = z.output<typeof passwordDocumentSchema>

const _credentialMatchesModel: SchemaCredential = null as unknown as PasswordCredential
const _modelMatchesCredential: PasswordCredential = null as unknown as SchemaCredential
const _documentMatchesModel: SchemaDocument = null as unknown as PasswordDocument
const _modelMatchesDocument: PasswordDocument = null as unknown as SchemaDocument
void _credentialMatchesModel
void _modelMatchesCredential
void _documentMatchesModel
void _modelMatchesDocument

export interface PasswordStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps do not depend on when the test ran. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

export class PasswordStore {
  readonly #store: JsonStore<PasswordDocument>
  readonly #generateId: () => string
  readonly #now: () => number

  private constructor(
    store: JsonStore<PasswordDocument>,
    generateId: () => string,
    now: () => number
  ) {
    this.#store = store
    this.#generateId = generateId
    this.#now = now
  }

  static async open(options: PasswordStoreOptions): Promise<PasswordStore> {
    const store = await JsonStore.open<PasswordDocument>({
      filePath: options.filePath,
      schema: passwordDocumentSchema,
      fallback: emptyPasswordDocument,
      // A file written by an older build, edited by hand, or cut short by a crash must not leave
      // two entries for one account or two entries with one id — the first makes autofill offer a
      // password that no longer works, the second makes "reveal this one" ambiguous.
      repair: (document) => ({
        ...document,
        credentials: repairPasswords(document.credentials),
        neverSaved: repairNeverSaved(document.neverSaved)
      }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new PasswordStore(
      store,
      options.generateId ?? defaultIdGenerator,
      options.now ?? (() => Date.now())
    )
  }

  /**
   * Every saved credential, without its password.
   *
   * What `passwords:list` answers and what the autofill offer is built from. There is no method
   * that returns the collection *with* passwords, and that absence is the design: it means no
   * caller can accidentally put the vault on the wire, and no future convenience method can be
   * added without deliberately writing one.
   */
  list(): PasswordSummary[] {
    return listSummaries(this.#store.get().credentials)
  }

  neverSavedOrigins(): string[] {
    return [...this.#store.get().neverSaved]
  }

  /**
   * One password, by id.
   *
   * The single exit for a secret. `null` for an unknown id rather than a throw: the id came from a
   * list the caller was holding, and an entry can be removed between a page rendering and the user
   * clicking — a normal race, not a fault, and an error message naming a credential id is worth
   * less than a row that quietly stops offering to reveal.
   */
  secretOf(id: string): string | null {
    const found = this.#store.get().credentials.find((credential) => credential.id === id)
    return found?.password ?? null
  }

  /** The summary for one id, or `null`. Used to re-check the fill rules against a chosen entry. */
  summaryOf(id: string): PasswordSummary | null {
    const found = this.#store.get().credentials.find((credential) => credential.id === id)
    return found === undefined ? null : withoutSecret(found)
  }

  /**
   * Whether this exact credential is already stored, without revealing what is.
   *
   * The comparison is `===` on the whole string, which is right here and would be wrong in an
   * authentication path: this answers "should the browser ask the user to save?", so a timing
   * difference tells an attacker who can already read the vault nothing it does not already know.
   */
  compareStored(url: string, username: string, password: string): StoredCredentialState {
    const origin = passwordOriginOf(url)
    if (origin === null) return 'none'
    const key = usernameKey(username)
    const found = this.#store
      .get()
      .credentials.find(
        (credential) => credential.origin === origin && usernameKey(credential.username) === key
      )
    if (found === undefined) return 'none'
    return found.password === password ? 'same-password' : 'different-password'
  }

  /**
   * The only way to obtain a writer, and it cannot be obtained without saying which kind of
   * session it is for.
   *
   * A private window gets `discardingPasswordWriter`, an object with no reference to this store —
   * so a private window physically holds no path to the file rather than holding one it is
   * expected to leave alone. That is the difference between an invariant and a convention: no call
   * site can forget a check it does not have to make, and a `save` added anywhere in the window's
   * code inherits the guarantee for free.
   *
   * `noteUsed` is on this interface as well as `save`, and that is the subtle half. Filling a
   * password in a private window is allowed — a private window is about leaving no trace, not
   * about being a different person — but moving `lastUsedAt` would write the trace of a private
   * sign-in into a file on disk, through a field nobody thinks of as history.
   *
   * Deletion and editing are deliberately *not* behind this. Removing a credential from a private
   * window acts on the real vault, which is exactly what the user asking for it means.
   */
  writerFor(mode: BrowsingMode): PasswordWriter {
    if (mode === 'private') return discardingPasswordWriter
    return {
      save: (input: SaveCredentialInput) => this.#save(input),
      neverSaveFor: (url: string) => {
        this.#store.update((document) => ({
          ...document,
          neverSaved: neverSaveOrigin(document.neverSaved, url)
        }))
      },
      noteUsed: (id: string) => {
        this.#store.update((document) => ({
          ...document,
          credentials: noteCredentialUsed(document.credentials, id, { now: this.#now() })
        }))
      }
    }
  }

  /**
   * Adds a credential the user typed on the passwords page.
   *
   * Not behind `writerFor`, and the asymmetry is deliberate: this is a person deciding to record
   * something, not the browser observing a sign-in. The mode-bound writer exists to stop a private
   * window leaving traces of what was *browsed*; refusing an explicit "add this entry" because the
   * passwords tab happens to be in a private window would be a rule protecting nobody from
   * anything.
   */
  create(input: SaveCredentialInput): SaveOutcome {
    return this.#save(input)
  }

  update(id: string, patch: UpdateCredentialPatch): void {
    this.#store.update((document) => ({
      ...document,
      credentials: updateCredential(document.credentials, id, patch, { now: this.#now() })
    }))
  }

  /** True when something was actually removed, so a caller can report what happened. */
  remove(id: string): boolean {
    const before = this.#store.get().credentials.length
    const after = this.#store.update((document) => ({
      ...document,
      credentials: removeCredential(document.credentials, id)
    }))
    return after.credentials.length < before
  }

  forgetNeverSaved(url: string): void {
    this.#store.update((document) => ({
      ...document,
      neverSaved: forgetNeverSavedOrigin(document.neverSaved, url)
    }))
  }

  /** Everything. What a "clear passwords" action would run, and what a test resets with. */
  clear(): number {
    const before = this.#store.get().credentials.length
    this.#store.update((document) => ({ ...document, credentials: [], neverSaved: [] }))
    return before
  }

  /**
   * Change notification, in summaries.
   *
   * Deliberately not the documents: a listener is something that can be added anywhere, including
   * in a renderer-facing layer, and handing one the whole vault would put every password one
   * careless subscriber away from the wire.
   */
  onChange(listener: (summaries: PasswordSummary[]) => void): () => void {
    return this.#store.onChange((document) => listener(listSummaries(document.credentials)))
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  /**
   * True when the document on disk was rewritten under a different key during `open`.
   *
   * The observable half of the migration off the local-data key. Exposed because "the vault was
   * re-encrypted onto its own key" is otherwise a claim with nothing behind it — a test asserts this
   * is true on the first start after the split and false on the second, which is what makes the
   * one-startup window a fact rather than an intention. See `main/passwords/vault-codec.ts`.
   */
  get reencryptedOnLoad(): boolean {
    return this.#store.diagnostics.migratedEncodingOnLoad
  }

  #save(input: SaveCredentialInput): SaveOutcome {
    // Computed before the update so the outcome describes what happened rather than being derived
    // from a length difference — `updated` and `unchanged` both leave the count alone.
    let outcome: SaveOutcome = 'rejected'
    this.#store.update((document) => {
      const result = saveCredential(document.credentials, input, {
        now: this.#now(),
        newId: this.#generateId
      })
      outcome = result.outcome
      return { ...document, credentials: result.credentials }
    })
    return outcome
  }
}

let counter = 0

/**
 * Ids only have to be unique within this file, so a counter plus the clock is enough — the same
 * generator the other stores use.
 *
 * Readable rather than a UUID, and here that is a deliberate re-decision rather than consistency
 * for its own sake: the id is the *only* field of a credential that appears in a place a password
 * must not, so it is worth being certain it carries nothing. A counter and a timestamp cannot
 * encode a username by accident.
 */
function defaultIdGenerator(): string {
  counter += 1
  return `pw-${Date.now().toString(36)}-${counter.toString(36)}`
}
