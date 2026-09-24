import { z } from 'zod'
import type { SameShape } from '../ipc/same-shape.js'
import {
  BACKUP_DOCUMENTS,
  BACKUP_REFUSALS,
  MAX_PASSPHRASE_LENGTH,
  RESTORE_ITEMS,
  VAULT_IN_BACKUP,
  type CreateBackupOutcome,
  type OpenRestoreOutcome,
  type RestoreItem,
  type StageRestoreOutcome
} from './model.js'

/**
 * The backup's wire shapes: the file's header, the archive inside it, the staging manifest, and the
 * four channels of the settings page. The core and the contract read this; the page reads `model.ts`.
 *
 * Every object is strict. A field this build does not know is either a newer format — which the
 * header's `format` answers before this is asked — or somebody's addition, and neither is read.
 */

/** Base64 of at most `bytes` bytes, as text; the decoded length is checked where it matters. */
const base64 = (bytes: number): z.ZodString =>
  z
    .string()
    .max(Math.ceil(bytes / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/)

/** scrypt's parameters as a file states them. Which values are *allowed* is `format.ts`'s question. */
export const scryptParamsSchema = z.strictObject({
  algorithm: z.literal('scrypt'),
  n: z.number().int().positive(),
  r: z.number().int().positive(),
  p: z.number().int().positive(),
  salt: base64(64)
})

/**
 * The header, in the clear and bound as AAD (KTD17): format, app version, the version of every
 * document inside, the KDF's parameters with a fresh salt, and the nonce.
 *
 * `documents` is keyed by any name, not only the ones this build knows: a name it does not know is a
 * document from a newer build, which the restore refuses as newer rather than as damage.
 */
export const backupHeaderSchema = z.strictObject({
  format: z.literal(1),
  appVersion: z.string().min(1).max(64),
  documents: z.record(z.string().min(1).max(64), z.number().int().positive()),
  kdf: scryptParamsSchema,
  iv: base64(12)
})

export type BackupHeader = z.output<typeof backupHeaderSchema>

const vaultInArchiveSchema = z.discriminatedUnion('included', [
  z.strictObject({
    included: z.literal(false),
    reason: z.enum(VAULT_IN_BACKUP).exclude(['included'])
  }),
  z.strictObject({
    included: z.literal(true),
    /** The master password's scrypt, from `passwords.key`; checked against the allowlist too. */
    kdf: scryptParamsSchema,
    /** The key sealed under the master password alone, base64 (R37). */
    sealedKey: z.string().min(1),
    /** `passwords.json` as it was on disk: sealed with the vault key, which nobody here holds. */
    document: z.string().min(1)
  })
])

/**
 * The archive: what the header's ciphertext decrypts and inflates to.
 *
 * `documents` is a strict object over `BACKUP_DOCUMENTS`, so an entry named anything else — the
 * `../local-data.key` a hostile file would try — makes the whole archive unreadable rather than a
 * file somewhere (KTD18). Each document is the decoded JSON the store wrote; the load pipeline checks
 * its shape at the next start, as it does for every file.
 */
export const backupArchiveSchema = z.strictObject({
  format: z.literal(1),
  createdAt: z.number().int().nonnegative(),
  documents: z.strictObject(
    Object.fromEntries(BACKUP_DOCUMENTS.map((name) => [name, z.unknown().optional()])) as Record<
      (typeof BACKUP_DOCUMENTS)[number],
      z.ZodOptional<z.ZodUnknown>
    >
  ),
  vault: vaultInArchiveSchema
})

export type BackupArchive = z.output<typeof backupArchiveSchema>

/**
 * The commit mark of a staged restore, sealed with this profile's codec and written last (KTD18).
 *
 * It names the items staged and nothing else: which file each one replaces comes from the inventory.
 */
export const restoreManifestSchema = z.strictObject({
  format: z.literal(1),
  /** The version that staged it; a newer one is refused and the staging kept. */
  appVersion: z.string().min(1).max(64),
  items: z.array(z.enum(RESTORE_ITEMS as [RestoreItem, ...RestoreItem[]])).max(RESTORE_ITEMS.length)
})

export type RestoreManifest = z.output<typeof restoreManifestSchema>

const passphrase = z.string().max(MAX_PASSPHRASE_LENGTH)
const restoreItem = z.enum(RESTORE_ITEMS as [RestoreItem, ...RestoreItem[]])

const createOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('saved'), vault: z.enum(VAULT_IN_BACKUP) }),
  z.strictObject({ outcome: z.literal('cancelled') }),
  z.strictObject({ outcome: z.literal('refused'), reason: z.literal('passphrase-too-short') }),
  z.strictObject({ outcome: z.literal('failed') })
])

const openOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('preview'),
    preview: z.strictObject({
      token: z.string(),
      createdAt: z.number(),
      appVersion: z.string(),
      items: z.array(restoreItem).readonly(),
      vault: z.enum(VAULT_IN_BACKUP),
      settings: z
        .array(z.strictObject({ key: z.string(), label: z.string(), value: z.string() }))
        .readonly()
    })
  }),
  z.strictObject({ outcome: z.literal('cancelled') }),
  z.strictObject({ outcome: z.literal('refused'), reason: z.enum(BACKUP_REFUSALS) }),
  z.strictObject({ outcome: z.literal('failed') })
])

const stageOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('staged') }),
  z.strictObject({ outcome: z.literal('expired') }),
  z.strictObject({ outcome: z.literal('failed') })
])

const _createWireMatchesModel: SameShape<
  z.output<typeof createOutcomeSchema>,
  CreateBackupOutcome
> = true
const _openWireMatchesModel: SameShape<
  z.output<typeof openOutcomeSchema>,
  OpenRestoreOutcome
> = true
const _stageWireMatchesModel: SameShape<
  z.output<typeof stageOutcomeSchema>,
  StageRestoreOutcome
> = true
void _createWireMatchesModel
void _openWireMatchesModel
void _stageWireMatchesModel

/**
 * The settings page's four channels, spread into `invokeContract` so that file stays under its bar.
 *
 * None carries a path or a file: the core opens both dialogs and reads and writes the file itself,
 * as the importers do. The passphrase crosses once per press and is not kept.
 */
export const backupInvokeContract = {
  'backup:status': {
    request: z.void(),
    response: z.strictObject({ vault: z.enum(VAULT_IN_BACKUP), pendingRestore: z.boolean() })
  },
  'backup:create': {
    request: z.strictObject({ passphrase }),
    response: createOutcomeSchema
  },
  'backup:openRestore': {
    request: z.strictObject({ passphrase }),
    response: openOutcomeSchema
  },
  'backup:stageRestore': {
    request: z.strictObject({
      token: z.string().max(64),
      items: z.array(restoreItem).max(RESTORE_ITEMS.length),
      settings: z.array(z.string().max(64)).max(200)
    }),
    response: stageOutcomeSchema
  }
}
