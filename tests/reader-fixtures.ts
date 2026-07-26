import type { ReaderDocument, ReaderElementNode, ReaderNode } from '@shared/reader/wire.js'

/**
 * Pages for the reader-mode tests, as plain object trees.
 *
 * Written by hand rather than parsed from HTML, and that is the point of the whole wire shape: the
 * extractor never sees a DOM, so a fixture is data and a test needs no browser. It also means each
 * fixture can be built to hold exactly the trap it is about — a sidebar with real prose in it, an
 * article three wrappers deep — instead of a page that happens to have one.
 *
 * The paragraphs are long enough to clear `MIN_BLOCK_CHARS` because a page whose paragraphs are all
 * under forty characters is a different fixture with a different expected answer, and mixing the two
 * would make every assertion here ambiguous.
 */

interface ElementOptions {
  readonly id?: string
  readonly classes?: readonly string[]
  readonly attributes?: Readonly<Record<string, string>>
  readonly hidden?: boolean
}

export function text(value: string): ReaderNode {
  return { kind: 'text', text: value }
}

export function el(
  tag: string,
  options: ElementOptions = {},
  children: readonly ReaderNode[] = []
): ReaderElementNode {
  return {
    kind: 'element',
    tag,
    id: options.id ?? '',
    classes: options.classes ?? [],
    attributes: options.attributes ?? {},
    children,
    ...(options.hidden === true ? { hidden: true } : {})
  }
}

/** `<p>` with one run of text: the shape most of these fixtures are made of. */
export function p(value: string, options: ElementOptions = {}): ReaderElementNode {
  return el('p', options, [text(value)])
}

export function link(href: string, label: string): ReaderElementNode {
  return el('a', { attributes: { href } }, [text(label)])
}

export function doc(
  root: ReaderElementNode,
  extra: {
    readonly meta?: Readonly<Record<string, string>>
    readonly documentTitle?: string
    readonly lang?: string
    readonly url?: string
    readonly truncated?: boolean
  } = {}
): ReaderDocument {
  return {
    root,
    meta: extra.meta ?? {},
    documentTitle: extra.documentTitle ?? '',
    lang: extra.lang ?? '',
    url: extra.url ?? 'https://example.test/article',
    truncated: extra.truncated ?? false
  }
}

/** Nine paragraphs, each comfortably over `MIN_BLOCK_CHARS`, so nine of them is a real article. */
export const ARTICLE_PARAGRAPHS: readonly string[] = [
  'The council rejected the riverside plan on Tuesday evening after four hours of argument in a packed room, and the vote was taken shortly before midnight.',
  'Objections had been filed by every one of the seven neighbourhood associations along the river, several of them for the second time in three years.',
  'The developer had promised a footbridge, a public park and two hundred flats in exchange for the land, which the town has owned outright since the war.',
  'Councillors who supported the scheme said the town would not see an offer of this size again soon, and that the empty site costs money to keep fenced.',
  'Those against pointed at the traffic study, which assumed a bus route that does not yet exist and may never be funded by the county at all.',
  'The vote was nine to eight with one abstention, from a member who declared a private interest in a neighbouring property before the debate began.',
  'A revised application may be submitted in the spring, according to a solicitor acting for the developer, who declined to say what would change in it.',
  'The land has been vacant since the foundry closed in nineteen eighty-four, and the last of the buildings on it were cleared eleven years after that.',
  'Residents said afterwards that they expected the argument to continue for at least another year, and that they were prepared for a public inquiry.'
]

/**
 * A news article with a sidebar, adverts, navigation and a footer.
 *
 * The sidebar deliberately holds *prose*, not only links — a "most read" column with a real teaser
 * paragraph in it — because a sidebar made purely of links is caught by link discounting alone and
 * would not test the name vocabulary at all.
 */
export function newsArticleWithSidebar(): ReaderDocument {
  return doc(
    el('body', {}, [
      el('header', { classes: ['masthead'] }, [
        el('nav', {}, [
          el('ul', {}, [
            el('li', {}, [link('https://example.test/news', 'News')]),
            el('li', {}, [link('https://example.test/sport', 'Sport')]),
            el('li', {}, [link('https://example.test/culture', 'Culture')])
          ])
        ])
      ]),
      el('div', { classes: ['page-wrap'] }, [
        el('main', {}, [
          el('article', { classes: ['story'] }, [
            el('header', { classes: ['story-header'] }, [
              el('h1', {}, [text('Council rejects riverside plan')]),
              el('p', { classes: ['byline'] }, [
                text('By '),
                el('a', { attributes: { rel: 'author', href: 'https://example.test/staff/ap' } }, [
                  text('Anna Pohl')
                ])
              ]),
              el('time', { attributes: { datetime: '2026-03-17T19:40:00Z' } }, [
                text('17 March 2026')
              ])
            ]),
            el('div', { classes: ['ad-slot'] }, [
              p('Sponsored: the finest riverside apartments money can buy this year, act now.')
            ]),
            ...ARTICLE_PARAGRAPHS.map((value) => p(value)),
            el('figure', {}, [
              el('img', { attributes: { src: 'https://example.test/river.jpg', alt: 'The site' } }),
              el('figcaption', {}, [text('The cleared foundry site, seen from the bridge.')])
            ]),
            el('aside', { classes: ['related'] }, [
              el('h2', {}, [text('Related')]),
              p('The foundry that shaped a town: our long read on eighty years of ironworking.')
            ])
          ])
        ]),
        el('div', { id: 'sidebar-1', classes: ['widget-area'] }, [
          el('h2', {}, [text('Most read')]),
          p('A teaser paragraph about something else entirely, long enough to count as prose here.'),
          el('ul', {}, [
            el('li', {}, [link('https://example.test/a', 'A second story about the harbour works')]),
            el('li', {}, [link('https://example.test/b', 'A third story about the school budget')])
          ])
        ])
      ]),
      el('footer', {}, [
        p('Copyright and terms and conditions and a long paragraph of legal boilerplate text.')
      ])
    ]),
    {
      documentTitle: 'Council rejects riverside plan | Example Herald',
      meta: { 'og:site_name': 'Example Herald' },
      lang: 'en',
      url: 'https://example.test/news/council-rejects-riverside-plan'
    }
  )
}

/** A documentation page: headings, prose, a list, a code block and a table, beside a nav sidebar. */
export function documentationPage(): ReaderDocument {
  return doc(
    el('body', {}, [
      el('div', { classes: ['layout'] }, [
        el('nav', { classes: ['sidebar', 'toc'] }, [
          el('ul', {}, [
            el('li', {}, [link('https://docs.test/install', 'Installation')]),
            el('li', {}, [link('https://docs.test/config', 'Configuration')]),
            el('li', {}, [link('https://docs.test/api', 'API reference')])
          ])
        ]),
        el('main', { classes: ['content'] }, [
          el('h1', {}, [text('Configuration')]),
          p('Every option below can be set in the configuration file or on the command line, and the command line always wins — which matters when a deployment script overrides one value and nobody remembers that it does.'),
          p('The file is read once at start-up. Changing it while the process is running has no effect at all, and there is deliberately no watcher: a configuration that changes underneath a running request is harder to reason about than a restart.'),
          el('h2', {}, [text('Options')]),
          el('ul', {}, [
            el('li', {}, [
              text('The '),
              el('code', {}, [text('timeout')]),
              text(' option, in milliseconds, applied to every outgoing request in the pool.')
            ]),
            el('li', {}, [
              text('The '),
              el('code', {}, [text('retries')]),
              text(' option, a whole number, applied after a timeout and never after a refusal.')
            ])
          ]),
          el('pre', {}, [
            el('code', {}, [text('  timeout: 3000\n  retries: 2\n  verbose: false\n')])
          ]),
          p('A table of the defaults follows. Every one of them can be overridden per host, and a per-host value replaces the global one rather than merging with it, which is the opposite of what the older releases did.'),
          el('table', {}, [
            el('thead', {}, [
              el('tr', {}, [el('th', {}, [text('Option')]), el('th', {}, [text('Default')])])
            ]),
            el('tbody', {}, [
              el('tr', {}, [el('td', {}, [text('timeout')]), el('td', {}, [text('3000')])]),
              el('tr', {}, [el('td', {}, [text('retries')]), el('td', {}, [text('2')])])
            ])
          ]),
          p('The remaining options are experimental and may be removed in any minor release, so a deployment that depends on one of them should pin the version it was tested against.'),
          p('Read the migration notes before changing any of them in a production deployment, particularly the section about the retry counter, whose meaning changed in the last release.')
        ])
      ])
    ]),
    { documentTitle: 'Configuration – Example Docs', lang: 'en', url: 'https://docs.test/config' }
  )
}

/** A forum thread: five posts of similar length, each in its own wrapper. */
export function forumThread(): ReaderDocument {
  const posts = [
    'I have been trying to get the timeout option to apply per host and I cannot make it work at all. The global value is honoured, the per-host block is accepted without a warning, and then ignored.',
    'Which version are you on? The per-host form only landed in the release before last, and before that the parser read the block and threw the contents away without saying anything about it.',
    'Version four point two. The documentation shows the nested form, the file validates, and the request still times out after the global three seconds rather than the twenty I asked for.',
    'That is a known defect and there is an issue open for it. The workaround is the flat form with the host in the key, which the parser has always understood, including in the older releases.',
    'Confirmed, the flat form works and the per-host timeout is applied. Thank you both — I had read the table of defaults and not the notes underneath it, which say exactly this.'
  ]
  return doc(
    el('body', {}, [
      el('div', { classes: ['thread'] }, [
        el('h1', {}, [text('Per-host timeout is ignored')]),
        ...posts.map((body, index) =>
          el('div', { classes: ['post'] }, [
            el('div', { classes: ['post-author'] }, [text(`user${String(index)}`)]),
            el('div', { classes: ['post-body'] }, [p(body)])
          ])
        )
      ])
    ]),
    { documentTitle: 'Per-host timeout is ignored', url: 'https://forum.test/t/4711' }
  )
}

/** A shop category page: navigation, a grid of short cards, a footer. No prose anywhere. */
export function notAnArticlePage(): ReaderDocument {
  const products = ['Kettle', 'Toaster', 'Blender', 'Grinder', 'Steamer', 'Whisk']
  return doc(
    el('body', {}, [
      el('nav', {}, [
        el('ul', {}, products.map((name) => el('li', {}, [link(`https://shop.test/${name}`, name)])))
      ]),
      el('main', {}, [
        el('h1', {}, [text('Kitchen')]),
        el(
          'div',
          { classes: ['grid'] },
          products.map((name) =>
            el('div', { classes: ['card'] }, [
              link(`https://shop.test/${name}`, name),
              el('span', { classes: ['price'] }, [text('£29.99')])
            ])
          )
        )
      ]),
      el('footer', {}, [el('ul', {}, [el('li', {}, [link('https://shop.test/help', 'Help')])])])
    ]),
    { documentTitle: 'Kitchen | Example Shop', url: 'https://shop.test/kitchen' }
  )
}

/** An article three neutral wrappers deep, each wrapper also holding furniture siblings. */
export function nestedWrappersArticle(): ReaderDocument {
  return doc(
    el('body', {}, [
      el('div', { id: 'app' }, [
        el('div', { classes: ['shell'] }, [
          el('nav', { classes: ['topbar'] }, [link('https://example.test/', 'Home')]),
          el('div', { classes: ['column', 'column--main'] }, [
            el('article', { attributes: { itemprop: 'articleBody' } }, [
              el('h1', {}, [text('Three wrappers deep')]),
              ...ARTICLE_PARAGRAPHS.map((value) => p(value))
            ]),
            el('div', { classes: ['comments'] }, [
              p('A comment long enough to be prose, which is why the vocabulary has to exclude it.'),
              p('A second comment, also long enough, so the section is not dismissed by its size.')
            ])
          ])
        ])
      ])
    ]),
    { documentTitle: 'Three wrappers deep', url: 'https://example.test/deep' }
  )
}

/** A cookie notice: real paragraphs, real sentences, and nowhere near an article's worth. */
export function cookieNoticePage(): ReaderDocument {
  return doc(
    el('body', {}, [
      el('main', {}, [
        el('h1', {}, [text('Before you continue')]),
        p('We and our four hundred partners store information on your device to serve adverts.'),
        p('You can accept, refuse, or manage each purpose separately on the following screen.')
      ])
    ]),
    { documentTitle: 'Before you continue', url: 'https://example.test/consent' }
  )
}
