import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OverlayState } from '@shared/overlay/surface.js'
import { chromeHiddenAt, chromeInsetsFor } from '@shared/split/chrome-insets.js'
import { internalUrl } from '@shared/product.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'
import { focusTabOf, nextStripEntry, stripItems } from '@shared/strip/model.js'
import { invoke, subscribe } from './bridge.js'
import { useBrowserState } from './useBrowserState.js'
import { useTileRects } from './useTileRects.js'
import { useI18n } from './i18n.js'
import { TabBar } from './components/TabBar.js'
import { Toolbar } from './components/Toolbar.js'
import { isDownloadsPanel, useDownloadSummary } from './components/DownloadsButton.js'
import { useAutofillKeyState } from './components/AutofillKey.js'
import { mediaPortFor, useMediaFindingCount } from './components/MediaButton.js'
import { SplitDividers } from './components/SplitDividers.js'
import { ExtensionsPanel } from './components/ExtensionsPanel.js'
import { TileFailures } from './components/TabFailure.js'
import { TileHeaders } from './components/TileHeaders.js'

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

/**
 * The media panel, fetched when first opened (roadmap U16).
 *
 * It carries the media feature's sentences in both languages, and most windows never open it; the
 * button, which every window draws, needs only its count and one catalogue line.
 */
const MediaPanel = lazy(() =>
  import('./components/MediaPanel.js').then((module) => ({ default: module.MediaPanel }))
)

/**
 * The tab search (U22), fetched the first time its key is pressed, for the media panel's reason: the
 * ranker and the list are code every window would otherwise parse before its first paint.
 */
const TabSearchPanel = lazy(() =>
  import('./components/TabSearchPanel.js').then((module) => ({ default: module.TabSearchPanel }))
)

export function App(): React.ReactNode {
  const { t } = useI18n()
  const state = useBrowserState()
  const chromeRef = useRef<HTMLDivElement>(null)
  const [chromeHeight, setChromeHeight] = useState(88)
  const [panel, setPanel] = useState<'none' | 'extensions' | 'media' | 'tabSearch'>('none')
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
  /** What the toolbar's download button says; pulled once, then pushed on every change. */
  const downloads = useDownloadSummary()
  /** Where each tile's edges fall, and which tiles carry a header (U20), for everything drawn per tile. */
  const {
    ref: contentRef,
    rects: tileRects,
    headers: tileHeaders
  } = useTileRects(state.split, state.settings?.['splitView.showTileHeaders'] ?? false)

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  /** What the media button counts: the active tab's finds, following the tab (media plan R3). */
  const mediaFinds = useMediaFindingCount(activeTab?.id)
  const privateMode = state.window?.privateMode ?? false
  /** The password key, asked again whenever the tile, its page, the layer or the setting moves. */
  const autofillKey = useAutofillKeyState(
    [
      activeTab?.id,
      activeTab?.url,
      overlay?.kind,
      String(state.settings?.['passwords.autofill'])
    ].join(' ')
  )
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
            Over the strip's entries, not over `state.tabs` (U7, R13).

            `state.tabs` is `displayOrder()`, which keeps a collapsed group's members in the array
            so the chip can say how many are hidden, and which holds every member of a tiled view
            although the strip draws the view as one entry. Cycling through it would land on a tab
            the strip shows nothing for. `nextStripEntry` reads the same entries the strip draws
            and `activateTabAtStripPosition` counts on the core side, so a tiled view is one step
            and a folded group's members are none.
          */
          const items = stripItems(
            state.tabs.map((tab) => tab.id),
            state.groups,
            state.arrangements
          )
          const entry = nextStripEntry(items, state.activeTabId, action === 'nextTab' ? 1 : -1)
          if (entry) void invoke('tabs:activate', { tabId: focusTabOf(entry) })
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
        case 'searchTabs':
          // A panel over the window rather than the overlay layer, which stays the address bar's (KTD16).
          setPanel('tabSearch')
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
  }, [state.tabs, state.activeTabId, state.groups, state.arrangements])

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
   * The extensions, media and tab-search panels need it. Settings is a tab now, and a tab is
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
          arrangements={state.arrangements}
          activeTabId={state.activeTabId}
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
          downloads={downloads}
          downloadsPanelOpen={isDownloadsPanel(overlay)}
          autofillKey={autofillKey}
          media={mediaFinds}
          mediaPanelOpen={panel === 'media'}
          onOpenMedia={() => setPanel('media')}
          focusRequest={focusRequest}
          onOpenSettings={openSettingsTab}
          onOpenExtensions={() => setPanel('extensions')}
        />
      </div>

      {panel === 'extensions' && <ExtensionsPanel onClose={() => setPanel('none')} />}
      {/* The active tab's finds, and the next tab's once a shortcut switches under the panel. */}
      {panel === 'media' && (
        <Suspense fallback={null}>
          <MediaPanel
            port={mediaPortFor(activeTab?.id)}
            {...(activeTab === undefined ? {} : { tabId: activeTab.id })}
            onClose={() => setPanel('none')}
          />
        </Suspense>
      )}

      {/* This window's tabs, folded groups' members included: `state.tabs` is `displayOrder()`. */}
      {panel === 'tabSearch' && (
        <Suspense fallback={null}>
          <TabSearchPanel tabs={state.tabs} onClose={() => setPanel('none')} />
        </Suspense>
      )}

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
        {/* A failed page or a gone renderer, drawn where the core hid its view (U9, KTD4). */}
        {state.split !== null && (
          <TileFailures
            split={state.split}
            tabs={state.tabs}
            rects={tileRects}
            headers={tileHeaders}
            exemptSites={state.settings?.['privacy.blockerOffForSites'] ?? []}
          />
        )}
        {/* Favicon and title in the strip above each view, which the core left free for it (U20). */}
        {state.split !== null && (
          <TileHeaders
            split={state.split}
            tabs={state.tabs}
            rects={tileRects}
            headers={tileHeaders}
          />
        )}
      </div>
    </div>
  )
}
