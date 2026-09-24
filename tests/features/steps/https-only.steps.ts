import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { evaluateStages, type HttpsOnlyWiring } from '@main/privacy/RequestPipeline.js'
import { decideTabNavigation } from '@main/browser/navigation-policy.js'
import {
  followInterstitial,
  forgetHttpsExemptions,
  httpsExemptionsFor,
  type ContinueGrant
} from '@main/privacy/https-exemptions.js'
import {
  ContinueTokens,
  continueUrl,
  interstitialTargetOf,
  interstitialTokenOf
} from '@shared/privacy/https-token.js'
import { omniboxDisplayValue } from '@shared/url/omnibox.js'
import { scope } from './world.js'

/**
 * Steps for `https-only.feature`.
 *
 * The real pipeline, the real navigation policy and the real redemption, over two windows that are each a
 * session key and one tab. `Tab.ts` cannot be here — it needs a browser process — but what it does with a
 * navigation is two calls: `decideTabNavigation`, and `followInterstitial` for what that refused. The page's
 * "Continue" button is its address's token put on the continue route, which is what `HttpsOnlyPage` does.
 */

interface Window {
  /** Stands in for the Electron session: only ever a key. */
  readonly session: object
  readonly viewId: number
  url: string
}

interface HttpsWorld {
  readonly windows: Record<'normal' | 'private', Window>
  readonly tokens: ContinueTokens<ContinueGrant>
  readonly clock: { at: number }
  /** The window the last step acted in, which "the tab" refers to. */
  current: Window
}

/** Kept in `scratch`: the shape is this file's alone, as `tab-groups.steps.ts` argues for its own. */
const KEY = 'httpsOnlyWorld'

function httpsWorld(state: unknown): HttpsWorld {
  const held = scope(state).scratch[KEY]
  if (held === undefined) throw new Error('this scenario has no windows; add a Given for it')
  return held as HttpsWorld
}

function windowOf(state: unknown, name: string): Window {
  if (name !== 'normal' && name !== 'private') throw new Error(`no ${name} window`)
  const window = httpsWorld(state).windows[name]
  httpsWorld(state).current = window
  return window
}

function wiring(world: HttpsWorld, window: Window): HttpsOnlyWiring {
  return {
    exemptions: httpsExemptionsFor(window.session),
    tokens: world.tokens,
    uiLocale: () => 'en'
  }
}

/** A load the core starts: through the pipeline, and wherever it redirects. */
function load(state: unknown, window: Window, url: string): void {
  const world = httpsWorld(state)
  const outcome = evaluateStages(
    {
      url,
      resourceType: 'mainFrame',
      documentUrl: null,
      method: 'GET',
      settings: scope(state).settings,
      webContentsId: window.viewId
    },
    null,
    wiring(world, window)
  )
  window.url = outcome.action === 'redirect' ? outcome.url : url
}

// --- given -------------------------------------------------------------------

Given('a normal window and a private window', (state: unknown) => {
  const clock = { at: 0 }
  let minted = 0
  const normal: Window = { session: {}, viewId: 1, url: 'tessera://start/' }
  const world: HttpsWorld = {
    windows: { normal, private: { session: {}, viewId: 2, url: 'tessera://start/' } },
    tokens: new ContinueTokens<ContinueGrant>({
      mint: () => `token${(minted += 1)}`.padEnd(43, 'x'),
      same: (a, b) => a === b,
      now: () => clock.at
    }),
    clock,
    current: normal
  }
  scope(state).scratch[KEY] = world
})

// --- when --------------------------------------------------------------------

When('I open {string} in the {word} window', (state: unknown, url: string, name: string) => {
  load(state, windowOf(state, name), url)
})

When(
  '{string} redirects the {word} window to {string}',
  (state: unknown, _site: string, name: string, url: string) => {
    const window = windowOf(state, name)
    // A `Location:` header: judged as a redirect, and the unprivileged interstitial is let through.
    expect(decideTabNavigation({ url, source: 'redirect', isMainFrame: true }).allowed).toBe(true)
    window.url = url
  }
)

When(
  "{string} redirects the {word} window to the continue route with the tab's token",
  (state: unknown, site: string, name: string) => {
    const window = windowOf(state, name)
    const token = interstitialTokenOf(window.url)
    if (token === null) throw new Error('the tab carries no token to steal')
    const redirect = {
      url: continueUrl(token),
      source: 'redirect' as const,
      isMainFrame: true,
      initiatorUrl: `https://${site}/`
    }
    // Let through as a redirect — the protocol handler answers the route with nothing, so the tab stays.
    expect(decideTabNavigation(redirect).allowed).toBe(true)
    expect(
      followInterstitial(
        redirect,
        { id: window.viewId, navigationHistory: { canGoBack: () => true } },
        httpsWorld(state).tokens
      )
    ).toBeNull()
  }
)

When('I press {string}', (state: unknown, label: string) => {
  if (label !== 'Continue unencrypted') throw new Error(`no step for the button ${label}`)
  const world = httpsWorld(state)
  const window = world.current
  // What the button does: the token of its own address, onto the continue route, from the page itself.
  const token = interstitialTokenOf(window.url)
  if (token === null) throw new Error('the page offers no way to continue')
  const pending = {
    url: continueUrl(token),
    source: 'frame' as const,
    isMainFrame: true,
    initiatorUrl: window.url
  }
  expect(decideTabNavigation(pending).allowed, 'page content reached an internal address').toBe(
    false
  )
  const step = followInterstitial(
    pending,
    { id: window.viewId, navigationHistory: { canGoBack: () => true } },
    world.tokens
  )
  if (step?.kind === 'load') load(state, window, step.url)
})

When('ten minutes pass', (state: unknown) => {
  httpsWorld(state).clock.at += 10 * 60 * 1000
})

When('I close the private window', (state: unknown) => {
  forgetHttpsExemptions(httpsWorld(state).windows.private.session)
})

// --- then --------------------------------------------------------------------

Then('the tab is on the interstitial for {string}', (state: unknown, target: string) => {
  expect(interstitialTargetOf(httpsWorld(state).current.url)).toBe(target)
})

Then('the tab shows {string}', (state: unknown, url: string) => {
  expect(httpsWorld(state).current.url).toBe(url)
})

Then('the address bar shows {string}', (state: unknown, shown: string) => {
  expect(omniboxDisplayValue(httpsWorld(state).current.url)).toBe(shown)
})

Then('the page offers a way to continue', (state: unknown) => {
  expect(interstitialTokenOf(httpsWorld(state).current.url)).not.toBeNull()
})

Then('the page offers no way to continue', (state: unknown) => {
  expect(interstitialTokenOf(httpsWorld(state).current.url)).toBeNull()
})

Then(
  "the page's image {string} loads from {string}",
  (state: unknown, image: string, fetched: string) => {
    const world = httpsWorld(state)
    const outcome = evaluateStages(
      {
        url: image,
        resourceType: 'image',
        documentUrl: world.current.url,
        method: 'GET',
        settings: scope(state).settings,
        webContentsId: world.current.viewId
      },
      null,
      wiring(world, world.current)
    )
    expect(outcome.action === 'redirect' ? outcome.url : image).toBe(fetched)
  }
)

Then('no host is exempt in the {word} window', (state: unknown, name: string) => {
  const window = windowOf(state, name)
  for (const url of ['http://bank.example/', 'http://printer.lan/']) {
    const exempt = httpsExemptionsFor(window.session).exempts({
      url,
      resourceType: 'mainFrame',
      documentUrl: null
    })
    expect(exempt, url).toBe(false)
  }
})
