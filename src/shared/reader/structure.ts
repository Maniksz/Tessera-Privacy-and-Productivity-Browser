import type { ReaderElementNode, ReaderNode } from './wire.js'
import { NEVER_CONTENT_TAGS } from './wire.js'

/**
 * What counts as a block, what counts as inline, and where the line between them is.
 *
 * Its own module because both halves of reader mode need the same answer and must not each have
 * their own: `prose.ts` measures how much article text a container holds, `content.ts` decides what
 * to render, and a page that measured as an article and then rendered as three sentences would be
 * the exact failure this feature is supposed to avoid. One vocabulary, two readers.
 */

/**
 * Tags that flow inside a line of text.
 *
 * Used for one decision, and it is a load-bearing one: an element whose children are *all* inline is
 * a paragraph even when it is spelled `<div>`. Sites that build their body copy out of `<div>`s are
 * common enough that a paragraph rule limited to `<p>` measures a real article at nearly zero and
 * refuses it — which reads to the user as "reader mode does not work on this site".
 */
export const INLINE_TAGS: ReadonlySet<string> = new Set([
  'a',
  'abbr',
  'acronym',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'cite',
  'code',
  'data',
  'del',
  'dfn',
  'em',
  'font',
  'i',
  'ins',
  'kbd',
  'mark',
  'nobr',
  'q',
  'rp',
  'rt',
  'ruby',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr'
])

/**
 * Tags whose text is body copy.
 *
 * Headings are absent, and that is the decision worth stating: a page made only of headings — a
 * table of contents, a category index — would otherwise measure as a substantial article. A heading
 * is a label for prose, so it is *kept* when an article is found (see `content.ts`) and it does not
 * help decide whether one was found.
 *
 * `figcaption` is absent for the same reason, and `td` because a cell is a value rather than a
 * sentence.
 */
export const BODY_BLOCK_TAGS: ReadonlySet<string> = new Set(['p', 'li', 'blockquote', 'pre', 'dd'])

/**
 * How long a block has to be to count as a sentence of an article.
 *
 * Forty characters is about seven words. Below it a block is a menu label, a caption, a byline, a
 * button's text or a table cell — the page is full of them and none of them is prose. The cost of
 * the cutoff is real and named in the report: dialogue and verse, where a paragraph legitimately is
 * four words, measure lower than they should.
 */
export const MIN_BLOCK_CHARS = 40

/** `1`–`6` for a heading tag, `null` for anything else. */
export function headingLevelOf(tag: string): number | null {
  const [, digit] = /^h([1-6])$/.exec(tag) ?? []
  return digit === undefined ? null : Number(digit)
}

/**
 * Nothing here contributes text, and nothing here is evidence about its parent either.
 *
 * The second half is the part that matters: `<div class="lede">Some text<script>…</script></div>` is
 * a paragraph, and a test for "are all my children inline" that counted the script would decide it
 * was a container of blocks and then find no blocks in it. The transcription already drops scripts,
 * so this only bites on markup handed in directly — but the two paths have to agree.
 */
export function isIgnorable(node: ReaderElementNode): boolean {
  return node.hidden === true || NEVER_CONTENT_TAGS.has(node.tag)
}

/** Whether every child of this element flows inside a line of text. */
export function isInlineOnly(node: ReaderElementNode): boolean {
  return node.children.every(
    (child) => child.kind === 'text' || isIgnorable(child) || INLINE_TAGS.has(child.tag)
  )
}

/**
 * Whether this element is a block of body copy rather than a container of blocks.
 *
 * Two ways to qualify: a tag that says so, or a tag that says nothing and children that are all
 * inline. A heading never qualifies — see `BODY_BLOCK_TAGS`.
 */
export function isBodyBlock(node: ReaderElementNode): boolean {
  if (isIgnorable(node)) return false
  if (headingLevelOf(node.tag) !== null) return false
  if (BODY_BLOCK_TAGS.has(node.tag)) return true
  if (node.tag === 'figcaption') return false
  return isInlineOnly(node)
}

/** The element children of a node, skipping text. */
export function elementsOf(node: ReaderElementNode): readonly ReaderElementNode[] {
  return node.children.filter(
    (child): child is ReaderElementNode => child.kind === 'element'
  )
}

/**
 * The first descendant matching `wanted`, in document order, or null.
 *
 * `skip` is a parameter rather than a constant because the two callers want different answers and
 * both are right. Looking for a headline skips furniture, so that the site's wordmark in the
 * masthead cannot become the article's title. Looking for a byline must *not* skip furniture,
 * because `.byline` is itself in the furniture vocabulary — the box holding the author's name is not
 * article prose, which is exactly why it is excluded from the measurement and exactly why it is the
 * first place to look for the author.
 */
export function findElement(
  node: ReaderElementNode,
  wanted: (candidate: ReaderElementNode) => boolean,
  skip: (candidate: ReaderElementNode) => boolean
): ReaderElementNode | null {
  for (const child of elementsOf(node)) {
    if (skip(child)) continue
    if (wanted(child)) return child
    const found = findElement(child, wanted, skip)
    if (found !== null) return found
  }
  return null
}

/**
 * All text under a node, with whitespace runs collapsed but edges left alone.
 *
 * Edges are deliberately not trimmed here: `<p>Read <a>the notice</a> now.</p>` is three text runs,
 * and trimming each of them would produce "Readthe noticenow.". Trimming happens once per block,
 * at its two ends, in `content.ts`.
 */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** The visible text of a subtree, collapsed and trimmed. Used for measurement and for metadata. */
export function textOf(node: ReaderNode): string {
  if (node.kind === 'text') return collapse(node.text)
  if (isIgnorable(node)) return ''
  return node.children.map((child) => textOf(child)).join('')
}

/** The same, trimmed — what a caller comparing against a threshold or a name actually wants. */
export function trimmedTextOf(node: ReaderNode): string {
  return textOf(node).trim()
}
