import { tmpdir } from 'node:os'
import type { IpcMainInvokeEvent } from 'electron'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Locale } from '@shared/i18n/catalog.js'
import type { MediaFindingList } from '@shared/media/wire.js'
import {
  registerMediaHandlers,
  type MediaHandle,
  type MediaHandlerTab,
  type MediaHandlerWindow
} from '@main/ipc/media-handlers.js'
import { MediaSessions, type MediaSession, type MediaTabHost } from '@main/media/MediaSessions.js'
import type { ObservedResponse } from '@main/session/hardening.js'

/**
 * The `media:*` handler bodies.
 *
 * Reachable by a test at all because `registerMediaHandlers` is handed its registrar
 * rather than importing `ipc/router.ts`, which imports `ipcMain` and therefore only
 * exists inside a running Electron process. That is the whole reason these channels live
 * in their own file: what they do — resolve a tab, pick the session that tab browses in,
 * translate a refusal — is decision-making, and `handlers.ts` has no tests at all.
 */

const T0 = 1_700_000_000_000

/** A `Session`-shaped fetcher that records what it was asked for. */
function spySession(body: string, contentType: string): MediaSession & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: (url) => {
      calls.push(url)
      return Promise.resolve(new Response(body, { headers: { 'content-type': contentType } }))
    }
  }
}

function tab(id: string, session: MediaSession): MediaHandlerTab {
  return { id, view: { webContents: { session } } }
}

interface FakeWindow extends MediaHandlerWindow {
  readonly emitted: MediaFindingList[]
}

function fakeWindow(tabs: readonly MediaHandlerTab[]): FakeWindow {
  const emitted: MediaFindingList[] = []
  const [active] = tabs.slice(0, 1)
  return {
    emitted,
    resolveTab: (tabId) =>
      tabId === undefined ? active : tabs.find((candidate) => candidate.id === tabId),
    tab: (tabId) => tabs.find((candidate) => candidate.id === tabId),
    emit: (_channel, payload) => {
      emitted.push(payload)
    }
  }
}

/** The hosts the registry walks to attribute a request; keyed the way the real one is. */
function hostFor(tabsByContents: Readonly<Record<number, string>>): MediaTabHost {
  return {
    tabForWebContents: (id) => {
      const found = tabsByContents[id]
      return found === undefined ? undefined : { id: found }
    }
  }
}

function observedResponse(overrides: Partial<ObservedResponse> = {}): ObservedResponse {
  return {
    url: 'https://example.com/clip.mp4',
    resourceType: 'media',
    documentUrl: 'https://example.com/watch',
    webContentsId: 11,
    statusCode: 200,
    headers: { 'content-type': 'video/mp4', 'content-length': '2048' },
    ...overrides
  }
}

/** No handler here touches the event beyond passing it to `windows.resolve`. */
const NO_EVENT = undefined as unknown as IpcMainInvokeEvent

type AnyHandler = (payload: never, event: IpcMainInvokeEvent) => unknown

interface Harness {
  readonly channels: string[]
  readonly media: MediaSessions
  readonly windows: FakeWindow[]
  locale: Locale
  invoke(channel: string, payload: unknown): Promise<unknown>
  resolvesWindow: boolean
}

function harness(options: { windows: FakeWindow[]; hosts: readonly MediaTabHost[] }): Harness {
  const handlers = new Map<string, AnyHandler>()
  const channels: string[] = []
  const handle: MediaHandle = (channel, handler) => {
    channels.push(channel)
    handlers.set(channel, handler)
  }

  const media = new MediaSessions({
    hosts: () => options.hosts,
    directory: () => tmpdir(),
    now: () => T0
  })

  const state: Harness = {
    channels,
    media,
    windows: options.windows,
    locale: 'en',
    resolvesWindow: true,
    /*
      Deferred by one turn, the way `ipcMain.handle` does it: a handler that throws has to
      arrive as a rejected promise, because that is what the renderer sees. A synchronous
      throw here would test the harness rather than the handler.
    */
    invoke: (channel, payload) =>
      Promise.resolve().then(() => {
        const handler = handlers.get(channel)
        if (handler === undefined) throw new Error(`no handler for ${channel}`)
        return handler(payload as never, NO_EVENT)
      })
  }

  registerMediaHandlers({
    handle,
    media,
    windows: {
      // One window per test in almost every case; the multi-window case is about which one
      // an event reaches, not about which one a request came from.
      resolve: () => (state.resolvesWindow ? options.windows[0] : undefined),
      get controllers() {
        return options.windows
      }
    },
    locale: () => state.locale
  })

  return state
}

describe('the media channels', () => {
  let session: MediaSession & { calls: string[] }
  let world: Harness

  beforeEach(() => {
    session = spySession('video-bytes', 'video/mp4')
    world = harness({
      windows: [fakeWindow([tab('tab-1', session), tab('tab-2', session)])],
      hosts: [hostFor({ 11: 'tab-1', 22: 'tab-2' })]
    })
  })

  it('registers exactly the four operations the panel needs', () => {
    expect(world.channels).toEqual([
      'media:list',
      'media:describe',
      'media:download',
      'media:cancel'
    ])
  })

  it('lists the tab in the active tile when the request names none', async () => {
    // The same default the navigation channels use. A panel that had to track which tab is
    // active would be a second copy of state the core already owns.
    world.media.forSession(session).observeResponse(observedResponse())
    expect(await world.invoke('media:list', {})).toMatchObject({
      tabId: 'tab-1',
      findings: [{ label: 'clip.mp4', container: 'mp4' }]
    })
  })

  it('lists the tab the request names', async () => {
    world.media.forSession(session).observeResponse(observedResponse({ webContentsId: 22 }))
    expect(await world.invoke('media:list', { tabId: 'tab-2' })).toMatchObject({
      tabId: 'tab-2',
      findings: [{ tabId: 'tab-2' }]
    })
    expect(await world.invoke('media:list', { tabId: 'tab-1' })).toMatchObject({ findings: [] })
  })

  it('refuses a call from a renderer that belongs to no window', async () => {
    world.resolvesWindow = false
    await expect(world.invoke('media:list', {})).rejects.toThrow(/No window/)
  })

  it('refuses a tab id this window does not hold', async () => {
    /*
      Rejected rather than answered with an empty list. "This page is playing nothing" and
      "the tab you named is gone" are different statements, and only the second tells a
      panel to reload itself rather than sit there showing nothing.
    */
    await expect(world.invoke('media:list', { tabId: 'tab-9' })).rejects.toThrow(/No tab/)
  })

  it('reads a manifest through the session the tab browses in', async () => {
    const playlist = spySession(
      '#EXTM3U\n#EXTINF:4.0,\none.ts\n#EXT-X-ENDLIST\n',
      'application/x-mpegurl'
    )
    const world = harness({
      windows: [fakeWindow([tab('tab-1', playlist)])],
      hosts: [hostFor({ 11: 'tab-1' })]
    })
    world.media.forSession(playlist).observeResponse(
      observedResponse({
        url: 'https://example.com/hls/media.m3u8',
        headers: { 'content-type': 'application/x-mpegurl' }
      })
    )
    const listed = (await world.invoke('media:list', {})) as MediaFindingList
    const finding = listed.findings[0]!

    const report = await world.invoke('media:describe', { findingId: finding.id })
    expect(report).toMatchObject({ manifest: { status: 'ready' }, message: null })
    // Through the tab's own session, which is what keeps a private window's request out of
    // the default session's cookie jar.
    expect(playlist.calls).toEqual(['https://example.com/hls/media.m3u8'])
  })

  it('turns a refusal into a sentence on its way to the renderer', async () => {
    const dash = spySession('<MPD/>', 'application/dash+xml')
    const world = harness({
      windows: [fakeWindow([tab('tab-1', dash)])],
      hosts: [hostFor({ 11: 'tab-1' })]
    })
    world.media.forSession(dash).observeResponse(
      observedResponse({
        url: 'https://example.com/dash/manifest.mpd',
        headers: { 'content-type': 'application/dash+xml' }
      })
    )
    const listed = (await world.invoke('media:list', {})) as MediaFindingList
    const finding = listed.findings[0]!

    const english = await world.invoke('media:download', { findingId: finding.id })
    expect(english).toMatchObject({ ok: false, refusal: 'dash-needs-muxer' })
    const message = (english as { message: string }).message
    expect(message).not.toContain('dash-needs-muxer')
    expect(message.length).toBeGreaterThan(20)

    // The locale is read per call, so a language change reaches the next refusal rather
    // than the next restart.
    world.locale = 'de'
    const german = await world.invoke('media:download', { findingId: finding.id })
    expect((german as { message: string }).message).not.toBe(message)
  })

  it('reports whether there was a download to stop', async () => {
    // A user pressing stop as a download finishes is a race the interface must not lose.
    expect(await world.invoke('media:cancel', { findingId: 'media-1' })).toEqual({ stopped: false })
  })

  it('pushes a change only to the window that owns the tab', () => {
    const other = fakeWindow([tab('tab-7', session)])
    const world = harness({
      windows: [fakeWindow([tab('tab-1', session)]), other],
      hosts: [hostFor({ 11: 'tab-1' })]
    })
    world.media.forSession(session).observeResponse(observedResponse())

    expect(world.windows[0]!.emitted).toHaveLength(1)
    expect(world.windows[0]!.emitted[0]).toMatchObject({ tabId: 'tab-1' })
    // A finding list names the addresses a page fetched. There is no reason for a second
    // window to be told.
    expect(other.emitted).toEqual([])
  })
})
