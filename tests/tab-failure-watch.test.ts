import { describe, expect, it, vi, type Mock } from 'vitest'
import {
  noteBlockedNavigation,
  watchTabFailure,
  type TabFailureWatchHost
} from '@main/browser/tab-failure-watch.js'
import { installRequestPipeline } from '@main/privacy/RequestPipeline.js'
import { defaultSettings } from '@shared/settings/definitions.js'

/**
 * The events that give a tab its failure, and the ones that take it away (U9).
 *
 * `Tab.ts` cannot run outside a browser process, so what is asserted here is everything but the
 * subscription itself: which Electron events are listened to, what each argument position means, and
 * that a success clears what a failure set.
 */

let nextId = 100

interface Harness {
  host: TabFailureWatchHost
  emit(event: string, ...args: unknown[]): void
  registered: string[]
  changed: Mock<() => void>
  url: { current: string }
  unloading: { current: boolean }
}

function harness(): Harness {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const registered: string[] = []
  const url = { current: 'https://example.com/page' }
  const unloading = { current: false }
  const host: TabFailureWatchHost = {
    webContentsId: (nextId += 1),
    on: (event, handler) => {
      registered.push(event)
      listeners.set(event, [...(listeners.get(event) ?? []), handler])
    },
    url: () => url.current,
    unloading: () => unloading.current
  }
  return {
    host,
    registered,
    url,
    unloading,
    changed: vi.fn<() => void>(),
    emit: (event, ...args) => {
      for (const handler of listeners.get(event) ?? []) handler({}, ...args)
    }
  }
}

/** Electron's argument order: event, errorCode, errorDescription, validatedURL, isMainFrame. */
const failLoad = (h: Harness, code: number, url: string, isMainFrame = true): void =>
  h.emit('did-fail-load', code, 'ERR', url, isMainFrame)

describe('watchTabFailure', () => {
  it('listens to the failure, the crash and the commit that clears them', () => {
    const h = harness()
    watchTabFailure(h.host, h.changed)
    expect(h.registered.sort()).toEqual([
      'certificate-error',
      'did-fail-load',
      'did-navigate',
      'did-start-navigation',
      'render-process-gone'
    ])
  })

  it('starts without a failure', () => {
    const h = harness()
    expect(watchTabFailure(h.host, h.changed).current).toBeUndefined()
  })

  it('sets a failure for a main-frame load that failed and says so once', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    failLoad(h, -105, 'https://nowhere.example/')
    expect(watch.current).toEqual({ kind: 'network', code: -105, host: 'nowhere.example' })
    expect(h.changed).toHaveBeenCalledTimes(1)
  })

  it('ignores a subframe, an abort and arguments that are not what Electron sends', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    failLoad(h, -105, 'https://ads.example/', false)
    failLoad(h, -3, 'https://example.com/')
    h.emit('did-fail-load', 'x', 'ERR', 42, 'yes')
    expect(watch.current).toBeUndefined()
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('still shows a failure whose address did not arrive, with no host to name', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    h.emit('did-fail-load', -105, 'ERR', undefined, true)
    expect(watch.current).toEqual({ kind: 'network', code: -105, host: '' })
  })

  it('keeps an existing failure when a subframe fails afterwards', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    failLoad(h, -130, 'https://example.com/')
    failLoad(h, -105, 'https://ads.example/', false)
    expect(watch.current?.kind).toBe('proxy')
    expect(h.changed).toHaveBeenCalledTimes(1)
  })

  it('clears the failure when the reload commits, and says so', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    failLoad(h, -105, 'https://example.com/page')
    // The address the tab reports was never touched: the watch has no way to write one.
    expect(h.url.current).toBe('https://example.com/page')
    h.emit('did-navigate', 'https://example.com/page', 200, 'OK')
    expect(watch.current).toBeUndefined()
    expect(h.changed).toHaveBeenCalledTimes(2)
  })

  it('says nothing for a commit when there was nothing to clear', () => {
    const h = harness()
    watchTabFailure(h.host, h.changed)
    h.emit('did-navigate', 'https://example.com/', 200, 'OK')
    expect(h.changed).not.toHaveBeenCalled()
  })

  it('marks a crash with the page it happened on', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    h.emit('render-process-gone', { reason: 'crashed', exitCode: 139 })
    expect(watch.current).toEqual({ kind: 'crashed', code: 139, host: 'example.com' })
    expect(h.changed).toHaveBeenCalledTimes(1)
  })

  it('keeps a clean exit silent and reads odd details defensively', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    h.emit('render-process-gone', { reason: 'clean-exit', exitCode: 0 })
    expect(watch.current).toBeUndefined()
    h.emit('render-process-gone', null)
    expect(watch.current).toEqual({ kind: 'crashed', code: 0, host: 'example.com' })
  })

  it('does not call an eviction during an unload a crash', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    h.unloading.current = true
    h.emit('render-process-gone', { reason: 'memory-eviction', exitCode: 0 })
    expect(watch.current).toBeUndefined()
  })

  it('treats an eviction as a crash for a host that cannot be unloaded', () => {
    const h = harness()
    const { unloading: _ignored, ...host } = h.host
    const watch = watchTabFailure(host, h.changed)
    h.emit('render-process-gone', { reason: 'memory-eviction', exitCode: 0 })
    expect(watch.current?.kind).toBe('crashed')
  })

  it('gives both tabs of one renderer their own crashed state', () => {
    const first = harness()
    const second = harness()
    const a = watchTabFailure(first.host, first.changed)
    const b = watchTabFailure(second.host, second.changed)
    // One process gone is one event per WebContents it hosted.
    first.emit('render-process-gone', { reason: 'crashed', exitCode: 1 })
    second.emit('render-process-gone', { reason: 'crashed', exitCode: 1 })
    expect(a.current?.kind).toBe('crashed')
    expect(b.current?.kind).toBe('crashed')
  })
})

describe('certificateRejected', () => {
  it('is set by a rejected certificate and cleared when the next navigation starts', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    expect(watch.certificateRejected).toBe(false)
    h.emit('certificate-error', 'https://example.com/', 'net::ERR_CERT_DATE_INVALID')
    h.emit('certificate-error', 'https://example.com/img.png', 'net::ERR_CERT_DATE_INVALID')
    expect(watch.certificateRejected).toBe(true)
    expect(h.changed).toHaveBeenCalledTimes(1)
    h.emit('did-start-navigation')
    h.emit('did-start-navigation')
    expect(watch.certificateRejected).toBe(false)
    expect(h.changed).toHaveBeenCalledTimes(2)
  })

  it('leaves the tile alone: a rejected certificate is not yet a failed page', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    h.emit('certificate-error')
    expect(watch.current).toBeUndefined()
  })
})

describe('the stage behind a -20', () => {
  it('takes the stage the pipeline recorded for this view', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    noteBlockedNavigation(h.host.webContentsId, 'blocker')
    failLoad(h, -20, 'https://ads.example/')
    expect(watch.current).toEqual({
      kind: 'blocked',
      code: -20,
      host: 'ads.example',
      source: 'blocker'
    })
  })

  it('does not lend one view the stage recorded for another', () => {
    const blocked = harness()
    const other = harness()
    const watch = watchTabFailure(other.host, other.changed)
    noteBlockedNavigation(blocked.host.webContentsId, 'telemetry')
    failLoad(other, -20, 'https://example.com/')
    expect(watch.current?.source).toBeUndefined()
  })

  it('uses a record once, so a later -20 is not blamed on an old stage', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    noteBlockedNavigation(h.host.webContentsId, 'telemetry')
    failLoad(h, -20, 'https://a.example/')
    failLoad(h, -20, 'https://b.example/')
    expect(watch.current?.source).toBeUndefined()
  })

  it('forgets a record on a successful commit', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    noteBlockedNavigation(h.host.webContentsId, 'blocker')
    h.emit('did-navigate', 'https://example.com/', 200, 'OK')
    failLoad(h, -20, 'https://example.com/')
    expect(watch.current?.source).toBeUndefined()
  })

  it('ignores a request that belongs to no view, and a stage that does not cancel', () => {
    const h = harness()
    const watch = watchTabFailure(h.host, h.changed)
    noteBlockedNavigation(null, 'blocker')
    noteBlockedNavigation(h.host.webContentsId, 'https-upgrade')
    failLoad(h, -20, 'https://example.com/')
    expect(watch.current?.source).toBeUndefined()
  })

  it('is fed by the request pipeline for a refused main frame, and only for one', () => {
    const onBlockedNavigation = vi.fn()
    let listener: ((details: unknown, callback: (r: unknown) => void) => void) | null = null
    // The fake only needs the surface the installer touches.
    const session = {
      webRequest: {
        onBeforeRequest: (registered: typeof listener) => {
          listener = registered
        }
      }
    }
    installRequestPipeline({
      session: session as never,
      getSettings: () => defaultSettings(),
      filterEngine: null,
      hooks: { onBlockedNavigation }
    })
    const request = (resourceType: string): void =>
      listener?.(
        {
          url: 'https://safebrowsing.googleapis.com/x',
          resourceType,
          method: 'GET',
          webContentsId: 7
        },
        () => {}
      )
    request('xhr')
    expect(onBlockedNavigation).not.toHaveBeenCalled()
    request('mainFrame')
    expect(onBlockedNavigation).toHaveBeenCalledWith(7, 'telemetry')
  })

  it('still cancels a refused main frame when nobody listens for it', () => {
    let listener: ((details: unknown, callback: (r: unknown) => void) => void) | null = null
    const session = {
      webRequest: {
        onBeforeRequest: (registered: typeof listener) => {
          listener = registered
        }
      }
    }
    installRequestPipeline({
      session: session as never,
      getSettings: () => defaultSettings(),
      filterEngine: null
    })
    const answer = vi.fn()
    // Assigned inside the fake, so the checker cannot see it is set; read it through a helper.
    const fire = (details: unknown, callback: (r: unknown) => void): void =>
      listener?.(details, callback)
    fire(
      {
        url: 'https://safebrowsing.googleapis.com/x',
        resourceType: 'mainFrame',
        method: 'GET',
        webContentsId: 7
      },
      answer
    )
    expect(answer).toHaveBeenCalledWith({ cancel: true })
  })
})
