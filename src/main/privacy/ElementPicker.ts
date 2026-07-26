import { app, webContents, type WebContents } from 'electron'
import {
  PICKER_COMMIT_CHANNEL,
  PICKER_PROPOSE_CHANNEL,
  PICKER_START_CHANNEL,
  PICKER_STOP_CHANNEL,
  asElementDescription
} from '@shared/filters/picker-wire.js'
import { cosmeticRuleFor, proposeSelector } from '@shared/filters/picker.js'
import type { PickerChrome } from '@shared/filters/picker-wire.js'
import { registrableDomainOfUrl } from '@shared/url/domain.js'
import type { UserRuleEditor } from '../data/UserRuleStore.js'

/**
 * The element picker's core half: what may enter it, what a hover would hide, and what a click stores.
 *
 * ## Why a set of views rather than a flag on the request
 *
 * Every message from a page's preload is, from here, a message from a renderer — and a renderer can be
 * compromised. So the question "may this view propose selectors?" is answered from state the *core* set
 * when the user chose the picker in that tab, never from anything the message carries. A view that was
 * not started gets `null`, whatever it sends.
 *
 * That is the whole of the privilege story. A page cannot enter picker mode: the entry is a message from
 * here to one view, sent because the user clicked something in the browser's own interface.
 *
 * ## Why a picked rule may only hide
 *
 * `describeUserRule` in `user-rules.ts` refuses any rule that would block a network request, and this
 * only ever produces `hostname##selector`. Hiding a banner and cutting a site off are very different
 * powers, and they must not sit behind the same click.
 */

export interface ElementPickerOptions {
  /**
   * The picker's stylesheet and wording, for the language in force *now*.
   *
   * Read per start rather than once, so a language change reaches the next picker session rather than the
   * next restart — and so the preload never has to hold a translation catalogue.
   */
  readonly chrome: () => PickerChrome
  /**
   * Where a picked rule goes. Bound to a browsing mode by `UserRuleStore.editorFor`, so a private
   * window's picker writes nothing — which is a property of the object rather than a check here.
   */
  readonly editorFor: (webContentsId: number) => UserRuleEditor | null
}

export class ElementPicker {
  readonly #options: ElementPickerOptions
  /** Views the *core* has started. The only thing that grants a view the right to propose. */
  readonly #active = new Set<number>()

  constructor(options: ElementPickerOptions) {
    this.#options = options
  }

  install(): void {
    app.on('web-contents-created', (_event, contents) => {
      contents.on('ipc-message-sync', (event, channel, ...args) => {
        if (channel !== PICKER_PROPOSE_CHANNEL) return
        event.returnValue = this.#propose(contents, args[0])
      })

      contents.on('ipc-message', (_ipcEvent, channel, ...args) => {
        if (channel !== PICKER_COMMIT_CHANNEL) return
        this.#commit(contents, args[0])
      })

      // A navigation ends picker mode. The user asked to pick something on *this* page; carrying the
      // mode to the next one would leave a highlight following the pointer around a page nobody asked
      // about.
      contents.on('did-start-navigation', () => {
        this.#active.delete(contents.id)
      })
      contents.once('destroyed', () => {
        this.#active.delete(contents.id)
      })
    })
  }

  /**
   * Puts one view into picker mode. Called because the user chose it in the browser's interface.
   *
   * Returns whether it could be started, so a caller can report "there is no page here" rather than
   * appearing to work.
   */
  start(webContentsId: number): boolean {
    const view = webContents.fromId(webContentsId)
    if (view === undefined || view.isDestroyed()) return false
    this.#active.add(webContentsId)
    view.send(PICKER_START_CHANNEL, this.#options.chrome())
    return true
  }

  stop(webContentsId: number): void {
    this.#active.delete(webContentsId)
    const view = webContents.fromId(webContentsId)
    if (view !== undefined && !view.isDestroyed()) view.send(PICKER_STOP_CHANNEL)
  }

  isActive(webContentsId: number): boolean {
    return this.#active.has(webContentsId)
  }

  #propose(contents: WebContents, reported: unknown): unknown {
    if (!this.#active.has(contents.id)) return null
    const target = asElementDescription(reported)
    if (target === null) return null
    /*
      The estimate is taken against the target alone rather than against a survey of the page.

      Sending every element on every hover would be the whole document across a process boundary many
      times a second. What that costs is precision in `estimatedMatches` — it counts the target and
      whatever else the description contains — so the "matches many" warning is weaker than it could be.
      The user still sees and confirms the selector, which is where that judgement belongs.
    */
    return proposeSelector({ target, page: [target] })
  }

  #commit(contents: WebContents, reportedSelector: unknown): void {
    if (!this.#active.has(contents.id)) return
    if (typeof reportedSelector !== 'string' || reportedSelector === '') return

    const host = registrableDomainOfUrl(contents.getURL())
    // No site, no rule. A `file:` document or `about:blank` has no host to key a rule on, and a rule
    // with no host would be a *generic* rule the user never asked to write — one that hid that selector
    // on every site they visit.
    if (host === null) return

    const editor = this.#options.editorFor(contents.id)
    if (editor === null) return
    editor.add({ text: cosmeticRuleFor(host, reportedSelector), origin: 'picker' })
  }
}
