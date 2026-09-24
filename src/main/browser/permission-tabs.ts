import type { PermissionTabChange } from '../permissions/model.js'

/**
 * What a window's permission listeners were last told about each of its tabs (spec 4), and the telling.
 *
 * Out of `BrowserWindowController` (KTD21), and for more than its length: tab unloading gives a tab a new
 * view, and so a new `webContents` id, and a question from that view has to reach the dialogue over its tile.
 * The id is held here, per tab, and `replaced` is the one place it changes (KTD9, `onViewReplaced`).
 *
 * The id is read once, when the tab is made or its view replaced, because it is needed again when the tab
 * closes — and a view that is being torn down is the one thing whose id may no longer be readable. A `WeakMap`,
 * so a closed tab takes its entry with it.
 */
export class PermissionTabs<T extends object> {
  /**
   * Whoever waits on this window's tabs to answer a permission question: the arbiter, while it has something
   * queued here. A set with its own unsubscribe rather than the window's disposers: the arbiter subscribes
   * whenever a queue opens and unsubscribes whenever it empties, many times over a window's life.
   */
  readonly #listeners = new Set<(change: PermissionTabChange) => void>()
  readonly #tabs = new WeakMap<T, { webContentsId: number; url: string }>()
  /** The tab in front as the listeners last heard it; see `activated`. */
  #reportedActive: number | null = null

  add(tab: T, webContentsId: number, url: string): void {
    this.#tabs.set(tab, { webContentsId, url })
  }

  /** The `webContents` id the listeners know this tab by, or `null` for none. */
  idOf(tab: T | undefined): number | null {
    return tab === undefined ? null : (this.#tabs.get(tab)?.webContentsId ?? null)
  }

  subscribe(listener: (change: PermissionTabChange) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * A tab's committed address, reported when it changes and not otherwise.
   *
   * `onStateChanged` fires for a title, a favicon or a load starting as well, and the address moves only on a
   * commit — so comparing with what was last reported turns the one callback into a navigation event without
   * reaching into `Tab`'s own subscriptions.
   */
  navigated(tab: T, url: string): void {
    const reported = this.#tabs.get(tab)
    if (reported === undefined || reported.url === url) return
    reported.url = url
    this.#tell({ kind: 'navigated', webContentsId: reported.webContentsId, url })
  }

  /** The tab has gone. After it left the window, so a listener reacting cannot find it in front. */
  closed(tab: T): void {
    const reported = this.#tabs.get(tab)
    if (reported === undefined) return
    this.#tell({ kind: 'closed', webContentsId: reported.webContentsId })
  }

  /**
   * The tab's view was replaced (U15): the old id is gone like a closed tab's, and the tab answers to the new one.
   */
  replaced(tab: T, webContentsId: number): void {
    const reported = this.#tabs.get(tab)
    if (reported === undefined) return
    const old = reported.webContentsId
    this.#tabs.set(tab, { webContentsId, url: reported.url })
    this.#tell({ kind: 'closed', webContentsId: old })
  }

  /**
   * Tells the listeners the tab in front changed, once per change.
   *
   * From the window's broadcast round rather than from every place that moves the active tile, because that
   * round is where every one of them already arrives.
   */
  activated(webContentsId: number | null): void {
    if (webContentsId === this.#reportedActive) return
    this.#reportedActive = webContentsId
    this.#tell({ kind: 'activated' })
  }

  /** The window is gone: anything still waiting on a tab here is refused, and nobody is told again. */
  gone(): void {
    this.#tell({ kind: 'gone' })
    this.#listeners.clear()
  }

  /**
   * Guarded per listener: this runs inside closing a tab and the window's teardown, and a listener that threw
   * must not leave a tab half closed.
   */
  #tell(change: PermissionTabChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change)
      } catch (error) {
        console.error('[permissions] a tab listener threw:', error)
      }
    }
  }
}
