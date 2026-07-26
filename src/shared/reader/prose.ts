import { isFurniture } from './names.js'
import {
  MIN_BLOCK_CHARS,
  elementsOf,
  isBodyBlock,
  isIgnorable,
  textOf,
  trimmedTextOf
} from './structure.js'
import type { ReaderElementNode } from './wire.js'

/**
 * How much article there is, and where it is.
 *
 * ## One measure instead of four weighted signals
 *
 * The obvious design is a score: so many points per paragraph, so many per thousand characters,
 * multiplied down by link density, multiplied down again by a negative class name. Every published
 * extractor is built that way and every one of them carries a table of weights that nobody can
 * justify, because the weights were fitted to whatever pages the author happened to test on.
 *
 * This measures one quantity instead — **prose mass** — and the four signals are properties of how
 * it is defined rather than terms added together:
 *
 *   - *paragraph count*: only text inside a block counts, so a container of forty `<span>`s holding
 *     menu labels measures zero however much text it has.
 *   - *text density*: a block shorter than `MIN_BLOCK_CHARS` contributes nothing, so captions,
 *     labels and one-line teasers do not accumulate into an article.
 *   - *link density*: link text is **subtracted** rather than penalised by a factor. A navigation
 *     column is entirely link text and therefore measures exactly zero, which is the honest answer;
 *     a paragraph with two links in it loses the width of those two links and stays prose.
 *   - *negative names*: a furniture subtree measures zero and is not descended into, so a comment
 *     thread cannot outweigh the article it is attached to.
 *
 * The result is a single number in a unit that means something — characters of article text — which
 * is what makes it possible to state a refusal threshold that a person can argue with. A score in
 * arbitrary points cannot be argued with; it can only be tuned until the pages in front of you pass.
 *
 * ## Finding the container by descent rather than by ranking
 *
 * Ranking every element by mass and taking the maximum always picks `<body>`, since mass accumulates
 * upward. Ranking by mass per node, or by density, is where the classic failure comes from: the
 * densest subtree of a nine-paragraph article is often a three-paragraph `<div>` inside it, and the
 * reader then stops mid-article with nothing to say it has.
 *
 * So the container is found by walking *down* from the root for as long as a single child still holds
 * `DESCEND_SHARE` of the **whole document's** mass. Measured against the document rather than
 * against the current node, that gives an invariant worth more than any amount of tuning: the
 * container that comes out holds at least `DESCEND_SHARE` of every character of prose on the page.
 * Truncation is not made unlikely, it is made impossible — as far as furniture detection is correct,
 * which is the honest boundary of the claim and is stated as such in the report.
 */

export interface ProseMeasure {
  /** Characters of block text with link text subtracted: the quantity the refusal is decided on. */
  readonly mass: number
  /** How many blocks reached `MIN_BLOCK_CHARS`. */
  readonly blocks: number
  /** All characters in those blocks, link text included. */
  readonly text: number
  /** Characters of link text in those blocks. */
  readonly linkText: number
}

const NOTHING: ProseMeasure = { mass: 0, blocks: 0, text: 0, linkText: 0 }

function add(left: ProseMeasure, right: ProseMeasure): ProseMeasure {
  return {
    mass: left.mass + right.mass,
    blocks: left.blocks + right.blocks,
    text: left.text + right.text,
    linkText: left.linkText + right.linkText
  }
}

/** Characters of text inside `<a>` descendants, which is what a navigation block is made of. */
function linkTextLengthOf(node: ReaderElementNode): number {
  if (isIgnorable(node) || isFurniture(node)) return 0
  if (node.tag === 'a') return textOf(node).length
  return elementsOf(node).reduce((sum, child) => sum + linkTextLengthOf(child), 0)
}

function measureBlock(node: ReaderElementNode): ProseMeasure {
  const text = trimmedTextOf(node).length
  if (text < MIN_BLOCK_CHARS) return NOTHING
  const linkText = Math.min(text, linkTextLengthOf(node))
  return { mass: text - linkText, blocks: 1, text, linkText }
}

/**
 * A measured element and its measured children.
 *
 * A parallel tree rather than a `Map` keyed by node, so that every lookup the descent makes is a
 * field access that cannot miss. A map would have needed a `?? nothing` at each read — a branch that
 * can never be taken, which no test can reach and which therefore reads to the next person as a case
 * somebody thought was possible.
 *
 * `children` is empty for a subtree the descent must not enter: furniture, something the page was
 * not showing, and — the important one — a block of body copy. Without that last case the descent
 * would walk into a single long paragraph holding nine tenths of the page and call *it* the article,
 * dropping its siblings with nothing rendered to suggest they had existed.
 */
interface Measured {
  readonly node: ReaderElementNode
  readonly measure: ProseMeasure
  readonly children: readonly Measured[]
}

function measuredOf(node: ReaderElementNode): Measured {
  if (isIgnorable(node) || isFurniture(node)) return { node, measure: NOTHING, children: [] }
  if (isBodyBlock(node)) return { node, measure: measureBlock(node), children: [] }
  const children = elementsOf(node).map((child) => measuredOf(child))
  return {
    node,
    measure: children.reduce((sum, child) => add(sum, child.measure), NOTHING),
    children
  }
}

/**
 * Above this share of the document's prose, a single child is the article and its parent is a
 * wrapper.
 *
 * Nine tenths, and the number is chosen for what it *guarantees* rather than for how it performs:
 * the container that comes out of the descent holds at least nine tenths of the page's prose, so the
 * worst truncation reader mode can produce is one paragraph in ten — and even that only when a page
 * puts a tenth of its article outside the element that holds the rest.
 *
 * A share above one half has a second, quieter benefit: at most one child can ever qualify, because
 * siblings hold disjoint text. There is no tie to break, so there is no tie-breaking rule to get
 * wrong.
 */
export const DESCEND_SHARE = 0.9

export interface ProseChoice {
  /** The element the article will be taken from. */
  readonly container: ReaderElementNode
  /** Root first, container last — so `metadata.ts` can look for a headline above the container. */
  readonly path: readonly ReaderElementNode[]
  readonly measure: ProseMeasure
  /** The whole document's prose mass, furniture excluded. What `measure.mass` is a share of. */
  readonly documentMass: number
}

/**
 * The element the article is in.
 *
 * Total: the root is always an answer, so there is no "no container found" case for a caller to
 * handle. Whether that answer is *an article* is a separate question, decided in `extract.ts`
 * against the mass this reports.
 */
export function chooseContainer(root: ReaderElementNode): ProseChoice {
  const tree = measuredOf(root)
  const documentMass = tree.measure.mass
  const wanted = DESCEND_SHARE * documentMass

  const path: ReaderElementNode[] = [root]
  let current = tree
  for (;;) {
    const next = current.children.find(
      (child) =>
        // `> 0` as well as the share, because a document with no prose at all makes `wanted` zero,
        // and every child would then clear the threshold: the descent would walk into whichever
        // branch happened to come first and report it as the article.
        child.measure.mass > 0 && child.measure.mass >= wanted && child.children.length > 0
    )
    if (next === undefined) break
    path.push(next.node)
    current = next
  }

  return { container: current.node, path, measure: current.measure, documentMass }
}
