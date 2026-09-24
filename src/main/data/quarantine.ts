import { readFile, readdir, rm } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import {
  removeMatching,
  removeTempFilesOf,
  writeFileAtomically,
  type AtomicFileSystem,
  type AtomicWriteOptions
} from './atomic-write.js'

/**
 * The copies a store keeps of a file before it replaces it, and their removal.
 *
 * Two kinds, both beside the file they preserve:
 *
 *   - `<file>.unreadable`, `<file>.unreadable.1`, … — a file this build could not use at all, set aside
 *     before defaults replace it. Taken out of `SettingsStore`, where it was the only protection any
 *     store had; `JsonStore` now does the same for the dozen others.
 *   - `<file>.v<N>.bak` — the version-`N` original, kept before a migration writes the upgraded
 *     document over it. A migration can be valid and still wrong, and this is the way back.
 *
 * ## Never over an existing copy
 *
 * A copy is only ever written under a name that is not taken, which is the `wx` rule the settings
 * quarantine always had: the file already there is the older one, and the older one is the one with
 * the data the user actually had. Every write goes through `atomic-write.ts`, so a crash mid-copy
 * leaves no half-copy under the name either.
 *
 * The name is chosen from a listing of the directory, not by the rename refusing, because the rename
 * cannot refuse: it replaces. Two writers racing for one name would need two processes on one profile,
 * which the single-instance lock rules out before any store opens.
 *
 * ## Belonging to the data
 *
 * A copy holds the same data as the file it preserves, so it goes when that data goes:
 * `removeCopiesOf` runs in the deletion paths — clearing history, clearing the download list,
 * resetting the vault. A "delete my history" that left last month's history in a `.v1.bak` would be a
 * promise broken by a file the user never knew existed.
 */

/**
 * As much of `node:fs/promises` as this module uses itself, plus what its copies are written through.
 *
 * The writing is `atomic-write.ts`'s and nobody else's — this module never opens or renames a file —
 * so its file system is a separate, optional member rather than methods here. A test that needs a copy
 * to fail hands in a `writer` whose `open` fails.
 */
export interface CopyFileSystem {
  readFile(path: string): Promise<Uint8Array>
  readdir(path: string): Promise<string[]>
  rm(path: string, options: { force: true }): Promise<void>
  /** What the copies are written, and their temporaries removed, through. Absent: the real one. */
  readonly writer?: AtomicFileSystem
}

const nodeFileSystem: CopyFileSystem = { readFile, readdir, rm }

export interface CopyOptions {
  /**
   * What to preserve. Absent means "the file as it is on disk now", which is what the settings store
   * wants; `JsonStore` passes the bytes it already read, so the copy is the file it decided about and
   * not whatever might have replaced it since.
   */
  readonly bytes?: Uint8Array
  readonly fs?: CopyFileSystem
}

/**
 * Sets an unreadable file's contents aside and answers where they went.
 *
 * A copy already there with the same contents is answered instead of a new one. Without that, a file
 * that stays broken across starts — the store could not write, or it is read-only — would add one
 * identical copy per launch, and the one worth having would drown among them.
 *
 * Rejects when no copy could be made. What that means is the caller's decision: `SettingsStore` then
 * refuses to start, `JsonStore` then refuses to write.
 */
export async function quarantineCopy(filePath: string, options: CopyOptions = {}): Promise<string> {
  const fs = options.fs ?? nodeFileSystem
  const content = options.bytes ?? (await fs.readFile(filePath))
  const taken = await namesIn(dirname(filePath), fs)
  for (let attempt = 0; ; attempt += 1) {
    const target = attempt === 0 ? `${filePath}.unreadable` : `${filePath}.unreadable.${attempt}`
    if (!taken.has(basename(target))) {
      await writeFileAtomically(target, content, writeOptions(fs))
      return target
    }
    if (sameBytes(await fs.readFile(target), content)) return target
    // Taken by an earlier quarantine of something else; try the next name.
  }
}

/** Where the version-`version` original of `filePath` is kept. */
export function backupPathOf(filePath: string, version: number): string {
  return `${filePath}.v${version}.bak`
}

/**
 * Where a restore stages the document that will replace `filePath` at the next start (U23, KTD18).
 *
 * Beside the file, as a copy of it, rather than in a folder of its own: then every way the data goes
 * reaches it without knowing about restores — clearing history now, on exit, panic, the catch-up and a
 * vault reset all remove a file's copies — and a pending restore of a history the user just cleared
 * cannot bring it back at the next start. The name comes from the inventory's path, never from the
 * archive, and the move into place is a rename within one directory.
 */
export function stagedCopyOf(filePath: string): string {
  return `${filePath}.restore`
}

/**
 * What `filePath` held before a restore replaced it: the safety copy (R38), made when the restore is
 * applied rather than when it was asked for, so what changed in between is in it. A copy like the
 * others here, and it goes with the data as they do.
 */
export function safetyCopyOf(filePath: string): string {
  return `${filePath}.before-restore`
}

/**
 * Keeps the version-`version` original before a migration replaces it, and answers where.
 *
 * At most one per version, and the first one wins: a backup already there is answered as it is. It is
 * the file from before the *first* migration off that version, and a second run of the same migration
 * — after the upgraded file was restored from it, say — must not replace it with something newer.
 */
export async function backupBeforeMigration(
  filePath: string,
  version: number,
  bytes: Uint8Array,
  fs: CopyFileSystem = nodeFileSystem
): Promise<string> {
  const target = backupPathOf(filePath, version)
  const taken = await namesIn(dirname(filePath), fs)
  if (!taken.has(basename(target))) await writeFileAtomically(target, bytes, writeOptions(fs))
  return target
}

/**
 * The name of every copy this module makes of `filePath`, and of the temporaries writing one leaves.
 *
 * `<name>.unreadable`, `<name>.unreadable.<n>`, `<name>.v<n>.bak`, `<name>.restore`,
 * `<name>.before-restore`, each optionally followed by the `.<pid>-<hex>.tmp` the atomic writer uses
 * while it is being written.
 */
const COPY_SUFFIX =
  /^(?:unreadable(?:\.\d+)?|v\d+\.bak|restore|before-restore)(?:\.\d+-[0-9a-f]+\.tmp)?$/

/**
 * Removes every copy of `filePath` and every temporary beside it — everything of that data that is
 * not the file itself.
 *
 * Must not run while a write to the same file is in flight, for the reason `removeTempFilesOf` gives;
 * `JsonStore.discardCopies` queues it behind the store's own writes for that reason. Failures are let
 * out: a caller about to report "deleted" must not be told it may.
 */
export async function removeCopiesOf(
  filePath: string,
  fs: CopyFileSystem = nodeFileSystem
): Promise<void> {
  await removeTempFilesOf(filePath, fs.writer)
  const prefix = `${basename(filePath)}.`
  await removeMatching(
    dirname(filePath),
    (name) => name.startsWith(prefix) && COPY_SUFFIX.test(name.slice(prefix.length)),
    fs
  )
}

/** Owner-only, like the files they copy, through the injected writer when there is one. */
function writeOptions(fs: CopyFileSystem): AtomicWriteOptions {
  return fs.writer === undefined ? { mode: 0o600 } : { mode: 0o600, fs: fs.writer }
}

/** The names in a directory; none when it does not exist. */
async function namesIn(directory: string, fs: CopyFileSystem): Promise<Set<string>> {
  try {
    return new Set(await fs.readdir(directory))
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return new Set()
    throw error
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index])
}
