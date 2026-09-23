import * as nodeFs from 'node:fs/promises'
import { mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  removeTempFilesIn,
  removeTempFilesOf,
  writeFileAtomically,
  type AtomicFileHandle,
  type AtomicFileSystem
} from '@main/data/atomic-write.js'

/**
 * `atomic-write.ts`: the one place a file is replaced on disk.
 *
 * What these tests are for is the failure behaviour, stage by stage. A store that writes through the
 * helper promises that after a crash its file is either the old one or the new one, never half of
 * each — and the only way to know that holds is to make each step fail in turn and look at what is
 * left on disk. The file system is injected for exactly that reason; everything that does not fail
 * still goes to a real temporary directory, so "what is left on disk" is a real listing.
 */

/** No POSIX mode on Windows: `stat` reports `0o666` whatever was asked for. See `vault-key.test.ts`. */
const posixModes = process.platform !== 'win32'

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'tessera-atomic-'))
}

function failure(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`simulated ${code}`)
  error.code = code
  return error
}

type Stage =
  | 'open'
  | 'write'
  | 'sync'
  | 'close'
  | 'rename'
  | 'rm'
  | 'readdir'
  | 'directory-open'
  | 'directory-sync'

interface RecordingFileSystem extends AtomicFileSystem {
  readonly calls: string[]
  readonly opened: string[]
}

/**
 * The real file system, with a record of every call and one stage that can be told to fail.
 *
 * `directory-open` and `directory-sync` are told apart from their file counterparts by the flag the
 * helper opens with: a directory is opened for reading, a temporary for exclusive creation.
 */
function recordingFs(failures: Partial<Record<Stage, string>> = {}): RecordingFileSystem {
  const calls: string[] = []
  const opened: string[] = []
  const fail = (stage: Stage): void => {
    const code = failures[stage]
    if (code !== undefined) throw failure(code)
  }
  const wrap = (handle: nodeFs.FileHandle, directory: boolean): AtomicFileHandle => ({
    writeFile: async (data) => {
      calls.push('write')
      fail('write')
      await handle.writeFile(data)
    },
    sync: async () => {
      calls.push(directory ? 'directory-sync' : 'sync')
      fail(directory ? 'directory-sync' : 'sync')
      await handle.sync()
    },
    close: async () => {
      calls.push(directory ? 'directory-close' : 'close')
      await handle.close()
      if (!directory) fail('close')
    }
  })
  return {
    calls,
    opened,
    open: async (path, flags, mode) => {
      const directory = flags === 'r'
      calls.push(directory ? 'directory-open' : `open ${flags} ${String(mode)}`)
      fail(directory ? 'directory-open' : 'open')
      if (!directory) opened.push(path)
      return wrap(await nodeFs.open(path, flags, mode), directory)
    },
    rename: async (from, to) => {
      calls.push('rename')
      fail('rename')
      await nodeFs.rename(from, to)
    },
    rm: async (path, options) => {
      calls.push(`rm ${basename(path)}`)
      fail('rm')
      await nodeFs.rm(path, options)
    },
    readdir: async (path) => {
      calls.push('readdir')
      fail('readdir')
      return nodeFs.readdir(path)
    }
  }
}

/** A target with an old version already in place, which is the case every failure test is about. */
async function existingTarget(): Promise<string> {
  const target = join(await tempDir(), 'document.json')
  await writeFile(target, 'old', 'utf8')
  return target
}

describe('writing a file atomically', () => {
  it('leaves the new contents and nothing else, with the mode it was given', async () => {
    const target = join(await tempDir(), 'document.json')
    await writeFileAtomically(target, 'new', { mode: 0o600 })

    expect(await readFile(target, 'utf8')).toBe('new')
    expect(await readdir(dirname(target))).toEqual(['document.json'])
    if (posixModes) expect((await stat(target)).mode & 0o777).toBe(0o600)
  })

  it('replaces a file that is already there', async () => {
    const target = await existingTarget()
    await writeFileAtomically(target, new TextEncoder().encode('new'))
    expect(await readFile(target, 'utf8')).toBe('new')
  })

  it('creates the temporary exclusively, with the default mode when none is given', async () => {
    // `wx`, so a name that is somehow taken fails instead of writing into a file somebody else is
    // still writing. `0o666` is what `fs.writeFile` would have used, so a caller that never asked for
    // a mode gets the same file it got before the helper existed.
    const fs = recordingFs()
    await writeFileAtomically(join(await tempDir(), 'list.txt'), 'body', { fs })
    expect(fs.calls[0]).toBe(`open wx ${String(0o666)}`)
  })

  it('passes the mode through to the temporary, which is what the rename puts in place', async () => {
    const fs = recordingFs()
    await writeFileAtomically(join(await tempDir(), 'key'), 'secret', { mode: 0o600, fs })
    expect(fs.calls[0]).toBe(`open wx ${String(0o600)}`)
  })

  it('writes, syncs and closes the file before renaming it, and syncs the directory after', async () => {
    // The order is the whole point. A rename before the data is durable can survive a power cut that
    // the data does not, which leaves the *new* name on an empty or partial file — exactly what the
    // rename was meant to rule out. And the directory sync is what makes the rename itself durable.
    const fs = recordingFs()
    await writeFileAtomically(join(await tempDir(), 'document.json'), 'new', { fs })
    expect(fs.calls).toEqual([
      `open wx ${String(0o666)}`,
      'write',
      'sync',
      'close',
      'rename',
      'directory-open',
      'directory-sync',
      'directory-close'
    ])
  })

  it('names the temporary after the target, the process and a random part', async () => {
    const fs = recordingFs()
    const target = join(await tempDir(), 'document.json')
    await writeFileAtomically(target, 'new', { fs })

    const [temp] = fs.opened
    expect(dirname(temp!)).toBe(dirname(target))
    expect(basename(temp!)).toMatch(
      new RegExp(`^document\\.json\\.${process.pid}-[0-9a-f]{12}\\.tmp$`)
    )
  })

  it('gives two writes to the same file two different temporaries', async () => {
    // A fixed name is what let two writers share one temporary: the second truncated what the first
    // was about to rename, and one of the two renames then found nothing to move.
    const fs = recordingFs()
    const target = join(await tempDir(), 'document.json')
    await Promise.all([
      writeFileAtomically(target, 'first', { fs }),
      writeFileAtomically(target, 'second', { fs })
    ])

    expect(fs.opened).toHaveLength(2)
    expect(fs.opened[0]).not.toBe(fs.opened[1])
    expect(['first', 'second']).toContain(await readFile(target, 'utf8'))
    expect(await readdir(dirname(target))).toEqual(['document.json'])
  })
})

describe('a write that fails part-way', () => {
  it.each(['write', 'sync', 'close', 'rename'] as const)(
    'leaves the old file as it was and removes the temporary when %s fails',
    async (stage) => {
      const target = await existingTarget()
      const fs = recordingFs({ [stage]: 'EIO' })

      await expect(writeFileAtomically(target, 'new', { fs })).rejects.toThrow(/simulated EIO/)

      expect(await readFile(target, 'utf8')).toBe('old')
      expect(await readdir(dirname(target))).toEqual(['document.json'])
    }
  )

  it('closes the temporary it opened before removing it', async () => {
    // An open handle keeps the file alive on Windows, where `rm` would then fail and leave it.
    const fs = recordingFs({ sync: 'EIO' })
    const target = await existingTarget()
    await expect(writeFileAtomically(target, 'new', { fs })).rejects.toThrow()

    const temp = basename(fs.opened[0]!)
    expect(fs.calls.slice(-2)).toEqual(['close', `rm ${temp}`])
  })

  it('does not close a temporary twice when closing it was what failed', async () => {
    const fs = recordingFs({ close: 'EIO' })
    await expect(writeFileAtomically(await existingTarget(), 'new', { fs })).rejects.toThrow()
    expect(fs.calls.filter((call) => call === 'close')).toHaveLength(1)
  })

  it('still removes the temporary when closing it after a failed write fails too', async () => {
    const fs = recordingFs({ write: 'ENOSPC', close: 'EIO' })
    const target = await existingTarget()

    await expect(writeFileAtomically(target, 'new', { fs })).rejects.toThrow(/simulated ENOSPC/)
    expect(await readdir(dirname(target))).toEqual(['document.json'])
  })

  it('removes nothing when the temporary could not even be created', async () => {
    // `wx` failing with EEXIST means the name belongs to somebody else. Removing it would be deleting a
    // file this call never made.
    const fs = recordingFs({ open: 'EEXIST' })
    const target = await existingTarget()

    await expect(writeFileAtomically(target, 'new', { fs })).rejects.toThrow(/simulated EEXIST/)
    expect(fs.calls.some((call) => call.startsWith('rm'))).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('old')
  })

  it('reports the failure that happened, not one from cleaning up after it', async () => {
    // The removal is best effort. What the caller needs to know is why the write failed.
    const fs = recordingFs({ rename: 'EXDEV', rm: 'EBUSY' })
    await expect(writeFileAtomically(await existingTarget(), 'new', { fs })).rejects.toThrow(
      /simulated EXDEV/
    )
  })
})

describe('syncing the directory', () => {
  it.each([
    ['directory-open', 'EISDIR'],
    ['directory-open', 'EPERM'],
    ['directory-sync', 'EINVAL'],
    ['directory-sync', 'EPERM']
  ] as const)(
    'counts the write as done when %s fails with %s, as it does on Windows',
    async (stage, code) => {
      // Windows cannot open a directory as a file at all, and some file systems refuse to sync one.
      // By then the rename has happened: failing the write would report as lost a file that is in
      // place.
      const target = await existingTarget()
      const fs = recordingFs({ [stage]: code })

      await expect(writeFileAtomically(target, 'new', { fs })).resolves.toBeUndefined()
      expect(await readFile(target, 'utf8')).toBe('new')
    }
  )

  it('closes the directory even when syncing it failed', async () => {
    const fs = recordingFs({ 'directory-sync': 'EINVAL' })
    await writeFileAtomically(await existingTarget(), 'new', { fs })
    expect(fs.calls.at(-1)).toBe('directory-close')
  })

  it.each(['directory-open', 'directory-sync'] as const)(
    'reports the write as done but logs any other failure of %s',
    async (stage) => {
      // Not a platform that cannot do it, but a disk that did not. The rename has happened and the new
      // contents are what every later read sees; rejecting would tell the caller the old file is still
      // in force. For a rewrapped vault key that is a lockout: the user keeps the old master password
      // while the file on disk already wants the new one.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        const target = await existingTarget()
        const fs = recordingFs({ [stage]: 'EIO' })
        await expect(writeFileAtomically(target, 'new', { fs })).resolves.toBeUndefined()
        expect(await readFile(target, 'utf8')).toBe('new')
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/directory/), expect.anything())
      } finally {
        warn.mockRestore()
      }
    }
  )
})

describe('removing the temporaries a crash left behind', () => {
  async function directoryWith(names: readonly string[]): Promise<string> {
    const directory = await tempDir()
    for (const name of names) await writeFile(join(directory, name), name, 'utf8')
    return directory
  }

  it('removes every temporary of one target, old fixed name and new unique ones alike', async () => {
    const directory = await directoryWith([
      'history.json',
      'history.json.tmp',
      'history.json.4242-0a1b2c3d4e5f.tmp',
      'history.json.7-ff.tmp',
      // Not temporaries of this target: its backup, a temporary of that backup, a neighbour's
      // temporary, and a name that merely starts with the same letters.
      'history.json.v1.bak',
      'history.json.v1.bak.4242-0a1b2c3d4e5f.tmp',
      'bookmarks.json.tmp',
      'history.jsonx.tmp',
      'history.json.12-XYZ.tmp',
      'history.json.tmp.old'
    ])

    await removeTempFilesOf(join(directory, 'history.json'))

    expect((await readdir(directory)).sort()).toEqual([
      'bookmarks.json.tmp',
      'history.json',
      'history.json.12-XYZ.tmp',
      'history.json.tmp.old',
      'history.json.v1.bak',
      'history.json.v1.bak.4242-0a1b2c3d4e5f.tmp',
      'history.jsonx.tmp'
    ])
  })

  it('treats a target in a directory that does not exist yet as having nothing to remove', async () => {
    const missing = join(await tempDir(), 'never-created', 'history.json')
    await expect(removeTempFilesOf(missing)).resolves.toBeUndefined()
  })

  it('lets a directory that cannot be listed say so', async () => {
    // Not "nothing there". A profile that cannot be read is broken, and a caller deleting credentials
    // must not be told it succeeded.
    const fs = recordingFs({ readdir: 'EACCES' })
    await expect(removeTempFilesOf(join(await tempDir(), 'x.json'), fs)).rejects.toThrow(
      /simulated EACCES/
    )
  })

  it('lets a temporary that cannot be removed say so', async () => {
    const directory = await directoryWith(['passwords.json.1-ab.tmp'])
    const fs = recordingFs({ rm: 'EPERM' })
    await expect(removeTempFilesOf(join(directory, 'passwords.json'), fs)).rejects.toThrow(
      /simulated EPERM/
    )
  })

  it('removes every temporary in a directory the store owns outright', async () => {
    // The favicon and thumbnail caches: one file per site, so no single target to name.
    const directory = await directoryWith([
      'index.json',
      'index.json.tmp',
      'example.com.ico',
      'example.com.ico.99-abcdef.tmp',
      'example.org.jpg.tmp'
    ])

    await removeTempFilesIn(directory, recordingFs())

    expect((await readdir(directory)).sort()).toEqual(['example.com.ico', 'index.json'])
  })

  it('treats a cache directory that does not exist yet as having nothing to remove', async () => {
    await expect(removeTempFilesIn(join(await tempDir(), 'never-created'))).resolves.toBeUndefined()
  })
})
