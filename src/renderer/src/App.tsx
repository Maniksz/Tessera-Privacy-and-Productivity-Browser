import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OverlayState } from '@shared/overlay/surface.js'
import { chromeHiddenAt, chromeInsetsFor } from '@shared/split/chrome-insets.js'
import { internalUrl } from '@shared/product.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'
import { tabsHiddenByCollapse } from '@shared/tabgroups/model.js'
import { invoke, subscribe } from './bridge.js'
import { useBrowserState } from './useBrowserState.js'
import { useTileRects } from './useTileRects.js'
import { useI18n } from './i18n.js'
import { TabBar } from './components/TabBar.js'
import { Toolbar } from './components/Toolbar.js'
import { SplitDividers } from './components/SplitDividers.js'
import { ExtensionsPanel } from './components/ExtensionsPanel.js'

/**
 * Settings opens a tab; it is not a panel any more.
 *
 * The user asked for a real page rather than something drawn over the window, and chose to remove the
 * panel outright rather than keep both. Three routes led to it — this button, `Ctrl+,`, and a Tools
 * entry — and they now agree: the two menu items call `createTab` in the core, and this one asks for
 * the same address. The surface itself did not move; `tessera://settings` already rendered the same
 * component the panel did, which is what made deleting the panel a deletion rather than a rewrite.
 */
const openSettingsTab = (): void => {
  void invoke('tabs:create', { url: internalUrl('settings') })
}

export function App(): React.ReactNode {
  const { t } = useI18n()
  const state = useBrowserState()
  const chromeRef = useRef<HTMLDivElement>(null)
  const [chromeHeight, setChromeHeight] = useState(88)
  const [panel, setPanel] = useState<'none' | 'extensions'>('none')
  /** Bumped when the user asks for the address bar; see `Omnibox`. */
  const [focusRequest, setFocusRequest] = useState(0)
  /**
   * What the overlay layer is showing.
   *
   * Tracked here rather than inside the button that opened it: the core dismisses surfaces on
   * its own — on resize, on losing focus, when a layout is chosen — and a button holding its
   * own `open` flag would keep claiming a menu that is no longer there.
   */
  const [overlay, setOverlay] = useState<OverlayState>(null)
  /** Where each tile's edges fall, for U1's active-tile frame and the per-tile empty placeholder below. */
  const { ref: contentRef, rects: tileRects } = useTileRects(state.split)

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  const privateMode = state.window?.privateMode ?? false
  /**
   * Where the content area begins *as the core sees it*, which is not always where the chrome ends.
   *
   * In window fullscreen the core gives the whole window to content and the chrome is off screen, so
   * everything this renderer draws over the tiles has to start at zero too. It did not: the divider
   * layer and the empty-tile placeholders both used the measured chrome height unconditionally, which
   * put every divider handle a chrome height below the gutter it belongs to — and a handle that is not
   * in a gutter is underneath a tile view, where it receives no pointer events at all. Reported as the
   * tile resizing being unusable in fullscreen.
   *
   * `chromeInsetsFor` is the core's own rule, imported rather than repeated; see that module for why
   * this is one function and not two agreeing ternaries.
   */
  const contentInsets = chromeInsetsFor(state.split?.escalation ?? null, {
    top: chromeHeight,
    bottom: 0,
    left: 0,
    right: 0
  })
  /*
    The same question the insets answer, asked directly rather than inferred from them.

    `contentInsets.top === 0` would be true for a window whose chrome has not been measured yet, and
    hiding the toolbar on the first frame of every window is not a trade worth making to save an import.
  */
  const chromeHidden = state.split !== null && chromeHiddenAt(state.split.escalation)
  /** `system` leaves the OS in charge of `tokens.css`'s `light-dark()` tokens; `light`/`dark` override it (D2). */
  const theme = state.settings?.['appearance.theme'] ?? 'system'

  /**
   * The renderer measures its own chrome and tells the core, which then
   * positions the native content views below it. Measuring here rather than
   * hard-coding a height in the main process is what keeps the two from
   * disagreeing when the toolbar grows a row — a bookmarks bar, a find bar, a
   * notification.
   */
  useLayoutEffect(() => {
    const element = chromeRef.current
    if (element === null) return

    const report = (): void => {
      const height = Math.ceil(element.getBoundingClientRect().height)
      setChromeHeight(height)
      void invoke('window:setChromeInsets', { top: height, bottom: 0, left: 0, right: 0 })
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    return subscribe('overlay:presented', ({ presentation }) => setOverlay(presentation))
  }, [])

  /*
    The one place `appearance.theme` reaches the DOM. `tokens.css` resolves every colour through
    `light-dark()` against whatever `color-scheme` is in force, and `[data-theme]` on `<html>` is
    the only thing that can override the OS default (spec 5: live, not a restart). `system` removes
    the attribute rather than writing it, so `:root`'s own `color-scheme: light dark` decides again
    — the same state a user gets before this setting has loaded at all.
  */
  useEffect(() => {
    if (theme === 'system') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  /** Commands the core routes to the UI because they depend on focus. */
  useEffect(() => {
    return subscribe('shortcut:triggered', ({ action }) => {
      switch (action) {
        case 'nextTab':
        case 'previousTab': {
          /*
            `state.tabs` is `displayOrder()`, which keeps a collapsed group's members in the array
            so the strip can still say how many are hidden (see `useBrowserState`'s doc comment).
            Cycling through it unfiltered lands on a tab the strip shows nothing for — the same
            state `setCollapsed` is supposed to prevent. `activateTabAtStripPosition` already
            filters with this exact function on the core side; this is that filter's other side.
          */
          const hidden = new Set(tabsHiddenByCollapse(state.groups))
          const visible = state.tabs.filter((tab) => !hidden.has(tab.id))
          if (visible.length === 0) return
          const index = visible.findIndex((tab) => tab.id === state.activeTabId)
          const delta = action === 'nextTab' ? 1 : -1
          const next = visible[(index + delta + visible.length) % visible.length]
          if (next) void invoke('tabs:activate', { tabId: next.id })
          break
        }
        /*
          No `settings` case any more, and its absence is deliberate.

          It existed to raise the panel, which the renderer owned. Opening a tab is something the core
          does better — it already does it for downloads, passwords and the extensions tab — so both
          menu items call `createTab` directly and nothing is routed here for it. The accelerator is
          unchanged and still declared on the menu item, which is the only place it can fire from.
        */
        case 'focusAddressBar':
          /*
            The shortcut every browser has, and it did nothing here until a fitness test noticed.
        
            Handled in the renderer because the address bar is a renderer element: the core can route the
            keystroke but cannot move a caret. A counter rather than a flag, so pressing it twice works twice.
          */
          setFocusRequest((previous) => previous + 1)
          break
        case 'findInPage':
          /*
            No payload, and nothing rendered here. The find bar lives on the overlay layer because a bar drawn
            in the chrome DOM would sit behind the page — so unlike `focusAddressBar` this renderer only
            forwards the request; the core decides which tile and puts the bar up.
          */
          void invoke('find:open')
          break
        case 'findNext':
          // Opens the bar with the remembered term if none is up, which is what F3 on its own means.
          void invoke('find:step', { forward: true })
          break
        case 'blockElement':
          /*
            No tab id: the core resolves it to the active tile's tab.

            The keyboard route to the picker, and the reason it exists at all: the context menu is the natural
            place for "block this element", and a feature reachable only by pointer does not satisfy spec 7.
          */
          void invoke('picker:start', {})
          break
        default:
          // Find bar and the rest arrive with their features.
          break
      }
    })
  }, [state.tabs, state.activeTabId, state.groups])

  /**
   * Escape walks one step back down the escalation ladder (spec 2).
   *
   * Handled here rather than as a menu accelerator because it must not fire
   * while the caret is in a text field — spec 9 requires shortcuts to leave
   * ordinary text editing alone.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      const target = event.target as HTMLElement | null
      const editing =
        target !== null &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      if (editing) return
      void invoke('split:escape')
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * A panel needs the whole window, so the content views are suspended while one is
   * open. Without this the panel would be drawn beneath the native views and receive
   * no pointer events — the same layering that forces the tile gutter.
   *
   * Only the extensions panel is left to need it. Settings is a tab now, and a tab is
   * content: it is drawn *by* one of those native views rather than over them, so it
   * suspends nothing and stays usable beside a page in a split tile.
   */
  useEffect(() => {
    const active = panel !== 'none'
    void invoke('window:setOverlay', { active })
    // Restoring on unmount matters: a window closed with a panel open would otherwise
    // leave the core believing its views should stay hidden.
    return () => {
      if (active) void invoke('window:setOverlay', { active: false })
    }
  }, [panel])

  const controls = state.window?.windowControlsInset ?? { left: 0, right: 0 }

  /**
   * The tooltip writer, built once and handed down.
   *
   * Built here rather than in each bar because this is where both of its inputs already are, and both
   * matter: the platform decides whether a key is written `⇧⌘T` or `Ctrl+Shift+T`, and the overrides
   * decide whether it is the key the user actually rebound. A tooltip naming the default while the
   * user has rebound it is worse than no tooltip.
   *
   * `platform` comes from the window state and is `null` until it arrives — for that first render the
   * buttons carry their labels and nothing else, which is the one honest answer to "which key?" before
   * we know which machine we are on.
   */
  const titleWithShortcut = shortcutTitles(
    state.window?.platform ?? null,
    state.settings?.['advanced.customShortcuts'] ?? {}
  )

  return (
    <div className={`app${privateMode ? ' app--private' : ''}`}>
      {/*
        Hidden in window fullscreen, and `visibility` rather than `display` for a specific reason.

        The tiles cover the whole window in fullscreen, so the chrome is behind them and invisible —
        except in the gutters between tiles, which no native view covers. A vertical gutter runs the
        full height of the window, so its top 88 pixels showed the tab strip: a sliver of browser
        interface down the middle of a fullscreen page.

        `display: none` would take the element out of layout, the `ResizeObserver` above would measure
        zero and report insets of zero to the core — which the core is already assuming in fullscreen,
        so nothing would break there — and then on the way *out* the chrome would be measured from
        scratch while the core had already laid the tiles out for a chrome that was still zero pixels
        tall. `visibility: hidden` keeps the box, so the measurement stays true the whole time and only
        the pixels go.
      */}
      <div
        className={`chrome${chromeHidden ? ' chrome--hidden' : ''}`}
        ref={chromeRef}
        aria-hidden={chromeHidden}
      >
        {/* Drag region for the frameless window; the OS controls sit outside it. */}
        <TabBar
          tabs={state.tabs}
          groups={state.groups}
          activeTabId={state.activeTabId}
          split={state.split}
          leftInset={controls.left}
          rightInset={controls.right}
          titleWithShortcut={titleWithShortcut}
        />
        <Toolbar
          tab={activeTab}
          split={state.split}
          settings={state.settings}
          privateMode={privateMode}
          titleWithShortcut={titleWithShortcut}
          layoutMenuOpen={overlay?.kind === 'layout-menu'}
          focusRequest={focusRequest}
          onOpenSettings={openSettingsTab}
          onOpenExtensions={() => setPanel('extensions')}
        />
      </div>

      {panel === 'extensions' && <ExtensionsPanel onClose={() => setPanel('none')} />}

      {state.split !== null && <SplitDividers split={state.split} contentTop={contentInsets.top} />}

      {/*
        The content area itself is drawn by native views on top of this element. A placeholder only
        shows through where no tile has a tab — one per empty tile, not one for the whole area,
        because `state.tabs.length === 0` is practically unreachable (`closeTab` guarantees at least
        one tab) while an *empty tile* in a 2x2 is the everyday case this exists for. Not
        `aria-hidden` any more: the text drawn here is the one legitimate thing this container ever
        holds, and hiding it from assistive tech left an empty tile silent.
      */}
      <div className="content" ref={contentRef} style={{ top: contentInsets.top }}>
        {state.split === null
          ? state.tabs.length === 0 && <p className="content__empty">{t('split.emptyTile')}</p>
          : state.split.tileTabIds.map((tabId, index) => {
              if (tabId !== null) return null
              const rect = tileRects[index]
              if (rect === undefined) return null
              return (
                <div
                  key={index}
                  className="content__tile"
                  data-tile-index={index}
                  style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
                >
                  <p className="content__empty">{t('split.emptyTile')}</p>
                </div>
              )
            })}
      </div>
    </div>
  )
}
