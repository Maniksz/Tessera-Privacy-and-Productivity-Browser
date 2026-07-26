import type { LocalePlan, UserAgentPlan } from './plan.js'
import type { Slots } from './page.js'

/**
 * Who the browser says it is: the user agent and the language.
 *
 * One of four files holding the page-world measures. The rule every function here
 * obeys — no reference to anything outside its own body — and what the approach can
 * and cannot reach are explained once, in `apply.ts`.
 */

/**
 * The user agent and everything that has to agree with it.
 *
 * `navigator.userAgentData` matters as much as the string: it carries the real
 * platform, architecture and full version, so a page that reads both learns the
 * lie *and* the truth — and the pair is more identifying than either alone.
 */
export function maskUserAgent(plan: UserAgentPlan): void {
  const scope = globalThis as unknown as { navigator?: Slots }
  const target = scope.navigator
  if (target === undefined) return

  const define = (key: string, get: () => unknown): void => {
    // The accessor lives on `Navigator.prototype`; replacing it there rather than
    // on the instance avoids leaving an own property where the real object has
    // none. A property that refuses to be redefined is left alone — a page that
    // still works matters more than one more masked value.
    let owner: object = target
    while (!Object.prototype.hasOwnProperty.call(owner, key)) {
      const next: unknown = Object.getPrototypeOf(owner)
      if (next === null || typeof next !== 'object') {
        owner = target
        break
      }
      owner = next
    }
    try {
      Object.defineProperty(owner, key, { get, configurable: true, enumerable: true })
    } catch {
      // Non-configurable: nothing to do but leave the real value in place.
    }
  }

  define('userAgent', () => plan.userAgent)
  define('appVersion', () => plan.userAgent.replace(/^Mozilla\//, ''))
  define('platform', () => plan.platform)
  define('vendor', () => plan.vendor)

  const brands = plan.brands.map((entry) => ({ brand: entry.brand, version: entry.version }))
  const highEntropy: Slots = {
    architecture: plan.architecture,
    bitness: plan.bitness,
    model: plan.model,
    platformVersion: plan.platformVersion,
    uaFullVersion: plan.fullVersion,
    fullVersionList: brands.map((entry) => ({
      brand: entry.brand,
      version: entry.version === '99' ? '99.0.0.0' : plan.fullVersion
    })),
    wow64: false
  }

  define('userAgentData', () => ({
    brands,
    mobile: false,
    platform: plan.uaPlatform,
    toJSON: () => ({ brands, mobile: false, platform: plan.uaPlatform }),
    getHighEntropyValues: (hints: unknown): Promise<Slots> => {
      // Chrome answers with the requested hints plus the low-entropy ones, so a
      // caller asking for nothing still gets brands, mobile and platform.
      const answer: Slots = { brands, mobile: false, platform: plan.uaPlatform }
      if (Array.isArray(hints)) {
        for (const hint of hints) {
          if (typeof hint === 'string' && hint in highEntropy) answer[hint] = highEntropy[hint]
        }
      }
      return Promise.resolve(answer)
    }
  }))
}

/**
 * `navigator.language` and `navigator.languages`.
 *
 * These have to match the `Accept-Language` header the same page's requests
 * carry; both come from one setting, resolved once in `plan.ts`, so they cannot
 * drift apart.
 *
 * Not covered: `new Intl.DateTimeFormat().resolvedOptions().locale`, which reports
 * the application locale. That is a process-level value, fixed by Chromium's
 * `--lang` switch at startup, and faking it per page would mean wrapping every
 * `Intl` constructor — visibly different number and date formatting, and a wide
 * breakage surface, for one bit of entropy.
 */
export function maskLocale(plan: LocalePlan): void {
  const scope = globalThis as unknown as { navigator?: Slots }
  const target = scope.navigator
  if (target === undefined) return

  const languages = [...plan.languages]
  const define = (key: string, get: () => unknown): void => {
    let owner: object = target
    while (!Object.prototype.hasOwnProperty.call(owner, key)) {
      const next: unknown = Object.getPrototypeOf(owner)
      if (next === null || typeof next !== 'object') {
        owner = target
        break
      }
      owner = next
    }
    try {
      Object.defineProperty(owner, key, { get, configurable: true, enumerable: true })
    } catch {
      // See `maskUserAgent`.
    }
  }

  define('language', () => plan.language)
  // A fresh copy per read: the real accessor hands out a frozen list, and sharing
  // one array would let a page mutate what the next reader sees.
  define('languages', () => Object.freeze([...languages]))
}
