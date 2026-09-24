import {
  subjectTopics,
  type PermissionSubject,
  type PermissionTopic
} from '@shared/overlay/permission.js'
import { topLevelOrigin, type PermissionDecision } from '../session/permission-policy.js'

/**
 * What a site was answered, as pure functions.
 *
 * The same division `@shared/history/model.ts` has with `HistoryStore`: the rules are here, the
 * clock and the disk are in the store. It sits under `main/` rather than `shared/` because no
 * renderer needs it — the overlay surface is told what to draw and reports one answer back; it
 * never reads the list.
 */

/** One remembered answer. */
export interface SitePermission {
  /** An origin, as `topLevelOrigin` produces: scheme, host and port, nothing else. */
  origin: string
  topic: PermissionTopic
  decision: 'allow' | 'deny'
  decidedAt: number
}

export interface PermissionDocument {
  version: 1
  sites: SitePermission[]
}

/**
 * How many answers are kept.
 *
 * A bound because the file is read at every launch and a page cannot be allowed to grow it
 * without limit — a site that asks about geolocation from a thousand subdomains would otherwise
 * write a thousand entries. Oldest go first, which is the right direction: an answer nobody has
 * exercised in a thousand sites' time is the one whose loss costs a single prompt.
 */
export const MAX_SITE_PERMISSIONS = 500

export function emptyPermissionDocument(): PermissionDocument {
  return { version: 1, sites: [] }
}

/** The stored answer for one atomic permission, or `null`. */
export function findSitePermission(
  sites: readonly SitePermission[],
  origin: string,
  topic: PermissionTopic
): SitePermission | null {
  return sites.find((site) => site.origin === origin && site.topic === topic) ?? null
}

/**
 * What a site was answered about a whole subject.
 *
 * `ask` means "not remembered", so the answer is total and the caller has no `null` to confuse
 * with a remembered refusal.
 *
 * The strictest answer wins across the topics a subject covers, exactly as
 * `decideMediaPermission` does across two settings: a site allowed the camera but never asked
 * about the microphone must still be asked before `getUserMedia({video, audio})` succeeds.
 * Anything else would hand over a microphone on the strength of consent to a camera.
 */
export function recallSiteDecision(
  sites: readonly SitePermission[],
  origin: string,
  subject: PermissionSubject
): PermissionDecision {
  const decisions = subjectTopics(subject).map((topic) => findSitePermission(sites, origin, topic))
  if (decisions.some((found) => found?.decision === 'deny')) return 'deny'
  if (decisions.some((found) => found === null)) return 'ask'
  return 'allow'
}

/**
 * Records an answer, replacing whatever this site was told before.
 *
 * Newest first, so `repairSitePermissions` and the cap agree on which end is old without either
 * of them sorting. A second answer for the same site and topic replaces the first rather than
 * joining it: two decisions for one question is a state nothing can resolve, and the read path
 * would silently pick whichever came first in the file.
 */
export function putSitePermission(
  sites: readonly SitePermission[],
  entry: SitePermission,
  maxEntries: number = MAX_SITE_PERMISSIONS
): SitePermission[] {
  const rest = sites.filter((site) => !(site.origin === entry.origin && site.topic === entry.topic))
  return [entry, ...rest].slice(0, Math.max(1, maxEntries))
}

/**
 * What this site was told, gone: every answer, or only the named topics.
 *
 * The topics are what the site menu passes (U19). It lists everything except camera, microphone and
 * screen sharing, whose behaviour stays exactly as it is, so its "forget all" has to be able to leave
 * those answers standing — forgetting the whole origin would quietly change them.
 */
export function forgetOrigin(
  sites: readonly SitePermission[],
  origin: string,
  topics?: readonly PermissionTopic[]
): SitePermission[] {
  const kept = sites.filter(
    (site) => site.origin !== origin || (topics !== undefined && !topics.includes(site.topic))
  )
  // The same array when nothing was removed, so a caller can tell a forget that changed nothing.
  return kept.length === sites.length ? (sites as SitePermission[]) : kept
}

/**
 * Heals a file rather than rejecting it.
 *
 * The line is the same one `HistoryStore` draws: wrong *kinds* of data are the schema's problem,
 * wrong *amounts* are healed here. Discarding the document over a duplicate would throw away every
 * answer the user has given because one of them was written twice — and duplicates are precisely
 * what an older build, a hand edit or a crash mid-write leaves behind.
 *
 * Newest wins on a duplicate, and the list comes out newest-first so the cap trims the oldest.
 */
export function repairSitePermissions(
  sites: readonly SitePermission[],
  maxEntries: number = MAX_SITE_PERMISSIONS
): SitePermission[] {
  const seen = new Set<string>()
  const kept: SitePermission[] = []
  for (const site of [...sites].sort((a, b) => b.decidedAt - a.decidedAt)) {
    if (site.origin === '') continue
    const key = `${site.origin}\u0000${site.topic}`
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(site)
  }
  return kept.slice(0, Math.max(1, maxEntries))
}

/**
 * The only way to read or write a site's answers, and it cannot be obtained without saying which
 * kind of session it is for. See `PermissionStore.rulesFor`.
 */
export interface SitePermissionRules {
  recall(origin: string, subject: PermissionSubject): PermissionDecision
  remember(origin: string, subject: PermissionSubject, decision: 'allow' | 'deny'): void
}

/**
 * What a private window gets: no memory in either direction.
 *
 * It holds no store, no path and no file, so "a private window leaves nothing behind" is a
 * property of what the window physically has rather than a check somebody has to remember at every
 * call site — the same guarantee `discardingHistoryRecorder` and `discardingFaviconCache` give.
 *
 * Reading is behind the same seam as writing here, which is a departure from those two. It has to
 * be: a persistent "allow the camera" carried into a private window would hand a site the camera
 * with no prompt, on the strength of a decision made in the mode whose entire purpose is not being
 * the same visitor. So a private window is asked every time, and answers nothing forward.
 */
export const forgetfulSitePermissions: SitePermissionRules = {
  recall: () => 'ask',
  // Deliberately empty: a private window's answer exists for the life of the prompt.
  remember: () => {}
}

/**
 * The stored answers as a site's own menu sees them: read, and forget.
 *
 * Behind the same mode seam as `SitePermissionRules`, and for the same reason: a private window holds
 * `forgetfulSiteAnswers`, which has no path to the store, so it can neither show the normal profile's
 * answers nor forget one of them. See `PermissionStore.answersFor`.
 */
export interface SiteAnswers {
  list(): SitePermission[]
  /** Number of answers removed. */
  forget(origin: string, topics?: readonly PermissionTopic[]): number
}

/** What a private window gets: nothing stored to show, and nothing to forget. */
export const forgetfulSiteAnswers: SiteAnswers = {
  list: () => [],
  forget: () => 0
}

// --- which tab a question belongs to -------------------------------------------

/**
 * Where a queued question came from: the tab that asked, and the site the dialogue names.
 *
 * The tab is kept as its `webContents` id rather than as an object, the way `ObservedRequest` keeps
 * it, so nothing here holds a view alive and the rules below stay free of Electron.
 */
export interface PromptSource {
  readonly webContentsId: number
  readonly origin: string
}

/**
 * What a window reports about its tabs, as far as a waiting question cares.
 *
 * `activated` — the tab in front may have changed. It carries nothing, because which tab is in front
 *   is asked of the window at the moment a dialogue would appear, never remembered from an event.
 * `navigated` — a tab committed a new main-frame document; `url` is its address.
 * `closed` — a tab is gone from the window.
 * `gone` — the window itself is gone, and with it every tab and the layer a dialogue appears in.
 */
export type PermissionTabChange =
  | { readonly kind: 'activated' }
  | { readonly kind: 'navigated'; readonly webContentsId: number; readonly url: string }
  | { readonly kind: 'closed'; readonly webContentsId: number }
  | { readonly kind: 'gone' }

/**
 * The question to put on screen: the oldest one from the tab in front, or `null`.
 *
 * Only that tab. A question from a background tab names a site the user is not looking at, and a
 * dialogue over the visible page is answered for the visible page — so "allow example.com?" over a
 * tab showing something else would collect consent from the wrong context. It waits instead, in its
 * place in the queue, and comes up when its tab does.
 */
export function promptForActiveTab<T extends PromptSource>(
  queue: readonly T[],
  activeWebContentsId: number | null
): T | null {
  if (activeWebContentsId === null) return null
  return queue.find((prompt) => prompt.webContentsId === activeWebContentsId) ?? null
}

/**
 * Whether a change leaves nobody who could answer a question — which then refuses once and is
 * remembered nowhere, like every other way a prompt ends unanswered.
 *
 * Only a *site* change of the tab ends it, not every navigation. The question was put for an origin,
 * and the answer is filed under that origin, so a page moving within its own site is still the site
 * the dialogue names. A move to another site — or to a document with no origin at all, `about:blank`
 * or an address that does not parse — would leave the dialogue asking about a page that is no longer
 * there, answered by somebody looking at a different one.
 *
 * `activated` never ends anything: a tab going to the background has its question put back, not
 * refused. See `PermissionArbiter`.
 */
export function endsPrompt(source: PromptSource, change: PermissionTabChange): boolean {
  if (change.kind === 'gone') return true
  if (change.kind === 'activated') return false
  if (change.webContentsId !== source.webContentsId) return false
  if (change.kind === 'closed') return true
  return topLevelOrigin({ frame: change.url, topLevel: null }) !== source.origin
}
