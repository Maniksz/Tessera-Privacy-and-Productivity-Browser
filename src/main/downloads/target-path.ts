import { isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { numberedFileName } from '@shared/media/url.js'
import { safeDownloadFileName } from '@shared/downloads/filename.js'

/**
 * Where a download lands.
 *
 * ## Why the containment check stays, given the sanitiser
 *
 * `safeDownloadFileName` already guarantees a name with no separators, so the join below
 * cannot escape — today. The check is kept because it is the *structural* guarantee at the
 * one place a path is actually built: it holds whatever the name came from, including a
 * future caller who acquires a name by some other route and does not know about the
 * sanitiser. Belt and braces, where the braces are load-bearing and the belt costs a
 * `startsWith`.
 *
 * That also makes the failure representable: a rejected path is `null`, and the caller
 * cancels the download instead of writing somewhere unexpected. There is no branch here that
 * proceeds hopefully.
 *
 * ## Why the directory is resolved rather than trusted
 *
 * `downloads.directory` is a setting, so it is text the user typed or a previous build wrote.
 * A relative value would resolve against the process's working directory — which for a
 * packaged application is somewhere nobody chose, often `/`. So an empty or relative setting
 * falls back to the platform's own downloads folder, supplied by the caller from
 * `app.getPath('downloads')`; `paths.ts` owns that decision, and this module never asks
 * Electron anything.
 */

export interface SavePathRequest {
  /** From `downloads.directory`; may be empty or relative. */
  directory: string
  /** From `app.getPath('downloads')`, used when `directory` is unusable. */
  fallbackDirectory: string
  /** As proposed by the server or by Chromium. Sanitised here. */
  fileName: string
}

export interface SavePathProbes {
  /**
   * True when something already occupies the path.
   *
   * Synchronous, and that is a hard requirement rather than a simplification.
   * `DownloadItem.setSavePath` is only available inside the `will-download` callback, and a
   * handler that returns without having called it makes Electron show its own save dialogue.
   * So the whole decision — including this probe — has to happen before the handler yields;
   * a promise here would compile, read well, and produce a save dialogue for every download.
   * See `DownloadManager`.
   */
  exists: (path: string) => boolean
}

/**
 * How many alternative names are tried before giving up.
 *
 * A ceiling rather than a `while (true)`: the loop's exit depends on the filesystem, and a
 * directory that answers "exists" for every name — a permission problem, an exotic mount —
 * would otherwise hang the main process during a download the user is watching. Two hundred
 * copies of one file is well past anything deliberate.
 */
export const MAX_SAVE_PATH_ATTEMPTS = 200

/** The directory a download should go to, absolute, with the fallback applied. */
export function downloadDirectoryOf(request: SavePathRequest): string {
  const configured = request.directory.trim()
  if (configured !== '' && isAbsolute(configured)) return normalize(configured)
  return normalize(resolve(request.fallbackDirectory))
}

/**
 * The path a download is written to, or `null` when no safe one exists.
 *
 * Numbered around whatever is already there, using the same `numberedFileName` the media
 * downloader uses — one rule for "that name is taken", so two features cannot disagree about
 * what the second copy of a file is called.
 *
 * The `.part`-sibling check that `MediaDownloader` performs is deliberately absent: Electron
 * writes its own `.crdownload` intermediate and renames it, and inventing a second suffix
 * convention here would make the two collide.
 */
export function resolveSavePath(
  request: SavePathRequest,
  probes: SavePathProbes
): string | null {
  const directory = downloadDirectoryOf(request)
  const fileName = safeDownloadFileName(request.fileName)

  for (let attempt = 1; attempt <= MAX_SAVE_PATH_ATTEMPTS; attempt += 1) {
    const candidate = normalize(join(directory, numberedFileName(fileName, attempt)))
    // After resolution, not before: `normalize` has already collapsed any `..`, so this
    // catches traversal by asking where the path *ended up* rather than by looking for a
    // pattern in the string it started as. The same check `protocol.ts` performs on an asset
    // address, and for the same reason.
    if (!candidate.startsWith(directory + sep)) return null
    if (!probes.exists(candidate)) return candidate
  }
  return null
}
