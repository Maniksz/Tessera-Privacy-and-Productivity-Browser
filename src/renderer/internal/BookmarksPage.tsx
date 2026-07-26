import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  BOOKMARK_BAR_ID,
  BOOKMARK_OTHER_ID,
  childrenOf,
  countChildren,
  descendantIdsOf,
  findBookmark,
  folderPath,
  queryBookmarks,
  type Bookmark,
  type BookmarkRootId
} from '@shared/bookmarks/model.js'
import { readableUrl } from '@shared/history/presentation.js'
import { bookmarksApi, internalBridgeAvailable } from './internal-calls.js'
import { BOOKMARK_MESSAGES, pendingTranslator, type BookmarkMessageKey } from './pending-messages.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://bookmarks`.
 *
 * An internal page rather than chrome UI, which is a *narrower* privilege rather than a wider
 * one: the per-page allowlist grants this document its eight bookmark channels and nothing
 * else. It cannot read a setting, touch a tab, or reach the window.
 *
 * Following a bookmark goes through `bookmarks:open`, which the core resolves to *this* tab.
 * The page deliberately does not have `nav:navigate`, which would let it steer any tab in the
 * window — the rule `quicklinks:open` established and `history:open` follows.
 *
 * ## Why the whole tree is fetched and filtered here, where history queries the core
 *
 * The history page re-queries on every keystroke because history is unbounded and only the
 * core can search all of it. Bookmarks are capped at ten thousand and the page needs the
 * *structure* — a breadcrumb, a child count, which folder a row sits in — none of which
 * survives a flat filtered result. So the page holds the tree and uses the same pure
 * functions the store does, which is also what makes the folder rules testable without a
 * browser.
 *
 * ## Reordering by button rather than by drag
 *
 * Drag-and-drop belongs here eventually, but the keyboard route has to exist either way
 * (spec 7), and a feature that is pointer-only is a feature some users do not have. The
 * up/down buttons *are* the accessible route, so they are built first and a drag layer can be
 * added over them later without changing what they call.
 */

interface EditingState {
  id: string
  title: string
  /** Empty for a folder, which has no address. */
  url: string
}

const ROOT_LABELS: Readonly<Record<BookmarkRootId, BookmarkMessageKey>> = {
  [BOOKMARK_BAR_ID]: 'bookmarks.bar',
  [BOOKMARK_OTHER_ID]: 'bookmarks.other'
}

const ROOT_IDS: readonly BookmarkRootId[] = [BOOKMARK_BAR_ID, BOOKMARK_OTHER_ID]

export function BookmarksPage(): React.ReactNode {
  const { locale } = useInternalI18n()
  const tp = useMemo(
    () => pendingTranslator<BookmarkMessageKey>(locale, BOOKMARK_MESSAGES),
    [locale]
  )

  const [nodes, setNodes] = useState<Bookmark[]>([])
  const [root, setRoot] = useState<BookmarkRootId>(BOOKMARK_BAR_ID)
  /**
   * The folder the user last opened. What is actually *shown* is `openFolderId` below.
   *
   * Two names because they can differ for one render: a folder deleted in another window leaves this pointing at
   * something that is gone, and the shown folder falls back to the root without a second render.
   */
  const [chosenFolderId, setFolderId] = useState<string>(BOOKMARK_BAR_ID)
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    setNodes(await bookmarksApi.list())
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!internalBridgeAvailable()) {
      // Reported through the same asynchronous path as everything else, so this effect has no
      // synchronous state write in it.
      queueMicrotask(() => {
        if (!cancelled) setLoaded(true)
      })
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      try {
        await refresh()
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      try {
        setNotice(null)
        await action()
      } catch (cause) {
        // A refused call must be visible. Silently leaving the list unchanged is how a user
        // learns not to trust the delete button.
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    []
  )

  /*
    A folder that no longer exists sends the view back to its root.

    Reachable in one ordinary way: deleting the folder you are looking at. Without this the
    page would show an empty folder listing with a breadcrumb naming something that is gone,
    and the only way out would be a reload.
  */
  /*
    Derived rather than stored, which is what the linter's "cascading renders" is pointing at.

    An effect that corrects state after a render means the page draws the stale folder once and then again —
    and with a folder that has just been deleted, that first frame is the empty listing this guard exists to
    prevent. Computing the effective folder makes the wrong state unrepresentable instead of transient.
  */
  const openFolderId =
    chosenFolderId === root || findBookmark(nodes, chosenFolderId) !== undefined ? chosenFolderId : root

  const searching = query.trim() !== ''

  const rows = useMemo(
    () =>
      searching
        ? queryBookmarks(nodes, { text: query, rootId: root })
        : childrenOf(nodes, openFolderId),
    [nodes, query, searching, root, openFolderId]
  )

  const trail = useMemo(() => folderPath(nodes, openFolderId), [nodes, openFolderId])
  const currentFolder = openFolderId === root ? undefined : findBookmark(nodes, openFolderId)

  const enterRoot = (next: BookmarkRootId): void => {
    setRoot(next)
    setFolderId(next)
    setQuery('')
  }

  const openBookmark = (node: Bookmark): void => {
    void run(async () => {
      await bookmarksApi.open(node.url)
    })
  }

  const addFolder = (): void => {
    void run(async () => {
      await bookmarksApi.create({
        kind: 'folder',
        title: tp('bookmarks.newFolderName'),
        parentId: openFolderId
      })
      await refresh()
    })
  }

  const removeNode = (node: Bookmark): void => {
    /*
      Every descendant, not the direct children.

      `removeBookmark` is transitive — the model's own docstring calls that "the trap" — so a folder holding one
      folder holding fifty bookmarks used to ask "remove … and the 1 items inside it?" and then remove
      fifty-two. A confirmation that under-reports what it destroys is worse than none: the user reads it,
      agrees to something small, and loses something large.
    */
    const children = descendantIdsOf(nodes, node.id).size
    // Confirmed only when something else goes with it. A folder deletion is transitive — see
    // `removeBookmark` — so this is the one place the user has to be told what they are about
    // to lose, and an empty folder is not worth a dialogue.
    if (children > 0) {
      const message = tp('bookmarks.removeFolderConfirm', { title: node.title, count: children })
      if (!globalThis.confirm(message)) return
    }
    void run(async () => {
      const { removed } = await bookmarksApi.remove(node.id)
      setNotice(tp('bookmarks.removedCount', { count: removed }))
      await refresh()
    })
  }

  const moveBy = (node: Bookmark, delta: number): void => {
    const siblings = childrenOf(nodes, node.parentId)
    const from = siblings.findIndex((sibling) => sibling.id === node.id)
    const to = from + delta
    if (to < 0 || to >= siblings.length) return
    void run(async () => {
      await bookmarksApi.move({ id: node.id, parentId: node.parentId, toIndex: to })
      await refresh()
    })
  }

  const moveToRoot = (node: Bookmark, target: BookmarkRootId): void => {
    void run(async () => {
      await bookmarksApi.move({
        id: node.id,
        parentId: target,
        // Appended: the far end of a list the user cannot see is the only position that is not
        // a guess about where they wanted it.
        toIndex: childrenOf(nodes, target).length
      })
      await refresh()
    })
  }

  const importFile = (): void => {
    void run(async () => {
      const result = await bookmarksApi.import()
      if (result.cancelled) return
      setNotice(
        tp('bookmarks.importResult', { imported: result.imported, skipped: result.skipped })
      )
      await refresh()
    })
  }

  const submitEdit = (): void => {
    const pending = editing
    if (pending === null) return
    const original = findBookmark(nodes, pending.id)
    if (original === undefined) return

    void run(async () => {
      if (pending.title !== original.title) {
        await bookmarksApi.update({ id: pending.id, title: pending.title })
      }
      /*
        The address goes through `bookmarks:relocate`, not `bookmarks:update`.

        They differ in what they keep: relocating preserves the title the user gave, the folder
        and the position, and re-derives the name only when the name *was* the old address.
        That is the "this page has moved" case, which is the ordinary reason somebody edits a
        bookmark's address at all.
      */
      if (original.kind === 'bookmark' && pending.url !== original.url) {
        await bookmarksApi.relocate({ id: pending.id, url: pending.url })
      }
      setEditing(null)
      await refresh()
    })
  }

  return (
    <main className="bookmarks" lang={locale}>
      <header className="bookmarks__header">
        <h1 className="bookmarks__title">{tp('bookmarks.title')}</h1>
        <input
          className="bookmarks__search"
          type="search"
          value={query}
          placeholder={tp('bookmarks.searchPlaceholder')}
          aria-label={tp('bookmarks.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="bookmarks__action" onClick={addFolder}>
          {tp('bookmarks.addFolder')}
        </button>
        <button type="button" className="bookmarks__action" onClick={importFile}>
          {tp('bookmarks.import')}
        </button>
      </header>

      <nav className="bookmarks__roots" aria-label={tp('bookmarks.location')}>
        {ROOT_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="bookmarks__root"
            aria-current={root === id ? 'true' : undefined}
            onClick={() => enterRoot(id)}
          >
            {tp(ROOT_LABELS[id])}
          </button>
        ))}
      </nav>

      {/*
        Announced rather than merely shown: what a deletion removed, and what an import made of
        a file, are the only confirmations the user gets, and both appear after the list has
        already changed.
      */}
      {notice !== null && (
        <p className="bookmarks__notice" role="status">
          {notice}
        </p>
      )}

      {!searching && currentFolder !== undefined && (
        <ol className="bookmarks__trail">
          <li>
            <button type="button" className="bookmarks__crumb" onClick={() => setFolderId(root)}>
              {tp(ROOT_LABELS[root])}
            </button>
          </li>
          {trail.map((folder) => (
            <li key={folder.id}>
              <button
                type="button"
                className="bookmarks__crumb"
                onClick={() => setFolderId(folder.id)}
              >
                {folder.title}
              </button>
            </li>
          ))}
          <li aria-current="true">{currentFolder.title}</li>
        </ol>
      )}

      {loaded && rows.length === 0 && (
        <p className="bookmarks__empty">
          {searching
            ? tp('bookmarks.noMatches', { query })
            : openFolderId === root
              ? tp('bookmarks.empty')
              : tp('bookmarks.emptyFolder')}
        </p>
      )}

      <ul className="bookmarks__list">
        {rows.map((node, index) => {
          const readable = node.kind === 'folder' ? '' : readableUrl(node.url)
          // A bookmark with no title falls back to its address — and the address line below
          // would then say the same thing twice. A row that repeats itself is harder to scan,
          // not more informative. The same finding as on the history page.
          const label = node.title === '' ? readable : node.title
          const showAddress = readable !== '' && label !== readable
          const otherRoot = root === BOOKMARK_BAR_ID ? BOOKMARK_OTHER_ID : BOOKMARK_BAR_ID
          return (
            <li className="bookmarks__entry" key={node.id}>
              <button
                type="button"
                className="bookmarks__open"
                aria-label={
                  node.kind === 'folder'
                    ? tp('bookmarks.openFolder', { title: label })
                    : tp('bookmarks.open', { title: label })
                }
                onClick={() => (node.kind === 'folder' ? setFolderId(node.id) : openBookmark(node))}
              >
                <span className="bookmarks__entryTitle">
                  {node.kind === 'folder' ? '📁 ' : ''}
                  {label}
                </span>
                {showAddress && <span className="bookmarks__entryUrl">{readable}</span>}
                {node.kind === 'folder' && (
                  <span className="bookmarks__entryMeta">
                    {/* The row says how many are *in* the folder; the delete confirmation counts every descendant. */}
              {tp('bookmarks.itemCount', { count: countChildren(nodes, node.id) })}
                  </span>
                )}
              </button>

              {!searching && (
                <>
                  <button
                    type="button"
                    className="bookmarks__rowAction"
                    aria-label={tp('bookmarks.moveUp', { title: label })}
                    disabled={index === 0}
                    onClick={() => moveBy(node, -1)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="bookmarks__rowAction"
                    aria-label={tp('bookmarks.moveDown', { title: label })}
                    disabled={index === rows.length - 1}
                    onClick={() => moveBy(node, 1)}
                  >
                    ↓
                  </button>
                </>
              )}
              <button
                type="button"
                className="bookmarks__rowAction"
                aria-label={
                  otherRoot === BOOKMARK_BAR_ID
                    ? tp('bookmarks.moveToBar', { title: label })
                    : tp('bookmarks.moveToOther', { title: label })
                }
                onClick={() => moveToRoot(node, otherRoot)}
              >
                ⇄
              </button>
              <button
                type="button"
                className="bookmarks__rowAction"
                aria-label={tp('bookmarks.edit', { title: label })}
                onClick={() => setEditing({ id: node.id, title: node.title, url: node.url })}
              >
                ✎
              </button>
              <button
                type="button"
                className="bookmarks__rowAction"
                aria-label={
                  node.kind === 'folder'
                    ? tp('bookmarks.removeFolder', { title: label })
                    : tp('bookmarks.remove', { title: label })
                }
                onClick={() => removeNode(node)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>

      {editing !== null && (
        <form
          className="bookmarks__dialog"
          onSubmit={(event) => {
            event.preventDefault()
            submitEdit()
          }}
        >
          <h2 className="bookmarks__dialogTitle">
            {findBookmark(nodes, editing.id)?.kind === 'folder'
              ? tp('bookmarks.dialogFolderTitle')
              : tp('bookmarks.dialogTitle')}
          </h2>
          <label className="bookmarks__field">
            {tp('bookmarks.name')}
            <input
              type="text"
              value={editing.title}
              onChange={(event) => setEditing({ ...editing, title: event.target.value })}
            />
          </label>
          {findBookmark(nodes, editing.id)?.kind === 'bookmark' && (
            <label className="bookmarks__field">
              {tp('bookmarks.address')}
              <input
                type="text"
                value={editing.url}
                onChange={(event) => setEditing({ ...editing, url: event.target.value })}
              />
            </label>
          )}
          <div className="bookmarks__dialogButtons">
            <button type="button" onClick={() => setEditing(null)}>
              {tp('bookmarks.cancel')}
            </button>
            <button type="submit">{tp('bookmarks.save')}</button>
          </div>
        </form>
      )}
    </main>
  )
}
