import {
  BOOKMARK_BAR_ID,
  BOOKMARK_OTHER_ID,
  BookmarkLimitError,
  MAX_BOOKMARKS,
  bookmarkUrlOf,
  createBookmark,
  type Bookmark
} from './model.js'

/**
 * Reading the bookmark file every other browser exports.
 *
 * ## Why this exists at all
 *
 * A bookmarks feature nobody can move their bookmarks into is a bookmarks feature nobody
 * uses. Chrome, Firefox, Edge and Safari all export the same 1996 Netscape format, so one
 * parser covers every migration a person will actually attempt — which is the reason this
 * was judged worth building rather than deferred.
 *
 * ## Why it is a tag scanner and not an HTML parser
 *
 * The format is not well-formed HTML and never was. `<DT>` is never closed, `<p>` appears
 * as a stray opening tag after every `<DL>`, and attribute values are sometimes unquoted.
 * Every browser reads it with a tolerant scanner for exactly that reason. A strict parser
 * would reject real files from real browsers, and there is no DOM here to hand it to
 * anyway: `shared` runs in the main process as well as in a renderer.
 *
 * The structure that matters is only this:
 *
 * ```
 * <DL>                          a folder's contents
 *   <DT><A HREF="…">title</A>   a bookmark
 *   <DT><H3>title</H3>          a folder, whose contents are the <DL> that follows
 *   <DL> … </DL>
 * </DL>
 * ```
 *
 * ## Why the file is untrusted input, emphatically
 *
 * It is a file the user picked, but its *contents* were written by whatever produced it —
 * and a bookmark file is a plausible thing to be sent. The two things it can carry that
 * matter:
 *
 *   - **`javascript:` URLs.** A bookmarklet is a script that runs in the origin of whatever
 *     page is open when it is clicked. Importing one as an ordinary-looking bookmark named
 *     "Invoices" is a stored cross-site-scripting primitive with a friendly label. Every
 *     address here goes through `bookmarkUrlOf`, which defers to the address bar's own
 *     classifier — and that classifier already refuses `javascript:`, `data:`, `blob:` and
 *     `vbscript:`. One opinion about what an address is, and the import path inherits it
 *     rather than growing a second, weaker one.
 *   - **Sheer size.** A hundred megabytes of `<A>` tags is a main process that stops
 *     answering. Bounded by `MAX_IMPORT_LENGTH` before the scan and by `MAX_BOOKMARKS`
 *     during the graft.
 *
 * Whatever is refused is *counted*, not silently dropped. "412 imported, 3 skipped" is
 * something a user can investigate; a file that half-arrived with no explanation is not.
 */

/**
 * Longest document scanned, in characters.
 *
 * Sixteen megabytes of markup is roughly a hundred thousand bookmarks — two orders of
 * magnitude past any real collection, and still small enough that the scan is milliseconds.
 */
export const MAX_IMPORT_LENGTH = 16 * 1024 * 1024

export interface ImportedBookmark {
  kind: 'bookmark' | 'folder'
  title: string
  /** Already normalised by `bookmarkUrlOf`; empty for a folder. */
  url: string
  /** From `ADD_DATE`, in milliseconds, or `null` when the file carried none. */
  addedAt: number | null
  /** Empty for a bookmark. */
  children: ImportedBookmark[]
  /**
   * The folder the exporting browser drew on its own toolbar.
   *
   * Only ever true for one folder in a result: a file that claims two — hand-edited, or
   * merged from two exports — would otherwise split the bar across both, and which one won
   * would depend on document order. The first claim wins and the rest import as ordinary
   * folders.
   */
  onToolbar: boolean
}

export interface ImportReport {
  nodes: ImportedBookmark[]
  /** Entries whose address was refused, or which arrived past the cap. */
  skipped: number
}

/** Named HTML entities that appear in real exports. Numeric references are decoded too. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' '
}

/**
 * Decodes the entities a bookmark title can contain.
 *
 * Titles are the one place the format is genuinely HTML-encoded — `AT&amp;T` is a real
 * bookmark name. Unknown entities are left as they stand rather than turned into a
 * replacement character: a title reading `&hellip;` is a cosmetic flaw, one reading `&#65533;`
 * is a bug report.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase()
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16)
      return codePointOrSelf(code, whole)
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10)
      return codePointOrSelf(code, whole)
    }
    return NAMED_ENTITIES[lower] ?? whole
  })
}

/**
 * A numeric reference outside Unicode, or a surrogate, comes back as itself.
 *
 * `String.fromCodePoint` throws on both, and a parser that throws on one malformed title
 * loses the whole file.
 */
function codePointOrSelf(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return fallback
  if (code >= 0xd800 && code <= 0xdfff) return fallback
  return String.fromCodePoint(code)
}

/** Strips the tags a title may contain — real exports carry `<B>` and `<I>` inside `<A>`. */
function plainText(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim()
}

/**
 * One attribute's value, quoted or not.
 *
 * Case-insensitive because exporters disagree: Chrome writes `HREF`, Safari has written
 * `href`. Unquoted values stop at whitespace, which is what every browser does with them.
 */
function attributeOf(attributes: string, name: string): string | null {
  const quoted = new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes)
  if (quoted !== null) return quoted[1] ?? null
  const single = new RegExp(`${name}\\s*=\\s*'([^']*)'`, 'i').exec(attributes)
  if (single !== null) return single[1] ?? null
  const bare = new RegExp(`${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(attributes)
  return bare?.[1] ?? null
}

/**
 * `ADD_DATE` as milliseconds, or `null`.
 *
 * The format stores Unix *seconds*, which is the trap: taken as milliseconds every
 * imported bookmark would claim to have been added in January 1970, and sorting by age
 * would put a fresh import at the very bottom for ever. Values that are not a plausible
 * timestamp are dropped rather than guessed at, and the caller then uses the import time.
 */
function addDateOf(attributes: string): number | null {
  const raw = attributeOf(attributes, 'ADD_DATE')
  if (raw === null) return null
  const seconds = Number.parseInt(raw, 10)
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  return seconds * 1000
}

function claimsToolbar(attributes: string): boolean {
  return (attributeOf(attributes, 'PERSONAL_TOOLBAR_FOLDER') ?? '').toLowerCase() === 'true'
}

/**
 * Every construct the scanner reacts to, in one pass.
 *
 * `<DT>` is deliberately absent: it is never closed, carries nothing, and treating it as
 * structure is how a hand-written parser ends up with a nesting level per bookmark.
 */
const TOKENS = /<dl[^>]*>|<\/dl\s*>|<h3([^>]*)>([\s\S]*?)<\/h3\s*>|<a([^>]*)>([\s\S]*?)<\/a\s*>/gi

/**
 * Reads an exported bookmark file into a tree.
 *
 * Total: any input produces a report. A file that is not a bookmark file at all yields no
 * nodes and nothing skipped, which the caller shows as "nothing to import" — the honest
 * answer, and distinguishable from "the file was rejected".
 */
export function parseNetscapeBookmarks(html: string): ImportReport {
  const source = html.slice(0, MAX_IMPORT_LENGTH)
  const root: ImportedBookmark[] = []
  /** Where the next entry goes. The last element is the folder currently open. */
  const stack: ImportedBookmark[][] = [root]
  /** The folder announced by an `<H3>` and not yet opened by its `<DL>`. */
  let pending: ImportedBookmark | null = null
  let toolbarClaimed = false
  let skipped = 0

  TOKENS.lastIndex = 0
  let token: RegExpExecArray | null
  while ((token = TOKENS.exec(source)) !== null) {
    const [whole, h3Attributes, h3Text, aAttributes, aText] = token

    if (whole.toLowerCase().startsWith('</dl')) {
      // Never pop the root: a file with more closing tags than opening ones — truncated, or
      // simply sloppy — must not start writing into `stack[-1]`.
      if (stack.length > 1) stack.pop()
      pending = null
      continue
    }

    if (whole.toLowerCase().startsWith('<dl')) {
      const folder = pending
      pending = null
      if (folder === null) {
        /*
          A `<DL>` with no `<H3>` before it is the outermost list, or a stray one.

          Its contents belong to whatever is currently open rather than to a new anonymous
          folder — a nameless folder in the middle of an import is a row the user cannot
          identify. The level is pushed all the same, so the matching `</DL>` has something
          to close and the nesting stays balanced.
        */
        const [current] = stack.slice(-1)
        stack.push(current ?? root)
        continue
      }
      stack.push(folder.children)
      continue
    }

    if (h3Text !== undefined) {
      const onToolbar = !toolbarClaimed && claimsToolbar(h3Attributes ?? '')
      if (onToolbar) toolbarClaimed = true
      const folder: ImportedBookmark = {
        kind: 'folder',
        title: plainText(h3Text),
        url: '',
        addedAt: addDateOf(h3Attributes ?? ''),
        children: [],
        onToolbar
      }
      const [current] = stack.slice(-1)
      ;(current ?? root).push(folder)
      pending = folder
      continue
    }

    if (aText !== undefined) {
      const href = attributeOf(aAttributes ?? '', 'HREF')
      const url = href === null ? null : bookmarkUrlOf(decodeHtmlEntities(href))
      if (url === null) {
        // A `javascript:` bookmarklet, a `place:` query from Firefox's own sidebar, an
        // address past the length limit. Counted so the user hears about it.
        skipped += 1
        continue
      }
      const [current] = stack.slice(-1)
      ;(current ?? root).push({
        kind: 'bookmark',
        title: plainText(aText),
        url,
        addedAt: addDateOf(aAttributes ?? ''),
        children: [],
        onToolbar: false
      })
    }
  }

  return { nodes: root, skipped }
}

export interface GraftContext {
  /** A fresh id per node. The store supplies its own generator. */
  nextId: () => string
  now: number
  /** Name of the folder the import lands in. Supplied by the caller so it is translated. */
  folderTitle: string
}

export interface GraftResult {
  nodes: Bookmark[]
  imported: number
  /** Refused by the parser, plus anything that did not fit under `MAX_BOOKMARKS`. */
  skipped: number
}

/**
 * Adds a parsed tree to an existing document.
 *
 * Everything goes through `createBookmark`, which is the point: the limit, the title
 * cleaning and the parent rules are applied to imported data exactly as they are to a
 * bookmark the user makes by hand. A graft that wrote nodes directly would be a second
 * write path, and the first file that exercised a rule it had forgotten would be the one
 * that broke the document.
 *
 * Two routing decisions:
 *
 *   - The toolbar folder's *children* are grafted onto our own bar, rather than the folder
 *     itself being nested inside it. Chrome's bar becomes this browser's bar, which is what
 *     somebody importing expects to see. Nesting it would put every bar item one click away
 *     and leave the bar itself empty.
 *   - Everything else lands inside one new folder under "other bookmarks", named by the
 *     caller. A flat merge into the existing tree would be unreviewable and unundoable: the
 *     user could not tell afterwards which rows arrived and which were theirs.
 */
export function graftImportedBookmarks(
  nodes: readonly Bookmark[],
  report: ImportReport,
  context: GraftContext
): GraftResult {
  let current = [...nodes]
  let imported = 0
  let skipped = report.skipped

  const toolbar = report.nodes.find((node) => node.onToolbar)
  const rest = report.nodes.filter((node) => node !== toolbar)

  /*
    An explicit stack rather than recursion, and not as a style preference.

    Nesting depth here comes from the file, and the file is untrusted: a document with a
    hundred thousand nested `<DL>`s is easy to produce and would be a `RangeError` in the
    main process. Depth-first order is preserved by pushing a node's children in reverse.
  */
  const pending: Array<{ node: ImportedBookmark; parentId: string }> = []
  const pushChildren = (children: readonly ImportedBookmark[], parentId: string): void => {
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const [child] = children.slice(index, index + 1)
      if (child !== undefined) pending.push({ node: child, parentId })
    }
  }

  if (toolbar !== undefined) pushChildren(toolbar.children, BOOKMARK_BAR_ID)

  if (rest.length > 0) {
    const folderId = context.nextId()
    try {
      current = createBookmark(
        current,
        { kind: 'folder', title: context.folderTitle, parentId: BOOKMARK_OTHER_ID },
        { id: folderId, now: context.now }
      )
      imported += 1
      pushChildren(rest, folderId)
    } catch (error) {
      if (!(error instanceof BookmarkLimitError)) throw error
      skipped += countImported(rest)
    }
  }

  while (pending.length > 0) {
    const [work] = pending.splice(-1)
    if (work === undefined) continue
    const id = context.nextId()
    try {
      current = createBookmark(
        current,
        {
          kind: work.node.kind,
          title: work.node.title,
          parentId: work.parentId,
          ...(work.node.kind === 'folder' ? {} : { url: work.node.url })
        },
        // The exporting browser's own timestamp when it had one, so a fresh import does not
        // claim every bookmark was created today.
        { id, now: work.node.addedAt ?? context.now }
      )
    } catch (error) {
      /*
        The only refusal reachable from here: the document is full.

        Every address was normalised by the parser, and every parent id is one this loop
        created a moment ago, so nothing else `createBookmark` can throw applies. Rethrowing
        anything else keeps that assumption from quietly becoming a swallowed bug.
      */
      if (!(error instanceof BookmarkLimitError)) throw error
      skipped += 1 + countImported(work.node.children)
      continue
    }
    imported += 1
    pushChildren(work.node.children, id)
  }

  return { nodes: current, imported, skipped }
}

/** How many nodes a subtree would contribute, for an accurate "skipped" count. */
function countImported(nodes: readonly ImportedBookmark[]): number {
  let total = 0
  const queue = [...nodes]
  while (queue.length > 0) {
    const [node] = queue.splice(0, 1)
    if (node === undefined) continue
    total += 1
    queue.push(...node.children)
  }
  return total
}

/** Whether a document has room left, so a caller can refuse before reading a file. */
export function importCapacity(nodes: readonly Bookmark[]): number {
  return Math.max(0, MAX_BOOKMARKS - nodes.length)
}
