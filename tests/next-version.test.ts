import { describe, expect, it } from 'vitest'
// @ts-expect-error release tooling is plain ESM, deliberately outside both TypeScript programs so that
// nothing only a release needs can reach the application; there is no declaration file to import.
import { PRERELEASE, levelFrom, nextVersion, tagFor } from '../scripts/next-version.mjs'

/**
 * Where a release number goes next.
 *
 * This existed as five lines inside `release.mjs` with no test and a comment claiming the two examples in
 * its header were the tests. It bumped the **patch**, and that was wrong in the way a version number is
 * uniquely able to be wrong: it is valid, no tool objects, and it *claims* something untrue. `0.1.1` says
 * "since 0.1.0, bug fixes only" — so publishing a release full of features as a patch tells the reader of
 * a changelog the opposite of what happened, for ever, because a published version cannot be renamed.
 *
 * The other failure the ordering guards against is worse than misleading. Publish an alpha whose target is
 * a version that is already out — `0.1.0-alpha.4` after `0.1.0` — and the release channel is offered
 * nothing at all while every alpha user is offered a version *older* than the one they are running.
 */

const bump = nextVersion as (current: string, level?: 'major' | 'minor' | 'patch' | null) => string
const marker = PRERELEASE as string
const tag = tagFor as (version: string) => string
const level = levelFrom as (argv: readonly string[]) => 'major' | 'minor' | 'patch' | null

describe('from a release', () => {
  it('raises the minor by default, because an alpha carries features', () => {
    expect(bump('0.1.0')).toBe(`0.2.0-${marker}`)
  })

  it('raises the patch when the release really is fixes only', () => {
    expect(bump('0.1.0', 'patch')).toBe(`0.1.1-${marker}`)
  })

  it('raises the major and clears what is below it', () => {
    // `1.2.3 → 2.0.0`, not `2.2.3`: a major carries the minor and patch back to zero.
    expect(bump('1.2.3', 'major')).toBe(`2.0.0-${marker}`)
  })

  it('clears the patch when the minor moves', () => {
    expect(bump('0.1.7')).toBe(`0.2.0-${marker}`)
  })

  it('always lands above the version it came from', () => {
    /*
      The property that matters more than any single step. An alpha targeting a version that is already
      published sorts *below* it, and the visible result is a release channel offered nothing and an alpha
      channel offered a downgrade — so this is checked for every level from a version with all three parts
      non-zero, where a wrong carry is easiest to make.
    */
    for (const step of ['major', 'minor', 'patch'] as const) {
      const next = bump('1.2.3', step)
      const [releasePart] = next.split('-')
      expect(compare(releasePart ?? '', '1.2.3'), `${step} → ${next}`).toBe(1)
    }
  })
})

describe('while already on a prerelease', () => {
  it('raises the minor again, because there is no counter to advance', () => {
    /*
      The consequence of the `0.2.0-ALPHA` shape, and the reason it has to be said out loud: there is
      nowhere to put a second alpha of one minor. So the step from a prerelease is the same step as from a
      release — and it must be. Publishing `0.2.0-ALPHA` twice would mean two different builds answering
      to one version, and every installation of the first would be certain it was already up to date.
    */
    expect(bump(`0.2.0-${marker}`)).toBe(`0.3.0-${marker}`)
  })

  it('raises the target from the release part, not from the marker', () => {
    // `--patch` from `0.2.0-ALPHA` targets `0.2.1`, not `0.2.0` again.
    expect(bump(`0.2.0-${marker}`, 'patch')).toBe(`0.2.1-${marker}`)
    expect(bump(`0.2.0-${marker}`, 'major')).toBe(`1.0.0-${marker}`)
  })

  it('never returns the version it was given', () => {
    // The one outcome that cannot be allowed at any level, from either shape.
    for (const current of ['0.1.0', `0.2.0-${marker}`, '1.2.3', `1.2.3-${marker}`]) {
      for (const step of [null, 'major', 'minor', 'patch'] as const) {
        expect(bump(current, step), `${current} ${step ?? 'default'}`).not.toBe(current)
      }
    }
  })
})

describe('the tag', () => {
  it('is the version with a v, from one place', () => {
    // One function, so the tag and the published release can never disagree about the name.
    expect(tag('0.2.0-ALPHA')).toBe('v0.2.0-ALPHA')
  })

  it('uses upper case, and that is load-bearing', () => {
    /*
      Semver compares prerelease identifiers as ASCII, where upper case sorts *below* lower case — so
      `0.2.0-ALPHA` is older than `0.2.0-alpha`. Mixing the two across releases would produce an ordering
      nobody expects, which is why only one of them is ever written.
    */
    expect(marker).toBe(marker.toUpperCase())
    expect(bump('0.1.0')).not.toContain('alpha')
  })
})

describe('what it refuses', () => {
  it('throws for anything that is not a version it can step from', () => {
    // Loudly rather than guessing: this runs once, by hand, and a wrong guess is published for ever.
    for (const bad of ['', 'latest', '1.2', '0.1.0-beta.1', '0.1.0-alpha', 'v0.1.0']) {
      expect(() => bump(bad), bad).toThrow(/neither x\.y\.z/)
    }
  })
})

describe('the level from a command line', () => {
  it('is null when none is named, which means the default applies', () => {
    expect(level(['--dry-run'])).toBeNull()
  })

  it('reads each of the three', () => {
    expect(level(['--patch'])).toBe('patch')
    expect(level(['--minor'])).toBe('minor')
    expect(level(['--major'])).toBe('major')
  })

  it('prefers the largest step when more than one is named', () => {
    // A contradiction on the command line is a mistake, and of the two readings the larger step is the
    // recoverable one: too high a version is a number nobody uses, too low is a version that sorts wrong.
    expect(level(['--patch', '--major'])).toBe('major')
  })
})

/** Numeric comparison of an `x.y.z`, enough for the property above. */
function compare(left: string, right: string): number {
  const parts = (value: string): number[] => value.split('.').map(Number)
  const a = parts(left)
  const b = parts(right)
  for (let index = 0; index < 3; index += 1) {
    const [x] = a.slice(index, index + 1)
    const [y] = b.slice(index, index + 1)
    if (x !== y) return (x ?? 0) < (y ?? 0) ? -1 : 1
  }
  return 0
}
