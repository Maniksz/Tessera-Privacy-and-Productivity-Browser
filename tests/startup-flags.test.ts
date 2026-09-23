import { mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ExternalAddressInbox,
  acceptExternalAddress,
  devServerUrl,
  externalAddressWindow,
  firstExternalAddress,
  readCheckModule,
  readStartupFlags,
  refusedDebugSwitch,
  secondInstanceAddress,
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
    await writeStartupFlags(filePath, {
      hardwareAcceleration: false,
      throttleBackgroundContent: true
    })
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
    await writeFile(
      filePath,
      JSON.stringify({ hardwareAcceleration: false, throttleBackgroundContent: 'yes' })
    )
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
    // The listing, not one guessed name: temporaries are uniquely named (`atomic-write.ts`).
    expect(await readdir(dirname(filePath))).toEqual([basename(filePath)])
  })

  it('survives two writes at once, which is how every settings change calls it', async () => {
    // Nothing serialises these calls. With one fixed temporary name the second write truncated what
    // the first was about to rename, and one rename then found nothing to move.
    const filePath = await tempFile()
    const flags: StartupFlags = { hardwareAcceleration: false, throttleBackgroundContent: false }
    await Promise.all([writeStartupFlags(filePath, DEFAULTS), writeStartupFlags(filePath, flags)])
    expect([DEFAULTS, flags]).toContainEqual(readStartupFlags(filePath, DEFAULTS))
    expect(await readdir(dirname(filePath))).toEqual([basename(filePath)])
  })

  it('creates the directory when it is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-flags-'))
    const filePath = join(dir, 'nested', 'startup-flags.json')
    await writeStartupFlags(filePath, DEFAULTS)
    expect(readStartupFlags(filePath, DEFAULTS)).toEqual(DEFAULTS)
  })

  it('overwrites a previous file rather than appending to it', async () => {
    const filePath = await tempFile()
    await writeStartupFlags(filePath, {
      hardwareAcceleration: false,
      throttleBackgroundContent: false
    })
    await writeStartupFlags(filePath, {
      hardwareAcceleration: true,
      throttleBackgroundContent: true
    })
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
    expect(
      readCheckModule(
        ['electron', 'out/main/index.js', '--run-checks=/tmp/checks.mjs'],
        DEVELOPMENT
      )
    ).toBe('/tmp/checks.mjs')
  })

  it('is absent on an ordinary command line', () => {
    // Every normal launch goes through here. A false positive would make the browser load a module
    // and exit instead of opening a window.
    expect(
      readCheckModule(['electron', 'out/main/index.js', '--user-data-dir=/tmp/p'], DEVELOPMENT)
    ).toBeNull()
  })

  it('refuses the switch in a packaged build', () => {
    /*
      The guard that matters. A shipped browser that can be told to load and execute a file from disk
      is a code-execution route whose key is a command line — a tampered shortcut, a `.desktop` file,
      anything that can start the browser with arguments. In a packaged build the switch must not
      exist at all, however well-formed it looks.
    */
    expect(
      readCheckModule(['Tessera', '--run-checks=/tmp/evil.mjs'], { packaged: true })
    ).toBeNull()
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
      readCheckModule(
        ['electron', '--run-checks=/tmp/stale.mjs', '--run-checks=/tmp/wanted.mjs'],
        DEVELOPMENT
      )
    ).toBe('/tmp/wanted.mjs')
  })

  it('does not match a switch that merely starts with the same letters', () => {
    // `startsWith` on the bare name would accept `--run-checks-later=x` and hand the core a path it
    // was never given; the `=` is part of what is matched for that reason.
    expect(readCheckModule(['electron', '--run-checksum=/tmp/x.mjs'], DEVELOPMENT)).toBeNull()
  })
})

describe('the development server address', () => {
  const URL_FROM_VITE = { ELECTRON_RENDERER_URL: 'http://localhost:5173' }

  it('is never read in a packaged build, whatever the environment says', () => {
    /*
      The guard that matters. The chrome UI holds every IPC channel there is, so whoever decides where
      it loads from owns the browser — and an environment variable is something any launcher can set.
      A shipped build loads its bundle from disk, full stop.
    */
    expect(devServerUrl(URL_FROM_VITE, { packaged: true })).toBeNull()
  })

  it('is the address electron-vite hands a development build', () => {
    // Without it `pnpm dev` would load the last built bundle, and the chrome UI would stop reloading.
    expect(devServerUrl(URL_FROM_VITE, { packaged: false })).toBe('http://localhost:5173')
  })

  it('is absent when the variable is unset or empty', () => {
    // Empty is how a shell unsets a variable for one command; both mean "load from disk".
    expect(devServerUrl({}, { packaged: false })).toBeNull()
    expect(devServerUrl({ ELECTRON_RENDERER_URL: '' }, { packaged: false })).toBeNull()
  })
})

describe('the debugging switches a packaged build refuses', () => {
  /** A command line holding exactly `present`, as `app.commandLine.hasSwitch` would read it. */
  const switches =
    (...present: string[]) =>
    (name: string): boolean =>
      present.includes(name)

  it('names the remote-debugging port in a packaged build', () => {
    /*
      The fuses turn off Node's inspector, not Chromium's DevTools protocol, and the protocol is the
      whole browser: every page, every cookie, script in any tab. A shipped build started with the
      switch has been started by something other than its user.
    */
    expect(refusedDebugSwitch(switches('remote-debugging-port'), { packaged: true })).toBe(
      'remote-debugging-port'
    )
  })

  it('names the remote-debugging pipe in a packaged build', () => {
    // The same protocol over a file descriptor instead of a port. Refusing one and not the other
    // would close the door and leave the window beside it open.
    expect(refusedDebugSwitch(switches('remote-debugging-pipe'), { packaged: true })).toBe(
      'remote-debugging-pipe'
    )
  })

  it('lets an ordinary packaged launch through', () => {
    expect(refusedDebugSwitch(switches('user-data-dir', 'lang'), { packaged: true })).toBeNull()
  })

  it('never refuses a development build', () => {
    // A developer attaching DevTools to their own build is the switch doing its job.
    expect(
      refusedDebugSwitch(switches('remote-debugging-port', 'remote-debugging-pipe'), {
        packaged: false
      })
    ).toBeNull()
  })

  it('asks the command line rather than reading it', () => {
    /*
      Chromium accepts `-remote-debugging-port` and, on Windows, `/remote-debugging-port` and any
      capitalisation of it. A search of argv would have to know all of that and would be wrong the
      day Chromium learns another spelling; `hasSwitch` is Chromium's own parser answering. So the
      guard is handed the question and asks it about both switches.
    */
    const asked: string[] = []
    refusedDebugSwitch(
      (name) => {
        asked.push(name)
        return false
      },
      { packaged: true }
    )
    expect(asked).toEqual(['remote-debugging-port', 'remote-debugging-pipe'])
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

describe('addresses handed in from outside the browser', () => {
  /*
    The operating system, another application or a second launch of Tessera can each name an address
    to open, and none of them is a user typing into the address bar. `build/installer.nsh` registers the
    browser for web links with `"%1"`, so whatever follows the executable on that command line arrives
    here — and a shortcut or a `.desktop` file can put anything there. Only a web page may come in this
    way; an internal page opened from outside would inherit that page's channels, and a local file is a
    document able to read its neighbours.
  */
  it('accepts a web address', () => {
    expect(acceptExternalAddress('https://a.test/')).toBe('https://a.test/')
    expect(acceptExternalAddress('http://a.test/path?q=1')).toBe('http://a.test/path?q=1')
  })

  it('accepts a scheme in capitals, as a shell may pass it', () => {
    expect(acceptExternalAddress('HTTPS://A.test')).toBe('https://a.test/')
  })

  it('refuses everything that is not a web address', () => {
    for (const refused of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'tessera://settings',
      'data:text/html,<p>hi</p>',
      'ftp://a.test/',
      'a.test',
      '--flag',
      ''
    ]) {
      expect(acceptExternalAddress(refused), refused).toBeNull()
    }
  })
})

describe('the address a first launch was started with', () => {
  it('finds the address after the executable', () => {
    // How Windows and Linux open a link while the browser is closed: `tessera.exe "%1"`.
    expect(firstExternalAddress(['tessera.exe', 'https://a.test/'])).toBe('https://a.test/')
  })

  it('ignores switches and paths on the way to it', () => {
    /*
      Chromium adds switches of its own on Windows, and a development launch carries the entry script;
      a Windows path such as `C:\Tessera\tessera.exe` even parses as an address with the scheme `c:`,
      which is exactly why the scheme is checked rather than "does it parse".
    */
    expect(
      firstExternalAddress([
        'C:\\Program Files\\Tessera\\tessera.exe',
        '--allow-file-access-from-files',
        '/usr/lib/tessera/resources/app.asar',
        'file:///etc/passwd',
        'https://a.test/',
        'https://b.test/'
      ])
    ).toBe('https://a.test/')
  })

  it('finds nothing on an ordinary launch', () => {
    expect(firstExternalAddress(['tessera.exe', '--run-checks=/tmp/x.mjs'])).toBeNull()
    expect(firstExternalAddress([])).toBeNull()
  })
})

describe('the address a second launch hands over', () => {
  /*
    The second instance reads its own command line and sends the answer as `additionalData`, because the
    `argv` the running instance receives is not the one that was typed: it carries switches Chromium added,
    and is empty when the second launch runs as another user. The raw `argv` is still the fallback, for a
    second instance that sent nothing — a build from before the lock carried any data.
  */
  it('takes the address the second instance sent', () => {
    expect(
      secondInstanceAddress({ url: 'https://a.test/' }, ['tessera.exe', 'https://b.test/'])
    ).toBe('https://a.test/')
  })

  it('checks what was sent rather than trusting it', () => {
    // Any process running as this user can take the lock's other end; what it sends is input.
    expect(secondInstanceAddress({ url: 'file:///etc/passwd' }, ['tessera.exe'])).toBeNull()
  })

  it('falls back to the command line when nothing usable was sent', () => {
    const argv = ['tessera.exe', '--flag', 'https://b.test/']
    for (const data of [undefined, null, {}, { url: null }, { url: 5 }, 'https://c.test/']) {
      expect(secondInstanceAddress(data, argv), JSON.stringify(data)).toBe('https://b.test/')
    }
  })

  it('finds nothing when neither names an address', () => {
    expect(secondInstanceAddress({ url: null }, ['tessera.exe'])).toBeNull()
  })
})

describe('the window an address from outside opens in', () => {
  const normal = (name: string) => ({ name, privateMode: false })
  const secret = (name: string) => ({ name, privateMode: true })

  it('is the normal window focused most recently, even with a private one in front', () => {
    /*
      A link clicked in a mail client says nothing about wanting privacy, and a private window's tabs
      leave no history — so a link landing there would be a visit the user never gets to see again, in a
      session they did not choose for it.
    */
    const windows = [secret('front'), normal('recent'), normal('older')]
    expect(externalAddressWindow(windows)?.name).toBe('recent')
  })

  it('is a new normal window when only private windows are open', () => {
    expect(externalAddressWindow([secret('a'), secret('b')])).toBeUndefined()
  })

  it('is a new normal window when no window is open', () => {
    expect(externalAddressWindow([])).toBeUndefined()
  })
})

describe('the inbox that holds addresses until there is a window for them', () => {
  /*
    A link that starts the browser arrives long before a window exists: on macOS as `open-url` before
    `ready`, on Windows and Linux on the command line. The session is restored first, so the link opens
    beside the restored windows rather than being lost to them — or, as before, lost outright, because the
    handler that would have opened it was only attached after the restore.
  */
  it('holds what arrives before delivery starts, and hands it over in order', () => {
    const inbox = new ExternalAddressInbox()
    inbox.receive('https://a.test/')
    inbox.receive('https://b.test/')
    const opened: string[] = []
    inbox.deliverTo((address) => opened.push(address))
    expect(opened).toEqual(['https://a.test/', 'https://b.test/'])
  })

  it('hands over directly once delivery has started, and only once', () => {
    const inbox = new ExternalAddressInbox()
    inbox.receive('https://a.test/')
    const opened: string[] = []
    inbox.deliverTo((address) => opened.push(address))
    inbox.receive('https://b.test/')
    expect(opened).toEqual(['https://a.test/', 'https://b.test/'])
  })

  it('drops anything that is not a web address, and nothing at all', () => {
    const inbox = new ExternalAddressInbox()
    inbox.receive('tessera://settings')
    inbox.receive(null)
    const opened: string[] = []
    inbox.deliverTo((address) => opened.push(address))
    inbox.receive('javascript:alert(1)')
    expect(opened).toEqual([])
  })
})
