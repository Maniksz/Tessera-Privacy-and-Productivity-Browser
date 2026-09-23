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
 *
 * ## Why a handed-on claim carries a time
 *
 * What the button marks depends on when its window last presented the downloads panel, and that time
 * belongs to the window. A claim that moved alone would arrive at a successor whose panel had never
 * shown it — or had shown it last before the closing window did — and a completion the user had
 * already looked at, and perhaps opened, would light that button up as news. So the closing window's
 * last presentation travels with each id it hands on, as that id's "seen at", and the summary counts an
 * outcome as seen up to the later of the two (`summarizeWindowDownloads`). The time is kept per id and
 * not per window because a successor also holds downloads of its own, which the closing window never
 * showed. It goes wherever the claim goes: forgotten with the row, dropped when a claim is.
 */
export class DownloadOwnership {
  readonly #byWindow = new Map<number, Set<string>>()
  /** Per handed-on id, the latest moment a window that held it presented its panel. */
  readonly #seenAt = new Map<string, number>()

  claim(windowId: number, downloadId: string): void {
    const ids = this.#byWindow.get(windowId) ?? new Set<string>()
    ids.add(downloadId)
    this.#byWindow.set(windowId, ids)
  }

  /** A copy, so a caller holding it cannot rearrange which window owns what. */
  idsOf(windowId: number): ReadonlySet<string> {
    return new Set(this.#byWindow.get(windowId))
  }

  /** Per id of this window that was handed on to it, when a window before it last showed it. A copy. */
  seenAtOf(windowId: number): ReadonlyMap<string, number> {
    const seen = new Map<string, number>()
    for (const id of this.#byWindow.get(windowId) ?? []) {
      const at = this.#seenAt.get(id)
      if (at !== undefined) seen.set(id, at)
    }
    return seen
  }

  /** Keeps only the claims `keep` answers yes for — the rows that still exist anywhere. */
  retain(keep: (downloadId: string) => boolean): void {
    for (const [windowId, ids] of [...this.#byWindow]) {
      for (const id of [...ids]) {
        if (keep(id)) continue
        ids.delete(id)
        this.#seenAt.delete(id)
      }
      if (ids.size === 0) this.#byWindow.delete(windowId)
    }
  }

  /**
   * A window closed: its claims go to `successor`, or nowhere.
   *
   * Nowhere is a real answer and not a loss — the downloads themselves are untouched and still listed.
   * Only the claim goes, because no open window is left to show it, and its "seen at" with it.
   *
   * `seenAt` is when the closing window last presented its panel, `null` if it never did. Each id
   * handed on keeps the later of that and what it already carried: a download handed from A to B and
   * on to C was seen when A showed it, whether or not B ever opened its panel.
   */
  handOver(windowId: number, successor: number | undefined, seenAt: number | null = null): void {
    if (successor === windowId) return
    const ids = this.#byWindow.get(windowId)
    this.#byWindow.delete(windowId)
    if (ids === undefined) return
    for (const id of ids) {
      if (successor === undefined) {
        this.#seenAt.delete(id)
        continue
      }
      this.claim(successor, id)
      const carried = this.#seenAt.get(id)
      if (seenAt !== null && (carried === undefined || seenAt > carried)) {
        this.#seenAt.set(id, seenAt)
      }
    }
  }

  /** How many windows hold a claim. For tests and diagnostics. */
  get windowCount(): number {
    return this.#byWindow.size
  }
}
