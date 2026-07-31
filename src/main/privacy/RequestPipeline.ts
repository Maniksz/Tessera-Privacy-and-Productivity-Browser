import type { CallbackResponse, Session } from 'electron'
import { registrableDomain, hostMatchesRule, isIpAddress } from '@shared/url/domain.js'
import { stripTrackingParams } from '@shared/url/tracking-params.js'
import { filteringExemptFor } from '@shared/filters/site-exemption.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The single network interception point (spec 4).
 *
 * Spec 4 warns about registering the filter stages independently, and Electron
 * makes that warning concrete: `session.webRequest.onBeforeRequest` holds
 * exactly **one** listener. A second call silently replaces the first. Build the
 * blocker, the redirect filter and the parameter stripper as separate
 * registrations and whichever happens to register last is the only one that
 * runs — with no error, no warning, and no obvious symptom.
 *
 * So there is one listener per webRequest event, and the stages are an ordered
 * array inside it:
 *
 *   telemetry domains -> ad/tracker blocker -> redirect blocker
 *                     -> tracking parameters -> HTTPS upgrade
 *
 * Order is data, not emergent behaviour, and `STAGE_ORDER` is asserted by a
 * unit test so a future edit cannot reshuffle it by accident.
 */

export const STAGE_ORDER = [
  'telemetry',
  'blocker',
  'redirect',
  'tracking-params',
  'https-upgrade'
] as const

export type StageId = (typeof STAGE_ORDER)[number]

export type StageOutcome =
  | { action: 'continue' }
  | { action: 'block'; reason: StageId }
  | { action: 'redirect'; url: string; reason: StageId }

export interface RequestContext {
  url: string
  /** Electron's resource type: `mainFrame`, `subFrame`, `script`, `image`, … */
  resourceType: string
  /** Top-level document URL this request belongs to, when known. */
  documentUrl: string | null
  method: string
  settings: SettingsSnapshot
}

export interface RequestStage {
  readonly id: StageId
  /** Checked per request, so a settings change takes effect without a restart. */
  isEnabled(settings: SettingsSnapshot): boolean
  evaluate(context: RequestContext): StageOutcome
}

/**
 * Pluggable filter-list engine.
 *
 * An interface rather than a direct dependency, for two reasons that pull the same
 * way. A private session can be torn down with its window, so the stage has to
 * tolerate `null` and be skipped rather than approximated. And spec 4's objection
 * to a hand-rolled matcher is precisely a matcher that "understands a fraction of
 * the syntax and discards the rest" — so whatever implements this has to be
 * answerable for what it does *not* understand.
 *
 * `FilterEngine` in this directory is that implementation. It reads the same
 * EasyList/AdGuard syntax as the extensions Electron cannot host, and it counts
 * every line it declines with a reason, so "how much less does this block than the
 * lists ask for" is a number rather than a guess. The reasoning behind writing it
 * instead of taking `@ghostery/adblocker` is in `src/shared/filters/parse.ts`.
 */
export interface FilterListEngine {
  /** True when the request should be blocked. */
  matches(context: RequestContext): boolean
  /** CSS to hide leftover ad slots, per document URL. */
  cosmeticStylesFor(documentUrl: string): string | null
}

/**
 * Telemetry and crash-reporting endpoints of the substrate itself, blocked at
 * the network layer as a second line of defence behind the command-line
 * switches (spec 4).
 */
const TELEMETRY_HOSTS: readonly string[] = [
  'update.googleapis.com',
  'clients2.google.com',
  'clientservices.googleapis.com',
  'clients4.google.com',
  'safebrowsing.googleapis.com',
  'safebrowsing.google.com',
  'accounts.google.com',
  'optimizationguide-pa.googleapis.com',
  'content-autofill.googleapis.com',
  'translate.googleapis.com',
  'translate-pa.googleapis.com',
  'chromewebstore.googleapis.com',
  'crashpad.chromium.org',
  'clients.l.google.com',
  'sb-ssl.google.com'
]

/**
 * Redirect/link-shortener hosts. Matched on whole labels via
 * `hostMatchesRule`, never on fragments: spec 4 calls out that matching
 * `track.` or `click.` as substrings takes out parcel tracking and newsletter
 * links, and `registrableDomain` is what keeps `.co.uk` from collapsing into
 * one site.
 */
const REDIRECT_HOSTS: readonly string[] = [
  'doubleclick.net',
  'googleadservices.com',
  'adclick.g.doubleclick.net',
  'bs.serving-sys.com',
  'clickserve.dartsearch.net',
  'linksynergy.com',
  'anrdoezrs.net',
  'dpbolvw.net',
  'jdoqocy.com',
  'kqzyfj.com',
  'tkqlhce.com',
  'prf.hn',
  'awin1.com',
  'zenaps.com',
  'go.redirectingat.com',
  'shareasale.com',
  'out.reddit.com'
]

const telemetryStage: RequestStage = {
  id: 'telemetry',
  isEnabled: (settings) => settings['privacy.blockTelemetryDomains'],
  evaluate: ({ url }) => {
    const host = hostOf(url)
    if (host === null) return { action: 'continue' }
    return TELEMETRY_HOSTS.some((rule) => hostMatchesRule(host, rule))
      ? { action: 'block', reason: 'telemetry' }
      : { action: 'continue' }
  }
}

function blockerStage(engine: FilterListEngine | null): RequestStage {
  return {
    id: 'blocker',
    isEnabled: (settings) => settings['privacy.blockerEnabled'] && engine !== null,
    /*
      The per-site off switch is checked here rather than in `isEnabled`, and not by choice: `isEnabled`
      is handed the settings alone, while whether a site is exempt depends on which *document* the
      request belongs to. That is in the context.

      `documentUrl` is the top-level document, not the request's own address, which is the whole point —
      an exemption for `example.com` has to cover the third-party advert host the page pulls in, or it
      exempts nothing that matters. The one case it cannot answer is a request whose document is unknown
      (`null`), and there the exemption does not apply: filtering is the default and an unattributable
      request is not evidence that the user asked for less of it.

      Only this stage and cosmetic filtering are affected. `site-exemption.ts` argues why the other four
      stages keep running.
    */
    evaluate: (context) => {
      if (filteringExemptFor(context.documentUrl, context.settings['privacy.blockerOffForSites'])) {
        return { action: 'continue' }
      }
      return engine?.matches(context) ? { action: 'block', reason: 'blocker' } : { action: 'continue' }
    }
  }
}

const redirectStage: RequestStage = {
  id: 'redirect',
  isEnabled: (settings) => settings['privacy.blockRedirectTrackers'],
  evaluate: (context) => {
    // Only top-level navigations: a redirect host used as a subresource is the
    // blocker's business, and blocking it here would break embedded content.
    if (context.resourceType !== 'mainFrame') return { action: 'continue' }

    const host = hostOf(context.url)
    if (host === null) return { action: 'continue' }
    if (!REDIRECT_HOSTS.some((rule) => hostMatchesRule(host, rule))) return { action: 'continue' }

    // Never block a redirect that stays on the same site — that is ordinary
    // navigation, not cross-site tracking.
    if (context.documentUrl !== null) {
      const from = hostOf(context.documentUrl)
      if (from !== null && registrableDomain(from) === registrableDomain(host)) {
        return { action: 'continue' }
      }
    }

    // Many redirectors carry the real destination as a parameter; following it
    // directly beats showing a block page.
    const destination = extractDestination(context.url)
    if (destination !== null) return { action: 'redirect', url: destination, reason: 'redirect' }
    return { action: 'block', reason: 'redirect' }
  }
}

const trackingParamStage: RequestStage = {
  id: 'tracking-params',
  isEnabled: (settings) => settings['privacy.stripTrackingParameters'],
  evaluate: (context) => {
    // Rewriting subresource URLs would break cache keys and signed URLs for no
    // privacy gain; the address is what leaks.
    if (context.resourceType !== 'mainFrame' && context.resourceType !== 'subFrame') {
      return { action: 'continue' }
    }
    const { url, removed } = stripTrackingParams(context.url)
    return removed.length > 0
      ? { action: 'redirect', url, reason: 'tracking-params' }
      : { action: 'continue' }
  }
}

const httpsUpgradeStage: RequestStage = {
  id: 'https-upgrade',
  isEnabled: (settings) => settings['privacy.httpsOnlyMode'],
  evaluate: (context) => {
    if (!context.url.startsWith('http://')) return { action: 'continue' }

    const host = hostOf(context.url)
    /*
      Loopback, `.localhost` and bare IP addresses have no meaningful certificate to upgrade to.

      The IP case was stated in this comment and missing from the code, which is the worst of the two
      possible mistakes: a top-level `http://127.0.0.1:3000` — anybody's local development server —
      went to the interstitial, and a *subresource* on a bare address was silently rewritten to
      `https://` and simply failed to load. Nobody would connect either symptom to an HTTPS setting.

      An address literal cannot present a certificate a public CA would issue, so there is nothing to
      upgrade to and the interstitial has nothing to offer.
    */
    if (host === null || host === 'localhost' || host.endsWith('.localhost') || isIpAddress(host)) {
      return { action: 'continue' }
    }

    // Subresources are upgraded silently. A top-level navigation goes to the
    // interstitial instead, because spec 4 requires a real page explaining the
    // situation rather than a silent switch — that page then decides whether to
    // retry over HTTPS or offer to continue.
    if (context.resourceType === 'mainFrame') {
      return {
        action: 'redirect',
        url: `tessera://https-only?target=${encodeURIComponent(context.url)}`,
        reason: 'https-upgrade'
      }
    }
    return {
      action: 'redirect',
      url: `https://${context.url.slice('http://'.length)}`,
      reason: 'https-upgrade'
    }
  }
}

function hostOf(url: string): string | null {
  try {
    const { hostname } = new URL(url)
    return hostname === '' ? null : hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Pulls an absolute http(s) destination out of a redirector's parameters. */
function extractDestination(url: string): string | null {
  const candidates = ['url', 'u', 'target', 'dest', 'destination', 'redirect', 'r', 'to', 'q']
  try {
    const parsed = new URL(url)
    for (const name of candidates) {
      const value = parsed.searchParams.get(name)
      if (value === null) continue
      if (!/^https?:\/\//i.test(value)) continue
      // Validate before handing it to the network stack.
      try {
        return new URL(value).toString()
      } catch {
        continue
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * A request as an observer sees it, once the stages have let it through.
 *
 * Deliberately the same shape as `MediaRegistry`'s `MediaRequestObservation`, so the
 * hook hands its argument straight over with no adapter in between. The two are held
 * to that by a compile-time assignability check in `main/media/observation.ts` —
 * asserted there rather than by an import here, because this file must not depend on
 * the media feature to keep working.
 */
export interface ObservedRequest {
  readonly url: string
  readonly resourceType: string
  readonly documentUrl: string | null
  /**
   * `details.webContentsId`, which is what attributes the request to a tab.
   *
   * Read from the id rather than from `details.webContents`, because the object may
   * already be torn down by the time a listener looks at it while the number stays
   * usable — and an observer that only needs to answer "which tab" has no business
   * touching a live `WebContents` at all. Null for a request that belongs to no view:
   * a service worker, a session-level fetch.
   */
  readonly webContentsId: number | null
}

export interface PipelineHooks {
  /** Called for every blocked request so the omnibox badge shows a real count. */
  onBlocked(documentUrl: string | null, reason: StageId): void
  /**
   * Every request the stages let through, exactly once each.
   *
   * This is the only interception point in the browser, and it has to stay that way:
   * Electron keeps a *single* `onBeforeRequest` listener, so a feature that wanted to
   * watch traffic and registered its own would not add a listener, it would delete the
   * ad blocker. Observation is therefore a hook here rather than a second
   * registration elsewhere, and an architecture test counts the registrations.
   *
   * Called after the stage loop, which is what makes blocking win: a request that was
   * cancelled or rewritten never reaches this, so nothing the blocker stopped can
   * appear in a media panel as something the page is playing — and a redirected
   * request is observed when it comes back round at its new address, which is the
   * address that will actually be fetched.
   */
  onRequest(observation: ObservedRequest): void
}

export interface PipelineOptions {
  session: Session
  getSettings(): SettingsSnapshot
  filterEngine?: FilterListEngine | null
  hooks?: Partial<PipelineHooks>
}

/** What the pipeline needs from Electron's `details`, copied while the request is still live. */
interface RequestFacts {
  readonly url: string
  readonly resourceType: string
  readonly documentUrl: string | null
  readonly method: string
  readonly webContentsId: number | null
}

/**
 * The longest a top-level navigation may wait for the blocker's first compile.
 *
 * A bound rather than a courtesy. Reading the cached lists off disk takes a few hundred
 * milliseconds; a compile that fails, or a disk that has gone away, must cost one page its filtering
 * rather than cost the browser every page it will ever load.
 */
const FIRST_COMPILE_GRACE_MS = 750

/*
  The gate a top-level navigation waits at until the blocker has rules for the first time.

  Startup no longer waits for the lists — the first window opens while they are still being read —
  and `session.restoreAfterCrash` is on by default, so a restored session can put four real pages on
  the wire before the engine holds a single rule. Those first pages are the ones a blocker is judged
  on, and unfiltered is exactly what would be seen.

  Only main frames wait, and that is not a compromise either: a subresource is fetched *because* of a
  document, so by the time one is dispatched the navigation that asked for it has already waited.
  Making them wait too would add a second delay for nothing.

  Module-level, because the two ends are not in the same conversation: one process compiles its lists
  once, while `installRequestPipeline` runs per session — a private window opened an hour later has no
  promise to be handed and nothing to wait for. `FilterSubscription` is the one caller; it takes the
  release when it is built and gives it back after its first compile.
*/
let firstCompile: { readonly compiled: Promise<void>; readonly release: () => void } | null = null

/**
 * Holds top-level navigations until the returned function is called.
 *
 * Calling the release twice is harmless, and so is calling it after the grace period above has
 * already let the waiting requests through — it then finds nothing waiting.
 */
export function holdMainFrameRequests(): () => void {
  if (firstCompile === null) {
    let release = (): void => {}
    const compiled = new Promise<void>((resolve) => {
      release = resolve
    })
    firstCompile = { compiled, release }
  }
  const held = firstCompile
  return () => {
    held.release()
    // Cleared, so a request arriving later takes the synchronous path rather than a resolved promise's
    // microtask — and so a second subscription (only tests build one) starts from a closed gate again.
    if (firstCompile === held) firstCompile = null
  }
}

/** Resolves on the first compile or on the deadline, whichever comes first. */
function untilCompiled(compiled: Promise<void>): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, FIRST_COMPILE_GRACE_MS)
    void compiled.then(() => {
      // Cleared so the wait cannot outlive its reason: an unref-less timer would otherwise keep the
      // process on its feet for three quarters of a second after the lists were ready.
      clearTimeout(deadline)
      resolve()
    })
  })
}

/**
 * Installs the pipeline on a session. Returns a disposer, so a private session
 * can be torn down completely when its window closes.
 */
export function installRequestPipeline(options: PipelineOptions): () => void {
  const { session, getSettings } = options
  const engine = options.filterEngine ?? null
  const onBlocked = options.hooks?.onBlocked ?? (() => {})
  const onRequest = options.hooks?.onRequest ?? (() => {})

  const stages: readonly RequestStage[] = [
    telemetryStage,
    blockerStage(engine),
    redirectStage,
    trackingParamStage,
    httpsUpgradeStage
  ]

  // Guards the ordering invariant at startup rather than in review.
  const actualOrder = stages.map((stage) => stage.id)
  if (actualOrder.join(',') !== STAGE_ORDER.join(',')) {
    throw new Error(
      `Request pipeline order drifted: expected ${STAGE_ORDER.join(',')}, got ${actualOrder.join(',')}`
    )
  }

  const decide = (facts: RequestFacts, callback: (response: CallbackResponse) => void): void => {
    // Read here rather than at interception, so a request that waited for the lists is judged against
    // the settings as they are now — the same reason every stage takes them per request.
    const settings = getSettings()
    const context: RequestContext = {
      url: facts.url,
      resourceType: facts.resourceType,
      documentUrl: facts.documentUrl,
      method: facts.method,
      settings
    }

    for (const stage of stages) {
      if (!stage.isEnabled(settings)) continue
      const outcome = stage.evaluate(context)
      if (outcome.action === 'block') {
        onBlocked(context.documentUrl, outcome.reason)
        callback({ cancel: true })
        return
      }
      if (outcome.action === 'redirect') {
        callback({ redirectURL: outcome.url })
        return
      }
    }

    /*
      Observed here, after the loop and before the callback the page is waiting on.

      An observer is not allowed to fail this request: it runs on every request the
      browser makes, so a throw here would stall the load and look like a page that
      never finishes. There is no try/catch guarding it because the guarantee belongs
      to the observer — `MediaRegistry.observeRequest` counts its own failures rather
      than propagating them — and a second, unreachable catch in the hot path would be
      a branch no test can cover.
    */
    onRequest({
      url: context.url,
      resourceType: context.resourceType,
      documentUrl: context.documentUrl,
      webContentsId: facts.webContentsId
    })
    callback({})
  }

  session.webRequest.onBeforeRequest((details, callback) => {
    /*
      Copied before anything is awaited.

      `details.frame` is a live renderer-owned object, and a main frame may well be gone by the time a
      held request resumes — asking a disposed frame for its URL throws, in a listener every request in
      the browser passes through.
    */
    const facts: RequestFacts = {
      url: details.url,
      resourceType: details.resourceType,
      documentUrl: details.frame?.url ?? null,
      method: details.method,
      webContentsId: details.webContentsId ?? null
    }

    const held = firstCompile
    if (held !== null && facts.resourceType === 'mainFrame') {
      void untilCompiled(held.compiled).then(() => {
        decide(facts, callback)
      })
      return
    }
    decide(facts, callback)
  })

  return () => {
    // Electron has no "remove listener" for webRequest; passing null clears it.
    session.webRequest.onBeforeRequest(null)
  }
}

/** Exposed for tests: run the stage chain without an Electron session. */
export function evaluateStages(
  context: RequestContext,
  engine: FilterListEngine | null = null
): StageOutcome {
  const stages: readonly RequestStage[] = [
    telemetryStage,
    blockerStage(engine),
    redirectStage,
    trackingParamStage,
    httpsUpgradeStage
  ]
  for (const stage of stages) {
    if (!stage.isEnabled(context.settings)) continue
    const outcome = stage.evaluate(context)
    if (outcome.action !== 'continue') return outcome
  }
  return { action: 'continue' }
}
