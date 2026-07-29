import { useEffect, useMemo, useState } from 'react'
import { SettingsView, type SettingsHost, type Snapshot } from '@renderer-shared/SettingsView.js'
import { bridgeAvailable, invoke, subscribe } from './bridge.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://settings` — the settings surface, and now the only one.
 *
 * An adapter over `SettingsView`. It was one of two entry points; the in-window panel was removed
 * when the user asked for settings to be a real page rather than something drawn over the window, so
 * the toolbar button, `Ctrl+,` and the menu all arrive here. Being a page is what makes settings
 * zoomable, linkable and usable inside a split tile, none of which a panel over the window can be.
 *
 * The page is the *less* privileged of the two hosts it used to have: its bridge carries exactly the
 * six channels in `INTERNAL_PAGE_INVOKE_CHANNELS.settings`, where the chrome renderer had all of them.
 * Deleting the panel therefore narrowed the surface rather than widening it.
 *
 * The sixth, `updates:checkNow`, is newer than the rest and is the only one that reaches the network.
 * It is granted to this page and to no other, which is a rule a fitness function holds rather than a
 * habit — see `gives no page but settings an update command` in `architecture.test.ts`.
 *
 * ## Why this is a separate file from `settings.tsx`
 *
 * Same split as `HistoryPage.tsx` and `history.tsx`, and for a reason that is not tidiness: the entry
 * file calls `createRoot` at module scope, so anything that imports it mounts a second React root into
 * a document it does not own. A test cannot import an entry — which would mean the page had no test at
 * all, now that it is the only way in. The component is exported so it can be rendered against a stub
 * bridge; the entry stays three lines of plumbing.
 */
export function SettingsPage(): React.ReactNode {
  const { locale, t } = useInternalI18n()
  const [settings, setSettings] = useState<Snapshot | null>(null)

  /*
    Memoised on `t`, and that dependency now carries a second job.

    The first is the original one: without memoisation the host object would be new on every render
    and the view's `describe()` effect — keyed on the host — would refetch the descriptors on every
    character typed into the search box.

    The second is the language. `settings:describe` is locale-dependent now, because the labels and
    descriptions are resolved in the core and travel on the descriptors. `useInternalI18n` re-reads
    its catalogue when `appearance.uiLanguage` changes, which gives `t` a new identity, which gives
    the host a new identity, which is exactly the signal the view already watches. So a language
    change re-describes through the path that was there, rather than through a counter added beside
    it — and the section headings and the setting labels change together instead of one at a time.
  */
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
      /*
        The one call here that does not end in a re-read, because nothing it does is stored.

        A check reports itself in a native dialog the core raises, so the `{ ok: true }` is discarded
        and only the *settling* is passed on — that is what the view keeps its button disabled for.
        No `settings:getAll` afterwards either: an update check changes no setting, and asking would
        be a call made out of habit rather than need.
      */
      checkForUpdates: async () => {
        await invoke('updates:checkNow')
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

  /*
    Somebody else's change, shown here without asking for it.

    A setting can move without this page touching it — another window's menu, a context menu, a second
    settings tab — and the event carries the whole snapshot, so there is nothing to fetch. Without this
    an open settings tab would sit there showing values that were true when it loaded, which is the one
    thing a settings screen must never do.

    Returned straight out of the effect so React calls the unsubscribe; `settings:changed` is the only
    event this page is granted, and `subscribe` checks that grant rather than assuming it.
  */
  useEffect(() => {
    return subscribe('settings:changed', ({ snapshot }) => setSettings(snapshot))
  }, [])

  return (
    <main className="panelPage" lang={locale}>
      <SettingsView host={host} settings={settings} />
    </main>
  )
}
