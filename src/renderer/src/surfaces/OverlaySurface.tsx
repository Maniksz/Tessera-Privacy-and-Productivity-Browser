import { useEffect, useState } from 'react'
import type { OverlayState } from '@shared/overlay/surface.js'
import { invoke, subscribe } from '../bridge.js'
import { LayoutMenuSurface } from './LayoutMenuSurface.js'
import { TabDropSurface } from './TabDropSurface.js'
import { PermissionSurface } from './PermissionSurface.js'
import { TileBarSurface } from '../../overlay/TileBarSurface.js'
import { FindBarSurface } from '../../overlay/FindBarSurface.js'

/**
 * Root of the window's topmost layer.
 *
 * Renders whatever the core says should be presented and nothing otherwise. It holds no
 * state of its own beyond the last message: the core owns what is on screen, so the two can
 * never disagree about whether a menu is open.
 */

export function OverlaySurface(): React.ReactNode {
  const [presentation, setPresentation] = useState<OverlayState>(null)

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
      {presentation.kind === 'layout-menu' && <LayoutMenuSurface presentation={presentation} />}
    </div>
  )
}
