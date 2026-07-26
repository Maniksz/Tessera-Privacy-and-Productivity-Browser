import { useMemo } from 'react'
import { ExtensionsView, type ExtensionsHost } from '@renderer-shared/ExtensionsView.js'
import { invoke } from './bridge.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://extensions` — the extensions surface as a real page.
 *
 * An adapter over the same `ExtensionsView` the in-window panel renders. The page's bridge carries
 * exactly the four channels `INTERNAL_PAGE_INVOKE_CHANNELS.extensions` grants and nothing else.
 *
 * Separate from `extensions.tsx` for the reason spelled out in `SettingsPage.tsx`: an entry file
 * mounts a React root when it is imported, so only a component in its own file can be tested.
 */
export function ExtensionsPage(): React.ReactNode {
  const { locale, t } = useInternalI18n()

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

  return (
    <main className="panelPage" lang={locale}>
      <ExtensionsView host={host} />
    </main>
  )
}
