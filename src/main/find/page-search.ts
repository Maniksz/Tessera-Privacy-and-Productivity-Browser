import type { FindSearchAction, FindStopAction } from '@shared/find/session.js'
import type { Rect } from '@shared/ui/anchor.js'

/**
 * The Electron surface find in page needs, as the narrowest shapes a real `WebContents` satisfies.
 *
 * ## Why structural types rather than `import type { WebContents }`
 *
 * Two reasons, and the second is the one that matters. Declaring what is used keeps the controller
 * testable with a fake page — a find session is a sequence of stateful calls and asynchronous
 * answers, which is exactly the sort of thing that has to be exercised by a test rather than by
 * clicking. And it makes the seam explicit: everything Electron-shaped about this feature is on this
 * page, so there is one place to look when a version changes what `findInPage` means.
 *
 * The events are addressed by name through the untyped `EventEmitter` form for the same reason
 * `Tab.#wireEvents` does it: Electron's per-event overloads cannot be addressed generically, and the
 * payloads are narrowed by `shared/find/wire.ts` where that narrowing can be tested.
 */

/** Exactly Electron's `FindInPageOptions`, restated so the controller depends on no Electron type. */
export interface FindInPageOptions {
  forward?: boolean
  findNext?: boolean
  matchCase?: boolean
}

export interface SearchablePage {
  isDestroyed(): boolean
  findInPage(text: string, options?: FindInPageOptions): number
  stopFindInPage(action: FindStopAction): void
  on(event: string, listener: (...args: unknown[]) => void): unknown
  removeListener(event: string, listener: (...args: unknown[]) => void): unknown
}

/**
 * A tab, as find in page needs it. Structurally satisfied by `Tab`.
 *
 * `tileIndex` and the view's bounds are both here because the bar is anchored to the tile the tab
 * fills, and the view's own rectangle *is* that tile — read from the thing the window positioned
 * rather than recomputed from a layout, so the bar cannot end up in a tile the page is not in.
 */
export interface FindTarget {
  readonly id: string
  /** The tile it occupies, or `null` for a tab that is loaded but off screen. */
  readonly tileIndex: number | null
  readonly view: FindTargetView
}

export interface FindTargetView {
  /** The tile's rectangle in window coordinates, which is the space the bar's bounds are in. */
  getBounds(): Rect
  readonly webContents: SearchablePage
}

/**
 * Electron's options for one action of the find state machine.
 *
 * ## The trap, in one option
 *
 * `findNext` does **not** mean "find the next match". It is Chromium's `new_session` flag under a
 * name that reads like its opposite: Electron's own typings for the pinned version say "Whether to
 * begin a new text finding session with this request. Should be `true` for initial requests, and
 * `false` for follow-up requests." So a *restart* passes `true` and an *advance* passes `false` —
 * the reverse of what the name suggests, and the reverse of what a great deal of sample code on the
 * subject does.
 *
 * Getting it backwards fails silently and plausibly: every press of "next" would begin a fresh
 * session, so the highlight would return to the first match on the page each time and the bar would
 * look like it simply refused to advance. Nothing would throw, and the count would be correct.
 *
 * Hence one function, one test that pins both directions, and the default never relied upon — the
 * option is always passed explicitly, because the documented default has been the opposite of the
 * implementation's before.
 */
export function findInPageOptions(action: FindSearchAction): FindInPageOptions {
  return { forward: action.forward, findNext: action.do === 'restart' }
}
