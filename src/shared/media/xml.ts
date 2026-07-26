/**
 * A reader for the subset of XML a DASH manifest is written in.
 *
 * ## Why this is hand-written
 *
 * There is no XML parser here to use. `DOMParser` is a browser API and the main
 * process has none; `node:` modules are forbidden in `src/shared/` by an
 * architecture test, because a renderer imports this directory. A dependency
 * would have to be justified against a budget of eight (two are in use), and
 * would land in the bundle the user waits for — for a document format whose
 * relevant part is elements, attributes and nesting.
 *
 * ## What it is not
 *
 * Not a conforming parser, and it must not be mistaken for one. No namespace
 * resolution (prefixes are stripped, so `cenc:pssh` reads as `pssh`), no entity
 * declarations beyond the five predefined ones and numeric references, no schema,
 * no validation. A malformed document yields a partial tree rather than an error,
 * which is the right trade here: the manifest comes from the network, and the goal
 * is to learn what qualities exist, not to certify the document.
 *
 * Attribute entity decoding is the one piece that is not optional. Segment
 * templates and `BaseURL` routinely carry query strings, so `&amp;` appears in
 * ordinary manifests, and reading it literally produces addresses that 404.
 */

export interface XmlNode {
  /** Local name, namespace prefix removed, original case kept. */
  readonly name: string
  readonly attributes: Readonly<Record<string, string>>
  readonly children: readonly XmlNode[]
  /** Character data directly inside this element, concatenated. */
  readonly text: string
}

interface MutableNode {
  name: string
  attributes: Record<string, string>
  children: MutableNode[]
  text: string
}

const PREDEFINED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'"
}

function fromCodePoint(value: number, original: string): string {
  // Outside the Unicode range `String.fromCodePoint` throws, and an unparseable
  // reference is better left as written than turned into an exception.
  return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : original
}

export function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g,
    (whole: string, body: string) => {
      if (body.startsWith('#x') || body.startsWith('#X')) {
        return fromCodePoint(Number.parseInt(body.slice(2), 16), whole)
      }
      if (body.startsWith('#')) return fromCodePoint(Number.parseInt(body.slice(1), 10), whole)
      return PREDEFINED_ENTITIES[body.toLowerCase()] ?? whole
    }
  )
}

/** `cenc:pssh` -> `pssh`. */
function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1)
}

const ATTRIBUTE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function parseAttributes(text: string): Record<string, string> {
  const attributes: Record<string, string> = {}
  ATTRIBUTE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = ATTRIBUTE.exec(text)) !== null) {
    // Group 2 is the double-quoted form, group 3 the single-quoted one; the
    // alternation guarantees exactly one of them matched.
    attributes[localName(match[1]!)] = decodeXmlEntities(match[2] ?? match[3]!)
  }
  return attributes
}

/**
 * Removes everything that is not an element or character data.
 *
 * CDATA sections go with it: the only one that occurs in an MPD wraps a
 * `cenc:pssh` blob, which this reader has no use for — the presence of the
 * `ContentProtection` element around it is what matters.
 */
function stripNonElements(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\?[\s\S]*?\?>/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<!DOCTYPE[^>]*>/gi, ' ')
}

/**
 * Matches one tag.
 *
 * The middle group has to allow `>` inside quoted attribute values — a segment
 * template with a `>` in a query string is unusual but legal, and a `[^>]*` middle
 * would cut the tag in half and shift every subsequent element. The self-closing
 * slash is not captured separately because the greedy middle group would swallow
 * it; it is recognised afterwards instead.
 */
const TAG = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g

/**
 * The document's root element, or null when there is no element at all.
 *
 * Text outside the root is discarded, and a mismatched closing tag pops to the
 * nearest matching open element rather than abandoning the tree — the tolerance a
 * document from the network needs.
 */
export function parseXml(source: string): XmlNode | null {
  const text = stripNonElements(source)
  const roots: MutableNode[] = []
  const stack: MutableNode[] = []

  TAG.lastIndex = 0
  let cursor = 0
  let match: RegExpExecArray | null
  while ((match = TAG.exec(text)) !== null) {
    const open = stack.at(-1)
    if (open !== undefined) open.text += text.slice(cursor, match.index)
    cursor = TAG.lastIndex

    const name = localName(match[2]!)
    if (match[1] === '/') {
      const depth = stack.findLastIndex((node) => node.name === name)
      // A close tag matching nothing on the stack is ignored; popping blindly
      // would reparent every element that follows.
      if (depth >= 0) stack.length = depth
      continue
    }

    // Group 3 is a `*` repetition, so it always participated in the match — an
    // empty string for `<a>`, the attribute text otherwise. No fallback to cover.
    const body = match[3]!.trimEnd()
    const selfClosing = body.endsWith('/')
    const node: MutableNode = {
      name,
      attributes: parseAttributes(selfClosing ? body.slice(0, -1) : body),
      children: [],
      text: ''
    }
    if (open === undefined) roots.push(node)
    else open.children.push(node)
    if (!selfClosing) stack.push(node)
  }

  return roots.at(0) ?? null
}

/** Direct children with this local name. */
export function childrenNamed(node: XmlNode, name: string): readonly XmlNode[] {
  return node.children.filter((child) => child.name === name)
}

/** Every descendant with this local name, at any depth, document order. */
export function descendantsNamed(node: XmlNode, name: string): readonly XmlNode[] {
  const found: XmlNode[] = []
  const visit = (current: XmlNode): void => {
    for (const child of current.children) {
      if (child.name === name) found.push(child)
      visit(child)
    }
  }
  visit(node)
  return found
}
