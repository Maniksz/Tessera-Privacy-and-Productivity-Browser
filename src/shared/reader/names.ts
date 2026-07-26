import { classifyClassName, classifyElementId, type IdentifierVerdict } from '../filters/identifiers.js'
import type { ReaderElementNode } from './wire.js'

/**
 * Which parts of a page are furniture rather than article.
 *
 * ## What `identifiers.ts` is used for here, and what it is not used for
 *
 * That module answers a different question — whether a name is stable enough to *build a filter
 * rule on* — and reusing it wholesale would be wrong. `#sidebar-1` is what WordPress emits for
 * every widget area ever created, and `identifiers.ts` refuses it (`counter-suffix`) because the
 * number will change. For reader mode the number is irrelevant: the word `sidebar` is still there
 * and still means what it says.
 *
 * So only the verdicts that mean **"this name contains no words at all"** are honoured here:
 * `hash-like`, `framework-prefix`, `not-an-identifier` and `too-short`. Those are the cases where
 * scanning a name for meaning produces meaning that is not there — `.css-1a2b3c` splits into parts
 * that could match anything — and they are exactly the cases where a hand-rolled vocabulary check
 * would otherwise invent a signal. Everything that is a word gets read.
 *
 * ## Why whole words only
 *
 * The same mistake `shared/url/domain.ts` documents for hostnames: a substring test for `ad` calls
 * `.adaptive-layout`, `.header-badge` and `.download` advertising, and calling the article container
 * an advert is the one error that leaves the reader with nothing at all. Names are split on
 * separators and on camel-case boundaries, and every comparison is against a whole word.
 *
 * ## Why a positive override exists
 *
 * `<article class="post promoted">` is real markup: a publisher marks its own piece as promoted on
 * the front page and keeps the class on the article page. A vocabulary check alone would discard the
 * article because it says "promo". So an element that declares itself the article — by tag, by ARIA
 * role, or by schema.org `itemprop` — is never furniture, whatever its classes say. The declaration
 * is the page's own explicit statement; the class name is an inference about it.
 */

/** Tags that are furniture by definition, whatever they are called. */
export const FURNITURE_TAGS: ReadonlySet<string> = new Set(['nav', 'aside', 'footer'])

/**
 * ARIA landmarks that cannot be the article.
 *
 * `main` and `article` are absent because they are the positive signal, not the negative one.
 * `region` is absent too: it means "a landmark worth naming", which an article often is.
 */
export const FURNITURE_ROLES: ReadonlySet<string> = new Set([
  'navigation',
  'banner',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'dialog',
  'alertdialog',
  'menu',
  'menubar',
  'toolbar',
  'tablist'
])

/**
 * Words that name something other than the article, matched per word.
 *
 * The list is short on purpose. Every entry costs the risk of removing an article whose author
 * happened to use the word, and the measure this feeds — prose mass in `prose.ts` — already
 * discards short blocks and link text, which is what most furniture is made of. These are the cases
 * that measure cannot see: a comment thread and a related-articles column are genuinely prose, in
 * genuine paragraphs, and are genuinely not the article the user asked to read.
 *
 * Deliberately absent: `header` (an article has one, holding its own headline and byline),
 * `author` (`metadata.ts` needs to find the byline, and an author box is short enough to carry no
 * mass), and `tag` (`.post-tags` is a line of links, so link discounting already handles it).
 */
export const FURNITURE_WORDS: ReadonlySet<string> = new Set([
  'nav',
  'navbar',
  'navigation',
  'menu',
  'menubar',
  'sidebar',
  'sidenav',
  'aside',
  'breadcrumb',
  'breadcrumbs',
  'masthead',
  'footer',
  'ad',
  'ads',
  'advert',
  'adverts',
  'advertising',
  'advertisement',
  'adsbygoogle',
  'sponsor',
  'sponsored',
  'promo',
  'promotion',
  'related',
  'recommended',
  'recommendations',
  'popular',
  'trending',
  'comment',
  'comments',
  'commenting',
  'disqus',
  'respond',
  'reply',
  'replies',
  'social',
  'share',
  'sharing',
  'subscribe',
  'subscription',
  'newsletter',
  'signup',
  'paywall',
  'cookie',
  'cookies',
  'consent',
  'gdpr',
  'modal',
  'popup',
  'lightbox',
  'toolbar',
  'pagination',
  'pager',
  'widget',
  'byline',
  'skip'
])

/** Verdicts meaning the name is a hash or a build artefact, so it holds no words to read. */
const WORDLESS_VERDICTS: ReadonlySet<IdentifierVerdict> = new Set<IdentifierVerdict>([
  'not-an-identifier',
  'too-short',
  'hash-like',
  'framework-prefix'
])

/**
 * The words in a name, or none when the name is not made of words.
 *
 * Camel case is split as well as hyphens and underscores, because `.relatedPosts` and
 * `.related-posts` are the same claim written two ways and a vocabulary that only understood one of
 * them would work on half the web.
 */
function wordsOf(name: string, verdict: IdentifierVerdict): readonly string[] {
  if (WORDLESS_VERDICTS.has(verdict)) return []
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .map((word) => word.toLowerCase())
    .filter((word) => word !== '')
}

/** Every readable word in an element's id and classes. Exported for the tests that pin the split. */
export function nameWordsOf(node: ReaderElementNode): readonly string[] {
  const fromId = wordsOf(node.id, classifyElementId(node.id))
  const fromClasses = node.classes.flatMap((name) => wordsOf(name, classifyClassName(name)))
  return [...fromId, ...fromClasses]
}

/**
 * Whether the element says of itself that it is the article.
 *
 * All four signals are declarations rather than inferences, which is why they outrank the
 * vocabulary: `<article>`, `<main>`, `role="main"`/`role="article"`, and schema.org's
 * `itemprop="articleBody"`.
 */
export function isArticleContainer(node: ReaderElementNode): boolean {
  if (node.tag === 'article' || node.tag === 'main') return true
  const role = node.attributes['role']
  if (role === 'main' || role === 'article') return true
  return node.attributes['itemprop'] === 'articleBody'
}

/**
 * Whether a subtree is furniture: navigation, comments, adverts, anything the page was not showing.
 *
 * Order matters. Hidden comes first because it is a fact rather than an inference, and the article
 * declaration comes before the vocabulary because a page's own statement about itself outranks a
 * guess made from its class names.
 */
export function isFurniture(node: ReaderElementNode): boolean {
  if (node.hidden === true) return true
  if (node.attributes['aria-hidden'] === 'true') return true
  if (isArticleContainer(node)) return false
  if (FURNITURE_TAGS.has(node.tag)) return true
  const role = node.attributes['role']
  if (role !== undefined && FURNITURE_ROLES.has(role)) return true
  return nameWordsOf(node).some((word) => FURNITURE_WORDS.has(word))
}
