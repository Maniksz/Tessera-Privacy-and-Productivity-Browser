import { contextBridge, ipcRenderer } from 'electron'
import {
  INTERNAL_PAGE_EVENT_CHANNELS,
  INTERNAL_PAGE_INVOKE_CHANNELS,
  isInternalPage,
  mayInternalPageInvoke,
  mayInternalPageListen,
  type InternalPage
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
import { makeInvoker, makeSubscriber, markPreloadRan, type Role } from './bridge.js'
import { installCosmeticFiltering } from './cosmetic.js'
import { installElementPicker } from './picker.js'
import { installAutofill } from './autofill.js'
import { installZoomGesture } from './zoom.js'
import { installPageZoom } from './page-zoom.js'

/**
 * The preload for tab views: everything a *document* gets, and nothing the browser's own interface
 * needs.
 *
 * Loaded by `Tab.ts` through `preloadFile('content')`, which resolves to this bundle — `index.cjs`,
 * the default name, deliberately: whatever goes wrong with a preload path, the file that answers to
 * the obvious name is the one with the fewest privileges in it. The chrome bridge lives in
 * `chrome.ts` and is a different file on disk.
 *
 * ## Why two files rather than one file with a role branch
 *
 * This used to be one bundle that decided at startup whether to expose the chrome bridge, and every
 * visited page parsed the bridge it could never be given — about two kilobytes of channel tables per
 * page in every tab, and worse than the bytes: the code that hands out the full contract surface was
 * *present* in the renderer a hostile page runs in, one mistaken condition away from being reachable.
 *
 * Two files close that off in a way a branch cannot. There is no `exposeInMainWorld('tessera', …)`
 * in this bundle to reach, so however the role is spoofed — a crafted command line, a compromised
 * renderer, a future refactor that gets a condition backwards — the chrome bridge cannot appear in a
 * web page from here. The absent code is the guarantee; a branch is only a promise.
 *
 * ## What the role argument is still for
 *
 * Not for dispatch any more — the file *is* the role. It is read to cross-check the two against each
 * other: a view created with the chrome role but given this file is a wiring mistake, and it says so
 * rather than quietly serving a renderer with no bridge and no explanation. The command line is the
 * one input page content cannot alter, which is what makes it usable for that.
 *
 * ## Two gates, not one
 *
 * This file decides what to *expose*. The main process independently decides what to *accept*, in
 * `main/ipc/sender-policy.ts`. A compromised renderer is exactly the case where this file's
 * judgement cannot be relied on, so the core never relies on it (spec 6).
 *
 * ## Why an internal page's bridge is in *this* bundle
 *
 * Because a `tessera://` page is a tab. One `WebContentsView` shows the start page, then the site the
 * user typed into it, and a view's preload is fixed when it is created — so the file that serves
 * visited pages is the same file that has to serve our own. Putting the internal allowlist in the
 * chrome bundle instead would mean either every internal page loses its bridge, or a tab that started
 * on `tessera://start` loses its masking and blocking for every site it visits afterwards.
 */

const ROLE_PREFIX = '--tessera-role='
const INTERNAL_SCHEME = 'tessera:'

/**
 * The role the *view* was created with, for comparison with the role of this *file*.
 *
 * Spelled out here rather than imported, and duplicated in `chrome.ts` on purpose: "what does this
 * bundle do when the role disagrees with it" is the security-critical sentence about an entry, and it
 * belongs in the entry rather than an import away. `tests/preload-roles.test.ts` holds the two copies
 * to the same rule so the duplication cannot drift.
 */
function readRole(): Role {
  const argument = process.argv.find((value) => value.startsWith(ROLE_PREFIX))
  const role = argument?.slice(ROLE_PREFIX.length)
  // Least privilege by default: an unrecognised or absent role is content.
  return role === 'chrome' ? 'chrome' : 'content'
}

function internalPageName(): InternalPage | null {
  try {
    // Narrowed to the two fields actually read, and both optional: the DOM types promise a
    // `location` that always exists, and a preload runs early enough — and in torn-down frames
    // often enough — that reading one must be allowed to come back empty instead of throwing.
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

markPreloadRan('content')

const role = readRole()
/** Resolved once: the page cannot change its own address without a reload. */
const internalPage = internalPageName()

if (role === 'chrome') {
  /*
    A view created for the browser's own interface, holding the preload for documents.

    Nothing is exposed — least privilege when the two disagree — and the mistake is reported, because
    the symptom on the other side is `window.tessera` being undefined with nothing to say why. See
    `preloadFile()` in `src/main/paths.ts`.
  */
  console.error(
    '[preload] the content preload was loaded into a chrome-role view; no bridge was exposed'
  )
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
 * Web content only. The `tessera://` pages are the browser's own interface: masking them would fake
 * values our own code reads, for an audience of nobody — there is no site there to hide from. The
 * chrome UI and the overlay surface never load this bundle at all, which is the other half of the
 * same rule and is now enforced by which file they are given.
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

if (role === 'content') {
  /*
    The zoom gesture, above the internal-page line and therefore for *every* tab view.

    The three below are about defending the user from a site, so a `tessera://` page is exempt from
    all of them. This one is not a defence, it is an input device: the settings screen, the history
    list and the start page are zoomed with the same fingers as everything else, and a browser whose
    own pages ignored the trackpad would look broken rather than principled.

    First, and cheaply — one listener, no message until something is actually zoomed.
  */
  installZoomGesture()
  /*
    And the zoom itself, which is now this side's job too.

    Above the internal-page line for the same reason the gesture is: the settings screen and the start
    page are zoomed with the same fingers as everything else. It has to run before the masking and the
    filtering below rather than after, because it is the only one of them with a *paint* deadline —
    the page is about to be drawn, and drawing it at the wrong size and then correcting is the flash
    this whole ordering exists to avoid.
  */
  installPageZoom()
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
