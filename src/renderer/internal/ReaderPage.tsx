import { createElement, useEffect, useMemo, useState } from 'react'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { readerIdOf } from '@shared/reader/address.js'
import { linkTargetOf } from '@shared/reader/links.js'
import { refusedOutcome } from '@shared/reader/outcome.js'
import type { ReaderOutcome, ReaderRefusal } from '@shared/reader/outcome.js'
import type {
  ReaderBlock,
  ReaderInline,
  ReaderListItem,
  ReaderTableRow
} from '@shared/reader/content.js'
import { bridgeAvailable, invoke } from './bridge.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://reader`.
 *
 * ## Why this renders a structure and never markup
 *
 * Everything below the title comes out of a website. The one thing this page must not do is put that
 * content into the DOM as markup: `dangerouslySetInnerHTML` on page-derived HTML, inside an internal
 * document that holds a bridge to the core, would be the worst hole in this project — every defect in
 * whatever sanitised it would become a privilege escalation, and a sanitiser is a thing that has
 * defects.
 *
 * So the core hands over blocks and runs of text (`shared/reader/content.ts`), which cannot express a
 * script, a style, an iframe or an event handler, and this file turns them into React elements. Every
 * string lands in a text node. There is nothing to sanitise, which is a stronger claim than sanitising
 * correctly. The only page-derived values that are not text are the `href` on a link and the address of
 * a figure, and both are re-checked here through `linkTargetOf` — the extractor already filtered them,
 * and the page that renders them checks again, because these two are the whole attack surface.
 *
 * ## An internal page rather than an overlay
 *
 * Being a real document is what makes reader mode zoomable, printable, and usable in a split tile —
 * the three things a surface drawn over the window could never be. Its privilege is one channel:
 * `reader:get`, which answers with an extraction the user asked for. It cannot read a setting, reach a
 * tab, or navigate anything but itself.
 */

const REFUSAL_MESSAGES: Readonly<Record<ReaderRefusal, MessageKey>> = {
  unreadable: 'reader.refused.unreadable',
  expired: 'reader.refused.expired',
  truncated: 'reader.refused.truncated',
  'no-prose': 'reader.refused.noProse',
  'too-little-prose': 'reader.refused.tooLittleProse'
}

/** The refusals whose measurement is worth showing: the ones that were decided on a number. */
const MEASURED_REFUSALS: ReadonlySet<ReaderRefusal> = new Set<ReaderRefusal>([
  'no-prose',
  'too-little-prose'
])

function InlineRun({ inline }: { inline: ReaderInline }): React.ReactNode {
  const marked = inline.marks.reduce<React.ReactNode>((inner, mark) => {
    if (mark === 'strong') return <strong>{inner}</strong>
    if (mark === 'emphasis') return <em>{inner}</em>
    return <code>{inner}</code>
  }, inline.text)
  const href = linkTargetOf(inline.href ?? undefined)
  if (href === null) return marked
  // `noreferrer` as well as `noopener`: following a link out of a reader view should not tell the
  // destination that it was reached from a `tessera://` document.
  return (
    <a href={href} rel="noreferrer noopener">
      {marked}
    </a>
  )
}

function Inlines({ inlines }: { inlines: readonly ReaderInline[] }): React.ReactNode {
  return inlines.map((inline, index) => <InlineRun inline={inline} key={index} />)
}

/**
 * Translation is threaded as a prop rather than taken from `useInternalI18n` in each component.
 *
 * The hook fetches the catalogue over the bridge in an effect, so calling it per block would open one
 * IPC call per paragraph of the article — a hundred calls for a long piece, all asking the same
 * question. Only two leaves need words at all (a figure and the page frame), so the prop costs less
 * than a context would.
 */
type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

function Blocks({
  blocks,
  t
}: {
  blocks: readonly ReaderBlock[]
  t: Translate
}): React.ReactNode {
  return blocks.map((block, index) => <Block block={block} t={t} key={index} />)
}

function ListItems({
  items,
  t
}: {
  items: readonly ReaderListItem[]
  t: Translate
}): React.ReactNode {
  return items.map((item, index) => (
    <li key={index}>
      <Blocks blocks={item.blocks} t={t} />
    </li>
  ))
}

function TableRows({ rows }: { rows: readonly ReaderTableRow[] }): React.ReactNode {
  return rows.map((row, rowIndex) => (
    <tr key={rowIndex}>
      {row.cells.map((cell, cellIndex) =>
        createElement(row.header ? 'th' : 'td', { key: cellIndex }, <Inlines inlines={cell} />)
      )}
    </tr>
  ))
}

/**
 * A figure, without its pixels.
 *
 * The image is not fetched — see the policy in `reader.html` — so what is rendered is the caption, the
 * alternative text, and the address as a link. An article's photograph is the part of it a reader can
 * most easily do without, and it is not worth a request from a privileged document to a site that would
 * learn from it.
 */
function Figure({
  src,
  alt,
  caption,
  t
}: {
  src: string
  alt: string
  caption: readonly ReaderInline[]
  t: Translate
}): React.ReactNode {
  const href = linkTargetOf(src === '' ? undefined : src)
  return (
    <figure className="reader__figure">
      {alt !== '' && <p className="reader__figureAlt">{t('reader.imageAlt', { alt })}</p>}
      {caption.length > 0 && (
        <figcaption className="reader__caption">
          <Inlines inlines={caption} />
        </figcaption>
      )}
      {href !== null && (
        <a className="reader__figureLink" href={href} rel="noreferrer noopener">
          {t('reader.imageOpen')}
        </a>
      )}
    </figure>
  )
}

function Block({ block, t }: { block: ReaderBlock; t: Translate }): React.ReactNode {
  switch (block.kind) {
    case 'heading':
      // Shifted down one level: the article's title is this document's `<h1>`, so an `<h1>` inside the
      // body would claim to be a second document heading and an outline reader would say so.
      return createElement(
        `h${String(Math.min(block.level + 1, 6))}`,
        null,
        <Inlines inlines={block.inlines} />
      )
    case 'paragraph':
      return (
        <p>
          <Inlines inlines={block.inlines} />
        </p>
      )
    case 'quote':
      return (
        <blockquote className="reader__quote">
          <Blocks blocks={block.blocks} t={t} />
        </blockquote>
      )
    case 'list':
      return createElement(
        block.ordered ? 'ol' : 'ul',
        { className: 'reader__list' },
        <ListItems items={block.items} t={t} />
      )
    case 'code':
      return <pre className="reader__code">{block.text}</pre>
    case 'figure':
      return <Figure src={block.src} alt={block.alt} caption={block.caption} t={t} />
    case 'table':
      return (
        <table className="reader__table">
          <tbody>
            <TableRows rows={block.rows} />
          </tbody>
        </table>
      )
  }
}

export function ReaderPage(): React.ReactNode {
  const { locale, t } = useInternalI18n()
  const [outcome, setOutcome] = useState<ReaderOutcome | null>(null)

  const dateFormat = useMemo(() => new Intl.DateTimeFormat(locale, { dateStyle: 'long' }), [locale])

  useEffect(() => {
    let cancelled = false
    const id = readerIdOf(globalThis.location.search)
    if (id === null || !bridgeAvailable()) {
      /*
        No id means this address was opened by hand or linked to from somewhere — a website can link to
        an internal page — so there is no extraction to show and `expired` is the honest wording.

        Reported through a microtask rather than written synchronously, so this effect has no state
        write in its own body; the same shape as `HistoryPage`.
      */
      queueMicrotask(() => {
        if (!cancelled) setOutcome(refusedOutcome('expired', ''))
      })
      return () => {
        cancelled = true
      }
    }
    void invoke('reader:get', { id })
      .then((result) => {
        if (!cancelled) setOutcome(result)
      })
      .catch(() => {
        // A refused or failed call must still produce a worded page. Leaving the loading state up is
        // how a user learns that reader mode "sometimes does nothing".
        if (!cancelled) setOutcome(refusedOutcome('unreadable', ''))
      })
    return () => {
      cancelled = true
    }
  }, [])

  const title = outcome?.kind === 'article' ? outcome.article.title : null

  useEffect(() => {
    // The document title is the tab's label. Left at the placeholder in `reader.html`, every reader tab
    // would be called the same thing, which in a window of eight tabs is no label at all.
    document.title = title ?? t('reader.title')
  }, [title, t])

  if (outcome === null) {
    return (
      <main className="reader reader--pending">
        <p role="status">{t('reader.loading')}</p>
      </main>
    )
  }

  const original =
    linkTargetOf(outcome.url === '' ? undefined : outcome.url) === null ? null : outcome.url

  if (outcome.kind === 'refused') {
    const { measurement } = outcome
    return (
      <main className="reader reader--refused">
        <h1 className="reader__title">{t('reader.refusedTitle')}</h1>
        <p className="reader__reason">{t(REFUSAL_MESSAGES[outcome.reason])}</p>
        {MEASURED_REFUSALS.has(outcome.reason) && (
          <p className="reader__measured">
            {t('reader.measured', { found: measurement.mass, needed: measurement.required })}
          </p>
        )}
        {original !== null && (
          <a className="reader__original" href={original} rel="noreferrer noopener">
            {t('reader.openOriginal')}
          </a>
        )}
      </main>
    )
  }

  const { article } = outcome
  const published = article.publishedAt
  const parsed = published === null ? Number.NaN : Date.parse(published)

  return (
    <main className="reader">
      <article className="reader__article" {...(article.lang === null ? {} : { lang: article.lang })}>
        <h1 className="reader__title">{article.title ?? t('reader.untitled')}</h1>
        <p className="reader__meta">
          {article.byline !== null && (
            <span className="reader__byline">{t('reader.byline', { name: article.byline })}</span>
          )}
          {published !== null && (
            /*
              The machine-readable value goes in `dateTime` and the rendered text is formatted only when
              it parses. A page that states a date this build cannot parse gets it shown verbatim —
              which is worse-looking and correct, where a silent "Invalid Date" would be neither.
            */
            <time className="reader__date" dateTime={published}>
              {t('reader.published', {
                date: Number.isNaN(parsed) ? published : dateFormat.format(parsed)
              })}
            </time>
          )}
        </p>
        <Blocks blocks={article.blocks} t={t} />
      </article>
      {original !== null && (
        <a className="reader__original" href={original} rel="noreferrer noopener">
          {t('reader.openOriginal')}
        </a>
      )}
    </main>
  )
}
