import { WebContentsView, type Session } from 'electron'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { effectiveZoomPercent, type PaneZoom } from '@shared/zoom/model.js'
import { applyWebRtcPolicy } from '../session/hardening.js'
import { preloadFile, preloadRoleArgument } from '../paths.js'

/**
 * A tab's view, built the one way there is: at the tab's construction, and again for a discarded tab coming
 * back (U15, KTD9). Out of `Tab.ts` so both build it from the same options, and so that file does not grow.
 *
 * Only the view; its wiring is `Tab`'s, which owns the state every listener writes into.
 */
export function createTabView(options: {
  session: Session
  settings: SettingsSnapshot
  zoomPercent: PaneZoom
}): WebContentsView {
  const { settings } = options
  const view = new WebContentsView({
    webPreferences: {
      session: options.session,
      /*
        The content bundle, which is the one that has no chrome bridge in it at all.

        A visited page gets no bridge (spec 6); a `tessera://` page gets a narrow allowlist, decided
        from its own address. Both live in this one file because both are shown in *this* view — a
        tab starts on the start page and goes wherever the user types, and a preload is fixed when
        the view is created.

        The role argument is the cross-check rather than the switch: it lets the bundle notice it was
        handed to a view the core created for the chrome UI. See `preloadFile` in `paths.ts`.
      */
      preload: preloadFile('content'),
      additionalArguments: [preloadRoleArgument('content')],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      /**
       * The single most important option for split view.
       *
       * Chromium throttles timers and rendering in content it considers
       * backgrounded. In a 2x2 grid, three of four tiles look backgrounded to
       * Chromium, and their videos would stutter or stall — the exact failure
       * spec 2 rules out. This turns it off per view; the command-line
       * switches in `runtime-flags.ts` cover the process-level equivalent.
       */
      backgroundThrottling: settings['splitView.throttleInactiveTiles'],
      /**
       * The zoom, ahead of the first paint — the only apply point there is before a document has
       * committed, because `setZoomFactor` acts on the origin a view is on and a view that has
       * loaded nothing has none. Without it, a session restored at 200 % and every pane on a
       * profile whose `appearance.defaultZoom` is not 100 would paint wrong and snap, on every
       * launch. A default only: Chromium's per-origin level wins once one exists, which is why
       * `did-navigate` re-asserts.
       */
      zoomFactor:
        effectiveZoomPercent(options.zoomPercent, settings['appearance.defaultZoom']) / 100,
      spellcheck: settings['advanced.spellcheck'],
      autoplayPolicy:
        settings['splitView.autoplayInTiles'] === 'allow'
          ? 'no-user-gesture-required'
          : 'user-gesture-required'
    }
  })
  applyWebRtcPolicy(view.webContents, settings)
  return view
}
