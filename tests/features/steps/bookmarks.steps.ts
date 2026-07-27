import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { graftImportedBookmarks, parseNetscapeBookmarks } from '@shared/bookmarks/import.js'
import {
  BOOKMARK_BAR_ID,
  BOOKMARK_OTHER_ID,
  barBookmarks,
  childrenOf,
  createBookmark,
  isBookmarked,
  moveBookmark,
  relocateBookmark,
  removeBookmark,
  repairBookmarks,
  rootIdOf,
  type Bookmark
} from '@shared/bookmarks/model.js'
import { capture, scope } from './world.js'

/**
 * Steps for `bookmarks.feature`.
 *
 * The model is driven directly, with ids and timestamps supplied by the steps — which is
 * what `createBookmark` takes them as arguments for. Nothing here needs the store: the
 * decisions the scenarios are about are what a folder may hold, what a deletion takes with
 * it and what a loaded file is repaired into, and all three are pure.
 *
 * The three "a bookmark file with …" Givens write nodes straight into the list rather than
 * through the write path, deliberately: each of them describes a document the write path
 * refuses to produce, which is exactly why `repairBookmarks` exists.
 */

interface DataTable {
  hashes(): Array<Record<string, string>>
}

function nodes(state: unknown): Bookmark[] {
  return scope(state).bookmarks
}

function nextId(state: unknown): string {
  const current = scope(state)
  const previous = current.scratch['bookmarkIds']
  const next = (typeof previous === 'number' ? previous : 0) + 1
  current.scratch['bookmarkIds'] = next
  return `bookmark-${next}`
}

/** A fixed clock: a scenario asserting on order must not depend on how fast the machine is. */
const NOW = 1_700_000_000_000

function byTitle(state: unknown, title: string): Bookmark {
  const found = nodes(state).find((node) => node.title === title)
  if (found === undefined) {
    throw new Error(
      `no bookmark called "${title}"; have: ${nodes(state)
        .map((node) => node.title)
        .join(', ')}`
    )
  }
  return found
}

/** `bar` and `other` are the two roots; anything else names a folder in the document. */
function parentIdOf(state: unknown, where: string): string {
  const name = where.trim()
  if (name === 'bar') return BOOKMARK_BAR_ID
  if (name === 'other' || name === '') return BOOKMARK_OTHER_ID
  return byTitle(state, name).id
}

function add(state: unknown, input: { kind: 'bookmark' | 'folder'; title: string; url?: string; parentId: string }): void {
  const current = scope(state)
  current.bookmarks = createBookmark(
    current.bookmarks,
    {
      kind: input.kind,
      title: input.title,
      parentId: input.parentId,
      ...(input.url === undefined ? {} : { url: input.url })
    },
    { id: nextId(state), now: NOW }
  )
}

// --- given -------------------------------------------------------------------

Given('an empty set of bookmarks', (state: unknown) => {
  scope(state).bookmarks = []
})

Given('these bookmarks:', (state: unknown, table: DataTable) => {
  for (const row of table.hashes()) {
    const kind = (row['kind'] ?? '').trim()
    if (kind !== 'bookmark' && kind !== 'folder') throw new Error(`not a bookmark kind: ${kind}`)
    const url = (row['address'] ?? '').trim()
    add(state, {
      kind,
      title: (row['title'] ?? '').trim(),
      parentId: parentIdOf(state, row['inside'] ?? ''),
      ...(url === '' ? {} : { url })
    })
  }
})

Given(
  'a bookmark file in which the folders {string} and {string} each sit inside the other',
  (state: unknown, first: string, second: string) => {
    // Not reachable through `moveBookmark`, which refuses it. A hand-edited or merged file can
    // still hold it, and a ring is a shape no listing can draw.
    scope(state).bookmarks = [
      { id: 'ring-1', kind: 'folder', title: first, url: '', parentId: 'ring-2', createdAt: NOW },
      { id: 'ring-2', kind: 'folder', title: second, url: '', parentId: 'ring-1', createdAt: NOW }
    ]
  }
)

Given('a bookmark file with a bookmark filed inside a folder that is not in it', (state: unknown) => {
  scope(state).bookmarks = [
    {
      id: 'orphan-1',
      kind: 'bookmark',
      title: 'Orphan',
      url: 'https://orphan.example/',
      parentId: 'a-folder-that-is-not-here',
      createdAt: NOW
    }
  ]
})

Given('a bookmark file with a folder that also carries an address', (state: unknown) => {
  scope(state).bookmarks = [
    {
      id: 'folder-1',
      kind: 'folder',
      title: 'Recipes',
      url: 'https://recipes.example/',
      parentId: BOOKMARK_OTHER_ID,
      createdAt: NOW
    }
  ]
})

// --- when --------------------------------------------------------------------

When('I delete {string}', (state: unknown, title: string) => {
  const current = scope(state)
  current.bookmarks = removeBookmark(current.bookmarks, byTitle(state, title).id)
})

When('I try to move {string} into {string}', (state: unknown, title: string, into: string) => {
  const current = scope(state)
  const id = byTitle(state, title).id
  const parentId = into.trim() === title ? id : parentIdOf(state, into)
  capture(state, () => {
    current.bookmarks = moveBookmark(current.bookmarks, id, parentId, 0)
  })
})

When('I point {string} at {string}', (state: unknown, title: string, url: string) => {
  const current = scope(state)
  current.bookmarks = relocateBookmark(current.bookmarks, byTitle(state, title).id, url)
})

When('I bookmark {string} as {string}', (state: unknown, url: string, title: string) => {
  add(state, { kind: 'bookmark', title, url, parentId: BOOKMARK_OTHER_ID })
})

When('I try to bookmark {string} as {string}', (state: unknown, url: string, title: string) => {
  capture(state, () => {
    add(state, { kind: 'bookmark', title, url, parentId: BOOKMARK_OTHER_ID })
  })
})

When('the bookmark file is read back', (state: unknown) => {
  const current = scope(state)
  current.bookmarks = repairBookmarks(current.bookmarks)
})

When('I import this bookmark file:', (state: unknown, html: string) => {
  const current = scope(state)
  const report = parseNetscapeBookmarks(html)
  current.importReport = report
  const result = graftImportedBookmarks(current.bookmarks, report, {
    nextId: () => nextId(state),
    now: NOW,
    // Supplied by the caller so it can be translated; the store passes the catalogue's string.
    folderTitle: 'Imported'
  })
  current.bookmarks = result.nodes
  current.scratch['importSkipped'] = result.skipped
})

// --- then --------------------------------------------------------------------

Then('the bookmark tree holds {int} entry', (state: unknown, count: number) => {
  expect(nodes(state)).toHaveLength(count)
})

Then('the bookmark tree holds {int} entries', (state: unknown, count: number) => {
  expect(nodes(state)).toHaveLength(count)
})

Then('the bookmark tree holds {string}', (state: unknown, title: string) => {
  expect(nodes(state).map((node) => node.title)).toContain(title)
})

Then('the bookmark tree does not hold {string}', (state: unknown, title: string) => {
  // A grandchild left behind counts against the limit, appears in no listing, and comes back
  // the moment the file is repaired.
  expect(nodes(state).map((node) => node.title)).not.toContain(title)
})

Then('{string} sits in the folder {string}', (state: unknown, title: string, folder: string) => {
  expect(byTitle(state, title).parentId).toBe(byTitle(state, folder).id)
})

Then('{string} sits under other bookmarks', (state: unknown, title: string) => {
  // Never the bar: the bar is visible chrome, and rearranging it on startup would move the
  // interface in front of the user.
  expect(rootIdOf(nodes(state), byTitle(state, title).id)).toBe(BOOKMARK_OTHER_ID)
})

Then('the bookmarks bar holds {string}', (state: unknown, title: string) => {
  expect(barBookmarks(nodes(state)).map((node) => node.title)).toContain(title)
})

Then('the bookmarks bar does not hold {string}', (state: unknown, title: string) => {
  expect(barBookmarks(nodes(state)).map((node) => node.title)).not.toContain(title)
})

Then('the bookmarks bar holds nothing', (state: unknown) => {
  expect(barBookmarks(nodes(state))).toEqual([])
})

Then('the folder {string} has no address', (state: unknown, title: string) => {
  expect(byTitle(state, title).url).toBe('')
})

Then('the folder {string} lists {string}', (state: unknown, folder: string, order: string) => {
  const titles = childrenOf(nodes(state), byTitle(state, folder).id).map((node) => node.title)
  expect(titles.join(', ')).toBe(order)
})

Then('the page {string} reads as bookmarked', (state: unknown, url: string) => {
  // Answered through the same normalisation a save would use, or the star would go out the
  // moment a page added a campaign parameter to its own address and the user would save it twice.
  expect(isBookmarked(nodes(state), url)).toBe(true)
})

Then('the bookmark {string} points at {string}', (state: unknown, title: string, url: string) => {
  expect(byTitle(state, title).url).toBe(url)
})

Then('{int} imported entry was refused', (state: unknown, count: number) => {
  expect(scope(state).scratch['importSkipped']).toBe(count)
})
