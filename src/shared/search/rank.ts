import { historyUrlOf } from '../history/model.js'

/**
 * The local ranker behind address-bar suggestions (R28) and the tab search (R31), KTD11.
 *
 * ## Why it is pure and has no zod import
 *
 * The renderer calls this on every keystroke, so every value import here lands in a bundle the user
 * waits for. A validation library in that bundle cost half a megabyte of parse work once already
 * (`docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`). The only import is
 * the history normalizer, which is zod-free for the same reason. The clock is a parameter, so the same
 * input always gives the same rows. And nothing here reaches the network — R28 promises that nothing
 * typed into the address bar leaves the device, and a fitness test holds this module to it.
 *
 * ## How rows are ordered
 *
 * Match class first, weight second, and only then the tie-breaks:
 *
 *   1. **Match class.** The address starts with the text (ignoring scheme and a leading `www.`),
 *      then a word in a title starts with it, then it occurs anywhere in address or title. A class
 *      is never overtaken by weight: someone typing `git` wants `github.com`, however often they read
 *      a blog post titled "Learning git".
 *   2. **Weight**, frecency-style after Firefox. Each visit counts once and halves in value every
 *      {@link HALF_LIFE_DAYS} days, so a page read five times yesterday comes before one read fifty
 *      times last quarter. A bookmark or quick link adds a fixed amount even without a single visit —
 *      the user chose it, which history cannot know. An open tab adds more, because switching to it
 *      is almost always what the user wants over opening the page a second time.
 *   3. **Tie-breaks**: the shorter address (`github.com` before `github.com/features`), then plain
 *      code-unit order of the address. Neither depends on the order candidates arrive in.
 *
 * ## How duplicates merge
 *
 * One pass, keyed by the address history would store (`historyUrlOf`: no fragment, no tracking
 * parameters), so a page that is in history, bookmarked and open in a tab is one row. The row takes
 * source, title, address and tab id from its strongest member (tab, then bookmark, then quick link,
 * then history; the earlier candidate on a tie). Its class is the best any member reaches, so a
 * bookmark whose own title does not match still shows when its history title does. Its visits are
 * those of the most-visited member rather than a sum: the same page listed twice has not been
 * visited twice as often.
 */

/** Where a candidate comes from. */
export type SuggestionSource = 'history' | 'bookmark' | 'quicklink' | 'tab'

/** One entry offered to the ranker. Visit data is optional: only history usually has it. */
export interface RankCandidate {
  source: SuggestionSource
  title: string
  url: string
  visitCount?: number
  /** Milliseconds since the epoch, the same clock as `now`. */
  lastVisitedAt?: number
  /** Set for `source: 'tab'`, and carried to the row so selecting it can switch to the tab. */
  tabId?: string
}

/** Why a row matched: the address starts with the text, a title word does, or either contains it. */
export type MatchKind = 'prefix' | 'word' | 'substring'

/** One suggestion, in the order the ranker returns them. */
export interface RankedRow {
  source: SuggestionSource
  title: string
  url: string
  /** Present only when the row's strongest source is an open tab. */
  tabId?: string
  match: MatchKind
}

/** Rows returned at most. A dropdown longer than this is scrolled past, not read. */
export const MAX_RANKED_ROWS = 8

/** Days after which a visit counts half. Short enough that last quarter's habit yields to last week's. */
export const HALF_LIFE_DAYS = 14

/** What a bookmark or quick link is worth with no visit behind it: ten visits today. */
const CURATED_WEIGHT = 10

/** What an open tab adds on top: more than a bookmark, so the tab wins a tie with it. */
const OPEN_TAB_WEIGHT = 20

const DAY_MS = 86_400_000

/** Higher is stronger: the source a merged row is shown as. */
const SOURCE_STRENGTH: Record<SuggestionSource, number> = {
  history: 0,
  quicklink: 1,
  bookmark: 2,
  tab: 3
}

const MATCH_STRENGTH: Record<MatchKind, number> = { substring: 0, word: 1, prefix: 2 }

/** A letter or digit in any script: what continues a word rather than starting one. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u

/** Ranks `candidates` against the typed `text`; at most {@link MAX_RANKED_ROWS} rows, best first. */
export function rankCandidates(
  candidates: readonly RankCandidate[],
  text: string,
  now: number
): RankedRow[] {
  const query = text.trim().toLowerCase()
  if (query === '') return []
  const bareQuery = bareAddressOf(query)

  const groups = new Map<string, RankCandidate[]>()
  for (const candidate of candidates) {
    const key = historyUrlOf(candidate.url) ?? candidate.url
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [candidate])
    else group.push(candidate)
  }

  const scored: { row: RankedRow; weight: number; bare: string }[] = []
  for (const members of groups.values()) {
    let match: MatchKind | null = null
    for (const member of members) {
      const found = matchOf(member, query, bareQuery)
      if (found !== null && (match === null || MATCH_STRENGTH[found] > MATCH_STRENGTH[match])) {
        match = found
      }
    }
    if (match === null) continue

    const strongest = members.reduce((best, member) =>
      SOURCE_STRENGTH[member.source] > SOURCE_STRENGTH[best.source] ? member : best
    )
    const row: RankedRow = {
      source: strongest.source,
      title: strongest.title,
      url: strongest.url,
      match
    }
    if (strongest.tabId !== undefined) row.tabId = strongest.tabId

    scored.push({
      row,
      weight: weightOf(members, now),
      bare: bareAddressOf(strongest.url.toLowerCase())
    })
  }

  scored.sort(
    (a, b) =>
      MATCH_STRENGTH[b.row.match] - MATCH_STRENGTH[a.row.match] ||
      b.weight - a.weight ||
      a.bare.length - b.bare.length ||
      compareCodeUnits(a.row.url, b.row.url)
  )
  return scored.slice(0, MAX_RANKED_ROWS).map((entry) => entry.row)
}

/**
 * The best class `candidate` matches `query` in, or `null`.
 *
 * `bareQuery` is the query without scheme and `www.`, compared against the address stripped the same
 * way; it may be empty (the user typed only `https://`), and an empty needle must not match every
 * address.
 */
function matchOf(candidate: RankCandidate, query: string, bareQuery: string): MatchKind | null {
  const address = bareAddressOf(candidate.url.toLowerCase())
  const title = candidate.title.toLowerCase()
  if (bareQuery !== '' && address.startsWith(bareQuery)) return 'prefix'
  if (startsWord(title, query)) return 'word'
  if ((bareQuery !== '' && address.includes(bareQuery)) || title.includes(query)) return 'substring'
  return null
}

/**
 * A lowercased address without its `scheme://` and a leading `www.`.
 *
 * Only a scheme followed by `//` is removed, so `localhost:3000` keeps its host rather than losing it
 * as if `localhost:` were a scheme; `about:blank` stays whole for the same reason.
 */
function bareAddressOf(lowercased: string): string {
  return lowercased.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^www\./, '')
}

/**
 * Whether `needle` occurs in `haystack` at the start of a word. The start of the string needs no case
 * of its own: `charAt(-1)` is the empty string, which is no word character.
 */
function startsWord(haystack: string, needle: string): boolean {
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    if (!WORD_CHARACTER.test(haystack.charAt(at - 1))) return true
    at = haystack.indexOf(needle, at + 1)
  }
  return false
}

/** The frecency-style weight of one merged row. */
function weightOf(members: readonly RankCandidate[], now: number): number {
  let visits = 0
  let curated = false
  let open = false
  for (const member of members) {
    visits = Math.max(visits, visitWeightOf(member, now))
    if (member.source === 'bookmark' || member.source === 'quicklink') curated = true
    if (member.source === 'tab') open = true
  }
  return visits + (curated ? CURATED_WEIGHT : 0) + (open ? OPEN_TAB_WEIGHT : 0)
}

/**
 * Visits halved for every {@link HALF_LIFE_DAYS} since the last one. Visits without a date count
 * nothing rather than as fresh, and a date in the future (clock skew) counts as now rather than as
 * more than now.
 */
function visitWeightOf(candidate: RankCandidate, now: number): number {
  if (candidate.visitCount === undefined || candidate.lastVisitedAt === undefined) return 0
  const ageDays = Math.max(0, now - candidate.lastVisitedAt) / DAY_MS
  return candidate.visitCount * 0.5 ** (ageDays / HALF_LIFE_DAYS)
}

/**
 * Locale-independent order, so the same input sorts the same everywhere. Two rows never share an
 * address — the address decides the group — so there is no equal case to answer.
 */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : 1
}
