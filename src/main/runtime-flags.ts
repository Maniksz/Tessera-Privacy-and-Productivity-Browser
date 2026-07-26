import { app } from 'electron'

/**
 * Chromium command-line configuration (spec 4: no telemetry in the substrate).
 *
 * These have to be applied before `app.whenReady()` — Chromium reads its
 * command line during initialisation, so a switch appended later is simply
 * ignored. That is the same "timing decides" problem as the fingerprint
 * preload, one layer down.
 */

/**
 * Chromium features that phone home or exist to feed a Google service. Each is
 * off by default in tessera; none of them are user-visible features we are
 * taking away.
 */
const DISABLED_FEATURES = [
  // Sends page text to a translation backend.
  'Translate',
  'TranslateSubFrames',
  // Cast/DIAL discovery, which probes the local network unprompted.
  'MediaRouter',
  'DialMediaRouteProvider',
  // Server-provided performance hints, fetched per navigation.
  'OptimizationHints',
  'OptimizationHintsFetching',
  'OptimizationTargetPrediction',
  // Ad/interest-based targeting APIs. Blocking these at the network layer is
  // not enough; the APIs themselves must not exist.
  'InterestFeedContentSuggestions',
  'PrivacySandboxSettings4',
  'TopicsAPI',
  'BrowsingTopics',
  'FledgeBiddingAndAuctionServer',
  'AttributionReporting',
  'PrivateAggregationApi',
  // Speculative connections based on typing, which leak partial input.
  'PreconnectToSearch',
  // Feedback/metrics collection.
  'UserFeedbackUI',
  'ChromeWhatsNewUI'
].join(',')

/**
 * Features we explicitly want on. Hardware video decoding is a requirement, not
 * an optimisation: four simultaneous 1080p streams in a 2x2 grid are not
 * feasible with software decoding (spec 2).
 */
function enabledFeatures(): string {
  const features = ['CanvasOopRasterization']
  if (process.platform === 'linux') {
    // Without these, Linux falls back to software decoding on most setups.
    features.push('VaapiVideoDecoder', 'VaapiVideoEncoder', 'AcceleratedVideoDecodeLinuxGL')
  }
  if (process.platform === 'darwin' || process.platform === 'win32') {
    features.push('PlatformHEVCDecoderSupport')
  }
  return features.join(',')
}

export interface RuntimeFlagOptions {
  /** From `advanced.hardwareAcceleration`; needs a restart to change. */
  hardwareAcceleration: boolean
  /** From `splitView.throttleInactiveTiles`. */
  throttleBackgroundContent: boolean
}

export function applyRuntimeFlags(options: RuntimeFlagOptions): void {
  const cli = app.commandLine

  // --- no background chatter ------------------------------------------------
  cli.appendSwitch('disable-features', DISABLED_FEATURES)
  cli.appendSwitch('enable-features', enabledFeatures())
  // Component updater fetches widevine, filter lists, cert revocation sets…
  cli.appendSwitch('disable-component-update')
  // Domain Reliability reports network errors to Google.
  cli.appendSwitch('disable-domain-reliability')
  // <a ping> and Beacon-style navigation pings.
  cli.appendSwitch('no-pings')
  // Field-trial configuration fetched at startup.
  cli.appendSwitch('disable-background-networking')
  cli.appendSwitch('metrics-recording-only')
  cli.appendSwitch('disable-breakpad')
  cli.appendSwitch('disable-crash-reporter')
  cli.appendSwitch('no-default-browser-check')
  cli.appendSwitch('no-first-run')
  // Speculative prefetch/prerender based on page hints.
  cli.appendSwitch('disable-speech-api')

  // Electron's own crash reporting stays uninitialised: we never call
  // crashReporter.start(), and this makes the intent explicit for readers.
  app.setPath('crashDumps', app.getPath('temp'))

  // --- split view needs unthrottled background content ----------------------
  // Chromium throttles timers, rendering and raster work in views it considers
  // occluded or backgrounded. In a split layout every tile except the focused
  // one looks "background" to Chromium, which would stall exactly the videos
  // the user is watching (spec 2).
  if (!options.throttleBackgroundContent) {
    cli.appendSwitch('disable-background-timer-throttling')
    cli.appendSwitch('disable-renderer-backgrounding')
    cli.appendSwitch('disable-backgrounding-occluded-windows')
    cli.appendSwitch('disable-features-in-background', '')
  }

  // --- rendering ------------------------------------------------------------
  if (!options.hardwareAcceleration) {
    app.disableHardwareAcceleration()
  }

  // Mixed DPI across monitors, which a split-view window may straddle
  // (spec 10). Chromium handles this natively on Windows and macOS; on Linux
  // it needs to be told to respect per-monitor scaling.
  if (process.platform === 'linux') {
    cli.appendSwitch('enable-use-zoom-for-dsf', 'true')
  }
}
