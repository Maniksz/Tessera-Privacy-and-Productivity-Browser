import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { childrenOf, countChildren, findLink, titleFromUrl } from '@shared/quicklinks/model.js'
import type { QuickLinkCard } from '@shared/quicklinks/cards.js'
import { classifyOmniboxInput } from '@shared/url/omnibox.js'
import { bridgeAvailable, invoke, subscribeQuickLinks } from './bridge.js'
import { useInternalI18n } from './useInternalI18n.js'
import { QuickLinkTile } from './QuickLinkTile.js'
import { QuickLinkDialog, type DialogState } from './QuickLinkDialog.js'

/**
 * The start page: quick links that can be created, opened, renamed, reordered,
 * grouped into folders and deleted.
 *
 * Everything is driven by the core. The page holds no authoritative copy of the
 * list — it renders what `quicklinks:list` returns and re-reads on
 * `quicklinks:changed`, so a tile added in another window shows up here without a
 * reload.
 */

export function StartPage(): React.ReactNode {
  // Cards, not bare links: each carries the address of its screenshot and of its icon, built by the
  // core because only the core knows the version that makes a refreshed picture a new address.
  const [links, setLinks] = useState<QuickLinkCard[]>([])
  // The shared hook rather than a private copy. This page grew the first implementation, and a
  // second one on the history page would have been where the two started answering differently.
  const { locale, t } = useInternalI18n()
  const [openFolderId, setOpenFolderId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)



  const refresh = useCallback(async (): Promise<void> => {
    const next = await invoke('quicklinks:list')
    setLinks(next)
  }, [])

  /** Surfaces a rejected core call instead of leaving the UI silently unchanged. */
  const run = useCallback(async (action: () => Promise<unknown>): Promise<void> => {
    try {
      setError(null)
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? stripIpcPrefix(cause.message) : String(cause))
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!bridgeAvailable()) {
      // Reported through the same async path as everything else, so the effect has
      // no synchronous setState in it.
      queueMicrotask(() => {
        if (cancelled) return
        setError(t('start.bridgeUnavailable'))
        setLoaded(true)
      })
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      try {
        // The catalogue is the hook's business now; this only needs the list.
        const initial = await invoke('quicklinks:list')
        if (cancelled) return
        setLinks(initial)
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()

    // Unsubscribed on unmount, like every other channel (spec 6).
    const unsubscribe = subscribeQuickLinks(({ links: next }) => setLinks(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
    // `t` is intentionally excluded: it changes when the catalogue loads, and
    // re-running this effect would re-subscribe on every language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * The folder currently open, or null at the top level.
   *
   * A folder deleted in another window must not leave this page stuck inside it.
   * Resolved during render rather than corrected by an effect: an effect would
   * paint one frame of an empty folder before recovering, and React warns about
   * synchronous setState in an effect for exactly that reason.
   */
  const openFolder = openFolderId === null ? null : (findLink(links, openFolderId) ?? null)
  const effectiveFolderId = openFolder?.id ?? null

  const visible = useMemo(
    () => childrenOf(links, effectiveFolderId),
    [links, effectiveFolderId]
  )

  const onDrop = (targetIndex: number): void => {
    if (dragging === null) return
    const id = dragging
    setDragging(null)
    void run(() =>
      invoke('quicklinks:move', {
        id,
        parentId: effectiveFolderId,
        toIndex: targetIndex
      })
    )
  }

  /** Dropping a tile onto a folder tile files it away instead of reordering. */
  const onDropIntoFolder = (folderId: string): void => {
    if (dragging === null || dragging === folderId) return
    const id = dragging
    setDragging(null)
    void run(() => invoke('quicklinks:move', { id, parentId: folderId, toIndex: 0 }))
  }

  const submitDialog = async (state: DialogState): Promise<void> => {
    if (state.mode === 'edit') {
      await run(() =>
        invoke('quicklinks:update', {
          id: state.id,
          title: state.title,
          ...(state.kind === 'folder' ? {} : { url: state.url })
        }).then(refresh)
      )
    } else {
      await run(() =>
        invoke('quicklinks:create', {
          kind: state.kind,
          title: state.title,
          ...(state.kind === 'folder' ? {} : { url: state.url }),
          parentId: effectiveFolderId
        }).then(refresh)
      )
    }
    setDialog(null)
  }

  const gridRef = useRef<HTMLDivElement>(null)

  return (
    <main className="start" lang={locale}>
      <header className="start__header">
        <h1 className="start__title">{t('app.name')}</h1>
        <p className="start__subtitle">{t('start.tagline')}</p>
      </header>

      {openFolder !== null && (
        <nav className="start__breadcrumb" aria-label={t('start.breadcrumb')}>
          <button type="button" className="start__crumb" onClick={() => setOpenFolderId(null)}>
            ← {t('start.allTiles')}
          </button>
          <span className="start__crumbCurrent">{openFolder.title}</span>
        </nav>
      )}

      {error !== null && (
        <p className="start__error" role="alert">
          {error}
        </p>
      )}

      <div className="start__grid" ref={gridRef} role="list" aria-label={t('start.quickLinks')}>
        {visible.map((link, index) => (
          <QuickLinkTile
            key={link.id}
            link={link}
            index={index}
            childCount={link.kind === 'folder' ? countChildren(links, link.id) : 0}
            isDragging={dragging === link.id}
            t={t}
            onOpen={() => {
              if (link.kind === 'folder') setOpenFolderId(link.id)
              else void run(() => invoke('quicklinks:open', { id: link.id }))
            }}
            onOpenInNewTab={() =>
              void run(() => invoke('quicklinks:open', { id: link.id, newTab: true }))
            }
            onEdit={() =>
              setDialog({
                mode: 'edit',
                id: link.id,
                kind: link.kind,
                title: link.title,
                url: link.url
              })
            }
            onRemove={() => void run(() => invoke('quicklinks:remove', { id: link.id }).then(refresh))}
            onDragStart={() => setDragging(link.id)}
            onDragEnd={() => setDragging(null)}
            onDropBefore={() => onDrop(index)}
            onDropInto={link.kind === 'folder' ? () => onDropIntoFolder(link.id) : undefined}
            onMove={(direction) => {
              const target = direction === 'left' ? index - 1 : index + 1
              if (target < 0 || target >= visible.length) return
              void run(() =>
                invoke('quicklinks:move', {
                  id: link.id,
                  parentId: effectiveFolderId,
                  toIndex: target
                })
              )
            }}
          />
        ))}

        {/* Drop zone past the last tile, so a tile can be moved to the end. */}
        <div
          className="start__tail"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault()
            onDrop(visible.length)
          }}
        >
          <button
            type="button"
            className="start__add"
            onClick={() => setDialog({ mode: 'create', kind: 'link', title: '', url: '' })}
          >
            <span aria-hidden="true">+</span>
            {t('start.addTile')}
          </button>

          {/* Folders only exist at the top level, so the button hides inside one. */}
          {openFolder === null && (
            <button
              type="button"
              className="start__add start__add--folder"
              onClick={() => setDialog({ mode: 'create', kind: 'folder', title: '', url: '' })}
            >
              <span aria-hidden="true">🗀</span>
              {t('start.addFolder')}
            </button>
          )}
        </div>
      </div>

      {loaded && visible.length === 0 && (
        <p className="start__empty">{t('start.noTiles')}</p>
      )}

      {dialog !== null && (
        <QuickLinkDialog
          state={dialog}
          t={t}
          onChange={setDialog}
          onCancel={() => setDialog(null)}
          onSubmit={submitDialog}
          previewTitle={(url) => titleFromUrl(url)}
          // Validated with the omnibox classifier so the preview matches exactly
          // what the core will accept.
          isUsableUrl={(value) => classifyOmniboxInput(value).kind === 'url'}
        />
      )}
    </main>
  )
}

/**
 * Electron wraps a handler's error message; showing the raw wrapper text would
 * put "Error invoking remote method" in front of the part that matters.
 */
function stripIpcPrefix(message: string): string {
  const marker = /^Error invoking remote method '[^']+':\s*/
  return message.replace(marker, '').replace(/^\w*Error:\s*/, '')
}
