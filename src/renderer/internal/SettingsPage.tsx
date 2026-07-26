import { useEffect, useMemo, useState } from 'react'
import { SettingsView, type SettingsHost, type Snapshot } from '@renderer-shared/SettingsView.js'
import { bridgeAvailable, invoke } from './bridge.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://settings` — the settings surface as a real page.
 *
 * An adapter over the same `SettingsView` the in-window panel renders. Both entry points exist because
 * the user asked for both; one implementation exists because two would drift.
 *
 * The page is the *less* privileged of the two hosts: its bridge carries exactly the seven settings
 * channels from `INTERNAL_PAGE_INVOKE_CHANNELS.settings`, where the chrome renderer hosting the panel
 * has all of them. Being a page is what makes settings zoomable, linkable and usable inside a split
 * tile — none of which a panel drawn over the window can be.
 *
 * ## Why this is a separate file from `settings.tsx`
 *
 * Same split as `HistoryPage.tsx` and `history.tsx`, and for a reason that is not tidiness: the entry
 * file calls `createRoot` at module scope, so anything that imports it mounts a second React root into
 * a document it does not own. A test cannot import an entry — which would mean the page half of the
 * seam had no test, and the seam is the whole claim this feature rests on. The component is exported
 * so it can be rendered against a stub bridge; the entry stays three lines of plumbing.
 */
export function SettingsPage(): React.ReactNode {
  const { locale, t } = useInternalI18n()
  const [settings, setSettings] = useState<Snapshot | null>(null)

  // Memoised on `t`, which changes identity only when the catalogue arrives or the language changes.
  // Without it the host object would be new on every render and the view's `describe()` effect — keyed
  // on the host — would refetch the descriptors on every character typed into the search box.
  const host = useMemo<SettingsHost>(
    () => ({
      describe: () => invoke('settings:describe'),
      set: async (key, value) => {
        await invoke('settings:set', { key, value })
        // Re-read rather than patching the local copy: the core may clamp or normalise a value, and a
        // page that showed what it *sent* would disagree with what was stored.
        setSettings(await invoke('settings:getAll'))
      },
      reset: async (key) => {
        await invoke('settings:reset', { key })
        setSettings(await invoke('settings:getAll'))
      },
      t
    }),
    [t]
  )

  useEffect(() => {
    if (!bridgeAvailable()) return
    let cancelled = false
    void invoke('settings:getAll').then((snapshot) => {
      if (!cancelled) setSettings(snapshot)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // `onClose` deliberately omitted: a tab has nothing to dismiss, so the view drops the close button,
  // the backdrop and the focus trap. A close button on a page that did nothing would be worse than none.
  return (
    <main className="panelPage" lang={locale}>
      <SettingsView host={host} settings={settings} />
    </main>
  )
}
