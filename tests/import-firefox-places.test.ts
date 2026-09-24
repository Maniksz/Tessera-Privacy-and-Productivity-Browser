import { describe, expect, it } from 'vitest'
import { firefoxBookmarkRowOf, mapFirefoxBookmarks } from '@shared/import/firefox-places.js'
import type { FirefoxBookmarkRow } from '@shared/import/firefox-places.js'

/**
 * Firefox's bookmarks, from the rows of `moz_bookmarks` joined to `moz_places` (U24).
 *
 * Read from the same copy of `places.sqlite` the history comes from, so no export in Firefox is
 * needed; the HTML import stays as the way in when the file cannot be read. The roots are placed as
 * Firefox's own HTML export places them: the toolbar on our bar, the menu, "other bookmarks" and the
 * mobile root at the top level, and the tags — a second index over the same bookmarks — not at all.
 */

let nextId = 100

function row(overrides: Partial<FirefoxBookmarkRow> & Pick<FirefoxBookmarkRow, 'parent'>) {
  nextId += 1
  return {
    id: nextId,
    type: 1,
    position: 0,
    title: '',
    url: null,
    dateAdded: null,
    guid: `g${nextId}`,
    ...overrides
  } satisfies FirefoxBookmarkRow
}

const ROOTS: FirefoxBookmarkRow[] = [
  row({ id: 1, parent: 0, type: 2, guid: 'root________', title: '' }),
  row({ id: 2, parent: 1, type: 2, position: 0, guid: 'menu________', title: 'menu' }),
  row({ id: 3, parent: 1, type: 2, position: 1, guid: 'toolbar_____', title: 'toolbar' }),
  row({ id: 4, parent: 1, type: 2, position: 2, guid: 'tags________', title: 'tags' }),
  row({ id: 5, parent: 1, type: 2, position: 3, guid: 'unfiled_____', title: 'unfiled' }),
  row({ id: 6, parent: 1, type: 2, position: 4, guid: 'mobile______', title: 'mobile' })
]

describe('Firefox bookmarks from places.sqlite', () => {
  it('puts the toolbar on the bar, the other roots at the top level, and leaves the tags out', () => {
    const report = mapFirefoxBookmarks([
      ...ROOTS,
      row({ parent: 3, position: 1, title: 'Second', url: 'https://second.example/' }),
      row({ parent: 3, position: 0, title: 'First', url: 'https://first.example/' }),
      row({ id: 50, parent: 2, type: 2, title: 'Work' }),
      row({ parent: 50, title: 'Tickets', url: 'https://tickets.example/' }),
      row({ id: 60, parent: 4, type: 2, title: 'a-tag' }),
      row({ parent: 60, title: 'Tagged', url: 'https://first.example/' }),
      row({ parent: 5, title: 'Unfiled', url: 'https://unfiled.example/' }),
      row({ parent: 6, title: 'Phone', url: 'https://phone.example/' })
    ])
    expect(report.nodes.map((node) => [node.title, node.onToolbar])).toEqual([
      ['Work', false],
      ['toolbar', true],
      ['Unfiled', false],
      ['Phone', false]
    ])
    expect(report.nodes[1]?.children.map((node) => node.title)).toEqual(['First', 'Second'])
    expect(report.nodes[0]?.children.map((node) => node.url)).toEqual(['https://tickets.example/'])
    expect(report.skipped).toBe(0)
  })

  it('dates each entry from `dateAdded`, microseconds since 1970', () => {
    const report = mapFirefoxBookmarks([
      ...ROOTS,
      row({
        parent: 5,
        title: 'Dated',
        url: 'https://d.example/',
        dateAdded: 1_726_000_000_000_000n
      })
    ])
    expect(report.nodes.find((node) => !node.onToolbar)?.addedAt).toBe(1_726_000_000_000)
  })

  it('refuses and counts javascript: and place: entries; separators are no entries at all', () => {
    const report = mapFirefoxBookmarks([
      ...ROOTS,
      row({ parent: 3, title: 'Most visited', url: 'place:sort=8&maxResults=10' }),
      row({ parent: 3, title: 'Bookmarklet', url: 'javascript:alert(1)' }),
      row({ parent: 3, title: 'No place', url: null }),
      row({ parent: 3, type: 3 }),
      row({ parent: 3, type: 7, title: 'Unknown kind' })
    ])
    expect(report.nodes[0]?.children).toEqual([])
    expect(report.skipped).toBe(4)
  })

  it('reads a profile without a root as nothing, and rows under no root as not there', () => {
    expect(mapFirefoxBookmarks([])).toEqual({ nodes: [], skipped: 0 })
    const report = mapFirefoxBookmarks([
      row({ id: 1, parent: 0, type: 2, guid: 'something-else' }),
      row({ parent: 999, title: 'Orphan', url: 'https://orphan.example/' })
    ])
    expect(report).toEqual({ nodes: [], skipped: 0 })
  })

  it('takes the row without a parent as the root when the guid is not the usual one', () => {
    const report = mapFirefoxBookmarks([
      row({ id: 1, parent: 0, type: 2, guid: '' }),
      row({ id: 2, parent: 1, type: 2, guid: 'unfiled_____' }),
      row({ parent: 2, title: 'Kept', url: 'https://kept.example/' })
    ])
    expect(report.nodes.map((node) => node.title)).toEqual(['Kept'])
  })

  it('does not overflow the stack on a deeply nested profile', () => {
    const rows = [...ROOTS]
    let parent = 5
    for (let level = 0; level < 5_000; level += 1) {
      const folder = row({ parent, type: 2, title: 'F' })
      rows.push(folder)
      parent = folder.id
    }
    // The empty toolbar, and the one folder at the top of the chain.
    expect(mapFirefoxBookmarks(rows).nodes).toHaveLength(2)
  })
})

describe('one row of the query', () => {
  it('reads integers as SQLite hands them out, bigints included', () => {
    expect(
      firefoxBookmarkRowOf({
        id: 7n,
        parent: 3n,
        type: 1n,
        position: 2n,
        title: '  Spaced   title ',
        url: 'https://x.example/',
        dateAdded: 1_726_000_000_000_000n,
        guid: 'abc'
      })
    ).toEqual({
      id: 7,
      parent: 3,
      type: 1,
      position: 2,
      title: 'Spaced title',
      url: 'https://x.example/',
      dateAdded: 1_726_000_000_000_000n,
      guid: 'abc'
    })
  })

  it('fills in what may be null, and refuses a row without its numbers', () => {
    expect(
      firefoxBookmarkRowOf({ id: 1, parent: 0, type: 2, position: 0, title: null, url: null })
    ).toEqual({
      id: 1,
      parent: 0,
      type: 2,
      position: 0,
      title: '',
      url: null,
      dateAdded: null,
      guid: ''
    })
    expect(firefoxBookmarkRowOf({ id: 'x', parent: 0, type: 2, position: 0 })).toBeNull()
    expect(firefoxBookmarkRowOf({ id: 1, parent: 0, type: 2, position: 1.5 })).toBeNull()
    expect(
      firefoxBookmarkRowOf({ id: 1, parent: 0, type: 1, position: 0, url: 5, title: 3 })
    ).toEqual({
      id: 1,
      parent: 0,
      type: 1,
      position: 0,
      title: '',
      url: null,
      dateAdded: null,
      guid: ''
    })
    expect(firefoxBookmarkRowOf({ id: 2n ** 60n, parent: 0, type: 1, position: 0 })).toBeNull()
  })
})
