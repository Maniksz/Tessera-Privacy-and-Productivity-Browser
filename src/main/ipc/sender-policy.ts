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
 *     everything;
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
}

/**
 * Classifies a sender.
 *
 * The chrome check comes first and is identity-based (the caller matches the
 * sender against its own window list) rather than URL-based: in development the
 * chrome UI is served from an http dev server, and a URL rule that accepted that
 * would accept any http page.
 */
export function classifySender(sender: SenderDescription): SenderKind {
  if (sender.isChromeRenderer) return 'chrome'
  if (sender.frameUrl !== null && isInternalPageUrl(sender.frameUrl)) return 'internal-page'
  return 'web-content'
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
export function decideAccess(channel: string, sender: SenderDescription): AccessDecision {
  const kind = classifySender(sender)

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

  return {
    allowed: false,
    reason: `web content may not use IPC (channel ${channel})`
  }
}
