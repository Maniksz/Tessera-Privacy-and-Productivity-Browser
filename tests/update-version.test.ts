import { describe, expect, it } from 'vitest'
import {
  bestUpgrade,
  compareVersions,
  isPrerelease,
  isUpgrade,
  parseVersion
} from '@main/updates/version.js'

/**
 * Version ordering, and who is offered what.
 *
 * Every case here is a way a user gets hurt rather than an academic reading of the specification:
 *
 *   - `alpha.2` compared as text beats `alpha.10`, so a naive check offers somebody a **downgrade** and
 *     calls it an update. They accept, restart, and lose whatever the newer alpha fixed.
 *   - A release is newer than its own prereleases, which is the opposite of the alphabetical answer. Get
 *     it wrong and an alpha tester is stranded on a prerelease for ever, never offered the real thing.
 *   - A prerelease offered to somebody on the stable channel is a browser that can lose their session,
 *     handed to them because a filter was missing.
 *
 * The version on the other side arrives over the network from a repository anybody can tag, so the
 * malformed cases are not hypothetical either.
 */

describe('parsing', () => {
  it('reads a plain release', () => {
    expect(parseVersion('1.2.3')).toEqual({ release: [1, 2, 3], prerelease: [] })
  })

  it('reads a prerelease into its identifiers', () => {
    expect(parseVersion('0.1.0-alpha.3')).toEqual({
      release: [0, 1, 0],
      prerelease: ['alpha', '3']
    })
  })

  it('accepts the leading v that git tags carry', () => {
    expect(parseVersion('v0.1.0')).toEqual({ release: [0, 1, 0], prerelease: [] })
  })

  it('ignores build metadata, which is not part of the order', () => {
    expect(parseVersion('1.0.0+build.7')?.prerelease).toEqual([])
  })

  it('returns null rather than throwing for what is not a version', () => {
    // These come off the network. A malformed tag in somebody's repository must mean "no update",
    // not an exception inside the update check of a browser that is otherwise fine.
    for (const bad of ['', 'latest', '1.2', '1.2.3.4', 'v', 'nightly-2026-07-27', '1.2.x']) {
      expect(parseVersion(bad), bad).toBeNull()
    }
  })
})

describe('ordering', () => {
  it('orders numeric prerelease identifiers as numbers', () => {
    // The one that a string comparison gets backwards, and the reason this module exists.
    expect(compareVersions('0.1.0-alpha.10', '0.1.0-alpha.2')).toBe(1)
    expect(compareVersions('0.1.0-alpha.2', '0.1.0-alpha.10')).toBe(-1)
  })

  it('puts a release above every one of its own prereleases', () => {
    expect(compareVersions('0.1.0', '0.1.0-alpha.9')).toBe(1)
    expect(compareVersions('0.1.0-beta.1', '0.1.0')).toBe(-1)
  })

  it('lets a later prerelease outrank an earlier release', () => {
    // So an alpha channel does cross release boundaries; refusing to would freeze it.
    expect(compareVersions('0.2.0-alpha.1', '0.1.0')).toBe(1)
  })

  it('treats a shorter identifier run as the lower version', () => {
    expect(compareVersions('0.1.0-alpha', '0.1.0-alpha.1')).toBe(-1)
  })

  it('ranks a numeric identifier below a textual one', () => {
    expect(compareVersions('0.1.0-1', '0.1.0-alpha')).toBe(-1)
  })

  it('walks major, minor and patch in that order', () => {
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1)
    expect(compareVersions('1.2.0', '1.1.9')).toBe(1)
    expect(compareVersions('1.1.2', '1.1.1')).toBe(1)
  })

  it('calls equal versions equal', () => {
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.1')).toBe(0)
  })

  it('sorts an unparseable version as equal, so it can never be an upgrade either way', () => {
    expect(compareVersions('nonsense', '1.0.0')).toBe(0)
    expect(compareVersions('1.0.0', 'nonsense')).toBe(0)
  })

  it('is antisymmetric across every pair of a known-good ladder', () => {
    /*
      A property rather than more examples. The individual assertions above each pin one rule; this
      catches a rule that is right in isolation and inconsistent in combination — which is what a
      hand-written comparator gets wrong, and what no single example shows.
    */
    const ascending = [
      '0.1.0-alpha',
      '0.1.0-alpha.1',
      '0.1.0-alpha.2',
      '0.1.0-alpha.10',
      '0.1.0-beta.1',
      '0.1.0',
      '0.1.1',
      '0.2.0-alpha.1',
      '0.2.0',
      '1.0.0'
    ]

    for (let i = 0; i < ascending.length; i += 1) {
      for (let j = 0; j < ascending.length; j += 1) {
        const [left] = ascending.slice(i, i + 1)
        const [right] = ascending.slice(j, j + 1)
        const expected = i === j ? 0 : i < j ? -1 : 1
        expect(compareVersions(left ?? '', right ?? ''), `${left ?? ''} vs ${right ?? ''}`).toBe(
          expected
        )
      }
    }
  })
})

describe('isPrerelease', () => {
  it('is true only for a version with a prerelease part', () => {
    expect(isPrerelease('0.1.0-alpha.1')).toBe(true)
    expect(isPrerelease('0.1.0')).toBe(false)
    // Not a version at all is not a prerelease; the caller's refusal is elsewhere.
    expect(isPrerelease('latest')).toBe(false)
  })
})

describe('what a user is offered', () => {
  it('offers a newer alpha to somebody on the alpha channel', () => {
    expect(isUpgrade({ current: '0.1.0-alpha.2', candidate: '0.1.0-alpha.3', channel: 'alpha' })).toBe(
      true
    )
  })

  it('never offers an alpha to somebody on the stable channel', () => {
    // They did not ask to test anything, and an alpha of a browser can lose their session.
    expect(isUpgrade({ current: '0.1.0', candidate: '0.2.0-alpha.1', channel: 'stable' })).toBe(false)
  })

  it('offers a stable release to somebody on the alpha channel', () => {
    // The destination the alphas were heading for. Refusing it strands them on a prerelease.
    expect(isUpgrade({ current: '0.1.0-alpha.3', candidate: '0.1.0', channel: 'alpha' })).toBe(true)
  })

  it('never offers a step backwards, on either channel', () => {
    expect(isUpgrade({ current: '0.1.0-alpha.10', candidate: '0.1.0-alpha.2', channel: 'alpha' })).toBe(
      false
    )
    expect(isUpgrade({ current: '1.0.0', candidate: '0.9.9', channel: 'stable' })).toBe(false)
  })

  it('never offers the version already running', () => {
    expect(isUpgrade({ current: '1.0.0', candidate: '1.0.0', channel: 'stable' })).toBe(false)
  })

  it('refuses an unparseable candidate outright', () => {
    for (const bad of ['', 'latest', 'nightly']) {
      expect(isUpgrade({ current: '1.0.0', candidate: bad, channel: 'alpha' }), bad).toBe(false)
    }
  })

  it('refuses everything when the running version cannot be read', () => {
    // A development build can report something odd. Offering an "update" from an unknown version is
    // offering a change nobody can reason about.
    expect(isUpgrade({ current: 'dev', candidate: '1.0.0', channel: 'alpha' })).toBe(false)
  })
})

describe('the best of what a release list holds', () => {
  it('picks the newest one the channel admits', () => {
    expect(
      bestUpgrade({
        current: '0.1.0-alpha.2',
        candidates: ['0.1.0-alpha.3', '0.1.0-alpha.10', '0.1.0-alpha.1'],
        channel: 'alpha'
      })
    ).toBe('0.1.0-alpha.10')
  })

  it('skips the alphas entirely for a stable user', () => {
    expect(
      bestUpgrade({
        current: '0.1.0',
        candidates: ['0.2.0-alpha.1', '0.1.1', '0.2.0-beta.4'],
        channel: 'stable'
      })
    ).toBe('0.1.1')
  })

  it('is null when nothing on offer is newer', () => {
    expect(
      bestUpgrade({ current: '1.0.0', candidates: ['0.9.0', '1.0.0'], channel: 'alpha' })
    ).toBeNull()
  })

  it('is null for an empty list, which is a repository with no releases yet', () => {
    expect(bestUpgrade({ current: '0.1.0', candidates: [], channel: 'alpha' })).toBeNull()
  })

  it('steps over a malformed tag in the middle of the list', () => {
    // One bad tag must not hide the good release behind it, and must never become the answer itself.
    expect(
      bestUpgrade({
        current: '0.1.0',
        candidates: ['nightly', '0.1.1', 'v', ''],
        channel: 'alpha'
      })
    ).toBe('0.1.1')
  })
})
