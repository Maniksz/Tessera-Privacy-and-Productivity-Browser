import { linkTargetOf } from './links.js'
import { isFurniture } from './names.js'
import {
  INLINE_TAGS,
  collapse,
  elementsOf,
  findElement,
  headingLevelOf,
  isIgnorable
} from './structure.js'
import type { ReaderElementNode, ReaderNode } from './wire.js'

/**
 * What survives from the article container, as blocks rather than as markup.
 *
 * ## Why not markup
 *
 * The tempting shape for this is a string of sanitised HTML, because the reader page could then set
 * it and be done. That would be the worst hole in the project: an internal `tessera://` page holds a
 * bridge to the core, and putting a visited site's markup inside such a document — however
 * sanitised — makes every bug in the sanitiser a privilege escalation. A blocks-and-runs
 * representation cannot express a script, an event handler, an iframe or a style, so there is no
 * sanitiser to have a bug in. The reader page walks this structure and builds React elements, and
 * every string in it lands in a text node.
 *
 * ## What is kept, and the one thing that is not
 *
 * Headings, paragraphs, lists, blockquotes, preformatted code, figures with their captions, and
 * tables. Dropped: everything in `NEVER_CONTENT_TAGS` (scripts, styles, forms, frames, media
 * elements), everything `names.ts` calls furniture, and everything the page was not showing — which
 * is the same set a cosmetic filter rule would have hidden, because a hidden element and a blocked
 * one are the same computed style.
 *
 * A figure keeps its image's address and its alternative text but the reader page does **not** fetch
 * the pixels; see the CSP in `reader.html` for that decision and its cost.
 */

/**
 * Marks that apply to a run of text, in the order a run always lists them.
 *
 * A constant rather than a bare union so `schema.ts` can build its enumeration from it: a validator
 * that restated the three names by hand would go stale the first time a fourth was added, and it
 * would go stale silently — a rejected response looks to the reader page exactly like a core that
 * failed.
 */
export const READER_MARKS = ['strong', 'emphasis', 'code'] as const

export type ReaderMark = (typeof READER_MARKS)[number]

/**
 * One run of text inside a block, with the marks and the link that apply to it.
 *
 * Marks as a set rather than as nested runs, because `<strong><em>` and `<em><strong>` mean the same
 * thing and a nested representation would render the same sentence two different ways depending on
 * which the author wrote. `href` is `null` rather than absent so two runs can be compared for
 * merging without either side having to know which fields are optional.
 */
export interface ReaderInline {
  readonly text: string
  readonly marks: readonly ReaderMark[]
  /** Always `http`, `https` or `mailto`; see `links.ts`. */
  readonly href: string | null
}

export interface ReaderListItem {
  readonly blocks: readonly ReaderBlock[]
}

export interface ReaderTableRow {
  readonly header: boolean
  readonly cells: readonly (readonly ReaderInline[])[]
}

export type ReaderBlock =
  | { readonly kind: 'heading'; readonly level: number; readonly inlines: readonly ReaderInline[] }
  | { readonly kind: 'paragraph'; readonly inlines: readonly ReaderInline[] }
  | { readonly kind: 'quote'; readonly blocks: readonly ReaderBlock[] }
  | { readonly kind: 'list'; readonly ordered: boolean; readonly items: readonly ReaderListItem[] }
  | { readonly kind: 'code'; readonly text: string }
  | {
      readonly kind: 'figure'
      /** Absolute, or empty when the figure is a caption with no image. */
      readonly src: string
      readonly alt: string
      readonly caption: readonly ReaderInline[]
    }
  | { readonly kind: 'table'; readonly rows: readonly ReaderTableRow[] }

/** Tags that add a mark to the text inside them. */
const MARK_TAGS: Readonly<Record<string, ReaderMark>> = {
  strong: 'strong',
  b: 'strong',
  em: 'emphasis',
  i: 'emphasis',
  cite: 'emphasis',
  code: 'code',
  kbd: 'code',
  samp: 'code',
  var: 'code'
}

function marksWith(marks: readonly ReaderMark[], tag: string): readonly ReaderMark[] {
  const added = MARK_TAGS[tag]
  if (added === undefined || marks.includes(added)) return marks
  // Rebuilt in canonical order rather than appended, so `<em><strong>x` and `<strong><em>x` produce
  // the same run and can merge with each other.
  const wanted = new Set([...marks, added])
  return READER_MARKS.filter((mark) => wanted.has(mark))
}

function runsOf(
  node: ReaderNode,
  marks: readonly ReaderMark[],
  href: string | null
): readonly ReaderInline[] {
  if (node.kind === 'text') return [{ text: collapse(node.text), marks, href }]
  if (isIgnorable(node) || isFurniture(node)) return []
  // A line break becomes a space rather than a block boundary. Splitting on it would turn a poem or
  // an address into a dozen paragraphs; joining loses a line ending in text that had no other
  // structure to lose.
  if (node.tag === 'br') return [{ text: ' ', marks, href }]
  const linked = node.tag === 'a' ? linkTargetOf(node.attributes['href']) : href
  return node.children.flatMap((child) => runsOf(child, marksWith(marks, node.tag), linked))
}

function sameStyle(left: ReaderInline, right: ReaderInline): boolean {
  return (
    left.href === right.href &&
    left.marks.length === right.marks.length &&
    left.marks.every((mark, index) => mark === right.marks[index])
  )
}

function merged(runs: readonly ReaderInline[]): readonly ReaderInline[] {
  return runs.reduce<readonly ReaderInline[]>((accumulated, run) => {
    const [previous] = accumulated.slice(-1)
    if (previous !== undefined && sameStyle(previous, run)) {
      return [...accumulated.slice(0, -1), { ...previous, text: previous.text + run.text }]
    }
    return [...accumulated, run]
  }, [])
}

/**
 * Trims the block's leading whitespace — from as many runs as it takes.
 *
 * The trap this avoids: `<p>Read <a href="…">the notice</a> first.</p>` is three runs, and trimming
 * each of them individually produces "Readthe noticefirst.". Whitespace is collapsed per run and
 * trimmed only at the block's two ends, which is where it is actually insignificant.
 */
function trimmedStart(runs: readonly ReaderInline[]): readonly ReaderInline[] {
  const [first, ...rest] = runs
  if (first === undefined) return []
  const text = first.text.trimStart()
  return text === '' ? trimmedStart(rest) : [{ ...first, text }, ...rest]
}

function trimmedEnd(runs: readonly ReaderInline[]): readonly ReaderInline[] {
  const [last] = runs.slice(-1)
  if (last === undefined) return []
  const text = last.text.trimEnd()
  return text === '' ? trimmedEnd(runs.slice(0, -1)) : [...runs.slice(0, -1), { ...last, text }]
}

/** The inline content of a list of nodes: collapsed, merged, trimmed at the edges. */
export function inlinesOf(nodes: readonly ReaderNode[]): readonly ReaderInline[] {
  const runs = nodes.flatMap((node) => runsOf(node, [], null)).filter((run) => run.text !== '')
  return trimmedEnd(trimmedStart(merged(runs)))
}

/** The plain text of a run of inline content — for comparisons, never for rendering. */
export function inlineTextOf(inlines: readonly ReaderInline[]): string {
  return inlines
    .map((inline) => inline.text)
    .join('')
    .trim()
}

/** Text with its whitespace intact, for a `<pre>` where the indentation is the content. */
function verbatimTextOf(node: ReaderNode): string {
  if (node.kind === 'text') return node.text
  if (isIgnorable(node)) return ''
  return node.children.map((child) => verbatimTextOf(child)).join('')
}

function tableRowsOf(node: ReaderElementNode, inHead: boolean): readonly ReaderTableRow[] {
  return elementsOf(node).flatMap((child): readonly ReaderTableRow[] => {
    if (child.tag === 'tr') {
      const cells = elementsOf(child).filter((cell) => cell.tag === 'th' || cell.tag === 'td')
      return [
        {
          header: inHead || cells.every((cell) => cell.tag === 'th'),
          cells: cells.map((cell) => inlinesOf(cell.children))
        }
      ]
    }
    if (child.tag === 'thead') return tableRowsOf(child, true)
    if (child.tag === 'tbody' || child.tag === 'tfoot') return tableRowsOf(child, false)
    return []
  })
}

function figureBlocks(node: ReaderElementNode): readonly ReaderBlock[] {
  const image = findElement(node, (candidate) => candidate.tag === 'img', isIgnorable)
  const captionNode = findElement(node, (candidate) => candidate.tag === 'figcaption', isIgnorable)
  const caption = captionNode === null ? [] : inlinesOf(captionNode.children)
  const src = image?.attributes['src'] ?? ''
  const alt = image?.attributes['alt'] ?? ''
  // A figure with neither a picture nor a caption is a layout wrapper wearing a semantic tag.
  if (src === '' && caption.length === 0) return []
  return [{ kind: 'figure', src, alt, caption }]
}

/**
 * A bare `<img>`, kept only when it has alternative text.
 *
 * Alternative text is the one piece of evidence on the element itself that somebody meant it to
 * carry information. Everything with an empty `alt` is a spacer, a tracking pixel, an icon or a
 * decoration — and since the reader page shows a figure as its caption and its alternative text, an
 * image with neither would render as an empty box with a link in it.
 */
function imageBlocks(node: ReaderElementNode): readonly ReaderBlock[] {
  const alt = node.attributes['alt'] ?? ''
  const src = node.attributes['src'] ?? ''
  if (alt === '' || src === '') return []
  return [{ kind: 'figure', src, alt, caption: [] }]
}

function blocksOfNode(node: ReaderElementNode): readonly ReaderBlock[] {
  if (isIgnorable(node)) return []

  const level = headingLevelOf(node.tag)
  if (level !== null) {
    const inlines = inlinesOf(node.children)
    return inlines.length === 0 ? [] : [{ kind: 'heading', level, inlines }]
  }
  if (node.tag === 'ul' || node.tag === 'ol') {
    const items = elementsOf(node)
      .filter((child) => child.tag === 'li' && !isIgnorable(child) && !isFurniture(child))
      .map((child) => ({ blocks: childBlocksOf(child) }))
      .filter((item) => item.blocks.length > 0)
    return items.length === 0 ? [] : [{ kind: 'list', ordered: node.tag === 'ol', items }]
  }
  if (node.tag === 'blockquote') {
    const blocks = childBlocksOf(node)
    return blocks.length === 0 ? [] : [{ kind: 'quote', blocks }]
  }
  if (node.tag === 'pre') {
    // Leading blank lines are the markup's indentation, trailing whitespace is the closing tag's.
    // Everything between them is the content and must survive exactly.
    const text = verbatimTextOf(node).replace(/^\n+/, '').replace(/\s+$/, '')
    return text === '' ? [] : [{ kind: 'code', text }]
  }
  if (node.tag === 'figure') return figureBlocks(node)
  if (node.tag === 'img') return imageBlocks(node)
  if (node.tag === 'table') {
    const rows = tableRowsOf(node, false)
    return rows.length === 0 ? [] : [{ kind: 'table', rows }]
  }
  return childBlocksOf(node)
}

/**
 * The blocks inside an element, with runs of inline content gathered into paragraphs.
 *
 * The gathering is what makes `<div>Some text<p>and more</p></div>` keep both halves. Walking only
 * the element children — the obvious implementation — silently drops every text node that is not
 * already wrapped in something, and the markup that does that is common enough (`<li>` with a
 * nested list, `<td>` with a trailing note, hand-written body copy) that the loss looks like a
 * broken extractor rather than a missing rule.
 */
function childBlocksOf(node: ReaderElementNode): readonly ReaderBlock[] {
  const blocks: ReaderBlock[] = []
  let pending: ReaderNode[] = []

  const flush = (): void => {
    const inlines = inlinesOf(pending)
    if (inlines.length > 0) blocks.push({ kind: 'paragraph', inlines })
    pending = []
  }

  for (const child of node.children) {
    if (child.kind === 'text' || INLINE_TAGS.has(child.tag)) {
      pending.push(child)
      continue
    }
    if (isIgnorable(child) || isFurniture(child)) continue
    flush()
    blocks.push(...blocksOfNode(child))
  }
  flush()
  return blocks
}

/**
 * Everything worth reading inside the article container.
 *
 * The container itself is never tested for furniture: it was chosen deliberately, and a publisher
 * whose article container carries `class="post promoted"` would otherwise get an empty reader view.
 * Its descendants are tested, which is where the vocabulary earns its place.
 */
export function blocksOf(container: ReaderElementNode): readonly ReaderBlock[] {
  return blocksOfNode(container)
}
