import { useEffect, useRef, type SyntheticEvent } from 'react'
import type { QuickLinkKind } from '@shared/quicklinks/model.js'
import type { MessageKey } from '@shared/i18n/catalog.js'

/**
 * Create/edit dialog for a tile.
 *
 * The address is validated with the same classifier the core uses, so the button
 * is disabled exactly when the core would refuse — the user finds out before
 * submitting rather than through an error afterwards.
 */

/**
 * A discriminated union rather than one shape with an optional `id`: editing
 * without an id is not a state that should be representable, and the compiler can
 * enforce that only if the two modes are distinct types.
 */
export type DialogState =
  | { mode: 'create'; kind: QuickLinkKind; title: string; url: string }
  | { mode: 'edit'; id: string; kind: QuickLinkKind; title: string; url: string }

interface QuickLinkDialogProps {
  state: DialogState
  t: (key: MessageKey, params?: Record<string, string | number>) => string
  onChange: (state: DialogState) => void
  onCancel: () => void
  onSubmit: (state: DialogState) => void | Promise<void>
  previewTitle: (url: string) => string
  isUsableUrl: (value: string) => boolean
}

export function QuickLinkDialog({
  state,
  t,
  onChange,
  onCancel,
  onSubmit,
  previewTitle,
  isUsableUrl
}: QuickLinkDialogProps): React.ReactNode {
  const dialogRef = useRef<HTMLDivElement>(null)
  const firstFieldRef = useRef<HTMLInputElement>(null)

  const isFolder = state.kind === 'folder'
  const urlUsable = isFolder || isUsableUrl(state.url)
  const canSubmit = isFolder ? state.title.trim() !== '' : urlUsable

  useEffect(() => {
    firstFieldRef.current?.focus()
  }, [])

  // Focus stays inside the dialog while it is open, and Escape closes it —
  // spec 7 requires focus management, not just reachable controls.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCancel()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'input, button:not([disabled])'
      )
      if (focusable === undefined || focusable.length === 0) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    void onSubmit(state)
  }

  const heading = t(
    state.mode === 'create'
      ? isFolder
        ? 'start.dialog.newFolder'
        : 'start.dialog.newTile'
      : isFolder
        ? 'start.dialog.editFolder'
        : 'start.dialog.editTile'
  )

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-heading"
        ref={dialogRef}
      >
        <h2 className="dialog__heading" id="dialog-heading">
          {heading}
        </h2>

        <form onSubmit={submit}>
          {!isFolder && (
            <label className="dialog__field">
              <span className="dialog__label">{t('start.dialog.address')}</span>
              <input
                ref={firstFieldRef}
                className="dialog__input"
                value={state.url}
                inputMode="url"
                spellCheck={false}
                autoComplete="off"
                placeholder="example.com"
                aria-invalid={state.url !== '' && !urlUsable}
                aria-describedby="dialog-url-hint"
                onChange={(event) => onChange({ ...state, url: event.target.value })}
              />
              <span className="dialog__hint" id="dialog-url-hint">
                {state.url === ''
                  ? t('start.dialog.addressHint')
                  : urlUsable
                    ? t('start.dialog.addressResolved', { title: previewTitle(state.url) })
                    : t('start.dialog.addressInvalid')}
              </span>
            </label>
          )}

          <label className="dialog__field">
            <span className="dialog__label">{t('start.dialog.name')}</span>
            <input
              ref={isFolder ? firstFieldRef : undefined}
              className="dialog__input"
              value={state.title}
              maxLength={80}
              autoComplete="off"
              placeholder={isFolder ? '' : previewTitle(state.url)}
              onChange={(event) => onChange({ ...state, title: event.target.value })}
            />
            {!isFolder && (
              <span className="dialog__hint">{t('start.dialog.nameHint')}</span>
            )}
          </label>

          <div className="dialog__buttons">
            <button type="button" className="dialog__button" onClick={onCancel}>
              {t('start.dialog.cancel')}
            </button>
            <button
              type="submit"
              className="dialog__button dialog__button--primary"
              disabled={!canSubmit}
            >
              {t(state.mode === 'create' ? 'start.dialog.create' : 'start.dialog.save')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
