/**
 * Who is allowed to call what across the IPC boundary.
 *
 * Pure and Electron-free so it can be tested directly — this is a security
 * decision, and a security decision that is only exercised by hand is a security
 * decision nobody has checked.
 *
 * Two kinds of sender exist:
 *
 *   - the **chrome UI**, our own trusted window renderer, which may call
 *     everything — but only from its main frame, at the address the core
 *     loaded it from;
 *   - an **internal page** (`tessera://…`), our own code but rendered in a
 *     sandboxed content process, which may call only the narrow allowlist in
 *     `INTERNAL_INVOKE_CHANNELS`.
 *
 * Anything else — a visited web page — may call nothing at all (spec 6).
 */

import { isInternalPage, mayInternalPageInvoke } from '@shared/ipc/channels.js'
import { INTERNAL_SCHEME } from '@shared/product.js'
import type { InternalPage } from '@shared/ipc/channels.js'

/**
 * Re-exported under this file's own name because the sender policy is where callers look for
 * it, while `shared/product.ts` is where it is decided. One value, two vantage points.
 */
export const INTERNAL_PAGE_SCHEME = INTERNAL_SCHEME

export type SenderKind = 'chrome' | 'internal-page' | 'web-content'

export interface SenderDescription {
  /** URL of the frame that sent the message, if known. */
  frameUrl: string | null
  /** True when the sender is the window's own chrome renderer. */
  isChromeRenderer: boolean
  /**
   * True when the sending frame is its page's main frame. False for a subframe, and false when
   * there is no frame to ask — `senderFrame` is null once the frame has navigated or gone.
   */
  isMainFrame: boolean
}

/**
 * Where the chrome surfaces — the window's UI and its overlay layer — were loaded from.
 *
 * Handed in by the router rather than worked out here, so this file stays free of Electron and of
 * `__dirname`. Exactly one of the two applies: with a dev server, `BrowserWindowController` and
 * `OverlayLayer` load from it and the bundle is never loaded; without one, they `loadFile` the bundle.
 */
export interface ChromeAddresses {
  /** electron-vite's server in `pnpm dev`, as `devServerUrl` reads it; `null` everywhere else. */
  devServer: string | null
  /** The `file:` addresses of the bundled chrome documents, `index.html` and `overlay.html`. */
  bundle: readonly string[]
}

/**
 * Classifies a sender.
 *
 * The chrome check comes first and is identity-based (the caller matches the
 * sender against its own window list) rather than URL-based: in development the
 * chrome UI is served from an http dev server, and a URL rule that accepted that
 * on its own would accept any http page.
 *
 * Identity is necessary but no longer sufficient. The chrome webContents is trusted because of
 * what the core loaded into it, and the navigation guard in `BrowserWindowController` and
 * `OverlayLayer` keeps it there only for navigations the page starts — a load the core itself
 * starts never reaches that guard. So the identity counts only from the main frame, at the address
 * the controller loaded. Anything else with the chrome's identity is treated as what it then is:
 * content that has no business with IPC. It does not fall through to the internal-page rule
 * either; the chrome UI is never an internal page, whatever address it shows.
 */
export function classifySender(sender: SenderDescription, chrome: ChromeAddresses): SenderKind {
  if (sender.isChromeRenderer) {
    const atHome =
      sender.isMainFrame && sender.frameUrl !== null && isChromeAddress(sender.frameUrl, chrome)
    return atHome ? 'chrome' : 'web-content'
  }
  if (sender.frameUrl !== null && isInternalPageUrl(sender.frameUrl)) return 'internal-page'
  return 'web-content'
}

/**
 * Whether `frameUrl` is where the chrome surfaces were loaded from.
 *
 * With a dev server, any page of it counts — the window loads its root and the overlay
 * `/overlay.html` — and nothing else does, the bundle included, because in that mode the bundle is
 * not what the controller loaded. Without one, exactly the bundled chrome documents count.
 */
export function isChromeAddress(frameUrl: string, chrome: ChromeAddresses): boolean {
  if (chrome.devServer !== null) return isDevServerAddress(frameUrl, chrome.devServer)
  const document = bundledDocumentOf(frameUrl)
  return (
    document !== null && chrome.bundle.some((expected) => bundledDocumentOf(expected) === document)
  )
}

/**
 * Whether `url` is a page of the dev server, compared by origin.
 *
 * An opaque origin never matches. Every `file:` address has the origin "null", so comparing those
 * as strings would make a dev server named `file:///x` match every file on the disk.
 */
export function isDevServerAddress(url: string, devServer: string): boolean {
  const origin = webOriginOf(url)
  return origin !== null && origin === webOriginOf(devServer)
}

function webOriginOf(url: string): string | null {
  if (!URL.canParse(url)) return null
  const { origin } = new URL(url)
  return origin === 'null' ? null : origin
}

/**
 * A `file:` address reduced to the document it names, or `null` for anything else.
 *
 * The expected address is Node's (`pathToFileURL`) and the actual one Chromium's, and the two do
 * not percent-encode the same characters or keep a Windows drive letter in the same case. A
 * mismatch there would lock the browser out of its own interface over an apostrophe in a folder
 * name, so the path is decoded and the drive letter upper-cased before comparing. Query and
 * fragment are dropped: both can change without a navigation, so they say nothing about which
 * document is loaded. A path whose escapes do not decode is `null`, never a crash in a privilege
 * check.
 */
function bundledDocumentOf(url: string): string | null {
  if (!URL.canParse(url)) return null
  const parsed = new URL(url)
  if (parsed.protocol !== 'file:') return null
  let path: string
  try {
    path = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  const withDrive = path.replace(
    /^\/([a-z]):/i,
    (_match, drive: string) => `/${drive.toUpperCase()}:`
  )
  return `${parsed.host}${withDrive}`
}

export function isInternalPageUrl(url: string): boolean {
  // Parsed rather than prefix-matched: `tessera://x@evil.example` and
  // `https://evil.example/#tessera://` both defeat a naive startsWith check.
  try {
    return new URL(url).protocol === INTERNAL_PAGE_SCHEME
  } catch {
    return false
  }
}

/**
 * Which internal page a frame URL is, or null.
 *
 * Parsed rather than prefix-matched, for the same reason `isInternalPageUrl` is:
 * `tessera://x@evil.example` and `https://evil.example/#tessera://settings` both defeat a
 * `startsWith` check, and the second one would hand a visited site the settings channels.
 *
 * An empty host is the bare `tessera://` address, which the protocol handler serves as the
 * start page — the two have to agree or that address would load with no privileges.
 */
export function internalPageOf(url: string | null): InternalPage | null {
  if (url === null) return null
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== INTERNAL_SCHEME) return null
    const page = parsed.hostname === '' ? 'start' : parsed.hostname.toLowerCase()
    return isInternalPage(page) ? page : null
  } catch {
    return null
  }
}

export interface AccessDecision {
  allowed: boolean
  /** Why it was refused, for the thrown error and for tests. */
  reason: string | null
}

/**
 * Decides whether `channel` may be invoked by this sender.
 */
export function decideAccess(
  channel: string,
  sender: SenderDescription,
  chrome: ChromeAddresses
): AccessDecision {
  const kind = classifySender(sender, chrome)

  if (kind === 'chrome') return { allowed: true, reason: null }

  if (kind === 'internal-page') {
    /*
      Which page it is decides what it may do, and the page is read from the frame's own URL —
      the core's own view of where the sender is, not something the renderer told it.

      The preload makes the same decision when it builds the bridge. This one is the binding
      copy: a compromised renderer is exactly the case where the preload's answer cannot be
      trusted, so the core never relies on it.
    */
    const page = internalPageOf(sender.frameUrl)
    if (page === null) {
      return { allowed: false, reason: `unknown internal page may not call ${channel}` }
    }
    if (mayInternalPageInvoke(page, channel)) return { allowed: true, reason: null }
    return {
      allowed: false,
      reason: `internal page ${page} may not call ${channel}`
    }
  }

  if (sender.isChromeRenderer) {
    // Said separately, because "web content may not use IPC" from the chrome UI would send whoever
    // reads it looking for the wrong bug.
    const where = sender.frameUrl ?? 'no frame'
    return {
      allowed: false,
      reason: `the chrome UI may call ${channel} only from its own document in its main frame (sender: ${where})`
    }
  }

  return {
    allowed: false,
    reason: `web content may not use IPC (channel ${channel})`
  }
}
