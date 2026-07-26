import { describe, expect, it } from 'vitest'
import {
  GENERIC_FONT_FAMILIES,
  UNIFORM_FONTS,
  UNIFORM_IDENTITY,
  UNIFORM_PAGE_IDENTITY,
  acceptLanguageFor,
  chromeMajorVersion,
  languagesFor,
  normalizeLanguageTag,
  normalizeTimeZone,
  uniformBrandList,
  uniformBrands,
  uniformFullVersion,
  uniformUserAgent
} from '@shared/fingerprint/identity.js'
import { hash32, noiseTable, seededIndex, siteSeed } from '@shared/fingerprint/seed.js'
import {
  maskingPlanFor,
  resolvedAcceptLanguage,
  resolvedLocale,
  type MaskingPlan
} from '@shared/fingerprint/plan.js'
import { isMaskingPlan } from '@shared/fingerprint/wire.js'
import { findHeader, normalizeRequestHeaders } from '@main/session/headers.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The derivation behind the fingerprint masking (spec 4).
 *
 * Two requirements are load-bearing here, and both are stated as requirements
 * rather than as implementation details, because breaking either makes the browser
 * *more* identifiable than doing nothing at all:
 *
 *   1. The same measurement always yields the same masked value. Noise that varies
 *      per call is itself a distinguishing mark — a site reads twice and knows.
 *   2. Values that describe one machine never contradict each other. A user agent
 *      claiming Windows beside a `navigator.language` the header does not send is a
 *      stronger identifier than either alone.
 *
 * The masking that runs inside the page is tested in `fingerprint-masking.test.ts`.
 */

function withSettings(patch: Partial<SettingsSnapshot>): SettingsSnapshot {
  return { ...defaultSettings(), ...patch }
}

/** What Electron actually sends before anything is masked. */
const REAL_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'tessera/0.1.0 Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36'

function planFor(patch: Partial<SettingsSnapshot> = {}, host = 'example.com'): MaskingPlan {
  const plan = maskingPlanFor({
    settings: withSettings(patch),
    profileSecret: 'secret-one',
    host,
    userAgent: REAL_USER_AGENT
  })
  expect(plan, 'expected a plan for these settings').not.toBeNull()
  return plan!
}

describe('the uniform identity', () => {
  it('sheds every trace of Electron, the application and the real system', () => {
    const masked = uniformUserAgent(REAL_USER_AGENT)
    expect(masked).not.toMatch(/Electron/)
    expect(masked).not.toMatch(/tessera/)
    expect(masked).not.toMatch(/Macintosh|Mac OS/)
    expect(masked).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36'
    )
  })

  it('keeps the engine version it is actually running', () => {
    // A masked user agent claiming an older Chrome than the one whose features the
    // page can detect is its own contradiction, and it would arrive silently on
    // the next Electron upgrade.
    expect(chromeMajorVersion(REAL_USER_AGENT)).toBe(150)
    expect(chromeMajorVersion('Chrome/199.0.1.2')).toBe(199)
    expect(uniformUserAgent('Chrome/199.0.1.2')).toContain('Chrome/199.0.0.0')
    expect(uniformFullVersion('Chrome/199.0.1.2')).toBe('199.0.0.0')
  })

  it('falls back to the shipped Chromium when there is no version to copy', () => {
    expect(chromeMajorVersion('curl/8')).toBe(UNIFORM_PAGE_IDENTITY.fallbackChromeMajor)
  })

  it('reports the same build in the brand list as in the user agent', () => {
    const brandList = uniformBrandList('Chrome/199.0.1.2')
    expect(brandList).toContain('"Chromium";v="199"')
    expect(brandList).toContain('"Google Chrome";v="199"')
    // Chrome's own GREASE brand. Leaving it out would itself be a difference.
    expect(brandList).toContain('"Not)A;Brand";v="99"')

    const brands = uniformBrands('Chrome/199.0.1.2')
    expect(brands.map((entry) => entry.brand)).toEqual(['Chromium', 'Google Chrome', 'Not)A;Brand'])
    expect(brands[0]?.version).toBe('199')
  })

  it('offers only fonts the claimed platform would have', () => {
    // A Windows user agent beside a macOS-only face is the contradiction this list
    // exists to avoid.
    for (const macOnly of ['Helvetica Neue', 'San Francisco', 'Menlo', 'Geneva']) {
      expect(UNIFORM_FONTS, macOnly).not.toContain(macOnly)
    }
    expect(UNIFORM_FONTS).toContain('Segoe UI')
    expect(GENERIC_FONT_FAMILIES).toContain('monospace')
  })
})

describe('language tags', () => {
  it('canonicalises casing so one setting cannot produce two spellings', () => {
    expect(normalizeLanguageTag('de-de')).toBe('de-DE')
    expect(normalizeLanguageTag(' EN-us ')).toBe('en-US')
    expect(normalizeLanguageTag('zh-hans-cn')).toBe('zh-Hans-CN')
    expect(normalizeLanguageTag('de')).toBe('de')
  })

  it('rejects anything unusable rather than sending it', () => {
    // A malformed Accept-Language would single the user out far more than a
    // normalised one, so the fallback has to be the uniform value.
    expect(normalizeLanguageTag('')).toBeNull()
    expect(normalizeLanguageTag('english')).toBeNull()
    expect(normalizeLanguageTag('de_DE')).toBeNull()
    expect(normalizeLanguageTag('../etc/passwd')).toBeNull()
  })

  it('derives the header from the locale, so the two cannot drift', () => {
    // The literal in UNIFORM_IDENTITY and the derivation must agree; this is the
    // assertion that keeps them agreeing.
    expect(acceptLanguageFor(UNIFORM_PAGE_IDENTITY.language)).toBe(UNIFORM_IDENTITY.acceptLanguage)
    expect(acceptLanguageFor('de-DE')).toBe('de-DE,de;q=0.9')
    expect(acceptLanguageFor('de')).toBe('de')
    expect(languagesFor('de-DE')).toEqual(['de-DE', 'de'])
    expect(languagesFor('de')).toEqual(['de'])
  })
})

describe('time zones', () => {
  it('accepts a zone the runtime knows, in canonical form', () => {
    expect(normalizeTimeZone('UTC')).toBe('UTC')
    expect(normalizeTimeZone(' europe/berlin ')).toBe('Europe/Berlin')
  })

  it('rejects a zone that formats nowhere', () => {
    // Accepting one would leave Date and Intl reporting different zones — the
    // contradiction, self-inflicted.
    expect(normalizeTimeZone('Mars/Phobos')).toBeNull()
    expect(normalizeTimeZone('')).toBeNull()
    expect(normalizeTimeZone('nonsense')).toBeNull()
  })
})

describe('seed derivation', () => {
  it('is stable for the same input, across any number of calls', () => {
    const once = hash32('example.com')
    for (let attempt = 0; attempt < 100; attempt++) {
      expect(hash32('example.com')).toBe(once)
    }
  })

  it('stays inside 32 bits for every input', () => {
    for (const text of ['', 'a', 'example.com', 'üñî', 'x'.repeat(1000)]) {
      const hash = hash32(text)
      expect(hash, text).toBeGreaterThanOrEqual(0)
      expect(hash, text).toBeLessThan(2 ** 32)
      expect(Number.isInteger(hash), text).toBe(true)
    }
  })

  it('separates the profile secret from the site, so neither can be guessed from the other', () => {
    // Without a separator, profile "ab" on site "c" and profile "a" on site "bc"
    // would derive the same seed.
    expect(siteSeed('ab', 'c')).not.toBe(siteSeed('a', 'bc'))
  })

  it('gives every host of one site the same seed', () => {
    // Otherwise the same visitor looks like three, and a site's own subdomains
    // disagree about what the canvas said.
    const expected = siteSeed('secret', 'example.com')
    expect(siteSeed('secret', 'www.example.com')).toBe(expected)
    expect(siteSeed('secret', 'cdn.example.com')).toBe(expected)
    expect(siteSeed('secret', 'EXAMPLE.COM')).toBe(expected)
  })

  it('gives different sites different seeds', () => {
    // This is what stops the noise from becoming a cross-site identifier of its
    // own: two sites comparing notes must not find the same values.
    expect(siteSeed('secret', 'example.org')).not.toBe(siteSeed('secret', 'example.com'))
  })

  it('gives different profiles different seeds for the same site', () => {
    expect(siteSeed('secret-one', 'example.com')).not.toBe(siteSeed('secret-two', 'example.com'))
  })

  it('produces a deterministic table within the requested magnitude', () => {
    const table = noiseTable(12345, 64, 2)
    expect(table).toEqual(noiseTable(12345, 64, 2))
    expect(table).toHaveLength(64)
    for (const delta of table) {
      expect(delta).toBeGreaterThanOrEqual(-2)
      expect(delta).toBeLessThanOrEqual(2)
      expect(Number.isInteger(delta)).toBe(true)
    }
    expect(new Set(table).size, 'a table of one value would perturb nothing').toBeGreaterThan(1)
  })

  it('produces different tables for different seeds, and copes with a zero seed', () => {
    expect(noiseTable(1, 16, 3)).not.toEqual(noiseTable(2, 16, 3))
    // Zero is a fixed point for xorshift; a table of zeroes would mask nothing.
    expect(new Set(noiseTable(0, 16, 3)).size).toBeGreaterThan(1)
  })

  it('derives a stable index inside the modulus', () => {
    expect(seededIndex(999, 251)).toBe(seededIndex(999, 251))
    expect(seededIndex(999, 251)).toBeLessThan(251)
    expect(seededIndex(999, 251)).toBeGreaterThanOrEqual(0)
  })
})

describe('the masking plan', () => {
  it('is identical for the same profile, site and settings', () => {
    // The requirement in one assertion: nothing about a plan may vary between two
    // builds of it, because a page can trigger both.
    expect(planFor()).toEqual(planFor())
  })

  it('differs between two profiles', () => {
    const one = maskingPlanFor({
      settings: defaultSettings(),
      profileSecret: 'secret-one',
      host: 'example.com',
      userAgent: REAL_USER_AGENT
    })
    const two = maskingPlanFor({
      settings: defaultSettings(),
      profileSecret: 'secret-two',
      host: 'example.com',
      userAgent: REAL_USER_AGENT
    })
    expect(one?.canvas?.deltas).not.toEqual(two?.canvas?.deltas)
    expect(one?.audio?.deltas).not.toEqual(two?.audio?.deltas)
    // Everything a site can only read stays uniform: that is what puts the two
    // profiles in the same crowd instead of making each unique.
    expect(one?.userAgent).toEqual(two?.userAgent)
    expect(one?.webgl).toEqual(two?.webgl)
    expect(one?.fonts).toEqual(two?.fonts)
  })

  it('differs between sites but not between hosts of one site', () => {
    expect(planFor({}, 'www.example.com').canvas).toEqual(planFor({}, 'example.com').canvas)
    expect(planFor({}, 'example.org').canvas).not.toEqual(planFor({}, 'example.com').canvas)
  })

  it('derives canvas and audio noise from independent seeds', () => {
    // Reading one must not predict the other.
    const plan = planFor()
    expect(plan.canvas?.deltas).not.toEqual(plan.audio?.deltas)
  })

  it('switches everything off for mode "off"', () => {
    expect(
      maskingPlanFor({
        settings: withSettings({ 'fingerprint.mode': 'off' }),
        profileSecret: 'secret-one',
        host: 'example.com',
        userAgent: REAL_USER_AGENT
      })
    ).toBeNull()
  })

  it('has every measure on by default', () => {
    const plan = planFor()
    expect(plan.userAgent).not.toBeNull()
    expect(plan.locale).not.toBeNull()
    expect(plan.canvas).not.toBeNull()
    expect(plan.webgl).not.toBeNull()
    expect(plan.audio).not.toBeNull()
    expect(plan.fonts).not.toBeNull()
    expect(plan.screen).not.toBeNull()
    expect(plan.devices).not.toBeNull()
    // The one exception: no time zone is spoofed unless the user names one.
    expect(plan.timeZone).toBeNull()
  })

  it('turns off exactly the measure whose setting is off', () => {
    const cases: ReadonlyArray<readonly [keyof SettingsSnapshot, keyof MaskingPlan]> = [
      ['fingerprint.normalizeUserAgent', 'userAgent'],
      ['fingerprint.maskCanvas', 'canvas'],
      ['fingerprint.maskWebgl', 'webgl'],
      ['fingerprint.maskAudio', 'audio'],
      ['fingerprint.limitFonts', 'fonts'],
      ['fingerprint.normalizeScreen', 'screen'],
      ['fingerprint.blockDeviceApis', 'devices']
    ]

    for (const [setting, field] of cases) {
      const plan = planFor({ [setting]: false })
      expect(plan[field], `${setting} should switch off ${field}`).toBeNull()
      const others = Object.entries(plan).filter(
        ([key]) => key !== field && key !== 'version' && key !== 'timeZone'
      )
      for (const [key, value] of others) {
        expect(value, `${setting} also switched off ${key}`).not.toBeNull()
      }
    }
  })

  it('carries the derived user agent, not the real one', () => {
    const plan = planFor()
    expect(plan.userAgent?.userAgent).toBe(uniformUserAgent(REAL_USER_AGENT))
    expect(plan.userAgent?.platform).toBe('Win32')
    expect(plan.userAgent?.uaPlatform).toBe('Windows')
    // The high-entropy hints have to name the same machine as the header set.
    expect(`"${plan.userAgent?.platformVersion}"`).toBe(UNIFORM_IDENTITY.platformVersion)
    expect(`"${plan.userAgent?.architecture}"`).toBe(UNIFORM_IDENTITY.arch)
    expect(`"${plan.userAgent?.bitness}"`).toBe(UNIFORM_IDENTITY.bitness)
  })

  it('never carries the profile secret into the page', () => {
    // A page that read every value it was given must still learn nothing another
    // site could recognise.
    expect(JSON.stringify(planFor())).not.toContain('secret-one')
  })

  it('spoofs a named time zone and ignores an unusable one', () => {
    expect(planFor({ 'fingerprint.spoofTimezone': 'Europe/Berlin' }).timeZone).toBe('Europe/Berlin')
    expect(planFor({ 'fingerprint.spoofTimezone': 'Mars/Phobos' }).timeZone).toBeNull()
  })
})

describe('locale resolution', () => {
  it('reports the uniform locale while the header is normalised', () => {
    expect(resolvedLocale(defaultSettings())).toBe(UNIFORM_PAGE_IDENTITY.language)
    expect(planFor().locale).toEqual({ language: 'en-US', languages: ['en-US', 'en'] })
  })

  it('follows an explicit locale in both places at once', () => {
    const settings = withSettings({ 'fingerprint.spoofLocale': 'de-de' })
    expect(resolvedLocale(settings)).toBe('de-DE')
    expect(resolvedAcceptLanguage(settings)).toBe('de-DE,de;q=0.9')
    expect(planFor({ 'fingerprint.spoofLocale': 'de-de' }).locale).toEqual({
      language: 'de-DE',
      languages: ['de-DE', 'de']
    })
  })

  it('leaves the page locale alone exactly when the header is left alone', () => {
    // The pair is the point: reporting a uniform navigator.language while sending
    // the real Accept-Language is the contradiction spec 4 warns about.
    const settings = withSettings({ 'fingerprint.normalizeAcceptLanguage': false })
    expect(resolvedLocale(settings)).toBeNull()
    expect(resolvedAcceptLanguage(settings)).toBeNull()
    expect(planFor({ 'fingerprint.normalizeAcceptLanguage': false }).locale).toBeNull()
  })

  it('lets an explicit locale win over the normalisation switch', () => {
    const settings = withSettings({
      'fingerprint.normalizeAcceptLanguage': false,
      'fingerprint.spoofLocale': 'fr-CA'
    })
    expect(resolvedAcceptLanguage(settings)).toBe('fr-CA,fr;q=0.9')
  })
})

describe('recognising a plan that arrived over IPC', () => {
  it('accepts a plan this build produced', () => {
    expect(isMaskingPlan(planFor())).toBe(true)
  })

  it('refuses anything else, so a missing responder means no masking', () => {
    // `sendSync` answers `undefined` when nothing is listening, and that has to
    // lead to "mask nothing" rather than to a throw inside a preload.
    expect(isMaskingPlan(undefined)).toBe(false)
    expect(isMaskingPlan(null)).toBe(false)
    expect(isMaskingPlan('plan')).toBe(false)
    expect(isMaskingPlan({})).toBe(false)
    expect(isMaskingPlan({ ...planFor(), version: 2 })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), canvas: 'noise' })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), timeZone: 42 })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), userAgent: undefined })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), locale: 1 })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), webgl: 1 })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), audio: 1 })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), fonts: 1 })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), screen: 1 })).toBe(false)
    expect(isMaskingPlan({ ...planFor(), devices: 1 })).toBe(false)
  })
})

describe('the headers that carry the same identity', () => {
  const incoming = { 'User-Agent': REAL_USER_AGENT }

  it('replaces the user agent with the uniform one', () => {
    const headers = normalizeRequestHeaders(incoming, 'https://example.com/', defaultSettings())
    expect(findHeader(headers, 'user-agent')).toBe(uniformUserAgent(REAL_USER_AGENT))
    expect(findHeader(headers, 'user-agent')).not.toMatch(/Electron/)
  })

  it('replaces a lower-case header rather than sending two', () => {
    // Chromium and servers disagree about casing, and two User-Agent headers would
    // be a signature of their own.
    const headers = normalizeRequestHeaders(
      { 'user-agent': REAL_USER_AGENT },
      'https://example.com/',
      defaultSettings()
    )
    const names = Object.keys(headers).filter((name) => name.toLowerCase() === 'user-agent')
    expect(names).toHaveLength(1)
  })

  it('still sends a complete identity for a request that carried no user agent', () => {
    // Chromium omits it for a few internal request types; the replacement must be a
    // whole plausible browser rather than an empty string or a partial set.
    const headers = normalizeRequestHeaders({}, 'https://example.com/', defaultSettings())
    expect(findHeader(headers, 'user-agent')).toBe(uniformUserAgent(''))
    expect(findHeader(headers, 'Sec-CH-UA')).toBe(uniformBrandList(''))

    // And with the user-agent normalisation off, so there is no rewritten string to
    // read the version out of either.
    const hintsOnly = normalizeRequestHeaders(
      {},
      'https://example.com/',
      withSettings({ 'fingerprint.normalizeUserAgent': false })
    )
    expect(findHeader(hintsOnly, 'Sec-CH-UA')).toBe(uniformBrandList(''))
    expect(findHeader(hintsOnly, 'user-agent')).toBeUndefined()
  })

  it('leaves the user agent alone when that normalisation is off', () => {
    const headers = normalizeRequestHeaders(
      incoming,
      'https://example.com/',
      withSettings({ 'fingerprint.normalizeUserAgent': false })
    )
    expect(findHeader(headers, 'user-agent')).toBe(REAL_USER_AGENT)
  })

  it('sends a brand list naming the build the user agent claims', () => {
    const headers = normalizeRequestHeaders(incoming, 'https://example.com/', defaultSettings())
    expect(findHeader(headers, 'Sec-CH-UA')).toBe(uniformBrandList(REAL_USER_AGENT))
  })

  it('derives the brand list from the real build when the user agent is untouched', () => {
    // Otherwise the pair contradicts itself, which is worse than either alone.
    const headers = normalizeRequestHeaders(
      { 'User-Agent': 'Chrome/199.0.1.2' },
      'https://example.com/',
      withSettings({ 'fingerprint.normalizeUserAgent': false })
    )
    expect(findHeader(headers, 'Sec-CH-UA')).toContain('"Chromium";v="199"')
  })

  it('sends the language the page will report', () => {
    const headers = normalizeRequestHeaders(
      incoming,
      'https://example.com/',
      withSettings({ 'fingerprint.spoofLocale': 'de-DE' })
    )
    expect(findHeader(headers, 'Accept-Language')).toBe('de-DE,de;q=0.9')
    expect(planFor({ 'fingerprint.spoofLocale': 'de-DE' }).locale?.language).toBe('de-DE')
  })

  it('changes no header at all when masking is off', () => {
    // A master switch that still rewrote three headers would not be off.
    const original = {
      'User-Agent': REAL_USER_AGENT,
      'Accept-Language': 'de-AT,de;q=0.9',
      'Sec-CH-UA-Platform': '"macOS"'
    }
    const headers = normalizeRequestHeaders(
      original,
      'https://example.com/',
      withSettings({ 'fingerprint.mode': 'off' })
    )
    expect(findHeader(headers, 'user-agent')).toBe(REAL_USER_AGENT)
    expect(findHeader(headers, 'accept-language')).toBe('de-AT,de;q=0.9')
    expect(findHeader(headers, 'sec-ch-ua-platform')).toBe('"macOS"')
    expect(findHeader(headers, 'sec-ch-ua')).toBeUndefined()
    // The privacy headers are a different setting and stay on.
    expect(findHeader(headers, 'DNT')).toBe('1')
  })
})
