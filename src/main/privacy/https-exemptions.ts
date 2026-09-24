import { randomBytes, timingSafeEqual } from 'node:crypto'
import {
  CONTINUE_TOKEN_BYTES,
  ContinueTokens,
  interstitialActionOf,
  type InterstitialNavigation
} from '@shared/privacy/https-token.js'
import { HOME_URL } from '@shared/url/omnibox.js'

/**
 * Which hosts the user let through HTTPS-only, per session, and the core's half of "Continue unencrypted"
 * (KTD3, R8).
 *
 * ## What an exemption covers
 *
 * A request is exempt when its own host is the exempted one **and** — for anything but the navigation itself —
 * the document it belongs to is on that host too. The user agreed to read `http://printer.lan` unencrypted;
 * they did not agree that every `http://` tracker, script or frame that page pulls in may skip the upgrade,
 * and they did not agree that the exempted host's pixel on somebody else's page may either. Those keep being
 * upgraded exactly as before.
 *
 * The key is the host as the network stack sees it: lower case and Punycode (the WHATWG parser does both,
 * which is `domainToASCII`), without a trailing dot, and with a port that is not the default — so
 * `HOST.example.` and `host.example` are one key, and `host.example:8080` is another.
 *
 * ## Where it lives
 *
 * In memory, one set per session. Nothing is written anywhere, so a restart forgets every exemption; and a
 * private window is its own session with its own set, which `WindowRegistry` forgets when the window closes —
 * so continuing in a private window changes nothing for the normal one (AE2).
 *
 * No Electron import: a `Session` is only ever a key here, so every rule is a unit test away.
 */

/** The exemption key of an `http:` address, or `null` for anything else. Parsed already, or not. */
export function hostKeyOf(url: string | URL): string | null {
  let parsed: URL
  try {
    parsed = typeof url === 'string' ? new URL(url) : url
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:') return null
  const host = parsed.hostname.replace(/\.$/, '')
  return parsed.port === '' ? host : `${host}:${parsed.port}`
}

/** A request as the exemption reads it: the three fields `RequestContext` already carries. */
export interface ExemptionQuery {
  readonly url: string
  readonly resourceType: string
  readonly documentUrl: string | null
}

export class HttpsExemptions {
  readonly #hosts = new Set<string>()

  /** Exempts the host of an `http:` address. False when there is no such host to exempt. */
  add(url: string): boolean {
    const key = hostKeyOf(url)
    if (key === null) return false
    this.#hosts.add(key)
    return true
  }

  /** `key` is `hostKeyOf(request.url)`, for a caller that has parsed the address already. */
  exempts(request: ExemptionQuery, key: string | null = hostKeyOf(request.url)): boolean {
    if (key === null || !this.#hosts.has(key)) return false
    // The navigation *is* the document, so there is no other document to be on.
    if (request.resourceType === 'mainFrame') return true
    return request.documentUrl !== null && hostKeyOf(request.documentUrl) === key
  }

  clear(): void {
    this.#hosts.clear()
  }
}

const bySession = new WeakMap<object, HttpsExemptions>()

/** The one set of this session, created the first time anybody asks. */
export function httpsExemptionsFor(session: object): HttpsExemptions {
  let exemptions = bySession.get(session)
  if (exemptions === undefined) {
    exemptions = new HttpsExemptions()
    bySession.set(session, exemptions)
  }
  return exemptions
}

/**
 * Empties and drops a session's set: a private window has closed.
 *
 * Emptied as well as dropped, because the pipeline installed on that session still holds the object.
 */
export function forgetHttpsExemptions(session: object): void {
  bySession.get(session)?.clear()
  bySession.delete(session)
}

/** What a redemption hands back: where to go, and whose set the exemption goes into. */
export interface ContinueGrant {
  readonly target: string
  readonly exemptions: HttpsExemptions
}

/**
 * The open tokens of the whole process, keyed by view.
 *
 * One ledger rather than one per session, because a view id is unique across sessions already and the grant
 * carries the session's set with it. `timingSafeEqual` throws on a length mismatch, so the lengths are
 * compared first — which says nothing an attacker could use, since every real token has the same length.
 */
export const continueTokens = new ContinueTokens<ContinueGrant>({
  mint: () => randomBytes(CONTINUE_TOKEN_BYTES).toString('base64url'),
  same: (a, b) => {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
  },
  now: () => Date.now()
})

/** What the tab does next. */
export type InterstitialStep = { kind: 'load'; url: string } | { kind: 'back' }

/** The part of a `WebContents` this reads: which view it is, and whether it has a page to go back to. */
export interface InterstitialView {
  readonly id: number
  readonly navigationHistory: { canGoBack(): boolean }
}

/**
 * The interstitial's "Continue" or "Go back", carried out for it — or `null` for any other navigation.
 *
 * Called by `Tab.ts` for a navigation the policy has already refused and stopped, which every navigation onto
 * an internal address from page content is. So `null` leaves the refusal standing, and a step is the core
 * starting a load of its own that page content could not.
 *
 * "Go back" with no history opens the start page, which only the core can: the page itself may not navigate
 * to a privileged address.
 */
export function followInterstitial(
  navigation: InterstitialNavigation,
  view: InterstitialView,
  tokens: ContinueTokens<ContinueGrant> = continueTokens
): InterstitialStep | null {
  const action = interstitialActionOf(navigation)
  if (action === null) return null
  if (action.kind === 'back') {
    return view.navigationHistory.canGoBack() ? { kind: 'back' } : { kind: 'load', url: HOME_URL }
  }
  const grant = tokens.redeem(view.id, action.token)
  if (grant === null) return null
  grant.exemptions.add(grant.target)
  return { kind: 'load', url: grant.target }
}
