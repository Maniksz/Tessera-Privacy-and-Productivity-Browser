/**
 * The web contents a view still shows, or `null` once it shows none.
 *
 * ## Why a view's `webContents` cannot simply be read
 *
 * Electron's typings declare `WebContentsView.webContents` as a `WebContents`, always there. The getter
 * says otherwise. In Electron 43 (`shell/browser/api/electron_api_web_contents_view.cc`) it hands back the
 * contents through a weak pointer, and an empty handle — `undefined` in JavaScript — once that pointer
 * has gone. It goes when the page is destroyed, and it has already gone by the time `destroyed` is emitted:
 * the weak-pointer factory is the last member of `api::WebContents`, so it is torn down before the
 * Chromium contents whose destruction emits the event.
 *
 * So the old guard, `view.webContents.isDestroyed()`, never got to say "gone": by the time the page is
 * destroyed the view no longer hands it out, and the guard throws "Cannot read properties of undefined
 * (reading 'isDestroyed')" instead. A contents that *is* handed out destroyed — one a caller held on to, or
 * one a fake still returns — is the other way to have no page, and `isDestroyed()` answers for that one.
 *
 * The throw is what closing a tile from its bar did. The close contract finishes a tab from the page's
 * `destroyed` listener (`unload-guard.ts`), `Tab.destroy` asked the view for its contents once more, and the
 * exception came out of an Electron event as a main-process error dialogue. A discard (`tab-unloader.ts`)
 * leaves the tab holding a view in exactly that state until the tab is woken, so every relayout, broadcast
 * and sweep over it would have done the same.
 *
 * ## One question, asked here
 *
 * Every read of a view's contents that may come after the page went asks through this, so "is there a live
 * page" has one answer rather than a guard at each call site that is right for one of the two cases. The
 * view itself may be missing too — a tab that is not there, an overlay not yet built — because every caller
 * that has one of those has the same question behind it. `tests/architecture.test.ts` holds `src/main` to
 * it: `.webContents.isDestroyed()` on a view is refused everywhere but here.
 *
 * Where a caller needs the contents' id after the page has gone, it captures the id while the page was
 * there (`PermissionTabs`, `TabDiscards`) rather than reading it back: a gone page has no id to read.
 *
 * Structural and Electron-free, so the seams that use it stay testable against fakes.
 */

/** A web contents as far as this question needs one. Electron's `WebContents` satisfies it. */
export interface PossiblyDestroyed {
  isDestroyed(): boolean
}

/** A view as this reads it: its contents, which Electron may already have taken away. */
export interface ContentsHolder<C extends PossiblyDestroyed> {
  readonly webContents: C | null | undefined
}

/** The view's contents while there is a live page in it; `null` for no view, no contents, or a dead one. */
export function liveContentsOf<C extends PossiblyDestroyed>(
  view: ContentsHolder<C> | null | undefined
): C | null {
  const contents = view?.webContents
  if (contents === undefined || contents === null) return null
  return contents.isDestroyed() ? null : contents
}
