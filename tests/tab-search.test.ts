import { describe, expect, it } from 'vitest'
import { MAX_RANKED_ROWS } from '@shared/search/rank.js'
import { tabSearchRows } from '@shared/search/tab-search.js'

/**
 * Which tabs the tab search lists, and in what order (U22, R31).
 *
 * The order of a non-empty search is the ranker's (U17), and `search-rank.test.ts` holds that. What is
 * asserted here is what the tab search adds on top of it: that an empty field lists the window's tabs
 * as the strip has them, and that two tabs on one page are two rows — the ranker merges by address,
 * which is right for suggestions and wrong for a list whose every row is a tab to switch to.
 */

const tab = (id: string, url: string, title = id): { id: string; url: string; title: string } => ({
  id,
  url,
  title
})

const ids = (rows: readonly { id: string }[]): string[] => rows.map((row) => row.id)

describe('tabSearchRows', () => {
  it('lists every tab in the order given while nothing is typed', () => {
    const tabs = [tab('c', 'https://c.example/'), tab('a', 'https://a.example/')]
    expect(ids(tabSearchRows(tabs, ''))).toEqual(['c', 'a'])
    expect(ids(tabSearchRows(tabs, '   '))).toEqual(['c', 'a'])
  })

  it('finds a tab by its title', () => {
    const tabs = [
      tab('mail', 'https://mail.example/', 'Inbox'),
      tab('docs', 'https://docs.example/', 'Quarterly report')
    ]
    expect(ids(tabSearchRows(tabs, 'report'))).toEqual(['docs'])
  })

  it('finds a tab by its address', () => {
    const tabs = [
      tab('mail', 'https://mail.example/', 'Inbox'),
      tab('docs', 'https://docs.example/', 'Quarterly report')
    ]
    expect(ids(tabSearchRows(tabs, 'mail.ex'))).toEqual(['mail'])
  })

  it('ranks the way the address bar does: an address prefix before a title word', () => {
    const tabs = [
      tab('blog', 'https://blog.example/', 'Learning git'),
      tab('hub', 'https://github.com/', 'Home')
    ]
    expect(ids(tabSearchRows(tabs, 'git'))).toEqual(['hub', 'blog'])
  })

  it('keeps two tabs on the same page as two rows, in the order given', () => {
    const tabs = [
      tab('second', 'https://news.example/#top', 'News'),
      tab('other', 'https://other.example/', 'Other'),
      tab('first', 'https://news.example/', 'News')
    ]
    expect(ids(tabSearchRows(tabs, 'news'))).toEqual(['second', 'first'])
  })

  it('finds a tab whose address history would not record', () => {
    const tabs = [tab('start', 'tessera://newtab', 'New tab')]
    expect(ids(tabSearchRows(tabs, 'newtab'))).toEqual(['start'])
  })

  it('returns nothing when no tab matches', () => {
    expect(tabSearchRows([tab('a', 'https://a.example/')], 'zzz')).toEqual([])
  })

  it('stops at the ranker limit even when one page is open many times', () => {
    const tabs = Array.from({ length: MAX_RANKED_ROWS + 3 }, (_, index) =>
      tab(`t${index}`, 'https://same.example/', 'Same')
    )
    expect(tabSearchRows(tabs, 'same')).toHaveLength(MAX_RANKED_ROWS)
  })

  it('hands back the tabs it was given, so the caller keeps its own fields', () => {
    const given = { ...tab('a', 'https://a.example/'), extra: 1 }
    expect(tabSearchRows([given], 'a.example')[0]).toBe(given)
  })
})
