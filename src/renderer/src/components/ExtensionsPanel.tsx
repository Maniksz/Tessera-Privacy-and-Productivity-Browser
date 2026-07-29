import { useMemo } from 'react'
import { ExtensionsView, type ExtensionsHost } from '@renderer-shared/ExtensionsView.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * The extensions panel: the in-window entry point.
 *
 * An adapter over `ExtensionsView`, which the `tessera://extensions` page renders as well: one
 * implementation, two entry points, because two implementations of one screen drift within a month.
 *
 * This is now the only panel of the pair. `SettingsPanel` was deleted when settings became a page —
 * the user asked for a real tab and not a surface drawn over the window — so `ExtensionsView` is the
 * only remaining reason the `.overlay` and `.panel` rules exist in the chrome stylesheet.
 */
export function ExtensionsPanel({ onClose }: { onClose: () => void }): React.ReactNode {
  const { t } = useI18n()

  // Memoised on `t`: the view's initial `list()` effect is keyed on the host, so a new object per
  // render would refetch the list continuously.
  const host = useMemo<ExtensionsHost>(
    () => ({
      list: () => invoke('extensions:list'),
      load: () => invoke('extensions:load'),
      remove: async (id) => {
        await invoke('extensions:remove', { id })
      },
      t
    }),
    [t]
  )

  return <ExtensionsView host={host} onClose={onClose} />
}
