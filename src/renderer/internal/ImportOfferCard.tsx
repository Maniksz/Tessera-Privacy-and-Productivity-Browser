import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/i18n/catalog.js'
import type { ImportOffer } from '@shared/import/model.js'
import { Icon } from '../shared/Icon.js'

/**
 * The start page's card on first start (U24, Q3): coming from another browser, take its bookmarks and
 * history along. No wizard and nothing blocking — one sentence, a way to the settings page's import
 * section, and a close button that closes it for good. An import that went through closes it too.
 */

export interface ImportOfferHost {
  offer(): Promise<ImportOffer>
  close(): Promise<unknown>
  openSettings(): Promise<unknown>
  t: (key: MessageKey) => string
}

export function ImportOfferCard({ host }: { host: ImportOfferHost }): React.ReactNode {
  const { t } = host
  const [shown, setShown] = useState(false)

  useEffect(() => {
    let cancelled = false
    // A card that cannot ask is a card not shown; the start page has its own error line.
    void host.offer().then(
      ({ show }) => {
        if (!cancelled) setShown(show)
      },
      () => undefined
    )
    return () => {
      cancelled = true
    }
  }, [host])

  if (!shown) return null
  return (
    <aside className="start__offer" aria-label={t('import.title')}>
      <p className="start__offerText">{t('start.importOffer')}</p>
      <button
        type="button"
        className="start__offerButton"
        onClick={() => void host.openSettings().catch(() => undefined)}
      >
        {t('start.importOpen')}
      </button>
      <button
        type="button"
        className="start__offerClose"
        aria-label={t('start.importClose')}
        title={t('start.importClose')}
        onClick={() => {
          setShown(false)
          void host.close().catch(() => undefined)
        }}
      >
        <Icon name="close" />
      </button>
    </aside>
  )
}
