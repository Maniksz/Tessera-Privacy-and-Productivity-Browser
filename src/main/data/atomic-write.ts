import { randomBytes } from 'node:crypto'
import { open, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Replacing a file on disk so that a crash leaves either the old file or the new one, never half of
 * each.
 *
 * Eight places used to spell this out for themselves as `writeFile(temp)` + `rename(temp, target)`,
 * and the two-line version is short of the promise in three ways:
 *
 *   - **Nothing reached the disk before the rename.** Without `sync` on the file, a power cut can keep
 *     the rename and lose the data, which leaves the *new* name on an empty or partial file — the very
 *     thing the rename was meant to rule out. Without a sync of the directory the rename itself may not
 *     survive.
 *   - **The temporary had a fixed name.** Two writers to one target — two unserialised calls in one
 *     process, or a second process — then wrote into the same `<target>.tmp`, one truncating what the
 *     other was about to rename. The name here carries the process id and a random part.
 *   - **A failed write left its temporary behind**, which for the vault means a file full of
 *     credentials that no "delete everything" knew the name of.
 *
 * A unique name has a cost of its own: nothing can find a leftover by guessing its name any more. So
 * this module also removes them — `removeTempFilesOf` for one target, `removeTempFilesIn` for a
 * directory a store owns outright — and every store runs one when it opens, and every deletion path
 * runs one before it reports that the data is gone.
 *
 * The file system is a parameter, structurally, so a test can make any single step fail and look at
 * what is left. Nothing here decides what a failure *means* to the caller; that stays with the store.
 */

/** As much of a `FileHandle` as the helper uses. Node's own satisfies it. */
export interface AtomicFileHandle {
  writeFile(data: string | Uint8Array): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

/** As much of `node:fs/promises` as the helper uses. */
export interface AtomicFileSystem {
  open(path: string, flags: string, mode?: number): Promise<AtomicFileHandle>
  rename(from: string, to: string): Promise<void>
  rm(path: string, options: { force: true }): Promise<void>
  readdir(path: string): Promise<string[]>
}

const nodeFileSystem: AtomicFileSystem = { open, rename, rm, readdir }

export interface AtomicWriteOptions {
  /**
   * Given to the temporary at creation, which is what the rename then puts in place.
   *
   * Absent means `0o666`, what `fs.writeFile` uses, so a caller that never asked for a mode gets the
   * same file it got before this helper existed. Both are subject to the umask.
   */
  readonly mode?: number
  readonly fs?: AtomicFileSystem
}

/**
 * Codes a directory sync fails with where the platform cannot do it, rather than where the disk did
 * not: Windows cannot open a directory as a file (`EISDIR`, `EPERM`), and some file systems refuse to
 * sync one (`EINVAL`). By then the rename has happened, so failing the write would report as lost a
 * file that is in place.
 */
const UNSUPPORTED_DIRECTORY_SYNC = new Set<string | undefined>(['EISDIR', 'EPERM', 'EINVAL'])

/** `<target>.tmp` as the old code named it, or `<target>.<pid>-<hex>.tmp` as this module does. */
const TEMP_SUFFIX = /^(?:\d+-[0-9a-f]+\.)?tmp$/

/**
 * Writes `data` to `target` through a uniquely named temporary beside it.
 *
 * Rejects only when the write did not happen, with the old file untouched and the temporary removed.
 * Once the rename has happened the write has happened: every later read sees the new contents, so a
 * failed directory sync is logged rather than thrown. Rejecting there would tell the caller the old
 * file is still in force — for a rewrapped vault key, a user keeping the old master password while the
 * file on disk already wants the new one.
 */
export async function writeFileAtomically(
  target: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const fs = options.fs ?? nodeFileSystem
  const temp = `${target}.${process.pid}-${randomBytes(6).toString('hex')}.tmp`

  // `wx`: a name that is somehow taken belongs to somebody else, and must fail rather than be written
  // into — or, below, removed.
  const handle = await fs.open(temp, 'wx', options.mode ?? 0o666)
  let closed = false
  try {
    await handle.writeFile(data)
    await handle.sync()
    closed = true
    await handle.close()
    await fs.rename(temp, target)
  } catch (error) {
    // Best effort, and quiet: the caller needs the reason the write failed, not one from cleaning up
    // after it. Closed first, because on Windows an open handle is what would make the removal fail.
    if (!closed) await handle.close().catch(() => undefined)
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
  await syncDirectory(dirname(target), fs).catch((error: unknown) => {
    console.warn('[atomic-write] replaced the file but could not sync its directory:', error)
  })
}

async function syncDirectory(directory: string, fs: AtomicFileSystem): Promise<void> {
  let handle: AtomicFileHandle
  try {
    handle = await fs.open(directory, 'r')
  } catch (error) {
    if (UNSUPPORTED_DIRECTORY_SYNC.has(codeOf(error))) return
    throw error
  }
  try {
    await handle.sync()
  } catch (error) {
    if (!UNSUPPORTED_DIRECTORY_SYNC.has(codeOf(error))) throw error
  } finally {
    await handle.close()
  }
}

/**
 * Removes every temporary a crash left beside `target`: the old fixed `<target>.tmp` and any
 * `<target>.<pid>-<hex>.tmp`.
 *
 * Nothing else: `<target>.v1.bak` is not a temporary, and `<target>.v1.bak.<pid>-<hex>.tmp` is one of a
 * different target. Must not run while a write to the same target is in flight — it would remove the
 * temporary that write is about to rename — which is why stores call it when they open, before their
 * first write, and deletion paths call it once nothing holds the store any more.
 *
 * A directory that does not exist has nothing to remove. Any other failure is let out: a caller
 * deleting credentials must not be told it succeeded.
 */
export async function removeTempFilesOf(
  target: string,
  fs: AtomicFileSystem = nodeFileSystem
): Promise<void> {
  const prefix = `${basename(target)}.`
  await removeMatching(
    dirname(target),
    (name) => name.startsWith(prefix) && TEMP_SUFFIX.test(name.slice(prefix.length)),
    fs
  )
}

/**
 * Removes every `*.tmp` in a directory a store owns outright.
 *
 * For the favicon and thumbnail caches, which write one file per site and so have no single target
 * to name. Only for a directory in which every file is the store's own.
 */
export async function removeTempFilesIn(
  directory: string,
  fs: AtomicFileSystem = nodeFileSystem
): Promise<void> {
  await removeMatching(directory, (name) => name.endsWith('.tmp'), fs)
}

async function removeMatching(
  directory: string,
  matches: (name: string) => boolean,
  fs: AtomicFileSystem
): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(directory)
  } catch (error) {
    if (codeOf(error) === 'ENOENT') return
    throw error
  }
  for (const name of names) {
    if (matches(name)) await fs.rm(join(directory, name), { force: true })
  }
}

function codeOf(error: unknown): string | undefined {
  return (error as { code?: string }).code
}
