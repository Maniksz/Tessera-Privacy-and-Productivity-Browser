import { WebContentsView, type BrowserWindow } from 'electron'
import { join } from 'node:path'
import {
  capturesKeyboard,
  departureMatters,
  mayPresentOver,
  overlayBounds,
  surfaceIdentity,
  takesFocus,
  type OverlayKind,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import type { Rect, Size } from '@shared/ui/anchor.js'
import { preloadFile, preloadRoleArgument } from '../paths.js'
import { notifyOverlayKey } from '../passwords/overlay-keys.js'
import { notifyOverlayVacancy, type OverlayVacancyReason } from '../permissions/vacancy.js'

/**
 * The window's topmost layer: the only place browser UI can be drawn *over* page content.
 *
 * ## The constraint this exists to satisfy
 *
 * Each tab is a `WebContentsView` stacked above the window's own web contents, which is
 * where the chrome UI lives. A native view is opaque to the DOM beneath it — not just
 * visually, but for hit testing — so a dropdown rendered in the toolbar's DOM is painted
 * behind the page and every click on it lands on the page instead. No amount of z-index
 * changes that; the pixels must come from a layer above the views. This is that layer.
 *
 * ## Why not the alternatives
 *
 * - **A native menu** (`Menu.popup`) would fix a menu and nothing else. The drag
 *   indicator, permission prompts and tile navigation bars all need arbitrary UI over
 *   content, and none of them is a menu.
 * - **Moving the chrome above the views** would put `-webkit-app-region: drag` inside a
 *   `WebContentsView`, risking the window's ability to be dragged by its tab strip — a
 *   core interaction, traded away for a dropdown.
 * - **Hiding the views while UI is up** (what `window:setOverlay` does for the panels) is
 *   acceptable for a full-window panel and wrong for a menu: the page would vanish to make
 *   room for a 190-pixel list.
 *
 * ## Cost
 *
 * One renderer per window, created on first use — a window whose user never opens a menu
 * never pays for it. It stays transparent and hidden between presentations, so pages
 * remain visible behind a menu rather than being hidden to make room for it.
 *
 * ## Surfaces whose departure is not free
 *
 * A menu that vanishes because the window was resized costs nobody anything, and a resize, a lost
 * focus and every layout change take one down for exactly that reason. Not every surface may be
 * taken that way — a permission prompt and a master-password prompt are dismissed *by kind* and
 * survive both interruptions, since neither a wider window nor a glance elsewhere is an answer; see
 * `DISMISSED_ON_INTERRUPTION` in `window-events.ts`. No rule keeps a surface on a layer that is going
 * away regardless: the window closes, the renderer dies, something with a stronger claim arrives. A
 * permission prompt that leaves has a page's promise unsettled behind it, so the site hangs with no
 * error anywhere; a find bar that leaves has its match still highlighted on a page, with nothing on
 * screen to say why. So every departure of a surface `departureMatters` names is announced through
 * `permissions/vacancy.ts`, and whoever owns the consequence undoes it. See that module for why the
 * announcement is not a constructor option.
 *
 * An *update* is not a departure, and telling the two apart is what `surfaceIdentity` is for: this
 * layer is also how a surface's contents change — a prompt re-presented with a new queue count, a
 * find bar re-presented with a new match count — and announcing those as departures settled the very
 * request that was still on screen.
 *
 * ## Two claims on one layer
 *
 * There is one layer per window and it shows one surface, so `present` is `replace`. That was
 * harmless while every claim came from a deliberate act, and stopped being harmless when the tile
 * navigation bar arrived: it is claimed by a pointer drifting near a tile's top edge, and
 * replacing a permission prompt refuses the page's request. So claims are ranked
 * (`OVERLAY_PRECEDENCE`), `present` can decline, and an ambient source dismisses through
 * `dismissKind` so it can only ever take down its own surface.
 */

export interface OverlayLayerOptions {
  window: BrowserWindow
  /** Told after every change so the chrome UI's button can track its own menu. */
  onPresentationChanged(state: OverlayState): void
}

export class OverlayLayer {
  #view: WebContentsView | null = null
  #presentation: OverlayState = null
  #loaded = false
  /** Set while the view is still loading, then flushed once it can receive messages. */
  #deferred: OverlayState = null

  private readonly options: OverlayLayerOptions

  constructor(options: OverlayLayerOptions) {
    this.options = options
  }

  get presentation(): OverlayState {
    return this.#presentation
  }

  /**
   * True when `webContentsId` is this layer's renderer.
   *
   * The surface is trusted browser UI and needs the full IPC surface, so the window
   * registry has to recognise it as chrome. Identity-based, like the chrome renderer
   * check itself: in development both are served over http, and any URL rule loose
   * enough to accept that would accept a visited page too.
   */
  owns(webContentsId: number): boolean {
    const view = this.#view
    if (view === null || view.webContents.isDestroyed()) return false
    return view.webContents.id === webContentsId
  }

  /**
   * Puts a surface up, unless something with a stronger claim is already there.
   *
   * `false` means declined and nothing changed — not "failed". The layer shows one surface at a
   * time, so presenting is replacing, and a replaced surface that something was waiting on is
   * settled the safe way: a permission prompt displaced by a tile bar would refuse the page's
   * request. The caller is told so it can leave its own state alone; a caller that recorded a bar
   * as visible when the layer declined it would then dismiss the *prompt* on the pointer's way out.
   * See `OVERLAY_PRECEDENCE` for the ranking and why it is data.
   */
  present(presentation: OverlayPresentation, windowSize: Size, contentRect: Rect): boolean {
    if (!mayPresentOver(presentation.kind, this.#presentation)) return false

    const view = this.#ensureView()
    const outgoing = this.#presentation
    this.#presentation = presentation
    view.setBounds(overlayBounds(presentation, windowSize, contentRect))
    view.setVisible(true)
    /*
      Focus so the surface receives Escape and the arrow keys without the user having to click
      into it first (spec 7) — but only where that is what the user asked for. This renderer
      taking focus takes it away from the page, so a tile bar revealed by a passing pointer must
      leave the keyboard where it is; see `takesFocus`.
    */
    if (takesFocus(presentation) && !view.webContents.isDestroyed()) view.webContents.focus()
    this.#send(presentation)
    this.options.onPresentationChanged(presentation)
    this.#vacated(outgoing, 'replaced', presentation)
    return true
  }

  /** Takes down whatever is up, and reports what that was. */
  dismiss(): OverlayState {
    const outgoing = this.#presentation
    if (outgoing === null) return null
    this.#presentation = null
    const view = this.#view
    if (view !== null) view.setVisible(false)
    /*
      Focus goes back to the chrome UI, where the button that opened the surface is, so a keyboard
      user is not stranded on an invisible layer — and only for a surface that had the keyboard in
      the first place. Doing it unconditionally would mean a bar that appeared under a drifting
      pointer, took no focus, and then *moved* focus out of the page on its way out: the page would
      lose the caret because the mouse passed by.
    */
    const host = this.options.window
    if (takesFocus(outgoing) && !host.isDestroyed()) host.webContents.focus()
    this.#send(null)
    this.options.onPresentationChanged(null)
    this.#vacated(outgoing, 'dismissed')
    return outgoing
  }

  /**
   * Takes the layer down only if it is showing the kind named. `false` means it was not.
   *
   * What an ambient source has to use. The tile bar is dismissed by the pointer leaving a strip,
   * and that departure can arrive after something else has taken the layer — a permission prompt
   * displaces the bar the moment a page asks for the camera. An unconditional `dismiss()` on the
   * pointer's way out would then refuse that request, which is the same accident as displacing it,
   * reached from the other direction.
   */
  dismissKind(kind: OverlayKind): boolean {
    if (this.#presentation === null || this.#presentation.kind !== kind) return false
    this.dismiss()
    return true
  }

  /** Keeps the layer's bounds correct as the window resizes. */
  layout(windowSize: Size, contentRect: Rect): void {
    const view = this.#view
    const presentation = this.#presentation
    if (view === null || presentation === null) return
    view.setBounds(overlayBounds(presentation, windowSize, contentRect))
  }

  destroy(): void {
    const view = this.#view
    const outgoing = this.#presentation
    this.#view = null
    this.#presentation = null
    // Announced before the early return below: a window can be closed with a prompt up and no
    // view ever created is not one of the ways that happens, but the request has to be
    // refused either way.
    this.#vacated(outgoing, 'gone')
    if (view === null) return
    if (!this.options.window.isDestroyed()) {
      this.options.window.contentView.removeChildView(view)
    }
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  // --- internals -----------------------------------------------------------

  /**
   * Announces a surface that has left, if its departure has a consequence.
   *
   * Called *after* this layer's own state has changed, always. A listener reacting to a
   * vacated prompt presents the next one, and if it did so while `#presentation` still held
   * the outgoing surface, the nested `present` would be overwritten the moment this call
   * returned — the request would count as presented while the layer showed something else,
   * which is the stranded state this whole mechanism exists to prevent.
   *
   * `incoming` is what replaced it, and it is how an update is told from a departure. Both a
   * permission prompt and a find bar are re-presented in place — the prompt when the number queued
   * behind it changes, the bar on every match count — and without this comparison each of those
   * announced the surface still on screen as gone. For the prompt that meant refusing the request the
   * user was reading, the moment a second one queued behind it; for the bar it would mean clearing
   * its own highlight on its first result. Same surface, so nothing has left.
   */
  #vacated(
    presentation: OverlayState,
    reason: OverlayVacancyReason,
    incoming: OverlayState = null
  ): void {
    if (presentation === null) return
    if (incoming !== null && surfaceIdentity(incoming) === surfaceIdentity(presentation)) return
    if (!departureMatters(presentation)) return
    notifyOverlayVacancy(presentation, reason)
  }

  #ensureView(): WebContentsView {
    const existing = this.#view
    if (existing !== null && !existing.webContents.isDestroyed()) return existing

    const view = new WebContentsView({
      webPreferences: {
        // Trusted browser UI, exactly like the chrome renderer: the chrome bundle, and the role
        // argument it cross-checks itself against. The main process verifies this independently by
        // web contents identity.
        preload: preloadFile('chrome'),
        additionalArguments: [preloadRoleArgument('chrome')],
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        // A surface that animates a drop indicator while the user drags must not be
        // throttled for being "in the background".
        backgroundThrottling: false
      }
    })

    // AARRGGBB, not RRGGBBAA — the alpha comes first in Electron's hex parser. Getting
    // this backwards yields opaque black, which would paint over every page.
    view.setBackgroundColor('#00000000')
    view.setVisible(false)

    // Appended, so it sits above the tab views. Tab views are inserted at index 0 for the
    // same reason; see `BrowserWindowController.createTab`.
    this.options.window.contentView.addChildView(view)

    /*
      Keystrokes for the surfaces that must not receive their own.

      One surface on this layer is a master-password field, and the whole point of it is that the
      characters never reach a renderer — so they are read here, where the browser process already has
      them, and `preventDefault` keeps them from going any further. See `capturesKeyboard` for why that
      is a property of the kind rather than a check written here, and `overlay-keys.ts` for why the
      collector is reached through a registry.

      `preventDefault` comes before the announcement deliberately: a listener that throws must not be
      able to leak the keystroke into the renderer as a side effect of failing.
    */
    view.webContents.on('before-input-event', (event, input) => {
      const presentation = this.#presentation
      if (presentation === null || !capturesKeyboard(presentation)) return
      event.preventDefault()
      notifyOverlayKey(presentation, input)
    })

    view.webContents.on('did-finish-load', () => {
      this.#loaded = true
      if (this.#deferred !== null || this.#presentation !== null) {
        this.#send(this.#deferred ?? this.#presentation)
        this.#deferred = null
      }
    })

    // A crashed surface must not be left covering the window and swallowing every click.
    view.webContents.on('render-process-gone', () => {
      this.#loaded = false
      view.setVisible(false)
      const outgoing = this.#presentation
      this.#presentation = null
      this.options.onPresentationChanged(null)
      // Nothing can be presented into a dead renderer, so a prompt that was up is refused
      // rather than reissued.
      this.#vacated(outgoing, 'gone')
    })

    this.#view = view
    this.#load(view)
    return view
  }

  #load(view: WebContentsView): void {
    const devServer = process.env.ELECTRON_RENDERER_URL
    if (devServer !== undefined && devServer !== '') {
      void view.webContents.loadURL(`${devServer}/overlay.html`)
    } else {
      void view.webContents.loadFile(join(__dirname, '../renderer/overlay.html'))
    }
  }

  #send(state: OverlayState): void {
    const view = this.#view
    if (view === null || view.webContents.isDestroyed()) return
    if (!this.#loaded) {
      this.#deferred = state
      return
    }
    view.webContents.send('overlay:presented', { presentation: state })
  }
}
