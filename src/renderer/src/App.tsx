import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { OverlayState } from '@shared/overlay/surface.js'
import { invoke, subscribe } from './bridge.js'
import { useBrowserState } from './useBrowserState.js'
import { useI18n } from './i18n.js'
import { TabBar } from './components/TabBar.js'
import { Toolbar } from './components/Toolbar.js'
import { SplitDividers } from './components/SplitDividers.js'
import { SettingsPanel } from './components/SettingsPanel.js'
import { ExtensionsPanel } from './components/ExtensionsPanel.js'

export function App(): React.ReactNode {
  const { t } = useI18n()
  const state = useBrowserState()
  const chromeRef = useRef<HTMLDivElement>(null)
  const [chromeHeight, setChromeHeight] = useState(88)
  const [panel, setPanel] = useState<'none' | 'settings' | 'extensions'>('none')
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

  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  const privateMode = state.window?.privateMode ?? false

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

  /** Commands the core routes to the UI because they depend on focus. */
  useEffect(() => {
    return subscribe('shortcut:triggered', ({ action }) => {
      switch (action) {
        case 'nextTab':
        case 'previousTab': {
          if (state.tabs.length === 0) return
          const index = state.tabs.findIndex((tab) => tab.id === state.activeTabId)
          const delta = action === 'nextTab' ? 1 : -1
          const next = state.tabs[(index + delta + state.tabs.length) % state.tabs.length]
          if (next) void invoke('tabs:activate', { tabId: next.id })
          break
        }
        case 'settings':
          setPanel('settings')
          break
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
  }, [state.tabs, state.activeTabId])

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

  return (
    <div className={`app${privateMode ? ' app--private' : ''}`}>
      <div className="chrome" ref={chromeRef}>
        {/* Drag region for the frameless window; the OS controls sit outside it. */}
        <TabBar
          tabs={state.tabs}
          groups={state.groups}
          activeTabId={state.activeTabId}
          split={state.split}
          leftInset={controls.left}
          rightInset={controls.right}
        />
        <Toolbar
          tab={activeTab}
          split={state.split}
          settings={state.settings}
          privateMode={privateMode}
          layoutMenuOpen={overlay?.kind === 'layout-menu'}
          focusRequest={focusRequest}
          onOpenSettings={() => setPanel('settings')}
          onOpenExtensions={() => setPanel('extensions')}
        />
      </div>

      {panel === 'settings' && (
        <SettingsPanel settings={state.settings} onClose={() => setPanel('none')} />
      )}
      {panel === 'extensions' && <ExtensionsPanel onClose={() => setPanel('none')} />}

      {state.split !== null && <SplitDividers split={state.split} contentTop={chromeHeight} />}

      {/*
        The content area itself is drawn by native views on top of this element.
        The placeholder only shows through where no tile has a tab, which is the
        one case the user needs a prompt for.
      */}
      <div className="content" style={{ top: chromeHeight }} aria-hidden="true">
        {state.tabs.length === 0 && <p className="content__empty">{t('split.emptyTile')}</p>}
      </div>
    </div>
  )
}
