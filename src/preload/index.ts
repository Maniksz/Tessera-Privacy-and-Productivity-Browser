import { contextBridge, ipcRenderer } from 'electron'
import {
  EVENT_CHANNELS,
  INTERNAL_PAGE_EVENT_CHANNELS,
  INTERNAL_PAGE_INVOKE_CHANNELS,
  isInternalPage,
  mayInternalPageInvoke,
  mayInternalPageListen,
  type InternalPage,
  INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel
} from '@shared/ipc/channels.js'
import {
  maskAudio,
  maskCanvas,
  maskDeviceApis,
  maskFonts,
  maskLocale,
  maskScreen,
  maskTimeZone,
  maskUserAgent,
  maskWebgl
} from '@shared/fingerprint/apply.js'
// `wire.ts`, not `plan.ts`: the latter reaches a table of public suffixes this bundle never uses.
import { FINGERPRINT_PLAN_CHANNEL, isMaskingPlan } from '@shared/fingerprint/wire.js'
import { installCosmeticFiltering } from './cosmetic.js'
import { installElementPicker } from './picker.js'
import { installAutofill } from './autofill.js'

/**
 * The one preload script, for every renderer.
 *
 * ## Why one file rather than one per role
 *
 * Two entry files that both import the shared channel list make Rollup emit a
 * shared chunk, and the entries then `require('./chunks/…')` at runtime. A
 * sandboxed preload cannot do that: `require` there is limited to a small set of
 * built-ins, so the split build would fail the moment it ran — while still
 * building cleanly. One self-contained file removes that failure mode entirely.
 *
 * ## How the role is decided
 *
 * From `process.argv`, which the main process sets per renderer via
 * `webPreferences.additionalArguments`. Page content cannot alter the process
 * command line, so this is as trustworthy as picking a different file would be —
 * and unlike a URL check it is not fooled by a dev server or a crafted address.
 *
 * Anything without an explicit role is treated as web content and gets nothing.
 * The default has to be the restrictive one.
 *
 * ## Two gates, not one
 *
 * This file decides what to *expose*. The main process independently decides what
 * to *accept*, in `main/ipc/sender-policy.ts`. A compromised renderer is exactly
 * the case where this file's judgement cannot be relied on, so the core never
 * relies on it (spec 6).
 */

const ROLE_PREFIX = '--tessera-role='
const INTERNAL_SCHEME = 'tessera:'

type Role = 'chrome' | 'content'

function readRole(): Role {
  const argument = process.argv.find((value) => value.startsWith(ROLE_PREFIX))
  const role = argument?.slice(ROLE_PREFIX.length)
  // Least privilege by default: an unrecognised or absent role is content.
  return role === 'chrome' ? 'chrome' : 'content'
}

function internalPageName(): InternalPage | null {
  try {
    // Compiled under the Node config, which has no DOM lib on purpose — adding it
    // would let genuinely browser-only APIs into the preload unnoticed.
    const scope = globalThis as { location?: { protocol?: string; hostname?: string } }
    if (scope.location?.protocol !== INTERNAL_SCHEME) return null
    /*
      The hostname *is* the page name, and it decides the privileges. An empty host means the
      bare `tessera://` address, which the protocol handler serves as the start page — so the
      two have to agree on that default or the page would load with no bridge.

      This is the convenience gate. The core decides again from the frame URL in
      `main/ipc/sender-policy.ts`, because a compromised renderer is exactly the case where this
      file's answer cannot be trusted.
    */
    const host = (scope.location.hostname ?? '').toLowerCase()
    const page = host === '' ? 'start' : host
    return isInternalPage(page) ? page : null
  } catch {
    return null
  }
}

function currentHost(): string {
  try {
    const scope = globalThis as { location?: { hostname?: string } }
    return scope.location?.hostname ?? ''
  } catch {
    return ''
  }
}

/** Subscribes and returns its own unsubscribe function (spec 6). */
function makeSubscriber(guard: (channel: string) => boolean) {
  return (channel: string, listener: (payload: unknown) => void): (() => void) => {
    if (!guard(channel)) {
      throw new Error(`tessera: not allowed to listen to "${channel}"`)
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

function makeInvoker(guard: (channel: string) => boolean, label: string) {
  return (channel: string, payload?: unknown): Promise<unknown> => {
    if (!guard(channel)) {
      return Promise.reject(new Error(`tessera: ${label} may not call "${channel}"`))
    }
    return ipcRenderer.invoke(channel, payload)
  }
}

// Marks that the preload ran, and when. An integration test asserts this exists
// before any page script executed — the timing window in which fingerprint
// masking has to be installed to be worth anything (spec 4).
Object.defineProperty(globalThis, '__tesseraPreload', {
  value: Object.freeze({ version: 1, role: readRole(), appliedAt: 'document-start' }),
  writable: false,
  enumerable: false,
  configurable: false
})

const role = readRole()
/** Resolved once: the page cannot change its own address without a reload. */
const internalPage = internalPageName()

if (role === 'chrome') {
  // The trusted browser UI: full contract surface, still name-checked.
  contextBridge.exposeInMainWorld('tessera', {
    invoke: makeInvoker(isInvokeChannel, 'chrome UI'),
    on: makeSubscriber(isEventChannel),
    channels: { invoke: INVOKE_CHANNELS, event: EVENT_CHANNELS }
  })
} else if (internalPage !== null) {
  // Our own pages, but rendered as content: a narrow allowlist only. Nothing here
  // can change settings, touch tabs or reach the window.
  contextBridge.exposeInMainWorld('tesseraInternal', {
    invoke: makeInvoker(
      (channel) => mayInternalPageInvoke(internalPage, channel),
      `internal page ${internalPage}`
    ),
    on: makeSubscriber((channel) => mayInternalPageListen(internalPage, channel)),
    channels: {
      invoke: INTERNAL_PAGE_INVOKE_CHANNELS[internalPage],
      event: INTERNAL_PAGE_EVENT_CHANNELS[internalPage]
    }
  })
}

// Visited web pages fall through: no bridge at all (spec 6).

/**
 * Fingerprint masking (spec 4).
 *
 * ## Who gets masked
 *
 * Web content only. The chrome UI, the overlay surface and the `tessera://`
 * pages are the browser's own interface: masking them would fake values our own
 * code reads, for an audience of nobody — there is no site there to hide from.
 * Role first, then scheme, mirroring the two checks above.
 *
 * ## Why the work happens elsewhere
 *
 * The core builds the plan (it has the settings, the real user agent and the
 * per-session secret) and `shared/fingerprint/apply.ts` performs it. What is left
 * here is the part that can only happen here: asking for the plan *synchronously*,
 * because `document-start` is the last moment before page scripts run and an
 * awaited answer would arrive after them, then carrying each measure across the
 * context-isolation boundary into the page's own world.
 *
 * `executeInMainWorld` is the only route across that boundary. Patching a
 * prototype from here would patch the preload's isolated world, where no page can
 * see it — a masking that builds, runs, and protects nothing.
 *
 * Every step is guarded on its own. A measure that fails must cost only itself:
 * the page must still load, and the other measures must still apply.
 */
function installFingerprintMasking(): void {
  let answer: unknown
  try {
    answer = ipcRenderer.sendSync(FINGERPRINT_PLAN_CHANNEL, currentHost())
  } catch {
    // No responder — an old build, or a renderer created outside a hardened
    // session. Masking nothing is the only safe reading; guessing a plan would
    // apply measures the user may have switched off.
    return
  }
  if (!isMaskingPlan(answer)) return
  const plan = answer

  const apply = <T>(measure: (value: T) => void, value: T | null): void => {
    if (value === null) return
    try {
      // The function is serialised and re-compiled in the page's world, so it may
      // reference nothing from this file. See `shared/fingerprint/apply.ts`.
      contextBridge.executeInMainWorld({ func: measure, args: [value] })
    } catch (error) {
      console.warn('[fingerprint] a masking measure could not be installed:', error)
    }
  }

  // Identity first: it is the one a page is most likely to read in its first
  // statement, and the others do not depend on it.
  apply(maskUserAgent, plan.userAgent)
  apply(maskLocale, plan.locale)
  apply(maskTimeZone, plan.timeZone)
  apply(maskScreen, plan.screen)
  apply(maskDeviceApis, plan.devices)
  apply(maskFonts, plan.fonts)
  apply(maskCanvas, plan.canvas)
  apply(maskWebgl, plan.webgl)
  apply(maskAudio, plan.audio)
}

if (role === 'content' && internalPage === null) {
  installFingerprintMasking()
  /*
    The blocker's hiding rules.

    Only for visited pages, like the masking above: an internal page has nothing to filter, and a
    stylesheet injected into the settings screen by a downloaded list would be a list rearranging the
    browser's own interface.

    After the masking, deliberately. Masking has to happen before any page script observes anything;
    hiding is only ever visual, so it can afford to go second — and if a masking measure throws, it does
    so before this one has added a `<style>` element for a page that then failed to be protected.
  */
  installCosmeticFiltering()
  /*
    "Block this element myself."

    Installs two listeners and nothing else — the mode is entered by a message from the core, sent because
    the user chose it for this tab. Nothing is exposed on `window`, so a page can neither turn it on nor
    ask what a selector would match nor write a rule.
  */
  installElementPicker()
  /*
    Password autofill.

    Web pages only, and last of the three. It is the only one of them that can put a *secret* into a
    document, so it runs after masking has been installed rather than before: a page that failed to be
    protected must not be one that has already been offered a credential.

    Nothing is exposed on `window` here either. The suggestion list lives in a closed shadow root, a fill
    happens only after a trusted click on one of our own entries, and the core independently refuses any
    fill it did not see a real input event for — see `shared/passwords/fill-policy.ts`, which holds every
    rule and the attack each one prevents.
  */
  installAutofill()
}

export {}
