import { useEffect, useRef, useState } from 'react'
import type { MessageKey } from '@shared/i18n/catalog.js'
import {
  IMPORT_BROWSER_NAMES,
  type BookmarkImportOutcome,
  type HistoryImportCounts,
  type HistoryImportOutcome,
  type ImportRefusal,
  type ImportSource
} from '@shared/import/model.js'
import type { Translate } from '@renderer-shared/SettingsView.js'

/**
 * „Importieren" — bookmarks and history from Chrome, Edge, Chromium and Firefox (U24, R39).
 *
 * The page names a profile by the id the core listed and nothing else; the core reads the files. The
 * history is always previewed first: the page says how many entries are added, merged and left out
 * under the cap before anything is written, and imports only on the second press. Firefox's bookmarks
 * come from its profile too, and the HTML file stays as the way in when that cannot be read. Passwords
 * are one sentence and a button to the password manager, whose CSV import is the only way in.
 */

export interface ImportHost {
  sources(): Promise<readonly ImportSource[]>
  importBookmarks(source: string): Promise<BookmarkImportOutcome>
  previewHistory(source: string): Promise<HistoryImportOutcome>
  importHistory(source: string): Promise<HistoryImportOutcome>
  /** The existing HTML import: the core opens the picker. */
  importHtml(): Promise<{ imported: number; skipped: number; cancelled: boolean }>
  openPasswordManager(): Promise<unknown>
  t: Translate
}

const REFUSALS: Readonly<Record<ImportRefusal, MessageKey>> = {
  missing: 'import.missing',
  locked: 'import.locked',
  unreadable: 'import.unreadable',
  'read-only': 'import.readOnly',
  full: 'import.full'
}

function labelOf(source: ImportSource): string {
  return `${IMPORT_BROWSER_NAMES[source.browser]} — ${source.profile}`
}

export function ImportSection({ host }: { host: ImportHost }): React.ReactNode {
  const { t } = host
  const [sources, setSources] = useState<readonly ImportSource[] | null>(null)
  const [chosen, setChosen] = useState('')
  const [preview, setPreview] = useState<HistoryImportCounts | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const section = useRef<HTMLElement>(null)

  useEffect(() => {
    let cancelled = false
    void host.sources().then(
      (found) => {
        if (cancelled) return
        setSources(found)
        setChosen(found[0]?.id ?? '')
        // The start page's card opens `tessera://settings#import`: bring the section into view.
        if (location.hash === '#import') section.current?.scrollIntoView({ block: 'start' })
      },
      () => {
        if (cancelled) return
        setSources([])
        setMessage(t('backup.failed'))
      }
    )
    return () => {
      cancelled = true
    }
  }, [host, t])

  const source = sources?.find((candidate) => candidate.id === chosen) ?? null

  const refusal = (reason: ImportRefusal): string =>
    t(REFUSALS[reason], {
      browser: source === null ? '' : IMPORT_BROWSER_NAMES[source.browser]
    })

  const run = (work: () => Promise<string | null>): void => {
    setBusy(true)
    setMessage(null)
    void work()
      .then(setMessage, () => setMessage(t('backup.failed')))
      .finally(() => setBusy(false))
  }

  const importBookmarks = (id: string): void => {
    run(async () => {
      const outcome = await host.importBookmarks(id)
      if (outcome.outcome === 'refused') return refusal(outcome.reason)
      return t('import.bookmarksDone', {
        imported: outcome.imported,
        duplicates: outcome.duplicates,
        skipped: outcome.skipped
      })
    })
  }

  const previewHistory = (id: string): void => {
    run(async () => {
      const outcome = await host.previewHistory(id)
      if (outcome.outcome === 'refused') return refusal(outcome.reason)
      setPreview(outcome.counts)
      return null
    })
  }

  const importHistory = (id: string): void => {
    run(async () => {
      const outcome = await host.importHistory(id)
      setPreview(null)
      if (outcome.outcome === 'refused') return refusal(outcome.reason)
      return t('import.historyDone', {
        added: outcome.counts.added,
        merged: outcome.counts.merged
      })
    })
  }

  const importHtml = (): void => {
    run(async () => {
      const result = await host.importHtml()
      if (result.cancelled) return null
      return t('bookmarks.importResult', { imported: result.imported, skipped: result.skipped })
    })
  }

  return (
    <section className="panel__section" aria-labelledby="import-heading" id="import" ref={section}>
      <h3 className="panel__sectionTitle" id="import-heading">
        {t('import.title')}
      </h3>

      {sources !== null && sources.length === 0 && (
        <p className="field__description">{t('import.none')}</p>
      )}

      {sources !== null && sources.length > 0 && (
        <div className="field">
          <div className="field__text-block">
            <label className="field__label" htmlFor="import-source">
              {t('import.source')}
            </label>
          </div>
          <div className="field__control backup__inputs">
            <select
              id="import-source"
              className="field__select"
              value={chosen}
              onChange={(event) => {
                setChosen(event.target.value)
                setPreview(null)
                setMessage(null)
              }}
            >
              {sources.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {labelOf(candidate)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="dialog__button"
              disabled={busy || source?.bookmarks !== true}
              onClick={() => importBookmarks(chosen)}
            >
              {t('import.bookmarks')}
            </button>
            <button
              type="button"
              className="dialog__button"
              disabled={busy || source?.history !== true}
              onClick={() => previewHistory(chosen)}
            >
              {t('import.history')}
            </button>
          </div>
        </div>
      )}

      {preview !== null && (
        <div className="backup__preview">
          <p className="field__description">
            {t('import.historyPreview', {
              added: preview.added,
              merged: preview.merged,
              skipped: preview.skipped
            })}
          </p>
          {preview.dropped > 0 && (
            <p className="field__description">
              {t('import.historyDropped', { dropped: preview.dropped })}
            </p>
          )}
          <div className="panel__lead">
            <button
              type="button"
              className="dialog__button dialog__button--primary"
              disabled={busy}
              onClick={() => importHistory(chosen)}
            >
              {t('import.historyConfirm')}
            </button>
            <button type="button" className="dialog__button" onClick={() => setPreview(null)}>
              {t('passwords.cancel')}
            </button>
          </div>
        </div>
      )}

      {message !== null && (
        <p className="panel__notice" role="status">
          {message}
        </p>
      )}

      <div className="field">
        <div className="field__text-block">
          <span className="field__label">{t('import.htmlTitle')}</span>
          <p className="field__description">{t('import.htmlHint')}</p>
        </div>
        <div className="field__control">
          <button type="button" className="dialog__button" disabled={busy} onClick={importHtml}>
            {t('bookmarks.import')}
          </button>
        </div>
      </div>

      <div className="field">
        <div className="field__text-block">
          <span className="field__label">{t('passwords.title')}</span>
          <p className="field__description">{t('import.passwords')}</p>
        </div>
        <div className="field__control">
          <button
            type="button"
            className="dialog__button"
            onClick={() => void host.openPasswordManager().catch(() => undefined)}
          >
            {t('settings.openPasswordManager')}
          </button>
        </div>
      </div>
    </section>
  )
}
