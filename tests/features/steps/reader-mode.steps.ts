import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { inlineTextOf } from '@shared/reader/content.js'
import { extractArticle } from '@shared/reader/extract.js'
import { MIN_PROSE_MASS, refusedOutcome, type ReaderRefusal } from '@shared/reader/outcome.js'
import {
  asReaderDocument,
  type ReaderDocument,
  type ReaderElementNode,
  type ReaderNode
} from '@shared/reader/wire.js'
import { readerOutcome, scope } from './world.js'

/**
 * Steps for `reader-mode.feature`.
 *
 * The pages are built as plain object trees, which is the whole point of the wire shape: the
 * extractor never sees a DOM, so a page in a scenario is data and no browser is involved. It
 * also means each page can be built to hold exactly the trap it is about — nine paragraphs
 * with three of them in a section of their own — rather than being a page that happens to.
 *
 * The reading step is the two calls the core makes in this order: rebuild what the page
 * answered, and refuse it outright if it cannot be rebuilt. An off-shape answer is tampering
 * rather than skew, because the transcription runs in the page's own main world.
 */

const URL = 'https://example.test/news/council-rejects-riverside-plan'

/** Long enough to count as body copy, and the same length every time so the figures are stable. */
const SENTENCE =
  'The council rejected the riverside plan on Tuesday evening after four hours of argument in a packed room.'

interface PagePlan {
  paragraphs: number
  /** How many of those paragraphs sit in a section of their own inside the article. */
  sectioned: number
  wrappers: number
  comments: number
  links: number
  cards: boolean
  truncated: boolean
  unreadable: boolean
}

function plan(state: unknown): PagePlan {
  const current = scope(state)
  const existing = current.scratch['readerPlan'] as PagePlan | undefined
  if (existing !== undefined) return existing
  const fresh: PagePlan = {
    paragraphs: 0,
    sectioned: 0,
    wrappers: 0,
    comments: 0,
    links: 0,
    cards: false,
    truncated: false,
    unreadable: false
  }
  current.scratch['readerPlan'] = fresh
  return fresh
}

function text(value: string): ReaderNode {
  return { kind: 'text', text: value }
}

function el(
  tag: string,
  options: { id?: string; classes?: readonly string[]; attributes?: Readonly<Record<string, string>> } = {},
  children: readonly ReaderNode[] = []
): ReaderElementNode {
  return {
    kind: 'element',
    tag,
    id: options.id ?? '',
    classes: options.classes ?? [],
    attributes: options.attributes ?? {},
    children
  }
}

function para(value: string): ReaderElementNode {
  return el('p', {}, [text(value)])
}

function link(label: string): ReaderElementNode {
  return el('a', { attributes: { href: 'https://example.test/elsewhere' } }, [text(label)])
}

const COMMENT = 'A comment from a reader, long enough to be genuine prose in a genuine paragraph.'

function pageFrom(page: PagePlan): ReaderDocument {
  const paragraphs = Array.from({ length: page.paragraphs }, (_unused, index) =>
    para(`${SENTENCE} Paragraph ${index + 1}.`)
  )
  const inside =
    page.sectioned > 0
      ? [
          el('div', { classes: ['section'] }, paragraphs.slice(0, page.sectioned)),
          ...paragraphs.slice(page.sectioned)
        ]
      : paragraphs

  const beside: ReaderElementNode[] =
    page.comments > 0
      ? [
          el(
            'div',
            { classes: ['comments'] },
            Array.from({ length: page.comments }, (_unused, index) =>
              para(`${COMMENT} Number ${index + 1}.`)
            )
          )
        ]
      : []

  let content: ReaderElementNode[] =
    page.paragraphs > 0 ? [el('article', { classes: ['story'] }, inside), ...beside] : []
  for (let depth = 0; depth < page.wrappers; depth += 1) {
    content = [el('div', { classes: [`wrapper-${depth + 1}`] }, content)]
  }

  if (page.links > 0) {
    content = [
      ...content,
      el('div', { classes: ['directory'] }, [
        el(
          'ul',
          {},
          Array.from({ length: page.links }, (_unused, index) =>
            el('li', {}, [link(`A story about the harbour works, part ${index + 1} of the series`)])
          )
        )
      ])
    ]
  }

  if (page.cards) {
    const products = ['Kettle', 'Toaster', 'Blender', 'Grinder', 'Steamer', 'Whisk']
    content = [
      ...content,
      el('main', {}, [
        el('h1', {}, [text('Kitchen')]),
        el(
          'div',
          { classes: ['grid'] },
          products.map((name) =>
            el('div', { classes: ['card'] }, [link(name), el('span', {}, [text('29.99')])])
          )
        )
      ])
    ]
  }

  return {
    root: el('body', {}, content),
    meta: {},
    documentTitle: 'Council rejects riverside plan | Example Herald',
    lang: 'en',
    url: URL,
    truncated: page.truncated
  }
}

function refusal(state: unknown): ReaderRefusal {
  const outcome = readerOutcome(state)
  if (outcome.kind !== 'refused') {
    throw new Error('reader mode presented an article, and this scenario expects a refusal')
  }
  return outcome.reason
}

function paragraphsOf(state: unknown): string[] {
  const outcome = readerOutcome(state)
  if (outcome.kind !== 'article') {
    throw new Error(`reader mode refused this page: ${outcome.reason}`)
  }
  return outcome.article.blocks
    .filter((block) => block.kind === 'paragraph')
    .map((block) => (block.kind === 'paragraph' ? inlineTextOf(block.inlines) : ''))
}

// --- given -------------------------------------------------------------------

Given('a page with {int} paragraphs of article text', (state: unknown, count: number) => {
  plan(state).paragraphs = count
})

Given('{int} of them sit in a section of their own', (state: unknown, count: number) => {
  plan(state).sectioned = count
})

Given(
  'a page with {int} paragraphs of article text inside {int} nested wrappers',
  (state: unknown, count: number, wrappers: number) => {
    const page = plan(state)
    page.paragraphs = count
    page.wrappers = wrappers
  }
)

Given('a comment thread of {int} paragraphs beside it', (state: unknown, count: number) => {
  plan(state).comments = count
})

Given('a page whose only text is a column of {int} links', (state: unknown, count: number) => {
  plan(state).links = count
})

Given('a page with no body copy at all', (state: unknown) => {
  plan(state).cards = true
})

Given('the transcription stopped before the end of the page', (state: unknown) => {
  plan(state).truncated = true
})

Given('a page that answered with something this build cannot read', (state: unknown) => {
  plan(state).unreadable = true
})

// --- when --------------------------------------------------------------------

When('reader mode reads the page', (state: unknown) => {
  const current = scope(state)
  const page = plan(state)
  // The page's own script can replace the answer, so what comes back is rebuilt from scratch
  // and a document that cannot be rebuilt is refused whole rather than repaired in part.
  current.readerPage = page.unreadable ? { root: 'not a node at all' } : pageFrom(page)
  const document = asReaderDocument(current.readerPage)
  current.readerOutcome =
    document === null ? refusedOutcome('unreadable', URL) : extractArticle(document)
})

// --- then --------------------------------------------------------------------

Then('it presents the article', (state: unknown) => {
  const outcome = readerOutcome(state)
  expect(
    outcome.kind,
    outcome.kind === 'refused' ? `it refused: ${outcome.reason}` : 'presented'
  ).toBe('article')
})

Then('the article keeps all {int} paragraphs', (state: unknown, count: number) => {
  // The whole argument: a reader who reaches the end of a truncated article has no way of
  // knowing there was more.
  expect(paragraphsOf(state)).toHaveLength(count)
})

Then('the article holds nothing from the comment thread', (state: unknown) => {
  const spoken = paragraphsOf(state).join(' ')
  expect(spoken, 'a comment thread is prose, and is not the article').not.toContain('A comment from a reader')
})

Then('the text it judged on is all the article text on the page', (state: unknown) => {
  const { measurement } = readerOutcome(state)
  // Structural rather than statistical: the container holds every character of prose the page
  // has, so truncation is bounded rather than merely made unlikely.
  expect(measurement.mass).toBe(measurement.documentMass)
})

Then('it refuses: this does not look like an article', (state: unknown) => {
  expect(refusal(state)).toBe('too-little-prose')
})

Then('it refuses: the page holds no article text', (state: unknown) => {
  expect(refusal(state)).toBe('no-prose')
})

Then('it refuses: the page came back cut short', (state: unknown) => {
  // Refused even though the page held a whole article: every measurement taken from a partial
  // document is a measurement of a fragment.
  expect(refusal(state)).toBe('truncated')
})

Then('it refuses: the answer from the page could not be read', (state: unknown) => {
  expect(refusal(state)).toBe('unreadable')
})

Then('it says how much article text it found, and how much it wanted', (state: unknown) => {
  const { measurement } = readerOutcome(state)
  expect(measurement.required, 'the threshold travels with the figure').toBe(MIN_PROSE_MASS)
  expect(measurement.mass, 'a refusal with no figure is an opinion nobody can check').toBeGreaterThan(0)
  expect(measurement.mass).toBeLessThan(measurement.required)
})
