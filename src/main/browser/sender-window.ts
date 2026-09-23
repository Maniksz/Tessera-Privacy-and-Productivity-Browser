/**
 * Which window an IPC call acts for.
 *
 * Pure and Electron-free so it can be tested directly. `WindowRegistry` is Electron-bound and
 * excluded from coverage, and this decision is the one in it that was wrong without anybody seeing.
 *
 * ## The hole this closes
 *
 * The registry used to find a tab's window through `sender.hostWebContents`. That property belongs to
 * `<webview>` and is never set for a `WebContentsView`, which is what every tab here is — so no tab
 * sender ever matched, and `resolve` fell back to the *focused* window every time. An internal page
 * therefore acted for whichever window the user had last clicked: the settings page of a private
 * window, with a normal window in front, wrote its filter rule into the normal profile.
 *
 * ## No fallback
 *
 * A sender that no live window owns gets no window. Guessing one is how the bug above happened, and
 * the router already guarantees that every sender reaching a handler is either a window's chrome or
 * an internal page in some tab — so "not found" means the sender or its window is gone, and the only
 * honest answer is to refuse.
 *
 * ## Structural rather than concrete
 *
 * `BrowserWindowController` satisfies `SenderWindowCandidate` as it stands, and Electron's
 * `WebContents` satisfies `SenderContents`, so the registry hands its controllers over unchanged and
 * this file never has to import either.
 */

/** A web contents as far as this decision needs one. Electron's `WebContents` satisfies it. */
export interface SenderContents {
  /** Read only after `isDestroyed()` said no: Electron throws on a destroyed object's properties. */
  readonly id: number
  isDestroyed(): boolean
}

/** A window as far as this decision needs one. `BrowserWindowController` satisfies it. */
export interface SenderWindowCandidate {
  readonly window: { isDestroyed(): boolean }
  /** True for the window's chrome renderer and its overlay surface — its own trusted UI. */
  ownsChromeWebContents(webContentsId: number): boolean
  readonly tabs: Iterable<{ readonly view: { readonly webContents: SenderContents } }>
}

/**
 * The window whose tab shows the given web contents, or `undefined`.
 *
 * Only tabs count; a chrome renderer's id finds nothing here. The element picker and the password
 * manager act on a *page*, and a window matched through its chrome would hand them one that is not.
 *
 * Destroyed windows and destroyed tabs are stepped over before their ids are read, because reading
 * them is what throws.
 */
export function windowOfTab<C extends SenderWindowCandidate>(
  windows: Iterable<C>,
  webContentsId: number
): C | undefined {
  for (const candidate of windows) {
    if (candidate.window.isDestroyed()) continue
    for (const tab of candidate.tabs) {
      const contents = tab.view.webContents
      if (contents.isDestroyed()) continue
      if (contents.id === webContentsId) return candidate
    }
  }
  return undefined
}

/**
 * The window an IPC sender belongs to, or `undefined` — never the focused one instead.
 *
 * The chrome and overlay renderers are matched first, as the registry always did, and then the tabs.
 * The order only matters in theory, since Electron does not hand one id to two live contents, but it
 * is kept so the chrome's answer does not depend on how many tabs are open.
 */
export function windowOfSender<C extends SenderWindowCandidate>(
  windows: Iterable<C>,
  sender: SenderContents
): C | undefined {
  // A destroyed sender cannot receive the reply, and its id is not safe to read.
  if (sender.isDestroyed()) return undefined
  const senderId = sender.id
  // Materialised once: the caller may hand over a live iterator, and it is walked twice below.
  const candidates = [...windows]
  for (const candidate of candidates) {
    if (candidate.window.isDestroyed()) continue
    if (candidate.ownsChromeWebContents(senderId)) return candidate
  }
  return windowOfTab(candidates, senderId)
}
