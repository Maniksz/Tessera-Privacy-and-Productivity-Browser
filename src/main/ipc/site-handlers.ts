import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import type { Locale } from '@shared/i18n/catalog.js'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { SecurityState } from '@shared/model.js'
import type { SettingsKey, SettingValue } from '@shared/settings/definitions.js'
import { injectableDocumentUrl } from '@shared/filters/injection.js'
import {
  exemptionHostOf,
  filteringExemptFor,
  withSiteExemption
} from '@shared/filters/site-exemption.js'
import { nextZoomPercent } from '@shared/gestures/zoom.js'
import { internalUrl } from '@shared/product.js'
import type { UserRuleTextEditor } from '../data/UserRuleStore.js'
import type { BrowsingMode } from '../data/HistoryStore.js'
import type { SiteAnswers } from '../permissions/model.js'
import { permissionOriginOf, siteMenuTemplate } from '../menu/site-menu-items.js'

/**
 * `site:menu`: the native menu behind the lock and the shield in the address bar (U19, KTD13).
 *
 * ## Why this is not in `handlers.ts`
 *
 * It was, as `blocker:menu`, and it was the longest handler in a file over the line mark. Growing it by
 * the permissions, the zoom and the fingerprint switch would have been the wrong place twice: the file
 * may only gain call sites (KTD21), and it imports `ipc/router.ts`, so nothing in it can be tested.
 * Taking the registrar as an argument, as `media-handlers.ts` does, makes the body an ordinary function a
 * test can call with a fake window.
 *
 * ## What resolves what
 *
 * The window from the sender, and the tab from the window's active tile — the tile the address bar
 * speaks for. Zoom therefore goes to that tab alone (zoom is the pane's, not the site's; see
 * `shared/zoom/model.ts`), and the stored permissions come from the answers bound to the window's mode,
 * so a private window is handed ones that list and forget nothing.
 */

type SiteChannelContract = {
  [C in 'site:menu']: { request: InvokeHandlerArg<C>; response: InvokeResponse<C> }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to this channel. See `MediaHandle`. */
export type SiteHandle = <C extends keyof SiteChannelContract>(
  channel: C,
  handler: (
    payload: SiteChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => SiteChannelContract[C]['response']
) => void

/** A tab, as far as the menu needs one. `Tab` satisfies this. */
export interface SiteMenuTab {
  toState(): {
    readonly url: string
    readonly blockedRequests: number
    readonly security: SecurityState
  }
  /** Effective, with the setting standing in for a pane never zoomed. */
  readonly zoomPercent: number
  setZoomPercent(percent: number): void
  resetZoom(): void
  readonly view: { readonly webContents: { readonly id: number } }
}

/** One window. `BrowserWindowController` satisfies this. */
export interface SiteMenuWindow {
  readonly privateMode: boolean
  /** No argument: the active tile's tab. */
  resolveTab(): SiteMenuTab | undefined
  createTab(options: { url: string }): unknown
}

export interface SiteHandlerDeps<W extends SiteMenuWindow> {
  /** `handle` from `ipc/router.ts`. See `SiteHandle` for why it is passed rather than imported. */
  readonly handle: SiteHandle
  readonly windows: { resolve(event: IpcMainInvokeEvent): W | undefined }
  readonly settings: {
    get<K extends SettingsKey>(key: K): SettingValue<K>
    set(key: string, value: unknown): unknown
  }
  /** Read per call, so a language change reaches the next menu rather than the next restart. */
  readonly locale: () => Locale
  /** The stored permission answers, bound to a browsing mode. `PermissionStore` satisfies this. */
  readonly permissions: { answersFor(mode: BrowsingMode): SiteAnswers }
  /** The user's rules through the sender's mode-bound editor (R16); see `editorFor` in `handlers.ts`. */
  readonly rulesFor: (event: IpcMainInvokeEvent) => UserRuleTextEditor
  readonly startPicker: (webContentsId: number) => void
  readonly refreshFilters: () => void
  /** `Menu.buildFromTemplate(template).popup(…)` over the window, which needs Electron. */
  readonly showMenu: (template: MenuItemConstructorOptions[], window: W) => void
}

const OK = { ok: true } as const

export function registerSiteHandlers<W extends SiteMenuWindow>(deps: SiteHandlerDeps<W>): void {
  const { handle, windows, settings } = deps

  handle('site:menu', (_payload, event) => {
    const window = windows.resolve(event)
    const tab = window?.resolveTab()
    if (window === undefined || tab === undefined) return OK
    const state = tab.toState()
    /*
      The host, and it is `null` for anything the menu's site-scoped items cannot be keyed on.

      `injectableDocumentUrl` decides whether a document may be filtered at all — internal pages and
      `file:` documents may not — and `exemptionHostOf` reads the host out of it. Going through both
      rather than parsing the URL here is what keeps the picker, the per-site switch and the request
      pipeline agreeing about which documents are in scope.
    */
    const host = exemptionHostOf(injectableDocumentUrl(state.url, ''))
    const exemptSites = settings.get('privacy.blockerOffForSites')
    const editor = deps.rulesFor(event)
    const answers = deps.permissions.answersFor(window.privateMode ? 'private' : 'normal')

    const template = siteMenuTemplate({
      locale: deps.locale(),
      blockedOnPage: state.blockedRequests,
      // Read through the same editor the two rule items write through (R16); in a private window the
      // list and the switch would otherwise disagree about what "my rules" are.
      userRules: editor.list(),
      blockerEnabled: settings.get('privacy.blockerEnabled'),
      host,
      blockerEnabledOnSite: !filteringExemptFor(state.url, exemptSites),
      onBlockElement: () => deps.startPicker(tab.view.webContents.id),
      // Opens the tab rather than asking the renderer to: nothing in the chrome listens for that any more.
      onOpenSettings: () => window.createTab({ url: internalUrl('settings') }),
      onRefreshLists: () => deps.refreshFilters(),
      onSetBlockerEnabled: (enabled) => settings.set('privacy.blockerEnabled', enabled),
      onSetBlockerEnabledOnSite: (menuHost, enabled) => {
        // `enabled` is "blocking on", so the exemption is its opposite. Through the pure function so that
        // removing an exemption also removes a parent-domain one covering this host.
        const next = withSiteExemption(exemptSites, menuHost, !enabled)
        if (next === exemptSites) return
        settings.set('privacy.blockerOffForSites', [...next])
      },
      // Through the mode-bound editor: a private window must not alter the normal profile's rules, and
      // is offered only what that editor would honour.
      onSetRuleEnabled: (id, enabled) => editor.setEnabled(id, enabled),
      onRemoveRules: (ids) => {
        for (const id of ids) editor.remove(id)
      },
      canSetRuleEnabled: (id, enabled) => editor.canSetEnabled(id, enabled),
      canRemoveRule: (id) => editor.canRemove(id),

      security: state.security,
      origin: permissionOriginOf(state.url),
      privateWindow: window.privateMode,
      storedPermissions: answers.list(),
      zoomPercent: tab.zoomPercent,
      fingerprintMode: settings.get('fingerprint.mode'),
      onForgetPermissions: (origin, topics) => answers.forget(origin, topics),
      /*
        The same two calls `zoom:step` and `zoom:reset` make, on the tab this menu was opened for and on no
        other: a step walks the ladder in `nextZoomPercent`, and reset puts the pane back to following
        `appearance.defaultZoom`, which a percentage cannot express.
      */
      onZoom: (step) => {
        if (step === 'reset') tab.resetZoom()
        else tab.setZoomPercent(nextZoomPercent(tab.zoomPercent, step))
      },
      onSetFingerprintMode: (mode) => settings.set('fingerprint.mode', mode)
    })
    deps.showMenu(template, window)
    return OK
  })
}
