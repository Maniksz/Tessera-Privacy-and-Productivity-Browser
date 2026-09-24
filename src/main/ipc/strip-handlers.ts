import type { IpcMainInvokeEvent } from 'electron'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import type { stripInvokeContract } from '@shared/strip/schema.js'
import type { TabGroupController } from '../browser/TabGroupController.js'

/**
 * The `strip:*` channels: a tab or a tiled view's entry let go in the tab strip (U9, KTD7).
 *
 * Out of `handlers.ts` for `tabgroup-handlers.ts`'s reasons: that file may only gain call sites, and
 * handed the registrar and the windows, this is an ordinary function a test drives against a fake
 * window. The drop resolves the *sending* window, the only source a renderer cannot lie about, and is
 * applied by its groups, which own the strip's order (`TabGroupController.dropInStrip`).
 */

type StripChannel = keyof typeof stripInvokeContract

type StripChannelContract = {
  [C in StripChannel]: { request: InvokeHandlerArg<C>; response: InvokeResponse<C> }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to these channels. See `TabGroupHandle`. */
export type StripHandle = <C extends StripChannel>(
  channel: C,
  handler: (
    payload: StripChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => StripChannelContract[C]['response']
) => void

/** One window, as far as its strip goes. `BrowserWindowController` satisfies this. */
export interface StripWindow {
  readonly groups: Pick<TabGroupController, 'dropInStrip'>
}

export interface StripHandlerDeps<W extends StripWindow> {
  /** `handle` from `ipc/router.ts`, passed rather than imported; see `StripHandle`. */
  readonly handle: StripHandle
  readonly windows: { resolve(event: IpcMainInvokeEvent): W | undefined }
}

const OK = { ok: true } as const

export function registerStripHandlers<W extends StripWindow>(deps: StripHandlerDeps<W>): void {
  const { handle, windows } = deps

  handle('strip:drop', (drop, event) => {
    windows.resolve(event)?.groups.dropInStrip(drop)
    return OK
  })
}
