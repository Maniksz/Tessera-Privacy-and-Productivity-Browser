import { isFurniture, nameWordsOf } from './names.js'
import type { ProseChoice } from './prose.js'
import { findElement, headingLevelOf, isIgnorable, trimmedTextOf } from './structure.js'
import type { ReaderDocument, ReaderElementNode } from './wire.js'

/**
 * The headline, the author and the date — from evidence only.
 *
 * ## Why the `<title>` element is the last resort rather than the first
 *
 * `document.title` is the one string every page has, and it is almost never the headline. It is the
 * headline *plus the site name*, in whichever order and with whichever separator the publisher's
 * template chose, and often with a category and a page number as well. A reader view whose heading
 * says "Council rejects plan – Local News – Example Herald – Page 2" has told the user something
 * about the CMS rather than about the article.
 *
 * So the search starts where the answer is unambiguous — the `<h1>` inside the container the article
 * was found in — and only falls back to `<title>` when nothing else said anything. And when it does
 * fall back, the site name is stripped **only** if the page itself said what its site is called, via
 * `og:site_name` or `application-name`. Guessing that the shortest segment is the site name works on
 * most pages and mangles the rest, and a mangled headline is worse than a long one because the user
 * cannot tell it was mangled.
 *
 * ## Why the byline search does not skip furniture and the headline search does
 *
 * A byline lives in exactly the kind of box the furniture vocabulary is built to exclude — that is
 * why `byline` is one of its words. It is not article prose and must not count toward the
 * measurement, and it is still the first place to look for the author's name. The headline search
 * does skip furniture, for the mirror-image reason: on a great many sites the site's own wordmark is
 * an `<h1>` in the masthead, and a document-wide search that did not skip it would title every
 * article on the site after the site.
 *
 * ## Nothing is inferred from prose
 *
 * There is no "the first line looks like a name" rule and no date parsing out of body text. Both are
 * easy to write, both work on the pages you test them on, and both fail by attributing an article to
 * the wrong person or dating it wrongly — errors that look like facts. `null` is a better answer, and
 * the reader page simply leaves the line out.
 */

export interface ReaderMetadata {
  readonly title: string | null
  readonly byline: string | null
  /** As the page stated it — an ISO timestamp in practice. Formatted, or shown verbatim, by the page. */
  readonly publishedAt: string | null
  /** BCP 47, from the container's own `lang` if it has one, otherwise the document's. */
  readonly lang: string | null
}

/** Longer than this and it is a summary, a whole first paragraph, or a template gone wrong. */
const MAX_TITLE_CHARS = 200

/** Longer than this and it is an author *biography*, not a byline. */
const MAX_BYLINE_CHARS = 120

/** Longer than this and it is not a date, whatever attribute it came out of. */
const MAX_DATE_CHARS = 64

/** Separators publishers put between a headline and a site name, widest first. */
const TITLE_SEPARATORS: readonly string[] = [' | ', ' — ', ' – ', ' - ', ' :: ', ' · ']

function skipFurniture(node: ReaderElementNode): boolean {
  return isIgnorable(node) || isFurniture(node)
}

/** The first non-null candidate that is neither empty nor implausibly long. */
function firstUsable(candidates: readonly (string | null | undefined)[], limit: number): string | null {
  for (const candidate of candidates) {
    const value = (candidate ?? '').trim()
    if (value !== '' && value.length <= limit) return value
  }
  return null
}

function textOfFirst(
  root: ReaderElementNode,
  wanted: (candidate: ReaderElementNode) => boolean,
  skip: (candidate: ReaderElementNode) => boolean
): string | null {
  const found = findElement(root, wanted, skip)
  return found === null ? null : trimmedTextOf(found)
}

/**
 * `document.title` without the site's own name.
 *
 * Only when the page said what its name is. `.some()` over a one-element slice rather than an index
 * plus a guard: `split` always yields a first and a last element, so a guard here would be a branch
 * no test could ever take.
 */
export function withoutSiteName(
  documentTitle: string,
  meta: Readonly<Record<string, string>>
): string {
  const site = (meta['og:site_name'] ?? meta['application-name'] ?? '').trim().toLowerCase()
  const whole = documentTitle.trim()
  if (site === '') return whole

  const matchesSite = (value: string): boolean => value.trim().toLowerCase() === site
  for (const separator of TITLE_SEPARATORS) {
    const parts = whole.split(separator)
    if (parts.length < 2) continue
    if (parts.slice(-1).some(matchesSite)) return parts.slice(0, -1).join(separator).trim()
    if (parts.slice(0, 1).some(matchesSite)) return parts.slice(1).join(separator).trim()
  }
  return whole
}

function titleOf(document: ReaderDocument, container: ReaderElementNode): string | null {
  const isHeading = (node: ReaderElementNode): boolean => headingLevelOf(node.tag) === 1
  return firstUsable(
    [
      // The article's own headline, inside the container the prose was found in. Unambiguous when it
      // exists, which is most of the time.
      textOfFirst(container, isHeading, skipFurniture),
      textOfFirst(
        document.root,
        (node) => node.attributes['itemprop'] === 'headline',
        skipFurniture
      ),
      document.meta['og:title'],
      document.meta['twitter:title'],
      textOfFirst(document.root, isHeading, skipFurniture),
      withoutSiteName(document.documentTitle, document.meta)
    ],
    MAX_TITLE_CHARS
  )
}

/**
 * Strips a leading "by" or "von" so the page can put its own label in front of the name.
 *
 * Two languages spelled out in shared code, and they are not user-visible strings: they are input the
 * parser has to recognise, in the two languages this browser ships. Without it, a page whose markup
 * says "By Jane Doe" renders as "By By Jane Doe" — and the alternative, an unlabelled name, reads as
 * a stray line of text.
 */
function withoutByPrefix(value: string): string {
  return value.replace(/^(?:by|von)\b[\s:]*/i, '').trim()
}

function bylineOf(document: ReaderDocument): string | null {
  const { root } = document
  const author = findElement(root, (node) => node.attributes['itemprop'] === 'author', isIgnorable)
  // schema.org nests the name inside the author: `<span itemprop="author"><span itemprop="name">`.
  const authorName =
    author === null
      ? null
      : (textOfFirst(author, (node) => node.attributes['itemprop'] === 'name', isIgnorable) ??
        trimmedTextOf(author))

  const candidates = [
    textOfFirst(root, (node) => node.attributes['rel'] === 'author', isIgnorable),
    authorName,
    document.meta['author'],
    textOfFirst(
      root,
      (node) => nameWordsOf(node).some((word) => word === 'byline' || word === 'author'),
      isIgnorable
    )
  ]
  return firstUsable(
    candidates.map((candidate) => (candidate == null ? null : withoutByPrefix(candidate))),
    MAX_BYLINE_CHARS
  )
}

function dateAttributeOf(node: ReaderElementNode): string {
  // `content` before `datetime`: schema.org markup states the machine-readable value in `content`,
  // and a `<time>` carrying both has the human-facing text in `datetime` only by accident.
  return node.attributes['content'] ?? node.attributes['datetime'] ?? ''
}

function publishedAtOf(document: ReaderDocument, container: ReaderElementNode): string | null {
  const { root } = document
  const hasDateTime = (node: ReaderElementNode): boolean =>
    node.tag === 'time' && (node.attributes['datetime'] ?? '') !== ''
  const published = findElement(
    root,
    (node) => node.attributes['itemprop'] === 'datePublished',
    isIgnorable
  )
  const inContainer = findElement(container, hasDateTime, isIgnorable)
  const anywhere = findElement(root, hasDateTime, isIgnorable)

  return firstUsable(
    [
      inContainer === null ? null : dateAttributeOf(inContainer),
      published === null ? null : dateAttributeOf(published),
      document.meta['article:published_time'],
      document.meta['date'],
      anywhere === null ? null : dateAttributeOf(anywhere)
    ],
    MAX_DATE_CHARS
  )
}

function langOf(document: ReaderDocument, path: readonly ReaderElementNode[]): string | null {
  // The nearest declaration wins, so a German article on an English site is read as German. The
  // path is root-first, hence the last non-empty one.
  const [nearest] = path
    .map((node) => (node.attributes['lang'] ?? '').trim())
    .filter((value) => value !== '')
    .slice(-1)
  const lang = (nearest ?? document.lang).trim()
  return lang === '' ? null : lang
}

export function metadataOf(document: ReaderDocument, choice: ProseChoice): ReaderMetadata {
  return {
    title: titleOf(document, choice.container),
    byline: bylineOf(document),
    publishedAt: publishedAtOf(document, choice.container),
    lang: langOf(document, choice.path)
  }
}
