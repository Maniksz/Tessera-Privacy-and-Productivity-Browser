/**
 * Which of two versions is newer, and whether an offer is one the user asked to see.
 *
 * ## Why this is a module and not two lines at the call site
 *
 * `electron-updater` compares versions itself, and the temptation is to let it. But the *policy* — an
 * alpha user sees alphas, a stable user does not, and neither is ever offered a step backwards — is the
 * part that decides what a person is shown, and it has exactly the shape of a rule that looks obvious
 * and is not:
 *
 *   - `0.1.0-alpha.2` is **older** than `0.1.0-alpha.10`. Compared as strings, `"10" < "2"`, so a
 *     naive check offers `alpha.2` to somebody on `alpha.10` — a downgrade presented as an update.
 *   - `0.1.0-alpha.3` is **older** than `0.1.0`. A release is newer than every one of its own
 *     prereleases, which is the opposite of the alphabetical answer.
 *   - `0.2.0-alpha.1` is **newer** than `0.1.0`, so an alpha channel does have to cross releases.
 *
 * Getting any of these wrong is invisible until somebody is on the wrong version, and by then the
 * evidence is gone. So it is pure, and it is tested.
 *
 * ## What it deliberately does not do
 *
 * It does not fetch, and it does not decide *when* to look. It answers "is this an upgrade for this
 * user?" — nothing else. Network, consent and timing live in the caller, because those are the parts
 * that need a setting and a person.
 */

/** Which releases a user has asked to be told about. */
export type UpdateChannel = 'stable' | 'alpha'

interface Parsed {
  readonly release: readonly number[]
  /** The dot-separated identifiers after `-`, empty for a release. */
  readonly prerelease: readonly string[]
}

/**
 * Splits a version, tolerating what it is not.
 *
 * `null` for anything unparseable rather than a throw: the version on the other side comes off the
 * network, and a malformed tag in somebody's repository must mean "no update offered", not a crash in
 * the update check of a browser that is otherwise working.
 *
 * A leading `v` is accepted because git tags conventionally carry one and release names are written
 * both ways.
 */
export function parseVersion(version: string): Parsed | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
    version.trim()
  )
  if (match === null) return null

  const [, major, minor, patch, prerelease] = match
  if (major === undefined || minor === undefined || patch === undefined) return null

  return {
    release: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined || prerelease === '' ? [] : prerelease.split('.')
  }
}

/** True for a version with a prerelease part, which is what "an alpha" means here. */
export function isPrerelease(version: string): boolean {
  const parsed = parseVersion(version)
  return parsed !== null && parsed.prerelease.length > 0
}

/**
 * `-1`, `0` or `1`, as a comparator reads.
 *
 * Unparseable sorts as *equal* rather than lower, so a bad tag can never be an upgrade in either
 * direction; `isUpgrade` refuses it outright.
 */
export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (a === null || b === null) return 0

  for (let index = 0; index < 3; index += 1) {
    const [x] = a.release.slice(index, index + 1)
    const [y] = b.release.slice(index, index + 1)
    if (x !== y) return (x ?? 0) < (y ?? 0) ? -1 : 1
  }

  return comparePrerelease(a.prerelease, b.prerelease)
}

/**
 * The rule that surprises people: *no* prerelease outranks any prerelease.
 *
 * `1.0.0` is newer than `1.0.0-alpha.9`, because the prerelease is a step on the way to the release
 * rather than a version after it. Handled first, before any identifier is looked at.
 */
function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length === 0) return 0
  if (left.length === 0) return 1
  if (right.length === 0) return -1

  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    const [a] = left.slice(index, index + 1)
    const [b] = right.slice(index, index + 1)
    // A shorter run of identifiers is the lower version: `alpha` precedes `alpha.1`.
    if (a === undefined) return -1
    if (b === undefined) return 1
    const step = compareIdentifiers(a, b)
    if (step !== 0) return step
  }
  return 0
}

/**
 * Numeric identifiers compare as numbers, everything else as text, and a number is lower than text.
 *
 * The numeric case is the whole reason this function exists: `alpha.10` must beat `alpha.2`, and it is
 * the comparison a string sort gets backwards.
 */
function compareIdentifiers(left: string, right: string): number {
  const numeric = /^\d+$/
  const leftIsNumber = numeric.test(left)
  const rightIsNumber = numeric.test(right)

  if (leftIsNumber && rightIsNumber) {
    const a = Number(left)
    const b = Number(right)
    return a === b ? 0 : a < b ? -1 : 1
  }
  if (leftIsNumber) return -1
  if (rightIsNumber) return 1
  return left === right ? 0 : left < right ? -1 : 1
}

/**
 * Whether `candidate` is something to offer somebody running `current` on this channel.
 *
 * Three refusals, and each one is a way a user gets hurt:
 *
 *   - **Not newer.** Includes equal, and includes unparseable on either side.
 *   - **A prerelease offered to a stable user.** They did not ask to test anything, and an alpha of a
 *     browser is a thing that can lose their session.
 *   - Nothing else. An alpha user *is* offered a stable release when it is newer, because a release is
 *     the destination the alphas were heading for — refusing it would strand them on a prerelease for
 *     ever.
 */
export function isUpgrade(input: {
  current: string
  candidate: string
  channel: UpdateChannel
}): boolean {
  if (parseVersion(input.current) === null || parseVersion(input.candidate) === null) return false
  if (input.channel === 'stable' && isPrerelease(input.candidate)) return false
  return compareVersions(input.candidate, input.current) > 0
}

/**
 * The newest of a list that this user should be told about, or `null`.
 *
 * Written as a fold rather than a sort because the answer is one element and a sort invites the reader
 * to wonder whether the *order* is meaningful elsewhere. Every candidate goes through `isUpgrade`, so a
 * malformed tag in the middle of the list cannot become the answer.
 */
export function bestUpgrade(input: {
  current: string
  candidates: readonly string[]
  channel: UpdateChannel
}): string | null {
  let best: string | null = null
  for (const candidate of input.candidates) {
    if (!isUpgrade({ current: input.current, candidate, channel: input.channel })) continue
    if (best === null || compareVersions(candidate, best) > 0) best = candidate
  }
  return best
}
