/**
 * A stand-in for the Public Suffix List, built in code.
 *
 * Built rather than copied from publicsuffix.org, for two reasons: the tests must not depend on a
 * download, and a checked-in copy of the real list would be a quarter of a megabyte that goes stale
 * while looking authoritative. What matters to the checks is the list's *shape* — the four markers,
 * two sections, several thousand rules, the rule kinds — and that is what this reproduces. The
 * handful of real rules the canaries and the acceptance examples name are in it verbatim.
 */

export interface FixtureRules {
  readonly icann: readonly string[]
  readonly private: readonly string[]
}

/** Real ICANN rules the checks and the acceptance examples depend on. */
export const CORE_ICANN: readonly string[] = [
  'com',
  'net',
  'org',
  'io',
  'uk',
  'co.uk',
  // A wildcard below a bootstrap entry (`sch.uk`), which splits more finely and is fine.
  '*.sch.uk',
  'sg',
  'com.sg',
  'jp',
  '*.kawasaki.jp',
  '!city.kawasaki.jp',
  // A country domain that registers only at the third level, as several do.
  '*.ck',
  '!www.ck',
  'cn',
  '公司.cn',
  'рф'
]

/** Real PRIVATE rules the canaries depend on. */
export const CORE_PRIVATE: readonly string[] = ['github.io', 'blogspot.com']

/** 4 000 ICANN rules and 3 000 PRIVATE ones unless asked otherwise: comfortably above the minimum. */
export function fixtureRules(icannCount = 4000, privateCount = 3000): FixtureRules {
  const icann = [...CORE_ICANN]
  for (let index = 0; icann.length < icannCount; index++) icann.push(`i${String(index)}.zz`)
  const privateRules = [...CORE_PRIVATE]
  for (let index = 0; privateRules.length < privateCount; index++) {
    privateRules.push(`p${String(index)}.hosting.zz`)
  }
  return { icann, private: privateRules }
}

/** The rules as the list's text format, header comments and all. */
export function fixtureText(rules: FixtureRules): string {
  return [
    '// This Source Code Form is subject to the terms of the Mozilla Public',
    '// License, v. 2.0.',
    '',
    '// ===BEGIN ICANN DOMAINS===',
    '',
    '// com : https://en.wikipedia.org/wiki/.com',
    ...rules.icann,
    '',
    '// ===END ICANN DOMAINS===',
    '// ===BEGIN PRIVATE DOMAINS===',
    '',
    ...rules.private,
    '',
    '// ===END PRIVATE DOMAINS===',
    ''
  ].join('\n')
}

/** The same rules without the ones named. */
export function without(rules: FixtureRules, removed: readonly string[]): FixtureRules {
  const gone = new Set(removed)
  return {
    icann: rules.icann.filter((rule) => !gone.has(rule)),
    private: rules.private.filter((rule) => !gone.has(rule))
  }
}

/** The same rules plus some, in the section named. */
export function withAdded(
  rules: FixtureRules,
  section: 'icann' | 'private',
  added: readonly string[]
): FixtureRules {
  return section === 'icann'
    ? { icann: [...rules.icann, ...added], private: rules.private }
    : { icann: rules.icann, private: [...rules.private, ...added] }
}

/** The filler PRIVATE rules from `from` up to `to`, for removing a counted share of them. */
export function fillerPrivate(from: number, to: number): string[] {
  const rules: string[] = []
  for (let index = from; index < to; index++) rules.push(`p${String(index)}.hosting.zz`)
  return rules
}
