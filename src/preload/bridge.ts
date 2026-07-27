import { ipcRenderer } from 'electron'

/**
 * The two things every preload entry does the same way, and the one word for what it is.
 *
 * ## Why this file exists at all
 *
 * There are two preload entries — `index.ts` for tab views, `chrome.ts` for the browser's own
 * interface — and each is bundled on its own (see `electron.vite.config.ts`). Both wrap `ipcRenderer`
 * before it crosses the context bridge, and how that wrapping refuses a channel is the security
 * property of the boundary. Written twice it would be two things to keep in step; written here it is
 * one, and the entries differ only in *which* allowlist they hand it.
 *
 * Sharing a module between the entries costs nothing now: each entry is a separate build pass, so
 * this file is inlined into both rather than emitted as a chunk they would have to `require` — which
 * a sandboxed preload cannot do.
 */

/**
 * Which renderer a preload is running in.
 *
 * A file, not a flag, since the split: `chrome.ts` is the only bundle that contains the chrome bridge
 * at all. The value is still read from the command line by each entry, but only to *cross-check* the
 * file it is against the view it was given to — see either entry's `readRole`.
 */
export type Role = 'chrome' | 'content'

/**
 * Marks that a preload ran, which one, and when.
 *
 * An integration test asserts this exists before any page script executed — the timing window in
 * which fingerprint masking has to be installed to be worth anything (spec 4). `role` names the
 * *bundle* that ran, because after the split that is the fact worth having: a view whose bridge is
 * missing is nearly always a view that was handed the other file.
 */
export function markPreloadRan(role: Role): void {
  Object.defineProperty(globalThis, '__tesseraPreload', {
    value: Object.freeze({ version: 1, role, appliedAt: 'document-start' }),
    writable: false,
    enumerable: false,
    configurable: false
  })
}

/** Subscribes and returns its own unsubscribe function (spec 6). */
export function makeSubscriber(guard: (channel: string) => boolean) {
  return (channel: string, listener: (payload: unknown) => void): (() => void) => {
    if (!guard(channel)) {
      throw new Error(`tessera: not allowed to listen to "${channel}"`)
    }
    const wrapped = (_event: unknown, payload: unknown): void => listener(payload)
    ipcRenderer.on(channel, wrapped)
    return () => {
      ipcRenderer.removeListener(channel, wrapped)
    }
  }
}

export function makeInvoker(guard: (channel: string) => boolean, label: string) {
  return (channel: string, payload?: unknown): Promise<unknown> => {
    if (!guard(channel)) {
      return Promise.reject(new Error(`tessera: ${label} may not call "${channel}"`))
    }
    return ipcRenderer.invoke(channel, payload)
  }
}
