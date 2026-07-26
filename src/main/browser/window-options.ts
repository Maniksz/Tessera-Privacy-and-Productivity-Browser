import type { BrowserWindowConstructorOptions } from 'electron'
import type { Platform } from '@shared/model.js'

/**
 * How a browser window is built.
 *
 * Lifted out of `BrowserWindowController`'s constructor, where it was thirty-five lines that nothing
 * could check. Every decision in here is a requirement someone could undo without any test noticing:
 * that a private window is a different colour, that the chrome UI is never throttled, that the window
 * controls stay in their platform's corner, that the renderer is sandboxed with no Node.
 *
 * Pure, and free of Electron at runtime — the import is type-only and the preload path arrives as a
 * parameter rather than from `paths.ts`, which needs `app`. So the invariants above are ordinary unit
 * tests instead of things to read carefully and hope about.
 */

export interface ChromeWindowOptions {
  privateMode: boolean
  platform: Platform
  /** Absolute path to the built preload bundle; `preloadFile()`. */
  preload: string
  /** `preloadRoleArgument('chrome')` — what tells the preload to expose the full bridge. */
  roleArgument: string
}

/** Private windows get their own colour so the two are never confused (spec 4). */
const PRIVATE_BACKGROUND = '#2a1636'
const NORMAL_BACKGROUND = '#17171a'

export function chromeWindowOptions(
  options: ChromeWindowOptions
): BrowserWindowConstructorOptions {
  const isMac = options.platform === 'darwin'
  const background = options.privateMode ? PRIVATE_BACKGROUND : NORMAL_BACKGROUND

  return {
    width: 1440,
    height: 900,
    minWidth: 720,
    minHeight: 480,
    // Shown once the chrome UI has painted, so the first frame is never an empty white rectangle.
    show: false,
    backgroundColor: background,
    /*
      Window controls stay in each platform's usual corner (spec 10).

      `hidden` rather than `hiddenInset` or a frameless window: the controls remain real OS controls,
      and the chrome UI reserves space for them through `windowControlsInset` instead of drawing its
      own. A browser that redraws the close button gets it subtly wrong on every platform at once.
    */
    titleBarStyle: 'hidden',
    // macOS has no overlay to colour, and the other two have no traffic-light position to set. The
    // conditional spreads are `exactOptionalPropertyTypes` — an absent key and one holding
    // `undefined` are different types here.
    ...(isMac ? { trafficLightPosition: { x: 14, y: 15 } } : {}),
    ...(isMac
      ? {}
      : {
          titleBarOverlay: {
            color: background,
            symbolColor: '#d8d8dd',
            height: 40
          }
        }),
    webPreferences: {
      preload: options.preload,
      // Marks this renderer as the trusted chrome UI, so the preload exposes the full bridge. The
      // main process verifies sender identity independently — see `sender-policy.ts`.
      additionalArguments: [options.roleArgument],
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The chrome UI is our own code and always visible; throttling it while the user works in a
      // tab would make the toolbar feel dead.
      backgroundThrottling: false
    }
  }
}
