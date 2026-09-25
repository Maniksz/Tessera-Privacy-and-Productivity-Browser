import { useCallback, useEffect, useLayoutEffect, useState } from 'react'
import { MAX_WORKSPACE_NAME, workspaceName, type WorkspaceMenu } from '@shared/workspaces/model.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import { LayoutIcon } from '../components/LayoutIcon.js'
import { focusOnMount } from '@renderer-shared/focus-on-mount.js'

/**
 * The layout menu's workspaces (U21): the saved list, and "Save as…" with its name field.
 *
 * Its own chunk, fetched the first time the menu opens: the overlay's main chunk has a 20 kB budget it
 * sits just under, which is the bargain `OverlaySurface` makes for its rarer surfaces. A text field and
 * an inline question stand in for a prompt, which the overlay cannot raise.
 *
 * Nothing is decided here. The core answers whether this window may save (`canSave`, false in a private
 * window) and whether the file is a newer version's (`readOnly`); a taken name comes back as `exists`
 * and is overwritten only when the question is answered with Save. `onResize` tells the menu to measure
 * itself again, because the list arrives after the menu was placed.
 */

interface Draft {
  name: string
  /** The name is taken, and the menu is asking whether to overwrite it. */
  asking: boolean
}

export function WorkspacesMenu({ onResize }: { onResize: () => void }): React.ReactNode {
  const { t } = useI18n()
  const [menu, setMenu] = useState<WorkspaceMenu | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)

  const refresh = useCallback(async () => setMenu(await invoke('workspaces:list')), [])

  useEffect(() => {
    let live = true
    void invoke('workspaces:list').then((answer) => {
      if (live) setMenu(answer)
    })
    return () => {
      live = false
    }
  }, [])

  // What changes the menu's height: the list, and which of the entry, the field or the question
  // shows. Not every keystroke in the field.
  const shape = draft === null ? 'entry' : draft.asking ? 'question' : 'field'
  useLayoutEffect(onResize, [menu, shape, onResize])

  if (menu === null) return null

  const save = async (name: string, replace: boolean): Promise<void> => {
    const { outcome } = await invoke('workspaces:save', { name, replace })
    if (outcome === 'read-only') {
      // The file turned out to be a newer version's: say so where the entry was, and stop offering it.
      setDraft(null)
      setMenu({ ...menu, readOnly: true })
      return
    }
    // A name that is taken asks; anything else unsaved keeps the field, with the name, to try again.
    setDraft(outcome === 'saved' ? null : { name, asking: outcome === 'exists' })
    await refresh()
  }

  const remove = async (id: string): Promise<void> => {
    await invoke('workspaces:remove', { id })
    await refresh()
  }

  return (
    <>
      <div className="menu__separator" role="separator" />
      {menu.workspaces.map((workspace) => (
        <div key={workspace.id} className="menu__row">
          <button
            type="button"
            role="menuitem"
            className="menu__item"
            onClick={() => void invoke('workspaces:open', { id: workspace.id })}
          >
            <span className="menu__icon">
              <LayoutIcon layout={workspace.layoutId} size={16} />
            </span>
            <span className="menu__label">{workspace.name}</span>
          </button>
          {!menu.readOnly && (
            <button
              type="button"
              className="menu__remove"
              aria-label={t('workspaces.remove', { name: workspace.name })}
              onClick={() => void remove(workspace.id)}
            >
              ×
            </button>
          )}
        </div>
      ))}
      {draft === null && (
        <button
          type="button"
          role="menuitem"
          className="menu__item"
          disabled={!menu.canSave || menu.readOnly}
          onClick={() => setDraft({ name: '', asking: false })}
        >
          <span className="menu__icon" />
          <span className="menu__label">{t('workspaces.saveAs')}</span>
        </button>
      )}
      {draft !== null && draft.asking && (
        <div className="menu__form">
          <span className="menu__label">
            {t('workspaces.replace', { name: draft.name.trim() })}
          </span>
          <button type="button" onClick={() => void save(draft.name, true)}>
            {t('bookmarks.save')}
          </button>
          <button type="button" onClick={() => setDraft({ ...draft, asking: false })}>
            {t('bookmarks.cancel')}
          </button>
        </div>
      )}
      {draft !== null && !draft.asking && (
        <form
          className="menu__form"
          onSubmit={(event) => {
            event.preventDefault()
            void save(draft.name, false)
          }}
        >
          <input
            // The field is what the entry was pressed for, so it takes the keys at once.
            ref={focusOnMount}
            aria-label={t('workspaces.name')}
            placeholder={t('workspaces.name')}
            maxLength={MAX_WORKSPACE_NAME}
            value={draft.name}
            onChange={(event) => setDraft({ name: event.currentTarget.value, asking: false })}
          />
          <button type="submit" disabled={workspaceName(draft.name) === null}>
            {t('bookmarks.save')}
          </button>
        </form>
      )}
      {menu.readOnly && <p className="menu__note">{t('workspaces.readOnly')}</p>}
    </>
  )
}
