import { describe, expect, it } from 'vitest'
import {
  followInterstitial,
  forgetHttpsExemptions,
  hostKeyOf,
  httpsExemptionsFor,
  HttpsExemptions,
  type ContinueGrant
} from '@main/privacy/https-exemptions.js'
import {
  evaluateStages,
  type HttpsOnlyWiring,
  type RequestContext
} from '@main/privacy/RequestPipeline.js'
import { decideTabNavigation, type NavigationSource } from '@main/browser/navigation-policy.js'
import {
  BACK_URL,
  ContinueTokens,
  continueUrl,
  interstitialTokenOf,
  type TokenSource
} from '@shared/privacy/https-token.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import { defaultSettings } from '@shared/settings/definitions.js'

/**
 * "Continue unencrypted", end to end on the core's side (KTD3, R8).
 *
 * The interstitial is served without privileges, so the one thing it can make the core do — exempt a host
 * from HTTPS-only — is decided here and nowhere else: a token the pipeline issues when it redirects, and a
 * redemption that only a main-frame, non-redirect navigation started *by the interstitial itself* reaches.
 * `Tab.ts` only hands its `will-frame-navigate` payload over; everything that decides is in these modules.
 */

const INTERSTITIAL = 'tessera://https-only/?target=http%3A%2F%2Fbank.example%2F&lang=en'

/** Tokens that can be told apart, and a clock the test moves. */
function fakeSource(): TokenSource & { at: number } {
  let issued = 0
  const source = {
    at: 1_000,
    mint: () => {
      issued += 1
      return `token-${issued}`.padEnd(43, 'x')
    },
    same: (a: string, b: string) => a === b,
    now: () => source.at
  }
  return source
}

function world(): {
  session: object
  tokens: ContinueTokens<ContinueGrant>
  clock: { at: number }
  wiring: HttpsOnlyWiring
} {
  const session = {}
  const clock = fakeSource()
  const tokens = new ContinueTokens<ContinueGrant>(clock)
  return {
    session,
    tokens,
    clock,
    wiring: { exemptions: httpsExemptionsFor(session), tokens, uiLocale: () => 'en' }
  }
}

function request(
  url: string,
  overrides: Partial<RequestContext> = {},
  wiring?: HttpsOnlyWiring
): ReturnType<typeof evaluateStages> {
  const context: RequestContext = {
    url,
    resourceType: 'mainFrame',
    documentUrl: null,
    method: 'GET',
    settings: defaultSettings(),
    webContentsId: 7,
    ...overrides
  }
  return evaluateStages(context, null, wiring)
}

/** Sends view 7 to the interstitial for `url`, and returns the token the redirect carried. */
function redirectToInterstitial(url: string, wiring: HttpsOnlyWiring, webContentsId = 7): string {
  const outcome = request(url, { webContentsId }, wiring)
  if (outcome.action !== 'redirect') throw new Error(`${url} was not redirected`)
  const token = interstitialTokenOf(outcome.url)
  if (token === null) throw new Error(`${outcome.url} carries no token`)
  return token
}

function navigation(
  url: string,
  source: NavigationSource = 'frame',
  initiatorUrl: string | null = INTERSTITIAL,
  isMainFrame = true
): { url: string; source: NavigationSource; isMainFrame: boolean; initiatorUrl: string | null } {
  return { url, source, isMainFrame, initiatorUrl }
}

function view(
  id = 7,
  canGoBack = true
): {
  id: number
  navigationHistory: { canGoBack(): boolean }
} {
  return { id, navigationHistory: { canGoBack: () => canGoBack } }
}

const exemptMainFrame = (exemptions: HttpsExemptions, url: string): boolean =>
  exemptions.exempts({ url, resourceType: 'mainFrame', documentUrl: null })

describe('a foreign redirect onto the continue route (AE1)', () => {
  it('redeems nothing and exempts nothing, with or without a token', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)

    for (const url of [continueUrl(token), 'tessera://https-only/continue']) {
      // evil.example answers with `302 Location: <url>`, which reaches the tab as a redirect.
      const foreign = navigation(url, 'redirect', 'https://evil.example/')
      // The redirect itself is let through — the route is unprivileged and serves nothing …
      expect(decideTabNavigation(foreign).allowed, url).toBe(true)
      // … and it is not a redemption.
      expect(followInterstitial(foreign, view(), tokens), url).toBeNull()
    }

    expect(exemptMainFrame(wiring.exemptions, 'http://bank.example/')).toBe(false)
    expect(request('http://bank.example/', {}, wiring).action).toBe('redirect')
  })

  it('does not redeem a redirect even when the interstitial started the navigation', () => {
    /*
      "Try HTTPS" navigates to `https://bank.example/`; a hostile server there can answer with a `302` onto
      the continue route. The navigation's initiator is then the interstitial — so the initiator alone is
      not enough, and the redirect is refused on being a redirect.
    */
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)
    expect(
      followInterstitial(navigation(continueUrl(token), 'redirect'), view(), tokens)
    ).toBeNull()

    // The token survived the attempt, so the user's own click still works.
    expect(followInterstitial(navigation(continueUrl(token)), view(), tokens)).toEqual({
      kind: 'load',
      url: 'http://bank.example/'
    })
  })

  it('does not redeem a navigation some other page started', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)
    for (const initiator of ['https://evil.example/', 'tessera://about/', null]) {
      expect(
        followInterstitial(navigation(continueUrl(token), 'frame', initiator), view(), tokens),
        String(initiator)
      ).toBeNull()
    }
    expect(exemptMainFrame(wiring.exemptions, 'http://bank.example/')).toBe(false)
  })

  it('does not redeem from a subframe', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)
    const framed = navigation(continueUrl(token), 'frame', INTERSTITIAL, false)
    expect(followInterstitial(framed, view(), tokens)).toBeNull()
  })

  it('is untouched by an image pointed at the route', () => {
    /*
      `<img src="tessera://https-only/continue?t=…">` is a subresource request, which never reaches
      `will-frame-navigate` and so never reaches `followInterstitial`. What it does reach is the pipeline and
      the protocol handler — the first lets a `tessera:` address through untouched, the second answers the
      route with an empty response. So nothing is redeemed and nothing exempted.
    */
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)
    expect(request(continueUrl(token), { resourceType: 'image' }, wiring)).toEqual({
      action: 'continue'
    })
    expect(exemptMainFrame(wiring.exemptions, 'http://bank.example/')).toBe(false)
    expect(followInterstitial(navigation(continueUrl(token)), view(), tokens)?.kind).toBe('load')
  })
})

describe('redeeming a token', () => {
  it('loads the target the core stored, and exempts its host', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://printer.lan/status?x=1', wiring)
    expect(followInterstitial(navigation(continueUrl(token)), view(), tokens)).toEqual({
      kind: 'load',
      url: 'http://printer.lan/status?x=1'
    })
    expect(exemptMainFrame(wiring.exemptions, 'http://printer.lan/other')).toBe(true)
  })

  it('refuses the token of another view', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring, 8)
    expect(followInterstitial(navigation(continueUrl(token)), view(7), tokens)).toBeNull()
    expect(exemptMainFrame(wiring.exemptions, 'http://bank.example/')).toBe(false)
  })

  it('refuses a token older than ten minutes', () => {
    const { tokens, wiring, clock } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)
    clock.at += 10 * 60 * 1000
    expect(followInterstitial(navigation(continueUrl(token)), view(), tokens)).toBeNull()
  })

  it('refuses a token that was already redeemed', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)
    expect(followInterstitial(navigation(continueUrl(token)), view(), tokens)).not.toBeNull()
    expect(followInterstitial(navigation(continueUrl(token)), view(), tokens)).toBeNull()
  })

  it('lets a second redirect of the same view invalidate the first token', () => {
    const { tokens, wiring } = world()
    const first = redirectToInterstitial('http://bank.example/', wiring)
    const second = redirectToInterstitial('http://other.example/', wiring)
    expect(followInterstitial(navigation(continueUrl(first)), view(), tokens)).toBeNull()
    // Refused *and* spent: the entry is deleted before it is compared, so a wrong guess costs the right one.
    expect(followInterstitial(navigation(continueUrl(second)), view(), tokens)).toBeNull()
  })

  it('refuses a forged token and spends the real one with it', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://bank.example/', wiring)
    expect(followInterstitial(navigation(continueUrl('forged')), view(), tokens)).toBeNull()
    expect(followInterstitial(navigation(continueUrl(token)), view(), tokens)).toBeNull()
  })

  it('refuses the continue route with no token on it', () => {
    const { tokens } = world()
    const bare = navigation('tessera://https-only/continue')
    expect(followInterstitial(bare, view(), tokens)).toBeNull()
  })

  it('leaves every other refused navigation to the refusal', () => {
    const { tokens } = world()
    for (const url of ['tessera://settings/', 'tessera://https-only/', 'tessera://https-only/x']) {
      expect(followInterstitial(navigation(url), view(), tokens), url).toBeNull()
    }
  })
})

describe('"Go back" on the interstitial', () => {
  it('goes back when there is somewhere to go', () => {
    expect(followInterstitial(navigation(BACK_URL), view(7, true))).toEqual({ kind: 'back' })
  })

  it('opens the start page when there is no history', () => {
    expect(followInterstitial(navigation(BACK_URL), view(7, false))).toEqual({
      kind: 'load',
      url: HOME_URL
    })
  })

  it('is the interstitial’s alone to ask for', () => {
    expect(followInterstitial(navigation(BACK_URL, 'frame', 'https://evil.example/'), view())).toBe(
      null
    )
    expect(followInterstitial(navigation(BACK_URL, 'redirect'), view())).toBeNull()
  })
})

describe('an exemption', () => {
  function exempted(url = 'http://host.example/'): HttpsExemptions {
    const exemptions = new HttpsExemptions()
    expect(exemptions.add(url)).toBe(true)
    return exemptions
  }

  it('lets the exempted page load over http, and its own images too', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://host.example/pfad', wiring)
    followInterstitial(navigation(continueUrl(token)), view(), tokens)

    expect(request('http://host.example/pfad', {}, wiring)).toEqual({ action: 'continue' })
    const image = request(
      'http://host.example/logo.png',
      { resourceType: 'image', documentUrl: 'http://host.example/pfad' },
      wiring
    )
    expect(image).toEqual({ action: 'continue' })
  })

  it('still upgrades another host’s image or frame on the exempted page', () => {
    const { tokens, wiring } = world()
    const token = redirectToInterstitial('http://host.example/pfad', wiring)
    followInterstitial(navigation(continueUrl(token)), view(), tokens)

    for (const resourceType of ['image', 'subFrame', 'script']) {
      expect(
        request(
          'http://other.example/thing',
          { resourceType, documentUrl: 'http://host.example/pfad' },
          wiring
        ),
        resourceType
      ).toEqual({ action: 'redirect', url: 'https://other.example/thing', reason: 'https-upgrade' })
    }
  })

  it('does not cover the exempted host’s image on somebody else’s page', () => {
    const exemptions = exempted()
    const query = { url: 'http://host.example/pixel.gif', resourceType: 'image' }
    expect(exemptions.exempts({ ...query, documentUrl: 'http://tracker.example/' })).toBe(false)
    expect(exemptions.exempts({ ...query, documentUrl: null })).toBe(false)
    expect(exemptions.exempts({ ...query, documentUrl: 'http://host.example/a' })).toBe(true)
  })

  it('keys the host case-, dot- and IDN-insensitively, and counts the port', () => {
    expect(hostKeyOf('http://HOST.example./a')).toBe('host.example')
    expect(hostKeyOf('http://host.example/b')).toBe('host.example')
    expect(hostKeyOf('http://host.example:80/')).toBe('host.example')
    expect(hostKeyOf('http://host.example:8080/')).toBe('host.example:8080')
    expect(hostKeyOf('http://bücher.example/')).toBe('xn--bcher-kva.example')
    expect(hostKeyOf('https://host.example/')).toBeNull()
    expect(hostKeyOf('not a url')).toBeNull()

    const exemptions = exempted('http://HOST.example./')
    expect(exemptMainFrame(exemptions, 'http://host.example/x')).toBe(true)
    expect(exemptMainFrame(exemptions, 'http://host.example:8080/x')).toBe(false)
  })

  it('exempts nothing that has no http host', () => {
    const exemptions = new HttpsExemptions()
    expect(exemptions.add('https://host.example/')).toBe(false)
    expect(exemptMainFrame(exemptions, 'https://host.example/')).toBe(false)
  })

  it('lives in memory until it is cleared', () => {
    const exemptions = exempted()
    exemptions.clear()
    expect(exemptMainFrame(exemptions, 'http://host.example/')).toBe(false)
  })
})

describe('exemptions per session (AE2)', () => {
  it('keeps a private window’s exemption out of the normal window', () => {
    const normal = {}
    const privateSession = {}
    const tokens = new ContinueTokens<ContinueGrant>(fakeSource())
    const wiringFor = (session: object): HttpsOnlyWiring => ({
      exemptions: httpsExemptionsFor(session),
      tokens,
      uiLocale: () => 'de'
    })

    // Continued in the private window, in its view 9.
    const token = redirectToInterstitial('http://printer.lan/', wiringFor(privateSession), 9)
    expect(followInterstitial(navigation(continueUrl(token)), view(9), tokens)?.kind).toBe('load')
    expect(request('http://printer.lan/', { webContentsId: 9 }, wiringFor(privateSession))).toEqual(
      { action: 'continue' }
    )

    // The normal window's view 7 gets the interstitial again.
    expect(request('http://printer.lan/', {}, wiringFor(normal)).action).toBe('redirect')
  })

  it('hands one session the same set every time, and a new one once it is forgotten', () => {
    const session = {}
    const first = httpsExemptionsFor(session)
    expect(httpsExemptionsFor(session)).toBe(first)
    first.add('http://printer.lan/')

    forgetHttpsExemptions(session)
    expect(exemptMainFrame(first, 'http://printer.lan/'), 'the old set was not emptied').toBe(false)
    expect(httpsExemptionsFor(session)).not.toBe(first)
    // Forgetting a session that never had one is harmless.
    forgetHttpsExemptions({})
  })
})

describe('the process-wide ledger', () => {
  it('issues 256-bit tokens that differ, and compares them in constant time', async () => {
    const { continueTokens } = await import('@main/privacy/https-exemptions.js')
    const exemptions = new HttpsExemptions()
    const a = continueTokens.issue(101, { target: 'http://a.example/', exemptions })
    const b = continueTokens.issue(102, { target: 'http://b.example/', exemptions })
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(b).not.toBe(a)
    expect(continueTokens.redeem(101, b)).toBeNull()
    expect(continueTokens.redeem(102, `${b}x`)).toBeNull()
    const c = continueTokens.issue(103, { target: 'http://c.example/', exemptions })
    expect(continueTokens.redeem(103, c)?.target).toBe('http://c.example/')
  })
})
