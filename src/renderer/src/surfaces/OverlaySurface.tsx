import { useEffect, useState } from 'react'
import type { OverlayState } from '@shared/overlay/surface.js'
import type { Platform } from '@shared/model.js'
import { invoke, subscribe } from '../bridge.js'
import { LayoutMenuSurface } from './LayoutMenuSurface.js'
import { TabDropSurface } from './TabDropSurface.js'
import { PermissionSurface } from './PermissionSurface.js'
import { MasterPasswordSurface } from './MasterPasswordSurface.js'
import { TileBarSurface } from '../../overlay/TileBarSurface.js'
import { FindBarSurface } from '../../overlay/FindBarSurface.js'

/**
 * Root of the window's topmost layer.
 *
 * Renders whatever the core says should be presented and nothing otherwise. It holds no
 * state of its own beyond the last message: the core owns what is on screen, so the two can
 * never disagree about whether a menu is open.
 */

/**
 * The platform and the user's key overrides, read by this layer for itself.
 *
 * This is a *second renderer*. It does not share the chrome UI's state, so the platform it needs to
 * write `⇧⌘2` rather than `Ctrl+Shift+2` has to come from somewhere — and the two candidates were
 * widening the presentation to carry finished display text, or asking, as the chrome UI already does.
 *
 * Asking, by decision: a presentation carries *what is on screen*, and putting rendered strings into it
 * would make the core the place where a key is spelled for a platform, which is a renderer's business.
 * The cost is real and worth writing down — the accelerator tables now reach this bundle too, and
 * renderer JavaScript is already over its budget — so if that has to be paid back, the route is a core
 * channel handing over pre-resolved strings, not moving this decision.
 *
 * Both channels are already open to this view: the overlay's own `webContents` runs with the `chrome`
 * preload role (see `OverlayLayer`), so no privilege changes for this.
 */
function useShortcutContext(): { platform: Platform | null; overrides: Readonly<Record<string, string>> } {
  const [platform, setPlatform] = useState<Platform | null>(null)
  const [overrides, setOverrides] = useState<Readonly<Record<string, string>>>({})

  useEffect(() => {
    let live = true
    void Promise.all([invoke('window:getState'), invoke('settings:getAll')]).then(
      ([windowState, settings]) => {
        // The layer outlives no unmount in practice, but a fetch settling into a gone component is a
        // React warning and a habit worth not forming.
        if (!live) return
        setPlatform(windowState.platform)
        setOverrides(settings['advanced.customShortcuts'])
      }
    )
    // Rebinding a key has to change what the menu says without a restart, which is the whole reason
    // this subscribes rather than reading once.
    const stop = subscribe('settings:changed', ({ snapshot }) => {
      setOverrides(snapshot['advanced.customShortcuts'])
    })
    return () => {
      live = false
      stop()
    }
  }, [])

  return { platform, overrides }
}

export function OverlaySurface(): React.ReactNode {
  const [presentation, setPresentation] = useState<OverlayState>(null)
  const { platform, overrides } = useShortcutContext()

  useEffect(() => {
    return subscribe('overlay:presented', ({ presentation: next }) => setPresentation(next))
  }, [])

  // Escape works wherever focus happens to be on this layer, not only inside the menu.
  useEffect(() => {
    if (presentation === null) return
    /*
      Except for a surface something is waiting on. Dismissing a permission prompt without
      answering it leaves the page's promise pending forever, so that surface handles Escape
      itself and sends a refusal — see `PermissionSurface`. A generic dismissal here would
      race it and, whichever won, one of the two outcomes is a hung page.
    */
    if (presentation.kind === 'permission-request') return
    /*
      And except for the master-password prompt, where this handler could not fire even if it were
      registered: the core takes every keystroke off this view before the renderer is dispatched to
      (`capturesKeyboard`), Escape included, and cancels the request itself. Returning here says so
      rather than leaving a listener that looks like the thing handling Escape and never runs — the
      reader of the next bug would spend an afternoon on it.
    */
    if (presentation.kind === 'master-password') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void invoke('overlay:dismiss')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [presentation])

  if (presentation === null) return null

  /*
    A drag owns the pointer, so it gets the surface to itself: the dismiss-on-click wrapper
    below would swallow the drop.
  */
  if (presentation.kind === 'tab-drop') {
    return <TabDropSurface presentation={presentation} />
  }

  /*
    A prompt owns the whole layer for the same reason from the other direction: the wrapper below
    dismisses on any click that misses, and for this surface a dismissal is a refusal of a request
    the user may still be reading.
  */
  if (presentation.kind === 'permission-request') {
    return <PermissionSurface presentation={presentation} />
  }

  /*
    Returned before the wrapper for the prompt's reason, one step stronger: a click that misses would
    dismiss the layer, and a dismissed master-password prompt throws away what somebody is halfway
    through typing — with no way to tell them that is what happened.
  */
  if (presentation.kind === 'master-password') {
    return <MasterPasswordSurface presentation={presentation} />
  }

  /*
    Returned before the wrapper below, because the bar *is* the layer.

    The view is sized to one tile's top strip, so there is no outside to click. Inside the wrapper it would sit
    in a `position: fixed; inset: 0` element that dismisses on a click that misses — and every click on the
    bar's own padding would be a miss.
  */
  if (presentation.kind === 'tile-bar') {
    return <TileBarSurface presentation={presentation} />
  }

  /*
    Returned before the wrapper below, for the tile bar's reason: the layer is sized to the box, so the bar *is*
    the layer and there is no outside to click. Inside the wrapper, every click on the bar's own padding would be
    a miss and would dismiss the search.

    The generic Escape handler above is deliberately left in play: the bar stops Escape itself, and if it ever
    failed to, a dismissal here would still take the highlight off the page — clearing hangs off the bar leaving
    the layer, not off the keystroke.
  */
  if (presentation.kind === 'find-bar') {
    return <FindBarSurface presentation={presentation} />
  }

  return (
    <div
      className="surface"
      /*
        This *is* the outside click. The layer covers the whole window while a menu is up, so
        there is no other surface left to listen on — and a click that misses the menu is the
        one gesture every menu is expected to close on.
      */
      onPointerDown={(event) => {
        if (event.target !== event.currentTarget) return
        void invoke('overlay:dismiss')
      }}
    >
      {presentation.kind === 'layout-menu' && (
        <LayoutMenuSurface presentation={presentation} platform={platform} overrides={overrides} />
      )}
    </div>
  )
}
