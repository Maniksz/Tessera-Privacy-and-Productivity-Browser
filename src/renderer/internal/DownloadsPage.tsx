import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  canOpenDownload,
  downloadFraction,
  downloadSourceHost,
  fileWentMissing,
  isActiveDownload,
  type DownloadEntry,
  type DownloadState
} from '@shared/downloads/model.js'
import { byteSize } from '@shared/downloads/presentation.js'
import { downloadsApi, internalBridgeAvailable, type DownloadListing } from './internal-calls.js'
import { DOWNLOAD_MESSAGES, pendingTranslator, type DownloadMessageKey } from './pending-messages.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://downloads`.
 *
 * ## Why this page is pushed to rather than polled
 *
 * A download is an event over time, so the list changes while nobody is touching it. The core
 * pushes `downloads:changed`, already coalesced to a few updates a second — see
 * `DownloadManager` for why that coalescing is in the core and not here. A page that polled
 * would either be slower than the download or busier than it needs to be, and it would have
 * to guess an interval that the core already knows.
 *
 * The first list still comes from an explicit `downloads:list`, because that call re-probes the
 * disk while the pushed one reuses what the core last saw. The distinction is deliberate and
 * documented on `DownloadEntry`: the row is a hint, the open is authoritative.
 *
 * ## What the page refuses to offer
 *
 * A completed download whose file is gone gets no Open button and no Show-in-folder button —
 * it says the file was moved or deleted instead. Offering a button that leads to a native
 * "file not found" dialogue is how a list teaches the user to distrust it. And because the
 * file can vanish between the row being drawn and the button being pressed, `downloads:open`
 * checks again and the page refreshes when it answers no.
 */

const STATE_LABELS: Readonly<Record<DownloadState, DownloadMessageKey>> = {
  progressing: 'downloads.state.progressing',
  paused: 'downloads.state.paused',
  completed: 'downloads.state.completed',
  cancelled: 'downloads.state.cancelled',
  interrupted: 'downloads.state.interrupted'
}

export function DownloadsPage(): React.ReactNode {
  const { locale } = useInternalI18n()
  const tp = useMemo(
    () => pendingTranslator<DownloadMessageKey>(locale, DOWNLOAD_MESSAGES),
    [locale]
  )

  const [entries, setEntries] = useState<DownloadEntry[]>([])
  const [privateWindow, setPrivateWindow] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const numberFormat = useMemo(
    () => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }),
    [locale]
  )
  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  const apply = useCallback((listing: DownloadListing): void => {
    setEntries(listing.downloads)
    setPrivateWindow(listing.privateWindow)
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    apply(await downloadsApi.list())
  }, [apply])

  useEffect(() => {
    let cancelled = false
    if (!internalBridgeAvailable()) {
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

  // The subscription is returned straight out of the effect, so React calls the unsubscribe —
  // the idiom the architecture test accepts alongside a named `unsubscribe`.
  useEffect(
    () =>
      downloadsApi.subscribe((listing) => {
        apply(listing)
      }),
    [apply]
  )

  const run = useCallback(
    async (action: () => Promise<void>): Promise<void> => {
      try {
        setNotice(null)
        await action()
      } catch (cause) {
        setNotice(cause instanceof Error ? cause.message : String(cause))
      }
    },
    []
  )

  const sizeText = (bytes: number): string => {
    const { value, unit } = byteSize(bytes)
    return tp('downloads.byteSize', { value: numberFormat.format(value), unit })
  }

  const progressText = (entry: DownloadEntry): string =>
    entry.totalBytes > 0
      ? tp('downloads.progress', {
          received: sizeText(entry.receivedBytes),
          total: sizeText(entry.totalBytes)
        })
      : tp('downloads.progressUnknown', { received: sizeText(entry.receivedBytes) })

  const openEntry = (entry: DownloadEntry): void => {
    void run(async () => {
      const { opened } = await downloadsApi.open(entry.id)
      if (opened) return
      // The file went between the row being drawn and this click. Saying so and refreshing is
      // the honest answer; the alternative is a native error naming a path.
      setNotice(tp('downloads.openFailed'))
      await refresh()
    })
  }

  const revealEntry = (entry: DownloadEntry): void => {
    void run(async () => {
      const { revealed } = await downloadsApi.reveal(entry.id)
      if (revealed) return
      setNotice(tp('downloads.openFailed'))
      await refresh()
    })
  }

  const clearFinished = (): void => {
    void run(async () => {
      const { removed } = await downloadsApi.clear()
      setNotice(tp('downloads.clearedCount', { count: removed }))
      await refresh()
    })
  }

  const finished = entries.filter((entry) => !isActiveDownload(entry))

  return (
    <main className="downloads" lang={locale}>
      <header className="downloads__header">
        <h1 className="downloads__title">{tp('downloads.title')}</h1>
        <button
          type="button"
          className="downloads__clear"
          onClick={clearFinished}
          disabled={finished.length === 0}
        >
          {tp('downloads.clear')}
        </button>
      </header>

      {privateWindow && (
        <p className="downloads__notice">{tp('downloads.privateNotice')}</p>
      )}

      {notice !== null && (
        <p className="downloads__notice" role="status">
          {notice}
        </p>
      )}

      {loaded && entries.length === 0 && <p className="downloads__empty">{tp('downloads.empty')}</p>}

      <ul className="downloads__list">
        {entries.map((entry) => {
          const fraction = downloadFraction(entry)
          const host = downloadSourceHost(entry)
          return (
            <li className="downloads__entry" key={entry.id}>
              <span className="downloads__name">{entry.fileName}</span>
              <span className="downloads__meta">
                {tp(STATE_LABELS[entry.state])}
                {host === '' ? '' : ` · ${tp('downloads.fromHost', { host })}`}
                {entry.state === 'completed' && entry.endedAt !== null
                  ? ` · ${timeFormat.format(entry.endedAt)}`
                  : ` · ${progressText(entry)}`}
              </span>

              {isActiveDownload(entry) && (
                <progress
                  className="downloads__progress"
                  aria-label={tp(STATE_LABELS[entry.state])}
                  /*
                    An indeterminate bar when the total is unknown, which is what `null` from
                    `downloadFraction` means. Passing 0 instead would draw an empty bar that
                    never moves for the whole download — the same picture as a stalled one.
                  */
                  {...(fraction === null ? {} : { value: fraction, max: 1 })}
                />
              )}

              {fileWentMissing(entry) && (
                <span className="downloads__missing">{tp('downloads.fileMissing')}</span>
              )}

              {entry.interruptReason !== '' && (
                <span className="downloads__missing">
                  {tp('downloads.reason', { reason: entry.interruptReason })}
                </span>
              )}

              <span className="downloads__actions">
                {canOpenDownload(entry) && (
                  <>
                    <button
                      type="button"
                      aria-label={tp('downloads.open', { name: entry.fileName })}
                      onClick={() => openEntry(entry)}
                    >
                      ⤢
                    </button>
                    <button
                      type="button"
                      aria-label={tp('downloads.reveal', { name: entry.fileName })}
                      onClick={() => revealEntry(entry)}
                    >
                      📂
                    </button>
                  </>
                )}

                {entry.state === 'progressing' && (
                  <button
                    type="button"
                    aria-label={tp('downloads.pause', { name: entry.fileName })}
                    onClick={() =>
                      void run(async () => {
                        await downloadsApi.pause(entry.id)
                      })
                    }
                  >
                    ⏸
                  </button>
                )}

                {entry.state === 'paused' && (
                  <button
                    type="button"
                    aria-label={tp('downloads.resume', { name: entry.fileName })}
                    onClick={() =>
                      void run(async () => {
                        const { changed } = await downloadsApi.resume(entry.id)
                        // The core refuses when the server cannot serve a range request, and a
                        // resume that silently restarted a nine-tenths-finished file would be
                        // worse than one that says it cannot.
                        if (!changed) setNotice(tp('downloads.cannotResume'))
                      })
                    }
                  >
                    ▶
                  </button>
                )}

                {isActiveDownload(entry) && (
                  <button
                    type="button"
                    aria-label={tp('downloads.cancel', { name: entry.fileName })}
                    onClick={() =>
                      void run(async () => {
                        await downloadsApi.cancel(entry.id)
                        await refresh()
                      })
                    }
                  >
                    ⏹
                  </button>
                )}

                <button
                  type="button"
                  aria-label={tp('downloads.remove', { name: entry.fileName })}
                  onClick={() =>
                    void run(async () => {
                      await downloadsApi.remove(entry.id)
                      await refresh()
                    })
                  }
                >
                  ×
                </button>
              </span>
            </li>
          )
        })}
      </ul>
    </main>
  )
}
