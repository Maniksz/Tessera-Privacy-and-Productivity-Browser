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
