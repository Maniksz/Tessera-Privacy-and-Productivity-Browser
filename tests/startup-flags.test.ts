import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  readCheckModule,
  readStartupFlags,
  startupFlagsFrom,
  writeStartupFlags,
  type StartupFlags
} from '@main/startup-flags.js'
import { defaultSettings } from '@shared/settings/definitions.js'

/**
 * The two settings that reach Chromium's command line.
 *
 * They exist as their own file because of a failure that would have been invisible: both become
 * command-line switches, switches must be set before the application is ready, and `settings.json`
 * is encrypted — with `safeStorage` unreliable that early on Linux. Reading it there lands in a
 * `catch` on every launch, and `advanced.hardwareAcceleration: false` silently stops taking effect.
 *
 * So these tests are mostly about tolerance: this file is read at a moment where nothing can be
 * awaited and nothing can be repaired, and it must never be the reason the browser will not start.
 */

const DEFAULTS: StartupFlags = { hardwareAcceleration: true, throttleBackgroundContent: false }

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-flags-'))
  return join(dir, 'startup-flags.json')
}

describe('reading the flags', () => {
  it('reads both values back', async () => {
    const filePath = await tempFile()
    await writeStartupFlags(filePath, { hardwareAcceleration: false, throttleBackgroundContent: true })
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual({
      hardwareAcceleration: false,
      throttleBackgroundContent: true
    })
  })

  it('falls back to the defaults when there is no file', async () => {
    // The first launch of a fresh profile, and the normal case rather than an error.
    const filePath = await tempFile()
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('falls back for a file that is not JSON', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, '{ half written')
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('falls back for JSON that is not an object', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, '"just a string"')
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('falls back for null, which typeof calls an object', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, 'null')
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('honours the usable half of a partly broken file', async () => {
    // Each value is checked on its own, so one bad field does not cost the other. The alternative
    // — reject the file wholesale — would turn a typo into two reverted settings.
    const filePath = await tempFile()
    await writeFile(filePath, JSON.stringify({ hardwareAcceleration: false, throttleBackgroundContent: 'yes' }))
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual({
      hardwareAcceleration: false,
      throttleBackgroundContent: DEFAULTS.throttleBackgroundContent
    })
  })

  it('ignores a value of the wrong type rather than coercing it', async () => {
    // `0` and `""` are falsy but are not `false`; treating them as such would let a malformed file
    // quietly turn a feature off.
    const filePath = await tempFile()
    await writeFile(filePath, JSON.stringify({ hardwareAcceleration: 0 }))
    expect(readStartupFlags(filePath, DEFAULTS).hardwareAcceleration).toBe(true)
  })
})

describe('deriving the flags from settings', () => {
  it('takes exactly the two keys that become switches', () => {
    const settings = defaultSettings()
    expect(startupFlagsFrom(settings)).toEqual({
      hardwareAcceleration: settings['advanced.hardwareAcceleration'],
      throttleBackgroundContent: settings['splitView.throttleInactiveTiles']
    })
  })

  it('carries a change through', () => {
    const settings = { ...defaultSettings(), 'advanced.hardwareAcceleration': false }
    expect(startupFlagsFrom(settings).hardwareAcceleration).toBe(false)
  })
})

describe('writing the flags', () => {
  it('round-trips through the reader', async () => {
    const filePath = await tempFile()
    const flags: StartupFlags = { hardwareAcceleration: false, throttleBackgroundContent: true }
    await writeStartupFlags(filePath, flags)
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual(flags)
  })

  it('leaves no temporary file behind', async () => {
    // Write-then-rename is what keeps a crash mid-write from leaving a half-written file that the
    // next startup would read as "no usable flags" — the one way this file could be worse than the
    // problem it solves.
    const filePath = await tempFile()
    await writeStartupFlags(filePath, DEFAULTS)
    await expect(readFile(`${filePath}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('creates the directory when it is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-flags-'))
    const filePath = join(dir, 'nested', 'startup-flags.json')
    await writeStartupFlags(filePath, DEFAULTS)
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('overwrites a previous file rather than appending to it', async () => {
    const filePath = await tempFile()
    await writeStartupFlags(filePath, { hardwareAcceleration: false, throttleBackgroundContent: false })
    await writeStartupFlags(filePath, { hardwareAcceleration: true, throttleBackgroundContent: true })
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual({
      hardwareAcceleration: true,
      throttleBackgroundContent: true
    })
  })
})

describe('the check-run switch', () => {
  const DEVELOPMENT = { packaged: false }

  it('reads the module path off the command line', () => {
    // Without this the application has no way to be driven from inside its own process, and the
    // only remaining way to drive a real window is a debugging port — the thing this replaced.
    expect(readCheckModule(['electron', 'out/main/index.js', '--run-checks=/tmp/checks.mjs'], DEVELOPMENT)).toBe(
      '/tmp/checks.mjs'
    )
  })

  it('is absent on an ordinary command line', () => {
    // Every normal launch goes through here. A false positive would make the browser load a module
    // and exit instead of opening a window.
    expect(readCheckModule(['electron', 'out/main/index.js', '--user-data-dir=/tmp/p'], DEVELOPMENT)).toBeNull()
  })

  it('refuses the switch in a packaged build', () => {
    /*
      The guard that matters. A shipped browser that can be told to load and execute a file from disk
      is a code-execution route whose key is a command line — a tampered shortcut, a `.desktop` file,
      anything that can start the browser with arguments. In a packaged build the switch must not
      exist at all, however well-formed it looks.
    */
    expect(readCheckModule(['Tessera', '--run-checks=/tmp/evil.mjs'], { packaged: true })).toBeNull()
  })

  it('treats a switch with no path as absent', () => {
    // `--run-checks=` names nothing to load. Refusing to start over it would make a typo in a
    // development-only switch into a browser that does not open.
    expect(readCheckModule(['electron', '--run-checks='], DEVELOPMENT)).toBeNull()
  })

  it('lets the last occurrence win, as Chromium does with its own switches', () => {
    // The run script appends the switch to whatever is already on the command line. If an earlier
    // one won, a stale path in someone's launch configuration would silently decide what runs.
    expect(
      readCheckModule(['electron', '--run-checks=/tmp/stale.mjs', '--run-checks=/tmp/wanted.mjs'], DEVELOPMENT)
    ).toBe('/tmp/wanted.mjs')
  })

  it('does not match a switch that merely starts with the same letters', () => {
    // `startsWith` on the bare name would accept `--run-checks-later=x` and hand the core a path it
    // was never given; the `=` is part of what is matched for that reason.
    expect(readCheckModule(['electron', '--run-checksum=/tmp/x.mjs'], DEVELOPMENT)).toBeNull()
  })
})

describe('a file whose contents are not an object', () => {
  /*
    Added after a mutation run: the `parsed === null || typeof parsed !== 'object'` guard survived every
    mutation, because no test ever fed it anything but an object. That guard protects the *first* file this
    browser reads — before `app.whenReady()`, before a window, before anything that could report a problem — so
    a throw here is a browser that does not start, with no message a user could act on.

    `JSON.parse` answers with a bare value for each of these, and none of them has properties to read.
  */
  const cases: Array<[string, string]> = [
    ['null', 'null'],
    ['a number', '5'],
    ['a string', '"hardwareAcceleration"'],
    ['a boolean', 'true'],
    ['an array', '[true, false]']
  ]

  for (const [what, contents] of cases) {
    it(`falls back to the defaults for ${what}`, async () => {
      const file = join(await mkdtemp(join(tmpdir(), 'tessera-flags-')), 'startup-flags.json')
      await writeFile(file, contents, 'utf8')
      // Derived rather than written out: a literal here would drift from `StartupFlags` the moment a third
      // switch is added, and would then compare two objects with different key sets.
      const defaults = startupFlagsFrom(defaultSettings())
      expect(readStartupFlags(file, defaults)).toEqual(defaults)
    })
  }
})
