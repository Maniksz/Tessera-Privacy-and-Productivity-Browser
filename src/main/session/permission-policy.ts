import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type {
  PermissionAnswer,
  PermissionSubject
} from '@shared/overlay/permission.js'

/**
 * Permission decisions, as pure functions.
 *
 * Extracted from `hardening.ts` so they can be tested directly. This is the code
 * that decides whether a page gets the camera; a decision like that being
 * exercised only by hand is a decision nobody has actually checked.
 *
 * Electron's default with no handler installed is to **approve** camera,
 * microphone, geolocation and notifications without asking. Not configuring this
 * is not a neutral choice — it is the most permissive one (spec 4).
 *
 * `resolvePermissionRequest` at the bottom is where a settings value of `ask`
 * becomes a dialogue and an awaited answer. It stays in this file, and it stays
 * free of Electron, a clock and a source of randomness, so that "what happens
 * when the user says no" is a unit test rather than something only a running
 * browser can be asked.
 */

export type PermissionDecision = 'allow' | 'deny' | 'ask'

/** Electron permission names mapped to the settings key that governs them. */
export const PERMISSION_SETTINGS = {
  geolocation: 'permissions.geolocation',
  notifications: 'permissions.notifications',
  'clipboard-read': 'permissions.clipboard',
  'clipboard-sanitized-write': 'permissions.clipboard',
  'display-capture': 'permissions.displayCapture',
  midi: 'permissions.midi',
  midiSysex: 'permissions.midi',
  'storage-access': 'permissions.persistentStorage',
  'top-level-storage-access': 'permissions.persistentStorage'
} as const satisfies Record<string, keyof SettingsSnapshot>

/**
 * Refused regardless of settings: device buses and ambient sensors have no
 * legitimate use in a browser built for privacy, and each is a strong
 * fingerprinting surface (spec 4).
 */
export const ALWAYS_DENIED: ReadonlySet<string> = new Set([
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'idle-detection',
  'window-management',
  'speaker-selection',
  'keyboard-lock',
  // Would let a page launch other applications.
  'openExternal'
])

/**
 * Granted without prompting because they are UI affordances rather than data
 * access.
 *
 * `fullscreen` is load-bearing: tile fullscreen (spec 2) depends on the page's
 * fullscreen request being honoured. Denying it would break the browser's central
 * feature in exchange for a privacy gain that does not exist.
 */
export const ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  'fullscreen',
  'pointerLock',
  'mediaKeySystem'
])

export function toDecision(value: unknown): PermissionDecision {
  return value === 'allow' ? 'allow' : value === 'ask' ? 'ask' : 'deny'
}

/**
 * Decides a single permission.
 *
 * An unmapped permission is denied. New Chromium releases add permissions, and
 * the default for anything we have not reasoned about must be "no" — otherwise a
 * version bump quietly widens what pages can do.
 */
export function decidePermission(
  permission: string,
  settings: SettingsSnapshot
): PermissionDecision {
  if (ALWAYS_DENIED.has(permission)) return 'deny'
  if (ALWAYS_ALLOWED.has(permission)) return 'allow'

  const key = (PERMISSION_SETTINGS as Record<string, keyof SettingsSnapshot | undefined>)[
    permission
  ]
  if (key === undefined) return 'deny'
  return toDecision(settings[key])
}

/**
 * Decides a `media` request, which covers camera and microphone together.
 *
 * They are separate settings because users reason about them separately, and the
 * strictest decision wins: a request for both is denied if either is denied.
 * Granting the pair because one half was allowed would hand over a microphone the
 * user never agreed to.
 */
export function decideMediaPermission(
  mediaTypes: readonly string[],
  settings: SettingsSnapshot
): PermissionDecision {
  const decisions: PermissionDecision[] = []
  if (mediaTypes.includes('video')) decisions.push(toDecision(settings['permissions.camera']))
  if (mediaTypes.includes('audio')) decisions.push(toDecision(settings['permissions.microphone']))

  // A media request naming neither is not something to guess at.
  if (decisions.length === 0) return 'deny'
  if (decisions.includes('deny')) return 'deny'
  if (decisions.includes('ask')) return 'ask'
  return 'allow'
}

/**
 * Which origin a permission request came from, for the prompt and the stored
 * decision. Returns `null` when there is nothing trustworthy to show — better an
 * absent origin than a misleading one.
 */
export function requestOrigin(requestingUrl: string | null, senderUrl: string | null): string | null {
  for (const candidate of [requestingUrl, senderUrl]) {
    if (candidate === null || candidate === '') continue
    try {
      return new URL(candidate).origin
    } catch {
      continue
    }
  }
  return null
}

// --- naming the request --------------------------------------------------------

/**
 * Electron's permission names, translated into what a dialogue can say and a store
 * can key on.
 *
 * `satisfies Record<keyof typeof PERMISSION_SETTINGS, …>` is the whole reason this
 * is a separate table rather than a `switch`: a permission that gains a setting
 * without gaining a name would otherwise reach the prompt as an unnameable
 * request and be refused — a feature that fails by going silent, which is the
 * failure mode nobody notices.
 *
 * `media` is deliberately absent. It is not one permission; it is "camera and/or
 * microphone", and which one only `details.mediaTypes` says. See `mediaSubject`.
 */
const PERMISSION_SUBJECT_NAMES = {
  geolocation: 'geolocation',
  notifications: 'notifications',
  'clipboard-read': 'clipboard-read',
  'clipboard-sanitized-write': 'clipboard-write',
  'display-capture': 'display-capture',
  midi: 'midi',
  midiSysex: 'midi-sysex',
  'storage-access': 'storage-access',
  'top-level-storage-access': 'top-level-storage-access'
} as const satisfies Record<keyof typeof PERMISSION_SETTINGS, PermissionSubject>

/**
 * Which subject a media request is about.
 *
 * A request naming neither is not something to guess at, the same answer
 * `decideMediaPermission` gives — and in practice it never gets this far, because
 * that function has already refused it.
 */
function mediaSubject(mediaTypes: readonly string[]): PermissionSubject | null {
  const video = mediaTypes.includes('video')
  const audio = mediaTypes.includes('audio')
  if (video && audio) return 'camera-and-microphone'
  if (video) return 'camera'
  if (audio) return 'microphone'
  return null
}

/**
 * What this request is asking for, or `null` when there is no way to say.
 *
 * `null` is not a defensive branch: it is what an unmapped permission produces,
 * and the caller turns it into a refusal rather than a dialogue with a blank in
 * it.
 */
export function permissionSubject(
  permission: string,
  mediaTypes: readonly string[]
): PermissionSubject | null {
  if (permission === 'media') return mediaSubject(mediaTypes)
  const named = (PERMISSION_SUBJECT_NAMES as Record<string, PermissionSubject | undefined>)[
    permission
  ]
  return named ?? null
}

/**
 * What an answer leaves behind on disk.
 *
 * `allow-once` remembers nothing — that is the point of it. See
 * `PERMISSION_ANSWERS` for why there is no matching "block once".
 */
export function rememberedDecision(answer: PermissionAnswer): 'allow' | 'deny' | null {
  if (answer === 'allow-always') return 'allow'
  if (answer === 'block') return 'deny'
  return null
}

// --- asking --------------------------------------------------------------------

/** One request from a page, already reduced to the three facts a decision needs. */
export interface PermissionRequestDetails {
  /** Electron's name for it, `media` included. */
  readonly permission: string
  /** Electron's `details.mediaTypes`; empty for everything that is not `media`. */
  readonly mediaTypes: readonly string[]
  /** As `requestOrigin` resolved it, which is `null` when nothing trustworthy was found. */
  readonly origin: string | null
}

/**
 * Everything asking needs that this file must not contain.
 *
 * The prompt, the memory and the clock are all injected, which is what keeps the
 * decision path testable without a window: "Escape refuses" and "a remembered
 * answer is not asked again" are assertions about this function, and neither
 * should need a renderer to make.
 */
export interface PermissionPrompting {
  readonly settings: SettingsSnapshot
  /**
   * What this site was told last time.
   *
   * `ask` means nothing is remembered, so the three-valued answer is total and
   * there is no `null` to confuse with "remembered, and the answer was no".
   *
   * A private window is handed an implementation that always says `ask` and never
   * writes — see `PermissionStore.rulesFor`. That is why nothing here checks for
   * private mode: there is no flag at this call site to forget.
   */
  recall(origin: string, subject: PermissionSubject): PermissionDecision
  /** Presents the dialogue and resolves with what the user chose. */
  prompt(request: { origin: string; subject: PermissionSubject }): Promise<PermissionAnswer>
  remember(origin: string, subject: PermissionSubject, decision: 'allow' | 'deny'): void
}

/**
 * The whole path from "a page asked" to "yes" or "no".
 *
 * Order matters and each step is a refusal waiting to happen:
 *
 *  1. A request this file cannot *name* never reaches a dialogue. The settings are
 *     the whole answer for it: that is how `fullscreen` is granted and how
 *     anything a future Chromium adds is refused. A dialogue with a gap where the
 *     permission should be is one nobody can answer, and the temptation to fill
 *     the gap with the raw Chromium string is how "allow
 *     top-level-storage-access?" reaches a person.
 *  2. For everything else the setting decides first. `allow` and `deny` are
 *     answers the user has already given in the settings, and re-asking them would
 *     make the setting a suggestion.
 *  3. A request with no trustworthy origin is refused. "A page wants your camera"
 *     names no site, so consent to it means nothing.
 *  4. Only then is the user asked — and only if this site has not already been
 *     asked this question.
 *
 * Returns a plain boolean because that is what Electron's callback takes. Every
 * way of not getting an answer — no origin, no name, a dismissed dialogue, a
 * closed window — arrives at `false`.
 */
export async function resolvePermissionRequest(
  request: PermissionRequestDetails,
  deps: PermissionPrompting
): Promise<boolean> {
  const subject = permissionSubject(request.permission, request.mediaTypes)
  if (subject === null) {
    /*
      No name means no dialogue is possible, so the settings answer alone — and they can only
      answer, never ask: `decidePermission` returns `ask` from a settings value, and a permission
      with no name here has no settings entry either. The two tables are tied together by
      `satisfies` for exactly that reason.
    */
    return decidePermission(request.permission, deps.settings) === 'allow'
  }

  const decision =
    request.permission === 'media'
      ? decideMediaPermission(request.mediaTypes, deps.settings)
      : decidePermission(request.permission, deps.settings)

  if (decision === 'allow') return true
  if (decision === 'deny') return false

  const origin = request.origin
  if (origin === null) return false

  const remembered = deps.recall(origin, subject)
  if (remembered === 'allow') return true
  if (remembered === 'deny') return false

  const answer = await deps.prompt({ origin, subject })
  const persist = rememberedDecision(answer)
  if (persist !== null) deps.remember(origin, subject, persist)
  return answer !== 'block'
}
