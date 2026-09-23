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
 * becomes a dialogue and an awaited answer, and `answerPermissionCheck` is its
 * synchronous twin for `permissions.query()`. Both stay in this file, and both
 * stay free of Electron, a clock and a source of randomness, so that "what
 * happens when the user says no" is a unit test rather than something only a
 * running browser can be asked.
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
 * The origin a question is asked and remembered for: the top-level site, or `null`.
 *
 * `frame` is whoever asked — Electron's `requestingUrl` for a request, its `requestingOrigin` for a
 * check. `topLevel` is the tab's own document; `null` means there is none to compare with, which is a
 * check arriving without a `webContents` (a service worker's), and then the frame is its own top level.
 *
 * A frame on another origin than its page gets `null`, and so a refusal. The dialogue names one site
 * and the answer is filed under one site; for an embedded third party that site would be the page
 * around it, so "allow example.com?" would be answered for `ads.example.net`. Chromium has already
 * applied Permissions Policy before either handler runs, but neither handler is told whether the frame
 * was *delegated* — `PermissionRequest` carries only `requestingUrl` and `isMainFrame`, and the check's
 * `embeddingOrigin` says merely that the frame is cross-origin. With nothing to tell a delegated frame
 * from an undelegated one, the embedded frame is refused rather than attributed to the page.
 *
 * An opaque origin — `data:`, a sandboxed frame, `about:blank` — is `null` too. It serialises as the
 * string `"null"`, which would put one remembered answer on every such document at once.
 */
export function topLevelOrigin(frame: {
  readonly frame: string | null
  readonly topLevel: string | null
}): string | null {
  const own = originOf(frame.frame)
  const top = frame.topLevel === null ? own : originOf(frame.topLevel)
  return own !== null && own === top ? own : null
}

function originOf(url: string | null): string | null {
  if (url === null) return null
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
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
 * The subjects "ask" is a silent refusal for.
 *
 * Camera, microphone and screen sharing keep exactly the behaviour they had before prompting was
 * wired: `allow` and `deny` answer alone, and `ask` refuses with no dialogue and nothing remembered.
 * That is a decided stance rather than a missing feature, and it is a set here rather than a check at
 * each call site so that the request and the check cannot disagree about it.
 */
const SILENT_WHEN_ASKED: ReadonlySet<PermissionSubject> = new Set<PermissionSubject>([
  'camera',
  'microphone',
  'camera-and-microphone',
  'display-capture'
])

/** Whether a settings value of `ask` may become a dialogue for this subject. */
export function isAskableSubject(subject: PermissionSubject): boolean {
  return !SILENT_WHEN_ASKED.has(subject)
}

/**
 * How a prompt ended when nobody answered it: the window closed, the queue was full, the dialogue
 * was displaced or dismissed.
 *
 * It refuses, like `block`, and unlike `block` it is never remembered. A remembered refusal is a
 * decision about a site, and only a person can make one; filing "the window closed" as "this site is
 * blocked" would leave eight sites blocked by one closed window, none of which anybody refused.
 *
 * Deliberately *not* a member of `PERMISSION_ANSWERS`. That list is the enum `permissions:answer`
 * validates against, so this value cannot arrive over IPC: only the core can conclude that nobody
 * answered.
 */
export const UNANSWERED = 'unanswered'

/** Everything a prompt can end in: what a person chose, or that nobody did. */
export type PermissionOutcome = PermissionAnswer | typeof UNANSWERED

/**
 * What an outcome leaves behind on disk.
 *
 * `allow-once` remembers nothing — that is the point of it. See
 * `PERMISSION_ANSWERS` for why there is no matching "block once". `UNANSWERED`
 * remembers nothing either: see there.
 */
export function rememberedDecision(outcome: PermissionOutcome): 'allow' | 'deny' | null {
  if (outcome === 'allow-always') return 'allow'
  if (outcome === 'block') return 'deny'
  return null
}

/** Whether an outcome grants the request. Only the two ways a person can say yes do. */
export function grantsPermission(outcome: PermissionOutcome): boolean {
  return outcome === 'allow-once' || outcome === 'allow-always'
}

// --- asking --------------------------------------------------------------------

/** One request from a page, already reduced to the three facts a decision needs. */
export interface PermissionRequestDetails {
  /** Electron's name for it, `media` included. */
  readonly permission: string
  /** Electron's `details.mediaTypes`; empty for everything that is not `media`. */
  readonly mediaTypes: readonly string[]
  /** As `topLevelOrigin` resolved it: the page's site, or `null` for anything that must not be asked. */
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
/** What a dialogue asks: which site, about what. */
export interface PermissionQuestion {
  readonly origin: string
  readonly subject: PermissionSubject
}

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
  /**
   * Presents the dialogue and resolves with what the user chose — or with `UNANSWERED` when the
   * dialogue ended without a choice, which refuses and is not remembered.
   */
  prompt(request: PermissionQuestion): Promise<PermissionOutcome>
  remember(origin: string, subject: PermissionSubject, decision: 'allow' | 'deny'): void
}

/**
 * Everything short of asking: `true` or `false` when the answer is already known, or the question
 * a dialogue would have to put.
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
 *  3. Camera, microphone and screen sharing are never asked about: `ask` refuses
 *     them silently, exactly as it did before there was a dialogue. See
 *     `isAskableSubject`.
 *  4. A request with no trustworthy top-level origin is refused — an embedded
 *     frame from another site included, see `topLevelOrigin`. "A page wants your
 *     location" names no site, so consent to it means nothing.
 *  5. Only then does memory answer, and only a question it cannot answer is
 *     returned for asking.
 *
 * The origin rule sits after the settings on purpose: an `allow` or `deny` in the
 * settings never needed a site, and camera and microphone must keep answering
 * the way they always have, embedded frames included.
 */
export function settleWithoutAsking(
  request: PermissionRequestDetails,
  deps: Pick<PermissionPrompting, 'settings' | 'recall'>
): boolean | PermissionQuestion {
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
  if (!isAskableSubject(subject)) return false

  const origin = request.origin
  if (origin === null) return false

  const remembered = deps.recall(origin, subject)
  if (remembered === 'allow') return true
  if (remembered === 'deny') return false
  return { origin, subject }
}

/**
 * The whole path from "a page asked" to "yes" or "no".
 *
 * `settleWithoutAsking`, then the dialogue for whatever it could not settle. Only an
 * answer a person gave is remembered — `rememberedDecision` turns `UNANSWERED` into
 * nothing, so a closed window or a full queue refuses this once and leaves the
 * site to be asked again.
 *
 * Returns a plain boolean because that is what Electron's callback takes. Every
 * way of not getting an answer — no origin, no name, a dismissed dialogue, a
 * closed window — arrives at `false`.
 */
export async function resolvePermissionRequest(
  request: PermissionRequestDetails,
  deps: PermissionPrompting
): Promise<boolean> {
  const settled = settleWithoutAsking(request, deps)
  if (typeof settled === 'boolean') return settled

  const outcome = await deps.prompt(settled)
  const persist = rememberedDecision(outcome)
  if (persist !== null) deps.remember(settled.origin, settled.subject, persist)
  return grantsPermission(outcome)
}

/**
 * Prompting with nobody to ask: the settings and nothing else.
 *
 * What a request gets when there is no window to show a dialogue in, and what a session gets when
 * it was hardened without a prompt at all. It remembers nothing and reads nothing back, and every
 * dialogue it would have shown ends `UNANSWERED` — so `allow` and `deny` in the settings still
 * answer, exactly as they did before prompting existed, and `ask` refuses without leaving a trace.
 */
export function unaskedPrompting(settings: SettingsSnapshot): PermissionPrompting {
  return {
    settings,
    recall: () => 'ask',
    prompt: () => Promise.resolve(UNANSWERED),
    // Deliberately empty: nothing was answered, so there is nothing to keep.
    remember: () => {}
  }
}

// --- checking ------------------------------------------------------------------

/** One `permissions.query()`-style check, reduced to what the decision reads. */
export interface PermissionCheck {
  /** Electron's name for it. */
  readonly permission: string
  /** Electron's `requestingOrigin`: the frame that is checking. */
  readonly requestingOrigin: string
  /**
   * Electron's `details.embeddingOrigin`: the page's origin, set only when a cross-origin
   * subframe is checking. `null` otherwise.
   */
  readonly embeddingOrigin: string | null
  /** The tab's document, or `null` when the check came without a `webContents`. */
  readonly topLevelUrl: string | null
}

/**
 * The synchronous counterpart of `resolvePermissionRequest`, for Electron's check handler.
 *
 * Without a check handler Chromium answers `permissions.query()` from its own
 * defaults, so a page could see "granted" for something the request handler
 * would refuse. With one that read only the settings, a site the user had told
 * "always allow" would still read `denied` and might never ask.
 *
 * Only ever `true` for something that would be granted without a dialogue: the
 * settings allow it, or this site was told "always allow" for the kind of window
 * `deps.recall` is bound to. A question still to be asked is `false` — the page
 * then requests, and the request is where asking happens.
 *
 * Media is checked with no device named, and so, as before, is never reported as
 * granted: `permissionSubject('media', [])` has no name and `media` has no
 * setting of its own. That keeps the camera and microphone exactly where they
 * were.
 */
export function answerPermissionCheck(
  check: PermissionCheck,
  deps: Pick<PermissionPrompting, 'settings' | 'recall'>
): boolean {
  const origin = topLevelOrigin({
    frame: check.requestingOrigin,
    topLevel: check.embeddingOrigin ?? check.topLevelUrl
  })
  return (
    settleWithoutAsking({ permission: check.permission, mediaTypes: [], origin }, deps) === true
  )
}
