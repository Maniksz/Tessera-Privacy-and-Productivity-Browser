import type { BaseWindow, Dialog, MessageBoxOptions } from 'electron'
import { NOW_CHOOSABLE, type DataCategory, type InventoryPath } from '@shared/data/inventory.js'
import type { Locale } from '@shared/i18n/catalog.js'
import { bookmarkUrlOf } from '@shared/bookmarks/model.js'
import {
  clearNow,
  noteFileAt,
  type ClearableCache,
  type ClearableList,
  type ClearingSession,
  type OpenStores
} from '../data/clear-data.js'
import { ReadOnlyStoreError } from '../data/JsonStore.js'
import { Panic, type AbandonableStore } from '../data/panic.js'
import type { BookmarkStore } from '../data/BookmarkStore.js'
import { httpsExemptionsFor } from '../privacy/https-exemptions.js'
import { menuLabel, type MenuTextKey } from './menu-text.js'

/**
 * The three menu actions that run in the core, not in the chrome (KTD6): Strg+D, "Clear Browsing
 * Data…" and "Delete Everything and Quit".
 *
 * ## Why here and not in `App.tsx`
 *
 * They used to be emitted as `shortcut:triggered` to the focused window's chrome, whose switch had no
 * case for any of them, so all three did nothing. None of them needs the chrome's focus or caret, and
 * each has to work when no window of ours is focused (R16) — the macOS menu bar with another application
 * in front, where "the focused window" is nobody. So they take the window focused *last*, from
 * `WindowRegistry.byRecentFocus`, and ask in a native dialog. `tests/architecture.test.ts` holds every
 * action the menu still sends to a receiver in `App.tsx` or in this class.
 *
 * ## What is not here
 *
 * Electron. The windows, the stores, the dialog and the panic are handed in, and `installMenuActions`
 * at the bottom is the wiring `index.ts` calls — with Electron's objects passed to it, not imported.
 * Every handler settles and none rejects: a menu click's promise is held by nobody, and a rejection
 * nobody holds ends the process.
 */

/** A window, as far as the actions need one. `BrowserWindowController` satisfies it. */
export interface ActionWindow {
  readonly privateMode: boolean
  /** The tab in the active tile; its `url` is the real address even when the page failed (U9). */
  activeTab(): { toState(): { readonly url: string; readonly title: string } } | undefined
  /** Drops the stack "Reopen Closed Tab" walks, which is history kept in memory (KTD7). */
  forgetClosedTabs(): void
}

/** What the application menu calls; `MenuActions` of any window type. */
export type CoreMenuActions = Pick<
  MenuActions<ActionWindow, ClearingSession>,
  'addBookmark' | 'clearData' | 'panic'
>

/** A native message box, in the shape `dialog.showMessageBox` takes. */
export interface MessageBox {
  readonly type: 'warning' | 'question'
  readonly message: string
  readonly detail: string
  readonly buttons: string[]
  readonly defaultId: number
  readonly cancelId: number
  readonly noLink: true
}

export interface MenuActionDeps<W extends ActionWindow, S> {
  readonly windows: {
    /** Most recently focused first; see `window-recency.ts`. */
    readonly byRecentFocus: readonly W[]
    sessionOf(window: W): S | undefined
  }
  /** The normal profile's session, for a clearing asked with no window open. */
  readonly defaultSession: S
  readonly bookmarks: Pick<BookmarkStore, 'isBookmarked' | 'create'>
  readonly stores: OpenStores
  /** Drops what a session keeps only in memory: its HTTPS exceptions and its media finds. */
  readonly forgetSession: (session: S) => void
  /** Shows a box on `window` (or on none) and answers the index of the button pressed. */
  readonly ask: (window: W | undefined, box: MessageBox) => Promise<number>
  readonly locale: () => Locale
  readonly panic: { run(): Promise<unknown>; whenIdle(): Promise<void> }
}

/**
 * The choices "Clear Browsing Data…" offers, as buttons.
 *
 * Presets rather than a checkbox per category, and that is a deviation from the plan's "native dialog
 * with category checkboxes": Electron's native message box has room for one checkbox, not five, and a
 * dialog drawn by a renderer would no longer be native. The three are the useful cuts of the inventory's
 * five choosable categories — everything; everything but what the user has visited; only the cache —
 * and the dialog lists what "everything" contains. Both cookie presets take site storage and the cache
 * as well, so their clearing is Chromium's unfiltered one, network traces included (`clearChromium`).
 */
export const CLEAR_NOW_PRESETS: ReadonlyArray<{
  readonly label: MenuTextKey
  readonly categories: readonly DataCategory[]
}> = [
  { label: 'clearData.everything', categories: NOW_CHOOSABLE },
  {
    label: 'clearData.keepHistory',
    categories: NOW_CHOOSABLE.filter((category) => !['history', 'downloads'].includes(category))
  },
  { label: 'clearData.cacheOnly', categories: ['cache'] }
]

export class MenuActions<W extends ActionWindow, S extends ClearingSession> {
  readonly #deps: MenuActionDeps<W, S>

  constructor(deps: MenuActionDeps<W, S>) {
    this.#deps = deps
  }

  /**
   * Strg+D (R13): the active page of the window focused last, into "Other bookmarks".
   *
   * A page saved already is left as it is, so pressing it twice does not make two. A file this run
   * may not write — one a newer version wrote — gets a native notice rather than a silent nothing.
   */
  async addBookmark(): Promise<void> {
    const window = this.#lastWindow()
    const state = window?.activeTab()?.toState()
    if (state === undefined || bookmarkUrlOf(state.url) === null) return
    const { bookmarks } = this.#deps
    if (bookmarks.isBookmarked(state.url)) return
    try {
      bookmarks.create({ kind: 'bookmark', title: state.title, url: state.url })
    } catch (error) {
      if (!(error instanceof ReadOnlyStoreError)) {
        console.warn('[bookmarks] Strg+D could not bookmark the page:', error)
        return
      }
      await this.#settle('bookmark notice', () =>
        this.#ask(window, {
          type: 'warning',
          message: 'bookmarks.readOnly.message',
          detail: 'bookmarks.readOnly.detail',
          buttons: ['bookmarks.readOnly.ok'],
          cancel: 0
        })
      )
    }
  }

  /**
   * "Clear Browsing Data…" (R14): asks, then clears at once in the session of the window focused
   * last — in a private window only its own partition, and never a store of the normal profile.
   */
  async clearData(): Promise<void> {
    const window = this.#lastWindow()
    await this.#settle('clearing browsing data', async () => {
      const presets = CLEAR_NOW_PRESETS.map((preset) => preset.label)
      const pressed = await this.#ask(window, {
        type: 'question',
        message: 'clearData.message',
        detail: window?.privateMode === true ? 'clearData.detailPrivate' : 'clearData.detail',
        buttons: [...presets, 'clearData.cancel'],
        cancel: presets.length
      })
      const preset = CLEAR_NOW_PRESETS[pressed]
      if (preset === undefined) return
      await this.#clear(window, preset.categories)
    })
  }

  /** "Delete Everything and Quit" (R15): one confirmation, then `Panic` does the rest. */
  async panic(): Promise<void> {
    await this.#settle('panic', async () => {
      const pressed = await this.#ask(this.#lastWindow(), {
        type: 'warning',
        message: 'panic.message',
        detail: 'panic.detail',
        buttons: ['panic.confirm', 'panic.cancel'],
        cancel: 1
      })
      if (pressed === 0) await this.#deps.panic.run()
    })
  }

  /** Settles when a running panic has; the shutdown waits on it among its flushes. */
  whenIdle(): Promise<void> {
    return this.#deps.panic.whenIdle()
  }

  #lastWindow(): W | undefined {
    return this.#deps.windows.byRecentFocus[0]
  }

  async #clear(window: W | undefined, categories: readonly DataCategory[]): Promise<void> {
    const { windows, defaultSession, stores, forgetSession } = this.#deps
    const session = (window === undefined ? undefined : windows.sessionOf(window)) ?? defaultSession
    const privateMode = window?.privateMode === true
    await clearNow(categories, {
      session,
      stores: privateMode ? null : stores,
      forget: (due) => {
        // The closed tabs of every window of this session: history is the profile's, not a window's.
        if (due.includes('history')) {
          for (const other of windows.byRecentFocus) {
            if (other.privateMode === privateMode && windows.sessionOf(other) === session) {
              other.forgetClosedTabs()
            }
          }
        }
        if (due.includes('inMemory')) forgetSession(session)
      }
    })
  }

  /** A box in the interface language, `cancel` also being the default: Enter never deletes. */
  #ask(
    window: W | undefined,
    box: {
      type: MessageBox['type']
      message: MenuTextKey
      detail: MenuTextKey
      buttons: MenuTextKey[]
      cancel: number
    }
  ): Promise<number> {
    const locale = this.#deps.locale()
    return this.#deps.ask(window, {
      type: box.type,
      message: menuLabel(locale, box.message),
      detail: menuLabel(locale, box.detail),
      buttons: box.buttons.map((key) => menuLabel(locale, key)),
      defaultId: box.cancel,
      cancelId: box.cancel,
      noLink: true
    })
  }

  async #settle(name: string, work: () => Promise<unknown>): Promise<void> {
    try {
      await work()
    } catch (error) {
      console.error(`[menu] ${name} failed:`, error)
    }
  }
}

// --- wiring -------------------------------------------------------------------------------------

/** The stores clearing now empties, which panic stops as well, as `index.ts` opened them. */
export interface ClearedStores {
  readonly history: AbandonableStore & ClearableList
  readonly downloads: AbandonableStore & ClearableList
  readonly favicons: ClearableCache
  readonly thumbnails: ClearableCache
}

export interface MenuActionWiring<W extends ActionWindow & { readonly window: BaseWindow }, S> {
  readonly windows: MenuActionDeps<W, S>['windows'] & { closeAll(): void }
  /** Electron's own, handed in so this file imports only its types. */
  readonly electron: {
    readonly dialog: Pick<Dialog, 'showMessageBox'>
    readonly defaultSession: S
    readonly quit: () => void
  }
  readonly bookmarks: MenuActionDeps<W, S>['bookmarks']
  readonly stores: ClearedStores
  /** The other stores of a panic category: the session, tab groups, arrangements, permissions. */
  readonly stopped: readonly AbandonableStore[]
  readonly downloads: { cancelUnfinished(): readonly string[] }
  readonly media: { release(session: S): void }
  readonly locale: () => Locale
  /** `inventoryPath` in `paths.ts`. */
  readonly path: (name: InventoryPath) => string
}

/** The actions and the panic behind them, wired to the application's windows, stores and session. */
export function installMenuActions<
  W extends ActionWindow & { readonly window: BaseWindow },
  S extends ClearingSession & object
>(wiring: MenuActionWiring<W, S>): MenuActions<W, S> {
  const { windows, electron, stores } = wiring
  const panic = new Panic({
    note: noteFileAt(() => wiring.path('panicPendingFile')),
    downloads: wiring.downloads,
    stores: [...wiring.stopped, stores.history, stores.downloads],
    caches: [stores.favicons, stores.thumbnails],
    closeWindows: () => {
      windows.closeAll()
    },
    clearing: { session: electron.defaultSession, path: wiring.path },
    quit: electron.quit
  })
  return new MenuActions<W, S>({
    windows,
    defaultSession: electron.defaultSession,
    bookmarks: wiring.bookmarks,
    stores,
    forgetSession: (session) => {
      httpsExemptionsFor(session).clear()
      wiring.media.release(session)
    },
    ask: async (window, box) => {
      const options: MessageBoxOptions = box
      const { response } = await (window === undefined
        ? electron.dialog.showMessageBox(options)
        : electron.dialog.showMessageBox(window.window, options))
      return response
    },
    locale: wiring.locale,
    panic
  })
}
