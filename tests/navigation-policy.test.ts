import { describe, expect, it } from 'vitest'
import {
  decideChromeNavigation,
  decideTabNavigation,
  pendingNavigationOf,
  type NavigationSource
} from '@main/browser/navigation-policy.js'
import { INTERNAL_PAGES } from '@shared/ipc/channels.js'
import { internalUrl } from '@shared/product.js'

/**
 * The lock on navigation to internal addresses.
 *
 * Covered case by case rather than representatively, for the reason `privacy-policy.test.ts` gives
 * about the sender policy: a mistake here is a security hole, not a bug. The subscriptions that feed
 * this live in `Tab.ts`, which no unit test can construct — `tests/architecture.test.ts` asserts they
 * are still wired to these functions.
 */

function attempt(
  url: string,
  source: NavigationSource = 'frame',
  isMainFrame = true
): { url: string; source: NavigationSource; isMainFrame: boolean } {
  return { url, source, isMainFrame }
}

describe('decideTabNavigation', () => {
  it('allows everything that is not an internal address', () => {
    const ordinary = [
      'https://example.com/',
      'http://example.com/path?q=1',
      'file:///tmp/page.html',
      'about:blank',
      'data:text/html,hi',
      // Not parseable as a URL at all: total, and an address nothing can serve is nothing to refuse.
      'not a url'
    ]
    for (const url of ordinary) {
      for (const source of ['frame', 'redirect'] as const) {
        const decision = decideTabNavigation(attempt(url, source))
        expect(decision.allowed, `${source}: ${url}`).toBe(true)
        expect(decision.reason, `${source}: ${url}`).toBeNull()
      }
    }
  })

  it('refuses page content every internal page, privileged or not', () => {
    // The whole table, so a page added later is refused by default rather than by somebody
    // remembering to add it here.
    for (const page of INTERNAL_PAGES) {
      const decision = decideTabNavigation(attempt(internalUrl(page)))
      expect(decision.allowed, page).toBe(false)
      expect(decision.reason, page).toContain('may not navigate to an internal address')
    }
    // And the two that are served without privileges. A site framing the HTTPS-only interstitial with
    // a target of its own choosing is a phishing surface, whatever it can or cannot call.
    for (const page of ['https-only', 'about']) {
      expect(decideTabNavigation(attempt(internalUrl(page))).allowed, page).toBe(false)
    }
  })

  it('refuses the forms a prefix check would miss', () => {
    const disguised = [
      // Upper case: `URL.protocol` lower-cases, a `startsWith` would not.
      'TESSERA://settings',
      // Userinfo, which makes the authority read as a host to the naked eye.
      'tessera://x@evil.example',
      // No slashes at all.
      'tessera:settings'
    ]
    for (const url of disguised) {
      expect(decideTabNavigation(attempt(url)).allowed, url).toBe(false)
    }
  })

  it('is not fooled by an internal address that only appears inside another one', () => {
    // The mirror of the case above: refusing this would break an ordinary link.
    const innocent = 'https://evil.example/#tessera://settings'
    expect(decideTabNavigation(attempt(innocent)).allowed, innocent).toBe(true)
  })

  it('names the frame in the refusal, because a subframe is a different event', () => {
    const url = internalUrl('settings')
    expect(decideTabNavigation(attempt(url, 'frame', true)).reason).toContain('the main frame')

    const subframe = decideTabNavigation(attempt(url, 'frame', false))
    expect(subframe.allowed, 'a subframe reaches an internal page').toBe(false)
    expect(subframe.reason).toContain('a subframe')
  })

  it('lets a redirect reach an internal page that carries no privileges', () => {
    /*
      HTTPS-only mode depends on this. `RequestPipeline` rewrites a top-level `http://` request to the
      interstitial, and that arrives as a redirect — indistinguishable from a remote server's. Refusing
      it would leave the setting switched on and the interstitial never shown.
    */
    const interstitial = internalUrl('https-only', { target: 'http://example.com/' })
    const decision = decideTabNavigation(attempt(interstitial, 'redirect'))
    expect(decision.allowed, interstitial).toBe(true)
    expect(decision.reason).toBeNull()

    expect(decideTabNavigation(attempt(internalUrl('about'), 'redirect')).allowed).toBe(true)
  })

  it('refuses a redirect towards every page that does carry privileges', () => {
    // A remote server answering `Location:` with one of these is the same escalation by another route.
    for (const page of INTERNAL_PAGES) {
      const decision = decideTabNavigation(attempt(internalUrl(page), 'redirect'))
      expect(decision.allowed, page).toBe(false)
      expect(decision.reason, page).toContain(`may not reach the ${page} page`)
    }
  })

  it('treats the bare internal address as the start page on both events', () => {
    // `internalPageOf` reads an empty host as `start`, which is what the protocol handler serves. The
    // two have to agree or a redirect there would be allowed while the page it loads is privileged.
    const bare = 'tessera://'
    expect(decideTabNavigation(attempt(bare, 'redirect')).allowed, bare).toBe(false)
    expect(decideTabNavigation(attempt(bare, 'frame')).allowed, bare).toBe(false)
  })

  it('refuses a redirect to an internal address no page answers to', () => {
    // `favicon` serves bytes and has no renderer, so it is on no privilege list and costs nothing.
    expect(decideTabNavigation(attempt(internalUrl('favicon'), 'redirect')).allowed).toBe(true)
    // But page content still may not navigate a document there.
    expect(decideTabNavigation(attempt(internalUrl('favicon'), 'frame')).allowed).toBe(false)
  })
})

describe('decideChromeNavigation', () => {
  /*
    The chrome window and the overlay layer are moved only by the core, with `loadURL` and `loadFile`,
    and neither fires `will-frame-navigate`. Anything that does arrive here is the page moving itself —
    a dropped link, a stray `location` assignment, script that should not be running there — and the
    surface that holds every IPC channel must not follow it anywhere.
  */
  const BUNDLE = 'file:///app/out/renderer/index.html'
  const DEV = 'http://localhost:5173'

  it('refuses every navigation in a packaged build, wherever it goes', () => {
    for (const url of [
      'https://example.com/',
      'http://localhost:5173/',
      'tessera://settings',
      'file:///Users/me/Downloads/page.html',
      'data:text/html,<p>x</p>',
      'javascript:alert(1)'
    ]) {
      expect(decideChromeNavigation(attempt(url), null).allowed, url).toBe(false)
    }
  })

  it('refuses even its own document, because the core never navigates there this way', () => {
    // A reload the core wants is `webContents.reload`, which does not come through here either.
    expect(decideChromeNavigation(attempt(BUNDLE), null).allowed).toBe(false)
    expect(
      decideChromeNavigation(attempt('file:///app/out/renderer/overlay.html'), null).allowed
    ).toBe(false)
  })

  it('names the frame and the target in the refusal', () => {
    expect(decideChromeNavigation(attempt('https://a.test/'), null).reason).toBe(
      'the chrome UI may not navigate its main frame (https://a.test/)'
    )
    expect(decideChromeNavigation(attempt('https://a.test/', 'frame', false), null).reason).toBe(
      'the chrome UI may not navigate a subframe (https://a.test/)'
    )
  })

  it('lets the dev server reload its own page in development', () => {
    /*
      The one navigation of its own the chrome UI makes: Vite answers an edit it cannot hot-swap with
      `location.reload()`, which is renderer-initiated and so arrives here. Refused, `pnpm dev` would
      stop picking up changes. Only the main frame, only to the server the UI came from.
    */
    expect(decideChromeNavigation(attempt(`${DEV}/`), DEV)).toEqual({ allowed: true, reason: null })
    expect(decideChromeNavigation(attempt(`${DEV}/overlay.html`), DEV).allowed).toBe(true)
  })

  it('refuses everything else in development', () => {
    expect(decideChromeNavigation(attempt(`${DEV}/`, 'frame', false), DEV).allowed).toBe(false)
    expect(decideChromeNavigation(attempt('http://localhost:5174/'), DEV).allowed).toBe(false)
    expect(decideChromeNavigation(attempt('https://example.com/'), DEV).allowed).toBe(false)
    expect(decideChromeNavigation(attempt(BUNDLE), DEV).allowed).toBe(false)
    expect(decideChromeNavigation(attempt('not a url'), DEV).allowed).toBe(false)
  })
})

describe('pendingNavigationOf', () => {
  it('reads the three fields the decision needs', () => {
    let prevented = 0
    const details = {
      url: 'https://example.com/',
      isMainFrame: true,
      preventDefault: () => {
        prevented += 1
      }
    }

    const pending = pendingNavigationOf(details, 'frame')
    expect(pending).not.toBeNull()
    expect(pending?.url).toBe('https://example.com/')
    expect(pending?.source).toBe('frame')
    expect(pending?.isMainFrame).toBe(true)

    pending?.prevent()
    expect(prevented, 'the veto did not reach Electron').toBe(1)
  })

  it('calls preventDefault on its own event, not detached from it', () => {
    /*
      Electron's `preventDefault` sets `defaultPrevented` on the event object. A detached reference
      would set it on nothing, the navigation would proceed, and the log would say it had been stopped —
      a refusal that reports success is worse than no refusal.
    */
    const details = {
      url: 'https://example.com/',
      stopped: false,
      preventDefault(this: { stopped: boolean }) {
        this.stopped = true
      }
    }

    pendingNavigationOf(details, 'frame')?.prevent()
    expect(details.stopped).toBe(true)
  })

  it('reads a missing isMainFrame as a subframe rather than refusing the payload', () => {
    // Refusing the whole attempt over an absent flag would let the navigation through, which is the
    // one outcome this file exists to avoid.
    const pending = pendingNavigationOf({ url: 'https://example.com/' }, 'redirect')
    expect(pending?.isMainFrame).toBe(false)
    expect(pending?.source).toBe('redirect')
  })

  it('yields a veto that does nothing for a payload with no preventDefault', () => {
    // An event shape this build does not recognise. Building the attempt anyway means the refusal is
    // still logged; refusing to build it would lose that too.
    const pending = pendingNavigationOf({ url: 'https://example.com/' }, 'frame')
    expect(() => pending?.prevent()).not.toThrow()
  })

  it('answers null for anything that is not a navigation payload', () => {
    const notPayloads: unknown[] = [
      null,
      undefined,
      'https://example.com/',
      42,
      // An object, but with no address to judge.
      {},
      { url: 123 },
      { isMainFrame: true }
    ]
    for (const details of notPayloads) {
      expect(pendingNavigationOf(details, 'frame'), String(details)).toBeNull()
    }
  })
})
