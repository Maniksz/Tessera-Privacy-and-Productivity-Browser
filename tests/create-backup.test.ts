import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InventoryPath } from '@shared/data/inventory.js'
import { BACKUP_DOCUMENTS } from '@shared/backup/model.js'
import { backupArchiveSchema } from '@shared/backup/schema.js'
import type { SafeStorageLike } from '@main/crypto/local-data-key.js'
import {
  newVaultKey,
  wrapVaultKey,
  writeVaultKeyFile,
  type ScryptCost
} from '@main/crypto/vault-key.js'
import { sealDocument } from '@main/crypto/envelope.js'
import { createEncryptedDocumentCodec } from '@main/data/encrypted-codec.js'
import { BackupService, type BackupServiceDeps } from '@main/backup/backup-service.js'
import { collectBackup, createBackup, vaultInBackup } from '@main/backup/create-backup.js'
import { DOCUMENT_VERSIONS, admitBackup } from '@main/backup/documents.js'
import { openBackup, readBackupHeader } from '@main/backup/format.js'
import type { StagingDeps } from '@main/backup/stage-restore.js'

/**
 * Making a backup (R36, R37): what is read, how, and above all what is never carried.
 *
 * Profiles here are real directories with real encrypted files, so "the documents are opened through
 * the running codec" is shown by the bytes on disk being ciphertext and the archive holding JSON.
 */

const CHEAP: ScryptCost = { n: 16, r: 8, p: 1 }
const PASSPHRASE = 'twelve chars or more'
const MASTER = 'the master password'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

function fakeKeystore(options: { available?: boolean; brand?: string } = {}): SafeStorageLike {
  const available = options.available ?? true
  const brand = Buffer.from(options.brand ?? 'keychain-a', 'utf8')
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
  readonly codec: ReturnType<typeof createEncryptedDocumentCodec>
  readonly safeStorage: SafeStorageLike
  write(name: InventoryPath, document: unknown): Promise<void>
}

async function profile(safeStorage: SafeStorageLike = fakeKeystore()): Promise<Profile> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-create-backup-'))
  dirs.push(dir)
  const codec = createEncryptedDocumentCodec(randomBytes(32))
  const path = (name: InventoryPath): string => join(dir, name)
  return {
    dir,
    path,
    codec,
    safeStorage,
    write: async (name, document) => {
      await writeFile(path(name), await codec.encode(document))
    }
  }
}

/** Everything a profile has on disk, including the files that must never leave it. */
async function fullProfile(): Promise<Profile> {
  const p = await profile()
  await p.write('historyFile', { version: 1, visits: [{ url: 'https://a.example/' }] })
  await p.write('bookmarksFile', { version: 1, nodes: [{ id: 'b1', title: 'A' }] })
  await p.write('quickLinksFile', { version: 1, links: [] })
  await p.write('permissionsFile', { version: 1, sites: {} })
  await p.write('userRulesFile', { version: 1, rules: [] })
  await p.write('workspacesFile', { version: 1, workspaces: [] })
  await p.write('settingsFile', { 'appearance.theme': 'dark', 'network.proxyMode': 'direct' })
  for (const secret of [
    'localDataKeyFile',
    'startupFlagsFile',
    'windowPlacementFile',
    'extensionsFile',
    'pendingClearFile',
    'panicPendingFile',
    'sessionStateFile',
    'tabGroupsFile',
    'downloadsFile'
  ] as const) {
    await writeFile(p.path(secret), `SECRET-${secret}`)
  }
  await mkdir(p.path('faviconCacheDir'))
  await writeFile(join(p.path('faviconCacheDir'), 'icon'), 'SECRET-favicon')
  return p
}

async function withVault(p: Profile, masterPassword: string | null): Promise<Uint8Array> {
  const key = newVaultKey()
  const file = await wrapVaultKey({ key, safeStorage: p.safeStorage, masterPassword, cost: CHEAP })
  await writeVaultKeyFile(p.path('passwordVaultKeyFile'), file)
  const document = sealDocument(key, new TextEncoder().encode('{"version":1,"entries":[]}'))
  await writeFile(p.path('passwordsFile'), document)
  return key
}

describe('what a backup carries', () => {
  it('carries the backup column’s documents as the codec decodes them, and their versions', async () => {
    const p = await fullProfile()
    const onDisk = await readFile(p.path('bookmarksFile'))
    expect(onDisk.toString('utf8')).not.toContain('"title"')

    const collected = await collectBackup(p, 1_000)
    expect(Object.keys(collected.archive.documents).sort()).toEqual([...BACKUP_DOCUMENTS].sort())
    expect(collected.archive.documents.bookmarksFile).toEqual({
      version: 1,
      nodes: [{ id: 'b1', title: 'A' }]
    })
    expect(collected.documents).toEqual({
      historyFile: 1,
      permissionsFile: 1,
      bookmarksFile: 1,
      quickLinksFile: 1,
      settingsFile: 1,
      userRulesFile: 1,
      workspacesFile: 1
    })
    expect(collected.archive).toMatchObject({ format: 1, createdAt: 1_000 })
    expect(backupArchiveSchema.safeParse(collected.archive).success).toBe(true)
  })

  it('never carries the keys, the flags, the placement, the extensions, both notes or the caches', async () => {
    const p = await fullProfile()
    const { bytes } = await createBackup({
      passphrase: PASSPHRASE,
      appVersion: '0.21.0-ALPHA',
      now: 1,
      sources: p,
      cost: CHEAP
    })
    const opened = await openBackup({ bytes, passphrase: PASSPHRASE, allowedCost: CHEAP })
    const text = new TextDecoder().decode(opened.payload)
    expect(text).not.toContain('SECRET-')
    expect(text).toContain('a.example')
  })

  it('leaves out what the profile does not have, and fails on a document with no version', async () => {
    const p = await profile()
    await p.write('bookmarksFile', { version: 1, nodes: [] })
    const collected = await collectBackup(p, 0)
    expect(Object.keys(collected.archive.documents)).toEqual(['bookmarksFile'])
    expect(collected.vault).toBe('no-vault')

    for (const version of [undefined, 0, 1.5, '1']) {
      await p.write('historyFile', { version, visits: [] })
      await expect(collectBackup(p, 0)).rejects.toThrow(/historyFile has no version/)
    }
    await p.write('historyFile', null)
    await expect(collectBackup(p, 0)).rejects.toThrow(/historyFile has no version/)
  })

  it('lets a file it cannot read stop the backup, rather than leaving it out in silence', async () => {
    const p = await profile()
    await mkdir(p.path('bookmarksFile'))
    await expect(collectBackup(p, 0)).rejects.toThrow()
  })

  it('makes two different files of the same data and passphrase', async () => {
    const p = await fullProfile()
    const options = { passphrase: PASSPHRASE, appVersion: '0.21.0-ALPHA', now: 1, sources: p }
    const a = await createBackup({ ...options, cost: CHEAP })
    const b = await createBackup({ ...options, cost: CHEAP })
    const headerA = readBackupHeader(a.bytes, CHEAP)
    const headerB = readBackupHeader(b.bytes, CHEAP)
    expect(headerA.header.kdf.salt).not.toBe(headerB.header.kdf.salt)
    expect(Buffer.from(a.bytes).subarray(headerA.headerEnd)).not.toEqual(
      Buffer.from(b.bytes).subarray(headerB.headerEnd)
    )
  })
})

describe('the vault in a backup (R37)', () => {
  it('stays out without a master password, and says so', async () => {
    const p = await fullProfile()
    await withVault(p, null)
    expect(await vaultInBackup(p)).toBe('no-master-password')
    const collected = await collectBackup(p, 0)
    expect(collected.archive.vault).toEqual({ included: false, reason: 'no-master-password' })
    expect(collected.documents).not.toHaveProperty('passwordsFile')
  })

  it('comes under the master password alone: no key-store layer, the document as ciphertext', async () => {
    const p = await fullProfile()
    await withVault(p, MASTER)
    expect(await vaultInBackup(p)).toBe('included')
    const collected = await collectBackup(p, 0)
    const { vault } = collected.archive
    if (!vault.included) throw new Error('expected the vault')
    expect(vault.kdf).toMatchObject({ algorithm: 'scrypt', n: 16, r: 8, p: 1 })
    // The key store's brand is gone from the key: another machine could never have opened it.
    expect(Buffer.from(vault.sealedKey, 'base64').subarray(0, 5).toString('ascii')).toBe('OBENC')
    expect(
      Buffer.from(vault.document, 'base64').equals(await readFile(p.path('passwordsFile')))
    ).toBe(true)
    expect(collected.documents['passwordsFile']).toBe(DOCUMENT_VERSIONS.passwordsFile)
  })

  it('stays out when the key store cannot take its layer off, or the key file is damaged', async () => {
    const locked = await profile(fakeKeystore())
    await withVault(locked, MASTER)
    const elsewhere = { ...locked, safeStorage: fakeKeystore({ brand: 'keychain-b' }) }
    expect(await vaultInBackup(elsewhere)).toBe('unreadable')

    const damaged = await profile()
    await writeFile(damaged.path('passwordVaultKeyFile'), 'not json')
    expect(await vaultInBackup(damaged)).toBe('unreadable')
  })

  it('stays out when a key was made but nothing was ever saved', async () => {
    const p = await profile()
    await withVault(p, MASTER)
    await rm(p.path('passwordsFile'))
    expect((await collectBackup(p, 0)).vault).toBe('no-vault')
  })
})

describe('the header’s versions, before any key is derived (AE8)', () => {
  const header = (appVersion: string, documents: Record<string, number>) =>
    ({
      format: 1,
      appVersion,
      documents,
      kdf: { algorithm: 'scrypt', n: 16, r: 8, p: 1, salt: '' },
      iv: ''
    }) as const

  it('lets through this version and older ones, with documents this build reads', () => {
    expect(admitBackup(header('0.21.0-ALPHA', { bookmarksFile: 1 }), '0.21.0-ALPHA')).toBeNull()
    expect(admitBackup(header('0.21.0-ALPHA', { workspacesFile: 1 }), '0.21.0-ALPHA')).toBeNull()
    expect(admitBackup(header('0.20.0-ALPHA', {}), '0.21.0-ALPHA')).toBeNull()
  })

  it('refuses a newer app, a newer document, and a document this build does not know', () => {
    expect(admitBackup(header('0.22.0', {}), '0.21.0-ALPHA')).toBe('newer')
    expect(admitBackup(header('0.21.0-ALPHA', { bookmarksFile: 2 }), '0.21.0-ALPHA')).toBe('newer')
    // A document no backup of this build carries; workspaces were the example until U21 carried them.
    expect(admitBackup(header('0.21.0-ALPHA', { tabGroupsFile: 1 }), '0.21.0-ALPHA')).toBe('newer')
    expect(admitBackup(header('0.21.0-ALPHA', { workspacesFile: 2 }), '0.21.0-ALPHA')).toBe('newer')
    expect(admitBackup(header('0.21.0-ALPHA', { toString: 1 }), '0.21.0-ALPHA')).toBe('newer')
    expect(admitBackup(header('not a version', {}), '0.21.0-ALPHA')).toBe('not-a-backup')
  })
})

describe('the create channel', () => {
  async function service(overrides: Partial<BackupServiceDeps> = {}) {
    const p = await fullProfile()
    const written: Array<{ path: string; bytes: Uint8Array }> = []
    const order: string[] = []
    const staging: StagingDeps = {
      path: p.path,
      codec: p.codec,
      appVersion: '0.21.0-ALPHA',
      safeStorage: p.safeStorage
    }
    const deps: BackupServiceDeps = {
      appVersion: '0.21.0-ALPHA',
      sources: p,
      staging,
      flush: () => {
        order.push('flush')
        return Promise.resolve()
      },
      chooseSaveTarget: () => {
        order.push('dialog')
        return Promise.resolve(join(p.dir, 'out.tessera-backup'))
      },
      chooseBackupFile: () => Promise.resolve(null),
      writeBackup: (path, bytes) => {
        order.push('write')
        written.push({ path, bytes })
        return Promise.resolve()
      },
      readBackup: () => Promise.reject(new Error('unused')),
      currentSettings: () => ({}),
      labelOf: (key) => key,
      now: () => 42,
      cost: CHEAP,
      ...overrides
    }
    return { backup: new BackupService(deps), written, order, p }
  }

  it('refuses a passphrase under twelve characters before any dialog opens (Q2)', async () => {
    const { backup, order } = await service()
    expect(await backup.create({ passphrase: 'eleven char' })).toEqual({
      outcome: 'refused',
      reason: 'passphrase-too-short'
    })
    expect(order).toEqual([])
  })

  it('opens the dialog, flushes, then writes what it read — and answers what became of the vault', async () => {
    const { backup, written, order } = await service()
    expect(await backup.create({ passphrase: PASSPHRASE })).toEqual({
      outcome: 'saved',
      vault: 'no-vault'
    })
    expect(order).toEqual(['dialog', 'flush', 'write'])
    const [file] = written
    const opened = await openBackup({
      bytes: file!.bytes,
      passphrase: PASSPHRASE,
      allowedCost: CHEAP
    })
    expect(JSON.parse(new TextDecoder().decode(opened.payload))).toMatchObject({ createdAt: 42 })
  })

  it('writes nothing when the dialog is cancelled', async () => {
    const { backup, order } = await service({ chooseSaveTarget: () => Promise.resolve(null) })
    expect(await backup.create({ passphrase: PASSPHRASE })).toEqual({ outcome: 'cancelled' })
    expect(order).toEqual([])
  })

  it('answers failed, with the cause in the log only, when writing fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { backup } = await service({ writeBackup: () => Promise.reject(new Error('disk full')) })
    expect(await backup.create({ passphrase: PASSPHRASE })).toEqual({ outcome: 'failed' })
    expect(error).toHaveBeenCalledWith('[backup] the backup could not be made:', expect.any(Error))
  })

  it('tells the page before anything is made whether the vault would come, and whether a restore waits', async () => {
    const { backup, p } = await service()
    expect(await backup.status()).toEqual({ vault: 'no-vault', pendingRestore: false })
    await withVault(p, null)
    await writeFile(p.path('restoreManifestFile'), 'x')
    expect(await backup.status()).toEqual({ vault: 'no-master-password', pendingRestore: true })
  })

  it('uses the real clock and cost when none is handed in', async () => {
    const { p } = await service()
    const backup = new BackupService({
      appVersion: '0.21.0-ALPHA',
      sources: p,
      staging: {
        path: p.path,
        codec: p.codec,
        appVersion: '0.21.0-ALPHA',
        safeStorage: p.safeStorage
      },
      flush: () => Promise.resolve(),
      chooseSaveTarget: () => Promise.resolve('x'),
      chooseBackupFile: () => Promise.resolve(null),
      writeBackup: (_path, bytes) => {
        const { header } = readBackupHeader(bytes, { n: 131_072, r: 8, p: 1 })
        expect(header.kdf.n).toBe(131_072)
        return Promise.resolve()
      },
      readBackup: () => Promise.reject(new Error('unused')),
      currentSettings: () => ({}),
      labelOf: (key) => key
    })
    const before = Date.now()
    expect(await backup.create({ passphrase: PASSPHRASE })).toMatchObject({ outcome: 'saved' })
    expect(before).toBeLessThanOrEqual(Date.now())
  }, 20_000)
})
