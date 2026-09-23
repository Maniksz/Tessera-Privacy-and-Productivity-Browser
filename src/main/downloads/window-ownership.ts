/**
 * Which window started which download, for as long as this run lasts.
 *
 * ## Why a set of ids per window, apart from the live downloads
 *
 * A normal download leaves the manager's live map the moment it ends — the store holds the finished
 * record, and two answers to one id would disagree. The window it started in has to outlive that: a
 * download that finished is exactly the one whose window should say so. Keeping the claim here, beside
 * the live map rather than inside it, is what lets it survive the end of the transfer.
 *
 * ## Why nothing here is written down
 *
 * A window id names a `BrowserWindow` of this process. After a restart the same number means another
 * window or none, so a stored claim would file yesterday's downloads under whichever window happened to
 * be created with that id today. Everything the claim is for belongs to the running session anyway.
 *
 * ## What ends a claim
 *
 * Forgetting a row forgets its claim, and a window closing hands its claims on or drops them. An empty
 * set is removed rather than kept, so a window that is gone leaves nothing behind in this map.
 */
export class DownloadOwnership {
  readonly #byWindow = new Map<number, Set<string>>()

  claim(windowId: number, downloadId: string): void {
    const ids = this.#byWindow.get(windowId) ?? new Set<string>()
    ids.add(downloadId)
    this.#byWindow.set(windowId, ids)
  }

  /** A copy, so a caller holding it cannot rearrange which window owns what. */
  idsOf(windowId: number): ReadonlySet<string> {
    return new Set(this.#byWindow.get(windowId))
  }

  /** Keeps only the claims `keep` answers yes for — the rows that still exist anywhere. */
  retain(keep: (downloadId: string) => boolean): void {
    for (const [windowId, ids] of [...this.#byWindow]) {
      for (const id of [...ids]) if (!keep(id)) ids.delete(id)
      if (ids.size === 0) this.#byWindow.delete(windowId)
    }
  }

  /**
   * A window closed: its claims go to `successor`, or nowhere.
   *
   * Nowhere is a real answer and not a loss — the downloads themselves are untouched and still listed.
   * Only the claim goes, because no open window is left to show it.
   */
  handOver(windowId: number, successor: number | undefined): void {
    if (successor === windowId) return
    const ids = this.#byWindow.get(windowId)
    this.#byWindow.delete(windowId)
    if (ids === undefined || successor === undefined) return
    for (const id of ids) this.claim(successor, id)
  }

  /** How many windows hold a claim. For tests and diagnostics. */
  get windowCount(): number {
    return this.#byWindow.size
  }
}
