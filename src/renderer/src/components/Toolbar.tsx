import type { SplitState, TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { ShortcutTitle } from '@shared/shortcuts/format.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import { effectiveZoomPercent } from '@shared/zoom/model.js'
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

  /*
    This pane's zoom, shown only while it is not the ordinary size.

    Two things had to be true before a Reset Zoom button was worth adding, and only one of them was.
    The command existed — the View menu and `Ctrl+0` — but nothing on screen ever said a pane *was*
    zoomed, so the way back was a shortcut you had to already know. Reported as "es gibt keinen zoom
    reset button", and the badge is the more important half of the answer: it is the only thing that
    makes an accidental pinch on a trackpad recoverable by looking rather than by remembering.

    Measured against `appearance.defaultZoom` rather than against 100, because that setting is what
    "ordinary" means on this profile — a person who set it to 125 does not want a badge on every pane.
    Both sides go through `effectiveZoomPercent` so the comparison happens after the same clamp; a
    setting outside the range would otherwise never equal the value the pane is actually showing, and
    the badge would be permanent.

    Hidden rather than disabled when there is nothing to reset. A disabled control is a promise that it
    will do something under other circumstances, and this one would be lying: at the default zoom the
    reset is a no-op.
  */
  const defaultZoom = settings?.['appearance.defaultZoom'] ?? null
  const paneZoom =
    tab === undefined || defaultZoom === null
      ? null
      : effectiveZoomPercent(tab.zoomPercent, defaultZoom)
  const zoomBadge =
    paneZoom === null ||
    defaultZoom === null ||
    paneZoom === effectiveZoomPercent(null, defaultZoom)
      ? null
      : t('toolbar.zoomLevel', { percent: paneZoom })

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
        {/*
          Text rather than an icon, because the number *is* the information: a magnifying glass would
          say "zoom" to somebody who can already see the page is the wrong size, and say nothing about
          how far off it is or which way.
        */}
        {zoomBadge !== null && (
          <button
            type="button"
            className="iconbutton iconbutton--zoom"
            // The level in the accessible name as well as on the face: a screen reader user gets
            // "Reset zoom: 150%" rather than a button whose only clue is a number they cannot see.
            aria-label={`${t('toolbar.zoomReset')}: ${zoomBadge}`}
            title={titleWithShortcut(t('toolbar.zoomReset'), 'zoomReset')}
            onClick={() => void invoke('zoom:reset', {})}
          >
            {zoomBadge}
          </button>
        )}

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
          {/*
            A cog, and the previous drawing has to be named because it is the kind of mistake that
            looks like a choice. It was a circle with eight straight rays leaving it — which is the
            icon for brightness, not for settings. Reported as "das settings icon ist eine sonne?",
            and the question mark is the whole problem: a reader could not tell whether the browser
            meant a theme switch.

            The teeth are therefore a closed outline rather than radial strokes. That is the only
            shape that cannot be read as a sun: a ray touches the circle at one point and a tooth
            has flanks, and at 20px the flanks are what the eye uses. Six teeth rather than eight —
            with a 1.6 stroke on a 20px grid, eight leaves under two pixels of gap between them and
            they merge back into a blur.

            Geometry, so the next person can move it without re-deriving it: tips on r=8, roots on
            r=5.75, teeth 26° wide on a 60° period, centred on (10,10).
          */}
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="M8.2 2.21L11.8 2.21L11.87 4.56L13.77 5.66L15.85 4.54L17.65 7.66L15.64 8.9L15.64 11.1L17.65 12.34L15.85 15.46L13.77 14.34L11.87 15.44L11.8 17.79L8.2 17.79L8.13 15.44L6.23 14.34L4.15 15.46L2.35 12.34L4.36 11.1L4.36 8.9L2.35 7.66L4.15 4.54L6.23 5.66L8.13 4.56Z" />
            <circle cx="10" cy="10" r="2.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
