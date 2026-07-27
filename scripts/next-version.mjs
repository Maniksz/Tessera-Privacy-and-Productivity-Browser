/**
 * Where the version goes next.
 *
 * ## The shape: `0.2.0-ALPHA`
 *
 * A prerelease marker with no counter, so the *release* part carries the count: `0.2.0-ALPHA`,
 * `0.3.0-ALPHA`, `0.4.0-ALPHA`. That is the form asked for, and it is coherent as long as the minor
 * moves every time — which it does, because every alpha of this browser carries features.
 *
 * The consequence, stated because it is a real constraint rather than a detail: **two alphas of the same
 * minor are impossible.** There is nowhere to put the second. If a published alpha needs a fix without a
 * feature, that is `--patch` and it becomes `0.2.1-ALPHA`.
 *
 * ## Why the minor and not the patch
 *
 * A first version of this bumped the patch, and that is wrong in the one way a version number can be:
 * `0.1.1` is valid, no tool objects, and it *claims* something untrue — "since 0.1.0, bug fixes only".
 * Publishing a release full of features under it tells the reader of a changelog the opposite of what
 * happened, for ever, because a published version cannot be renamed.
 *
 * ## Upper case, and the trap in it
 *
 * `ALPHA` is what the tags are to read. Semver compares prerelease identifiers as ASCII, where upper case
 * sorts *below* lower case — so `0.2.0-ALPHA` is older than `0.2.0-alpha`. Mixing the two cases across
 * releases would produce an ordering nobody expects, which is why this file only ever writes one of them.
 *
 * Kept out of `src/` because nothing in the application needs it; the *ordering* rules the browser does
 * need live in `src/main/updates/version.ts` and are tested there.
 */

/** @typedef {'major' | 'minor' | 'patch'} Level */

/** The marker every prerelease here carries. Upper case; see the note above. */
export const PRERELEASE = 'ALPHA'

const PATTERN = new RegExp(`^(\\d+)\\.(\\d+)\\.(\\d+)(?:-${PRERELEASE})?$`)

/**
 * The next version, for a release at the given level.
 *
 * @param {string} current
 * @param {Level | null} level `null` means the ordinary step, which is the minor.
 * @returns {string}
 */
export function nextVersion(current, level = null) {
  const match = PATTERN.exec(current.trim())
  if (match === null) {
    throw new Error(
      `version "${current}" is neither x.y.z nor x.y.z-${PRERELEASE}, so there is no next one`
    )
  }

  const [, rawMajor, rawMinor, rawPatch] = match
  const major = Number(rawMajor)
  const minor = Number(rawMinor)
  const patch = Number(rawPatch)

  /*
    Raised from the release part in every case, including when the current version is already a
    prerelease. There is no counter to advance, so `0.2.0-ALPHA` steps to `0.3.0-ALPHA` — and it must,
    because publishing `0.2.0-ALPHA` twice would mean two different builds answering to one version, and
    every installation would then be certain it was already up to date.
  */
  const step = level ?? 'minor'
  if (step === 'major') return `${major + 1}.0.0-${PRERELEASE}`
  if (step === 'patch') return `${major}.${minor}.${patch + 1}-${PRERELEASE}`
  return `${major}.${minor + 1}.0-${PRERELEASE}`
}

/**
 * The level named on a command line, or `null`.
 *
 * @param {readonly string[]} argv
 * @returns {Level | null}
 */
export function levelFrom(argv) {
  if (argv.includes('--major')) return 'major'
  if (argv.includes('--minor')) return 'minor'
  if (argv.includes('--patch')) return 'patch'
  return null
}

/** The git tag for a version. One place, so the tag and the release can never disagree. */
export function tagFor(version) {
  return `v${version}`
}
