import { classifyOmniboxInput } from '../url/omnibox.js'
import { titleFromUrl } from '../quicklinks/model.js'
import { cleanUrl } from '../url/tracking-params.js'

/**
 * Bookmarks — what `tessera://bookmarks` manages and what the bookmarks bar draws.
 *
 * ## Why this file has no zod import
 *
 * The bookmarks page is a renderer, so every value import here lands in a bundle the user
 * waits for. Co-locating validation schemas with pure helpers cost this project roughly
 * half a megabyte of startup parse work once already, and an architecture test now keeps
 * it out. The persistence schema therefore lives with the store, in
 * `src/main/data/BookmarkStore.ts`. See
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * ## Why the roots are ids rather than stored nodes
 *
 * There are exactly two places a bookmark can live at the top: the bar and everything
 * else. Both are addressed by a reserved id that is never itself a stored node, so
 * `parentId` is a plain `string` and never `null`.
 *
 * The alternative — storing two real folder nodes — was rejected because it makes the two
 * most damaging operations representable: a root can then be renamed, moved into another
 * folder, or deleted, and the file that comes back has no bar. Every one of those would
 * have needed its own guard in every write function. Here the type says a root is not a
 * node, so there is nothing to guard.
 *
 * The cost, stated rather than discovered: a root has no `createdAt` and no title of its
 * own, so its name is a translated string in the interface rather than data. That is the
 * right place for it anyway — the bar is called "Lesezeichenleiste" in German.
 *
 * ## Why there is no depth limit
 *
 * A real bookmark tree nests arbitrarily and users expect it to. Nothing here recurses:
 * every traversal is an explicit loop with a `seen` set, so a pathological file costs time
 * proportional to `MAX_BOOKMARKS` and never a blown stack. A limit would be a rule a
 * person can hit while importing somebody else's bookmarks, buying nothing.
 *
 * What *is* guarded is the cycle — a folder that is its own ancestor. That one is not a
 * depth question but a termination question, and it is guarded in two places: `moveBookmark`
 * refuses to create one, and `repairBookmarks` breaks one that arrived in the file anyway.
 *
 * ## Why every operation is pure
 *
 * The rules — what may hold what, what a deletion takes with it, how a reorder lands —
 * exist once here instead of being re-implemented across a store, an IPC handler and a
 * page. The store supplies identity and the clock, and writes the result down.
 */

export const BOOKMARK_KINDS = ['bookmark', 'folder'] as const
export type BookmarkKind = (typeof BOOKMARK_KINDS)[number]

/**
 * The bar the setting `appearance.showBookmarksBar` shows.
 *
 * Short, stable strings rather than generated ids: they are written into every child's
 * `parentId`, so they end up in the file and in exported data. A uuid there would be a
 * value nothing could recognise after a profile was copied.
 */
export const BOOKMARK_BAR_ID = 'bar'
export const BOOKMARK_OTHER_ID = 'other'
export const BOOKMARK_ROOT_IDS = [BOOKMARK_BAR_ID, BOOKMARK_OTHER_ID] as const
export type BookmarkRootId = (typeof BOOKMARK_ROOT_IDS)[number]

/**
 * Entries kept at most, oldest first to go.
 *
 * The same reasoning as the history cap, and for the same mechanical reason: the store
 * rewrites the *whole* document on every flush and decrypts it in one piece at startup, so
 * this is a write-cost and startup-cost bound rather than a disk-space one. Ten thousand
 * bookmarks is far past what anyone curates by hand and still leaves the document well
 * under a megabyte.
 */
export const MAX_BOOKMARKS = 10_000

export const MAX_BOOKMARK_TITLE_LENGTH = 200

/**
 * Addresses longer than this are refused rather than truncated.
 *
 * A cut URL is an address that no longer resolves, so the bookmark would be a row the user
 * can click and never arrive anywhere from. Refusing says so at the moment the person can
 * still do something about it.
 */
export const MAX_BOOKMARK_URL_LENGTH = 2048

export interface Bookmark {
  id: string
  kind: BookmarkKind
  title: string
  /** Always empty for a folder. Normalised by `bookmarkUrlOf` for a bookmark. */
  url: string
  /** A root id, or the id of a folder in the same document. Never empty. */
  parentId: string
  createdAt: number
}

export interface BookmarkDocument {
  version: 1
  /** Sibling order is array order within one `parentId`; see `insertAmongSiblings`. */
  nodes: Bookmark[]
}

export function emptyBookmarkDocument(): BookmarkDocument {
  return { version: 1, nodes: [] }
}

export function isBookmarkKind(value: unknown): value is BookmarkKind {
  return typeof value === 'string' && (BOOKMARK_KINDS as readonly string[]).includes(value)
}

const rootIdSet: ReadonlySet<string> = new Set(BOOKMARK_ROOT_IDS)

export function isBookmarkRootId(value: string): value is BookmarkRootId {
  return rootIdSet.has(value)
}

// --- errors ------------------------------------------------------------------
// Named types rather than bare strings, so an IPC handler can turn each into a message
// the user can act on instead of a generic failure.

export class BookmarkNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Bookmark not found: ${id}`)
    this.name = 'BookmarkNotFoundError'
  }
}

export class InvalidBookmarkUrlError extends Error {
  constructor(readonly input: string) {
    super(`Not a usable address: ${input}`)
    this.name = 'InvalidBookmarkUrlError'
  }
}

/** A folder asked to hold something it cannot, or a folder asked to hold itself. */
export class BookmarkNestingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BookmarkNestingError'
  }
}

export class BookmarkLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Cannot hold more than ${limit} bookmarks`)
    this.name = 'BookmarkLimitError'
  }
}

// --- reads -------------------------------------------------------------------

/**
 * Direct children of a folder or of a root, in display order.
 *
 * Generic over the element for the same reason `childrenOf` in `quicklinks/model.ts` is: a
 * caller holding richer objects — a node plus its favicon address — gets them back rather
 * than having them widened on the way through.
 */
export function childrenOf<T extends Bookmark>(nodes: readonly T[], parentId: string): T[] {
  return nodes.filter((node) => node.parentId === parentId)
}

export function findBookmark<T extends Bookmark>(nodes: readonly T[], id: string): T | undefined {
  return nodes.find((node) => node.id === id)
}

/** What the bar draws. Its own name because it is the one folder with a setting attached. */
export function barBookmarks<T extends Bookmark>(nodes: readonly T[]): T[] {
  return childrenOf(nodes, BOOKMARK_BAR_ID)
}

/** A folder's direct child count, for the "3 items" label. */
export function countChildren(nodes: readonly Bookmark[], folderId: string): number {
  return nodes.reduce((total, node) => (node.parentId === folderId ? total + 1 : total), 0)
}

/**
 * Every id inside a folder, at any depth.
 *
 * Breadth-first with an explicit queue and a `seen` set rather than recursion. The set is
 * not decoration: a file whose folders form a cycle would otherwise loop forever here, and
 * this function is called by the deletion path — the one place where not terminating means
 * a hung main process while the user waits for a folder to disappear.
 */
export function descendantIdsOf(nodes: readonly Bookmark[], folderId: string): Set<string> {
  const found = new Set<string>()
  const queue: string[] = [folderId]
  while (queue.length > 0) {
    const [current] = queue.splice(0, 1)
    if (current === undefined) continue
    for (const child of nodes) {
      if (child.parentId !== current) continue
      if (found.has(child.id)) continue
      found.add(child.id)
      queue.push(child.id)
    }
  }
  return found
}

/**
 * True when `candidateId` sits anywhere inside `ancestorId`.
 *
 * Walks *up* from the candidate rather than down from the ancestor, because that is the
 * cheap direction: a node has one parent, a folder has any number of children. Same `seen`
 * guard, for the same reason.
 */
export function isDescendantOf(
  nodes: readonly Bookmark[],
  candidateId: string,
  ancestorId: string
): boolean {
  const seen = new Set<string>()
  let current = candidateId
  while (!isBookmarkRootId(current)) {
    if (seen.has(current)) return false
    seen.add(current)
    const node = findBookmark(nodes, current)
    if (node === undefined) return false
    if (node.parentId === ancestorId) return true
    current = node.parentId
  }
  return false
}

/**
 * The folders between a root and this node, outermost first — the breadcrumb.
 *
 * The node itself is not included: a breadcrumb names where you are, and the current
 * folder is drawn as the heading rather than as the last crumb.
 */
export function folderPath(nodes: readonly Bookmark[], id: string): Bookmark[] {
  const path: Bookmark[] = []
  const seen = new Set<string>()
  let current = id
  while (!isBookmarkRootId(current)) {
    if (seen.has(current)) break
    seen.add(current)
    const node = findBookmark(nodes, current)
    if (node === undefined) break
    const parent = findBookmark(nodes, node.parentId)
    if (parent === undefined) break
    path.unshift(parent)
    current = parent.id
  }
  return path
}

/** Which root a node ultimately lives under, or `null` for a node outside the tree. */
export function rootIdOf(nodes: readonly Bookmark[], id: string): BookmarkRootId | null {
  const seen = new Set<string>()
  let current = id
  while (!isBookmarkRootId(current)) {
    if (seen.has(current)) return null
    seen.add(current)
    const node = findBookmark(nodes, current)
    if (node === undefined) return null
    current = node.parentId
  }
  return current
}

// --- addresses ---------------------------------------------------------------

/**
 * The address a bookmark stores for a page, or `null` when it stores none.
 *
 * Three decisions, and two of them differ from what history does with the same problem:
 *
 *   - **What counts as an address** comes from `classifyOmniboxInput`, the same classifier
 *     the address bar uses. So `example.com` becomes `https://example.com/` here exactly as
 *     it would when typed, and `javascript:…` is refused because that classifier already
 *     refuses it. One opinion about what an address is, which matters most on the import
 *     path: a bookmark file from another browser can contain anything at all.
 *   - **The fragment is kept**, where history drops it. History is a list of pages visited,
 *     and one entry per anchor would be noise. A bookmark is a place a person chose to
 *     return to, and `#installation` in a long document is very often the whole point of
 *     saving it.
 *   - **Tracking parameters are stripped**, with the same rule the network layer uses. This
 *     address will be *requested*, every time the bookmark is opened, for years — leaving a
 *     campaign identifier in it would make the bookmark the place that identifier survives.
 *
 * Plus one correction of the classifier, which is why this is not simply a call to it.
 * `classifyOmniboxInput` answers `https://example.com` for the typed text `example.com` and
 * `https://example.com/` for the typed text `https://example.com` — the first is the raw
 * concatenation, the second went through the URL parser. As a navigation target the two are
 * identical, so nothing noticed. As an *identity* they are two different bookmarks: the star
 * would read as off on a page that is bookmarked, and the user would save it twice. So an
 * http or https result is put through the parser here, which makes the key canonical whichever
 * way the address was written.
 */
export function bookmarkUrlOf(raw: string): string | null {
  const intent = classifyOmniboxInput(raw)
  if (intent.kind !== 'url') return null

  // No `try` needed and none wanted: the classifier only answers `url` for an http(s) address
  // it has already parsed successfully, so this cannot throw. A `catch` here would be a branch
  // no test could reach. Other schemes — the internal one, `about:`, `file:` — come back from
  // the classifier already in the form it decided on and are left exactly as they are.
  const canonical =
    intent.url.startsWith('http://') || intent.url.startsWith('https://')
      ? new URL(intent.url).toString()
      : intent.url

  const cleaned = cleanUrl(canonical)
  if (cleaned.length > MAX_BOOKMARK_URL_LENGTH) return null
  return cleaned
}

/** Throwing form, for the write paths that must report *why* they refused. */
export function normalizeBookmarkUrl(input: string): string {
  const url = bookmarkUrlOf(input)
  if (url === null) throw new InvalidBookmarkUrlError(input)
  return url
}

/**
 * Titles arrive from pages and from imported files, so they arrive with newlines, tabs and
 * padding. Every view shows a single line, so the whitespace is collapsed once here.
 */
function cleanTitle(title: string, url: string): string {
  const collapsed = title.replace(/\s+/g, ' ').trim().slice(0, MAX_BOOKMARK_TITLE_LENGTH)
  if (collapsed !== '') return collapsed
  // A bookmark with no title falls back to its host, which is what
  // `quicklinks/model.ts` already decided for the same problem. Imported here rather than
  // reimplemented: two answers to "what is this page called" would eventually differ, and
  // the start page and the bookmarks page would then disagree about the same address.
  return titleFromUrl(url).slice(0, MAX_BOOKMARK_TITLE_LENGTH)
}

/** Folders keep a name of their own; there is no address to fall back to. */
function cleanFolderTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim().slice(0, MAX_BOOKMARK_TITLE_LENGTH)
}

/** Every bookmark pointing at a page, matched on the normalised address. */
export function bookmarksForUrl(nodes: readonly Bookmark[], url: string): Bookmark[] {
  const target = bookmarkUrlOf(url)
  if (target === null) return []
  return nodes.filter((node) => node.kind === 'bookmark' && node.url === target)
}

/**
 * Whether a page is bookmarked — what the star in the address bar draws.
 *
 * Answered through `bookmarkUrlOf`, so it agrees with what `createBookmark` would store.
 * A comparison against the raw address would make the star turn off the moment a page
 * added a campaign parameter to its own URL, and the user would bookmark it twice.
 */
export function isBookmarked(nodes: readonly Bookmark[], url: string): boolean {
  return bookmarksForUrl(nodes, url).length > 0
}

// --- writes ------------------------------------------------------------------

export interface CreateBookmarkInput {
  kind: BookmarkKind
  title: string
  /** Raw input, normalised here. Ignored for a folder. */
  url?: string
  /** A root id or a folder id; `BOOKMARK_OTHER_ID` when omitted. */
  parentId?: string
  /** Position among siblings; appended when omitted. */
  index?: number
}

export interface CreateBookmarkContext {
  id: string
  now: number
}

/**
 * Adds a bookmark or a folder.
 *
 * `id` and `now` come from the caller, so this stays pure and a test does not have to
 * freeze the clock or stub a generator.
 */
export function createBookmark(
  nodes: readonly Bookmark[],
  input: CreateBookmarkInput,
  context: CreateBookmarkContext
): Bookmark[] {
  if (nodes.length >= MAX_BOOKMARKS) throw new BookmarkLimitError(MAX_BOOKMARKS)

  const parentId = input.parentId ?? BOOKMARK_OTHER_ID
  assertUsableParent(nodes, parentId)

  const url = input.kind === 'folder' ? '' : normalizeBookmarkUrl(input.url ?? '')
  const node: Bookmark = {
    id: context.id,
    kind: input.kind,
    title: input.kind === 'folder' ? cleanFolderTitle(input.title) : cleanTitle(input.title, url),
    url,
    parentId,
    createdAt: context.now
  }

  return insertAmongSiblings([...nodes], node, parentId, input.index)
}

export interface UpdateBookmarkPatch {
  title?: string
  /** Raw input, normalised. Refused for a folder, which has no address. */
  url?: string
}

export function updateBookmark(
  nodes: readonly Bookmark[],
  id: string,
  patch: UpdateBookmarkPatch
): Bookmark[] {
  const existing = findBookmark(nodes, id)
  if (existing === undefined) throw new BookmarkNotFoundError(id)

  if (patch.url !== undefined && existing.kind === 'folder') {
    throw new BookmarkNestingError('A folder has no address')
  }

  const url = patch.url === undefined ? existing.url : normalizeBookmarkUrl(patch.url)
  const title =
    patch.title === undefined
      ? existing.title
      : existing.kind === 'folder'
        ? cleanFolderTitle(patch.title)
        : cleanTitle(patch.title, url)

  const next: Bookmark = { ...existing, title, url }
  return nodes.map((node) => (node.id === id ? next : node))
}

/**
 * Points an existing bookmark at a new address — "this page has moved".
 *
 * Its own operation rather than `updateBookmark({ url })`, and the difference is what it
 * *keeps*: the title the user gave it, the folder they filed it in, and its position among
 * its siblings. A user whose bookmark broke wants the address fixed, not the bookmark
 * replaced — and the obvious alternative, delete and re-add, loses all three and drops the
 * row to the bottom of the folder.
 *
 * Refused for a folder, which has no address to move.
 */
export function relocateBookmark(nodes: readonly Bookmark[], id: string, url: string): Bookmark[] {
  const existing = findBookmark(nodes, id)
  if (existing === undefined) throw new BookmarkNotFoundError(id)
  if (existing.kind === 'folder') throw new BookmarkNestingError('A folder has no address')

  const target = normalizeBookmarkUrl(url)
  // The title is only re-derived when it *was* the old address. A title the user typed
  // survives; a placeholder host name follows the page rather than staying behind as the
  // name of somewhere the bookmark no longer goes.
  const derived = titleFromUrl(existing.url).slice(0, MAX_BOOKMARK_TITLE_LENGTH)
  const title = existing.title === derived ? cleanTitle('', target) : existing.title
  return nodes.map((node) => (node.id === id ? { ...node, url: target, title } : node))
}

/**
 * Removes a bookmark, or a folder together with everything inside it at any depth.
 *
 * The transitive part is the trap, and it is the one place bookmarks genuinely differ from
 * quick links. Quick links nest exactly one level, so deleting a folder's *direct* children
 * is complete there. Here a folder holds folders: taking only the direct children would
 * leave the grandchildren with a `parentId` naming a folder that no longer exists — nodes
 * that count against the limit, appear in no listing, and come back the moment `repair`
 * re-parents them somewhere unexpected. That reads as data loss followed by data
 * resurrection, which is worse than either.
 */
export function removeBookmark(nodes: readonly Bookmark[], id: string): Bookmark[] {
  const existing = findBookmark(nodes, id)
  if (existing === undefined) throw new BookmarkNotFoundError(id)

  const doomed = descendantIdsOf(nodes, id)
  doomed.add(id)
  return nodes.filter((node) => !doomed.has(node.id))
}

/**
 * Moves a node to a new parent and position — the drag-and-drop operation.
 *
 * The refusals, each for its own reason:
 *
 *   - into itself, which would detach the node from every listing;
 *   - into one of its own descendants, which would make a ring of folders reachable from
 *     nothing. That is the case a one-level model like quick links never has to think
 *     about, and it is silent: the write succeeds, the folder vanishes from the tree, and
 *     only a traversal without a `seen` set would reveal it — by hanging;
 *   - into a bookmark, which is not a container.
 */
export function moveBookmark(
  nodes: readonly Bookmark[],
  id: string,
  parentId: string,
  toIndex: number
): Bookmark[] {
  const existing = findBookmark(nodes, id)
  if (existing === undefined) throw new BookmarkNotFoundError(id)

  if (parentId === id) throw new BookmarkNestingError('Cannot move an item into itself')
  if (isDescendantOf(nodes, parentId, id)) {
    throw new BookmarkNestingError('Cannot move a folder into one of its own folders')
  }
  assertUsableParent(nodes, parentId)

  const withoutMoved = nodes.filter((node) => node.id !== id)
  return insertAmongSiblings(withoutMoved, { ...existing, parentId }, parentId, toIndex)
}

/** Everything under one root, for "clear the bar" and for tests. */
export function removeChildrenOf(nodes: readonly Bookmark[], parentId: string): Bookmark[] {
  const doomed = descendantIdsOf(nodes, parentId)
  return nodes.filter((node) => !doomed.has(node.id))
}

function assertUsableParent(nodes: readonly Bookmark[], parentId: string): void {
  if (isBookmarkRootId(parentId)) return
  const parent = findBookmark(nodes, parentId)
  if (parent === undefined) throw new BookmarkNotFoundError(parentId)
  if (parent.kind !== 'folder') {
    throw new BookmarkNestingError('Only a folder can hold bookmarks')
  }
}

/**
 * Places `node` into `list` so it lands at `index` among the items sharing `parentId`.
 *
 * The list is flat and holds every parent's children, so a sibling index has to be
 * translated into an absolute one. Appending when `index` is out of range is the forgiving
 * choice: a drag that overshoots the last row should land at the end rather than fail.
 *
 * The same function as in `quicklinks/model.ts`, and deliberately not shared with it: that
 * one is typed to `QuickLink` and its "no siblings" fallback lands at the end of a *flat*
 * list, which is right there and wrong here — a first child of a nested folder belongs
 * beside its parent, not at the end of the document. See the `siblingIndices.length === 0`
 * branch below.
 */
function insertAmongSiblings(
  list: Bookmark[],
  node: Bookmark,
  parentId: string,
  index?: number
): Bookmark[] {
  const siblingIndices = list.reduce<number[]>((acc, item, position) => {
    if (item.parentId === parentId) acc.push(position)
    return acc
  }, [])

  const next = [...list]

  if (siblingIndices.length === 0) {
    /*
      No siblings yet: the first child goes directly after its own folder, so a nested
      folder's contents sit next to it in the file.

      That is not cosmetic. A user who opens the document to inspect it, and any future
      export, reads the array in order; scattering a folder's first child to the far end
      makes the file unreadable and makes every diff after an edit look like a
      rearrangement. A root has no node to sit after, so its first child goes at the end.
    */
    const parentPosition = next.findIndex((item) => item.id === parentId)
    next.splice(parentPosition === -1 ? next.length : parentPosition + 1, 0, node)
    return next
  }

  const target = index ?? siblingIndices.length
  const clamped = Math.max(0, Math.min(Math.trunc(target), siblingIndices.length))
  const absolute =
    clamped >= siblingIndices.length
      ? (siblingIndices.at(-1) ?? 0) + 1
      : (siblingIndices[clamped] ?? 0)

  next.splice(absolute, 0, node)
  return next
}

// --- reads that the page performs -------------------------------------------

export interface BookmarkQuery {
  /** Case-insensitive fragment, matched against title and address. */
  text?: string
  /** Restrict to one root's subtree; both roots when omitted. */
  rootId?: BookmarkRootId
  limit?: number
}

/**
 * Matching nodes, folders included.
 *
 * Folders match on their title only — they have no address — and they are kept in the
 * result rather than filtered out, because a person searching for "Recipes" is usually
 * looking for the folder. The result is a flat list on purpose: a search that redrew the
 * tree with only matching branches would hide the matches inside a folder whose own name
 * did not match.
 */
export function queryBookmarks(nodes: readonly Bookmark[], query: BookmarkQuery): Bookmark[] {
  const needle = (query.text ?? '').trim().toLowerCase()
  const root = query.rootId
  const matches = nodes.filter((node) => {
    if (root !== undefined && rootIdOf(nodes, node.id) !== root) return false
    if (needle === '') return true
    if (node.title.toLowerCase().includes(needle)) return true
    return node.kind === 'bookmark' && node.url.toLowerCase().includes(needle)
  })

  const limit = query.limit === undefined ? matches.length : Math.max(0, Math.trunc(query.limit))
  return matches.slice(0, limit)
}

// --- repair ------------------------------------------------------------------

/**
 * Makes a loaded document obey the invariants the write path maintains.
 *
 * Four things can be wrong in a file that still validates against the schema, and each is
 * healed rather than rejected — a document that fails validation is replaced by an empty
 * one, and losing somebody's whole bookmark collection because one `parentId` was wrong
 * would be the worst possible reading of "inconsistent".
 *
 *   - **A duplicate id.** Two nodes with one id make every lookup answer whichever came
 *     first, so a delete removes one row and an update writes to the other. The later one
 *     goes.
 *   - **A missing or non-folder parent.** Re-parented to `BOOKMARK_OTHER_ID`, not to the
 *     bar: the bar is visible chrome, and silently adding rows to it on startup would
 *     rearrange the interface in front of the user. "Other bookmarks" is where something
 *     recovered belongs.
 *   - **A cycle.** Broken by re-parenting the first node of the ring to `other`. This is
 *     the one repair that is not merely tidiness: without it every traversal here relies on
 *     its `seen` guard to terminate, and the guards would be silently load-bearing forever.
 *   - **A folder carrying an address**, which no write path produces but a hand-edited file
 *     can. Cleared, because a folder that navigates somewhere is a row with two meanings.
 *
 * Deliberately *not* done here: re-validating each address against
 * `classifyOmniboxInput`. Narrowing what counts as an address later would then delete every
 * affected bookmark on the next start — a data-loss trap disguised as a cleanup. The same
 * decision `repairHistory` documents.
 */
export function repairBookmarks(nodes: readonly Bookmark[]): Bookmark[] {
  const byId = new Map<string, Bookmark>()
  for (const node of nodes) {
    // A node claiming a reserved root id is a node that would shadow a root; treated as a
    // duplicate, which drops it.
    if (isBookmarkRootId(node.id)) continue
    if (byId.has(node.id)) continue
    byId.set(node.id, node.kind === 'folder' && node.url !== '' ? { ...node, url: '' } : node)
  }

  const acyclic = breakCycles(reparentOrphans([...byId.values()]))
  /*
    Orphans are healed a second time, after pruning, and that is not belt-and-braces.

    `pruneToLimit` drops whole nodes by age, and nothing guarantees a folder is older than
    what it contains — an imported file carries the other browser's timestamps. So a prune
    can take a folder and leave its children, which is exactly the dangling `parentId` the
    first pass just fixed.
  */
  return reparentOrphans(pruneToLimit(acyclic))
}

/** Anything whose parent is neither a root nor an existing folder lands in `other`. */
function reparentOrphans(nodes: readonly Bookmark[]): Bookmark[] {
  const folders = new Set(nodes.filter((node) => node.kind === 'folder').map((node) => node.id))
  return nodes.map((node) =>
    isBookmarkRootId(node.parentId) || folders.has(node.parentId)
      ? node
      : { ...node, parentId: BOOKMARK_OTHER_ID }
  )
}

/**
 * Re-parents any node that is its own ancestor to `other`.
 *
 * Walking up from every node and stopping at a root is the whole test: a chain that never
 * reaches a root is a ring. Cheap enough to run on load — at the cap, ten thousand walks
 * over a tree that is a few levels deep.
 */
function breakCycles(nodes: readonly Bookmark[]): Bookmark[] {
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]))
  const looping = new Set<string>()

  for (const node of nodes) {
    const seen = new Set<string>([node.id])
    let current = node.parentId
    while (!isBookmarkRootId(current)) {
      if (seen.has(current)) {
        looping.add(node.id)
        break
      }
      seen.add(current)
      const next = parents.get(current)
      if (next === undefined) break
      current = next
    }
  }

  if (looping.size === 0) return [...nodes]
  return nodes.map((node) =>
    looping.has(node.id) ? { ...node, parentId: BOOKMARK_OTHER_ID } : node
  )
}

/**
 * Enforces the cap by dropping the newest entries.
 *
 * The *newest*, deliberately, and the opposite of what history does. History drops the
 * least recently visited because recency is what makes an entry useful there. A bookmark
 * has no recency — it is kept because somebody chose to keep it — so the only defensible
 * rule is that an over-full file loses what was added last rather than the collection
 * somebody built years ago.
 */
function pruneToLimit(nodes: readonly Bookmark[]): Bookmark[] {
  if (nodes.length <= MAX_BOOKMARKS) return [...nodes]
  const byAge = [...nodes].sort((left, right) => left.createdAt - right.createdAt)
  const kept = new Set(byAge.slice(0, MAX_BOOKMARKS).map((node) => node.id))
  return nodes.filter((node) => kept.has(node.id))
}
