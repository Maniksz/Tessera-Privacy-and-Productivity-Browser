import { lazy, Suspense, useEffect, useState } from 'react'
import type { OverlayState } from '@shared/overlay/surface.js'
import type { Platform } from '@shared/model.js'
import { invoke, subscribe } from '../bridge.js'
import { LayoutMenuSurface } from './LayoutMenuSurface.js'
import { TabDropSurface } from './TabDropSurface.js'
import { PermissionSurface } from './PermissionSurface.js'
import { NavigationRequestSurface } from './NavigationRequestSurface.js'
import { TileBarSurface } from '../../overlay/TileBarSurface.js'
import { FindBarSurface } from '../../overlay/FindBarSurface.js'
import { PickerBarSurface } from '../../overlay/PickerBarSurface.js'

/**
 * The two surfaces this bundle fetches the first time they are shown, and not before.
 *
 * The layer's bundle is loaded into every window, and it has a budget (`tests/architecture.test.ts`,
 * 20 kB) that it sat a few hundred bytes under when the downloads panel arrived (KTD1). The panel is the
 * largest surface this layer has, so it lives in a chunk of its own — and the first dynamic import in
 * this renderer brings Vite's preload helper into the layer's bundle with it, which the few hundred bytes
 * did not cover either.
 *
 * The master-password prompt is the other half of that bargain, by decision: the surface this layer shows
 * most rarely, moved behind the same boundary so the helper is paid for without raising a budget. What it
 * costs is one local chunk fetch the first time a window shows the prompt, and nothing it does: the core
 * takes the keystrokes before this renderer sees them either way (`capturesKeyboard`), so a prompt that
 * appears a frame later loses no character — the count it is re-presented with already includes them.
 *
 * `lazy` wants a default export and these are named ones, so each import is mapped; the names stay the
 * only way the rest of the renderer refers to them.
 */
const DownloadsPanelSurface = lazy(() =>
  import('./DownloadsPanelSurface.js').then((module) => ({ default: module.DownloadsPanelSurface }))
)
const MasterPasswordSurface = lazy(() =>
  import('./MasterPasswordSurface.js').then((module) => ({ default: module.MasterPasswordSurface }))
)
/*
  The account picker, behind the same boundary and for the same bargain: drawn statically it took the
  layer's bundle past its 20 kB budget, and it is shown only after a press on a badge or the key. The
  core holds the request while the chunk arrives, so a list that appears a frame later loses nothing.
*/
const AutofillSuggestSurface = lazy(() =>
  import('./AutofillSuggestSurface.js').then((module) => ({
    default: module.AutofillSuggestSurface
  }))
)
/*
  The address bar's suggestions, behind the same boundary and for the same budget. The first keystroke
  that shows a list pays one local chunk fetch; every later one is an update of a surface already drawn.
*/
const OmniboxSuggestionsSurface = lazy(() =>
  import('./OmniboxSuggestionsSurface.js').then((module) => ({
    default: module.OmniboxSuggestionsSurface
  }))
)

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
function useShortcutContext(): {
  platform: Platform | null
  overrides: Readonly<Record<string, string>>
} {
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
    /*
      And except for the popup-or-redirect prompt, for the permission prompt's reason exactly: the core is
      holding a callback, and a generic dismissal here would race the surface's own Escape handler. Either
      winner leaves the same defect — a navigation that is neither performed nor refused, or one refused
      twice.
    */
    if (presentation.kind === 'navigation-request') return
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
    // Nothing while the chunk arrives, rather than a placeholder: the prompt draws a count the core
    // keeps, so there is nothing a placeholder could show that the real surface would not a moment later.
    return (
      <Suspense fallback={null}>
        <MasterPasswordSurface presentation={presentation} />
      </Suspense>
    )
  }

  /*
    Returned before the wrapper below for the permission prompt's reason: a click that misses would dismiss
    the layer, and for this surface a dismissal is a refusal of a question the user may still be reading.
    Refusing is the safe answer here, so the cost is smaller than for a consent dialogue — but it is still
    the browser answering on the user's behalf, and the surface answers Escape itself.
  */
  if (presentation.kind === 'navigation-request') {
    return <NavigationRequestSurface presentation={presentation} />
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

  /*
    Returned before the wrapper below, for the find bar's reason: the layer is sized to the box, so the bar *is*
    the layer and there is no outside to click. Inside the wrapper, every click on the bar's own padding would be
    a miss and would end a selection the user is in the middle of judging.

    The generic Escape handler above is deliberately left in play. The bar stops Escape itself and answers it with
    a *named* cancel — a dismissal takes down whatever is up, and one that raced a consent dialogue onto the layer
    would take the dialogue down — but if it ever failed to stop the event, a dismissal still ends the session and
    lifts the provisional rule off the page through the layer's vacancy route. The fallback is worse and not wrong.
  */
  if (presentation.kind === 'picker-bar') {
    return <PickerBarSurface presentation={presentation} />
  }

  /*
    Returned before the wrapper below for the find bar's reason exactly: the layer is cut to this
    list's own rectangle, so the list *is* the layer and a press beside it lands in the page view,
    never here. Inside the wrapper, every press on the list's own padding would be a miss and would
    dismiss somebody's account picker as they reached for it.

    The three answers travel from here rather than from the surface, so the surface can be rendered
    by a test without a bridge. A dismissal is the ordinary `overlay:dismiss`: the picker's departure
    is what discards the fill request and takes the badge's highlight off the page, and routing
    Escape through a fourth verb would have been a second way to leave those two undone.
  */
  if (presentation.kind === 'autofill-suggest') {
    return (
      <Suspense fallback={null}>
        <AutofillSuggestSurface
          presentation={presentation}
          onChoose={({ requestId, entryId }) => {
            void invoke('passwords:answerSuggestion', { requestId, action: 'choose', entryId })
          }}
          onUnlock={({ requestId }) => {
            void invoke('passwords:answerSuggestion', { requestId, action: 'unlock' })
          }}
          onDismiss={() => {
            void invoke('overlay:dismiss')
          }}
        />
      </Suspense>
    )
  }

  /*
    Returned before the wrapper below for the account picker's reason: the layer is cut to the list, so a
    press beside it lands in the page or the toolbar and never here. The surface chooses a row on the press,
    over the same channels the address bar uses on Enter (`chooseSuggestion`); the core closes the list.
  */
  if (presentation.kind === 'omnibox-suggestions') {
    return (
      <Suspense fallback={null}>
        <OmniboxSuggestionsSurface presentation={presentation} />
      </Suspense>
    )
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
      {presentation.kind === 'downloads-panel' && (
        <Suspense fallback={null}>
          <DownloadsPanelSurface presentation={presentation} />
        </Suspense>
      )}
    </div>
  )
}
