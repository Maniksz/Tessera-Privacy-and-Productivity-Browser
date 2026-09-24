import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InventoryPath } from '@shared/data/inventory.js'
import type { OpenRestoreOutcome, RestorePreview } from '@shared/backup/model.js'
import type { BackupArchive } from '@shared/backup/schema.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import type { SafeStorageLike } from '@main/crypto/local-data-key.js'
import { openDocument, sealDocument } from '@main/crypto/envelope.js'
import {
  MasterPasswordRequiredError,
  WrongMasterPasswordError,
  newVaultKey,
  openVaultKey,
  readVaultKeyFile,
  wrapVaultKey,
  writeVaultKeyFile,
  type ScryptCost
} from '@main/crypto/vault-key.js'
import { createEncryptedDocumentCodec } from '@main/data/encrypted-codec.js'
import type { DocumentCodec } from '@main/data/JsonStore.js'
import { BookmarkStore } from '@main/data/BookmarkStore.js'
import { HistoryStore } from '@main/data/HistoryStore.js'
import { removeCopiesOf, safetyCopyOf, stagedCopyOf } from '@main/data/quarantine.js'
import { SettingsStore } from '@main/settings/SettingsStore.js'
import { BackupService } from '@main/backup/backup-service.js'
import { createBackup } from '@main/backup/create-backup.js'
import { sealBackup } from '@main/backup/format.js'
import {
  applyStagedRestore,
  itemsOf,
  pendingRestore,
  readArchive,
  settingsForRestore,
  settingsToConfirm,
  stageRestore,
  type StagingDeps
} from '@main/backup/stage-restore.js'

/**
 * Restoring (R38, KTD17, KTD18): refused before anything changes, confirmed, staged, and put in place
 * at the next start in an order a crash cannot break.
 *
 * Two profiles on real disks with *different* codec keys and different key stores, so a restore that
 * copied bytes instead of re-sealing them — or kept the other machine's key-store layer on the vault —
 * fails here the way it would fail on a second computer.
 */

const CHEAP: ScryptCost = { n: 16, r: 8, p: 1 }
const PASSPHRASE = 'twelve chars or more'
const MASTER = 'the master password'
const VERSION = '0.21.0-ALPHA'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function fakeKeystore(brandName: string, available = true): SafeStorageLike {
  const brand = Buffer.from(brandName, 'utf8')
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plainText) => Buffer.concat([brand, Buffer.from(plainText, 'utf8')]),
    decryptString: (encrypted) => {
      if (!brand.equals(encrypted.subarray(0, brand.length))) throw new Error('not this keychain')
      return encrypted.subarray(brand.length).toString('utf8')
    }
  }
}

interface Profile {
  readonly dir: string
  readonly path: (name: InventoryPath) => string
  readonly codec: DocumentCodec
  readonly safeStorage: SafeStorageLike
  readonly staging: StagingDeps
  write(name: InventoryPath, document: unknown): Promise<void>
  read(name: InventoryPath): Promise<unknown>
}

async function profile(brand: string, available = true): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-stage-restore-'))
  dirs.push(dir)
  const codec = createEncryptedDocumentCodec(randomBytes(32))
  const safeStorage = fakeKeystore(brand, available)
  const path = (name: InventoryPath): string => join(dir, name)
  return {
    dir,
    path,
    codec,
    safeStorage,
    staging: { path, codec, appVersion: VERSION, safeStorage, allowedVaultCost: CHEAP },
    write: async (name, document) => {
      await writeFile(path(name), await codec.encode(document))
    },
    read: async (name) => codec.decode(await readFile(path(name)))
  }
}

/** A backup of `from`, and a service on `to` that is handed it by its "open dialog". */
async function restoreInto(from: Profile, to: Profile, current: Record<string, unknown> = {}) {
  const { bytes } = await createBackup({
    passphrase: PASSPHRASE,
    appVersion: VERSION,
    now: 7,
    sources: from,
    cost: CHEAP
  })
  return {
    bytes,
    service: serviceFor(to, () => Promise.resolve(bytes), current)
  }
}

function serviceFor(
  to: Profile,
  readBackup: () => Promise<Uint8Array>,
  current: Record<string, unknown> = {}
): BackupService {
  return new BackupService({
    appVersion: VERSION,
    sources: to,
    staging: to.staging,
    flush: () => Promise.resolve(),
    chooseSaveTarget: () => Promise.resolve(null),
    chooseBackupFile: () => Promise.resolve(join(to.dir, 'chosen.tessera-backup')),
    writeBackup: () => Promise.resolve(),
    readBackup,
    currentSettings: () => current,
    labelOf: (key) => `label of ${key}`,
    newToken: () => 'token-1',
    cost: CHEAP
  })
}

function previewOf(outcome: OpenRestoreOutcome): RestorePreview {
  if (outcome.outcome !== 'preview') throw new Error(`expected a preview, got ${outcome.outcome}`)
  return outcome.preview
}

/** Every file in a profile directory, so "nothing changed" is a listing rather than a hope. */
async function listing(p: Profile): Promise<string[]> {
  return (await readdir(p.dir)).sort()
}

describe('the round trip', () => {
  it('brings back bookmarks, history and settings as they were, through the load pipeline', async () => {
    const a = await profile('keychain-a')
    const bookmarks = await BookmarkStore.open({
      filePath: a.path('bookmarksFile'),
      codec: a.codec
    })
    bookmarks.create({ kind: 'bookmark', title: 'Example', url: 'https://example.com/' })
    await bookmarks.flush()
    const history = await HistoryStore.open({ filePath: a.path('historyFile'), codec: a.codec })
    history.recorderFor('normal').recordVisit({ url: 'https://example.org/page', title: 'Page' })
    await history.flush()
    const settings = await SettingsStore.open(a.path('settingsFile'), a.codec)
    settings.set('appearance.theme', 'dark')
    settings.set('privacy.httpsOnlyMode', false)
    await settings.flush()

    const b = await profile('keychain-b')
    const { service } = await restoreInto(a, b, { ...defaultSettings() })
    const preview = previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    expect(preview).toMatchObject({ token: 'token-1', createdAt: 7, appVersion: VERSION })
    expect(preview.items).toEqual(['historyFile', 'bookmarksFile', 'settingsFile'])
    expect(preview.settings).toEqual([
      { key: 'privacy.httpsOnlyMode', label: 'label of privacy.httpsOnlyMode', value: 'false' }
    ])

    expect(
      await service.stage({
        token: 'token-1',
        items: preview.items,
        settings: ['privacy.httpsOnlyMode']
      })
    ).toEqual({ outcome: 'staged' })
    expect(await pendingRestore(b.path)).toBe(true)

    // The next start: staged documents in place, then the stores open them like any other file.
    expect(await applyStagedRestore(b.staging)).toBe('applied')
    expect(await pendingRestore(b.path)).toBe(false)
    const restoredBookmarks = await BookmarkStore.open({
      filePath: b.path('bookmarksFile'),
      codec: b.codec
    })
    expect(restoredBookmarks.list()).toEqual(bookmarks.list())
    expect(restoredBookmarks.loadReport.outcome.kind).toBe('current')
    const restoredHistory = await HistoryStore.open({
      filePath: b.path('historyFile'),
      codec: b.codec
    })
    expect(restoredHistory.query()).toEqual(history.query())
    const restoredSettings = await SettingsStore.open(b.path('settingsFile'), b.codec)
    expect(restoredSettings.snapshot()).toEqual(settings.snapshot())
    // Sealed again under this profile's codec, not copied: the other key cannot read it.
    const sealedHere = await readFile(b.path('bookmarksFile'))
    expect(() => a.codec.decode(sealedHere)).toThrow(/could not be decrypted/)
  })
})

describe('refused before anything changes', () => {
  it('reports a wrong passphrase as such, and stages nothing', async () => {
    const a = await profile('keychain-a')
    await a.write('bookmarksFile', { version: 1, nodes: [] })
    const b = await profile('keychain-b')
    const { service } = await restoreInto(a, b)
    const before = await listing(b)
    expect(await service.openRestore({ passphrase: 'another long passphrase' })).toEqual({
      outcome: 'refused',
      reason: 'wrong-passphrase-or-damaged'
    })
    expect(
      await service.stage({ token: 'token-1', items: ['bookmarksFile'], settings: [] })
    ).toEqual({ outcome: 'expired' })
    expect(await listing(b)).toEqual(before)
  })

  it('shows nothing and stages nothing for a header with one changed byte', async () => {
    const a = await profile('keychain-a')
    await a.write('bookmarksFile', { version: 1, nodes: [] })
    const b = await profile('keychain-b')
    const { bytes } = await restoreInto(a, b)
    const tampered = Buffer.from(bytes)
    const at = tampered.indexOf('"appVersion"') + 15
    tampered[at] = (tampered[at] ?? 0) ^ 0x01
    const service = serviceFor(b, () => Promise.resolve(tampered))
    const outcome = await service.openRestore({ passphrase: PASSPHRASE })
    expect(outcome.outcome).toBe('refused')
    expect(await listing(b)).toEqual([])
  })

  it('refuses a passphrase under twelve characters before the dialog (Q2)', async () => {
    const b = await profile('keychain-b')
    const chooser = vi.fn(() => Promise.resolve('x'))
    const service = new BackupService({
      ...{
        appVersion: VERSION,
        sources: b,
        staging: b.staging,
        flush: () => Promise.resolve(),
        chooseSaveTarget: () => Promise.resolve(null),
        writeBackup: () => Promise.resolve(),
        readBackup: () => Promise.reject(new Error('unused')),
        currentSettings: () => ({}),
        labelOf: (key: string) => key
      },
      chooseBackupFile: chooser
    })
    expect(await service.openRestore({ passphrase: 'short' })).toEqual({
      outcome: 'refused',
      reason: 'passphrase-too-short'
    })
    expect(chooser).not.toHaveBeenCalled()
  })

  it('refuses a backup with a newer bookmarks schema before staging, and leaves the data (AE8)', async () => {
    const a = await profile('keychain-a')
    await a.write('bookmarksFile', { version: 2, nodes: [] })
    const b = await profile('keychain-b')
    await b.write('bookmarksFile', { version: 1, nodes: [{ id: 'mine' }] })
    const before = await readFile(b.path('bookmarksFile'))
    const { service } = await restoreInto(a, b)
    expect(await service.openRestore({ passphrase: PASSPHRASE })).toEqual({
      outcome: 'refused',
      reason: 'newer'
    })
    expect(await listing(b)).toEqual(['bookmarksFile'])
    expect((await readFile(b.path('bookmarksFile'))).equals(before)).toBe(true)
  })

  it('lets an archive entry named ../local-data.key land nowhere', async () => {
    const b = await profile('keychain-b')
    await writeFile(join(b.dir, 'local-data.key'), 'the real key')
    const hostile = {
      format: 1,
      createdAt: 0,
      documents: { '../local-data.key': 'attacker key', bookmarksFile: { version: 1, nodes: [] } },
      vault: { included: false, reason: 'no-vault' }
    }
    const bytes = await sealBackup({
      passphrase: PASSPHRASE,
      appVersion: VERSION,
      documents: { bookmarksFile: 1 },
      payload: new TextEncoder().encode(JSON.stringify(hostile)),
      cost: CHEAP
    })
    const service = serviceFor(b, () => Promise.resolve(bytes))
    expect(await service.openRestore({ passphrase: PASSPHRASE })).toEqual({
      outcome: 'refused',
      reason: 'not-a-backup'
    })
    expect(await readFile(join(b.dir, 'local-data.key'), 'utf8')).toBe('the real key')
    expect(await listing(b)).toEqual(['local-data.key'])
  })

  it('answers failed when the chosen file cannot be read, and cancelled when none was chosen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const b = await profile('keychain-b')
    const unreadable = serviceFor(b, () => Promise.reject(new Error('EACCES')))
    expect(await unreadable.openRestore({ passphrase: PASSPHRASE })).toEqual({ outcome: 'failed' })
    const cancelled = new BackupService({
      appVersion: VERSION,
      sources: b,
      staging: b.staging,
      flush: () => Promise.resolve(),
      chooseSaveTarget: () => Promise.resolve(null),
      chooseBackupFile: () => Promise.resolve(null),
      writeBackup: () => Promise.resolve(),
      readBackup: () => Promise.reject(new Error('unused')),
      currentSettings: () => ({}),
      labelOf: (key) => key
    })
    expect(await cancelled.openRestore({ passphrase: PASSPHRASE })).toEqual({
      outcome: 'cancelled'
    })
  })
})

describe('the restore channels at the real cost', () => {
  it('opens a backup sealed at the shipped cost, with a token nobody can guess', async () => {
    const a = await profile('keychain-a')
    await a.write('bookmarksFile', { version: 1, nodes: [] })
    const { bytes } = await createBackup({
      passphrase: PASSPHRASE,
      appVersion: VERSION,
      now: 1,
      sources: a
    })
    const b = await profile('keychain-b')
    const service = new BackupService({
      appVersion: VERSION,
      sources: b,
      // No `allowedVaultCost`: the vault's own cost is the allowlist, as in the application.
      staging: { path: b.path, codec: b.codec, appVersion: VERSION, safeStorage: b.safeStorage },
      flush: () => Promise.resolve(),
      chooseSaveTarget: () => Promise.resolve(null),
      chooseBackupFile: () => Promise.resolve('chosen'),
      writeBackup: () => Promise.resolve(),
      readBackup: () => Promise.resolve(bytes),
      currentSettings: () => ({}),
      labelOf: (key) => key
    })
    const preview = previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    expect(preview.token).toMatch(/^[0-9a-f]{32}$/)
    expect(await service.stage({ ...preview, settings: [] })).toEqual({ outcome: 'staged' })
    expect(await service.stage({ ...preview, settings: [] })).toEqual({ outcome: 'expired' })
  }, 20_000)
})

describe('reading the archive', () => {
  const archive = (
    documents: Record<string, unknown>,
    vault: unknown = { included: false, reason: 'no-vault' }
  ) => new TextEncoder().encode(JSON.stringify({ format: 1, createdAt: 0, documents, vault }))

  it('refuses what is not JSON, not the shape, or a document with no version', () => {
    expect(() => readArchive(new TextEncoder().encode('{'))).toThrow(/not-a-backup/)
    expect(() => readArchive(archive({}, { included: 'yes' }))).toThrow(/not-a-backup/)
    expect(() => readArchive(archive({ historyFile: { visits: [] } }))).toThrow(/not-a-backup/)
    expect(() => readArchive(archive({ historyFile: null }))).toThrow(/not-a-backup/)
  })

  it('refuses a document newer than this build, whatever the header said (AE8)', () => {
    expect(() => readArchive(archive({ bookmarksFile: { version: 2 } }))).toThrow(/newer/)
  })

  it('takes settings without a version, and reports what it holds in order', () => {
    const read = readArchive(
      archive({ settingsFile: { 'appearance.theme': 'dark' }, historyFile: { version: 1 } })
    )
    expect(itemsOf(read)).toEqual(['historyFile', 'settingsFile'])
  })

  it('refuses a vault whose scrypt is not the vault’s own, or whose parts are not sealed', () => {
    const sealed = Buffer.from(sealDocument(randomBytes(32), randomBytes(8))).toString('base64')
    const salt = randomBytes(16).toString('base64')
    const vault = (overrides: Record<string, unknown>) => ({
      included: true,
      kdf: { algorithm: 'scrypt', ...CHEAP, salt },
      sealedKey: sealed,
      document: sealed,
      ...overrides
    })
    expect(itemsOf(readArchive(archive({}, vault({})), CHEAP))).toEqual(['vault'])
    // The default allowlist is the vault's real cost, which this one is not.
    expect(() => readArchive(archive({}, vault({})))).toThrow(/not-a-backup/)
    for (const bad of [
      { kdf: { algorithm: 'scrypt', n: 2 ** 30, r: 8, p: 1, salt } },
      { kdf: { algorithm: 'scrypt', n: 16, r: 9, p: 1, salt } },
      { kdf: { algorithm: 'scrypt', n: 16, r: 8, p: 2, salt } },
      { kdf: { algorithm: 'scrypt', ...CHEAP, salt: 'AAAA' } },
      { sealedKey: 'AAAA' },
      { document: 'AAAA' }
    ]) {
      expect(() => readArchive(archive({}, vault(bad)), CHEAP)).toThrow(/not-a-backup/)
    }
  })
})

describe('what the person confirms', () => {
  const withSettings = (settings: unknown): BackupArchive => ({
    format: 1,
    createdAt: 0,
    documents: { settingsFile: settings },
    vault: { included: false, reason: 'no-vault' }
  })

  it('lists the security-relevant settings that differ, with their values, and nothing else', () => {
    const current = { ...defaultSettings() }
    const archive = withSettings({
      ...current,
      'network.proxyMode': 'manual',
      'network.proxyUrl': 'socks5://proxy.example:1080',
      'appearance.theme': 'dark',
      'unknown.key': true
    })
    expect(settingsToConfirm(archive, current, (key) => key)).toEqual([
      { key: 'network.proxyMode', label: 'network.proxyMode', value: '"manual"' },
      {
        key: 'network.proxyUrl',
        label: 'network.proxyUrl',
        value: '"socks5://proxy.example:1080"'
      }
    ])
    expect(settingsToConfirm(withSettings(['not', 'an', 'object']), current, (k) => k)).toEqual([])
    expect(settingsToConfirm(withSettings(undefined), current, (k) => k)).toEqual([])
  })

  it('takes out every unconfirmed security setting, and every key this build does not know', () => {
    const staged = settingsForRestore(
      {
        'network.proxyMode': 'manual',
        'network.killSwitch': false,
        'appearance.theme': 'dark',
        'unknown.key': 1
      },
      ['network.killSwitch']
    )
    expect(staged).toEqual({ 'network.killSwitch': false, 'appearance.theme': 'dark' })
  })

  it('keeps the proxy in force when the backup’s proxy is not confirmed', async () => {
    const a = await profile('keychain-a')
    await a.write('settingsFile', {
      'network.proxyMode': 'manual',
      'network.proxyUrl': 'socks5://proxy.example:1080',
      'privacy.httpsOnlyMode': false,
      'appearance.theme': 'dark'
    })
    const b = await profile('keychain-b')
    await b.write('settingsFile', { 'network.proxyMode': 'direct', 'privacy.httpsOnlyMode': true })
    const { service } = await restoreInto(a, b, { ...defaultSettings() })
    const preview = previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    expect(preview.settings.map((setting) => setting.key)).toEqual([
      'privacy.httpsOnlyMode',
      'network.proxyMode',
      'network.proxyUrl'
    ])
    await service.stage({ token: 'token-1', items: ['settingsFile'], settings: [] })
    expect(await applyStagedRestore(b.staging)).toBe('applied')
    const restored = await SettingsStore.open(b.path('settingsFile'), b.codec)
    expect(restored.get('network.proxyMode')).toBe('direct')
    expect(restored.get('network.proxyUrl')).toBe('')
    expect(restored.get('privacy.httpsOnlyMode')).toBe(true)
    expect(restored.get('appearance.theme')).toBe('dark')
  })

  it('takes the proxy over once it is confirmed', async () => {
    const a = await profile('keychain-a')
    await a.write('settingsFile', {
      'network.proxyMode': 'manual',
      'network.proxyUrl': 'socks5://proxy.example:1080'
    })
    const b = await profile('keychain-b')
    const { service } = await restoreInto(a, b, { ...defaultSettings() })
    previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    await service.stage({
      token: 'token-1',
      items: ['settingsFile'],
      settings: ['network.proxyMode', 'network.proxyUrl']
    })
    await applyStagedRestore(b.staging)
    expect(await b.read('settingsFile')).toEqual({
      'network.proxyMode': 'manual',
      'network.proxyUrl': 'socks5://proxy.example:1080'
    })
  })

  it('stages permissions and filter rules only when they are chosen', async () => {
    const a = await profile('keychain-a')
    await a.write('permissionsFile', { version: 1, sites: { 'https://a.example': 'allow' } })
    await a.write('userRulesFile', { version: 1, rules: [] })
    await a.write('bookmarksFile', { version: 1, nodes: [] })
    const b = await profile('keychain-b')
    const { service } = await restoreInto(a, b)
    const preview = previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    expect(preview.items).toEqual(['permissionsFile', 'bookmarksFile', 'userRulesFile'])
    await service.stage({ token: 'token-1', items: ['bookmarksFile', 'vault'], settings: [] })
    await applyStagedRestore(b.staging)
    expect(await listing(b)).toEqual(['bookmarksFile'])
  })
})

describe('the vault (R37, KTD17)', () => {
  async function vaultProfile(masterPassword: string | null) {
    const a = await profile('keychain-a')
    const key = newVaultKey()
    const file = await wrapVaultKey({
      key,
      safeStorage: a.safeStorage,
      masterPassword,
      cost: CHEAP
    })
    await writeVaultKeyFile(a.path('passwordVaultKeyFile'), file)
    const plaintext = '{"version":1,"entries":[{"id":"e1"}]}'
    await writeFile(a.path('passwordsFile'), sealDocument(key, new TextEncoder().encode(plaintext)))
    return { a, key, plaintext }
  }

  it('comes along with a master password, wears this machine’s key store, and opens only with it', async () => {
    const { a, key, plaintext } = await vaultProfile(MASTER)
    const b = await profile('keychain-b')
    const { service } = await restoreInto(a, b)
    const preview = previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    expect(preview.vault).toBe('included')
    expect(preview.items).toEqual(['vault'])
    await service.stage({ token: 'token-1', items: ['vault'], settings: [] })
    expect(await applyStagedRestore(b.staging)).toBe('applied')

    const restored = await readVaultKeyFile(b.path('passwordVaultKeyFile'))
    if (restored === null) throw new Error('no key file')
    expect(restored.keystore).toBe(true)
    expect(Buffer.from(restored.payload, 'base64').subarray(0, 10).toString('utf8')).toBe(
      'keychain-b'
    )
    const open = (masterPassword: string | null, safeStorage = b.safeStorage) =>
      openVaultKey({ file: restored, safeStorage, masterPassword })
    await expect(open(null)).rejects.toBeInstanceOf(MasterPasswordRequiredError)
    await expect(open('not the master password')).rejects.toBeInstanceOf(WrongMasterPasswordError)
    await expect(open(MASTER, a.safeStorage)).rejects.toThrow(/key store/)
    const opened = await open(MASTER)
    expect(Buffer.from(opened).equals(Buffer.from(key))).toBe(true)
    const document = openDocument(opened, await readFile(b.path('passwordsFile')))
    expect(new TextDecoder().decode(document)).toBe(plaintext)
  })

  it('stays behind the master password alone where this machine has no key store', async () => {
    const { a } = await vaultProfile(MASTER)
    const b = await profile('keychain-b', false)
    const { service } = await restoreInto(a, b)
    previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    await service.stage({ token: 'token-1', items: ['vault'], settings: [] })
    await applyStagedRestore(b.staging)
    const restored = await readVaultKeyFile(b.path('passwordVaultKeyFile'))
    expect(restored?.keystore).toBe(false)
    await expect(
      openVaultKey({ file: restored!, safeStorage: b.safeStorage, masterPassword: null })
    ).rejects.toBeInstanceOf(MasterPasswordRequiredError)
  })

  it('sends its key back when the document cannot move, so this start opens the old pair', async () => {
    const { a } = await vaultProfile(MASTER)
    const b = await profile('keychain-b')
    const oldKey = Buffer.from('{"the":"old key"}')
    const oldDocument = Buffer.from('the old document')
    await writeFile(b.path('passwordVaultKeyFile'), oldKey)
    await writeFile(b.path('passwordsFile'), oldDocument)
    const { service } = await restoreInto(a, b)
    previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    await service.stage({ token: 'token-1', items: ['vault'], settings: [] })
    const stagedKey = await readFile(stagedCopyOf(b.path('passwordVaultKeyFile')))
    const stagedDocument = await readFile(stagedCopyOf(b.path('passwordsFile')))

    // The key has moved; the document's safety copy then cannot be written — a full disk, say.
    await mkdir(safetyCopyOf(b.path('passwordsFile')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await applyStagedRestore(b.staging)).toBe('kept')
    expect(warn).toHaveBeenCalled()
    expect(await readFile(b.path('passwordVaultKeyFile'))).toEqual(oldKey)
    expect(await readFile(b.path('passwordsFile'))).toEqual(oldDocument)
    expect(await readFile(stagedCopyOf(b.path('passwordVaultKeyFile')))).toEqual(stagedKey)
    expect(await pendingRestore(b.path)).toBe(true)

    // The next start moves both, with the old key in its safety copy.
    await rm(safetyCopyOf(b.path('passwordsFile')), { recursive: true })
    expect(await applyStagedRestore(b.staging)).toBe('applied')
    expect(await readFile(b.path('passwordVaultKeyFile'))).toEqual(stagedKey)
    expect(await readFile(b.path('passwordsFile'))).toEqual(stagedDocument)
    expect(await readFile(safetyCopyOf(b.path('passwordVaultKeyFile')))).toEqual(oldKey)
    expect(await readFile(safetyCopyOf(b.path('passwordsFile')))).toEqual(oldDocument)
  })

  it('stages again a key it placed where there was none, so no key is left without its document', async () => {
    const { a } = await vaultProfile(MASTER)
    const b = await profile('keychain-b')
    await writeFile(b.path('passwordsFile'), 'the old document')
    const { service } = await restoreInto(a, b)
    previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    await service.stage({ token: 'token-1', items: ['vault'], settings: [] })
    const stagedKey = await readFile(stagedCopyOf(b.path('passwordVaultKeyFile')))

    await mkdir(safetyCopyOf(b.path('passwordsFile')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await applyStagedRestore(b.staging)).toBe('kept')
    await expect(readFile(b.path('passwordVaultKeyFile'))).rejects.toThrow()
    expect(await readFile(stagedCopyOf(b.path('passwordVaultKeyFile')))).toEqual(stagedKey)
  })

  it('leaves alone a key an earlier start moved, which the crash note covers', async () => {
    const { a } = await vaultProfile(MASTER)
    const b = await profile('keychain-b')
    await writeFile(b.path('passwordsFile'), 'the old document')
    const { service } = await restoreInto(a, b)
    previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    await service.stage({ token: 'token-1', items: ['vault'], settings: [] })
    const key = b.path('passwordVaultKeyFile')
    const stagedKey = await readFile(stagedCopyOf(key))
    // A start that crashed right after the key's move.
    await rename(stagedCopyOf(key), key)

    await mkdir(safetyCopyOf(b.path('passwordsFile')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await applyStagedRestore(b.staging)).toBe('kept')
    expect(await readFile(key)).toEqual(stagedKey)
  })

  it('is not in the archive without a master password, and the preview says why', async () => {
    const { a } = await vaultProfile(null)
    await a.write('bookmarksFile', { version: 1, nodes: [] })
    const b = await profile('keychain-b')
    const { service } = await restoreInto(a, b)
    const preview = previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    expect(preview.vault).toBe('no-master-password')
    expect(preview.items).toEqual(['bookmarksFile'])
  })
})

describe('staging', () => {
  async function staged(items: BackupArchive['documents'], choice = Object.keys(items)) {
    const b = await profile('keychain-b')
    const archive: BackupArchive = {
      format: 1,
      createdAt: 0,
      documents: items,
      vault: { included: false, reason: 'no-vault' }
    }
    const result = await stageRestore(archive, { items: choice as never, settings: [] }, b.staging)
    return { b, result }
  }

  it('writes each staged copy beside its file, sealed with this profile’s codec, and the manifest last', async () => {
    const { b, result } = await staged({ bookmarksFile: { version: 1, nodes: [] } })
    expect(result).toEqual(['bookmarksFile'])
    expect(await listing(b)).toEqual(['bookmarksFile.restore', 'restoreManifestFile'])
    expect(await b.codec.decode(await readFile(stagedCopyOf(b.path('bookmarksFile'))))).toEqual({
      version: 1,
      nodes: []
    })
    expect(await b.read('restoreManifestFile')).toEqual({
      format: 1,
      appVersion: VERSION,
      items: ['bookmarksFile']
    })
  })

  it('clears an earlier staging before it starts, so two can never mix', async () => {
    const { b } = await staged({ historyFile: { version: 1, visits: [] } })
    await stageRestore(
      {
        format: 1,
        createdAt: 0,
        documents: { bookmarksFile: { version: 1, nodes: [] } },
        vault: { included: false, reason: 'no-vault' }
      },
      { items: ['bookmarksFile'], settings: [] },
      b.staging
    )
    expect(await listing(b)).toEqual(['bookmarksFile.restore', 'restoreManifestFile'])
  })

  it('answers failed, and leaves no manifest, when a staged copy cannot be written', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await profile('keychain-a')
    await a.write('bookmarksFile', { version: 1, nodes: [] })
    const b = await profile('keychain-b')
    const { service } = await restoreInto(a, b)
    previewOf(await service.openRestore({ passphrase: PASSPHRASE }))
    await rm(b.dir, { recursive: true })
    await writeFile(b.dir, 'not a directory')
    expect(
      await service.stage({ token: 'token-1', items: ['bookmarksFile'], settings: [] })
    ).toEqual({
      outcome: 'failed'
    })
    await rm(b.dir)
    dirs.splice(dirs.indexOf(b.dir), 1)
  })

  it('stages nothing for an item the backup does not have', async () => {
    const { b, result } = await staged({ bookmarksFile: { version: 1, nodes: [] } }, [
      'historyFile',
      'vault'
    ])
    expect(result).toEqual([])
    expect(await listing(b)).toEqual(['restoreManifestFile'])
  })
})

describe('applying at the next start', () => {
  async function stagedProfile() {
    const b = await profile('keychain-b')
    await b.write('bookmarksFile', { version: 1, nodes: [{ id: 'before' }] })
    await b.write('settingsFile', { 'appearance.theme': 'light', 'network.proxyMode': 'system' })
    await stageRestore(
      {
        format: 1,
        createdAt: 0,
        documents: {
          bookmarksFile: { version: 1, nodes: [{ id: 'restored' }] },
          historyFile: { version: 1, visits: [] },
          settingsFile: { 'appearance.theme': 'dark' }
        },
        vault: { included: false, reason: 'no-vault' }
      },
      { items: ['historyFile', 'bookmarksFile', 'settingsFile'], settings: [] },
      b.staging
    )
    return b
  }

  it('keeps everything when the manifest cannot even be read', async () => {
    const b = await profile('keychain-b')
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await mkdir(b.path('restoreManifestFile'))
    await expect(pendingRestore(b.path)).rejects.toThrow()
    expect(await applyStagedRestore(b.staging)).toBe('kept')
  })

  it('does nothing when nothing is staged', async () => {
    const b = await profile('keychain-b')
    expect(await applyStagedRestore(b.staging)).toBe('none')
  })

  it('makes a safety copy of what each file holds when it is applied, not when it was asked for', async () => {
    const b = await stagedProfile()
    // A change between the request and the restart: the quit's own flush, say.
    await b.write('bookmarksFile', { version: 1, nodes: [{ id: 'changed since' }] })
    expect(await applyStagedRestore(b.staging)).toBe('applied')
    expect(await b.codec.decode(await readFile(safetyCopyOf(b.path('bookmarksFile'))))).toEqual({
      version: 1,
      nodes: [{ id: 'changed since' }]
    })
    expect(await b.read('bookmarksFile')).toEqual({ version: 1, nodes: [{ id: 'restored' }] })
    expect(await b.read('settingsFile')).toEqual({
      'appearance.theme': 'dark',
      'network.proxyMode': 'system'
    })
    // No safety copy for a file that was not there.
    expect(await listing(b)).toEqual([
      'bookmarksFile',
      'bookmarksFile.before-restore',
      'historyFile',
      'settingsFile',
      'settingsFile.before-restore'
    ])
  })

  it('discards a staging without its manifest — a crash while staging — and applies none of it', async () => {
    const b = await stagedProfile()
    await rm(b.path('restoreManifestFile'))
    const before = await b.read('bookmarksFile')
    expect(await applyStagedRestore(b.staging)).toBe('discarded')
    expect(await b.read('bookmarksFile')).toEqual(before)
    expect(await listing(b)).toEqual(['bookmarksFile', 'settingsFile'])
  })

  it('keeps a staging without its manifest when a staged copy cannot be removed', async () => {
    const b = await stagedProfile()
    await rm(b.path('restoreManifestFile'))
    // Not a file at all: nothing the discard may take away without looking, so the start keeps it.
    await rm(stagedCopyOf(b.path('historyFile')), { force: true })
    await mkdir(stagedCopyOf(b.path('historyFile')))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await applyStagedRestore(b.staging)).toBe('kept')
  })

  it('applies a staging a crashed run left behind, at the next start', async () => {
    const b = await stagedProfile()
    // Nothing between the staging and this start: the run that staged it simply never quit cleanly.
    expect(await applyStagedRestore(b.staging)).toBe('applied')
    expect(await b.read('historyFile')).toEqual({ version: 1, visits: [] })
  })

  it('finishes an apply that stopped halfway, and keeps the first safety copy', async () => {
    const b = await stagedProfile()
    const original = await b.read('bookmarksFile')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failSettings = true
    const flaky: DocumentCodec = {
      encode: (data) => b.codec.encode(data),
      decode: (bytes) => {
        const decoded = b.codec.decode(bytes)
        // The manifest is decoded first; the settings merge is where this run stops.
        return Promise.resolve(decoded).then((value) => {
          if (
            failSettings &&
            typeof value === 'object' &&
            value !== null &&
            'network.proxyMode' in value
          ) {
            throw new Error('power cut')
          }
          return value
        })
      }
    }
    expect(await applyStagedRestore({ ...b.staging, codec: flaky })).toBe('kept')
    expect(warn).toHaveBeenCalled()
    expect(await b.read('bookmarksFile')).toEqual({ version: 1, nodes: [{ id: 'restored' }] })
    expect(await pendingRestore(b.path)).toBe(true)

    failSettings = false
    expect(await applyStagedRestore(b.staging)).toBe('applied')
    expect(await b.read('settingsFile')).toEqual({
      'appearance.theme': 'dark',
      'network.proxyMode': 'system'
    })
    expect(await b.codec.decode(await readFile(safetyCopyOf(b.path('bookmarksFile'))))).toEqual(
      original
    )
    expect(await pendingRestore(b.path)).toBe(false)
  })

  it('lays the same settings over the same file when applied again after the merge', async () => {
    const b = await stagedProfile()
    // A crash after the merged settings were written into the staged copy, before the move.
    const merged = { 'appearance.theme': 'dark', 'network.proxyMode': 'system' }
    await writeFile(stagedCopyOf(b.path('settingsFile')), await b.codec.encode(merged))
    await applyStagedRestore(b.staging)
    expect(await b.read('settingsFile')).toEqual(merged)
  })

  it('refuses a manifest from a newer version and keeps the staging', async () => {
    const b = await stagedProfile()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await b.write('restoreManifestFile', {
      format: 1,
      appVersion: '9.0.0',
      items: ['bookmarksFile']
    })
    expect(await applyStagedRestore(b.staging)).toBe('kept')
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/newer version/))
    expect(await b.read('bookmarksFile')).toEqual({ version: 1, nodes: [{ id: 'before' }] })
    expect(await listing(b)).toContain('bookmarksFile.restore')
  })

  it('keeps a manifest it cannot read, or cannot decrypt', async () => {
    const b = await stagedProfile()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await b.write('restoreManifestFile', { format: 2 })
    expect(await applyStagedRestore(b.staging)).toBe('kept')
    const other = createEncryptedDocumentCodec(randomBytes(32))
    await writeFile(b.path('restoreManifestFile'), await other.encode({ format: 1 }))
    expect(await applyStagedRestore(b.staging)).toBe('kept')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(await listing(b)).toContain('bookmarksFile.restore')
  })

  it('restores settings where there were none, and over a file that is not an object', async () => {
    const b = await profile('keychain-b')
    const archive: BackupArchive = {
      format: 1,
      createdAt: 0,
      documents: { settingsFile: { 'appearance.theme': 'dark' } },
      vault: { included: false, reason: 'no-vault' }
    }
    await stageRestore(archive, { items: ['settingsFile'], settings: [] }, b.staging)
    await applyStagedRestore(b.staging)
    expect(await b.read('settingsFile')).toEqual({ 'appearance.theme': 'dark' })

    await b.write('settingsFile', [1, 2])
    await stageRestore(archive, { items: ['settingsFile'], settings: [] }, b.staging)
    await applyStagedRestore(b.staging)
    expect(await b.read('settingsFile')).toEqual({ 'appearance.theme': 'dark' })
  })

  it('does not bring back a history cleared after the restore was asked for', async () => {
    const b = await stagedProfile()
    // What clearing history now, on exit and in panic all do to a file: take its copies.
    await removeCopiesOf(b.path('historyFile'))
    expect(await applyStagedRestore(b.staging)).toBe('applied')
    expect(await listing(b)).not.toContain('historyFile')
    expect(await b.read('bookmarksFile')).toEqual({ version: 1, nodes: [{ id: 'restored' }] })
  })

  it('lets the clearing take the safety copies too', async () => {
    const b = await stagedProfile()
    await applyStagedRestore(b.staging)
    await removeCopiesOf(b.path('bookmarksFile'))
    expect(await listing(b)).not.toContain('bookmarksFile.before-restore')
  })
})
