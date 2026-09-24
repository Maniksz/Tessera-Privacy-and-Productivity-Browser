import { describe, expect, it } from 'vitest'
import { classifyCheckFailure } from '@main/updates/check-failure.js'

/**
 * Which sentence a thrown `checkForUpdates()` turns into.
 *
 * The fixtures are `electron-updater` 6.x's own errors, message and code, as it throws them. The one
 * that matters most is the first: the `stable` channel against a repository whose every release is
 * a prerelease. GitHub redirects `/releases/latest` to the release list, which answers the library's
 * JSON request with 406, and the library wraps that twice. Read as "unreachable", that user was told
 * GitHub could not be reached — on every check, for as long as no stable release exists.
 */

function updaterError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code })
}

const LATEST_URL = 'https://github.com/owner/repo/releases/latest'

/** Verbatim in shape: what 6.8.9 throws on `stable` while only prereleases are published. */
const NO_STABLE_RELEASE_WRAPPED = updaterError(
  'ERR_UPDATER_INVALID_RELEASE_FEED',
  `Cannot parse releases feed: Error: Unable to find latest version on GitHub (${LATEST_URL}), please ensure a production release exists: HttpError: 406 Not Acceptable\n"method: GET url: https://github.com/owner/repo/releases"\nHeaders: {}\n    at createHttpError (httpExecutor.js:53:12),\nXML:\n<feed/>`
)

describe('classifying a failed update check', () => {
  it('recognises the stable channel with no stable release, as the library throws it today', () => {
    expect(classifyCheckFailure(NO_STABLE_RELEASE_WRAPPED)).toEqual({ kind: 'no-stable-release' })
  })

  it('recognises it unwrapped, and with the API host’s 404', () => {
    const unwrapped = updaterError(
      'ERR_UPDATER_LATEST_VERSION_NOT_FOUND',
      `Unable to find latest version on GitHub (${LATEST_URL}), please ensure a production release exists: HttpError: 404 Not Found`
    )
    expect(classifyCheckFailure(unwrapped)).toEqual({ kind: 'no-stable-release' })
  })

  it('does not read a dropped connection on that same request as "no stable release"', () => {
    const dropped = updaterError(
      'ERR_UPDATER_INVALID_RELEASE_FEED',
      `Cannot parse releases feed: Error: Unable to find latest version on GitHub (${LATEST_URL}), please ensure a production release exists: Error: net::ERR_CONNECTION_RESET`
    )
    expect(classifyCheckFailure(dropped).kind).toBe('unreachable')
  })

  it('does not take the right status under the wrong code', () => {
    const elsewhere = updaterError(
      'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND',
      `Unable to find latest version on GitHub (${LATEST_URL}): HttpError: 404 Not Found`
    )
    expect(classifyCheckFailure(elsewhere).kind).toBe('unreachable')
  })

  it('keeps an empty repository as "nothing published"', () => {
    expect(
      classifyCheckFailure(
        updaterError('ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'No published versions on GitHub')
      )
    ).toEqual({ kind: 'nothing-published' })
    expect(
      classifyCheckFailure(
        updaterError('ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'Unable to find latest version')
      )
    ).toEqual({ kind: 'nothing-published' })
  })

  it('reports everything else as unreachable, with the detail kept for the console', () => {
    expect(classifyCheckFailure(new Error('net::ERR_INTERNET_DISCONNECTED'))).toEqual({
      kind: 'unreachable',
      detail: 'Error: net::ERR_INTERNET_DISCONNECTED'
    })
    expect(classifyCheckFailure('a string, not an Error')).toEqual({
      kind: 'unreachable',
      detail: 'a string, not an Error'
    })
  })
})
