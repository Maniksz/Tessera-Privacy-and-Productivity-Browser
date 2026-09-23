import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS } from '@shared/ipc/channels.js'
import type * as ContractModule from '@shared/ipc/contract.js'
import type * as RouterModule from '@main/ipc/router.js'

/**
 * The router: the one place every invoke from every renderer passes through.
 *
 * ## Why this file exists although the router needs `ipcMain`
 *
 * `sender-policy.ts` decides who may call what and is tested on its own; this file checks that the
 * router *asks* it, and asks it first. The decision being right is worth nothing if the wiring
 * parses the payload before it, hands the policy the wrong frame, or reads a vanished frame as
 * trusted. Those are the order-of-two-calls mistakes a fake `ipcMain` can catch and a pure test
 * cannot.
 *
 * ## Why the router is imported afresh for every test
 *
 * It holds three things at module level: the set of registered channels, the chrome check
 * `configureSenderPolicy` installs, and the chrome addresses, read once from the environment and
 * `app.isPackaged` at import. A fresh module per test resets all three the way a new process would,
 * which needs no test-only export in the router and lets the dev-server and packaged cases set up
 * their environment *before* the addresses are computed, as the real process does.
 */

type Listener = (event: unknown, payload: unknown) => Promise<unknown>

const electron = vi.hoisted(() => {
  const listeners = new Map<string, Listener>()
  return {
    listeners,
    app: { isPackaged: false },
    ipcMain: {
      handle(channel: string, listener: Listener): void {
        listeners.set(channel, listener)
      }
    }
  }
})

vi.mock('electron', () => ({ app: electron.app, ipcMain: electron.ipcMain }))

let router: typeof RouterModule
let contract: typeof ContractModule

/**
 * Where the router expects the bundled chrome documents: `../renderer` beside the main bundle.
 *
 * Under test the "bundle" is the source tree, so that is `src/main/renderer`, which does not exist —
 * it does not need to, since the address is compared and never loaded. Resolved from this file
 * rather than from the working directory, so the answer is the same inside Stryker's sandbox.
 */
const CHROME_DOCUMENT = new URL('../src/main/renderer/index.html', import.meta.url).href
const OVERLAY_DOCUMENT = new URL('../src/main/renderer/overlay.html', import.meta.url).href
const DEV_SERVER = 'http://localhost:5173'

/** The chrome renderer's `webContents`, as `configureSenderPolicy`'s check recognises it. */
const CHROME_CONTENTS = { id: 1 }
/** Any other renderer: a tab, an internal page. */
const TAB_CONTENTS = { id: 2 }

interface FrameShape {
  readonly url: string
  readonly parent: unknown
}

/**
 * An invoke event as Electron hands it over, reduced to what the router reads.
 *
 * `frame: null` is a frame that navigated away or was destroyed; `frame: 'throws'` is one disposed
 * between the two reads, where Electron throws from the getter instead of answering.
 */
function eventFrom(
  contents: object,
  frame: FrameShape | null | 'throws'
): IpcMainInvokeEvent & { readonly marker: string } {
  return {
    marker: 'the event the handler must receive',
    sender: contents,
    get senderFrame(): FrameShape | null {
      if (frame === 'throws')
        throw new Error('Render frame was disposed before WebFrameMain could be accessed')
      return frame
    }
  } as unknown as IpcMainInvokeEvent & { readonly marker: string }
}

function mainFrame(url: string): FrameShape {
  return { url, parent: null }
}

function subframe(url: string): FrameShape {
  return { url, parent: mainFrame(CHROME_DOCUMENT) }
}

const chromeAt = (url: string): IpcMainInvokeEvent => eventFrom(CHROME_CONTENTS, mainFrame(url))
const tabAt = (url: string): IpcMainInvokeEvent => eventFrom(TAB_CONTENTS, mainFrame(url))

/** Sends `payload` on `channel` as `event`, the way `ipcMain` would. */
function invoke(channel: string, event: IpcMainInvokeEvent, payload?: unknown): Promise<unknown> {
  const listener = electron.listeners.get(channel)
  if (listener === undefined) throw new Error(`nothing registered on ${channel}`)
  return listener(event, payload)
}

/** A fresh router, with the environment the process would have had when it was loaded. */
async function loadRouter(options: { devServer?: string; packaged?: boolean } = {}): Promise<void> {
  vi.resetModules()
  electron.listeners.clear()
  electron.app.isPackaged = options.packaged ?? false
  // Empty is how `devServerUrl` reads "unset", and it keeps a developer's own shell out of the test.
  vi.stubEnv('ELECTRON_RENDERER_URL', options.devServer ?? '')
  router = await import('@main/ipc/router.js')
  contract = await import('@shared/ipc/contract.js')
}

/** The same check `WindowRegistry` supplies: identity, never an address. */
function trustChromeContents(): void {
  router.configureSenderPolicy((event) => event.sender === (CHROME_CONTENTS as unknown))
}

/**
 * A handler's answer the contract would not accept, typed past the compiler.
 *
 * The router's response check exists for exactly the handler the types did not stop — one that
 * drifted during work — so the only way to exercise it is to hand it one.
 */
function offContract(value: unknown): never {
  return value as never
}

const INSETS = { top: 40, bottom: 0, left: 0, right: 0 }
const WINDOW_STATE = {
  windowId: 1,
  platform: 'darwin',
  focused: true,
  maximized: false,
  fullscreen: false,
  privateMode: false,
  windowControlsInset: { left: 72, right: 0 }
}

beforeEach(async () => {
  await loadRouter()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('who may call', () => {
  it('refuses web content before the payload is even parsed', async () => {
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)
    const parse = vi.spyOn(contract.invokeContract['window:setChromeInsets'].request, 'safeParse')

    // A payload that would also fail the schema: the refusal must be about the sender, not the shape.
    await expect(
      invoke('window:setChromeInsets', tabAt('https://evil.example/'), { top: 'x' })
    ).rejects.toThrow('Refused: web content may not use IPC (channel window:setChromeInsets)')
    expect(parse).not.toHaveBeenCalled()
    expect(handler).not.toHaveBeenCalled()
  })

  it('trusts nobody as chrome until the registry has said who that is', async () => {
    // No `configureSenderPolicy`: the default must be "no renderer is the chrome", not "any is".
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)

    await expect(
      invoke('window:setChromeInsets', chromeAt(CHROME_DOCUMENT), INSETS)
    ).rejects.toThrow('Refused: web content may not use IPC (channel window:setChromeInsets)')
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets the chrome renderer call from its own main frame, at the bundled documents', async () => {
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)

    await expect(
      invoke('window:setChromeInsets', chromeAt(CHROME_DOCUMENT), INSETS)
    ).resolves.toEqual({ ok: true })
    await expect(
      invoke('window:setChromeInsets', chromeAt(OVERLAY_DOCUMENT), INSETS)
    ).resolves.toEqual({ ok: true })
    expect(handler).toHaveBeenCalledTimes(2)
  })

  it('refuses the chrome identity at an address the core did not load', async () => {
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)

    await expect(
      invoke('window:setChromeInsets', chromeAt('https://evil.example/'), INSETS)
    ).rejects.toThrow(
      'Refused: the chrome UI may call window:setChromeInsets only from its own document in its main frame (sender: https://evil.example/)'
    )
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses the chrome identity from a subframe, even one at the chrome address', async () => {
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)

    await expect(
      invoke(
        'window:setChromeInsets',
        eventFrom(CHROME_CONTENTS, subframe(CHROME_DOCUMENT)),
        INSETS
      )
    ).rejects.toThrow(`(sender: ${CHROME_DOCUMENT})`)
    expect(handler).not.toHaveBeenCalled()
  })

  it('refuses the chrome identity when there is no frame to ask', async () => {
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)

    await expect(
      invoke('window:setChromeInsets', eventFrom(CHROME_CONTENTS, null), INSETS)
    ).rejects.toThrow('(sender: no frame)')
    // A frame disposed between the reads throws from the getter: still a refusal, never a crash
    // that skips the check.
    await expect(
      invoke('window:setChromeInsets', eventFrom(CHROME_CONTENTS, 'throws'), INSETS)
    ).rejects.toThrow('(sender: no frame)')
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets an internal page call what its own list grants', async () => {
    const set = vi.fn(() => offContract({}))
    router.handle('settings:set', set)
    // Packaged, so the stand-in answer is not held to the full settings snapshot.
    electron.app.isPackaged = true

    await expect(
      invoke('settings:set', tabAt('tessera://settings'), { key: 'k', value: 1 })
    ).resolves.toEqual({})
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('refuses an internal page a channel outside its list', async () => {
    const set = vi.fn(() => offContract({}))
    router.handle('settings:set', set)

    await expect(
      invoke('settings:set', tabAt('tessera://start'), { key: 'k', value: 1 })
    ).rejects.toThrow('Refused: internal page start may not call settings:set')
    expect(set).not.toHaveBeenCalled()
  })

  it('in development, trusts the dev server and not the bundle it did not load', async () => {
    await loadRouter({ devServer: DEV_SERVER })
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)

    await expect(
      invoke('window:setChromeInsets', chromeAt(`${DEV_SERVER}/overlay.html`), INSETS)
    ).resolves.toEqual({ ok: true })
    await expect(
      invoke('window:setChromeInsets', chromeAt(CHROME_DOCUMENT), INSETS)
    ).rejects.toThrow('Refused: the chrome UI may call')
  })

  it('in a packaged build, ignores a dev server named in the environment', async () => {
    await loadRouter({ devServer: DEV_SERVER, packaged: true })
    trustChromeContents()
    router.handle('window:setChromeInsets', () => router.OK)

    await expect(
      invoke('window:setChromeInsets', chromeAt(`${DEV_SERVER}/`), INSETS)
    ).rejects.toThrow('Refused: the chrome UI may call')
    await expect(
      invoke('window:setChromeInsets', chromeAt(CHROME_DOCUMENT), INSETS)
    ).resolves.toEqual({ ok: true })
  })
})

describe('what they may send', () => {
  it('refuses an invalid payload without calling the handler, naming every problem', async () => {
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)

    await expect(
      invoke('window:setChromeInsets', chromeAt(CHROME_DOCUMENT), { ...INSETS, top: -1, left: 'x' })
    ).rejects.toThrow(/^Invalid request on window:setChromeInsets: top: [^;]+; left: [^;]+$/)
    expect(handler).not.toHaveBeenCalled()
  })

  it('names a nested field by its whole path, and a payload that is not an object as the root', async () => {
    trustChromeContents()
    router.handle('overlay:present', () => router.OK)

    await expect(
      invoke('overlay:present', chromeAt(CHROME_DOCUMENT), {
        kind: 'layout-menu',
        anchor: { x: 'left', y: 0, width: 10, height: 10 },
        current: '1x1'
      })
    ).rejects.toThrow(/^Invalid request on overlay:present: anchor\.x: /)
    await expect(
      invoke('overlay:present', chromeAt(CHROME_DOCUMENT), 'not a form')
    ).rejects.toThrow(/^Invalid request on overlay:present: \(root\): /)
  })

  it('hands the handler the parsed payload, without fields the contract does not name', async () => {
    trustChromeContents()
    const handler = vi.fn(() => router.OK)
    router.handle('window:setChromeInsets', handler)
    const event = chromeAt(CHROME_DOCUMENT)

    await invoke('window:setChromeInsets', event, { ...INSETS, injected: 'not in the contract' })

    expect(handler).toHaveBeenCalledWith(INSETS, event)
    const [received] = handler.mock.calls[0] as unknown as [Record<string, unknown>]
    expect(received).not.toHaveProperty('injected')
  })
})

describe('what the handler may answer', () => {
  it('in development, refuses a response that drifted from the contract', async () => {
    trustChromeContents()
    router.handle('window:getState', () =>
      offContract({ ...WINDOW_STATE, windowControlsInset: { left: 'wide', right: 0 } })
    )
    router.handle('window:minimize', () => offContract(null))

    await expect(invoke('window:getState', chromeAt(CHROME_DOCUMENT))).rejects.toThrow(
      /^Handler for window:getState returned an invalid response: windowControlsInset\.left: /
    )
    await expect(invoke('window:minimize', chromeAt(CHROME_DOCUMENT))).rejects.toThrow(
      /^Handler for window:minimize returned an invalid response: \(root\): /
    )
  })

  it('in development, lists every problem with a response', async () => {
    trustChromeContents()
    router.handle('window:getState', () =>
      offContract({ ...WINDOW_STATE, focused: 'yes', maximized: 'no' })
    )

    await expect(invoke('window:getState', chromeAt(CHROME_DOCUMENT))).rejects.toThrow(
      /: focused: [^;]+; maximized: [^;]+$/
    )
  })

  it('passes a valid response through unchanged, from an async handler too', async () => {
    trustChromeContents()
    router.handle('window:getState', async () => Promise.resolve(WINDOW_STATE as never))

    await expect(invoke('window:getState', chromeAt(CHROME_DOCUMENT))).resolves.toBe(WINDOW_STATE)
  })

  it('in a packaged build, does not pay for response validation', async () => {
    trustChromeContents()
    const drifted = { ...WINDOW_STATE, focused: 'yes' }
    router.handle('window:getState', () => drifted as never)
    electron.app.isPackaged = true

    await expect(invoke('window:getState', chromeAt(CHROME_DOCUMENT))).resolves.toBe(drifted)
  })
})

describe('registration', () => {
  it('refuses a second handler for the same channel', () => {
    router.handle('window:minimize', () => router.OK)

    expect(() => {
      router.handle('window:minimize', () => router.OK)
    }).toThrow('IPC channel registered twice: window:minimize')
  })

  it('names every contract channel that has no handler', () => {
    const [first, second, ...rest] = INVOKE_CHANNELS
    for (const channel of rest) router.handle(channel, () => router.OK as never)

    expect(() => {
      router.assertAllChannelsRegistered()
    }).toThrow(`IPC channels declared but never handled: ${first}, ${second}`)
  })

  it('is satisfied once every contract channel has a handler', () => {
    for (const channel of INVOKE_CHANNELS) router.handle(channel, () => router.OK as never)

    expect(() => {
      router.assertAllChannelsRegistered()
    }).not.toThrow()
    expect(electron.listeners.size).toBe(INVOKE_CHANNELS.length)
  })
})
