import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HistoryVisit } from '@shared/history/model.js'
import { registrableDomainOfUrl } from '@shared/url/domain.js'
// The day grouping and the address formatting live in `shared` so they can be tested: both look
// trivial and both have a trap in them. See `history/presentation.ts`.
import { DAY_GROUPS, dayGroupOf, readableUrl, type DayGroup } from '@shared/history/presentation.js'
import { bridgeAvailable, invoke } from './bridge.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://history`.
 *
 * An internal page rather than chrome UI, and that is now a *narrower* privilege rather than a
 * wider one: the per-page allowlist grants this document the six history channels and nothing else.
 * It cannot read a setting, touch a tab, or reach the window — see `shared/ipc/channels.ts`.
 *
 * Following an entry goes through `history:open`, which the core resolves to *this* tab. The page
 * deliberately does not have `nav:navigate`, which would let it steer any tab in the window.
 */

const GROUP_LABELS: Readonly<
  Record<DayGroup, 'history.today' | 'history.yesterday' | 'history.older'>
> = {
  today: 'history.today',
  yesterday: 'history.yesterday',
  older: 'history.older'
}

export function HistoryPage(): React.ReactNode {
  const { locale, t } = useInternalI18n()
  const [entries, setEntries] = useState<HistoryVisit[]>([])
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  const refresh = useCallback(
    async (text: string): Promise<void> => {
      // Searching happens in the core, against every stored entry — filtering a page-sized slice
      // here would silently search only what had already been fetched.
      const found = await invoke('history:query', text === '' ? {} : { text })
      setEntries(found)
    },
    []
  )

  useEffect(() => {
    let cancelled = false
    if (!bridgeAvailable()) {
      queueMicrotask(() => {
        if (!cancelled) setLoaded(true)
      })
      return () => {
        cancelled = true
      }
    }
    // An async body rather than `.finally` on the promise: a state write attached directly to a
    // promise in an effect body is what the `react-hooks` rule flags, and it is right to — the
    // write then has no relationship to the effect's own cleanup.
    void (async () => {
      try {
        await refresh('')
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  // Re-queried on every keystroke rather than filtered in place, for the reason above. The core
  // answers from memory, so this is cheap.
  useEffect(() => {
    if (!loaded) return
    const handle = setTimeout(() => void refresh(query), 120)
    return () => clearTimeout(handle)
  }, [query, loaded, refresh])

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      try {
        setNotice(null)
        await action()
      } catch (cause) {
        // A refused call must be visible. Silently leaving the list unchanged is how a user learns
        // not to trust the delete button.
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    []
  )

  const grouped = useMemo(() => {
    const now = new Date()
    const buckets = new Map<DayGroup, HistoryVisit[]>()
    for (const entry of entries) {
      const group = dayGroupOf(entry.lastVisitedAt, now)
      const list = buckets.get(group) ?? []
      list.push(entry)
      buckets.set(group, list)
    }
    return buckets
  }, [entries])

  const removeVisit = (entry: HistoryVisit): void => {
    void run(async () => {
      const { removed } = await invoke('history:removeVisit', { url: entry.url })
      setNotice(t('history.removedCount', { count: removed }))
      await refresh(query)
    })
  }

  const removeDomain = (entry: HistoryVisit): void => {
    void run(async () => {
      const { removed } = await invoke('history:removeDomain', { domain: entry.url })
      setNotice(t('history.removedCount', { count: removed }))
      await refresh(query)
    })
  }

  const clearAll = (): void => {
    // Confirmed because it cannot be undone, and the store deletes rather than tombstones.
    if (!globalThis.confirm(t('history.clearAllConfirm'))) return
    void run(async () => {
      const { removed } = await invoke('history:clear')
      setNotice(t('history.removedCount', { count: removed }))
      await refresh(query)
    })
  }

  return (
    <main className="history">
      <header className="history__header">
        <h1 className="history__title">{t('history.title')}</h1>
        <input
          className="history__search"
          type="search"
          value={query}
          placeholder={t('history.searchPlaceholder')}
          aria-label={t('history.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          type="button"
          className="history__clear"
          onClick={clearAll}
          disabled={entries.length === 0}
        >
          {t('history.clearAll')}
        </button>
      </header>

      {/*
        Announced rather than merely shown: the count of what a deletion removed is the only
        confirmation the user gets, and it appears after the list has already changed.
      */}
      {notice !== null && (
        <p className="history__notice" role="status">
          {notice}
        </p>
      )}

      {loaded && entries.length === 0 && (
        <p className="history__empty">
          {query === '' ? t('history.empty') : t('history.noMatches', { query })}
        </p>
      )}

      {DAY_GROUPS.filter((group) => (grouped.get(group)?.length ?? 0) > 0).map((group) => {
        const list = grouped.get(group) ?? []
        return (
          <section className="history__group" key={group}>
            <h2
              className="history__groupTitle"
              aria-label={t('history.groupLabel', { group: t(GROUP_LABELS[group]), count: list.length })}
            >
              {t(GROUP_LABELS[group])}
            </h2>

            <ul className="history__list">
              {list.map((entry) => {
                const readable = readableUrl(entry.url)
                // A page with no title falls back to its address — and then the address line below
                // would say the same thing twice. A row that repeats itself is harder to scan, not
                // more informative. Found by a component test.
                const title = entry.title === '' ? readable : entry.title
                const showAddress = title !== readable
                return (
                  <li className="history__entry" key={entry.url}>
                    <button
                      type="button"
                      className="history__open"
                      aria-label={t('history.open', { title })}
                      onClick={() => void run(async () => void (await invoke('history:open', { url: entry.url })))}
                    >
                      <span className="history__entryTitle">{title}</span>
                      {showAddress && <span className="history__entryUrl">{readable}</span>}
                      <span className="history__entryMeta">
                        {entry.visitCount === 1
                          ? t('history.visitedOnce')
                          : t('history.visits', { count: entry.visitCount })}
                        {' · '}
                        {t('history.lastVisit', { time: timeFormat.format(entry.lastVisitedAt) })}
                      </span>
                    </button>

                    <button
                      type="button"
                      className="history__action"
                      /*
                        `registrableDomainOfUrl`, not `registrableDomain`.

                        The latter takes a *host* and returns unrecognised input unchanged, so
                        handing it a full address made this button announce
                        "forget https://example.com/deep/page" — indistinguishable from the button
                        beside it, which forgets exactly that one page. Two controls with different
                        consequences must not read the same.
                      */
                      aria-label={t('history.removeDomain', {
                        domain: registrableDomainOfUrl(entry.url) ?? readableUrl(entry.url)
                      })}
                      onClick={() => removeDomain(entry)}
                    >
                      ⌦
                    </button>
                    <button
                      type="button"
                      className="history__action"
                      aria-label={t('history.remove', { title })}
                      onClick={() => removeVisit(entry)}
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        )
      })}
    </main>
  )
}
