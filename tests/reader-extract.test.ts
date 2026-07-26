import { describe, expect, it } from 'vitest'
import { blocksOf, inlineTextOf, type ReaderBlock } from '@shared/reader/content.js'
import { extractArticle } from '@shared/reader/extract.js'
import { isFurniture, nameWordsOf } from '@shared/reader/names.js'
import { MIN_PROSE_MASS, type ReaderOutcome } from '@shared/reader/outcome.js'
import { DESCEND_SHARE, chooseContainer } from '@shared/reader/prose.js'
import { withoutSiteName } from '@shared/reader/metadata.js'
import { MIN_BLOCK_CHARS } from '@shared/reader/structure.js'
import type { ReaderElementNode } from '@shared/reader/wire.js'
import {
  ARTICLE_PARAGRAPHS,
  cookieNoticePage,
  doc,
  documentationPage,
  el,
  forumThread,
  link,
  nestedWrappersArticle,
  newsArticleWithSidebar,
  notAnArticlePage,
  p,
  text
} from './reader-fixtures.js'

/**
 * Reader mode's extraction, over pages built as plain object trees.
 *
 * The assertions are grouped by the decision they pin rather than by the function that makes it,
 * because the decisions are what a future change will get wrong: which container is the article,
 * what survives inside it, and — the one that matters most — when the answer is "this is not an
 * article" instead of a confident half of one.
 */

/** Every paragraph the extraction produced, as plain text. */
function paragraphsOf(blocks: readonly ReaderBlock[]): string[] {
  return blocks.flatMap((block): string[] => {
    if (block.kind === 'paragraph') return [inlineTextOf(block.inlines)]
    if (block.kind === 'quote') return paragraphsOf(block.blocks)
    if (block.kind === 'list') return block.items.flatMap((item) => paragraphsOf(item.blocks))
    return []
  })
}

function article(outcome: ReaderOutcome): ReaderOutcome & { kind: 'article' } {
  expect(outcome.kind, `refused: ${outcome.kind === 'refused' ? outcome.reason : ''}`).toBe(
    'article'
  )
  if (outcome.kind !== 'article') throw new Error('not an article')
  return outcome
}

describe('a news article with a sidebar', () => {
  const outcome = article(extractArticle(newsArticleWithSidebar()))

  it('keeps every paragraph of the article', () => {
    const found = paragraphsOf(outcome.article.blocks)
    for (const paragraph of ARTICLE_PARAGRAPHS) {
      expect(found, paragraph.slice(0, 30)).toContain(paragraph)
    }
  })

  it('leaves the sidebar, the advert, the related box and the footer out', () => {
    const whole = paragraphsOf(outcome.article.blocks).join('\n')
    expect(whole).not.toContain('A teaser paragraph')
    expect(whole).not.toContain('Sponsored')
    expect(whole).not.toContain('The foundry that shaped a town')
    expect(whole).not.toContain('Copyright and terms')
  })

  it('takes the headline from the article, not from the title element', () => {
    expect(outcome.article.title).toBe('Council rejects riverside plan')
  })

  it('does not then render the headline a second time', () => {
    const [first] = outcome.article.blocks.slice(0, 1)
    expect(first?.kind === 'heading' ? inlineTextOf(first.inlines) : '').not.toBe(
      'Council rejects riverside plan'
    )
  })

  it('finds the byline from rel=author and drops the word the label supplies', () => {
    // "By Anna Pohl" with a `reader.byline` label in front of it reads "By By Anna Pohl".
    expect(outcome.article.byline).toBe('Anna Pohl')
  })

  it('finds the publication date as the page stated it, not as it rendered it', () => {
    expect(outcome.article.publishedAt).toBe('2026-03-17T19:40:00Z')
  })

  it('keeps the figure as its caption and its alternative text', () => {
    const figures = outcome.article.blocks.filter((block) => block.kind === 'figure')
    expect(figures).toHaveLength(1)
    const [figure] = figures
    expect(figure?.kind === 'figure' ? figure.alt : '').toBe('The site')
    expect(figure?.kind === 'figure' ? inlineTextOf(figure.caption) : '').toBe(
      'The cleared foundry site, seen from the bridge.'
    )
  })

  it('reports the measurement it decided on', () => {
    expect(outcome.measurement.mass).toBeGreaterThanOrEqual(MIN_PROSE_MASS)
    expect(outcome.measurement.blocks).toBe(ARTICLE_PARAGRAPHS.length)
    expect(outcome.measurement.linkDensity).toBe(0)
    expect(outcome.measurement.required).toBe(MIN_PROSE_MASS)
  })
})

describe('a documentation page', () => {
  const outcome = article(extractArticle(documentationPage()))

  it('keeps the section headings', () => {
    // Narrowed in the filter rather than checked again in the map: the second check was dead, which meant the
    // fallback `''` could never be produced and an empty result would have read as a pass.
    const headings = outcome.article.blocks.filter(
      (block): block is Extract<typeof block, { kind: 'heading' }> => block.kind === 'heading'
    )
    expect(headings.map((block) => inlineTextOf(block.inlines))).toEqual(['Options'])
  })

  it('keeps the code block with its indentation intact', () => {
    const [code] = outcome.article.blocks.filter((block) => block.kind === 'code')
    expect(code?.kind === 'code' ? code.text : '').toBe(
      '  timeout: 3000\n  retries: 2\n  verbose: false'
    )
  })

  it('keeps the list, with the inline code inside its items', () => {
    const [list] = outcome.article.blocks.filter((block) => block.kind === 'list')
    expect(list?.kind === 'list' ? list.items : []).toHaveLength(2)
    const first = list?.kind === 'list' ? paragraphsOf(list.items[0]?.blocks ?? []) : []
    expect(first.join('')).toContain('The timeout option, in milliseconds')
  })

  it('keeps the table and marks the header row from its thead', () => {
    const [table] = outcome.article.blocks.filter((block) => block.kind === 'table')
    const rows = table?.kind === 'table' ? table.rows : []
    expect(rows.map((row) => row.header)).toEqual([true, false, false])
    expect(rows.slice(0, 1).map((row) => row.cells.map((cell) => inlineTextOf(cell)))).toEqual([
      ['Option', 'Default']
    ])
  })

  it('leaves the navigation sidebar out even though it is a list of real headings', () => {
    const whole = JSON.stringify(outcome.article.blocks)
    expect(whole).not.toContain('API reference')
  })
})

describe('a forum thread', () => {
  const outcome = article(extractArticle(forumThread()))

  it('extracts the whole thread rather than the densest single post', () => {
    // The trap: every post is a tidy block of prose, so a score that rewarded density would pick one
    // of them and show a fifth of the page with nothing to say so.
    const found = paragraphsOf(outcome.article.blocks).join('\n')
    expect(found).toContain('I have been trying to get the timeout option')
    expect(found).toContain('Confirmed, the flat form works')
  })

  it('holds at least the guaranteed share of the page prose', () => {
    expect(outcome.measurement.mass).toBeGreaterThanOrEqual(
      DESCEND_SHARE * outcome.measurement.documentMass
    )
  })
})

describe('an article inside three nested wrappers', () => {
  const source = nestedWrappersArticle()
  const outcome = article(extractArticle(source))

  it('descends to the article itself rather than stopping at the outermost wrapper', () => {
    const choice = chooseContainer(source.root)
    expect(choice.container.tag).toBe('article')
    // body, #app, .shell, .column--main, article
    expect(choice.path).toHaveLength(5)
  })

  it('still keeps every paragraph', () => {
    expect(paragraphsOf(outcome.article.blocks)).toHaveLength(ARTICLE_PARAGRAPHS.length)
  })

  it('leaves the comment thread out although it is genuine prose', () => {
    expect(JSON.stringify(outcome.article.blocks)).not.toContain('A comment long enough')
  })
})

describe('refusing', () => {
  it('says a page with no body copy is not an article', () => {
    const outcome = extractArticle(notAnArticlePage())
    expect(outcome.kind).toBe('refused')
    expect(outcome.kind === 'refused' ? outcome.reason : '').toBe('no-prose')
    expect(outcome.measurement.mass).toBe(0)
  })

  it('refuses a cookie notice and shows how far short it fell', () => {
    // The reason this threshold is where it is: a consent notice is real prose in real paragraphs,
    // and reformatting one as an article hides the controls the user came to press.
    const outcome = extractArticle(cookieNoticePage())
    expect(outcome.kind === 'refused' ? outcome.reason : '').toBe('too-little-prose')
    expect(outcome.measurement.mass).toBeGreaterThan(0)
    expect(outcome.measurement.mass).toBeLessThan(MIN_PROSE_MASS)
  })

  it('refuses a document the transcription could not finish, however much prose it holds', () => {
    const source = newsArticleWithSidebar()
    const outcome = extractArticle({ ...source, truncated: true })
    expect(outcome.kind === 'refused' ? outcome.reason : '').toBe('truncated')
    expect(outcome.measurement.truncated).toBe(true)
    expect(outcome.measurement.mass).toBeGreaterThanOrEqual(MIN_PROSE_MASS)
  })

  it('measures a navigation column at nothing, however long its links are', () => {
    const navigation = el('body', {}, [
      el(
        'ul',
        { classes: ['menu'] },
        ARTICLE_PARAGRAPHS.map((label) => el('li', {}, [link('https://example.test/x', label)]))
      )
    ])
    expect(chooseContainer(navigation).documentMass).toBe(0)
  })

  it('measures a list of long links at nothing even when it is not called a menu', () => {
    // Link text is subtracted rather than penalised by a factor, so this is exactly zero rather than
    // a small number that a long enough page could accumulate into an article.
    const directory = el('body', { classes: ['index'] }, [
      el(
        'ul',
        {},
        ARTICLE_PARAGRAPHS.map((label) => el('li', {}, [link('https://example.test/x', label)]))
      )
    ])
    expect(chooseContainer(directory).measure.mass).toBe(0)
    expect(chooseContainer(directory).measure.linkText).toBeGreaterThan(0)
  })
})

describe('what the measurement counts', () => {
  it('ignores a block shorter than a sentence', () => {
    const short = 'Nine words is not a paragraph of an article.'.slice(0, MIN_BLOCK_CHARS - 1)
    const page = el('body', {}, [p(short), p(short), p(short)])
    expect(chooseContainer(page).measure.mass).toBe(0)
  })

  it('counts a div of inline children as a paragraph, because many sites write body copy that way', () => {
    const page = el('body', {}, ARTICLE_PARAGRAPHS.map((value) => el('div', {}, [text(value)])))
    const measure = chooseContainer(page).measure
    expect(measure.blocks).toBe(ARTICLE_PARAGRAPHS.length)
    expect(measure.mass).toBeGreaterThanOrEqual(MIN_PROSE_MASS)
  })

  it('ignores headings, so a table of contents is not an article', () => {
    const page = el('body', {}, ARTICLE_PARAGRAPHS.map((value) => el('h2', {}, [text(value)])))
    expect(chooseContainer(page).measure.mass).toBe(0)
  })

  it('does not count what the page was not showing', () => {
    const page = el('body', {}, [
      el('div', { hidden: true }, [p(ARTICLE_PARAGRAPHS[0] ?? '')]),
      el('div', { attributes: { 'aria-hidden': 'true' } }, [p(ARTICLE_PARAGRAPHS[1] ?? '')])
    ])
    expect(chooseContainer(page).measure.mass).toBe(0)
  })

  it('subtracts only the link text from a paragraph that contains links', () => {
    const page = el('body', {}, [
      el('p', {}, [text('A paragraph long enough to count, with '), link('https://x.test', 'a link in it, which is discounted.')])
    ])
    const measure = chooseContainer(page).measure
    expect(measure.linkText).toBe('a link in it, which is discounted.'.length)
    expect(measure.mass).toBe(measure.text - measure.linkText)
    expect(measure.mass).toBeGreaterThan(0)
  })
})

describe('the furniture vocabulary', () => {
  it('reads a name whose only oddity is a counter, because the word is still there', () => {
    // `identifiers.ts` refuses `sidebar-1` for building a *filter rule* on, and it is right to.
    // The word is intact, so reader mode reads it anyway; see `names.ts`.
    expect(isFurniture(el('div', { id: 'sidebar-1' }))).toBe(true)
    expect(nameWordsOf(el('div', { classes: ['relatedPosts'] }))).toEqual(['related', 'posts'])
  })

  it('reads nothing out of a generated name', () => {
    expect(nameWordsOf(el('div', { classes: ['css-1a2b3c'] }))).toEqual([])
    expect(isFurniture(el('div', { classes: ['css-1a2b3c'] }))).toBe(false)
  })

  it('matches whole words only', () => {
    // A substring test for "ad" calls `.adaptive-layout` an advert, and calling the article container
    // an advert leaves the reader with nothing at all.
    expect(isFurniture(el('div', { classes: ['adaptive-layout'] }))).toBe(false)
    expect(isFurniture(el('div', { classes: ['header-badge'] }))).toBe(false)
    expect(isFurniture(el('div', { classes: ['ad-slot'] }))).toBe(true)
  })

  it('believes an element that declares itself the article over its own class names', () => {
    // `<article class="post promoted">` is real markup: a front page marks a piece as promoted and
    // the class survives onto the article page.
    expect(isFurniture(el('article', { classes: ['post', 'promo'] }))).toBe(false)
    expect(isFurniture(el('div', { classes: ['promo'] }))).toBe(true)
    expect(isFurniture(el('div', { attributes: { role: 'main' }, classes: ['sidebar'] }))).toBe(false)
  })

  it('excludes a landmark that cannot be the article', () => {
    expect(isFurniture(el('div', { attributes: { role: 'navigation' } }))).toBe(true)
    expect(isFurniture(el('div', { attributes: { role: 'region' } }))).toBe(false)
    expect(isFurniture(el('aside'))).toBe(true)
  })
})

describe('what is kept inside the container', () => {
  it('drops scripts, styles and forms wherever they are', () => {
    const container = el('div', {}, [
      el('script', {}, [text('window.x = 1')]),
      el('style', {}, [text('body { color: red }')]),
      el('form', {}, [p('A form is never article prose, however much text is on its labels.')]),
      p('Kept.')
    ])
    expect(paragraphsOf(blocksOf(container))).toEqual(['Kept.'])
  })

  it('keeps the spaces between inline elements', () => {
    // The trap: collapsing and trimming each run separately produces "Readthe noticefirst."
    const container = el('div', {}, [
      el('p', {}, [text('  Read '), link('https://x.test', 'the notice'), text(' first.  ')])
    ])
    expect(paragraphsOf(blocksOf(container))).toEqual(['Read the notice first.'])
  })

  it('merges adjacent runs of the same style and orders marks canonically', () => {
    const container = el('div', {}, [
      el('p', {}, [
        el('span', {}, [text('one ')]),
        el('span', {}, [text('two')]),
        el('em', {}, [el('strong', {}, [text(' three')])])
      ])
    ])
    const [block] = blocksOf(container)
    const inlines = block?.kind === 'paragraph' ? block.inlines : []
    expect(inlines).toHaveLength(2)
    expect(inlines[0]?.text).toBe('one two')
    expect(inlines[1]?.marks).toEqual(['strong', 'emphasis'])
  })

  it("keeps a link's text and refuses its address when the scheme is not one a page may use", () => {
    const container = el('div', {}, [
      el('p', {}, [link('javascript:alert(1)', 'Click me'), text(' and '), link('mailto:a@b.test', 'write')])
    ])
    const [block] = blocksOf(container)
    const inlines = block?.kind === 'paragraph' ? block.inlines : []
    // The refused link becomes plain text and then merges with the plain text after it, which is the
    // right outcome: nothing about the rendered sentence says there was ever a link there.
    expect(inlines[0]).toEqual({ text: 'Click me and ', marks: [], href: null })
    expect(inlines.slice(-1).map((inline) => inline.href)).toEqual(['mailto:a@b.test'])
  })

  it('drops an image with no alternative text, because that is a spacer or a tracker', () => {
    const container = el('div', {}, [
      el('img', { attributes: { src: 'https://x.test/pixel.gif', alt: '' } }),
      el('img', { attributes: { src: 'https://x.test/chart.png', alt: 'Turnout by ward' } })
    ])
    const figures = blocksOf(container).filter(
      (block): block is Extract<typeof block, { kind: 'figure' }> => block.kind === 'figure'
    )
    expect(figures).toHaveLength(1)
    expect(figures.map((block) => block.alt)).toEqual(['Turnout by ward'])
  })

  it('keeps the paragraphs inside a blockquote as paragraphs', () => {
    const container = el('div', {}, [
      el('blockquote', {}, [p('The first sentence of the quotation.'), p('And the second one.')])
    ])
    const [quote] = blocksOf(container)
    expect(quote?.kind === 'quote' ? paragraphsOf(quote.blocks) : []).toEqual([
      'The first sentence of the quotation.',
      'And the second one.'
    ])
  })

  it('keeps a nested list and the text beside it in the same item', () => {
    const container = el('div', {}, [
      el('ul', {}, [
        el('li', {}, [
          text('Outer item'),
          el('ul', {}, [el('li', {}, [text('Inner item')])])
        ])
      ])
    ])
    const [list] = blocksOf(container)
    expect(list?.kind === 'list' ? paragraphsOf(list.items[0]?.blocks ?? []) : []).toEqual([
      'Outer item',
      'Inner item'
    ])
  })

  it('marks a row whose cells are all th as a header even with no thead', () => {
    const container = el('div', {}, [
      el('table', {}, [
        el('tr', {}, [el('th', {}, [text('A')]), el('th', {}, [text('B')])]),
        el('tr', {}, [el('td', {}, [text('1')]), el('td', {}, [text('2')])])
      ])
    ])
    const [table] = blocksOf(container)
    expect(table?.kind === 'table' ? table.rows.map((row) => row.header) : []).toEqual([true, false])
  })

  it('produces nothing for wrappers that hold nothing', () => {
    // Empty containers must not become empty blocks: a reader view full of blank paragraphs looks
    // like a rendering fault rather than like a page with little on it.
    const container = el('div', {}, [
      el('figure', {}),
      el('table', {}),
      el('ul', {}),
      el('blockquote', {}),
      el('pre', {}),
      el('h2', {}),
      el('div', {}, [text('   ')])
    ])
    expect(blocksOf(container)).toEqual([])
  })

  it('turns a line break into a space rather than into a new paragraph', () => {
    const container = el('div', {}, [
      el('p', {}, [text('First line'), el('br', {}), text('second line')])
    ])
    expect(paragraphsOf(blocksOf(container))).toEqual(['First line second line'])
  })
})

describe('the title', () => {
  it('falls back to og:title when there is no heading', () => {
    const source = doc(el('body', {}, ARTICLE_PARAGRAPHS.map((value) => p(value))), {
      meta: { 'og:title': 'What the page says it is called' },
      documentTitle: 'Something else entirely'
    })
    expect(article(extractArticle(source)).article.title).toBe('What the page says it is called')
  })

  it('strips the site name from the document title only when the page named it', () => {
    expect(withoutSiteName('Headline - Example Herald', { 'og:site_name': 'Example Herald' })).toBe(
      'Headline'
    )
    expect(withoutSiteName('Example Herald | Headline', { 'application-name': 'Example Herald' })).toBe(
      'Headline'
    )
    // Nothing said what the site is called, so nothing is guessed: a mangled headline is worse than
    // a long one because the reader cannot tell it was mangled.
    expect(withoutSiteName('Headline - Example Herald', {})).toBe('Headline - Example Herald')
    expect(withoutSiteName('Headline', { 'og:site_name': 'Example Herald' })).toBe('Headline')
  })

  it('does not take the site wordmark out of the masthead', () => {
    const source = doc(
      el('body', {}, [
        el('header', { classes: ['masthead'] }, [el('h1', {}, [text('Example Herald')])]),
        el('main', {}, ARTICLE_PARAGRAPHS.map((value) => p(value)))
      ]),
      { documentTitle: 'The real headline' }
    )
    expect(article(extractArticle(source)).article.title).toBe('The real headline')
  })

  it('prefers a schema.org headline to the document title', () => {
    const source = doc(
      el('body', {}, [
        el('div', { attributes: { itemprop: 'headline' } }, [text('The schema headline')]),
        el('main', {}, ARTICLE_PARAGRAPHS.map((value) => p(value)))
      ]),
      { documentTitle: 'The template title' }
    )
    expect(article(extractArticle(source)).article.title).toBe('The schema headline')
  })
})

describe('the byline and the date', () => {
  const body = (extra: readonly ReaderElementNode[]): ReaderOutcome =>
    extractArticle(
      doc(el('body', {}, [...extra, el('main', {}, ARTICLE_PARAGRAPHS.map((value) => p(value)))]))
    )

  it('reads a nested schema.org author name rather than the whole author block', () => {
    const outcome = body([
      el('div', { attributes: { itemprop: 'author' } }, [
        text('Staff reporter, '),
        el('span', { attributes: { itemprop: 'name' } }, [text('Jane Doe')])
      ])
    ])
    expect(article(outcome).article.byline).toBe('Jane Doe')
  })

  it('reads an author block that has no nested name', () => {
    const outcome = body([el('div', { attributes: { itemprop: 'author' } }, [text('Jane Doe')])])
    expect(article(outcome).article.byline).toBe('Jane Doe')
  })

  it('reads a byline from a class name, which the measurement excludes for that reason', () => {
    const outcome = body([el('div', { classes: ['byline'] }, [text('Von Jan Meier')])])
    expect(article(outcome).article.byline).toBe('Jan Meier')
  })

  it('refuses an author biography wearing a byline class', () => {
    const long = ARTICLE_PARAGRAPHS.join(' ')
    const outcome = body([el('div', { classes: ['byline'] }, [text(long)])])
    expect(article(outcome).article.byline).toBeNull()
  })

  it('reads a date from meta when the article has no time element', () => {
    const source = doc(el('body', {}, ARTICLE_PARAGRAPHS.map((value) => p(value))), {
      meta: { 'article:published_time': '2026-01-02T03:04:05Z' }
    })
    expect(article(extractArticle(source)).article.publishedAt).toBe('2026-01-02T03:04:05Z')
  })

  it('reads a schema.org date from its content attribute, not from its rendered text', () => {
    const outcome = body([
      el('meta', { attributes: { itemprop: 'datePublished', content: '2026-02-03' } })
    ])
    expect(article(outcome).article.publishedAt).toBe('2026-02-03')
  })

  it('leaves the byline and the date null rather than inferring them from prose', () => {
    const outcome = extractArticle(
      doc(el('body', {}, ARTICLE_PARAGRAPHS.map((value) => p(value))))
    )
    expect(article(outcome).article.byline).toBeNull()
    expect(article(outcome).article.publishedAt).toBeNull()
  })

  it('takes the nearest declared language, so a translated piece is read as itself', () => {
    const source = doc(
      el('body', {}, [
        el('main', { attributes: { lang: 'de' } }, ARTICLE_PARAGRAPHS.map((value) => p(value)))
      ]),
      { lang: 'en' }
    )
    expect(article(extractArticle(source)).article.lang).toBe('de')
  })

  it('falls back to the document language', () => {
    const source = doc(el('body', {}, ARTICLE_PARAGRAPHS.map((value) => p(value))), { lang: 'en' })
    expect(article(extractArticle(source)).article.lang).toBe('en')
  })

  it('reports no language rather than a guess', () => {
    const source = doc(el('body', {}, ARTICLE_PARAGRAPHS.map((value) => p(value))))
    expect(article(extractArticle(source)).article.lang).toBeNull()
  })
})

describe('the guarantee the descent gives', () => {
  it('never hands back a container holding less than the share it promises', () => {
    for (const source of [
      newsArticleWithSidebar(),
      documentationPage(),
      forumThread(),
      nestedWrappersArticle(),
      cookieNoticePage()
    ]) {
      const choice = chooseContainer(source.root)
      expect(choice.measure.mass, source.url).toBeGreaterThanOrEqual(
        DESCEND_SHARE * choice.documentMass
      )
    }
  })

  it('stops above a single paragraph that holds almost all of the page', () => {
    // Descending into the paragraph would make it the article and drop its siblings — the classic
    // three-of-nine failure in miniature.
    const long = ARTICLE_PARAGRAPHS.join(' ')
    const page = el('body', {}, [el('div', { classes: ['content'] }, [p(long), p('A short tail.')])])
    expect(chooseContainer(page).container.classes).toEqual(['content'])
  })

  it('stays at the root when the prose forks immediately', () => {
    const page = el('body', {}, [
      el('div', {}, ARTICLE_PARAGRAPHS.slice(0, 5).map((value) => p(value))),
      el('div', {}, ARTICLE_PARAGRAPHS.slice(5).map((value) => p(value)))
    ])
    expect(chooseContainer(page).path).toHaveLength(1)
  })
})
