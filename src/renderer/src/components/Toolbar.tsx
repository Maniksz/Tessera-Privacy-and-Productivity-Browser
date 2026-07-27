import type { SplitState, TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { ShortcutTitle } from '@shared/shortcuts/format.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import { LayoutMenu } from './LayoutMenu.js'
import { Omnibox } from './Omnibox.js'

/**
 * The toolbar.
 *
 * Left: navigation and Home — the things you reach for constantly, grouped where the
 * pointer already is after using the tab strip. Right: the layout menu and the two
 * panels, which are occasional. Five separate layout buttons used to sit on the right
 * and cost five slots to express one choice; `LayoutMenu` is one button that also shows
 * which arrangement is active.
 */

interface ToolbarProps {
  tab: TabState | undefined
  split: SplitState | null
  settings: SettingsSnapshot | null
  privateMode: boolean
  /** Whether the layout menu is currently up on the overlay layer. */
  layoutMenuOpen: boolean
  onOpenSettings: () => void
  onOpenExtensions: () => void
  /** Bumped when the user asks for the address bar; passed straight to `Omnibox`. */
  focusRequest: number
  /** Joins a label to the key that also presses the button; see `shortcutTitles`. */
  titleWithShortcut: ShortcutTitle
}

export function Toolbar({
  tab,
  split,
  settings,
  privateMode,
  layoutMenuOpen,
  onOpenSettings,
  onOpenExtensions
,
  focusRequest,
  titleWithShortcut
}: ToolbarProps): React.ReactNode {
  const { t } = useI18n()
  const loading = tab?.loading ?? false
  const tileCount = split?.tileTabIds.length ?? 1
  const maximized = split?.maximizedTile !== null
  // Named once because it is the accessible name *and* the first line of the tooltip, and the two
  // drifting apart would mean a screen reader and a tooltip describing different buttons.
  const maximizeLabel = t(maximized ? 'split.restore' : 'split.maximize')

  return (
    <div className="toolbar">
      <div className="toolbar__nav">
        <button
          type="button"
          className="iconbutton"
          aria-label={t('toolbar.back')}
          title={titleWithShortcut(t('toolbar.back'), 'back')}
          disabled={!(tab?.canGoBack ?? false)}
          onClick={() => void invoke('nav:goBack', {})}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M12.5 4 6.5 10l6 6" />
          </svg>
        </button>

        <button
          type="button"
          className="iconbutton"
          aria-label={t('toolbar.forward')}
          title={titleWithShortcut(t('toolbar.forward'), 'forward')}
          disabled={!(tab?.canGoForward ?? false)}
          onClick={() => void invoke('nav:goForward', {})}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7.5 4l6 6-6 6" />
          </svg>
        </button>

        <button
          type="button"
          className="iconbutton"
          aria-label={t(loading ? 'toolbar.stop' : 'toolbar.reload')}
          /*
            A key while it means Reload, none while it means Stop.

            `stop` is bound to Escape in the tables, and nothing registers it: it is deliberately kept
            out of the menu so it cannot swallow Escape in a form, and the renderer's own Escape
            handler walks the fullscreen ladder — it never cancels a load. Printing `Esc` here would
            promise something the browser does not do.
          */
          title={loading ? t('toolbar.stop') : titleWithShortcut(t('toolbar.reload'), 'reload')}
          onClick={() => {
            if (loading) void invoke('nav:stop', {})
            else void invoke('nav:reload', {})
          }}
        >
          {loading ? (
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />
            </svg>
          ) : (
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <path d="M16 10a6 6 0 1 1-2.2-4.65" />
              <path d="M16 4.2V6.4h-2.2" />
            </svg>
          )}
        </button>

        <button
          type="button"
          className="iconbutton"
          aria-label={t('toolbar.home')}
          title={titleWithShortcut(t('toolbar.home'), 'home')}
          onClick={() => void invoke('nav:navigate', { input: HOME_URL })}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M3.5 9.2 10 4l6.5 5.2" />
            <path d="M5.4 8.6V16h9.2V8.6" />
          </svg>
        </button>
      </div>

      <Omnibox tab={tab} settings={settings} privateMode={privateMode} focusRequest={focusRequest} />

      <div className="toolbar__actions">
        <LayoutMenu current={split?.layout ?? '1x1'} open={layoutMenuOpen} />

        {/* Only meaningful once more than one tile exists. */}
        {tileCount > 1 && (
          <button
            type="button"
            className="iconbutton"
            aria-pressed={maximized}
            aria-label={maximizeLabel}
            title={titleWithShortcut(maximizeLabel, 'toggleTileMaximized')}
            onClick={() => void invoke('split:toggleTileMaximized', {})}
          >
            <svg viewBox="0 0 20 20" aria-hidden="true">
              {maximized ? <path d="M4 8h5V3M16 12h-5v5" /> : <path d="M4 4h12v12H4z" />}
            </svg>
          </button>
        )}

        {/* No key: `SHORTCUT_ACTIONS` has no extensions action, and a tooltip must not invent one. */}
        <button
          type="button"
          className="iconbutton"
          aria-label={t('toolbar.extensions')}
          title={t('toolbar.extensions')}
          onClick={onOpenExtensions}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M7 4h6v3.2a2 2 0 1 0 3.3 1.5V15H4V8.7A2 2 0 1 0 7 7.2z" />
          </svg>
        </button>

        <button
          type="button"
          className="iconbutton"
          aria-label={t('toolbar.settings')}
          title={titleWithShortcut(t('toolbar.settings'), 'settings')}
          onClick={onOpenSettings}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="2.6" />
            <path d="M10 3v2M10 15v2M3 10h2M15 10h2M5.1 5.1l1.4 1.4M13.5 13.5l1.4 1.4M14.9 5.1l-1.4 1.4M6.5 13.5l-1.4 1.4" />
          </svg>
        </button>
      </div>
    </div>
  )
}
