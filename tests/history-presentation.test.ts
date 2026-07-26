import { describe, expect, it } from 'vitest'
import { DAY_GROUPS, dayGroupOf, readableUrl } from '@shared/history/presentation.js'

/**
 * How a recorded visit is shown.
 *
 * Two small functions, each with a trap that reads as correct. The day grouping is the interesting
 * one: an elapsed-time rule and a calendar rule agree most of the day and disagree about exactly the
 * hours a user is most likely to be looking for.
 */

/** A fixed local afternoon, so nothing here depends on when the test runs. */
const NOW = new Date(2026, 6, 26, 15, 30)
const at = (day: number, hour: number, minute = 0): number =>
  new Date(2026, 6, day, hour, minute).getTime()

describe('dayGroupOf', () => {
  it('files this afternoon under today', () => {
    expect(dayGroupOf(at(26, 9), NOW)).toBe('today')
  })

  it('files one minute after local midnight under today', () => {
    // The boundary is local midnight, not "eight hours ago".
    expect(dayGroupOf(at(26, 0, 1), NOW)).toBe('today')
  })

  it('files last night under yesterday, not under today', () => {
    /*
      The trap, stated as a test. A page opened at eleven last night is sixteen and a half hours old
      here — an elapsed-time rule with a 24-hour window calls that "today", and the user looking for
      "the thing I read last night" finds it under the wrong heading.
    */
    expect(dayGroupOf(at(25, 23), NOW)).toBe('yesterday')
  })

  it('files the whole previous date under yesterday', () => {
    expect(dayGroupOf(at(25, 0, 0), NOW)).toBe('yesterday')
    expect(dayGroupOf(at(25, 23, 59), NOW)).toBe('yesterday')
  })

  it('files anything before that under earlier', () => {
    expect(dayGroupOf(at(24, 23, 59), NOW)).toBe('older')
    expect(dayGroupOf(at(1, 12), NOW)).toBe('older')
  })

  it('does not call a 30-hour-old visit yesterday when two dates have passed', () => {
    // Just after midnight, a 30-hour-old page is two dates back. Elapsed time would say
    // "yesterday"; the calendar says otherwise, and the calendar is what the heading claims.
    const justAfterMidnight = new Date(2026, 6, 26, 0, 30)
    expect(dayGroupOf(at(24, 18, 30), justAfterMidnight)).toBe('older')
  })

  it('files a future timestamp under today rather than nowhere', () => {
    // A clock that moved backwards, or a page whose server set the time. Every entry needs a
    // heading; the total function is the point.
    expect(dayGroupOf(at(27, 10), NOW)).toBe('today')
  })

  it('answers with one of the declared groups, whatever it is given', () => {
    for (const timestamp of [0, -1, at(26, 15), Number.MAX_SAFE_INTEGER]) {
      expect(DAY_GROUPS, String(timestamp)).toContain(dayGroupOf(timestamp, NOW))
    }
  })

  it('crosses a month boundary correctly', () => {
    const firstOfAugust = new Date(2026, 7, 1, 10, 0)
    expect(dayGroupOf(new Date(2026, 6, 31, 20, 0).getTime(), firstOfAugust)).toBe('yesterday')
    expect(dayGroupOf(new Date(2026, 6, 30, 20, 0).getTime(), firstOfAugust)).toBe('older')
  })

  it('crosses a year boundary correctly', () => {
    const newYear = new Date(2027, 0, 1, 10, 0)
    expect(dayGroupOf(new Date(2026, 11, 31, 20, 0).getTime(), newYear)).toBe('yesterday')
  })
})

describe('readableUrl', () => {
  it('drops the scheme and keeps host and path', () => {
    expect(readableUrl('https://example.com/articles/one')).toBe('example.com/articles/one')
  })

  it('drops a lone slash but keeps every other path', () => {
    expect(readableUrl('https://example.com/')).toBe('example.com')
    expect(readableUrl('https://example.com/a/')).toBe('example.com/a/')
  })

  it('keeps the query, because two pages can differ only there', () => {
    expect(readableUrl('https://example.com/search?q=split+view')).toBe(
      'example.com/search?q=split+view'
    )
  })

  it('keeps a port, which distinguishes two local servers', () => {
    expect(readableUrl('http://localhost:5173/app')).toBe('localhost:5173/app')
  })

  it('returns an unparseable address unchanged rather than empty', () => {
    /*
      The trap. A row with no text is a row the user cannot identify and cannot decide about — worse
      than an ugly one. Falling back to the raw string keeps every entry actionable.
    */
    expect(readableUrl('not a url')).toBe('not a url')
    expect(readableUrl('')).toBe('')
  })

  it('never returns an empty string for a non-empty address', () => {
    for (const url of ['https://example.com/', 'file:///tmp/x', 'mailto:a@b.c', '::1', 'a b c']) {
      expect(readableUrl(url), url).not.toBe('')
    }
  })
})
