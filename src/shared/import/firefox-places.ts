import type { ImportReport, ImportedBookmark } from '../bookmarks/import.js'
import { bookmarkUrlOf } from '../bookmarks/model.js'
import { firefoxTimeToMs } from './epochs.js'

/**
 * Firefox's bookmarks, read from `moz_bookmarks` joined to `moz_places` in the same read-only copy of
 * `places.sqlite` the history comes from (U24), into the tree `graftImportedBookmarks` places.
 *
 * No export in Firefox is needed for this. The HTML import stays beside it as the way in when the
 * profile cannot be read — a newer schema, a damaged file — and the settings page says how to make one.
 *
 * The roots are placed as Firefox's own HTML export places them: the toolbar is the folder that claims
 * our bar; the menu, "other bookmarks" and the mobile root give their contents to the top level, where
 * the graft files them into its import folder; the tags are left out, because a tag folder is a second
 * index over bookmarks that are already somewhere else. Separators are no entries at all. An address
 * `bookmarkUrlOf` refuses — `javascript:`, and the `place:` queries Firefox keeps as smart folders — is
 * counted, as is a row of a kind this reader does not know.
 */

/** One row of the query in `history-sqlite.ts`, checked. */
export interface FirefoxBookmarkRow {
  readonly id: number
  readonly parent: number
  /** 1 a bookmark, 2 a folder, 3 a separator. */
  readonly type: number
  readonly position: number
  readonly title: string
  /** `moz_places.url`; null for a folder, a separator, or a bookmark whose place is gone. */
  readonly url: string | null
  /** PRTime, as SQLite handed it out. */
  readonly dateAdded: unknown
  readonly guid: string
}

const BOOKMARK = 1
const FOLDER = 2
const SEPARATOR = 3
const ROOT_GUID = 'root________'
const TOOLBAR_GUID = 'toolbar_____'
const TAGS_GUID = 'tags________'

function integerOf(value: unknown): number | null {
  const number = typeof value === 'bigint' ? Number(value) : value
  return typeof number === 'number' && Number.isSafeInteger(number) ? number : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

/** A row as SQLite returned it, or `null` when one of its numbers is not a whole number. */
export function firefoxBookmarkRowOf(
  raw: Readonly<Record<string, unknown>>
): FirefoxBookmarkRow | null {
  const id = integerOf(raw['id'])
  const parent = integerOf(raw['parent'])
  const type = integerOf(raw['type'])
  const position = integerOf(raw['position'])
  if (id === null || parent === null || type === null || position === null) return null
  return {
    id,
    parent,
    type,
    position,
    title: textOf(raw['title']),
    url: typeof raw['url'] === 'string' ? raw['url'] : null,
    dateAdded: raw['dateAdded'] ?? null,
    guid: typeof raw['guid'] === 'string' ? raw['guid'] : ''
  }
}

/** The tree under Firefox's roots. Rows no root reaches are not there. */
export function mapFirefoxBookmarks(rows: readonly FirefoxBookmarkRow[]): ImportReport {
  const byParent = new Map<number, FirefoxBookmarkRow[]>()
  for (const row of rows) {
    const siblings = byParent.get(row.parent) ?? []
    siblings.push(row)
    byParent.set(row.parent, siblings)
  }
  const inOrder = (parent: number): FirefoxBookmarkRow[] =>
    [...(byParent.get(parent) ?? [])].sort((left, right) => left.position - right.position)

  const root =
    rows.find((row) => row.guid === ROOT_GUID) ??
    rows.find((row) => row.parent === 0 && row.guid === '')
  const nodes: ImportedBookmark[] = []
  if (root === undefined) return { nodes, skipped: 0 }

  let skipped = 0
  /** Folders whose rows are still to read, and the list they go into. Depth is the file's. */
  const pending: Array<{ parent: number; into: ImportedBookmark[] }> = []
  const read = (parent: number, into: ImportedBookmark[]): void => {
    for (const row of inOrder(parent)) {
      if (row.type === SEPARATOR) continue
      if (row.type === FOLDER) {
        const folder = folderOf(row, false)
        into.push(folder)
        pending.push({ parent: row.id, into: folder.children })
        continue
      }
      const url = row.type === BOOKMARK && row.url !== null ? bookmarkUrlOf(row.url) : null
      if (url === null) {
        skipped += 1
        continue
      }
      into.push({
        kind: 'bookmark',
        title: row.title,
        url,
        addedAt: firefoxTimeToMs(row.dateAdded),
        children: [],
        onToolbar: false
      })
    }
  }

  // The roots in Firefox's order; a root other than the toolbar gives its rows to the top level.
  for (const top of inOrder(root.id)) {
    if (top.guid === TAGS_GUID) continue
    if (top.guid !== TOOLBAR_GUID) {
      read(top.id, nodes)
      continue
    }
    const toolbar = folderOf(top, true)
    nodes.push(toolbar)
    pending.push({ parent: top.id, into: toolbar.children })
  }
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    read(next.parent, next.into)
  }
  return { nodes, skipped }
}

function folderOf(row: FirefoxBookmarkRow, onToolbar: boolean): ImportedBookmark {
  return {
    kind: 'folder',
    title: row.title,
    url: '',
    addedAt: firefoxTimeToMs(row.dateAdded),
    children: [],
    onToolbar
  }
}
