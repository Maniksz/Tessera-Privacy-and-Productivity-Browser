/**
 * The order in which windows were last focused, and the one question downloads ask of it.
 *
 * ## Why the registry needs an order and not only "the focused window"
 *
 * `WindowRegistry.focused()` answers for this instant, and the instants that matter here are the
 * ones where it has no answer. A download with no web contents behind it arrives while the person
 * is looking at another application, so nothing is focused; a window that closes was the focused
 * one until a moment ago, so the window to inherit its downloads is the one focused *before* it.
 * Both need a history, and an array of windows kept in focus order is all the history they need.
 *
 * Kept free of Electron so that the rules below are tests rather than claims: the registry builds
 * real windows and cannot be constructed under Node. It supplies the facts — which window owns
 * which web contents, which session each has — and this file decides.
 */
export class WindowRecency<W> {
  #order: W[] = []

  /** The window came to the front. A new window counts, before its first `focus` arrives. */
  touch(window: W): void {
    this.#order = [window, ...this.#order.filter((other) => other !== window)]
  }

  forget(window: W): void {
    this.#order = this.#order.filter((other) => other !== window)
  }

  latest(matches: (window: W) => boolean): W | undefined {
    return this.#order.find(matches)
  }

  get mostRecentFirst(): readonly W[] {
    return [...this.#order]
  }
}

/**
 * The window a download that has just started belongs to.
 *
 * The web contents Electron names wins: a download from a tab belongs to that tab's window whatever
 * is focused, because a background tab finishing a redirect into a file is a download somebody asked
 * for *there*. Without one, or with one no window owns — a popup, a page already torn down — it
 * belongs to the window of the same session focused most recently, which is the window the person
 * was using when they caused it.
 *
 * Only windows of the download's own session are candidates, on both paths. A private session is
 * one window's alone, so this is what keeps a private download off every other window's button;
 * and the default session is shared by exactly the normal windows, so a normal download can never
 * be filed under a private one.
 */
export function downloadWindowFor<W extends { readonly session: unknown }>(
  source: { readonly id: number } | undefined,
  session: unknown,
  mostRecentFirst: readonly W[],
  owns: (window: W, webContentsId: number) => boolean
): W | undefined {
  const candidates = mostRecentFirst.filter((window) => window.session === session)
  const owner =
    source === undefined ? undefined : candidates.find((window) => owns(window, source.id))
  return owner ?? candidates[0]
}
