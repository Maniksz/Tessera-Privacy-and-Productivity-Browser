/**
 * The single identity every masked page is shown (spec 4).
 *
 * ## Why one identity rather than a random one per profile
 *
 * Anti-fingerprinting has two opposing strategies. Randomising a value hides the
 * real one but makes the browser *unique*, which is worse if the randomisation is
 * detectable — and it always is, for anything a site can measure twice. Reporting
 * one uniform value hides the real one *and* puts every tessera user in the
 * same bucket. So everything a site can only read (system, GPU, fonts, screen,
 * locale) is uniform, and only the values a site *renders* — canvas, audio —
 * carry noise, because those cannot be made uniform without breaking them.
 *
 * ## Why Windows on x86-64
 *
 * It is the largest population to disappear into. The goal is to look like
 * everyone else, not to look unusual, so a macOS build reports Windows too.
 *
 * ## Consistency is the whole point
 *
 * Every value here belongs to the same fictional machine, and they are defined
 * together so that they change together. A user agent claiming Windows beside
 * client hints reporting macOS, or a Windows user agent beside `Helvetica Neue`
 * in the font list, is a *stronger* identifier than no masking at all — the
 * contradiction itself is the distinguishing mark.
 *
 * No imports, deliberately: the preload and both renderers read this at runtime,
 * and anything pulled in here would be pulled into their bundles too.
 */

/**
 * Header-side values. Quoted because client hints are structured-header strings
 * and the quotes are part of the value.
 */
export const UNIFORM_IDENTITY = {
  platform: '"Windows"',
  platformVersion: '"10.0.0"',
  arch: '"x86"',
  bitness: '"64"',
  model: '""',
  acceptLanguage: 'en-US,en;q=0.9'
} as const

/** Page-side counterparts of the same machine, unquoted for JavaScript. */
export const UNIFORM_PAGE_IDENTITY = {
  /** `navigator.platform`. Frozen by Chrome to this value on 64-bit Windows. */
  navigatorPlatform: 'Win32',
  vendor: 'Google Inc.',
  /** `navigator.userAgentData.platform`. */
  uaPlatform: 'Windows',
  platformVersion: '10.0.0',
  architecture: 'x86',
  bitness: '64',
  model: '',
  language: 'en-US',
  /**
   * No uniform time zone, deliberately.
   *
   * `fingerprint.spoofTimezone` is empty by default, and empty means "leave the
   * clock alone" rather than "report UTC". A visitor's address already places them
   * in a region, so UTC beside a German address is its own mismatch — and every
   * date on every site would shift for a user who never asked for that. The setting
   * exists for the case where the network location is masked too.
   */
  colorDepth: 24,
  /**
   * A power-of-two core count is by far the most common answer, and 4 is the
   * modal value. The real count is a strong signal on both ends of the range: 2
   * says netbook, 32 says workstation.
   */
  hardwareConcurrency: 4,
  /** `navigator.deviceMemory` is already quantised by Chrome; 8 is the mode. */
  deviceMemory: 8,
  /**
   * WebGL's plain `VENDOR` and `RENDERER` are what Chrome reports to everyone;
   * the real GPU only appears through `WEBGL_debug_renderer_info`, so that is
   * where the substitution has to happen.
   */
  gpuVendor: 'WebKit',
  gpuRenderer: 'WebKit WebGL',
  /** A Windows-plausible integrated GPU behind ANGLE's D3D11 backend. */
  gpuUnmaskedVendor: 'Google Inc. (Intel)',
  gpuUnmaskedRenderer:
    'ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)',
  /**
   * Used when the real user agent carries no Chrome version to copy. Pinned to
   * the Chromium that ships with Electron 43 rather than left to drift.
   */
  fallbackChromeMajor: 150
} as const

/**
 * Fonts a site is allowed to detect: the set that ships with Windows 10.
 *
 * Chosen to match the claimed platform. Answering "yes" for a macOS-only face
 * while the user agent says Windows would be the contradiction this file exists
 * to avoid, and answering "no" to everything is just as distinctive — no real
 * machine has no fonts.
 */
export const UNIFORM_FONTS: readonly string[] = [
  'Arial',
  'Arial Black',
  'Calibri',
  'Cambria',
  'Candara',
  'Comic Sans MS',
  'Consolas',
  'Constantia',
  'Corbel',
  'Courier New',
  'Ebrima',
  'Franklin Gothic Medium',
  'Gabriola',
  'Georgia',
  'Impact',
  'Lucida Console',
  'Lucida Sans Unicode',
  'Malgun Gothic',
  'Microsoft Sans Serif',
  'MS Gothic',
  'Palatino Linotype',
  'Segoe Print',
  'Segoe Script',
  'Segoe UI',
  'SimSun',
  'Sylfaen',
  'Symbol',
  'Tahoma',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'Webdings',
  'Wingdings',
  'Yu Gothic'
]

/** CSS keywords that are never a real face and must keep answering truthfully. */
export const GENERIC_FONT_FAMILIES: readonly string[] = [
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong'
]

const CHROME_VERSION = /Chrome\/(\d+)/

/**
 * The Chromium major version out of a user agent.
 *
 * Read from the real string rather than pinned, so the masked user agent keeps
 * claiming the engine that is actually running. Claiming an older Chrome than
 * the one whose features the page can detect is its own inconsistency, and it
 * would arrive silently on the next Electron upgrade.
 */
export function chromeMajorVersion(userAgent: string): number {
  const match = CHROME_VERSION.exec(userAgent)
  if (match === null) return UNIFORM_PAGE_IDENTITY.fallbackChromeMajor
  return Number(match[1])
}

/**
 * The masked user agent, derived from the real one.
 *
 * Electron's default announces the application name, the Electron version and
 * the real operating system — three values no other browser sends, which makes
 * it a near-unique string before any script runs. What is left here is exactly
 * what Chrome on 64-bit Windows sends, including the frozen `0.0.0` build part
 * that Chrome itself now reports.
 */
export function uniformUserAgent(realUserAgent: string): string {
  const major = chromeMajorVersion(realUserAgent)
  return (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
  )
}

/** `navigator.userAgentData.uaFullVersion` for the same claimed build. */
export function uniformFullVersion(realUserAgent: string): string {
  return `${chromeMajorVersion(realUserAgent)}.0.0.0`
}

/**
 * The `Sec-CH-UA` brand list for the claimed build.
 *
 * The deliberately malformed "Not)A;Brand" entry is Chrome's own GREASE brand:
 * it exists so servers cannot assume the list has a fixed shape. Leaving it out
 * would itself be a difference from Chrome.
 */
export function uniformBrandList(realUserAgent: string): string {
  const major = chromeMajorVersion(realUserAgent)
  return `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not)A;Brand";v="99"`
}

export interface UserAgentBrand {
  readonly brand: string
  readonly version: string
}

/** The same brand list in the shape `navigator.userAgentData.brands` uses. */
export function uniformBrands(realUserAgent: string): readonly UserAgentBrand[] {
  const major = String(chromeMajorVersion(realUserAgent))
  return [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not)A;Brand', version: '99' }
  ]
}

// Case-insensitive on purpose: a tag is case-insensitive per BCP 47, so a user who
// types `EN-us` gets the canonical form rather than the fallback.
const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

/**
 * A usable BCP-47 tag with canonical casing, or `null`.
 *
 * `null` rather than a thrown error or a silent pass-through: an unusable
 * setting has to fall back to the uniform value, because a malformed
 * `Accept-Language` would single the user out far more than a normalised one.
 */
export function normalizeLanguageTag(raw: string): string | null {
  const trimmed = raw.trim()
  if (!LANGUAGE_TAG.test(trimmed)) return null
  const [primary, ...rest] = trimmed.split('-')
  const subtags = rest.map((subtag) =>
    // Region subtags are conventionally upper-case, script subtags title-case.
    subtag.length === 2 ? subtag.toUpperCase() : titleCase(subtag)
  )
  return [primary?.toLowerCase(), ...subtags].join('-')
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}

/**
 * The `Accept-Language` value for a locale, and the list `navigator.languages`
 * reports.
 *
 * Derived from one input so the header and the page can never disagree — a
 * `navigator.language` of `de-DE` beside an `Accept-Language` of `en-US` is the
 * contradiction spec 4 warns about, arriving through two code paths that were
 * each correct on their own.
 */
export function acceptLanguageFor(locale: string): string {
  const languages = languagesFor(locale)
  // A tag with no region has no broader fallback to offer, and Chrome sends the
  // bare tag in that case. Inventing a `q` list here would be a difference.
  if (languages.length === 1) return locale
  return `${languages[0]},${languages[1]};q=0.9`
}

export function languagesFor(locale: string): readonly string[] {
  // `split` always yields at least one element, so the index is safe.
  const primary = locale.split('-')[0]!
  return primary === locale ? [locale] : [locale, primary]
}

/**
 * A time zone the runtime actually knows, or `null`.
 *
 * Validated by asking `Intl` rather than by pattern: the set of zone names is
 * data, not a shape, and a name that formats nowhere would leave `Date` and
 * `Intl` reporting different zones — again the contradiction, self-inflicted.
 */
export function normalizeTimeZone(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '') return null
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: trimmed }).resolvedOptions()
      .timeZone
    return resolved
  } catch {
    return null
  }
}
