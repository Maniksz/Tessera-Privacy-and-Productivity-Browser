import { INTERNAL_SCHEME, internalUrl } from '../product.js'

/**
 * The HTTPS-only interstitial's addresses, and the token that is the only way past it (KTD3, R8).
 *
 * ## Why a token at all
 *
 * `tessera://https-only` is served without privileges — it is not in `INTERNAL_PAGES`, because the
 * navigation policy refuses a redirect towards a privileged page and the pipeline's own redirect onto the
 * interstitial would then be refused too, switching HTTPS-only off without a word. So the page has no bridge
 * to ask the core with, and "continue unencrypted" has to be something the core recognises in a navigation.
 * Anything a navigation can carry, a hostile site can put in one as well: a `302` onto the route, an
 * `<img>`, an assignment to `location`. The token is what those do not have.
 *
 * ## The rules, and where each is enforced
 *
 * - **Issued by the core, when it redirects.** `RequestPipeline` issues one per view and puts only `t` in
 *   the address; the record — the full target, the view, ten minutes — stays in the core.
 * - **At most one per view.** A second redirect of the same view replaces the first record, so a page left
 *   open does not accumulate ways past the interstitial.
 * - **Redeemed only by the interstitial's own main-frame, non-redirect navigation** (`interstitialActionOf`),
 *   in the view the token was issued to.
 * - **Deleted before it is compared,** in constant time. A wrong guess spends the right token with it.
 * - **The route itself does nothing.** `protocol.ts` answers it with an empty response, because the scheme is
 *   `corsEnabled` and `supportFetchAPI` and any page can reach it; `protocol.handle` does not even know which
 *   view asked.
 *
 * Pure: randomness, the comparison and the clock are handed in (`TokenSource`), so every rule above is a
 * unit test away. The core's source is `node:crypto`, in `main/privacy/https-exemptions.ts`.
 */

export const HTTPS_ONLY_PAGE = 'https-only'

/** 256 bits. */
export const CONTINUE_TOKEN_BYTES = 32

export const CONTINUE_TOKEN_LIFETIME_MS = 10 * 60 * 1000

/** A token as the core mints it: 32 bytes, base64url, no padding. Anything else is not one. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/

const CONTINUE_PATH = '/continue'
const BACK_PATH = '/back'

/** Where "Go back" sends the interstitial. Only the core can open the start page for it. */
export const BACK_URL = `${INTERNAL_SCHEME}//${HTTPS_ONLY_PAGE}${BACK_PATH}`

/** Where "Continue unencrypted" sends the interstitial. */
export function continueUrl(token: string): string {
  return `${INTERNAL_SCHEME}//${HTTPS_ONLY_PAGE}${CONTINUE_PATH}?t=${encodeURIComponent(token)}`
}

/**
 * The interstitial for `target`, as the pipeline redirects to it.
 *
 * `lang` is the resolved interface language. The page cannot ask for it — it has no bridge — and
 * `navigator.language` on an unprivileged page is whatever the content preload's masking says it is.
 */
export function interstitialUrl(target: string, token: string | null, lang: string): string {
  return internalUrl(
    HTTPS_ONLY_PAGE,
    token === null ? { target, lang } : { target, t: token, lang }
  )
}

function interstitialAddressOf(url: string): URL | null {
  try {
    const parsed = new URL(url)
    const page = parsed.hostname.toLowerCase()
    return parsed.protocol === INTERNAL_SCHEME && page === HTTPS_ONLY_PAGE ? parsed : null
  } catch {
    return null
  }
}

/**
 * The interstitial document itself, as opposed to one of its two action routes.
 *
 * Both empty and `/` are the root: Chromium parses `tessera:` as the standard scheme `protocol.ts` registers,
 * Node — where the tests run — as an opaque one that keeps the path empty.
 */
function interstitialDocumentOf(url: string): URL | null {
  const parsed = interstitialAddressOf(url)
  return parsed !== null && (parsed.pathname === '/' || parsed.pathname === '') ? parsed : null
}

/**
 * The address the interstitial is about, or `null`.
 *
 * Only an `http:` address is a target. A `javascript:` target would run in the interstitial's origin the
 * moment "Try HTTPS" or anything else navigated to it, and an `https:` one has nothing to be warned about
 * — both are what a forged address would carry, and neither comes from the pipeline.
 */
export function interstitialTargetOf(url: string): string | null {
  const target = interstitialDocumentOf(url)?.searchParams.get('target') ?? null
  if (target === null) return null
  try {
    const parsed = new URL(target)
    return parsed.protocol === 'http:' ? parsed.toString() : null
  } catch {
    return null
  }
}

/** The token on the interstitial's address, or `null` when it carries none the core could have minted. */
export function interstitialTokenOf(url: string): string | null {
  const token = interstitialDocumentOf(url)?.searchParams.get('t') ?? null
  return token !== null && TOKEN_SHAPE.test(token) ? token : null
}

/** The interstitial's address without its token, for `history.replaceState`. */
export function withoutToken(url: string): string {
  const parsed = interstitialDocumentOf(url)
  if (parsed === null) return url
  parsed.searchParams.delete('t')
  return parsed.toString()
}

/** The same address over HTTPS: the scheme swapped, everything else — port included — kept. */
export function httpsVersionOf(target: string): string {
  return `https://${target.slice('http://'.length)}`
}

/** True for the two action routes, which the protocol handler answers with nothing at all. */
export function isInterstitialAction(url: string): boolean {
  const path = interstitialAddressOf(url)?.pathname
  return path === CONTINUE_PATH || path === BACK_PATH
}

/** The four facts of a navigation the redemption reads. `navigation-policy.ts` supplies them. */
export interface InterstitialNavigation {
  readonly url: string
  readonly source: 'frame' | 'redirect'
  readonly isMainFrame: boolean
  /** The address of the frame that started the navigation; `null` when no frame did or it is gone. */
  readonly initiatorUrl: string | null
}

export type InterstitialAction = { kind: 'continue'; token: string } | { kind: 'back' }

/**
 * What the interstitial asked the core to do, or `null` when this navigation is not the interstitial
 * asking.
 *
 * All three conditions, because each closes a different route:
 * - **not a redirect** — a hostile server answering "Try HTTPS" with `302` onto the route would otherwise
 *   arrive with the interstitial as its initiator;
 * - **the main frame** — a frame cannot speak for the tab it is in;
 * - **started by the interstitial document** — a site assigning to `location` is started by the site.
 *   `null` counts as "somebody else": this is a grant, and a grant fails towards refusing.
 */
export function interstitialActionOf(
  navigation: InterstitialNavigation
): InterstitialAction | null {
  if (navigation.source !== 'frame' || !navigation.isMainFrame) return null
  if (navigation.initiatorUrl === null) return null
  if (interstitialDocumentOf(navigation.initiatorUrl) === null) return null

  const target = interstitialAddressOf(navigation.url)
  if (target?.pathname === BACK_PATH) return { kind: 'back' }
  if (target?.pathname !== CONTINUE_PATH) return null
  const token = target.searchParams.get('t')
  return token === null ? null : { kind: 'continue', token }
}

/** Randomness, comparison and time, handed in so the ledger stays pure. */
export interface TokenSource {
  /** A fresh token of `CONTINUE_TOKEN_BYTES` random bytes. */
  mint(): string
  /** Constant-time equality. */
  same(a: string, b: string): boolean
  now(): number
}

interface OpenToken<Grant> {
  readonly token: string
  readonly grant: Grant
  readonly expiresAt: number
}

/**
 * The open tokens, at most one per view.
 *
 * `Grant` is what a redemption hands back: the full target, and in the core the exemption set of the session
 * the token was issued in — so the exemption lands in the session whose pipeline redirected, with no lookup
 * from a view back to its session that could pick the wrong one.
 */
export class ContinueTokens<Grant extends { readonly target: string }> {
  readonly #source: TokenSource
  readonly #open = new Map<number, OpenToken<Grant>>()

  constructor(source: TokenSource) {
    this.#source = source
  }

  /**
   * A token for this view, replacing any it already had.
   *
   * Expired records are swept here, so a view that was closed with a token open costs memory for ten
   * minutes at most — and a view id is never reused, so its record could not be redeemed by another.
   */
  issue(webContentsId: number, grant: Grant): string {
    const now = this.#source.now()
    for (const [id, open] of this.#open) {
      if (open.expiresAt <= now) this.#open.delete(id)
    }
    const token = this.#source.mint()
    this.#open.set(webContentsId, { token, grant, expiresAt: now + CONTINUE_TOKEN_LIFETIME_MS })
    return token
  }

  /** The grant, if `token` is this view's open, unexpired token. The record is gone either way. */
  redeem(webContentsId: number, token: string): Grant | null {
    const open = this.#open.get(webContentsId)
    if (open === undefined) return null
    this.#open.delete(webContentsId)
    if (open.expiresAt <= this.#source.now()) return null
    return this.#source.same(open.token, token) ? open.grant : null
  }
}
