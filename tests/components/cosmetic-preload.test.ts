/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COSMETIC_SPECIFIC_CHANNEL } from '@shared/filters/injection.js'

/**
 * The page half of the host-specific hiding rules: *when* the sheet is in the document, not what is in it.
 *
 * ## The bug this file is for
 *
 * Reported as a picked rule that "sometimes does not work" while reloading quickly. The core answered
 * every reload with the rule; the page did not apply it in time. A preload runs at `document-start`,
 * before the parser has produced `<html>`, so the first write had nowhere to go — and the only retry was
 * `DOMContentLoaded`, which comes after the first paint. Every frame drawn before it showed the element,
 * and a document discarded by the next reload never reached it at all. A push from the core that arrived
 * in the same window was simply lost.
 *
 * ## Why this is in `tests/components/`
 *
 * For the reason `picker-preload.test.ts` gives: what it needs is a document, and the `unit` project has
 * none. happy-dom's document starts out complete, so every test takes `<html>` away first and puts it
 * back the way a parser would — which is the one timing the preload is actually written for.
 *
 * ## Why the module is imported afresh for every test
 *
 * `installSpecificStyles` holds its state in a closure — the latest rules, whether it is still waiting
 * for somewhere to put them — and each test is about one document's lifetime. `electron` is stubbed as a
 * message bus, as in the picker's test, so a push here is exactly what the core would send.
 */

const bus = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  return {
    listeners,
    /** What the core answers the synchronous question with. Replaced per test. */
    specific: (): unknown => '',
    ipcRenderer: {
      on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
        listeners.set(channel, listener)
      },
      send(): void {
        // The generic survey and the procedural request: neither is what this file is about.
      },
      sendSync(channel: string): unknown {
        return channel === COSMETIC_SPECIFIC_CHANNEL ? bus.specific() : []
      }
    }
  }
})

vi.mock('electron', () => ({
  ipcRenderer: bus.ipcRenderer,
  contextBridge: { executeInMainWorld: (): void => undefined }
}))

const CSS = '.ad-slot { display: none !important; }'
const NEWER = '.ad-slot, .ad-rail { display: none !important; }'
const HOST_ID = 'tessera-cosmetic-host'

/**
 * Every observer the preload creates, and whether it is still attached.
 *
 * Wrapped rather than mocked: the real happy-dom observer still has to fire, because firing is what is
 * under test. What the wrapper adds is the ability to say "nothing is left watching the document".
 */
const observed: Array<{ target: Node; live: boolean }> = []
const NativeObserver = globalThis.MutationObserver
class WatchedObserver extends NativeObserver {
  readonly #entries: Array<{ target: Node; live: boolean }> = []

  override observe(target: Node, options?: MutationObserverInit): void {
    const entry = { target, live: true }
    this.#entries.push(entry)
    observed.push(entry)
    super.observe(target, options)
  }

  override disconnect(): void {
    for (const entry of this.#entries) entry.live = false
    super.disconnect()
  }
}

/** Observers still watching the document node itself — which only the host-sheet retry does. */
function waitingOnDocument(): number {
  return observed.filter((entry) => entry.live && entry.target === document).length
}

/** The host sheet's text, or null while there is no host sheet at all. */
function hostSheet(): string | null {
  return document.getElementById(HOST_ID)?.textContent ?? null
}

/** What the parser does next: `<html>` with a `<head>` and a `<body>`. */
function parseRoot(): void {
  const html = document.createElement('html')
  html.append(document.createElement('head'), document.createElement('body'))
  document.appendChild(html)
}

function push(payload: unknown): void {
  bus.listeners.get(COSMETIC_SPECIFIC_CHANNEL)?.({}, payload)
}

/**
 * Lets pending mutation records be delivered, and nothing else.
 *
 * One microtask, not a timer: a mutation observer's callback is a microtask, and that is the whole
 * argument for it — it runs before the browser gets to paint. A test that waited a macrotask would pass
 * for a retry scheduled on a timer as well, which would be too late. Nothing here dispatches
 * `DOMContentLoaded`, so a sheet present after this was not written by that fallback.
 */
async function settle(): Promise<void> {
  await Promise.resolve()
}

async function install(): Promise<void> {
  vi.resetModules()
  const { installCosmeticFiltering } = await import('../../src/preload/cosmetic.js')
  installCosmeticFiltering()
}

beforeEach(() => {
  globalThis.MutationObserver = WatchedObserver
  observed.length = 0
  bus.listeners.clear()
  bus.specific = () => ''
  const root = document.documentElement as HTMLElement | null
  if (root !== null) document.removeChild(root)
  // `document-start`: the parser has not finished, and has not even begun the tree.
  Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true })
})

afterEach(() => {
  if ((document.documentElement as HTMLElement | null) === null) parseRoot()
  Reflect.deleteProperty(document, 'readyState')
  globalThis.MutationObserver = NativeObserver
})

describe('the host sheet at document-start', () => {
  it('is in the document as soon as <html> is, without waiting for DOMContentLoaded', async () => {
    bus.specific = () => CSS
    await install()
    expect(hostSheet()).toBeNull()

    parseRoot()
    await settle()

    expect(hostSheet()).toBe(CSS)
    // Written, so nothing is left watching.
    expect(waitingOnDocument()).toBe(0)
  })

  it('keeps a push that arrives before <html> exists', async () => {
    await install()
    push(CSS)

    parseRoot()
    await settle()

    expect(hostSheet()).toBe(CSS)
  })

  it('writes only the newest of two pushes that arrive before <html>', async () => {
    bus.specific = () => CSS
    await install()
    push(CSS)
    push(NEWER)
    // One retry pending, however many answers are waiting on it.
    expect(waitingOnDocument()).toBe(1)

    parseRoot()
    await settle()

    expect(hostSheet()).toBe(NEWER)
    expect(waitingOnDocument()).toBe(0)
  })

  it('writes an empty push over a waiting answer rather than the stale one', async () => {
    // The core saying "no host rules any more" while the first answer is still waiting for a place.
    bus.specific = () => CSS
    await install()
    push('')

    parseRoot()
    await settle()

    expect(hostSheet()).toBe('')
  })

  it('writes at once when <html> is already there, and leaves no observer behind', async () => {
    parseRoot()
    bus.specific = () => CSS
    await install()

    expect(hostSheet()).toBe(CSS)
    expect(waitingOnDocument()).toBe(0)
  })
})

describe('the host sheet once it is in', () => {
  it('is emptied by an empty push, which is how a deleted rule stops hiding', async () => {
    parseRoot()
    bus.specific = () => CSS
    await install()

    push('')

    expect(hostSheet()).toBe('')
    expect(waitingOnDocument()).toBe(0)
  })
})
