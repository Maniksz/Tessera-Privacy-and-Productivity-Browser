/**
 * How a recorded visit is shown.
 *
 * Extracted from the history page so it can be tested. Both functions look trivial and both have a
 * trap in them, which is exactly the combination that survives a code review and fails in use.
 *
 * Zod-free and DOM-free: the page imports it at runtime, and it is held to this directory's 100 %
 * coverage bar.
 */

/** Which heading a visit appears under. */
export type DayGroup = 'today' | 'yesterday' | 'older'

export const DAY_GROUPS: readonly DayGroup[] = ['today', 'yesterday', 'older']

/**
 * Groups by calendar day, not by elapsed hours.
 *
 * The trap: "yesterday" has to mean the previous *date*, not "24 to 48 hours ago". At nine in the
 * morning those two disagree about everything from the night before — a page opened at eleven last
 * night is eleven hours old, which an elapsed-time rule files under "today". The user's word for it
 * is the date, and the date is what the heading claims.
 *
 * `now` is passed in rather than read, so the answer does not depend on when a test runs.
 */
export function dayGroupOf(timestamp: number, now: Date): DayGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (timestamp >= startOfToday) return 'today'
  // Local midnight minus one day, computed through `Date` rather than by subtracting 86 400 000,
  // so the day a clock shifts still has exactly one yesterday.
  const startOfYesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).getTime()
  if (timestamp >= startOfYesterday) return 'yesterday'
  return 'older'
}

/**
 * The part of an address worth reading in a list: host and path, without the scheme.
 *
 * The trap: an address that cannot be parsed must come back unchanged rather than empty. A list row
 * with no text is a row the user cannot identify and cannot decide about — worse than an ugly one.
 */
export function readableUrl(url: string): string {
  try {
    const parsed = new URL(url)
    // A lone `/` is noise; every other path is information.
    const tail = parsed.pathname === '/' ? '' : parsed.pathname
    return `${parsed.host}${tail}${parsed.search}`
  } catch {
    return url
  }
}
