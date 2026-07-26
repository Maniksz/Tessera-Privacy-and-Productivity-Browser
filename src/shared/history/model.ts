import { registrableDomain, registrableDomainOfUrl } from '../url/domain.js'
import { cleanUrl } from '../url/tracking-params.js'

/**
 * Browsing history — what `tessera://history` lists and what the address bar
 * offers when `search.suggestFromHistory` is on.
 *
 * ## Why this file has no zod import
 *
 * The history page is a renderer, so every value import here lands in a bundle the
 * user waits for. Pulling a validation library into that bundle cost roughly half a
 * megabyte of startup parse work once already, and an architecture test now keeps it
 * out. The persistence schema therefore lives with the store in the main process
 * (`src/main/data/HistoryStore.ts`), not next to these functions. See
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * ## Why one entry per address instead of one per visit
 *
 * A visit log would grow one row per reload — a page refreshed forty times while
 * debugging would occupy forty rows and, worse, produce forty identical address-bar
 * suggestions. Suggestions are the primary consumer, and duplicates there are the
 * worst possible outcome, so a repeat visit advances the existing entry instead:
 * `visitCount` goes up, `lastVisitedAt` moves, `firstVisitedAt` stays.
 *
 * What that costs, stated plainly rather than discovered later: the timeline is
 * coarse. A page visited on Monday and again on Friday appears only under Friday,
 * because only the most recent visit has a timestamp. A separate visits table (the
 * shape Chromium uses) would keep both, at the price of a second collection, a join
 * on every query, and a file that grows with reloads rather than with distinct
 * pages. When per-visit timestamps are actually needed, that is the change to make —
 * and `firstVisitedAt` is deliberately kept so a migration has something to seed the
 * first row from.
 *
 * ## Why every operation is pure
 *
 * The rules — which addresses are recorded at all, how a repeat visit merges, what
 * gets pruned when the cap is hit — exist once here rather than spread across a
 * store, an IPC handler and a page. The store supplies the clock and writes the
 * result down; nothing else.
 */

/**
 * Entries kept at most, oldest visits dropped first.
 *
 * With one entry per address, ten thousand distinct addresses is well past a year of
 * ordinary browsing, so the cap is generous for the user and still bounds the file:
 * at roughly 150 bytes per entry the document is about 1.5 MB full. That number
 * matters more than it looks, because the store rewrites the *whole* document on
 * every flush and decrypts it in one piece at startup — the cap is a write-cost and
 * startup-cost limit, not a disk-space one. Ten times as many entries would mean
 * rewriting fifteen megabytes while the user is still typing.
 */
export const MAX_HISTORY_ENTRIES = 10_000

/**
 * Titles are cut here. Long enough for any real page title, short enough that a
 * page which sets a novel as its title cannot inflate the document.
 */
export const MAX_HISTORY_TITLE_LENGTH = 200

/**
 * Addresses longer than this are not recorded at all.
 *
 * Truncating is not an option — a cut URL is an address that no longer resolves, so
 * the entry would be unusable in both the page and the suggestions. Skipping is the
 * honest failure, and 2048 is the length beyond which servers and other browsers
 * stop agreeing anyway.
 */
export const MAX_HISTORY_URL_LENGTH = 2048

/**
 * Schemes worth remembering.
 *
 * `tessera:` is left out deliberately: the browser's own pages are reachable from
 * the menu, and an entry for "History" inside the history is noise. Everything else
 * a tab can hold — `about:blank`, `data:`, `blob:`, `javascript:` — is either not a
 * place or not one the user could navigate back to.
 */
export const RECORDABLE_HISTORY_SCHEMES: readonly string[] = ['http:', 'https:', 'file:']

export interface HistoryVisit {
  /** Normalised by `historyUrlOf`, and the identity of the entry. */
  url: string
  /** Empty until the page reports one; the UI falls back to the address. */
  title: string
  firstVisitedAt: number
  lastVisitedAt: number
  /** At least 1. Counts visits, not entries. */
  visitCount: number
}

export interface HistoryDocument {
  version: 1
  /** Most recently visited first. Storage order is the only record of recency. */
  visits: HistoryVisit[]
}

export function emptyHistoryDocument(): HistoryDocument {
  return { version: 1, visits: [] }
}

export interface VisitInput {
  /** Raw address as navigated; normalised here. */
  url: string
  /** Omitted when the page has not reported a title yet. */
  title?: string
}

export interface TitleInput {
  url: string
  title: string
}

export interface RecordContext {
  now: number
}

/**
 * The write side of history, and the only one a caller ever gets handed.
 *
 * A private window is given `discardingHistoryRecorder` instead of a recorder bound
 * to the store, so "record nothing in private mode" is a property of what the window
 * holds rather than a check every call site has to remember. See
 * `HistoryStore.recorderFor`.
 */
export interface HistoryRecorder {
  recordVisit(input: VisitInput): void
  /**
   * Fills in a title that arrived after the visit.
   *
   * Chromium reports navigation and title separately, so at `did-navigate` time the
   * title is usually still the old page's or empty. Without this, most entries would
   * have no title and searching by title would find almost nothing.
   */
  noteTitle(input: TitleInput): void
}

/**
 * A recorder that keeps nothing, for private windows.
 *
 * It holds no reference to any store, which is the point: forgetting to check
 * `privateMode` cannot leak a visit, because there is nothing here to leak it into.
 */
export const discardingHistoryRecorder: HistoryRecorder = {
  recordVisit: (_input: VisitInput) => {},
  noteTitle: (_input: TitleInput) => {}
}

// --- normalisation -----------------------------------------------------------

/**
 * The address history stores for a navigation, or `null` when it stores none.
 *
 * Three things happen here, each for its own reason:
 *
 *   - Unrecordable schemes and unparseable input are refused, so the collection only
 *     ever holds addresses a user can return to.
 *   - The fragment is dropped. A fragment addresses a position inside a document, not
 *     a document: keeping it would list one entry per anchor, each with the same
 *     title, and split one page's visit count across them. The accepted cost is that
 *     a hash-routed application (`/#/inbox`) collapses to a single entry.
 *   - Tracking parameters are stripped with the same rule the network layer uses, so
 *     the same page arrived at through two campaign links is one entry rather than
 *     two, and history does not become the place those identifiers survive.
 */
export function historyUrlOf(rawUrl: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    return null
  }

  if (!RECORDABLE_HISTORY_SCHEMES.includes(parsed.protocol)) return null

  parsed.hash = ''
  const cleaned = cleanUrl(parsed.toString())
  if (cleaned.length > MAX_HISTORY_URL_LENGTH) return null
  return cleaned
}

/**
 * Titles arrive from pages, so they arrive with newlines, tabs and padding in them.
 * Both consumers show a single line, so the whitespace is collapsed once here rather
 * than in every view.
 */
function cleanHistoryTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_HISTORY_TITLE_LENGTH)
}

// --- writes ------------------------------------------------------------------

/**
 * Records a visit, advancing an existing entry for the same address.
 *
 * `now` comes from the caller so this stays pure and a test does not have to freeze
 * the clock. An address the history does not keep yields the list unchanged rather
 * than an error: a navigation to `about:blank` is normal, not a fault.
 */
export function recordVisit(
  visits: readonly HistoryVisit[],
  input: VisitInput,
  context: RecordContext
): HistoryVisit[] {
  const url = historyUrlOf(input.url)
  if (url === null) return [...visits]

  const title = cleanHistoryTitle(input.title ?? '')
  const existing = visits.find((visit) => visit.url === url)

  const entry: HistoryVisit =
    existing === undefined
      ? { url, title, firstVisitedAt: context.now, lastVisitedAt: context.now, visitCount: 1 }
      : {
          url,
          // An empty title means "not reported yet", never "the page has no title",
          // so the one already known wins over nothing.
          title: title === '' ? existing.title : title,
          firstVisitedAt: existing.firstVisitedAt,
          lastVisitedAt: context.now,
          visitCount: existing.visitCount + 1
        }

  const others = visits.filter((visit) => visit.url !== url)
  return pruneToLimit(insertByRecency(others, entry))
}

/**
 * Sets the title of an existing entry, without counting a visit.
 *
 * An empty title is ignored rather than stored: a page that briefly reports no title
 * during load would otherwise erase the one the entry already had.
 */
export function noteTitle(visits: readonly HistoryVisit[], input: TitleInput): HistoryVisit[] {
  const url = historyUrlOf(input.url)
  const title = cleanHistoryTitle(input.title)
  if (url === null || title === '') return [...visits]
  return visits.map((visit) => (visit.url === url ? { ...visit, title } : visit))
}

/**
 * Places an entry so the list stays most-recent-first.
 *
 * The position is searched for rather than assumed to be the front, because the clock
 * can go backwards — an NTP correction or a suspended laptop is enough. Trusting the
 * front would then put an older visit at the top, and pruning, which drops from the
 * end, would delete the wrong entry.
 */
function insertByRecency(visits: readonly HistoryVisit[], entry: HistoryVisit): HistoryVisit[] {
  const at = visits.findIndex((visit) => visit.lastVisitedAt < entry.lastVisitedAt)
  const next = [...visits]
  next.splice(at === -1 ? next.length : at, 0, entry)
  return next
}

/**
 * Enforces the cap by dropping the least recently visited entries.
 *
 * `slice` needs no length check: a shorter list comes back whole, which is one branch
 * that cannot be got wrong. Called on the write path only — pruning while reading
 * would hide entries that the next write brings back, so the same query would answer
 * differently depending on whether a navigation happened in between.
 */
function pruneToLimit(visits: readonly HistoryVisit[]): HistoryVisit[] {
  return visits.slice(0, MAX_HISTORY_ENTRIES)
}

// --- reads -------------------------------------------------------------------

export interface HistoryQuery {
  /** Case-insensitive fragment, matched against address and title. */
  text?: string
  /** Inclusive bounds on the most recent visit. Open-ended when omitted. */
  from?: number
  to?: number
  /** Most recent `limit` matches. All of them when omitted. */
  limit?: number
}

function byRecency(left: HistoryVisit, right: HistoryVisit): number {
  return right.lastVisitedAt - left.lastVisitedAt
}

/**
 * Matching entries, most recent first.
 *
 * Sorted here rather than relying on storage order, so a caller holding a list from
 * anywhere — a hand-edited file, a future paged read — gets the same answer. Ten
 * thousand entries sort in well under a millisecond, and a query happens when a
 * person asks, not on every navigation.
 *
 * The time bounds are compared against `lastVisitedAt`, the same field the range
 * deletion uses. That agreement is the point: a user who sees an entry listed under
 * "today" and then clears today's history expects it gone, and two different rules
 * here would leave it behind.
 */
export function queryHistory(visits: readonly HistoryVisit[], query: HistoryQuery): HistoryVisit[] {
  const needle = (query.text ?? '').trim().toLowerCase()
  const from = query.from ?? Number.NEGATIVE_INFINITY
  const to = query.to ?? Number.POSITIVE_INFINITY

  const matches = visits
    .filter((visit) => visit.lastVisitedAt >= from && visit.lastVisitedAt <= to)
    .filter(
      (visit) =>
        needle === '' ||
        visit.url.toLowerCase().includes(needle) ||
        visit.title.toLowerCase().includes(needle)
    )
    .sort(byRecency)

  const limit = query.limit === undefined ? matches.length : Math.max(0, Math.trunc(query.limit))
  return matches.slice(0, limit)
}

// --- deletions ---------------------------------------------------------------

/**
 * Removes one entry.
 *
 * The address is normalised first, so "forget this page" works when handed the live
 * tab's URL — fragment, campaign parameters and all — and not only the exact string
 * that happened to be stored.
 */
export function removeVisit(visits: readonly HistoryVisit[], url: string): HistoryVisit[] {
  const target = historyUrlOf(url)
  if (target === null) return [...visits]
  return visits.filter((visit) => visit.url !== target)
}

/**
 * Removes everything belonging to a site.
 *
 * Takes a URL or a bare domain, because both callers exist: the page's "forget this
 * site" has an entry in hand, a settings field has text typed by a person. Matching
 * is on the registrable domain, so clearing `example.com` also clears `www.` and
 * `blog.` — a per-host rule would leave the user believing the site was gone while
 * half of it stayed.
 *
 * `file:` entries have no host and are therefore never caught by this; they go
 * individually, by range, or with everything.
 */
export function removeDomain(visits: readonly HistoryVisit[], domainOrUrl: string): HistoryVisit[] {
  const target = registrableDomainOfUrl(domainOrUrl) ?? registrableDomain(domainOrUrl)
  if (target === '') return [...visits]
  return visits.filter((visit) => registrableDomainOfUrl(visit.url) !== target)
}

/**
 * Removes entries whose most recent visit falls within `[from, to]`.
 *
 * An entry first visited before the range and last visited inside it goes entirely.
 * That over-deletes by design: the user asked for a window of their history to be
 * gone, and leaving something behind because it was *also* visited earlier is a
 * privacy failure, where deleting a little more is an inconvenience.
 */
export function removeRange(
  visits: readonly HistoryVisit[],
  from: number,
  to: number
): HistoryVisit[] {
  return visits.filter((visit) => visit.lastVisitedAt < from || visit.lastVisitedAt > to)
}

// --- repair ------------------------------------------------------------------

function mergeVisits(left: HistoryVisit, right: HistoryVisit): HistoryVisit {
  return {
    url: left.url,
    title: left.title === '' ? right.title : left.title,
    firstVisitedAt: Math.min(left.firstVisitedAt, right.firstVisitedAt),
    lastVisitedAt: Math.max(left.lastVisitedAt, right.lastVisitedAt),
    visitCount: left.visitCount + right.visitCount
  }
}

/**
 * Makes a loaded document obey the invariants the write path maintains: one entry per
 * address, most recent first, no more than the cap.
 *
 * Duplicates are merged rather than dropped, so a partially written or hand-edited
 * file loses no visit count. Over-long files are pruned here instead of being
 * rejected by the schema — a document that fails validation is replaced by an empty
 * one, and losing a user's whole history because it grew past a number we chose would
 * be the worst possible reading of "too many entries".
 *
 * Deliberately *not* done here: re-checking each address against
 * `RECORDABLE_HISTORY_SCHEMES`. Narrowing that list later would then silently delete
 * every affected entry on the next start, which is a data-loss trap disguised as a
 * cleanup.
 */
export function repairHistory(visits: readonly HistoryVisit[]): HistoryVisit[] {
  const byUrl = new Map<string, HistoryVisit>()
  for (const visit of visits) {
    const existing = byUrl.get(visit.url)
    byUrl.set(visit.url, existing === undefined ? visit : mergeVisits(existing, visit))
  }
  return pruneToLimit([...byUrl.values()].sort(byRecency))
}
