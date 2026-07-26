import { useMemo } from 'react'
import { SettingsView, type SettingsHost, type Snapshot } from '@renderer-shared/SettingsView.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * The settings panel: the in-window entry point.
 *
 * An adapter, not an implementation. Everything settings *are* lives in `SettingsView`, which the
 * `tessera://settings` page renders as well — one surface with two entry points, because the user asked
 * for both and two implementations of the same screen would drift within a month.
 *
 * All this file supplies is the four operations the view needs, bound to the chrome bridge. The page's
 * adapter is the same length and binds them to the narrow internal bridge, which has exactly the seven
 * settings channels and nothing else.
 */

interface SettingsPanelProps {
  settings: Snapshot | null
  onClose: () => void
}

export function SettingsPanel({ settings, onClose }: SettingsPanelProps): React.ReactNode {
  const { t } = useI18n()

  // Memoised on `t`, which changes only when the language does. Without it the object would be new on
  // every render, and the view's `describe()` effect — keyed on the host — would refetch the descriptors
  // on every character typed into the search box.
  const host = useMemo<SettingsHost>(
    () => ({
      describe: () => invoke('settings:describe'),
      set: async (key, value) => {
        await invoke('settings:set', { key, value })
      },
      reset: async (key) => {
        await invoke('settings:reset', { key })
      },
      t
    }),
    [t]
  )

  return <SettingsView host={host} settings={settings} onClose={onClose} />
}
