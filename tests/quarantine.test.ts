import * as nodeFs from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backupBeforeMigration,
  backupPathOf,
  quarantineCopy,
  removeCopiesOf,
  safetyCopyOf,
  stagedCopyOf,
  type CopyFileSystem
} from '@main/data/quarantine.js'

/**
 * `quarantine.ts`: the copies a store keeps before it replaces a file, and their removal.
 *
 * Real temporary directories throughout, because "what is left on disk" is the whole assertion; a
 * file system that fails is injected only where a failure has to be caused.
 */

/** No POSIX mode on Windows. See `atomic-write.test.ts`. */
const posixModes = process.platform !== 'win32'

async function fileIn(name = 'doc.json'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-quarantine-'))
  return join(dir, name)
}

function failure(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
  error.code = code
  return error
}

/** The real file system, with `open` for writing made to fail. */
function fullDisk(): CopyFileSystem {
  return {
    rm: nodeFs.rm,
    readdir: (path) => nodeFs.readdir(path),
    readFile: (path) => nodeFs.readFile(path),
    writer: {
      open: (path, flags, mode) =>
        flags === 'wx' ? Promise.reject(failure('ENOSPC')) : nodeFs.open(path, flags, mode),
      rename: nodeFs.rename,
      rm: nodeFs.rm,
      readdir: (path) => nodeFs.readdir(path)
    }
  }
}

describe('quarantineCopy', () => {
  it('copies the file beside itself, readable by its owner only', async () => {
    const filePath = await fileIn()
    await writeFile(filePath, 'broken bytes')

    const copy = await quarantineCopy(filePath)

    expect(copy).toBe(`${filePath}.unreadable`)
    expect(await readFile(copy, 'utf8')).toBe('broken bytes')
    if (posixModes) expect((await stat(copy)).mode & 0o777).toBe(0o600)
  })

  it('copies the bytes it is given rather than the file as it is now', async () => {
    // What the store decided about, not whatever replaced it since.
    const filePath = await fileIn()
    await writeFile(filePath, 'now')
    const copy = await quarantineCopy(filePath, { bytes: new TextEncoder().encode('then') })
    expect(await readFile(copy, 'utf8')).toBe('then')
  })

  it('never writes over an earlier copy of something else', async () => {
    const filePath = await fileIn()
    await writeFile(`${filePath}.unreadable`, 'first')
    await writeFile(`${filePath}.unreadable.1`, 'second')
    await writeFile(filePath, 'third')

    const copy = await quarantineCopy(filePath)

    expect(copy).toBe(`${filePath}.unreadable.2`)
    expect(await readFile(`${filePath}.unreadable`, 'utf8')).toBe('first')
    expect(await readFile(`${filePath}.unreadable.1`, 'utf8')).toBe('second')
    expect(await readFile(copy, 'utf8')).toBe('third')
  })

  it('answers an existing copy with the same contents instead of making another', async () => {
    // A file that stays broken across starts must not add one identical copy per launch.
    const filePath = await fileIn()
    await writeFile(`${filePath}.unreadable`, 'other')
    await writeFile(`${filePath}.unreadable.1`, 'same')
    await writeFile(filePath, 'same')

    expect(await quarantineCopy(filePath)).toBe(`${filePath}.unreadable.1`)
    expect(await quarantineCopy(filePath)).toBe(`${filePath}.unreadable.1`)
    expect((await readdir(join(filePath, '..'))).sort()).toEqual(
      ['doc.json', 'doc.json.unreadable', 'doc.json.unreadable.1'].sort()
    )
  })

  it('tells a same-length copy with other bytes apart', async () => {
    const filePath = await fileIn()
    await writeFile(`${filePath}.unreadable`, 'abcd')
    await writeFile(filePath, 'abce')
    expect(await quarantineCopy(filePath)).toBe(`${filePath}.unreadable.1`)
  })

  it('rejects when the copy cannot be written, and leaves nothing behind', async () => {
    const filePath = await fileIn()
    await writeFile(filePath, 'broken')
    await expect(quarantineCopy(filePath, { fs: fullDisk() })).rejects.toMatchObject({
      code: 'ENOSPC'
    })
    expect(await readdir(join(filePath, '..'))).toEqual(['doc.json'])
  })

  it('rejects when the file cannot be read', async () => {
    const filePath = await fileIn()
    await mkdir(filePath)
    await expect(quarantineCopy(filePath)).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('rejects when the directory cannot be listed for a reason other than absence', async () => {
    const filePath = await fileIn()
    const fs: CopyFileSystem = { ...fullDisk(), readdir: () => Promise.reject(failure('EACCES')) }
    await expect(
      quarantineCopy(filePath, { bytes: new Uint8Array([1]), fs })
    ).rejects.toMatchObject({ code: 'EACCES' })
  })
})

describe('backupBeforeMigration', () => {
  it('keeps the original bytes under its version, readable by its owner only', async () => {
    const filePath = await fileIn('history.json')
    const bytes = new TextEncoder().encode('{"version":1}')

    const backup = await backupBeforeMigration(filePath, 1, bytes)

    expect(backup).toBe(backupPathOf(filePath, 1))
    expect(backup).toBe(`${filePath}.v1.bak`)
    expect(await readFile(backup, 'utf8')).toBe('{"version":1}')
    if (posixModes) expect((await stat(backup)).mode & 0o777).toBe(0o600)
  })

  it('keeps the first backup of a version and never replaces it', async () => {
    // At most one per version, and the older one is the one with the data the user had.
    const filePath = await fileIn()
    await writeFile(`${filePath}.v1.bak`, 'first')
    const backup = await backupBeforeMigration(filePath, 1, new TextEncoder().encode('second'))
    expect(backup).toBe(`${filePath}.v1.bak`)
    expect(await readFile(backup, 'utf8')).toBe('first')
  })

  it('rejects when the directory is gone', async () => {
    const filePath = join(await fileIn('gone'), 'doc.json')
    await expect(backupBeforeMigration(filePath, 1, new Uint8Array([1]))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  })

  it('rejects when the backup cannot be written', async () => {
    const filePath = await fileIn()
    await expect(
      backupBeforeMigration(filePath, 2, new Uint8Array([1]), fullDisk())
    ).rejects.toMatchObject({ code: 'ENOSPC' })
    expect(await readdir(join(filePath, '..'))).toEqual([])
  })
})

describe('removeCopiesOf', () => {
  it('removes every copy and temporary of the file, and nothing else', async () => {
    const filePath = await fileIn('history.json')
    const dir = join(filePath, '..')
    const theirs = [
      'history.json.unreadable',
      'history.json.unreadable.3',
      'history.json.v1.bak',
      'history.json.v12.bak',
      'history.json.v1.bak.4242-0a1b2c.tmp',
      'history.json.unreadable.4242-0a1b2c.tmp',
      'history.json.4242-0a1b2c.tmp',
      'history.json.tmp'
    ]
    const others = [
      'history.json',
      'history.jsonl.unreadable',
      'downloads.json.v1.bak',
      'history.json.v1.bak.old',
      'history.json.unreadable.x',
      'history.json.vx.bak'
    ]
    for (const name of [...theirs, ...others]) await writeFile(join(dir, name), name)

    await removeCopiesOf(filePath)

    expect((await readdir(dir)).sort()).toEqual([...others].sort())
  })

  it('takes a restore’s staged copy and safety copy with the file (U23)', async () => {
    const filePath = await fileIn('bookmarks.json')
    const dir = join(filePath, '..')
    expect(stagedCopyOf(filePath)).toBe(`${filePath}.restore`)
    expect(safetyCopyOf(filePath)).toBe(`${filePath}.before-restore`)
    const theirs = [
      'bookmarks.json.restore',
      'bookmarks.json.before-restore',
      'bookmarks.json.restore.4242-0a1b2c.tmp',
      'bookmarks.json.before-restore.7-ff.tmp'
    ]
    const others = [
      'bookmarks.json',
      'bookmarks.json.restored',
      'bookmarks.json.before-restore.old',
      'bookmarks.json.xrestore',
      'history.json.restore'
    ]
    for (const name of [...theirs, ...others]) await writeFile(join(dir, name), name)

    await removeCopiesOf(filePath)

    expect((await readdir(dir)).sort()).toEqual([...others].sort())
  })

  it('has nothing to do in a directory that does not exist', async () => {
    await expect(removeCopiesOf(join(await fileIn('gone'), 'doc.json'))).resolves.toBeUndefined()
  })

  it('lets a failed removal out, so a deletion is not reported as done', async () => {
    const filePath = await fileIn()
    await writeFile(`${filePath}.v1.bak`, 'old data')
    const fs: CopyFileSystem = {
      ...fullDisk(),
      rm: (path, options) =>
        path.endsWith('.bak') ? Promise.reject(failure('EPERM')) : nodeFs.rm(path, options)
    }
    await expect(removeCopiesOf(filePath, fs)).rejects.toMatchObject({ code: 'EPERM' })
  })
})
