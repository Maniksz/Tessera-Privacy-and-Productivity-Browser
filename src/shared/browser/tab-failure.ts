import type { MessageKey } from '../i18n/catalog.js'

/**
 * Whether a page that went wrong gets a failure state in its tile, and which one (U9, R9, R10).
 *
 * ## Why the tile draws it rather than an internal page
 *
 * KTD4: a loaded error page would become the tab's address — Strg+D would bookmark it, the history
 * would record it, the session would restore it. So the chrome UI draws the state in the tile's
 * rectangle over the hidden view, and the tab keeps naming the real page throughout. That is also why a
 * `TabFailure` carries a host and never an address: there is no field here a caller could mistake for
 * the page's.
 *
 * ## What stays silent, and why each one
 *
 *   - **A subframe.** An advert or an embed that failed — very often because the blocker refused it —
 *     is not the page failing. Covering a working page for it would be the worst answer available.
 *   - **`-3` (`ERR_ABORTED`).** Tessera causes it itself: the HTTPS-only redirect to its interstitial,
 *     the user pressing stop, a navigation that turned into a download. Electron does not report it as
 *     `did-fail-load` at all today; the rule is here so that stays true if it ever does.
 *   - **A clean exit**, which is a renderer being shut down on purpose.
 *   - **A memory eviction during an unload**, which is the unload working (U15 passes the flag).
 *
 * No Electron, no validation library: the chrome renderer imports this to choose its sentence, and the
 * schema over the same vocabulary lives in `model.ts`.
 */

export const FAILURE_KINDS = ['network', 'proxy', 'certificate', 'blocked', 'crashed'] as const
export type FailureKind = (typeof FAILURE_KINDS)[number]

/**
 * Who cancelled a main frame with `-20` (`ERR_BLOCKED_BY_CLIENT`).
 *
 * Carried because every one of them produces the same code, and only one has a way through: the
 * blocker's per-site exemption. Telemetry, the redirect-tracker stage and the kill switch are not
 * covered by that exemption (`site-exemption.ts` argues why), so offering "open anyway" for them would
 * be a button that reloads into the same refusal.
 */
export const BLOCK_SOURCES = ['blocker', 'telemetry', 'redirect', 'killSwitch'] as const
export type BlockSource = (typeof BLOCK_SOURCES)[number]

export interface TabFailure {
  kind: FailureKind
  /** The net error for a load, the exit code for a renderer. */
  code: number
  /** The page's host, or `''` for an address without one. */
  host: string
  /** Only on `blocked`, and only when the stage was recorded. `| undefined` matches the zod output. */
  source?: BlockSource | undefined
}

export type FailureSignal =
  | {
      event: 'did-fail-load'
      code: number
      isMainFrame: boolean
      /** `validatedURL`: the address that failed. */
      url: string
      /** The pipeline stage that cancelled this view's main frame, if one did. */
      blockedBy: BlockSource | null
    }
  | {
      event: 'render-process-gone'
      reason: string
      exitCode: number
      /** The page the renderer was showing. */
      url: string
      /** True while the tab is being unloaded on purpose. */
      unloading: boolean
    }

const ERR_ABORTED = -3
const ERR_BLOCKED_BY_CLIENT = -20
const ERR_INTERNET_DISCONNECTED = -106
const DNS_CODES: readonly number[] = [-105, -137]
/** Tunnel, both SOCKS failures, proxy connection, mandatory proxy configuration. */
const PROXY_CODES: readonly number[] = [-111, -120, -121, -130, -131]

/** Chromium numbers every certificate error in the 200 range (`net_error_list.h`). */
function isCertificateCode(code: number): boolean {
  return code <= -200 && code >= -299
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The state a tile should show for this event, or `null` for none. */
export function classifyFailure(signal: FailureSignal): TabFailure | null {
  if (signal.event === 'render-process-gone') {
    if (signal.reason === 'clean-exit') return null
    if (signal.reason === 'memory-eviction' && signal.unloading) return null
    return { kind: 'crashed', code: signal.exitCode, host: hostOf(signal.url) }
  }

  const { code } = signal
  if (!signal.isMainFrame || code >= 0 || code === ERR_ABORTED) return null
  const host = hostOf(signal.url)
  if (code === ERR_BLOCKED_BY_CLIENT) {
    return signal.blockedBy === null
      ? { kind: 'blocked', code, host }
      : { kind: 'blocked', code, host, source: signal.blockedBy }
  }
  if (PROXY_CODES.includes(code)) return { kind: 'proxy', code, host }
  if (isCertificateCode(code)) return { kind: 'certificate', code, host }
  return { kind: 'network', code, host }
}

/**
 * The source a request-pipeline stage stands for, or `null` for one that never cancels.
 *
 * Takes the stage id as a string because the ids belong to `main/privacy/RequestPipeline.ts`, which
 * shared code cannot import. `kill-switch` is the id U13's stage is to carry.
 */
export function blockSourceOf(stage: string): BlockSource | null {
  switch (stage) {
    case 'blocker':
    case 'telemetry':
    case 'redirect':
      return stage
    case 'kill-switch':
      return 'killSwitch'
    default:
      return null
  }
}

/** "Open anyway" exists for the blocker alone; see `BLOCK_SOURCES`. */
export function offersOpenAnyway(failure: TabFailure): boolean {
  return failure.kind === 'blocked' && failure.source === 'blocker'
}

export type FailureMessageKey = Extract<MessageKey, `error.${string}`>

/** The sentence a failure is explained with. */
export function failureMessage(failure: TabFailure): {
  key: FailureMessageKey
  params: { host: string }
} {
  const params = { host: failure.host }
  switch (failure.kind) {
    case 'crashed':
      return { key: 'error.crashed', params }
    case 'proxy':
      return { key: 'error.proxy', params }
    case 'certificate':
      return { key: 'error.certificate', params }
    case 'blocked':
      return { key: 'error.blocked', params }
    case 'network':
      if (DNS_CODES.includes(failure.code)) return { key: 'error.dnsFailed', params }
      if (failure.code === ERR_INTERNET_DISCONNECTED) return { key: 'error.offline', params }
      return { key: 'error.network', params }
  }
}
