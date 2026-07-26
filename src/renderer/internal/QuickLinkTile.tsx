import { useState, type KeyboardEvent, type MouseEvent } from 'react'
import { cardImageSequence, type QuickLinkCard } from '@shared/quicklinks/cards.js'
import type { MessageKey } from '@shared/i18n/catalog.js'

/**
 * One Speed Dial tile.
 *
 * Fully operable from the keyboard: Enter opens, Ctrl/Cmd+Arrow reorders, Delete
 * removes, F2 renames. Spec 7 requires complete keyboard operation, and drag and
 * drop alone would make reordering mouse-only.
 */

interface QuickLinkTileProps {
  link: QuickLinkCard
  index: number
  childCount: number
  isDragging: boolean
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  onOpen: () => void
  onOpenInNewTab: () => void
  onEdit: () => void
  onRemove: () => void
  onDragStart: () => void
  onDragEnd: () => void
  onDropBefore: () => void
  /** Present only for folders: dropping a tile onto it files the tile away. */
  onDropInto?: (() => void) | undefined
  onMove: (direction: 'left' | 'right') => void
}

export function QuickLinkTile({
  link,
  index,
  childCount,
  isDragging,
  t,
  onOpen,
  onOpenInNewTab,
  onEdit,
  onRemove,
  onDragStart,
  onDragEnd,
  onDropBefore,
  onDropInto,
  onMove
}: QuickLinkTileProps): React.ReactNode {
  const [dropTarget, setDropTarget] = useState<'none' | 'before' | 'into'>('none')

  const isFolder = link.kind === 'folder'
  const label = isFolder
    ? t('start.folderLabel', { name: link.title, count: childCount })
    : t('start.tileLabel', { name: link.title, url: link.url })

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const modifier = event.ctrlKey || event.metaKey

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen()
      return
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault()
      onRemove()
      return
    }
    if (event.key === 'F2') {
      event.preventDefault()
      onEdit()
      return
    }
    if (modifier && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault()
      onMove(event.key === 'ArrowLeft' ? 'left' : 'right')
    }
  }

  const onAuxClick = (event: MouseEvent): void => {
    // Middle click opens in a new tab, as it does everywhere else in the browser.
    if (event.button === 1 && !isFolder) {
      event.preventDefault()
      onOpenInNewTab()
    }
  }

  return (
    <div
      role="listitem"
      className={[
        'tile',
        isFolder ? 'tile--folder' : '',
        isDragging ? 'tile--dragging' : '',
        dropTarget === 'before' ? 'tile--dropBefore' : '',
        dropTarget === 'into' ? 'tile--dropInto' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      draggable
      tabIndex={0}
      aria-label={label}
      title={isFolder ? link.title : `${link.title}\n${link.url}`}
      onClick={onOpen}
      onAuxClick={onAuxClick}
      onKeyDown={onKeyDown}
      onDragStart={onDragStart}
      onDragEnd={() => {
        setDropTarget('none')
        onDragEnd()
      }}
      onDragOver={(event) => {
        event.preventDefault()
        // Dropping on the left half reorders; on a folder's centre it files away.
        if (onDropInto !== undefined) {
          const bounds = event.currentTarget.getBoundingClientRect()
          const nearEdge = event.clientX - bounds.left < bounds.width * 0.25
          setDropTarget(nearEdge ? 'before' : 'into')
        } else {
          setDropTarget('before')
        }
      }}
      onDragLeave={() => setDropTarget('none')}
      onDrop={(event) => {
        event.preventDefault()
        const mode = dropTarget
        setDropTarget('none')
        if (mode === 'into' && onDropInto !== undefined) onDropInto()
        else onDropBefore()
      }}
    >
      <div className="tile__icon" aria-hidden="true">
        {isFolder ? '🗀' : <TilePicture card={link} />}
      </div>

      <div className="tile__body">
        <span className="tile__title">{link.title}</span>
        <span className="tile__meta">
          {isFolder ? t('start.itemCount', { count: childCount }) : hostOf(link.url)}
        </span>
      </div>

      <div className="tile__actions">
        <button
          type="button"
          className="tile__action"
          aria-label={t('start.editTile', { name: link.title })}
          onClick={(event) => {
            event.stopPropagation()
            onEdit()
          }}
        >
          ✎
        </button>
        <button
          type="button"
          className="tile__action"
          aria-label={t('start.removeTile', { name: link.title })}
          onClick={(event) => {
            event.stopPropagation()
            onRemove()
          }}
        >
          ×
        </button>
      </div>

      <span className="tile__position" aria-hidden="true">
        {index + 1}
      </span>
    </div>
  )
}

/**
 * The card's picture: the page's own screenshot, else the site's icon, else its initial.
 *
 * Walks the sequence the core supplied rather than choosing: which picture is preferred is a product
 * decision and it lives in `cardImageSequence`, so this component cannot quietly disagree with the
 * tab strip about it.
 *
 * Falling forward on `error` is the mechanism, and it works because a miss answers 204 — an empty
 * body that cannot be decoded. That is the ordinary case rather than a failure: nothing is cached for
 * a page until it has been visited, and the last step of the walk is always the initial, which needs
 * nothing at all.
 *
 * The initial is derived from the title and never fetched. Spec 1 forbids pulling favourites' icons
 * from a third-party service, which would disclose the user's favourites; both real pictures here
 * come from the local caches, filled from the sites themselves.
 */
function TilePicture({ card }: { card: QuickLinkCard }): React.ReactNode {
  const candidates = cardImageSequence(card)
  const [attempt, setAttempt] = useState(0)
  // `slice(...).map(...)` rather than indexing: the project's way of staying total without a guard
  // for an index that cannot be out of range.
  const [candidate] = candidates.slice(attempt, attempt + 1)

  if (candidate === undefined) return <>{initialOf(card.title)}</>

  return (
    <img
      /*
        Keyed on the address, so a refreshed picture gets a fresh element and a fresh attempt counter.
        Without it, a card that had fallen back to its initial would stay on the initial for the rest of
        the session — even once a screenshot existed.
      */
      key={candidate.url}
      className={`tile__picture tile__picture--${candidate.kind}`}
      src={candidate.url}
      alt=""
      onError={() => setAttempt(attempt + 1)}
    />
  )
}

/** The last resort, and the only one that needs nothing from a cache. */
function initialOf(title: string): string {
  const trimmed = title.trim()
  if (trimmed === '') return '·'
  // `codePointAt` rather than indexing or spreading: a title starting with an
  // emoji or a character outside the basic plane would otherwise be cut in half.
  const first = trimmed.codePointAt(0)
  return first === undefined ? '·' : String.fromCodePoint(first).toUpperCase()
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
