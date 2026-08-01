import { registrableDomain } from '@shared/url/domain.js'

/**
 * Navigation and new tabs the *page* asked for rather than the person.
 *
 * ## What was reported, and what was there before
 *
 * Two requests, one mechanism: *"Ich möchte von webseiten getriggertes webseiten wechseln blocken.
 * Neue Seiten sollen nur vom echten user geöffnet werden können oder zumindest muss dieser das
 * bestätigen"* and *"Redirects sollen aus js geblockt werden oder nur vom user bestätigt werden, sonst
 * bleiben wir auf der seite."*
 *
 * Before this, both were unconditional. `setWindowOpenHandler` in `Tab.ts` turned **every**
 * `window.open` into a tab — a popup on a timer, a popup on page load, a popup from a handler attached
 * to the whole document — and `navigation-policy.ts` refused only navigations towards this browser's own
 * internal addresses, which is a privilege question rather than this one.
 *
 * ## Why a gesture is the test, and why the core is the only place that can apply it
 *
 * `passwords/gesture.ts` already worked this out for password filling, and the argument transfers whole:
 * a gesture reported *by the renderer* is worth nothing, because the renderer is what a hostile page
 * controls. `webContents.on('input-event')` fires for input the **browser process** dispatched into the
 * view, so a page calling `element.click()` or `dispatchEvent` never produces one. The core's own record
 * of the last real input event is therefore the only trustworthy answer to "did a person do this", and
 * it cannot be forged from inside a page.
 *
 * ## What this catches, and what it does not — stated because the difference matters
 *
 * It catches the **unprompted** ones: a popup on a timer, a redirect on load, a new tab from a script
 * that nobody touched. Those are the ones that arrive while the user is reading and are the reason the
 * feature was asked for.
 *
 * It does **not** catch the click-jacked kind, and no gesture test can: the classic advertising redirect
 * hangs a handler on the whole document, so there genuinely *was* a click and this will allow it. What
 * answers that is the scriptlet library — `addEventListener-defuser` is in it precisely for this, and it
 * is what uBlock Origin uses for the same pattern. The two features are complements, and claiming this
 * one covers both would be the kind of promise that gets a switch turned off.
 *
 * ## Why navigation is scoped to cross-site and popups are not
 *
 * A popup is gated on the gesture alone, because that is what every browser's own popup blocker does and
 * because a same-site popup nobody asked for is still a popup nobody asked for.
 *
 * Navigation is different: `will-frame-navigate` fires for a page moving *itself*, and a site sending
 * `/` to `/home`, or replacing the URL after an asynchronous auth check, is ordinary and constant. Gating
 * that would produce a prompt on sites that are behaving perfectly and teach the user to click through
 * without reading — which costs more than it protects. The redirects worth asking about leave the site,
 * so `isSameSite` is the line. Same registrable domain: `docs.example.com` to `shop.example.com` is not a
 * redirect anybody needs warning about.
 *
 * ## Why the main frame only
 *
 * `will-frame-navigate` fires for every subframe as well, and a cross-site iframe navigating itself is
 * what an embed *is* — a video player, a map, a comment widget. Gating those would prompt several times
 * per page on a great many sites for something that cannot take the user anywhere: a subframe navigation
 * does not move the tab. The caller filters on this rather than passing it in, because there is no reading
 * of a subframe navigation that this decision would answer differently.
 */

/** What the page tried to do. The two are judged differently; see the docblock. */
export type AutomaticNavigationKind = 'popup' | 'navigation'

/** What the user asked for, per kind. `ask` is the default for both. */
export type NavigationGate = 'allow' | 'ask' | 'block'

/**
 * How long after a real input event an action still counts as the user's.
 *
 * One second, which is what Chromium's own popup blocker uses for the same question. Long enough that a
 * click handler doing a little work before opening its window is still the user's action, short enough
 * that a click cannot be banked and spent minutes later on a popup the user has forgotten about.
 *
 * The failure directions are not equal, which is what picks the value rather than taste: too long lets an
 * unprompted popup through, and too short prompts for something the user did ask for. The second is
 * worse, because it is the one that happens on well-behaved sites and trains people to click Allow.
 */
export const GESTURE_WINDOW_MS = 1_000

export interface AutomaticNavigationRequest {
  kind: AutomaticNavigationKind
  /** Where the page wants to go. */
  url: string
  /** The document making the request, for the same-site test. */
  documentUrl: string
  /**
   * Milliseconds since the last real input event in this view, or `null` when there has been none.
   *
   * `null` rather than `Infinity` because "this view has never been touched" is a different fact from "it
   * was touched a long time ago", and a page that opens a popup before the user has interacted with it at
   * all is the clearest case this exists for.
   */
  sinceGestureMs: number | null
  gate: NavigationGate
}

export interface AutomaticNavigationDecision {
  action: 'allow' | 'ask' | 'block'
  /** For the log, and for the tests. Never shown to a page. */
  reason: string
  /**
   * Whether a real input event is what permitted this, and is therefore now spent.
   *
   * ## What was reported
   *
   * *"Wenn die webseite weiterleiten will, dann kommt die anzeige zwar, dass ich sagen kann, nicht
   * redirecten, aber es wird teilweise dennoch ein neuer tab geöffnet."* The dialogue appears for the
   * redirect, and a tab the user never asked for is already open beside it.
   *
   * ## Why one click could do both
   *
   * The gesture was a *timestamp that was only ever read*. One click therefore vouched for everything a
   * page did in the second that followed — a popup, and another popup, and a redirect — because each
   * question was asked of the same unspent click. So the pattern this feature exists for got its tab
   * through on the gesture while the slower half of the same script arrived after the second was up and
   * was, correctly, put to the user. From the outside that reads exactly as reported: asked about one,
   * not asked about the other.
   *
   * ## The rule, and why it is the browsers' own
   *
   * **A gesture authorises one thing.** This is Chromium's transient user activation, which `window.open`
   * consumes for precisely this reason, and it is the difference between "the user clicked" and "the user
   * asked for this". Nothing legitimate is lost: a click that opens a tab still opens it, and a click that
   * follows a link still follows it. What stops is one click standing in for a page's second, third and
   * fourth idea.
   *
   * Reported rather than decided by the caller, because only this function knows *which* of the four rules
   * let the request through — the gate allowing it outright, or same-site, spend nothing.
   */
  spendsGesture: boolean
}

/** Whether a real input event is recent enough for this to be the user's own action. */
export function withinGestureWindow(sinceGestureMs: number | null): boolean {
  if (sinceGestureMs === null) return false
  // A negative value means the clocks disagree, which is not evidence of a gesture.
  return sinceGestureMs >= 0 && sinceGestureMs <= GESTURE_WINDOW_MS
}

/**
 * Whether the page may do this, must ask, or may not.
 *
 * Reads as four rules because the argument is in the docblock above. The order of the first two is the
 * part worth noticing: **the gesture is checked before the gate**, so `block` never blocks something the
 * user just clicked. A setting called "block popups" that swallowed the window a person opened
 * deliberately would be reported as a bug, and rightly.
 */
export function decideAutomaticNavigation(
  request: AutomaticNavigationRequest
): AutomaticNavigationDecision {
  if (request.gate === 'allow') {
    return { action: 'allow', reason: 'the setting allows it', spendsGesture: false }
  }

  if (withinGestureWindow(request.sinceGestureMs)) {
    return {
      action: 'allow',
      reason: `a real input event ${request.sinceGestureMs}ms ago`,
      spendsGesture: true
    }
  }

  /*
    Same-site navigation is the page moving itself, which is ordinary. Not applied to a popup: a
    same-site window nobody asked for is still a window nobody asked for, and that is also what every
    browser's own popup blocker does.
  */
  if (request.kind === 'navigation' && sameSiteNavigation(request.documentUrl, request.url)) {
    return {
      action: 'allow',
      reason: 'the page is navigating within its own site',
      spendsGesture: false
    }
  }

  if (request.gate === 'block') {
    return {
      action: 'block',
      reason: `no user gesture, and the setting blocks ${request.kind}`,
      spendsGesture: false
    }
  }
  return {
    action: 'ask',
    reason: `no user gesture; asking about ${request.kind}`,
    spendsGesture: false
  }
}

/**
 * Whether both addresses belong to one site, by registrable domain.
 *
 * `false` for anything unparseable, and for a target that is not `http(s)` — a `javascript:` or `data:`
 * URL has no site to be the same as, and treating "I could not tell" as "same site" would turn every
 * unreadable address into an allowance.
 */
function sameSiteNavigation(documentUrl: string, url: string): boolean {
  let from: URL
  let to: URL
  try {
    from = new URL(documentUrl)
    to = new URL(url)
  } catch {
    return false
  }
  if (to.protocol !== 'http:' && to.protocol !== 'https:') return false
  if (from.protocol !== 'http:' && from.protocol !== 'https:') return false
  /*
    `registrableDomain` on the two hostnames, and *not* `isSameSite`.

    `isSameSite` takes two **URLs** and parses them itself; handing it the hostnames made every comparison
    false — `new URL('shop.example')` throws, so the answer was `null` and every same-site navigation was
    treated as leaving the site. Which is to say the narrowing this function exists for did nothing, and
    the setting would have prompted on every internal redirect on every site. Caught by the test that says
    a subdomain counts as the same site.
  */
  if (from.hostname === '' || to.hostname === '') return false
  return registrableDomain(from.hostname) === registrableDomain(to.hostname)
}
