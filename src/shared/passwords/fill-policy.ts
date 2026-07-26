import { registrableDomainOfUrl } from '../url/domain.js'

/**
 * When a saved password may be put into a page, and when it may not.
 *
 * This is the file that decides whether autofill is a convenience or a credential-leak
 * primitive, so it is pure, it takes no password, and every rule below is a unit test
 * named after the attack it prevents.
 *
 * ## Why it takes no password
 *
 * `decideFill` is given a `FillSubject` — an origin and nothing else. The secret is fetched
 * *after* this function has said yes, by the one caller that is allowed to fetch it. So
 * there is no version of this file that can log, echo or leak a password, and no future edit
 * can introduce one without changing the signature and being noticed.
 *
 * ## Why the same predicate builds the offer and authorises the fill
 *
 * `AutofillService` calls `decideFill` twice: once to decide which entries to *offer*, and
 * again when the user picks one. Two predicates would eventually disagree, and the direction
 * they disagree in is "the list offered something the rules would have refused" — which is
 * exactly the bug that makes an offer list a leak. One function, called twice, cannot drift.
 *
 * ## Why same registrable domain is not enough on its own
 *
 * It is the *first* check, not the whole of it. `registrableDomain` gets `bbc.co.uk` and
 * `evil.co.uk` right where "last two labels" would not, and it matches on whole labels so
 * `example.com.evil.com` is not `example.com`. But a page can be the right site and still be
 * the wrong place to hand a password to:
 *
 *   - it can be served over `http:`, so the value goes out in clear text;
 *   - it can be a frame inside somebody else's document, which is what a framed login page
 *     harvesting credentials looks like;
 *   - its form can post to a different origin than the page itself, which is what a script
 *     injected into a real login page looks like.
 *
 * Each of those shipped in a real browser. Each has a rule below.
 */

/**
 * The credential, reduced to the only field a decision needs.
 *
 * `PasswordSummary` satisfies it structurally, so the caller passes a summary straight in
 * and this module still cannot see a secret.
 */
export interface FillSubject {
  readonly origin: string
}

export interface FillContext {
  /** The core's own view of the frame that asked, never the renderer's claim about it. */
  readonly frameUrl: string
  /**
   * The top-level document's address, as the core reads it from the frame tree.
   *
   * `null` when it cannot be established — a frame torn down mid-request. Treated as a
   * refusal rather than as "same as the frame", because the whole point of this field is to
   * catch the case where the two differ.
   */
  readonly topLevelUrl: string | null
  /** True only for the top-level document. See `RULE cross-origin-frame`. */
  readonly isTopLevelFrame: boolean
  /**
   * The form's `action`, exactly as the attribute reads, or `null` when it has none.
   *
   * Not resolved by the caller: relative, protocol-relative and scheme-bearing actions all
   * behave differently, and resolving them is part of what this file is tested on.
   */
  readonly formAction: string | null
  /**
   * When the core last saw a real input event in this view, or `null` for never.
   *
   * From `webContents.on('input-event')`, which fires for input the browser process
   * dispatched and not for anything a page script synthesised. A renderer-supplied flag
   * would be worthless here, because a compromised renderer is one of the things this is
   * defending against.
   */
  readonly lastGestureAt: number | null
  readonly now: number
  /** Whether the form actually has a fillable password field. See `fields.ts`. */
  readonly hasFillablePasswordField: boolean
}

/**
 * Why a fill was refused. One value per attack, so a test can name the attack and a
 * diagnostic can say something true without naming the credential.
 */
export type FillRefusal =
  | 'no-user-gesture'
  | 'unsupported-scheme'
  | 'insecure-page'
  | 'scheme-downgrade'
  | 'different-site'
  | 'cross-origin-frame'
  | 'cross-origin-form-action'
  | 'no-password-field'

export type FillDecision = { readonly allowed: true } | { readonly allowed: false; readonly reason: FillRefusal }

const ALLOWED: FillDecision = { allowed: true }

function refuse(reason: FillRefusal): FillDecision {
  return { allowed: false, reason }
}

/**
 * How long after a real input event a fill still counts as user-initiated.
 *
 * Long enough that clicking our own suggestion is inside the window even on a slow machine,
 * short enough that a page cannot bank a gesture from a minute ago and spend it later on a
 * form the user never touched.
 */
export const FILL_GESTURE_WINDOW_MS = 5_000

/** `[::1]` is how `URL.hostname` reports the IPv6 loopback, brackets included. */
const NAMED_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '[::1]'])

/** The whole of 127.0.0.0/8, not only `127.0.0.1` — `127.0.0.2` is just as local. */
const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

function schemeAndHostOf(url: string): { scheme: string; host: string } | null {
  try {
    const parsed = new URL(url)
    return { scheme: parsed.protocol, host: parsed.hostname.toLowerCase() }
  } catch {
    return null
  }
}

/**
 * Whether this host is reachable only from the machine itself.
 *
 * `*.localhost` is included because RFC 6761 reserves the whole name for loopback, and
 * development setups use it for exactly that (`api.localhost`). A suffix match on `.localhost`
 * is safe in a way a suffix match on a real domain never is: the name cannot be registered.
 */
function isLoopbackHost(host: string): boolean {
  if (NAMED_LOOPBACK_HOSTS.has(host)) return true
  if (host.endsWith('.localhost')) return true
  return IPV4_LOOPBACK.test(host)
}

/**
 * Whether a page served over this scheme may receive a credential at all.
 *
 * `https:` yes. `http:` only on loopback, where there is no wire for anybody to listen on —
 * a development server, or a device's own configuration page reached through a tunnel.
 * Everything else — `file:`, `data:`, `blob:`, `about:`, this browser's own scheme — is
 * refused outright: none of them has an origin that means "this site", so a credential put
 * there is a credential handed to whoever supplied the document.
 */
function pageMayReceiveCredentials(scheme: string, host: string): boolean {
  if (scheme === 'https:') return true
  return scheme === 'http:' && isLoopbackHost(host)
}

/**
 * Whether a page on this origin could ever be filled, ignoring everything situational.
 *
 * The same predicate the fill path applies, exposed for the two callers that need to know
 * *before* there is a form: `save-policy.ts`, which refuses to collect a credential the
 * browser would never be willing to fill back, and the passwords page, which marks such an
 * entry so the user is not left wondering why autofill never appears there.
 *
 * A plain-`http:` intranet entry is still *storable*, deliberately: keeping a router's
 * password in the vault and reading it there is a legitimate use, and refusing to remember it
 * at all would push the user to a text file. It simply is not filled automatically.
 */
export function originMayReceiveCredentials(url: string): boolean {
  const parsed = schemeAndHostOf(url)
  if (parsed === null) return false
  return pageMayReceiveCredentials(parsed.scheme, parsed.host)
}

/**
 * Whether the *stored* scheme permits filling into the *page's* scheme.
 *
 * The one direction that is forbidden is a downgrade: a credential saved over `https:` is
 * never put into an `http:` page. That is the attack where a network attacker on a café
 * Wi-Fi answers `http://example.com/login` with their own page, the browser recognises the
 * site and fills, and the password leaves in clear text. It is refused even when the host
 * matches exactly, because a matching host is precisely what the attacker arranges.
 *
 * The other direction is fine: a credential remembered from an `http:` origin may be filled
 * on the `https:` version of the same site. That is an upgrade, and refusing it would punish
 * the user for the site having improved.
 */
function schemesAreCompatible(storedScheme: string, pageScheme: string): boolean {
  if (storedScheme === pageScheme) return true
  return storedScheme === 'http:' && pageScheme === 'https:'
}

/**
 * Whether `action` resolves somewhere other than the page's own site.
 *
 * Resolution is the interesting part, and it is why the raw attribute is passed in rather
 * than a URL the caller already built:
 *
 *   - `null`, `''` and `'#anchor'` all mean "post to this document" and are same-site;
 *   - `'/session'` is relative and resolves against the page, so same-site;
 *   - `'//evil.example/collect'` is *protocol-relative*. It looks relative and is not: it
 *     resolves to another host while keeping the page's scheme. Every hand-written check
 *     that tested for a leading `http` missed this one;
 *   - `'javascript:…'` and `'data:…'` have no host. They post nowhere by themselves — a
 *     script decides, and a script can reach any origin whatever the attribute says — so
 *     they are treated as same-document rather than as cross-origin.
 */
function formActionIsForeign(formAction: string | null, frameUrl: string): boolean {
  if (formAction === null || formAction.trim() === '') return false
  let resolved: URL
  try {
    resolved = new URL(formAction, frameUrl)
  } catch {
    // An action this browser cannot even parse is one the form cannot submit to either.
    return false
  }
  if (resolved.hostname === '') return false
  const target = registrableDomainOfUrl(resolved.toString())
  const page = registrableDomainOfUrl(frameUrl)
  return target === null || page === null || target !== page
}

/**
 * Whether a saved credential may be filled into this form, now.
 *
 * The order is deliberate: the cheapest and most universal refusals first, so a diagnostic
 * names the most general reason rather than an incidental one. Every branch returns; there
 * is no fall-through that could ever become an accidental yes.
 */
export function decideFill(context: FillContext, subject: FillSubject): FillDecision {
  /*
    RULE no-user-gesture — a hidden form must not be able to harvest a credential.

    Without this, a page appends an off-screen login form on load, the manager recognises the
    site and fills it, and one `submit()` later the password is on the attacker's server with
    the user having done nothing but visit. Filling on load is the convenience every browser
    started with and every browser has since walked back.

    The gesture is read from the core's own record of input events, not from anything the
    renderer says, so a compromised renderer cannot manufacture one.
  */
  if (context.lastGestureAt === null) return refuse('no-user-gesture')
  if (context.now - context.lastGestureAt > FILL_GESTURE_WINDOW_MS) return refuse('no-user-gesture')
  // A gesture timestamp in the future is a clock that moved — an NTP correction, a resumed
  // laptop — and not a gesture. Treating it as one would make the window unbounded.
  if (context.lastGestureAt > context.now) return refuse('no-user-gesture')

  /*
    RULE no-password-field — do not put a username into a search box.

    A form with no fillable password field is not a sign-in form, and offering one there
    means offering it on any page that happens to have a text input. It also covers the
    change-password case: `fields.ts` refuses a form whose only password field is marked
    `new-password`, so the existing password is never pre-filled into a "choose a new one"
    box where a stray submit would set it back.
  */
  if (!context.hasFillablePasswordField) return refuse('no-password-field')

  const page = schemeAndHostOf(context.frameUrl)
  if (page === null) return refuse('unsupported-scheme')

  /*
    RULE unsupported-scheme / insecure-page — no credential over a scheme that cannot carry
    one, and none over plain `http:` off loopback.

    `insecure-page` is separate from `unsupported-scheme` because the two are different
    conversations with the user: "this browser never fills here" versus "this page is not
    encrypted". Collapsing them would make the honest message impossible.
  */
  if (page.scheme !== 'https:' && page.scheme !== 'http:') return refuse('unsupported-scheme')
  if (!pageMayReceiveCredentials(page.scheme, page.host)) return refuse('insecure-page')

  const stored = schemeAndHostOf(subject.origin)
  if (stored === null) return refuse('unsupported-scheme')
  /*
    A *stored* origin this build would no longer accept: a hand-edited file, or a scheme list that
    has since been narrowed. `repairPasswords` deliberately keeps such an entry rather than deleting
    it — silently dropping credentials on a rule change is data loss disguised as a cleanup — so the
    refusal has to happen here, and it has to name the right reason. Without this branch the entry
    would be refused as a `scheme-downgrade`, which would send anyone diagnosing it looking for an
    http page that does not exist.
  */
  if (stored.scheme !== 'https:' && stored.scheme !== 'http:') return refuse('unsupported-scheme')

  /*
    RULE scheme-downgrade — a password saved over https never goes into an http page.

    Reached only for loopback `http:` pages, since the rule above has already refused every
    other one. It still has to exist: a credential saved on `https://localhost:8443` must not
    be filled into `http://localhost:8080`, which is a different application on the same
    machine as far as the browser is concerned.
  */
  if (!schemesAreCompatible(stored.scheme, page.scheme)) return refuse('scheme-downgrade')

  /*
    RULE different-site — the page must be the site the credential belongs to.

    On the registrable domain, so `accounts.example.com` gets `example.com`'s credential —
    which is what users mean by "the same site" and what the store's own key is derived from.
    On whole labels via `registrableDomain`, so `example.com.evil.com` does not match
    `example.com`, and with a public-suffix table so `evil.co.uk` does not match `bbc.co.uk`.

    A per-host rule instead would be tighter and wrong in practice: it breaks every site whose
    login lives on a subdomain, and the user's response to a manager that will not fill is to
    stop using it.
  */
  const pageSite = registrableDomainOfUrl(context.frameUrl)
  const storedSite = registrableDomainOfUrl(subject.origin)
  if (pageSite === null || storedSite === null || pageSite !== storedSite) {
    return refuse('different-site')
  }

  /*
    RULE cross-origin-frame — never fill a form that is not in the top-level document.

    `evil.example` frames the genuine `https://bank.example/login`, sizes it to a pixel or
    layers it under something clickable, and waits. The framed document *is* the bank, so
    every origin check above passes; the user is looking at the attacker's page. Firefox
    filled cross-origin frames for years and this is what came of it.

    Refusing every subframe rather than only cross-origin ones is deliberate, and it is the
    difference between a rule and a rule with an exception someone will widen. A same-site
    frame is the common legitimate case, and it loses nothing that matters: the user can still
    open the sign-in page directly, where the fill works.

    Belt and braces with the check below: `isTopLevelFrame` is what the frame tree says, and
    `topLevelUrl` is compared against the frame's address as a second, independent reading.
    In this browser tab views are created with `nodeIntegrationInSubFrames: false`, so a
    subframe has no preload and cannot ask in the first place — but a security property that
    rests on a `webPreferences` flag in a file three directories away is one flag away from
    being gone, and nothing would fail visibly when it went.
  */
  if (!context.isTopLevelFrame) return refuse('cross-origin-frame')
  if (context.topLevelUrl === null) return refuse('cross-origin-frame')
  const topSite = registrableDomainOfUrl(context.topLevelUrl)
  if (topSite === null || topSite !== pageSite) return refuse('cross-origin-frame')

  /*
    RULE cross-origin-form-action — the form must post to the site it is on.

    The page is genuinely `https://bank.example/login`; a stored cross-site scripting flaw, or
    a third-party script on the page, has replaced the form's action with
    `https://evil.example/collect`. Every check above passes — the site is right, the frame is
    top-level, the scheme is https — and the fill hands the credential to the attacker on
    submit. This is the rule browsers added after exactly that.

    What it cannot do, stated plainly: the check happens at fill time, so a script that
    rewrites the action *after* the fill still wins. Chromium has the same limit. What is
    bought is the static case, which is the one that gets injected and left there, and the
    gesture rule above means the attacker also needs the user to pick a suggestion.
  */
  if (formActionIsForeign(context.formAction, context.frameUrl)) {
    return refuse('cross-origin-form-action')
  }

  return ALLOWED
}

/**
 * The subjects that may be filled here, in the order they were given.
 *
 * The offer list is built from exactly this, so it can never be wider than what
 * `decideFill` would authorise a moment later.
 */
export function fillableSubjects<T extends FillSubject>(
  context: FillContext,
  subjects: readonly T[]
): T[] {
  return subjects.filter((subject) => decideFill(context, subject).allowed)
}
