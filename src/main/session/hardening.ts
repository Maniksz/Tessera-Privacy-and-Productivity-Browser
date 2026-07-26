import { randomUUID } from 'node:crypto'
import { app, type Session, type WebContents } from 'electron'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { uniformUserAgent } from '@shared/fingerprint/identity.js'
import { maskingPlanFor, resolvedAcceptLanguage } from '@shared/fingerprint/plan.js'
import { FINGERPRINT_PLAN_CHANNEL } from '@shared/fingerprint/wire.js'
import {
  decideMediaPermission,
  decidePermission,
  requestOrigin,
  type PermissionDecision
} from './permission-policy.js'
import { filterResponseHeaders, normalizeRequestHeaders } from './headers.js'

/**
 * Session hardening (spec 4).
 *
 * Thin on purpose: every decision this file makes lives in `permission-policy.ts`
 * or `headers.ts` as a pure function, and what remains here is the Electron
 * plumbing that cannot be tested without a running browser. The split is what
 * makes spec 7's requirement — a test proving each privacy setting changes real
 * traffic — actually writable.
 *
 * The load-bearing part is `setPermissionRequestHandler`. With no handler
 * installed, Electron **approves** camera, microphone, geolocation and
 * notifications without asking. Leaving it unset is not a neutral default, it is
 * the most permissive one.
 */

/**
 * A response as an observer sees it.
 *
 * The counterpart to `ObservedRequest` in `privacy/RequestPipeline.ts`, and it exists
 * because one moment does not have both facts: `onBeforeRequest` knows the address and
 * the resource type, while the `Content-Type` — the only thing that identifies the
 * ordinary extension-less CDN address as media — exists solely once response headers
 * come back.
 *
 * Headers travel as a flattened record rather than as the two values a media observer
 * happens to want. Pulling `content-type` out here would put header parsing in a file
 * that cannot be unit-tested without a running browser, and header names arrive in
 * whatever casing the server chose. `main/media/observation.ts` does that lookup, where
 * a test can reach it.
 */
export interface ObservedResponse {
  readonly url: string
  readonly resourceType: string
  readonly documentUrl: string | null
  /** See `ObservedRequest.webContentsId`: the id, never the object. */
  readonly webContentsId: number | null
  readonly statusCode: number
  /** Name -> value, multiple values newline-joined, as `flattenResponseHeaders` produces. */
  readonly headers: Readonly<Record<string, string>>
}

export interface HardeningOptions {
  session: Session
  getSettings(): SettingsSnapshot
  /**
   * Asks the user. The scaffold has no prompt UI yet, so the default resolves to
   * `false` — the correct failure mode: unanswered means denied.
   */
  requestFromUser?: (permission: string, origin: string | null) => Promise<boolean>
  /**
   * Every response whose headers passed through here.
   *
   * A hook on the existing `onHeadersReceived` registration rather than a second one:
   * Electron keeps a single listener per `webRequest` event, so registering
   * `onHeadersReceived` again anywhere else would silently replace this one and take
   * the response-header filtering with it. That is the same trap
   * `privacy/RequestPipeline.ts` documents, and an architecture test counts the
   * registrations for exactly this reason.
   */
  onResponse?: (observation: ObservedResponse) => void
}

export function applySessionHardening(options: HardeningOptions): void {
  const { session, getSettings } = options
  // `Promise.resolve(false)` rather than an async function with no await: the
  // signature has to return a promise, and unanswered must mean denied.
  const ask = options.requestFromUser ?? ((): Promise<boolean> => Promise.resolve(false))
  const onResponse = options.onResponse ?? (() => {})

  // --- permissions ---------------------------------------------------------
  session.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const settings = getSettings()

    const decision: PermissionDecision =
      permission === 'media'
        ? decideMediaPermission((details as { mediaTypes?: string[] }).mediaTypes ?? [], settings)
        : decidePermission(permission, settings)

    if (decision === 'allow') {
      callback(true)
      return
    }
    if (decision === 'deny') {
      callback(false)
      return
    }

    const origin = requestOrigin(
      (details as { requestingUrl?: string }).requestingUrl ?? null,
      webContents.getURL()
    )
    void ask(permission, origin).then(callback)
  })

  /**
   * Synchronous counterpart. Without it, Chromium answers `permissions.query()`
   * from its own defaults, so a page could see "granted" for something the request
   * handler above would refuse.
   */
  session.setPermissionCheckHandler((_webContents, permission) => {
    return decidePermission(permission, getSettings()) === 'allow'
  })

  /** WebHID / WebSerial / WebUSB device pickers. */
  session.setDevicePermissionHandler(() => false)

  /** Screen sharing: refuse rather than present a picker (spec 4). */
  session.setDisplayMediaRequestHandler((_request, callback) => {
    // An empty response signals refusal to Electron. There is no allow path yet
    // because there is no prompt to grant through; wiring one without asking the
    // user would be worse than refusing.
    callback({})
  })

  session.setBluetoothPairingHandler((_details, callback) => {
    callback({ confirmed: false })
  })

  // --- privacy headers -----------------------------------------------------
  // One registration per event only. Electron keeps a single listener per
  // webRequest event, so a second registration elsewhere would silently replace
  // this one — the same trap documented in `privacy/RequestPipeline.ts`.
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = normalizeRequestHeaders(
      details.requestHeaders,
      details.url,
      getSettings()
    )
    callback({ requestHeaders: { ...requestHeaders } })
  })

  session.webRequest.onHeadersReceived((details, callback) => {
    const received = flattenResponseHeaders(details.responseHeaders)
    const documentUrl = details.frame?.url ?? null
    const responseHeaders = filterResponseHeaders(
      received,
      { documentUrl, requestUrl: details.url },
      getSettings()
    )
    /*
      The observation carries what the server sent, not what survived the filter.

      Two reasons pull the same way. What an observer is deciding is what the *bytes*
      are, and that is the server's statement — a browser that had stripped a header
      before looking at it would be reasoning about its own output. And the filter is
      free to grow: the day it starts removing something a media observer reads, the
      failure would be a feature that quietly stops recognising files, with the setting
      that caused it nowhere near the symptom.

      Unguarded, like `onBlocked` and `onRequest`: an observer that throws here would
      break every response on the session, so not throwing is the observer's
      obligation. `MediaRegistry` counts its own failures instead.
    */
    onResponse({
      url: details.url,
      resourceType: details.resourceType,
      documentUrl,
      webContentsId: details.webContentsId ?? null,
      statusCode: details.statusCode,
      headers: received
    })
    callback({ responseHeaders: expandResponseHeaders(responseHeaders) })
  })

  // --- fingerprinting ------------------------------------------------------
  applySessionIdentity(session, getSettings())
  installFingerprintResponder(getSettings)

  // --- DNS -----------------------------------------------------------------
  applySecureDns(getSettings())
}

/**
 * The session-wide half of the fingerprint masking (spec 4).
 *
 * `setUserAgent` is what makes `navigator.userAgent` itself change, and unlike a
 * page-level patch it also covers workers, service workers and subframes — the
 * places a preload never reaches. The header transform in `headers.ts` produces
 * the same string for the network side, so the two cannot disagree.
 *
 * Applied once, when the session is created, which is why every
 * `fingerprint.*` setting is declared `applies: 'new-tab'` rather than `'live'`:
 * an existing renderer keeps the user agent it was born with.
 */
function applySessionIdentity(session: Session, settings: SettingsSnapshot): void {
  if (settings['fingerprint.mode'] === 'off') return

  const userAgent = settings['fingerprint.normalizeUserAgent']
    ? uniformUserAgent(session.getUserAgent())
    : session.getUserAgent()
  const acceptLanguage = resolvedAcceptLanguage(settings)

  // Passed to Chromium rather than only rewritten in the header, because this is
  // also where `navigator.languages` comes from — including inside workers.
  if (acceptLanguage === null) session.setUserAgent(userAgent)
  else session.setUserAgent(userAgent, acceptLanguage)
}

/**
 * One secret per session, for one run of the browser.
 *
 * Per session, so a private window is a different visitor from the normal one —
 * sharing the secret would let a site recognise the same person across a mode
 * whose entire purpose is that it cannot. For one run only, because a secret that
 * survived restarts would make the canvas noise it derives a *permanent* local
 * identifier, which is the thing being defended against rather than a defence.
 */
const profileSecrets = new WeakMap<Session, string>()

function profileSecretFor(session: Session): string {
  const existing = profileSecrets.get(session)
  if (existing !== undefined) return existing
  const secret = randomUUID()
  profileSecrets.set(session, secret)
  return secret
}

let responderInstalled = false

/**
 * Answers the preload's synchronous request for a masking plan.
 *
 * ## Why synchronous
 *
 * The masking has to be in place before the first page script runs, and the
 * preload therefore cannot await anything: a promise resolves a turn too late,
 * and by then the page has already read `navigator`. So the preload blocks for one
 * round trip at `document-start` and gets a plan built from live settings — which
 * makes a changed setting take effect on the next navigation rather than on the
 * next restart.
 *
 * ## Why not through the validating router
 *
 * `ipc/router.ts` is the gate for the *contract* — the operations the browser
 * exposes to a renderer. This is not one of them: it carries no operation, changes
 * nothing, and answers with policy the core itself decided. It is also
 * unreachable by web content, which has no bridge and cannot touch `ipcRenderer`
 * at all. Routing it through the contract would mean adding a channel every page
 * uses to the surface the sender policy has to defend.
 *
 * The alternative — passing the plan in `webPreferences.additionalArguments`
 * beside the role — would avoid the round trip entirely, at the cost of freezing
 * the plan when the view is created and rebuilding it in every place a view is
 * made.
 */
function installFingerprintResponder(getSettings: () => SettingsSnapshot): void {
  // App-level, so it is installed once even though hardening runs per session.
  // The plan is built from `contents.session`, so each session still gets its own
  // secret and its own user agent.
  if (responderInstalled) return
  responderInstalled = true

  app.on('web-contents-created', (_event, contents) => {
    // Per-webContents rather than on `ipcMain`, so the listener dies with the view
    // that could have used it and nothing accumulates over a long session.
    contents.on('ipc-message-sync', (event, channel, ...args) => {
      if (channel !== FINGERPRINT_PLAN_CHANNEL) return
      const session = contents.session
      event.returnValue = maskingPlanFor({
        settings: getSettings(),
        profileSecret: profileSecretFor(session),
        host: planHost(args[0], contents.id),
        userAgent: session.getUserAgent()
      })
    })
  })
}

/**
 * The site a plan is derived for.
 *
 * A document with no host — `about:blank`, a `data:` URL — would otherwise share
 * one seed with every other hostless document, and two unrelated sites could then
 * open one each and compare the noise they got. Falling back to the view's own id
 * keeps such a document consistent with itself while linking it to nothing.
 */
function planHost(reported: unknown, webContentsId: number): string {
  if (typeof reported === 'string' && reported !== '') return reported
  return `blank-${webContentsId}.invalid`
}

/**
 * Electron gives response headers as name -> string[]; the pure filter works on
 * name -> string. Multiple values are joined with a newline, which is how
 * `Set-Cookie` is conventionally represented when it has to be a single string,
 * and is round-tripped by `expandResponseHeaders`.
 */
function flattenResponseHeaders(
  headers: Record<string, string[]> | undefined
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, values] of Object.entries(headers ?? {})) {
    out[name] = values.join('\n')
  }
  return out
}

function expandResponseHeaders(
  headers: Readonly<Record<string, string>>
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    out[name] = value.split('\n')
  }
  return out
}

/**
 * Encrypted DNS (spec 4). Without it the ISP still learns every domain visited,
 * however well the traffic itself is encrypted.
 *
 * `configureHostResolver` is application-wide, not per-session.
 */
export function applySecureDns(settings: SettingsSnapshot): void {
  const mode = settings['network.secureDnsMode']
  const servers = settings['network.secureDnsServers']
  app.configureHostResolver({
    secureDnsMode: mode === 'off' ? 'off' : mode === 'automatic' ? 'automatic' : 'secure',
    secureDnsServers: mode === 'off' ? [] : [...servers],
    // Chromium's own built-in resolver rules can otherwise bypass the configured
    // servers.
    enableBuiltInResolver: true
  })
}

/**
 * Closes the local-IP leak through WebRTC, which persists even behind a VPN
 * (spec 4). Per-webContents, so it is applied when each tab is created.
 */
export function applyWebRtcPolicy(webContents: WebContents, settings: SettingsSnapshot): void {
  webContents.setWebRTCIPHandlingPolicy(settings['network.webrtcIpPolicy'])
}
