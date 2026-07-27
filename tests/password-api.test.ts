import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MasterPasswordPrompt,
  type MasterPasswordHost,
  type MasterPasswordVault
} from '@main/passwords/MasterPasswordPrompt.js'
import {
  PasswordApi,
  type ImportSource,
  type PasswordApiVault,
  type VaultCopyChoice
} from '@main/passwords/PasswordApi.js'
import type { MasterPasswordPresentation, OverlayPresentation } from '@shared/overlay/surface.js'
import type { PasswordCreateResponse, PasswordUpdateRequest } from '@shared/passwords/api.js'
import type { ChromeImportResult } from '@shared/passwords/chrome-import.js'
import type { PasswordSummary } from '@shared/passwords/model.js'
import {
  RESET_VAULT_CONFIRMATION,
  type MasterPasswordOutcome,
  type UnlockOutcome,
  type VaultStatus
} from '@shared/passwords/vault.js'

/**
 * What `tessera://passwords` is allowed to do, and what it must never be talked into.
 *
 * Four things break in the product if the decisions asserted here are wrong, and each one is the
 * reason its group of tests exists:
 *
 *   - **A vault discarded after the copy of it failed.** `resetVault` is reached by somebody who has
 *     forgotten their master password, and the sealed document they cannot read this morning is the
 *     one they can read the day the password comes back to them. Every failure path has to leave it
 *     alone, and the *order* — offer, copy, verify that something was written, only then discard — is
 *     asserted through a vault that records what happened in the order it happened. A version that
 *     discarded first would satisfy every assertion about return values.
 *   - **An edit that overwrites a password with nothing.** A request that crossed IPC carries
 *     `{ password: undefined }` rather than an absent field, so the patch is rebuilt key by key. A
 *     spread would claim an edit nobody asked for, on the one field where "nothing" destroys
 *     something.
 *   - **A page holding more secrets than it asked for.** One method may return a password. The class's
 *     own surface is walked below and every method is called against a vault that counts who reaches
 *     for a secret, because the bound on what an open passwords tab holds is only real while there is
 *     no second call that can fetch them in bulk, and no export.
 *   - **An English sentence on a translated page.** A cancelled file chooser is not a failure, a file
 *     that could not be read is not a file whose contents were refused, and neither rejection is let
 *     out of `import` — the page that would show it is one somebody reads once, at a bad moment.
 *
 * The prompt is a real `MasterPasswordPrompt` over the same fake vault rather than a stand-in, so
 * `requestUnlock` and `beginSetMasterPassword` go through the class that actually decides what to ask
 * and what an answer means.
 */

/**
 * An idle timeout no default would produce.
 *
 * Deliberately not the real constant: a status carrying this number can only have come from the vault,
 * so every `vault:` field asserted below is a pass-through rather than something this class invented.
 */
const IDLE_MS = 61_000

function unlockedStatus(overrides: Partial<VaultStatus> = {}): VaultStatus {
  return {
    protection: 'keystore+master',
    unlocked: true,
    unreadable: false,
    idleTimeoutMs: IDLE_MS,
    ...overrides
  }
}

function lockedStatus(overrides: Partial<VaultStatus> = {}): VaultStatus {
  return unlockedStatus({ unlocked: false, ...overrides })
}

/** What the fake's reset leaves behind: an empty vault, open, with no master password on it. */
function freshStatus(): VaultStatus {
  return unlockedStatus({ protection: 'keystore' })
}

function summary(id: string, origin: string, username: string): PasswordSummary {
  return { id, origin, username, createdAt: 1, updatedAt: 2, lastUsedAt: null }
}

function importReport(overrides: Partial<ChromeImportResult> = {}): ChromeImportResult {
  return {
    imported: 2,
    duplicatesIdentical: 0,
    duplicatesConflicting: 0,
    conflicts: [],
    skipped: {
      'no-url': 0,
      'formula-url': 0,
      'unsupported-url': 0,
      'no-password': 0,
      'password-too-long': 0,
      'username-too-long': 0
    },
    full: 0,
    refusedByVault: 0,
    notesDropped: 0,
    refusal: null,
    ...overrides
  }
}

/** A file the user picked. The path matters: a successful import names it back. */
const CSV: ImportSource = {
  path: '/Users/someone/Downloads/Chrome Passwords.csv',
  text: 'url,username,password\nhttps://example.com,alice,hunter2\n'
}

interface FakeVaultOptions {
  readonly status?: VaultStatus
  readonly credentials?: readonly PasswordSummary[]
  readonly neverSaved?: readonly string[]
  readonly secrets?: Readonly<Record<string, string>>
  readonly createOutcome?: PasswordCreateResponse['outcome']
  readonly removed?: boolean
  /** How many files the copy wrote, or the rejection the file system produced instead. */
  readonly copies?: number | Error
  readonly reset?: boolean
  /** `null` is what a locked vault answers an import with. */
  readonly imported?: ChromeImportResult | null
}

/**
 * One vault for both seams, because there is one vault in the application.
 *
 * `PasswordApiVault` and `MasterPasswordVault` are two views of `PasswordVault`, and sharing a single
 * fake between them is what makes "the status in the reply is the one *after* the prompt ran" a real
 * assertion instead of two unrelated fixtures agreeing.
 */
class FakeVault implements PasswordApiVault, MasterPasswordVault {
  /**
   * The three operations whose *order* is a decision, in the order they happened.
   *
   * Only those. Everything else is recorded in a field of its own, so an ordering assertion reads as
   * the sequence it is about and nothing else.
   */
  readonly log: string[] = []
  readonly patches: Array<{ id: string; patch: { username?: string; password?: string } }> = []
  readonly created: Array<{ url: string; username: string; password: string }> = []
  readonly removedIds: string[] = []
  readonly forgotten: string[] = []
  /** What was handed to the CSV reader. Empty means nothing was parsed at all. */
  readonly importedText: string[] = []
  /** How many times anything asked this vault for a password. See the surface tests. */
  secretReads = 0

  #status: VaultStatus
  readonly #credentials: readonly PasswordSummary[]
  readonly #neverSaved: readonly string[]
  readonly #secrets: Readonly<Record<string, string>>
  readonly #createOutcome: PasswordCreateResponse['outcome']
  readonly #removed: boolean
  readonly #copies: number | Error
  readonly #reset: boolean
  readonly #imported: ChromeImportResult | null

  constructor(options: FakeVaultOptions = {}) {
    this.#status = options.status ?? unlockedStatus()
    this.#credentials = options.credentials ?? []
    this.#neverSaved = options.neverSaved ?? []
    this.#secrets = options.secrets ?? {}
    this.#createOutcome = options.createOutcome ?? 'created'
    this.#removed = options.removed ?? true
    this.#copies = options.copies ?? 1
    this.#reset = options.reset ?? true
    this.#imported = options.imported === undefined ? importReport() : options.imported
  }

  status(): VaultStatus {
    return this.#status
  }

  list(): PasswordSummary[] {
    return [...this.#credentials]
  }

  neverSavedOrigins(): string[] {
    return [...this.#neverSaved]
  }

  secretOf(id: string): string | null {
    this.secretReads += 1
    // A closed vault has no store to read from; the key is not in the process. Same answer as an
    // unknown id, which is the shape `reveal` is asserted to preserve.
    if (!this.#status.unlocked) return null
    return this.#secrets[id] ?? null
  }

  create(input: {
    url: string
    username: string
    password: string
  }): PasswordCreateResponse['outcome'] {
    this.created.push({ ...input })
    return this.#createOutcome
  }

  update(id: string, patch: { username?: string; password?: string }): void {
    // The patch object itself, not a copy: which keys are present is the thing under test.
    this.patches.push({ id, patch })
  }

  remove(id: string): boolean {
    this.removedIds.push(id)
    return this.#removed
  }

  forgetNeverSaved(url: string): void {
    this.forgotten.push(url)
  }

  async lock(): Promise<void> {
    // Closing takes a turn, so a `lock()` that read the status before waiting would report an open
    // vault to a page that had just asked for it to be shut.
    await Promise.resolve()
    this.log.push('lock')
    this.#status = { ...this.#status, unlocked: false }
  }

  async copyTo(directory: string): Promise<number> {
    this.log.push(`copyTo:${directory}`)
    await Promise.resolve()
    if (this.#copies instanceof Error) throw this.#copies
    return this.#copies
  }

  async resetVault(confirmation: string): Promise<boolean> {
    // The token is recorded, so the test can see that the one the caller sent is the one the vault
    // checks — rather than a constant this class reconstructed on the way past.
    this.log.push(`resetVault:${confirmation}`)
    await Promise.resolve()
    this.#status = freshStatus()
    return this.#reset
  }

  importChromeCsv(text: string): ChromeImportResult | null {
    this.importedText.push(text)
    return this.#imported
  }

  // --- the slice the prompt reaches for ---------------------------------------

  async unlock(_masterPassword: string): Promise<UnlockOutcome> {
    await Promise.resolve()
    this.#status = { ...this.#status, unlocked: true }
    return 'unlocked'
  }

  verifyMasterPassword(_candidate: string): Promise<boolean> {
    return Promise.resolve(false)
  }

  setMasterPassword(_request: {
    readonly current: string | null
    readonly next: string | null
  }): Promise<MasterPasswordOutcome> {
    return Promise.resolve('set')
  }
}

interface HarnessOptions extends FakeVaultOptions {
  readonly copyChoice?: VaultCopyChoice
  /** `null` for a chooser the user closed, an `Error` for a file that could not be read. */
  readonly importFile?: ImportSource | null | Error
}

function harness(options: HarnessOptions = {}) {
  const vault = new FakeVault(options)
  const presented: OverlayPresentation[] = []
  const host: MasterPasswordHost = {
    presentOverlay: (presentation) => {
      presented.push(presentation)
    },
    // The prompt takes its own surface down when it settles, and nothing asserted here turns on which
    // surface was displaced — only on whether anybody was asked anything at all.
    dismissOverlay: () => {}
  }
  const prompt = new MasterPasswordPrompt({ vault, readClipboard: () => '' })
  const askAboutVaultCopy = vi.fn((): Promise<VaultCopyChoice> =>
    Promise.resolve(options.copyChoice ?? { choice: 'cancel' })
  )
  const chooseImportFile = vi.fn((): Promise<ImportSource | null> => {
    const file = options.importFile === undefined ? CSV : options.importFile
    return file instanceof Error ? Promise.reject(file) : Promise.resolve(file)
  })
  const api = new PasswordApi({ vault, prompt, chooseImportFile, askAboutVaultCopy })
  return { api, vault, prompt, host, presented, askAboutVaultCopy, chooseImportFile }
}

/** The master-password questions among what was drawn, narrowed so `requestId` is reachable. */
function questionsIn(presented: readonly OverlayPresentation[]): MasterPasswordPresentation[] {
  return presented.filter(
    (presentation): presentation is MasterPasswordPresentation =>
      presentation.kind === 'master-password'
  )
}

/**
 * Silences the one `console.warn` a caught rejection makes, and hands back the spy.
 *
 * The spy is the assertion: these failures are *logged* rather than returned, because a rejected
 * invoke becomes an untranslated sentence on the page. Restored in `afterEach`.
 */
function silencedWarnings() {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the list', () => {
  it('answers with the entries, the never-here origins and the lock in one reply', () => {
    const { api } = harness({
      credentials: [summary('pw-1', 'https://example.com', 'alice')],
      neverSaved: ['https://bank.example']
    })
    // One call, so the list and the lock cannot be out of step — which they would be with a separate
    // status channel and a round trip between the two.
    expect(api.list()).toEqual({
      credentials: [summary('pw-1', 'https://example.com', 'alice')],
      neverSaved: ['https://bank.example'],
      vault: unlockedStatus()
    })
  })

  it('answers while the vault is locked rather than refusing', () => {
    const { api } = harness({ status: lockedStatus() })
    const answer = api.list()
    // The same three fields an open vault's reply has: the page reads `vault`, draws the lock panel,
    // and never has to tell "locked" apart from "the call failed".
    expect(Object.keys(answer).sort()).toEqual(['credentials', 'neverSaved', 'vault'])
    expect(answer.vault).toEqual(lockedStatus())
  })
})

describe('revealing one password', () => {
  it('answers the one that was asked for', () => {
    const { api } = harness({ secrets: { 'pw-1': 'hunter2' } })
    expect(api.reveal({ id: 'pw-1' })).toEqual({ password: 'hunter2' })
  })

  it('answers an unknown id and a locked vault in the same shape', () => {
    /*
      Deliberately indistinguishable, and neither is a rejection. The id came from a list the page was
      already holding, and an entry can be removed in another window between the row being drawn and
      the button being pressed — so "it has gone" must not arrive looking like a fault.
    */
    const open = harness({ secrets: { 'pw-1': 'hunter2' } })
    const closed = harness({ status: lockedStatus(), secrets: { 'pw-1': 'hunter2' } })
    expect(open.api.reveal({ id: 'pw-2' })).toEqual({ password: null })
    expect(closed.api.reveal({ id: 'pw-1' })).toEqual({ password: null })
  })
})

describe('adding an entry', () => {
  it('hands over the address as typed and reports what the vault made of it', () => {
    // Not reduced to an origin here: `PasswordStore` does that, so a pasted deep link is normalised in
    // the one place that also normalises what the save bar collects.
    const { api, vault } = harness({ createOutcome: 'updated' })
    expect(
      api.create({
        url: 'https://example.com/login?session=abc',
        username: 'alice',
        password: 'hunter2'
      })
    ).toEqual({ outcome: 'updated' })
    expect(vault.created).toEqual([
      { url: 'https://example.com/login?session=abc', username: 'alice', password: 'hunter2' }
    ])
  })
})

describe('editing an entry', () => {
  it('sends no password key at all when the request carried no password', () => {
    const { api, vault } = harness()
    expect(api.update({ id: 'pw-1', username: 'renamed' })).toEqual({ ok: true })

    const [edit] = vault.patches.slice(0, 1)
    expect(edit, 'the edit never reached the vault').not.toBeUndefined()
    expect(edit!.id).toBe('pw-1')
    /*
      `in` rather than a comparison, because `toEqual` cannot tell a key holding `undefined` from an
      absent one — and that is exactly the difference between renaming an entry and wiping its
      password. A spread of the request would put the key here.
    */
    expect('password' in edit!.patch, 'a rename claimed an edit to the password').toBe(false)
    expect(edit!.patch).toStrictEqual({ username: 'renamed' })
  })

  it('sends no password key for a request in the shape one that crossed IPC has', () => {
    const { api, vault } = harness()
    /*
      The one type assertion in this file, and it is unavoidable: `PasswordUpdateRequest` declares
      `password?: string`, so under `exactOptionalPropertyTypes` nothing holding `password: undefined`
      is assignable to it — which is precisely what zod hands the handler after a page omitted the
      field. The runtime shape is the case worth testing; the compiler cannot express it.
    */
    const fromTheWire: unknown = { id: 'pw-1', username: 'renamed', password: undefined }
    api.update(fromTheWire as PasswordUpdateRequest)

    const [edit] = vault.patches.slice(0, 1)
    expect(edit, 'the edit never reached the vault').not.toBeUndefined()
    expect('password' in edit!.patch, 'an undefined field became an edit').toBe(false)
    expect(edit!.patch).toStrictEqual({ username: 'renamed' })
  })

  it('sends a password the request did carry', () => {
    const { api, vault } = harness()
    expect(api.update({ id: 'pw-1', password: 'hunter3' })).toEqual({ ok: true })

    const [edit] = vault.patches.slice(0, 1)
    expect(edit, 'the edit never reached the vault').not.toBeUndefined()
    // The mirror of the case above: an explicit value has to arrive, or the rule that protects a
    // password from an accidental edit would be protecting it from a deliberate one too.
    expect(edit!.patch).toStrictEqual({ password: 'hunter3' })
    expect('username' in edit!.patch).toBe(false)
  })
})

describe('removing an entry and undoing a never-here', () => {
  it('reports whether a row was actually removed', () => {
    // `false` is what a second click on a stale row produces, and the page needs to tell it from a
    // removal that did something.
    const gone = harness({ removed: true })
    const already = harness({ removed: false })
    expect(gone.api.remove({ id: 'pw-1' })).toEqual({ removed: true })
    expect(already.api.remove({ id: 'pw-2' })).toEqual({ removed: false })
    expect(gone.vault.removedIds).toEqual(['pw-1'])
  })

  it('forgets the never-here for the origin it names', () => {
    const { api, vault } = harness()
    expect(api.forgetNeverSaved({ origin: 'https://bank.example' })).toEqual({ ok: true })
    expect(vault.forgotten).toEqual(['https://bank.example'])
  })
})

describe('the lock', () => {
  it('answers the lock on its own, unedited', () => {
    /*
      Every field travels, `unreadable` included. It is the one that decides whether the panel asks for
      a master password at all — a vault whose key file cannot be opened would otherwise be shown a
      field that cannot succeed.
    */
    const { api } = harness({ status: lockedStatus({ protection: 'plain', unreadable: true }) })
    expect(api.vaultStatus()).toEqual({
      vault: { protection: 'plain', unlocked: false, unreadable: true, idleTimeoutMs: IDLE_MS }
    })
  })

  it('waits for the vault to close before it reports the state', async () => {
    // The fake takes a turn to close. A version that read the status first would answer `unlocked`
    // here, and the page would redraw itself as open immediately after being asked to lock.
    const { api, vault } = harness()
    await expect(api.lock()).resolves.toEqual({ vault: unlockedStatus({ unlocked: false }) })
    expect(vault.log).toEqual(['lock'])
  })
})

describe('a request to unlock', () => {
  it('is cancelled when there is no window to draw the prompt in', async () => {
    const { api, presented } = harness({ status: lockedStatus() })
    // Nowhere to ask, so nobody can answer. A prompt raised for a request that cannot be attributed to
    // a window would sit on screen unanswerable.
    await expect(api.requestUnlock(null)).resolves.toEqual({
      outcome: 'cancelled',
      vault: lockedStatus()
    })
    expect(presented, 'a prompt was drawn for a request nobody could answer').toEqual([])
  })

  it('carries the state afterwards, so a successful unlock needs no second round trip', async () => {
    // A locked vault with no master password on it — what an explicit lock leaves behind for a user
    // who never set one. The prompt reopens it without asking, and the status in this reply is the one
    // after that, which is what the page redraws from.
    const { api, host } = harness({ status: lockedStatus({ protection: 'keystore' }) })
    await expect(api.requestUnlock(host)).resolves.toEqual({
      outcome: 'unlocked',
      vault: unlockedStatus({ protection: 'keystore' })
    })
  })

  it('reports a dismissed prompt as cancelled, with the vault still shut', async () => {
    const { api, prompt, presented, vault, host } = harness({ status: lockedStatus() })
    const pending = api.requestUnlock(host)
    const [question] = questionsIn(presented).slice(0, 1)
    expect(question, 'no question was drawn for a vault that needs a password').not.toBeUndefined()

    prompt.answer(question!.requestId, 'cancel')
    await expect(pending).resolves.toEqual({ outcome: 'cancelled', vault: lockedStatus() })
    expect(vault.log, 'a cancelled prompt still touched the vault').toEqual([])
  })
})

describe('setting the master password', () => {
  it('forwards the intent and answers with the outcome and the state afterwards', async () => {
    /*
      `set` on an open vault with no master password on it is a `set` sequence, and the prompt derives
      that from the vault rather than from the caller. Seeing the question on screen is what proves the
      intent travelled — a method that reported an outcome without asking anybody would pass a
      return-value assertion.
    */
    const { api, prompt, presented, host } = harness({
      status: unlockedStatus({ protection: 'keystore' })
    })
    const pending = api.beginSetMasterPassword({ intent: 'set' }, host)
    const [question] = questionsIn(presented).slice(0, 1)
    expect(question?.purpose).toBe('set')
    expect(question?.step, 'a vault with no master password was asked for its current one').toBe(
      'new'
    )

    prompt.answer(question!.requestId, 'cancel')
    await expect(pending).resolves.toEqual({
      outcome: 'cancelled',
      vault: unlockedStatus({ protection: 'keystore' })
    })
  })

  it('reports an intent the vault cannot satisfy without asking anybody', async () => {
    // Nothing to remove. A dialogue here would ask for a password in order to be told there is none.
    const { api, presented, host } = harness({ status: unlockedStatus({ protection: 'keystore' }) })
    await expect(api.beginSetMasterPassword({ intent: 'remove' }, host)).resolves.toEqual({
      outcome: 'not-protected',
      vault: unlockedStatus({ protection: 'keystore' })
    })
    expect(presented).toEqual([])
  })
})

describe('destroying the vault', () => {
  it('offers nothing at all when the confirmation token is wrong', async () => {
    /*
      The token is checked before the dialogue, and that ordering is the point: an empty or mistaken
      invoke on this channel would otherwise put "your vault is about to be destroyed" in front of
      somebody — alarming on its own, and about a reset that was going to be refused anyway.
    */
    const { api, vault, askAboutVaultCopy } = harness()
    await expect(api.resetVault({ confirmation: 'delete' })).resolves.toEqual({
      reset: false,
      copy: 'none',
      vault: unlockedStatus()
    })
    await expect(api.resetVault({ confirmation: '' })).resolves.toEqual({
      reset: false,
      copy: 'none',
      vault: unlockedStatus()
    })
    expect(askAboutVaultCopy, 'a mistaken invoke raised the dialogue').not.toHaveBeenCalled()
    expect(vault.log).toEqual([])
  })

  it('leaves the vault alone when the user cancels the offer', async () => {
    // "Cancel the whole thing" is one of the three answers because the offer is shown at the point of
    // no return, and it is the answer most people want when they read the sentence and reconsider.
    const { api, vault, askAboutVaultCopy } = harness({ copyChoice: { choice: 'cancel' } })
    await expect(api.resetVault({ confirmation: RESET_VAULT_CONFIRMATION })).resolves.toEqual({
      reset: false,
      copy: 'none',
      vault: unlockedStatus()
    })
    expect(askAboutVaultCopy).toHaveBeenCalledTimes(1)
    expect(vault.log, 'a cancelled offer went on to discard the vault').toEqual([])
  })

  it('honours a decision to discard, and copies nothing', async () => {
    // A real answer, taken at face value: somebody who has decided the old vault is worthless does not
    // need arguing with, and the sentence they read said what they were giving up.
    const { api, vault } = harness({ copyChoice: { choice: 'discard' } })
    await expect(api.resetVault({ confirmation: RESET_VAULT_CONFIRMATION })).resolves.toEqual({
      reset: true,
      copy: 'declined',
      vault: freshStatus()
    })
    expect(vault.log).toEqual([`resetVault:${RESET_VAULT_CONFIRMATION}`])
  })

  it('writes the copy before it discards anything', async () => {
    const { api, vault } = harness({
      copyChoice: { choice: 'copy', directory: '/Volumes/backup' },
      copies: 2
    })
    await expect(api.resetVault({ confirmation: RESET_VAULT_CONFIRMATION })).resolves.toEqual({
      reset: true,
      copy: 'saved',
      vault: freshStatus()
    })
    // The order, not just the pair of calls. Reversed, this method would delete a vault and then try
    // to copy the file it had deleted.
    expect(vault.log).toEqual(['copyTo:/Volumes/backup', `resetVault:${RESET_VAULT_CONFIRMATION}`])
  })

  it('discards nothing when the copy wrote no files', async () => {
    /*
      Zero is a failure, not a best-effort success. Discarding after failing to save is the single
      outcome this whole feature exists to prevent, and it is what treating the copy as advisory would
      produce.
    */
    const { api, vault } = harness({
      copyChoice: { choice: 'copy', directory: '/Volumes/backup' },
      copies: 0
    })
    await expect(api.resetVault({ confirmation: RESET_VAULT_CONFIRMATION })).resolves.toEqual({
      reset: false,
      copy: 'failed',
      vault: unlockedStatus()
    })
    expect(vault.log, 'a vault was discarded after nothing was written').toEqual([
      'copyTo:/Volumes/backup'
    ])
  })

  it('discards nothing when the copy could not be written, and logs the reason', async () => {
    const warn = silencedWarnings()
    const { api, vault } = harness({
      copyChoice: { choice: 'copy', directory: '/Volumes/gone' },
      copies: new Error('ENOENT: no such file or directory')
    })
    await expect(api.resetVault({ confirmation: RESET_VAULT_CONFIRMATION })).resolves.toEqual({
      reset: false,
      copy: 'failed',
      vault: unlockedStatus()
    })
    expect(vault.log, 'a vault was discarded after the copy threw').toEqual([
      'copyTo:/Volumes/gone'
    ])
    // Caught and logged rather than returned: a rejected invoke becomes an English sentence from the
    // operating system on a translated page.
    expect(warn, 'the rejection was let out instead of logged').toHaveBeenCalledTimes(1)
  })
})

describe('importing an exported CSV', () => {
  it('names the file it read, because nothing will delete it for the user', () => {
    // The largest exposure this feature creates is not in the vault: it is the plain-text CSV now in
    // somebody's downloads folder. The browser will not remove somebody's file behind their back, so
    // the honest alternative is to say where it is.
    return expect(
      harness({ imported: importReport({ imported: 2 }) }).api.import()
    ).resolves.toEqual({
      outcome: 'imported',
      report: importReport({ imported: 2 }),
      filePath: CSV.path,
      vault: unlockedStatus()
    })
  })

  it('parses the text of the file it was handed', async () => {
    const { api, vault } = harness()
    await api.import()
    expect(vault.importedText).toEqual([CSV.text])
  })

  it('tells a file whose contents were refused apart from one it could not read', async () => {
    // A refused file was read: it arrives as `imported` with a refusal in the report, so the page can
    // say "that was not a password export" rather than "something went wrong".
    const { api } = harness({ imported: importReport({ imported: 0, refusal: 'unknown-columns' }) })
    const answer = await api.import()
    expect(answer.outcome).toBe('imported')
    expect(answer.report?.refusal).toBe('unknown-columns')
  })

  it('reports a closed chooser as cancelled and parses nothing', async () => {
    // Cancelling is not a failure and must not be reported as one; the three outcomes are kept apart
    // precisely because they would be easy to collapse into a single "failed".
    const { api, vault } = harness({ importFile: null })
    await expect(api.import()).resolves.toEqual({ outcome: 'cancelled', vault: unlockedStatus() })
    expect(vault.importedText, 'a cancelled import reached the vault').toEqual([])
  })

  it('reports a file it could not read as unreadable, and logs the reason', async () => {
    const warn = silencedWarnings()
    const { api, vault } = harness({ importFile: new Error('EACCES: permission denied') })
    await expect(api.import()).resolves.toEqual({ outcome: 'unreadable', vault: unlockedStatus() })
    expect(vault.importedText, 'a file that could not be read was parsed anyway').toEqual([])
    // The message names a path the user chose and no credential — the file has not been parsed at this
    // point — and it still stays off the page, for the same reason as the copy's rejection.
    expect(warn, 'the rejection was let out instead of logged').toHaveBeenCalledTimes(1)
  })

  it('reports a locked vault as locked rather than as an import of nothing', async () => {
    // Distinct from a file with no usable rows: one is "unlock and try again", the other is "this file
    // is not what you thought it was".
    const { api } = harness({ status: lockedStatus(), imported: null })
    await expect(api.import()).resolves.toEqual({ outcome: 'locked', vault: lockedStatus() })
  })
})

/**
 * Every operation, with arguments that reach the vault.
 *
 * Compared against the prototype below, so a thirteenth method cannot be added without somebody
 * deciding here what it is allowed to read.
 */
const EVERY_CALL = new Map<string, (api: PasswordApi, into: MasterPasswordHost) => unknown>([
  ['list', (api) => api.list()],
  ['reveal', (api) => api.reveal({ id: 'pw-1' })],
  [
    'create',
    (api) => api.create({ url: 'https://example.com', username: 'alice', password: 'hunter2' })
  ],
  ['update', (api) => api.update({ id: 'pw-1', password: 'hunter3' })],
  ['remove', (api) => api.remove({ id: 'pw-1' })],
  ['forgetNeverSaved', (api) => api.forgetNeverSaved({ origin: 'https://example.com' })],
  ['vaultStatus', (api) => api.vaultStatus()],
  ['requestUnlock', (api) => api.requestUnlock(null)],
  ['lock', (api) => api.lock()],
  ['beginSetMasterPassword', (api, into) => api.beginSetMasterPassword({ intent: 'remove' }, into)],
  ['resetVault', (api) => api.resetVault({ confirmation: RESET_VAULT_CONFIRMATION })],
  ['import', (api) => api.import()]
])

describe('the bound on what an open passwords tab can hold', () => {
  it('offers twelve operations and no thirteenth, so there is no export and no bulk read', () => {
    /*
      The absence is the feature. A page left open on `tessera://passwords` holds a list of sites and
      usernames plus, at most, the one password the user asked to see — and that only holds while no
      call exists that could fill it up in one go.
    */
    const surface = Object.getOwnPropertyNames(PasswordApi.prototype).filter(
      (name) => name !== 'constructor'
    )
    expect(surface.sort()).toEqual([...EVERY_CALL.keys()].sort())
  })

  it('reaches for a password in exactly one of them', async () => {
    for (const [name, invoke] of EVERY_CALL) {
      const { api, vault, host } = harness({
        // No master password, so the two prompt-bound calls answer without raising a question that
        // would never be answered.
        status: unlockedStatus({ protection: 'keystore' }),
        secrets: { 'pw-1': 'hunter2' },
        copyChoice: { choice: 'discard' }
      })
      // Half of these are synchronous; the other half have to settle before the count is read.
      await Promise.resolve(invoke(api, host))
      expect(vault.secretReads, `${name} reached for a secret`).toBe(name === 'reveal' ? 1 : 0)
    }
  })
})
