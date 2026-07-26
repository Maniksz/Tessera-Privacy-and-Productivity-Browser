import type { SettingsSnapshot } from '../settings/definitions.js'
import {
  GENERIC_FONT_FAMILIES,
  UNIFORM_FONTS,
  UNIFORM_PAGE_IDENTITY,
  acceptLanguageFor,
  languagesFor,
  normalizeLanguageTag,
  normalizeTimeZone,
  uniformBrands,
  uniformFullVersion,
  uniformUserAgent,
  type UserAgentBrand
} from './identity.js'
import { noiseTable, seededIndex, siteSeed } from './seed.js'

/**
 * What the page side of the masking is told to do (spec 4).
 *
 * A plan is **plain data**: numbers, strings, arrays. That is a hard requirement
 * rather than a style choice, because it crosses two boundaries that only copy
 * values — the synchronous IPC reply into the preload, and `executeInMainWorld`
 * into the page's own JavaScript world. Anything with behaviour would arrive as
 * an empty object on the other side.
 *
 * The plan is built here, in the core, and not in the preload: this is where the
 * settings live, where the real user agent is known, and — the reason that
 * decides it — where a unit test can call it without a browser. The preload's job
 * shrinks to fetching a plan and handing it over.
 *
 * The profile secret never crosses into the plan. Only the seed *derived* from it
 * for one site does, so a page that somehow read every value it was given still
 * learns nothing that another site could recognise.
 *
 * Type-only import of the settings snapshot on purpose: `definitions.ts` pulls in
 * zod, and this module is loaded by the preload at runtime.
 */

export interface CanvasNoise {
  /** Signed per-channel deltas, indexed by pixel position. Never empty. */
  readonly deltas: readonly number[]
  /** One pixel in this many is perturbed, along each row. */
  readonly stride: number
  /** Where in the row the perturbed pixels start; differs per site. */
  readonly offset: number
}

export interface AudioNoise {
  readonly deltas: readonly number[]
  /** Multiplier applied to a delta before it is added to a sample. */
  readonly scale: number
}

export interface GpuPlan {
  readonly vendor: string
  readonly renderer: string
  readonly unmaskedVendor: string
  readonly unmaskedRenderer: string
}

export interface FontPlan {
  readonly allowed: readonly string[]
  readonly generic: readonly string[]
}

export interface ScreenPlan {
  readonly colorDepth: number
}

export interface DevicePlan {
  readonly hardwareConcurrency: number
  readonly deviceMemory: number
  readonly maxTouchPoints: number
  readonly connection: {
    readonly effectiveType: string
    readonly rtt: number
    readonly downlink: number
    readonly saveData: boolean
  }
  /** Reported storage quota in bytes. The real one is a proxy for disk size. */
  readonly storageQuota: number
  /** APIs removed outright, because their only use here is enumeration. */
  readonly removed: readonly string[]
}

export interface UserAgentPlan {
  readonly userAgent: string
  readonly platform: string
  readonly vendor: string
  readonly brands: readonly UserAgentBrand[]
  readonly uaPlatform: string
  readonly platformVersion: string
  readonly architecture: string
  readonly bitness: string
  readonly model: string
  readonly fullVersion: string
}

export interface LocalePlan {
  readonly language: string
  readonly languages: readonly string[]
}

export interface MaskingPlan {
  readonly version: 1
  readonly userAgent: UserAgentPlan | null
  readonly locale: LocalePlan | null
  readonly timeZone: string | null
  readonly canvas: CanvasNoise | null
  readonly webgl: GpuPlan | null
  readonly audio: AudioNoise | null
  readonly fonts: FontPlan | null
  readonly screen: ScreenPlan | null
  readonly devices: DevicePlan | null
}


/**
 * Canvas noise parameters.
 *
 * `stride` is the trade-off made visible. Perturbing every pixel would cost a
 * pass over the whole image on every read — tens of milliseconds for a
 * full-window canvas, in a loop an image editor may run per frame. Perturbing
 * one pixel in 251 along each row changes any hash a fingerprinting script can
 * take (its canvases are a few hundred pixels wide, so several pixels per row
 * are still hit) while touching a fraction of a percent of the data. 251 is prime
 * so the pattern does not align with power-of-two image widths.
 */
const CANVAS_NOISE = { count: 64, magnitude: 2, stride: 251 } as const

/** Below float32's own resolution at unit amplitude, and about -100 dB. */
const AUDIO_NOISE = { count: 64, magnitude: 9, scale: 1e-6 } as const

/** 10 GiB: a plausible quota that is not the real disk size. */
const STORAGE_QUOTA = 10 * 1024 * 1024 * 1024

/**
 * Device APIs removed rather than normalised.
 *
 * Everything here exists only to enumerate hardware, and the permission handler
 * already refuses all of them (`session/permission-policy.ts`) — so removing the
 * entry point costs no working feature and takes away the enumeration surface
 * that survives a refusal. `getBattery` is the one that is not a picker: charge
 * level and discharge time are a short-lived cross-site identifier, which is why
 * Firefox dropped the API entirely.
 */
const REMOVED_DEVICE_APIS: readonly string[] = ['usb', 'serial', 'hid', 'bluetooth', 'getBattery']

export interface PlanInput {
  readonly settings: SettingsSnapshot
  /** Lives for one run of the browser; see `seed.ts`. */
  readonly profileSecret: string
  /** Host of the document being masked. May be empty for `about:` and `data:`. */
  readonly host: string
  /** The session's real user agent, which the masked one is derived from. */
  readonly userAgent: string
}

/**
 * The plan for one document, or `null` when masking is off entirely.
 *
 * Every branch is gated on its own setting, so turning one off changes exactly
 * one thing — and `fingerprint.mode: 'off'` short-circuits all of them, because a
 * master switch that leaves three measures running is not off.
 */
export function maskingPlanFor(input: PlanInput): MaskingPlan | null {
  const { settings } = input
  if (settings['fingerprint.mode'] === 'off') return null

  const seed = siteSeed(input.profileSecret, input.host)

  return {
    version: 1,
    userAgent: settings['fingerprint.normalizeUserAgent'] ? userAgentPlan(input.userAgent) : null,
    locale: localePlan(settings),
    timeZone: normalizeTimeZone(settings['fingerprint.spoofTimezone']),
    canvas: settings['fingerprint.maskCanvas']
      ? {
          deltas: noiseTable(seed, CANVAS_NOISE.count, CANVAS_NOISE.magnitude),
          stride: CANVAS_NOISE.stride,
          offset: seededIndex(seed, CANVAS_NOISE.stride)
        }
      : null,
    webgl: settings['fingerprint.maskWebgl']
      ? {
          vendor: UNIFORM_PAGE_IDENTITY.gpuVendor,
          renderer: UNIFORM_PAGE_IDENTITY.gpuRenderer,
          unmaskedVendor: UNIFORM_PAGE_IDENTITY.gpuUnmaskedVendor,
          unmaskedRenderer: UNIFORM_PAGE_IDENTITY.gpuUnmaskedRenderer
        }
      : null,
    audio: settings['fingerprint.maskAudio']
      ? {
          // A second seed for the same site: canvas and audio noise must not be
          // derivable from one another, or reading one would predict the other.
          deltas: noiseTable(seed ^ 0x5f5e_1000, AUDIO_NOISE.count, AUDIO_NOISE.magnitude),
          scale: AUDIO_NOISE.scale
        }
      : null,
    fonts: settings['fingerprint.limitFonts']
      ? { allowed: UNIFORM_FONTS, generic: GENERIC_FONT_FAMILIES }
      : null,
    screen: settings['fingerprint.normalizeScreen']
      ? { colorDepth: UNIFORM_PAGE_IDENTITY.colorDepth }
      : null,
    devices: settings['fingerprint.blockDeviceApis']
      ? {
          hardwareConcurrency: UNIFORM_PAGE_IDENTITY.hardwareConcurrency,
          deviceMemory: UNIFORM_PAGE_IDENTITY.deviceMemory,
          // The claimed machine is a desktop, so it has no touch screen.
          maxTouchPoints: 0,
          // Normalised rather than removed: Chrome ships Network Information, and
          // a missing `navigator.connection` on a browser claiming to be Chrome
          // would be its own signal. The values are the common case.
          connection: { effectiveType: '4g', rtt: 50, downlink: 10, saveData: false },
          storageQuota: STORAGE_QUOTA,
          removed: REMOVED_DEVICE_APIS
        }
      : null
  }
}

function userAgentPlan(realUserAgent: string): UserAgentPlan {
  return {
    userAgent: uniformUserAgent(realUserAgent),
    platform: UNIFORM_PAGE_IDENTITY.navigatorPlatform,
    vendor: UNIFORM_PAGE_IDENTITY.vendor,
    brands: uniformBrands(realUserAgent),
    uaPlatform: UNIFORM_PAGE_IDENTITY.uaPlatform,
    platformVersion: UNIFORM_PAGE_IDENTITY.platformVersion,
    architecture: UNIFORM_PAGE_IDENTITY.architecture,
    bitness: UNIFORM_PAGE_IDENTITY.bitness,
    model: UNIFORM_PAGE_IDENTITY.model,
    fullVersion: uniformFullVersion(realUserAgent)
  }
}

/**
 * What the page should report as its language — always whatever the
 * `Accept-Language` header says.
 *
 * There is no boolean for this, and that is the point: the page's locale is not
 * an independent decision. `navigator.language` disagreeing with the header the
 * same request carries is the contradiction spec 4 warns about, and it is the
 * easiest one to create by accident, because the two are set in different files.
 * So both read from `resolvedLocale`: an explicit `spoofLocale` if it is usable,
 * otherwise the uniform locale while the header is normalised, otherwise nothing
 * — leaving the real locale visible to the page exactly when the real one is
 * also being sent.
 */
function localePlan(settings: SettingsSnapshot): LocalePlan | null {
  const locale = resolvedLocale(settings)
  if (locale === null) return null
  return { language: locale, languages: languagesFor(locale) }
}

/**
 * The locale both the header and the page use, or `null` for "do not touch".
 *
 * Exported because `session/headers.ts` has to answer the same question, and two
 * files answering it separately is how the pair drifts apart.
 */
export function resolvedLocale(settings: SettingsSnapshot): string | null {
  const requested = normalizeLanguageTag(settings['fingerprint.spoofLocale'])
  if (requested !== null) return requested
  if (settings['fingerprint.normalizeAcceptLanguage']) return UNIFORM_PAGE_IDENTITY.language
  return null
}

/** The `Accept-Language` value that goes with `resolvedLocale`. */
export function resolvedAcceptLanguage(settings: SettingsSnapshot): string | null {
  const locale = resolvedLocale(settings)
  if (locale === null) return null
  // Identical to UNIFORM_IDENTITY.acceptLanguage for the uniform locale; asserted
  // by a test, so the two cannot drift.
  return acceptLanguageFor(locale)
}
