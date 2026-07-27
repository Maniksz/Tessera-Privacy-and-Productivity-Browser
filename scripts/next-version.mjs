/**
 * Where the version goes next, for an alpha release.
 *
 * ## Why the default is the minor and not the patch
 *
 * A first version of this bumped the patch — `0.1.0 → 0.1.1-alpha.0` — and that is wrong in the one way
 * a version number can be wrong: it *claims* something. `0.1.1` says "since 0.1.0, bug fixes only".
 * Every alpha of this browser so far has carried features, so publishing them as a patch tells the
 * reader of a changelog the opposite of what happened, and no tool can catch it because the number is
 * perfectly valid.
 *
 * So the default is the minor, and the patch is available for the case it actually describes: an alpha
 * that only fixes something. The level is a decision about what changed, which is why it is a flag and
 * not arithmetic.
 *
 * ## The rule while already on a prerelease
 *
 * From `0.2.0-alpha.3`, the default is `0.2.0-alpha.4` — the next alpha *of the same target*. That is
 * the common case by a wide margin: several alphas lead up to one release. Naming a level while on a
 * prerelease changes the target instead and restarts the count, which is what you want when a release
 * turns out to need more than was planned.
 *
 * Kept out of `src/` because nothing in the application needs it; the *ordering* rules that the browser
 * does need live in `src/main/updates/version.ts` and are tested there.
 */

/** @typedef {'major' | 'minor' | 'patch'} Level */

const PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/

/**
 * @param {string} current
 * @param {Level | null} level `null` means "the ordinary next step".
 * @returns {string}
 */
export function nextAlpha(current, level = null) {
  const match = PATTERN.exec(current.trim())
  if (match === null) {
    throw new Error(
      `version "${current}" is neither x.y.z nor x.y.z-alpha.n, so there is no next alpha of it`
    )
  }

  const [, rawMajor, rawMinor, rawPatch, rawAlpha] = match
  const major = Number(rawMajor)
  const minor = Number(rawMinor)
  const patch = Number(rawPatch)
  const onPrerelease = rawAlpha !== undefined

  // Already an alpha and no level named: the next alpha of the same target.
  if (onPrerelease && level === null) {
    return `${major}.${minor}.${patch}-alpha.${Number(rawAlpha) + 1}`
  }

  /*
    From a release, or from a prerelease whose target is being changed.

    The target is raised from the *release* part in both cases, which is what makes the result sort above
    everything already published: an alpha of a version that is already out would sort below it, and every
    user on the release channel would be offered nothing while every alpha user was offered a step
    backwards.
  */
  const step = level ?? 'minor'
  if (step === 'major') return `${major + 1}.0.0-alpha.0`
  if (step === 'patch') return `${major}.${minor}.${patch + 1}-alpha.0`
  return `${major}.${minor + 1}.0-alpha.0`
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
