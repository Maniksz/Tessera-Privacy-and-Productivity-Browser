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
