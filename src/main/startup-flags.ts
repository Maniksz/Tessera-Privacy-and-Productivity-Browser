import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The two settings that have to be known *before* the application is ready.
 *
 * ## Why they cannot come from `settings.json`
 *
 * Both become Chromium command-line switches, and switches must be set before `app.whenReady()`.
 * Until now `bootstrapFlags` read `settings.json` synchronously at that point. Once that file is
 * encrypted, the read fails and lands in a `catch` — and `advanced.hardwareAcceleration: false`
 * would silently stop taking effect, with nothing to see anywhere. A setting that quietly reverts
 * is worse than one that never existed.
 *
 * Decryption cannot happen there either: `safeStorage` is not reliable before `ready` on Linux,
 * which is exactly where the keyring question is open.
 *
 * ## Why a second file is the right answer
 *
 * The alternatives were worse. Applying the flags one launch late breaks the promise the settings
 * UI makes — it says "takes effect after restarting", not "after the one after that". Relaunching
 * the application to apply them is user-hostile. So: a tiny file, written whenever settings change,
 * read synchronously at startup.
 *
 * It is deliberately **not** encrypted, and that is a narrow, defensible exception rather than a
 * hole. Whether hardware acceleration is on and whether background tiles are throttled says
 * nothing about the user — no address, no search, no name. There is nothing here to protect.
 */

export interface StartupFlags {
  hardwareAcceleration: boolean
  throttleBackgroundContent: boolean
}

/**
 * Reads the flags, falling back to `defaults` for anything missing or malformed.
 *
 * Synchronous because the caller runs before the event loop is a useful place to be, and tolerant
 * because a missing file is the normal first-launch case. Every value is checked individually: a
 * file holding one usable flag and one broken one should honour the usable half.
 */
export function readStartupFlags(filePath: string, defaults: StartupFlags): StartupFlags {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return defaults
    const stored = parsed as Record<string, unknown>
    return {
      hardwareAcceleration:
        typeof stored['hardwareAcceleration'] === 'boolean'
          ? stored['hardwareAcceleration']
          : defaults.hardwareAcceleration,
      throttleBackgroundContent:
        typeof stored['throttleBackgroundContent'] === 'boolean'
          ? stored['throttleBackgroundContent']
          : defaults.throttleBackgroundContent
    }
  } catch {
    // No file yet, or unreadable. Defaults are the right answer either way, and unlike the
    // settings file there is nothing here worth preserving — the next write regenerates it.
    return defaults
  }
}

/**
 * The switch that makes this build drive its own checks instead of waiting for a user.
 *
 * Named `--run-checks=<module>` and carrying a path, because the checks must *not* live in the
 * main bundle: they are a thousand lines of assertions that every user would otherwise parse at
 * every launch, against a size budget that is already over. So the core knows how to load a
 * module, and nothing about what is in it.
 */
const CHECK_MODULE_SWITCH = '--run-checks='

/**
 * The check module named on the command line, or `null` for a normal launch.
 *
 * ## Why it is refused in a packaged build
 *
 * This switch says "load this file from disk and run it in the browser process", which is a
 * code-execution route with a command line for a key: a tampered shortcut, a `.desktop` file or
 * anything that can launch the browser with arguments would own the process. Development builds
 * are started by the developer who wrote the module; a shipped one has no such assurance, so the
 * switch does not exist there at all. `app.isPackaged` is the caller's to supply — this stays a
 * pure function so the refusal itself is testable.
 *
 * The last occurrence wins, as Chromium's own switch parsing does: the run script appends the
 * switch, and a stale one already on the command line must not silently beat it.
 */
export function readCheckModule(
  argv: readonly string[],
  options: { packaged: boolean }
): string | null {
  if (options.packaged) return null
  const named = argv.filter((argument) => argument.startsWith(CHECK_MODULE_SWITCH))
  const [last] = named.slice(-1)
  if (last === undefined) return null
  const modulePath = last.slice(CHECK_MODULE_SWITCH.length)
  // `--run-checks=` with nothing after it names no module. Treated as absent rather than as an
  // error, because the alternative is a browser that refuses to start over a typo in a switch it
  // only has in development.
  return modulePath === '' ? null : modulePath
}

/** The subset of the settings snapshot that reaches the command line. */
export function startupFlagsFrom(settings: SettingsSnapshot): StartupFlags {
  return {
    hardwareAcceleration: settings['advanced.hardwareAcceleration'],
    throttleBackgroundContent: settings['splitView.throttleInactiveTiles']
  }
}

/**
 * Writes the flags for the next launch.
 *
 * Write-then-rename, so a crash mid-write cannot leave a half-written file that the next startup
 * would read as "no usable flags" — the one failure mode that would make this file worse than the
 * problem it solves.
 */
export async function writeStartupFlags(filePath: string, flags: StartupFlags): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temp = `${filePath}.tmp`
  await writeFile(temp, `${JSON.stringify(flags, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, filePath)
}

/*
  Addresses handed in from outside the browser.

  They live here rather than in `index.ts` because they are startup decisions of the same kind as the
  two above — read off the command line, before anything is ready — and `index.ts` is excluded from
  coverage as Electron-bound. Every rule below used to be a line in that file, and two of them were wrong
  there without a number ever saying so: a link that started the browser was lost, because the handler
  that would have opened it was attached only after the session was restored; and one arriving while a
  private window was focused opened in that window.
*/

/**
 * The address, if it is one a page outside the browser may open, and `null` otherwise.
 *
 * Web addresses only. The command line, `open-url` and a second launch are all input from outside:
 * `build/installer.nsh` registers the browser for links with `"%1"`, so a shortcut or a `.desktop` file
 * can put anything after the executable. An internal page opened that way would be one no user asked
 * for, and a `file:` document is one that can read its neighbours. The scheme is checked rather than
 * "does it parse", because a Windows path such as `C:\Tessera\tessera.exe` parses as an address with
 * the scheme `c:`.
 */
export function acceptExternalAddress(candidate: string): string | null {
  if (!URL.canParse(candidate)) return null
  const address = new URL(candidate)
  return address.protocol === 'https:' || address.protocol === 'http:' ? address.href : null
}

/**
 * The first web address on a command line, or `null` for an ordinary launch.
 *
 * Windows and Linux open a link in a closed browser as `tessera.exe <address>`, but the address is not
 * reliably the second argument: Chromium adds switches of its own, and a development launch carries the
 * entry script. So the whole line is searched, and the first acceptable address wins.
 */
export function firstExternalAddress(argv: readonly string[]): string | null {
  for (const argument of argv) {
    const address = acceptExternalAddress(argument)
    if (address !== null) return address
  }
  return null
}

/**
 * The address a second launch hands to the running browser.
 *
 * The second instance sends what it found on its own command line as `additionalData`, and that is
 * preferred: the `argv` the running instance is given carries switches Chromium added on the way, and
 * Electron leaves it empty when the second launch runs as a different user. That raw `argv` is still
 * searched when nothing usable was sent — a build from before the lock carried any data. Either way the
 * result is checked here: any process running as this user can reach the other end of the lock.
 */
export function secondInstanceAddress(
  additionalData: unknown,
  argv: readonly string[]
): string | null {
  const sent =
    additionalData !== null && typeof additionalData === 'object' && 'url' in additionalData
      ? additionalData.url
      : undefined
  return typeof sent === 'string' ? acceptExternalAddress(sent) : firstExternalAddress(argv)
}

/**
 * The window an address from outside opens in: the normal window focused most recently, or `undefined`
 * for "open a new normal window".
 *
 * Never a private one, even the one in front. A link clicked in a mail client says nothing about wanting
 * privacy, and a private window keeps no history — the visit would be one the user never finds again,
 * in a session they did not choose for it. That is the case the old `focused() ?? controllers[0]` got
 * wrong, and it got the other one wrong as well: with nothing focused — the usual state while another
 * application is in front — it fell back to the *oldest* window rather than the last one used.
 */
export function externalAddressWindow<W extends { readonly privateMode: boolean }>(
  mostRecentFirst: readonly W[]
): W | undefined {
  return mostRecentFirst.find((window) => !window.privateMode)
}

/**
 * Holds addresses from outside until there is somewhere to open them.
 *
 * A link that starts the browser arrives before any window exists — on macOS as `open-url` before
 * `ready`, elsewhere on the command line — and a second launch can arrive while the stores are still
 * opening. Everything is held until `deliverTo` is called, which the entry point does once the previous
 * session is back: opened earlier, a link would land in a window that the restore then buries.
 *
 * Checks each address on the way in, so no caller can hand over one that `acceptExternalAddress` would
 * refuse.
 */
export class ExternalAddressInbox {
  #pending: string[] = []
  #open: ((address: string) => void) | null = null

  receive(candidate: string | null): void {
    const address = candidate === null ? null : acceptExternalAddress(candidate)
    if (address === null) return
    if (this.#open === null) this.#pending.push(address)
    else this.#open(address)
  }

  /** Opens everything held so far, in the order it arrived, and every later address as it comes. */
  deliverTo(open: (address: string) => void): void {
    this.#open = open
    const held = this.#pending
    this.#pending = []
    for (const address of held) open(address)
  }
}
