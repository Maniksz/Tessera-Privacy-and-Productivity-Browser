import { MAX_IMPORT_LENGTH, type ImportReport, type ImportedBookmark } from '../bookmarks/import.js'
import { bookmarkUrlOf } from '../bookmarks/model.js'
import { chromeTimeToMs } from './epochs.js'

/**
 * The `Bookmarks` file of a Chrome, Edge or Chromium profile, read into the tree the HTML importer
 * produces (U24, KTD19), so `graftImportedBookmarks` places it exactly as it places an export.
 *
 * ```
 * { "roots": { "bookmark_bar": folder, "other": folder, "synced": folder }, … }
 * folder = { "type": "folder", "name": "…", "date_added": "…", "children": [ node, … ] }
 * url    = { "type": "url",    "name": "…", "date_added": "…", "url": "…" }
 * ```
 *
 * The roots go where Chrome's own HTML export puts them: the bar becomes the folder that claims the
 * toolbar, the contents of "other bookmarks" stand at the top level — the graft files them into its
 * import folder, which is our "other" — and the mobile root, when it holds anything, is one folder
 * under its own name. A root this reader does not know is left out rather than guessed at.
 *
 * The file is untrusted in the way an export is: written by another program, readable by anything
 * that could write to the profile. Every address goes through `bookmarkUrlOf`, which refuses
 * `javascript:` and its relatives; what is refused, and every node that is neither a folder nor an
 * address, is counted. Depth comes from the file, so the walk is a loop, not a recursion.
 */

type Json = Record<string, unknown>

function objectOr(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
}

function childrenOf(node: Json): readonly unknown[] {
  return Array.isArray(node['children']) ? (node['children'] as unknown[]) : []
}

function folderOf(node: Json, onToolbar: boolean): ImportedBookmark {
  return {
    kind: 'folder',
    title: textOf(node['name']),
    url: '',
    addedAt: chromeTimeToMs(node['date_added']),
    children: [],
    onToolbar
  }
}

/** The tree in the file, or `null` when the text is not a Chrome bookmarks file at all. */
export function parseChromeBookmarks(json: string): ImportReport | null {
  if (json.length > MAX_IMPORT_LENGTH) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  const roots = objectOr(objectOr(parsed)?.['roots'])
  if (roots === null) return null

  const nodes: ImportedBookmark[] = []
  let skipped = 0
  /** Children still to read, and the list they go into. */
  const pending: Array<{ children: readonly unknown[]; into: ImportedBookmark[] }> = []

  const bar = objectOr(roots['bookmark_bar'])
  const other = objectOr(roots['other'])
  const synced = objectOr(roots['synced'])
  if (bar !== null) {
    const folder = folderOf(bar, true)
    nodes.push(folder)
    pending.push({ children: childrenOf(bar), into: folder.children })
  }
  if (other !== null) pending.push({ children: childrenOf(other), into: nodes })
  let mobile: ImportedBookmark | null = null
  if (synced !== null) {
    mobile = folderOf(synced, false)
    pending.push({ children: childrenOf(synced), into: mobile.children })
  }

  /*
    Breadth by level, and each list in file order: a folder is pushed with its children once it is
    placed, so nothing depends on the depth of the file. The mobile folder is placed at the end, and
    only once its children are read, so an empty root leaves no nameless folder behind.
  */
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    for (const raw of next.children) {
      const node = objectOr(raw)
      if (node?.['type'] === 'folder') {
        const folder = folderOf(node, false)
        next.into.push(folder)
        pending.push({ children: childrenOf(node), into: folder.children })
        continue
      }
      const url =
        node?.['type'] === 'url' && typeof node['url'] === 'string'
          ? bookmarkUrlOf(node['url'])
          : null
      if (node === null || url === null) {
        skipped += 1
        continue
      }
      next.into.push({
        kind: 'bookmark',
        title: textOf(node['name']),
        url,
        addedAt: chromeTimeToMs(node['date_added']),
        children: [],
        onToolbar: false
      })
    }
  }
  if (mobile !== null && mobile.children.length > 0) nodes.push(mobile)

  return { nodes, skipped }
}
