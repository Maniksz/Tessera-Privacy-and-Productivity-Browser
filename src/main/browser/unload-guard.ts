import { app, autoUpdater, dialog, type BaseWindow, type MessageBoxSyncOptions } from 'electron'
import { resolveLocale, type Locale } from '@shared/i18n/catalog.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { menuLabel } from '../menu/menu-text.js'
import { isInternalPageUrl } from '../ipc/sender-policy.js'
import type { After } from '../shutdown.js'
import { unfoldGroupOf } from './tab-unloader.js'
import { liveContentsOf } from './view-contents.js'

/**
 * The close contract (KTD5): which ways out of a page ask the page first, and what follows either answer.
 *
 * | Trigger                                   | Asks `beforeunload` | On "Stay"                                  |
 * |-------------------------------------------|---------------------|--------------------------------------------|
 * | Closing a tab (×, Ctrl+W, `window.close`) | yes                 | the tab stays; nothing on the closed stack |
 * | Closing the window                        | yes, tab by tab     | the window stays with the tabs still in it |
 * | Navigating away, reloading                | yes                 | the navigation is called off               |
 * | Quit, panic, OS log-off, update install   | never               | —                                          |
 * | Discarding (tab unloading)                | never               | "not discarded", as is no answer in 5 s    |
 * | Fillers, internal pages                   | no, and at once     | —                                          |
 * | A renderer that does not answer a close   | forced after 5 s    | —                                          |
 *
 * ## Why closing a tab is now two halves
 *
 * Electron cannot ask a page whether it objects without starting to close it: the only question there is, is
 * `webContents.close({ waitForBeforeUnload: true })`, and the answer is either the view going away (`destroyed`)
 * or a `will-prevent-unload` the core may overrule. So a close is a *request*, and the window's bookkeeping —
 * the closed-tab stack, the split, the groups, the permission listeners, `afterTabClosed` and the one-tab rule
 * — waits in `CloseContractHost.finish` for the view to be gone. A request whose page kept it finishes nothing,
 * which is what "Stay leaves everything as it was" (R11, AE3) comes down to.
 *
 * ## Why the dialog is synchronous
 *
 * Only a `preventDefault()` made *inside* the `will-prevent-unload` listener lets the page go. Answering later
 * would mean cancelling first and re-issuing the unload, and for a navigation out of the page there is nothing
 * to re-issue it with — the target is Chromium's, not ours. Hence `dialog.showMessageBoxSync` in the listener.
 *
 * ## What never asks
 *
 * A quit seals the session first (`beginShutdown` in `index.ts`) and then lets every window close at once:
 * `ShutdownSilence` hears the same `before-quit` and, for an update install, `before-quit-for-update`, which
 * Electron sends *before* it closes the windows and before any `before-quit`. A window torn down that way goes
 * straight to `closed`, whose `dispose` drops every pending request, so no tab of it is finished one by one.
 */

/**
 * How long a renderer may take to answer before the guard stops waiting (R12).
 *
 * A close the user asked for is then carried out without asking. A discard is not: the browser asked on its own
 * behalf, and a page too busy to answer is one it cannot know has nothing to lose, so it counts as "stay loaded".
 */
export const UNLOAD_HANG_MS = 5_000

/** What a page's objection is put to the user as, and which site it names (R11). */
export interface UnloadPrompt {
  readonly mode: 'close' | 'navigate'
  readonly site: string
}

/** The part of a `webContents` the guard speaks to. `WebContents` satisfies it as it stands. */
export interface UnloadContents extends Pick<NodeJS.EventEmitter, 'on' | 'removeListener'> {
  close(options?: { waitForBeforeUnload: boolean }): void
  isDestroyed(): boolean
  getURL(): string
}

/**
 * The host of an address, for a dialogue to lead with.
 *
 * The empty string for anything unparseable, which a surface renders as the full address instead — a prompt
 * that said "wants to open" with no subject would be unanswerable, and a URL this could not read is one the
 * user most needs to see in full.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The longest address a native dialogue names; a longer one keeps its start and its end. */
export const SITE_MAX = 80

/**
 * The site a question names: the host, or the address cut in the middle when there is no host.
 *
 * Only the fallback is ever cut. A `file:` or `data:` address can run to thousands of characters, and a native
 * message box can neither scroll nor show the rest, so a long one would push its buttons off the screen. The
 * start says what kind of address it is and the end which file, which is what is left to recognise it by. A
 * host is never cut: it is the fact the answer turns on.
 */
export function siteOf(url: string): string {
  const host = hostOf(url)
  if (host !== '') return host
  if (url.length <= SITE_MAX) return url
  const end = 24
  return `${url.slice(0, SITE_MAX - end - 1)}…${url.slice(-end)}`
}

/**
 * `preventDefault` on an Electron event that arrived as `unknown`.
 *
 * A declaration rather than a cast, as in `pendingNavigationOf`: `object` is assignable to a type whose only
 * field is optional, so this narrows without asserting anything unchecked.
 */
export function preventDefaultOf(event: unknown): void {
  if (typeof event !== 'object' || event === null) return
  const cancellable: { preventDefault?: () => void } = event
  cancellable.preventDefault?.()
}

function defaultAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  return () => clearTimeout(timer)
}

interface PendingUnload {
  /** Only ever raised, from `discard` to `close`: a close arriving on a pending discard is still a close. */
  mode: 'close' | 'discard'
  /** Everyone waiting on this request; a second × adds itself here rather than asking twice. */
  readonly settled: Array<(gone: boolean) => void>
  cancelDeadline: () => void
}

/**
 * One page's `beforeunload`, from the core's side: a close or discard request, the question, and the deadline.
 *
 * Subscribed for the page's whole life rather than per request, because a navigation asks too and nobody
 * requested that. A `will-prevent-unload` with no request pending is therefore a navigation or a reload.
 */
export class UnloadGuard {
  readonly #contents: UnloadContents
  readonly #confirm: (mode: UnloadPrompt['mode']) => boolean
  readonly #after: After
  #pending: PendingUnload | null = null
  /** A discard the deadline gave up on, whose renderer still owes Chromium its answer to the close. */
  #abandoned = false
  readonly #onObjection = (event: unknown): void => this.#objection(event)
  readonly #onDestroyed = (): void => this.#settle(true)

  constructor(options: {
    contents: UnloadContents
    /** Put the page's objection to the user; `true` is "Leave". Called only for `close` and `navigate`. */
    confirm(mode: UnloadPrompt['mode']): boolean
    after?: After
  }) {
    this.#contents = options.contents
    this.#confirm = options.confirm
    this.#after = options.after ?? defaultAfter
    this.#contents.on('will-prevent-unload', this.#onObjection)
    this.#contents.on('destroyed', this.#onDestroyed)
  }

  /** A close or discard is waiting on the page. The "closing" mark. */
  get pending(): boolean {
    return this.#pending !== null
  }

  /**
   * Asks the page to go. `settled(true)` once the view is gone, `settled(false)` when it stays.
   *
   * A request while one is already waiting asks nothing more of the page: it waits on the same answer. A close
   * that joins a discard makes the whole request a close, so an objection is put to the user rather than taken
   * as "not discarded" — the user asked for this tab to go, and would otherwise see it stay without a word.
   */
  request(mode: 'close' | 'discard', settled: (gone: boolean) => void): void {
    if (this.#pending !== null) {
      if (mode === 'close') this.#pending.mode = 'close'
      this.#pending.settled.push(settled)
      return
    }
    if (this.#contents.isDestroyed()) {
      settled(true)
      return
    }
    // Pending before the call: a view with no live renderer may go inside `close` itself.
    this.#abandoned = false
    this.#pending = { mode, settled: [settled], cancelDeadline: this.#deadline() }
    this.#contents.close({ waitForBeforeUnload: true })
  }

  /** Stops listening and forgets any request; `settled` is never called for it. The window's teardown. */
  dispose(): void {
    this.#pending?.cancelDeadline()
    this.#pending = null
    this.#contents.removeListener('will-prevent-unload', this.#onObjection)
    this.#contents.removeListener('destroyed', this.#onDestroyed)
  }

  /** Starts the five seconds; hands back what calls them off. */
  #deadline(): () => void {
    return this.#after(UNLOAD_HANG_MS, () => {
      if (this.#contents.isDestroyed()) {
        this.#settle(true)
        return
      }
      /*
        A discard is not forced: the page may still object, and unloading never goes over an objection (R12).
        Chromium's close cannot be taken back, so the answer may yet arrive; `#abandoned` keeps a late objection
        from being mistaken for a navigation's and put to the user.
      */
      if (this.#pending?.mode === 'discard') {
        this.#abandoned = true
        this.#settle(false)
        return
      }
      // The renderer never answered a close, so it is not asked again: the view goes without `beforeunload`.
      this.#contents.close()
    })
  }

  #objection(event: unknown): void {
    const pending = this.#pending
    if (pending === null) {
      // The late answer to an abandoned discard: refused without asking, as the discard's own would have been.
      if (this.#abandoned) this.#abandoned = false
      else if (this.#confirm('navigate')) preventDefaultOf(event)
      return
    }
    /*
      The renderer has answered, so the deadline is off before the question goes up. The dialog runs a nested
      loop on some platforms, in which a timer could otherwise fire and close the view under the user's answer.
    */
    pending.cancelDeadline()
    if (pending.mode === 'close' && this.#confirm('close')) {
      preventDefaultOf(event)
      // Unloading may hang as well, and gets its own five seconds from the answer.
      pending.cancelDeadline = this.#deadline()
      return
    }
    // "Stay", or a discard the page objected to. Either way the view stays and nothing follows.
    this.#settle(false)
  }

  #settle(gone: boolean): void {
    const pending = this.#pending
    if (pending === null) return
    this.#pending = null
    pending.cancelDeadline()
    for (const settled of pending.settled) settled(gone)
  }
}

/** A tab as the contract reads it. `Tab` satisfies this as it stands. */
export interface ClosingTab {
  readonly ephemeral: boolean
  /** `undefined` once the page has gone: what Electron's getter gives then (`view-contents.ts`). */
  readonly view: { readonly webContents: UnloadContents | undefined }
  toState(): { readonly url: string; readonly unloaded: boolean }
}

/**
 * True for a tab that closes at once, without a request: nothing in it could object.
 *
 * A filler the browser opened, an internal page, a tab restored unloaded, a view already gone, or a view that
 * has not committed an address. Fillers are why this exists: `TileOccupancyController.afterLayoutChange` closes
 * them and redistributes the rest in the same pass, which only works while their close is synchronous.
 */
export function closesAtOnce(tab: ClosingTab): boolean {
  if (tab.ephemeral || liveContentsOf(tab.view) === null) return true
  const { url, unloaded } = tab.toState()
  return unloaded || url === '' || isInternalPageUrl(url)
}

/** What the window is told when a tab has really gone. */
export interface ClosedTab {
  /** The address it goes on the closed-tab stack under, read before the view went. */
  readonly url: string
  /** False while the whole window is closing, when an empty window is the point rather than a mistake. */
  readonly keepOneTab: boolean
}

export interface CloseContractHost {
  /** Subscribes on the window with the window's own disposer pairing. Only `close` is asked for. */
  on(event: 'close', handler: (...args: unknown[]) => void): void
  tab(tabId: string): ClosingTab | undefined
  groups: {
    /** The strip's order, which is the order a closing window asks its tabs in. */
    displayOrder(): readonly string[]
    groups(): ReadonlyArray<{
      readonly id: string
      readonly collapsed: boolean
      readonly tabIds: readonly string[]
    }>
    setCollapsed(id: string, collapsed: boolean): void
  }
  activateTab(tabId: string): void
  /** The question, on this window. `true` is "Leave". */
  confirm(prompt: UnloadPrompt): boolean
  /** The second half of closing a tab: every piece of bookkeeping the tab's going sets off. */
  finish(tabId: string, closed: ClosedTab): void
  /** Close the window for real; every tab that could object has gone. */
  closeWindow(): void
  /** Whether a quit has begun, after which nothing asks. The process's own `ShutdownSilence` by default. */
  shutdown?: { readonly begun: boolean }
  after?: After
}

/**
 * One window's half of the contract: its tabs' guards, the tab-close request, and the window-close sequence.
 */
export class CloseContract {
  readonly #host: CloseContractHost
  readonly #shutdown: { readonly begun: boolean }
  readonly #guards = new Map<string, UnloadGuard>()
  /** The tabs a closing window has asked; each is asked once per attempt. */
  readonly #asked = new Set<string>()
  #closingWindow = false
  /** Set once every tab has agreed, so the window's own second `close` goes through. */
  #windowAgreed = false

  constructor(host: CloseContractHost) {
    this.#host = host
    // From the first window on, so the process hears a quit before any window is asked to close.
    this.#shutdown = host.shutdown ?? shutdownSilence()
    host.on('close', (event) => this.#onWindowClose(event))
  }

  /** Starts listening to a new tab's page, which may object to a navigation from its first commit. */
  track(tabId: string): void {
    // A view with no live page has nothing to object with, and nothing to listen on: it closes at once.
    const contents = liveContentsOf(this.#host.tab(tabId)?.view)
    if (contents === null) return
    const confirm = (mode: UnloadPrompt['mode']): boolean => {
      this.#reveal(tabId)
      return this.#host.confirm({ mode, site: siteOf(contents.getURL()) })
    }
    this.#guards.set(
      tabId,
      new UnloadGuard({ contents, confirm, after: this.#host.after ?? defaultAfter })
    )
  }

  /** Closes a tab: at once when nothing in it could object, otherwise as a request to its page. */
  closeTab(tabId: string): void {
    this.#close(tabId, () => undefined)
  }

  /**
   * Unloads a tab's page without ever asking: an objection means it stays loaded. Nothing is finished either
   * way — a discarded tab stays in the strip, so it goes on no stack and triggers no one-tab rule.
   */
  discard(tabId: string, settled: (discarded: boolean) => void): void {
    const guard = this.#guards.get(tabId)
    if (guard === undefined) {
      settled(false)
      return
    }
    guard.request('discard', (gone) => {
      if (gone) this.#untrack(tabId)
      settled(gone)
    })
  }

  /** The window's teardown: every guard stops listening, and a pending request finishes nothing. */
  dispose(): void {
    for (const guard of this.#guards.values()) guard.dispose()
    this.#guards.clear()
    this.#closingWindow = false
  }

  #close(tabId: string, settled: (gone: boolean) => void): void {
    const tab = this.#host.tab(tabId)
    if (tab === undefined) return
    const url = tab.toState().url
    const guard = this.#guards.get(tabId)
    if (guard === undefined || closesAtOnce(tab)) {
      this.#finish(tabId, url)
      settled(true)
      return
    }
    guard.request('close', (gone) => {
      if (gone) this.#finish(tabId, url)
      settled(gone)
    })
  }

  #finish(tabId: string, url: string): void {
    // Once, however many were waiting on the same request.
    if (this.#host.tab(tabId) === undefined) return
    this.#untrack(tabId)
    this.#host.finish(tabId, { url, keepOneTab: !this.#closingWindow })
  }

  #untrack(tabId: string): void {
    this.#guards.get(tabId)?.dispose()
    this.#guards.delete(tabId)
  }

  /** Brings the asking tab to the front before the question, unfolding its group if it is folded away. */
  #reveal(tabId: string): void {
    unfoldGroupOf(this.#host.groups, tabId)
    this.#host.activateTab(tabId)
  }

  #onWindowClose(event: unknown): void {
    if (this.#windowAgreed || this.#shutdown.begun) return
    preventDefaultOf(event)
    if (this.#closingWindow) return
    this.#closingWindow = true
    this.#asked.clear()
    this.#closeNextTab()
  }

  /**
   * One tab at a time, in strip order: the next is asked only once the one before has gone, and "Stay" ends
   * the whole attempt with the window open. Tabs that close at once are not asked; they go with the window.
   */
  #closeNextTab(): void {
    const next = this.#host.groups.displayOrder().find((tabId) => {
      const tab = this.#host.tab(tabId)
      return tab !== undefined && !this.#asked.has(tabId) && !closesAtOnce(tab)
    })
    if (next === undefined) {
      this.#closingWindow = false
      this.#windowAgreed = true
      this.#host.closeWindow()
      return
    }
    this.#asked.add(next)
    this.#close(next, (gone) => {
      if (gone) this.#closeNextTab()
      else this.#closingWindow = false
    })
  }
}

/**
 * Whether a quit has begun, heard from the two things that announce one.
 *
 * `before-quit` for every `app.quit()` — the menu, `Cmd+Q`, panic, a log-off on macOS. `before-quit-for-update`
 * for an update install, which on macOS closes the windows *before* any `before-quit`, and which
 * `electron-updater` sends on the other platforms as well. Sticky: a quit that has begun ends (`shutdown.ts`).
 */
export class ShutdownSilence {
  #begun = false

  constructor(emitters: {
    app: Pick<NodeJS.EventEmitter, 'on'>
    updater: Pick<NodeJS.EventEmitter, 'on'>
  }) {
    const begin = (): void => {
      this.#begun = true
    }
    emitters.app.on('before-quit', begin)
    emitters.updater.on('before-quit-for-update', begin)
  }

  get begun(): boolean {
    return this.#begun
  }
}

let processSilence: ShutdownSilence | null = null

/**
 * The process's one `ShutdownSilence`, over Electron's own app and updater, listening from the first window on.
 *
 * Its two listeners are never removed, and that is the pairing rule kept rather than broken: they belong to the
 * process, which is the one thing here that outlives every window, and there is only ever one pair.
 */
export function shutdownSilence(): ShutdownSilence {
  processSilence ??= new ShutdownSilence({ app, updater: autoUpdater })
  return processSilence
}

/** The native dialog for a page's objection. "Stay" is the default and the answer to Escape. */
export function unloadDialog(prompt: UnloadPrompt, locale: Locale): MessageBoxSyncOptions {
  return {
    type: 'question',
    buttons: [menuLabel(locale, 'unload.leave'), menuLabel(locale, 'unload.stay')],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
    message: menuLabel(locale, prompt.mode === 'close' ? 'unload.closeTab' : 'unload.leavePage'),
    detail: menuLabel(locale, 'unload.detail', { site: prompt.site })
  }
}

/** Asks on `window`, in the interface language; `true` is "Leave". */
export function askToLeave(
  window: BaseWindow,
  prompt: UnloadPrompt,
  preference: SettingsSnapshot['appearance.uiLanguage']
): boolean {
  const locale = preference === 'system' ? resolveLocale(app.getLocale()) : preference
  return dialog.showMessageBoxSync(window, unloadDialog(prompt, locale)) === 0
}
