import { registrableDomain } from '@shared/url/domain.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import {
  UNIFORM_IDENTITY,
  uniformBrandList,
  uniformUserAgent
} from '@shared/fingerprint/identity.js'
import { resolvedAcceptLanguage } from '@shared/fingerprint/plan.js'

/**
 * Request and response header transforms, as pure functions.
 *
 * Extracted from `hardening.ts` for one reason above all: spec 7 requires a test
 * proving that *each* privacy setting actually changes network traffic, not merely
 * that its switch flips. That test is only writable if the transform can be called
 * without an Electron session — so this is where it lives.
 *
 * Every function takes headers and returns new headers; nothing is mutated in
 * place, so a caller cannot half-apply a policy and leave the rest behind.
 */

export type Headers = Readonly<Record<string, string>>

/**
 * The single normalised identity presented to every site.
 *
 * Spec 4 is emphatic that consistency is the whole point: a masked user agent
 * paired with client hints that still report the real OS is a *stronger*
 * identifier than no masking at all, because the contradiction itself is
 * distinctive. So these values are one set, defined together, and changed
 * together.
 *
 * They now live in `shared/fingerprint/identity.ts`, because the page side of the
 * masking has to present the same machine as these headers do and the two cannot
 * be allowed to drift. Re-exported here so the header-facing name stays where its
 * callers and tests already look for it.
 */
export { UNIFORM_IDENTITY }

/** Case-insensitive header lookup; servers and Chromium disagree on casing. */
export function findHeader(headers: Headers, name: string): string | undefined {
  const lower = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower) return value
  }
  return undefined
}

function withoutHeader(headers: Record<string, string>, name: string): Record<string, string> {
  const lower = name.toLowerCase()
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) next[key] = value
  }
  return next
}

/**
 * Applies the referrer policy (spec 4).
 *
 * Cross-site requests are trimmed to the bare origin; an HTTPS to HTTP downgrade
 * drops the header entirely, because sending it over an unencrypted hop discloses
 * the source page to anyone on the path.
 */
export function applyReferrerPolicy(
  headers: Headers,
  requestUrl: string,
  policy: SettingsSnapshot['privacy.referrerPolicy']
): Headers {
  if (policy === 'default') return headers

  const key = Object.keys(headers).find((name) => name.toLowerCase() === 'referer')
  if (key === undefined) return headers
  const referrer = headers[key]
  if (referrer === undefined || referrer === '') return headers

  const next: Record<string, string> = { ...headers }

  try {
    const from = new URL(referrer)
    const to = new URL(requestUrl)

    if (from.protocol === 'https:' && to.protocol === 'http:') {
      return withoutHeader(next, 'referer')
    }
    if (policy === 'strict') {
      return withoutHeader(next, 'referer')
    }
    if (registrableDomain(from.hostname) !== registrableDomain(to.hostname)) {
      next[key] = `${from.origin}/`
    }
    return next
  } catch {
    // An unparseable referrer or target is not something to reason about; drop it.
    return withoutHeader(next, 'referer')
  }
}

/**
 * Builds the outgoing request headers for a navigation or subresource.
 *
 * Each block is gated on its own setting so the integration test can toggle one
 * and observe exactly one difference.
 */
export function normalizeRequestHeaders(
  headers: Headers,
  requestUrl: string,
  settings: SettingsSnapshot
): Headers {
  let next: Record<string, string> = { ...headers }

  if (settings['privacy.sendDoNotTrack']) next['DNT'] = '1'
  if (settings['privacy.sendGlobalPrivacyControl']) next['Sec-GPC'] = '1'

  // One master switch, checked once. A `mode: 'off'` that still rewrote three
  // headers would not be off, and reading it per block invites the day one block
  // forgets to.
  const masking = settings['fingerprint.mode'] !== 'off'

  const acceptLanguage = masking ? resolvedAcceptLanguage(settings) : null
  if (acceptLanguage !== null) {
    // A regional value like "de-AT,de;q=0.9" narrows a user down considerably on
    // its own, before any script has run. The value comes from the same resolver
    // the page side uses for `navigator.language`, so the two always agree.
    next['Accept-Language'] = acceptLanguage
  }

  if (masking && settings['fingerprint.normalizeUserAgent']) {
    // Electron's own user agent names the application, the Electron version and
    // the real operating system — three things no other browser sends. The
    // replacement keeps the Chromium major version from the real string so the
    // claimed build matches the engine that will actually run the page.
    const real = findHeader(next, 'user-agent') ?? ''
    next = withoutHeader(next, 'user-agent')
    next['User-Agent'] = uniformUserAgent(real)
  }

  if (masking && settings['fingerprint.normalizeClientHints']) {
    // Client hints leak OS and exact version even when the user agent has been
    // rewritten. Normalising them separately from the user agent is what creates
    // the contradiction spec 4 warns about, so they move together.
    next['Sec-CH-UA-Platform'] = UNIFORM_IDENTITY.platform
    next['Sec-CH-UA-Platform-Version'] = UNIFORM_IDENTITY.platformVersion
    next['Sec-CH-UA-Arch'] = UNIFORM_IDENTITY.arch
    next['Sec-CH-UA-Bitness'] = UNIFORM_IDENTITY.bitness
    next['Sec-CH-UA-Model'] = UNIFORM_IDENTITY.model
    // The brand list has to name the same build as the user agent above, so it is
    // derived from the same string rather than written out here.
    next['Sec-CH-UA'] = uniformBrandList(findHeader(next, 'user-agent') ?? '')
    next = withoutHeader(next, 'Sec-CH-UA-Full-Version')
    next = withoutHeader(next, 'Sec-CH-UA-Full-Version-List')
  }

  return applyReferrerPolicy(next, requestUrl, settings['privacy.referrerPolicy'])
}

/**
 * Strips `Set-Cookie` from cross-site responses (spec 4).
 *
 * Site comparison uses the registrable domain, so `a.example.com` setting a cookie
 * for a document on `b.example.com` is first-party and survives, while a genuine
 * third party does not.
 */
export function filterResponseHeaders(
  headers: Headers,
  context: { documentUrl: string | null; requestUrl: string },
  settings: SettingsSnapshot
): Headers {
  if (!settings['privacy.blockThirdPartyCookies']) return headers
  if (context.documentUrl === null) return headers
  if (isSameSite(context.documentUrl, context.requestUrl)) return headers
  return withoutHeader({ ...headers }, 'set-cookie')
}

export function isSameSite(a: string, b: string): boolean {
  try {
    return registrableDomain(new URL(a).hostname) === registrableDomain(new URL(b).hostname)
  } catch {
    // Unknown provenance is treated as cross-site: the stricter reading is the
    // one that cannot leak.
    return false
  }
}
