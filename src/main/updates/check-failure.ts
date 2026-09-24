import type { UpdateFeedResult } from './UpdateService.js'

/**
 * Which of the ordinary failures a thrown `checkForUpdates()` was.
 *
 * Matched on `electron-updater`'s own error codes and, for one case, its message — which is the
 * brittle part and the reason it is here rather than in the service. Anything unrecognised degrades
 * to "unreachable", which is a true sentence about every one of these cases. The others are named
 * separately because "GitHub could not be reached" would be a lie: the repository was reached and
 * has nothing to offer.
 *
 * Kept out of `install-updates.ts` so it can be tested: that adapter is excluded from coverage, and
 * a classifier nobody runs is how the stable channel's wrong answer survived.
 */
export function classifyCheckFailure(error: unknown): UpdateFeedResult {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  if (isNoStableRelease(code, error)) return { kind: 'no-stable-release' }
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === LATEST_VERSION_NOT_FOUND) {
    return { kind: 'nothing-published' }
  }
  return { kind: 'unreachable', detail: String(error) }
}

const LATEST_VERSION_NOT_FOUND = 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND'

/**
 * GitHub answering "there is no latest release" — every release is a prerelease.
 *
 * Only the `stable` channel asks (`allowPrerelease: false` is what sends the library to
 * `/releases/latest`), and with nothing but prereleases GitHub redirects that address to the release
 * list, which answers a JSON request with 406; a 404 is the same answer from the API host. The
 * library turns that into `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` and, in 6.x, wraps it again as
 * `ERR_UPDATER_INVALID_RELEASE_FEED` with the first message quoted inside — so the message is what
 * is matched, and the HTTP status in it is what keeps a dropped connection on that same request out.
 */
function isNoStableRelease(code: unknown, error: unknown): boolean {
  if (code !== LATEST_VERSION_NOT_FOUND && code !== 'ERR_UPDATER_INVALID_RELEASE_FEED') return false
  return NO_LATEST_RELEASE.test((error as Error).message)
}

const NO_LATEST_RELEASE = /Unable to find latest version on GitHub.*HttpError: 40[46]\b/s
