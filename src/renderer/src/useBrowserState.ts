import { useEffect, useState } from 'react'
import type { SplitState, TabState, WindowState } from '@shared/model.js'
import type { TabGroup } from '@shared/tabgroups/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { invoke, subscribe } from './bridge.js'

/**
 * Mirrors the core's state into the UI.
 *
 * Every subscription is torn down on unmount. Spec 6 requires a way back off
 * each channel for exactly this reason: a window that closes must not leave the
 * main process pushing updates into a renderer that no longer exists.
 */

export interface BrowserState {
  /**
   * Every tab, in group order — including the members of a collapsed group.
   *
   * Folded tabs are sent rather than filtered out because the chip has to say how many are hidden.
   * Which ones to draw is decided with `visibleTabOrder`, the same function the core settles the order
   * with, so the two sides cannot disagree about it.
   */
  tabs: TabState[]
  groups: TabGroup[]
  activeTabId: string | null
  split: SplitState | null
  window: WindowState | null
  settings: SettingsSnapshot | null
}

const EMPTY: BrowserState = {
  tabs: [],
  groups: [],
  activeTabId: null,
  split: null,
  window: null,
  settings: null
}

export function useBrowserState(): BrowserState {
  const [state, setState] = useState<BrowserState>(EMPTY)

  useEffect(() => {
    let cancelled = false

    // Initial pull: events only carry changes, so the first picture has to be
    // requested.
    void Promise.all([
      invoke('window:getState'),
      invoke('settings:getAll')
    ]).then(([windowState, settings]) => {
      if (cancelled) return
      setState((previous) => ({ ...previous, window: windowState, settings }))
    })

    const unsubscribers = [
      subscribe('tabs:changed', ({ tabs, activeTabId }) => {
        setState((previous) => ({ ...previous, tabs, activeTabId }))
      }),
      /*
        Separate from `tabs:changed` although the two usually arrive together.

        Renaming a group changes a group and nothing else, so folding it into the tab event would mean
        re-rendering every tab to change one label — and, worse, would make a rename look like a tab
        change to anything watching.
      */
      subscribe('tabgroups:changed', ({ groups }) => {
        setState((previous) => ({ ...previous, groups }))
      }),
      subscribe('split:changed', (split) => {
        setState((previous) => ({ ...previous, split }))
      }),
      subscribe('window:stateChanged', (windowState) => {
        setState((previous) => ({ ...previous, window: windowState }))
      }),
      subscribe('settings:changed', ({ snapshot }) => {
        setState((previous) => ({ ...previous, settings: snapshot }))
      })
    ]

    return () => {
      cancelled = true
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [])

  return state
}
