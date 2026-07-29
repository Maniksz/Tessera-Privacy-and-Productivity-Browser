import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STAGE_ORDER,
  evaluateStages,
  holdMainFrameRequests,
  installRequestPipeline,
  type FilterListEngine,
  type RequestContext
} from '@main/privacy/RequestPipeline.js'
import { FilterEngine } from '@main/privacy/FilterEngine.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * Spec 4 requires the filter stages to run as one ordered pipeline through a
 * single interception point, and warns that independent registration leaves part
 * of the protection silently ineffective. These tests pin the order and check
 * each stage in isolation.
 */

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    url: 'https://example.com/',
    resourceType: 'mainFrame',
    documentUrl: 'https://example.com/',
    method: 'GET',
    settings: defaultSettings(),
    ...overrides
  }
}

function withSettings(patch: Partial<SettingsSnapshot>): SettingsSnapshot {
  return { ...defaultSettings(), ...patch }
}

describe('pipeline ordering', () => {
  it('keeps the order spec 4 prescribes', () => {
    expect([...STAGE_ORDER]).toEqual([
      'telemetry',
      'blocker',
      'redirect',
      'tracking-params',
      'https-upgrade'
    ])
  })
})

describe('telemetry stage', () => {
  it('blocks a substrate telemetry endpoint', () => {
    const outcome = evaluateStages(
      context({ url: 'https://optimizationguide-pa.googleapis.com/v1', resourceType: 'xhr' })
    )
    expect(outcome).toEqual({ action: 'block', reason: 'telemetry' })
  })

  it('blocks subdomains of a telemetry host', () => {
    const outcome = evaluateStages(context({ url: 'https://a.b.safebrowsing.googleapis.com/x' }))
    expect(outcome.action).toBe('block')
  })

  it('does not block an unrelated Google service', () => {
    const outcome = evaluateStages(
      context({ url: 'https://fonts.googleapis.com/css', resourceType: 'stylesheet' })
    )
    expect(outcome.action).toBe('continue')
  })

  it('respects the setting', () => {
    const outcome = evaluateStages(
      context({
        url: 'https://safebrowsing.googleapis.com/x',
        resourceType: 'xhr',
        settings: withSettings({
          'privacy.blockTelemetryDomains': false,
          'privacy.stripTrackingParameters': false
        })
      })
    )
    expect(outcome.action).toBe('continue')
  })
})

describe('blocker stage', () => {
  const engine: FilterListEngine = {
    matches: (ctx) => ctx.url.includes('/ads/'),
    cosmeticStylesFor: () => null
  }

  it('blocks what the filter engine matches', () => {
    const outcome = evaluateStages(
      context({ url: 'https://cdn.example.com/ads/banner.js', resourceType: 'script' }),
      engine
    )
    expect(outcome).toEqual({ action: 'block', reason: 'blocker' })
  })

  it('is skipped entirely when no engine is wired up', () => {
    // Better a skipped stage than an approximation that understands a fraction
    // of the filter syntax (spec 4).
    const outcome = evaluateStages(
      context({ url: 'https://cdn.example.com/ads/banner.js', resourceType: 'script' }),
      null
    )
    expect(outcome.action).toBe('continue')
  })

  it('respects the setting', () => {
    const outcome = evaluateStages(
      context({
        url: 'https://cdn.example.com/ads/banner.js',
        resourceType: 'script',
        settings: withSettings({ 'privacy.blockerEnabled': false })
      }),
      engine
    )
    expect(outcome.action).toBe('continue')
  })
})

describe('blocker stage with the real filter engine', () => {
  /**
   * The engine reaching the pipeline through the one interception point.
   *
   * The stage tests above use a stub, which proves the wiring but not that the
   * engine and the stage agree about anything. These use real EasyList lines and
   * the real `FilterEngine`, so a change to either side that breaks the other
   * shows up here rather than in a browser.
   */
  const engine = new FilterEngine({
    lists: [
      [
        '||ad.doubleclick.net^',
        '||0emm.com^$third-party',
        '/2x2.gif?$image',
        '@@||ad.linksynergy.com^$image',
        '||ad.linksynergy.com^'
      ].join('\n')
    ],
    getSettings: defaultSettings
  })

  it('blocks a host the lists name', () => {
    const outcome = evaluateStages(
      context({ url: 'https://ad.doubleclick.net/ddm/ad', resourceType: 'image' }),
      engine
    )
    expect(outcome).toEqual({ action: 'block', reason: 'blocker' })
  })

  it('honours a list exception rather than blocking anyway', () => {
    const outcome = evaluateStages(
      context({ url: 'https://ad.linksynergy.com/pixel.gif', resourceType: 'image' }),
      engine
    )
    expect(outcome.action).toBe('continue')
  })

  it('takes the resource type from Electron’s own name for it', () => {
    const url = 'https://cdn.example.org/2x2.gif?id=1'
    expect(evaluateStages(context({ url, resourceType: 'image' }), engine).action).toBe('block')
    expect(evaluateStages(context({ url, resourceType: 'script' }), engine).action).toBe('continue')
  })

  it('takes the party from the document the request belongs to', () => {
    const url = 'https://t.0emm.com/pixel.gif'
    expect(
      evaluateStages(
        context({ url, resourceType: 'image', documentUrl: 'https://news.example.org/' }),
        engine
      ).action
    ).toBe('block')
    expect(
      evaluateStages(
        context({ url, resourceType: 'image', documentUrl: 'https://www.0emm.com/' }),
        engine
      ).action
    ).toBe('continue')
  })

  it('leaves an ordinary page request alone', () => {
    const outcome = evaluateStages(
      context({ url: 'https://en.wikipedia.org/wiki/Berlin', documentUrl: null }),
      engine
    )
    expect(outcome.action).toBe('continue')
  })

  it('still lets the telemetry stage decide first', () => {
    // Stage order is data, and the blocker sits behind the telemetry list.
    const outcome = evaluateStages(
      context({ url: 'https://safebrowsing.googleapis.com/v4', resourceType: 'xhr' }),
      engine
    )
    expect(outcome).toEqual({ action: 'block', reason: 'telemetry' })
  })
})

describe('redirect stage', () => {
  it('follows the real destination out of a redirector', () => {
    const outcome = evaluateStages(
      context({
        url: 'https://go.redirectingat.com/?url=https%3A%2F%2Fshop.example.com%2Fitem',
        documentUrl: 'https://news.example.org/article'
      })
    )
    expect(outcome).toEqual({
      action: 'redirect',
      url: 'https://shop.example.com/item',
      reason: 'redirect'
    })
  })

  it('blocks a redirector with no recoverable destination', () => {
    const outcome = evaluateStages(
      context({
        url: 'https://anrdoezrs.net/click-1234-5678',
        documentUrl: 'https://news.example.org/article'
      })
    )
    expect(outcome).toEqual({ action: 'block', reason: 'redirect' })
  })

  it('leaves same-site navigation alone', () => {
    const outcome = evaluateStages(
      context({
        url: 'https://sub.doubleclick.net/page',
        documentUrl: 'https://other.doubleclick.net/from'
      })
    )
    expect(outcome.action).toBe('continue')
  })

  it('ignores subresources, which belong to the blocker stage', () => {
    const outcome = evaluateStages(
      context({
        url: 'https://anrdoezrs.net/pixel.gif',
        resourceType: 'image',
        documentUrl: 'https://news.example.org/article'
      })
    )
    expect(outcome.action).toBe('continue')
  })

  it('does not block a parcel-tracking host', () => {
    // The regression spec 4 warns about.
    const outcome = evaluateStages(
      context({
        url: 'https://track.dhl.de/shipment/123',
        documentUrl: 'https://mail.example.com/inbox'
      })
    )
    expect(outcome.action).toBe('continue')
  })

  it('does not block a newsletter click host', () => {
    const outcome = evaluateStages(
      context({
        url: 'https://click.newsletter.example.com/story',
        documentUrl: 'https://mail.example.com/inbox'
      })
    )
    expect(outcome.action).toBe('continue')
  })
})

describe('tracking parameter stage', () => {
  it('redirects to the cleaned URL', () => {
    const outcome = evaluateStages(
      context({ url: 'https://example.com/article?utm_source=news&id=1' })
    )
    expect(outcome).toEqual({
      action: 'redirect',
      url: 'https://example.com/article?id=1',
      reason: 'tracking-params'
    })
  })

  it('leaves subresource URLs alone so cache keys and signatures survive', () => {
    const outcome = evaluateStages(
      context({ url: 'https://cdn.example.com/a.js?utm_source=x', resourceType: 'script' })
    )
    expect(outcome.action).toBe('continue')
  })

  it('does nothing when there is nothing to strip', () => {
    const outcome = evaluateStages(context({ url: 'https://example.com/?q=1' }))
    expect(outcome.action).toBe('continue')
  })
})

describe('https upgrade stage', () => {
  it('sends a top-level HTTP navigation to a real interstitial', () => {
    // Spec 4: a real page, not a silent switch.
    const outcome = evaluateStages(context({ url: 'http://example.com/page' }))
    expect(outcome.action).toBe('redirect')
    if (outcome.action !== 'redirect') return
    expect(outcome.url.startsWith('tessera://https-only?target=')).toBe(true)
    expect(decodeURIComponent(outcome.url.split('target=')[1]!)).toBe('http://example.com/page')
  })

  it('upgrades subresources silently', () => {
    const outcome = evaluateStages(
      context({ url: 'http://example.com/a.png', resourceType: 'image' })
    )
    expect(outcome).toEqual({
      action: 'redirect',
      url: 'https://example.com/a.png',
      reason: 'https-upgrade'
    })
  })

  it('leaves loopback alone, which has no certificate to upgrade to', () => {
    const outcome = evaluateStages(context({ url: 'http://localhost:5173/index.html' }))
    expect(outcome.action).toBe('continue')
  })

  it('leaves a bare IP address alone as well', () => {
    /*
      The stage's own comment claimed this and the code did not do it, which cost two separate
      failures nobody would have traced back to an HTTPS setting: a development server on
      `http://127.0.0.1:3000` went to the interstitial, and an image served from a bare address was
      rewritten to `https://` and silently failed.

      No public CA issues a certificate for an address literal, so there is nothing to upgrade to.
    */
    for (const url of [
      'http://127.0.0.1:3000/app',
      'http://192.168.1.10/router',
      'http://10.0.0.5:8080/x.png',
      'http://[::1]:5000/'
    ]) {
      expect(evaluateStages(context({ url })).action, url).toBe('continue')
    }
  })

  it('leaves a bare IP subresource alone, not only the top-level page', () => {
    // The silent half of the same bug: a subresource never reaches the interstitial, so an upgrade
    // here is simply a broken image with nothing to explain it.
    const outcome = evaluateStages(
      context({ url: 'http://127.0.0.1:3000/logo.png', resourceType: 'image' })
    )
    expect(outcome.action).toBe('continue')
  })

  it('still upgrades a hostname that merely contains digits', () => {
    // The guard must key on "is an address", not on "looks numeric": `192.168.example.com` is a
    // perfectly ordinary name that can and should be upgraded.
    const outcome = evaluateStages(context({ url: 'http://192.168.example.com/page' }))
    expect(outcome.action).toBe('redirect')
  })

  it('respects the setting', () => {
    const outcome = evaluateStages(
      context({
        url: 'http://example.com/page',
        settings: withSettings({ 'privacy.httpsOnlyMode': false })
      })
    )
    expect(outcome.action).toBe('continue')
  })
})

describe('stage precedence', () => {
  it('lets telemetry blocking win over parameter stripping', () => {
    // A telemetry URL carrying utm parameters must be blocked, not cleaned and
    // then allowed through.
    const outcome = evaluateStages(
      context({ url: 'https://safebrowsing.googleapis.com/v4?utm_source=x' })
    )
    expect(outcome).toEqual({ action: 'block', reason: 'telemetry' })
  })

  it('cleans parameters before considering an HTTPS upgrade', () => {
    const outcome = evaluateStages(context({ url: 'http://example.com/a?utm_source=x' }))
    expect(outcome.action).toBe('redirect')
    if (outcome.action !== 'redirect') return
    expect(outcome.reason).toBe('tracking-params')
  })
})

/**
 * The wait a page pays so it is not the one page that loads unfiltered.
 *
 * Startup does not await the filter compile any more — the window opens while the lists are still
 * being read — and `session.restoreAfterCrash` is on by default, so a restored session puts real
 * navigations on the wire in that gap. These pin both halves of the answer: a top-level navigation
 * waits, and it waits for a bounded time.
 */
describe('holding navigations until the lists compile', () => {
  let release: (() => void) | null = null

  afterEach(() => {
    // The hold is process-wide, so a test that left one on would hang the next one.
    release?.()
    release = null
    vi.useRealTimers()
  })

  function listenerOnHeldPipeline(): (details: unknown, callback: (r: unknown) => void) => void {
    const registrations: Array<(details: unknown, callback: (r: unknown) => void) => void> = []
    const session = {
      webRequest: {
        onBeforeRequest(listener: unknown) {
          if (listener !== null) {
            registrations.push(
              listener as (details: unknown, callback: (r: unknown) => void) => void
            )
          }
        }
      }
    }
    release = holdMainFrameRequests()
    installRequestPipeline({
      session: session as never,
      getSettings: () => defaultSettings(),
      filterEngine: null
    })
    const listener = registrations[0]
    if (listener === undefined) throw new Error('no listener registered')
    return listener
  }

  it('holds a top-level navigation until the first compile', async () => {
    const listener = listenerOnHeldPipeline()
    const answer = vi.fn()
    listener({ url: 'https://example.com/', resourceType: 'mainFrame', method: 'GET' }, answer)

    // A microtask turn is all a request that was *not* held would need.
    await Promise.resolve()
    expect(answer).not.toHaveBeenCalled()

    release?.()
    release = null
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith({})
    })
  })

  it('does not hold a subresource', () => {
    /*
      And answers it synchronously, which is the point rather than an implementation detail: a
      subresource is fetched because a document asked for it, so the navigation it belongs to has
      already paid the wait. Holding it as well would be a second delay for nothing.
    */
    const listener = listenerOnHeldPipeline()
    const answer = vi.fn()
    listener({ url: 'https://example.com/app.js', resourceType: 'script', method: 'GET' }, answer)
    expect(answer).toHaveBeenCalledWith({})
  })

  it('lets the navigation through after 750ms even if nothing ever compiles', async () => {
    vi.useFakeTimers()
    const listener = listenerOnHeldPipeline()
    const answer = vi.fn()
    listener({ url: 'https://example.com/', resourceType: 'mainFrame', method: 'GET' }, answer)

    await vi.advanceTimersByTimeAsync(749)
    expect(answer).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(answer).toHaveBeenCalledWith({})
  })

  it('still applies the stages to a request it held', async () => {
    // The wait must not turn into a bypass: the request is judged when it resumes, not waved through.
    const listener = listenerOnHeldPipeline()
    const answer = vi.fn()
    listener(
      { url: 'https://example.com/a?utm_source=x', resourceType: 'mainFrame', method: 'GET' },
      answer
    )
    release?.()
    release = null
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith({ redirectURL: 'https://example.com/a' })
    })
  })
})
