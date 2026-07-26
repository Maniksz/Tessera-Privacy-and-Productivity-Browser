import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtensionInfo } from '@shared/extensions/model.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { usePanelDismiss } from './usePanelDismiss.js'
import { useCoreCall } from './useCoreCall.js'

/**
 * The extensions surface, hosted by either the chrome UI or the `tessera://extensions` page.
 *
 * Same arrangement as `SettingsView`, and for the same reason: two entry points is what the user asked
 * for, two implementations is what would drift. Everything about how extensions are presented lives
 * here; each host supplies only the three operations and a translator.
 *
 * The limitations are stated at the top of the surface rather than discovered by the user, because they
 * are severe and structural: no store, no `.crx`, no automatic updates, only a subset of the extension
 * APIs, and no toolbar button, popup or options page for an extension to render into. An extension is
 * also detectable by websites, which works against this browser's whole reason for existing. Saying
 * that plainly is the difference between a limited feature and a misleading one.
 */

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

export interface ExtensionsHost {
  list(): Promise<ExtensionInfo[]>
  /** Opens the OS folder picker in the core. `error` is `null` for both success and a cancelled dialog. */
  load(): Promise<{ error: string | null }>
  remove(id: string): Promise<void>
  t: Translate
}

export interface ExtensionsViewProps {
  host: ExtensionsHost
  /** Present only in the panel; a tab has nothing to dismiss. See `SettingsView` for the full reasoning. */
  onClose?: (() => void) | undefined
}

export function ExtensionsView({ host, onClose }: ExtensionsViewProps): React.ReactNode {
  const { t } = host
  const [items, setItems] = useState<ExtensionInfo[]>([])
  const { error, run, report } = useCoreCall()
  const panelRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (): Promise<void> => {
    setItems(await host.list())
  }, [host])

  useEffect(() => {
    let cancelled = false
    // Guarded so a panel closed mid-request does not write into an unmounted component, and run through
    // `run` so a refused `extensions:list` says so — it used to render as "No extensions loaded", which
    // is a different and reassuring claim.
    void run(async () => {
      const next = await host.list()
      if (!cancelled) setItems(next)
    })
    return () => {
      cancelled = true
    }
  }, [host, run])

  /*
    Escape *and* the focus trap, where this file previously had only Escape.

    It set `role="dialog" aria-modal` in panel mode and kept a `panelRef` that nothing read, so the
    panel announced itself as modal and let Tab leave anyway. The hook holds both halves now, shared
    with `SettingsView` so the two panels cannot drift apart again.
  */
  usePanelDismiss(panelRef, onClose)

  /*
    `load` and `remove` both go through `run`, which they did not before.

    `remove` was a bare `await host.remove(id)` behind `void remove(item)`: a refused removal threw into
    nothing, the list was re-read unchanged, and the user saw an extension they had just tried to delete
    still sitting there with no explanation. `load` was unguarded against the call *itself* rejecting —
    it handled only the `{ error }` the core returns for a folder it could not read.
  */
  const load = (): Promise<void> =>
    run(async () => {
      const result = await host.load()
      // `error: null` covers both a successful load and a cancelled picker, so there is nothing to
      // report for either — but the list is re-read in every case, because a load that partially
      // succeeded still changed it.
      if (result.error !== null) report(t('extensions.loadFailed', { reason: result.error }))
      await refresh()
    })

  const remove = (item: ExtensionInfo): Promise<void> =>
    run(async () => {
      await host.remove(item.id)
      await refresh()
    })

  const body = (
    <div
      className="panel panel--narrow"
      {...(onClose === undefined ? {} : { role: 'dialog', 'aria-modal': true })}
      aria-labelledby="extensions-heading"
      ref={panelRef}
    >
      <header className="panel__header">
        <h2 className="panel__heading" id="extensions-heading">
          {t('extensions.title')}
        </h2>
        {onClose !== undefined && (
          <button
            type="button"
            className="iconbutton"
            aria-label={t('extensions.close')}
            onClick={onClose}
          >
            ×
          </button>
        )}
      </header>

      <div className="panel__body">
        <p className="panel__notice">{t('extensions.reason')}</p>

        {error !== null && (
          <p className="panel__error" role="alert">
            {error}
          </p>
        )}

        {items.length === 0 ? (
          <p className="panel__empty">{t('extensions.none')}</p>
        ) : (
          <ul className="extlist">
            {items.map((item) => (
              <li className="extlist__item" key={item.id}>
                <div className="extlist__text">
                  <span className="extlist__name">{item.name}</span>
                  <span className="extlist__meta">
                    {item.version} · {item.path}
                  </span>
                </div>
                <button
                  type="button"
                  className="dialog__button"
                  aria-label={t('extensions.remove', { name: item.name })}
                  onClick={() => void remove(item)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="panel__actions">
          <button type="button" className="dialog__button dialog__button--primary" onClick={() => void load()}>
            {t('extensions.load')}
          </button>
        </div>
      </div>
    </div>
  )

  if (onClose === undefined) return body
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {body}
    </div>
  )
}
