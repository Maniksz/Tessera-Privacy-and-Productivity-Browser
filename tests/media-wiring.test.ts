import { readFileSync } from 'node:fs'
import { mkdtemp, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { defaultSettings } from '@shared/settings/definitions.js'
import { installRequestPipeline, type ObservedRequest } from '@main/privacy/RequestPipeline.js'
import type { ObservedResponse } from '@main/session/hardening.js'
import { mediaResponseObservation } from '@main/media/observation.js'
import { MediaService, UnknownMediaFindingError } from '@main/media/MediaService.js'
import {
  MediaSessions,
  sessionFetcher,
  tabIdForWebContents,
  type MediaSession,
  type MediaTabHost
} from '@main/media/MediaSessions.js'
import type { MediaFetcher } from '@main/media/fetch.js'
import {
  mediaDownloadReportSchema,
  mediaFindingListSchema,
  mediaManifestReportSchema
} from '@shared/media/schema.js'

/**
 * The wiring, and only the wiring.
 *
 * The detection, the parsers, the plan and the downloader are tested in their own files;
 * nothing here re-tests them. What is under test is the set of decisions that only exist
 * because these pieces were connected to a browser:
 *
 *   - which layer answers "which tab does this web contents belong to", and what happens
 *     when the answer is "none" — a devtools window, a view being torn down, a tab that
 *     closed while a response was in flight;
 *   - that a request the privacy pipeline blocked is never also observed as media, which
 *     is a property of *where* the hook is called and of nothing else;
 *   - that a refusal reaches the caller as a sentence rather than as an enumeration value.
 */

const T0 = 1_700_000_000_000

// --- the pipeline hook ------------------------------------------------------

interface FakeSession {
  registrations: Array<((details: unknown, callback: (response: unknown) => void) => void) | null>
  session: unknown
}

function fakeSession(): FakeSession {
  const registrations: FakeSession['registrations'] = []
  return {
    registrations,
    session: {
      webRequest: {
        onBeforeRequest(listener: unknown) {
          registrations.push(
            listener as ((details: unknown, callback: (response: unknown) => void) => void) | null
          )
        }
      }
    }
  }
}

function installWithObserver(onRequest: (observation: ObservedRequest) => void) {
  const fake = fakeSession()
  installRequestPipeline({
    session: fake.session as never,
    getSettings: () => defaultSettings(),
    filterEngine: null,
    hooks: { onRequest }
  })
  const listener = fake.registrations[0]
  if (listener === null || listener === undefined) throw new Error('no listener registered')
  return listener
}

describe('what the request pipeline hands to an observer', () => {
  it('observes a request the stages let through', () => {
    const onRequest = vi.fn()
    const listener = installWithObserver(onRequest)
    listener(
      {
        url: 'https://example.com/clip.mp4',
        resourceType: 'media',
        method: 'GET',
        webContentsId: 11,
        frame: { url: 'https://example.com/watch' }
      },
      () => {}
    )
    expect(onRequest).toHaveBeenCalledWith({
      url: 'https://example.com/clip.mp4',
      resourceType: 'media',
      documentUrl: 'https://example.com/watch',
      webContentsId: 11
    })
  })

  it('never observes a request the blocker cancelled', () => {
    /*
      The reason the hook is called after the stage loop rather than inside it. A media
      panel offering a download of something the blocker stopped would be the blocker
      failing silently — the request never happens, so the entry could only ever fail.
    */
    const onRequest = vi.fn()
    const listener = installWithObserver(onRequest)
    const callback = vi.fn()
    listener(
      {
        url: 'https://safebrowsing.googleapis.com/clip.mp4',
        resourceType: 'media',
        method: 'GET',
        webContentsId: 11
      },
      callback
    )
    expect(callback).toHaveBeenCalledWith({ cancel: true })
    expect(onRequest).not.toHaveBeenCalled()
  })

  it('never observes the address a stage rewrote, only the one that is fetched', () => {
    const onRequest = vi.fn()
    const listener = installWithObserver(onRequest)
    listener(
      { url: 'https://example.com/watch?utm_source=x', resourceType: 'mainFrame', method: 'GET' },
      () => {}
    )
    expect(onRequest).not.toHaveBeenCalled()

    // The rewritten request comes back round, and that is the one worth recording: it is
    // the address the network will actually be asked for.
    listener(
      { url: 'https://example.com/watch', resourceType: 'mainFrame', method: 'GET' },
      () => {}
    )
    expect(onRequest).toHaveBeenCalledTimes(1)
  })

  it('reports no web contents for a request that belongs to no view', () => {
    // A service worker, or a session-level fetch. Electron simply omits the field.
    const onRequest = vi.fn()
    const listener = installWithObserver(onRequest)
    listener({ url: 'https://example.com/clip.mp4', resourceType: 'xhr', method: 'GET' }, () => {})
    expect(onRequest.mock.calls[0]?.[0]).toMatchObject({ webContentsId: null })
  })
})

// --- the response hook -----------------------------------------------------

function observedResponse(overrides: Partial<ObservedResponse> = {}): ObservedResponse {
  return {
    url: 'https://cdn.example.com/v/9d2f?token=abc',
    resourceType: 'xhr',
    documentUrl: 'https://example.com/watch',
    webContentsId: 11,
    statusCode: 200,
    headers: { 'Content-Type': 'video/mp4', 'Content-Length': '8192' },
    ...overrides
  }
}

describe('what the session hardening hands to an observer', () => {
  it('finds the content type whatever case the server wrote it in', () => {
    for (const name of ['Content-Type', 'content-type', 'CONTENT-TYPE']) {
      const observation = mediaResponseObservation(
        observedResponse({ headers: { [name]: 'video/mp4' } })
      )
      expect(observation.contentType, name).toBe('video/mp4')
    }
  })

  it('keeps the header verbatim and leaves normalising to the registry', () => {
    // One place decides what `video/mp4; codecs="avc1"` means, and it is not this one.
    const observation = mediaResponseObservation(
      observedResponse({ headers: { 'content-type': 'video/mp4; codecs="avc1.42E01E"' } })
    )
    expect(observation.contentType).toBe('video/mp4; codecs="avc1.42E01E"')
  })

  it('takes the first value of a header that was sent twice', () => {
    // Repeated headers arrive newline-joined; only the first can describe the body.
    const observation = mediaResponseObservation(
      observedResponse({ headers: { 'content-type': 'video/mp4\ntext/html' } })
    )
    expect(observation.contentType).toBe('video/mp4')
  })

  it('says nothing rather than guessing when there is no content type', () => {
    const observation = mediaResponseObservation(observedResponse({ headers: {} }))
    expect(observation.contentType).toBeNull()
    expect(observation.contentLength).toBeNull()
  })

  it('reads a content length, and refuses to invent one', () => {
    expect(mediaResponseObservation(observedResponse({})).contentLength).toBe(8192)
    expect(
      mediaResponseObservation(observedResponse({ headers: { 'content-length': 'chunked' } }))
        .contentLength
    ).toBeNull()
  })

  it('reports the size of the whole file, not of the range that arrived', () => {
    /*
      A `<video>` element does not fetch a file, it fetches ranges of one, so the first
      response is a `206` whose `Content-Length` describes a couple of megabytes of a
      two-hour film. Taking it as the size put a plainly wrong number on screen — and a
      different wrong number after every seek, because each range overwrote the last.
    */
    const observation = mediaResponseObservation(
      observedResponse({
        statusCode: 206,
        headers: {
          'content-type': 'video/mp4',
          'content-length': '1048576',
          'Content-Range': 'bytes 0-1048575/734003200'
        }
      })
    )
    expect(observation.contentLength).toBe(734_003_200)
  })

  it('says nothing when a partial response will not name the total', () => {
    // `bytes 0-1023/*` is a server that declines to say. "Unknown" is a state the panel can
    // render; a confidently wrong size is not.
    for (const range of ['bytes 0-1023/*', 'nonsense']) {
      const observation = mediaResponseObservation(
        observedResponse({
          statusCode: 206,
          headers: { 'content-length': '1024', 'content-range': range }
        })
      )
      expect(observation.contentLength, range).toBeNull()
    }
    expect(
      mediaResponseObservation(
        observedResponse({ statusCode: 206, headers: { 'content-length': '1024' } })
      ).contentLength
    ).toBeNull()
  })

  it('carries the status and the web contents through untouched', () => {
    const observation = mediaResponseObservation(
      observedResponse({ statusCode: 404, webContentsId: null })
    )
    expect(observation).toMatchObject({ statusCode: 404, webContentsId: null })
  })
})

// --- tab resolution --------------------------------------------------------

function windowWith(tabs: Readonly<Record<number, string>>): MediaTabHost {
  return {
    tabForWebContents: (id) => {
      const tabId = tabs[id]
      return tabId === undefined ? undefined : { id: tabId }
    }
  }
}

describe('which tab a web contents belongs to', () => {
  const first = windowWith({ 11: 'tab-1', 12: 'tab-2' })
  const second = windowWith({ 21: 'tab-9' })

  it('asks every window, because a session serves more than one', () => {
    expect(tabIdForWebContents([first, second], 21)).toBe('tab-9')
    expect(tabIdForWebContents([first, second], 12)).toBe('tab-2')
  })

  it('answers null for a request with no web contents at all', () => {
    expect(tabIdForWebContents([first], null)).toBeNull()
  })

  it('answers null for a view no window claims', () => {
    // Devtools, the chrome UI itself, an extension background page. None of them is a tab,
    // and attributing their traffic to a guess would put a stranger's video in a panel.
    expect(tabIdForWebContents([first, second], 99)).toBeNull()
  })

  it('answers null once the view is destroyed, so a late response is dropped', () => {
    /*
      The case a tab close creates: the response arrives after the view is gone.
      `BrowserWindowController.tabForWebContents` skips destroyed contents, so the answer
      is "no tab" — and the observation is dropped rather than recorded against a tab id
      that will never be listed again.
    */
    const closing = windowWith({})
    expect(tabIdForWebContents([closing], 11)).toBeNull()
  })

  it('resolves tabs without reaching for Electron', () => {
    /*
      The rule this protects, stated in `MediaRegistry`: the store is fed, it does not
      subscribe. A registry that called `webContents.fromId` itself would be a data
      structure that needs a running browser to test, and it would still answer for views
      that are not tabs.
    */
    for (const path of ['src/main/media/MediaRegistry.ts', 'src/main/media/MediaService.ts']) {
      const source = readFileSync(join(process.cwd(), path), 'utf8')
      expect(source, path).not.toMatch(/from 'electron'/)
    }
    // The one file that names Electron's session does so as a type, which is erased.
    const sessions = readFileSync(join(process.cwd(), 'src/main/media/MediaSessions.ts'), 'utf8')
    expect(sessions).toMatch(/import type \{ Session \} from 'electron'/)
  })
})

// --- the service -----------------------------------------------------------

interface ServiceHarness {
  service: MediaService
  requests: string[]
  answer(responder: (url: string) => Response): void
  directory: string
}

async function harness(
  options: { tabs?: Readonly<Record<number, string>>; fetcher?: MediaFetcher } = {}
): Promise<ServiceHarness> {
  const root = await mkdtemp(join(tmpdir(), 'tessera-media-wiring-'))
  const requests: string[] = []
  let responder: (url: string) => Response = () => new Response('', { status: 404 })
  const hosts = [windowWith(options.tabs ?? { 11: 'tab-1', 22: 'tab-2' })]

  const service = new MediaService({
    fetch:
      options.fetcher ??
      ((url) => {
        requests.push(url)
        return Promise.resolve(responder(url))
      }),
    now: () => T0,
    directory: () => root,
    resolveTabId: (id) => tabIdForWebContents(hosts, id)
  })

  return {
    service,
    requests,
    directory: root,
    answer: (next) => {
      responder = next
    }
  }
}

function request(overrides: Partial<ObservedRequest> = {}): ObservedRequest {
  return {
    url: 'https://example.com/clip.mp4',
    resourceType: 'media',
    documentUrl: 'https://example.com/watch',
    webContentsId: 11,
    ...overrides
  }
}

describe('observing traffic through the service', () => {
  it('folds a request and its response into one finding for the tab that asked', async () => {
    const world = await harness()
    world.service.observeRequest(request({ url: 'https://cdn.example.com/v/9d2f' }))
    // Nothing yet: an extension-less address says nothing until its headers arrive.
    expect(world.service.list('tab-1').findings).toEqual([])

    world.service.observeResponse(observedResponse({ url: 'https://cdn.example.com/v/9d2f' }))
    const { tabId, findings } = world.service.list('tab-1')
    expect(tabId).toBe('tab-1')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({
      tabId: 'tab-1',
      kind: 'progressive',
      container: 'mp4',
      byteLength: 8192,
      documentUrl: 'https://example.com/watch'
    })
  })

  it('drops a response whose tab is gone', async () => {
    // The tab closed while the response was in flight. There is no tab to list it under,
    // and inventing one would keep a closed page's addresses in memory.
    const world = await harness({ tabs: {} })
    world.service.observeResponse(observedResponse())
    expect(world.service.list('tab-1').findings).toEqual([])
  })

  it('never records what the pipeline blocked', async () => {
    /*
      The two halves connected: the pipeline decides, the service observes what survived.
      `safebrowsing.googleapis.com` is on the telemetry list, so the request is cancelled
      and the hook is never called — the address ending in `.mp4` makes no difference.
    */
    const world = await harness()
    const listener = installWithObserver((observation) => {
      world.service.observeRequest(observation)
    })
    listener(
      {
        url: 'https://safebrowsing.googleapis.com/clip.mp4',
        resourceType: 'media',
        method: 'GET',
        webContentsId: 11
      },
      () => {}
    )
    listener(
      {
        url: 'https://example.com/other.mp4',
        resourceType: 'media',
        method: 'GET',
        webContentsId: 11
      },
      () => {}
    )
    expect(world.service.list('tab-1').findings.map((one) => one.label)).toEqual(['other.mp4'])
  })

  it("forgets a tab's findings when it navigates and when it closes", async () => {
    const world = await harness()
    world.service.observeRequest(request())
    expect(world.service.list('tab-1').findings).toHaveLength(1)

    world.service.observeRequest(request({ resourceType: 'mainFrame', url: 'https://elsewhere/' }))
    expect(world.service.list('tab-1').findings).toEqual([])

    world.service.observeRequest(request())
    world.service.forgetTab('tab-1')
    expect(world.service.list('tab-1').findings).toEqual([])
  })

  it('publishes a change for the tab it happened in', async () => {
    const world = await harness()
    const seen: string[] = []
    const stop = world.service.onChange((list) => seen.push(list.tabId))
    world.service.observeRequest(request({ webContentsId: 22 }))
    stop()
    world.service.observeRequest(request({ url: 'https://example.com/second.mp4' }))
    expect(seen).toEqual(['tab-2'])
  })
})

describe('describing a manifest through the service', () => {
  async function withPlaylist(body: string, contentType = 'application/x-mpegurl') {
    const world = await harness()
    world.answer(() => new Response(body, { headers: { 'content-type': contentType } }))
    world.service.observeResponse(
      observedResponse({
        url: 'https://example.com/hls/master.m3u8',
        headers: { 'content-type': contentType }
      })
    )
    const finding = world.service.list('tab-1').findings[0]
    if (finding === undefined) throw new Error('expected a finding')
    return { world, finding }
  }

  it('says why a manifest could not be read, in the language the caller asked for', async () => {
    const { world, finding } = await withPlaylist('<html>login required</html>')
    const english = await world.service.describe('tab-1', finding.id, 'en')
    expect(english.manifest).toMatchObject({ status: 'failed', reason: 'not-a-manifest' })
    expect(english.message).toContain('not a playlist')
    // Not the code, in either language.
    expect(english.message).not.toContain('not-a-manifest')

    const { world: other, finding: second } = await withPlaylist('<html>login required</html>')
    const german = await other.service.describe('tab-1', second.id, 'de')
    expect(german.message).not.toBe(english.message)
  })

  it('has nothing to explain for a manifest that read cleanly', async () => {
    const { world, finding } = await withPlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480\n480p.m3u8\n'
    )
    const report = await world.service.describe('tab-1', finding.id, 'en')
    expect(report.manifest).toMatchObject({ status: 'ready' })
    expect(report.message).toBeNull()
  })

  it('has no manifest and no message for a progressive file', async () => {
    const world = await harness()
    world.service.observeResponse(observedResponse())
    const finding = world.service.list('tab-1').findings[0]!
    expect(await world.service.describe('tab-1', finding.id, 'en')).toEqual({
      manifest: null,
      message: null
    })
    expect(world.requests).toEqual([])
  })
})

describe('downloading through the service', () => {
  function progressiveFinding(world: ServiceHarness) {
    world.service.observeResponse(observedResponse({ url: 'https://example.com/clip.mp4' }))
    const finding = world.service.list('tab-1').findings[0]
    if (finding === undefined) throw new Error('expected a finding')
    return finding
  }

  it('writes the file and reports where it went', async () => {
    const world = await harness()
    world.answer(() => new Response('video-bytes'))
    const finding = progressiveFinding(world)

    const report = await world.service.download('tab-1', finding.id, null, 'en')
    expect(report.ok).toBe(true)
    expect(await readdir(world.directory)).toEqual(['clip.mp4'])
  })

  it('reports a refusal as a sentence and keeps the code beside it', async () => {
    /*
      The property this whole layer exists for. A DASH stream is single-track by
      construction, so there is nothing concatenation can produce — and what the user needs
      to be told is that, not `dash-needs-muxer`.
    */
    const world = await harness()
    world.service.observeResponse(
      observedResponse({
        url: 'https://example.com/dash/manifest.mpd',
        headers: { 'content-type': 'application/dash+xml' }
      })
    )
    const finding = world.service.list('tab-1').findings[0]!

    const report = await world.service.download('tab-1', finding.id, null, 'en')
    if (report.ok) throw new Error('expected a refusal')
    expect(report.refusal).toBe('dash-needs-muxer')
    expect(report.message).toMatch(/converter/)
    expect(report.message).not.toContain('dash-needs-muxer')
    // The diagnostic survives too, for whoever has to work out why.
    expect(report.detail).toContain('single-track')

    const german = await world.service.download('tab-1', finding.id, null, 'de')
    if (german.ok) throw new Error('expected a refusal')
    expect(german.message).not.toBe(report.message)
  })

  it('throws for a finding the tab does not have, rather than inventing a refusal', async () => {
    // Every refusal is a decision about media that exists. "You named something that is
    // not here" is a race — the tab navigated mid-click — and answering it with a sentence
    // about encryption would be a lie.
    const world = await harness()
    await expect(world.service.download('tab-1', 'media-99', null, 'en')).rejects.toThrow(
      UnknownMediaFindingError
    )
  })

  it('joins a second request for the same finding instead of racing it', async () => {
    /*
      Two clicks on one button used to mean two downloads writing into the same `.part`
      file, interleaving their bytes, both succeeding. The user got one corrupt file and no
      error at all.
    */
    const world = await harness()
    world.answer(() => new Response('video-bytes'))
    const finding = progressiveFinding(world)

    const [first, second] = await Promise.all([
      world.service.download('tab-1', finding.id, null, 'en'),
      world.service.download('tab-1', finding.id, null, 'en')
    ])
    expect(first).toBe(second)
    expect(await readdir(world.directory)).toEqual(['clip.mp4'])
  })

  it('stops a download that is running and says so', async () => {
    let abortRequested = (): void => {}
    const world = await harness({
      fetcher: (_url, init) =>
        new Promise((_resolve, reject) => {
          abortRequested = () => reject(new Error('aborted'))
          init?.signal?.addEventListener('abort', abortRequested)
        })
    })
    const finding = progressiveFinding(world)

    const running = world.service.download('tab-1', finding.id, null, 'en')
    expect(world.service.cancel(finding.id)).toBe(true)
    const report = await running
    if (report.ok) throw new Error('expected a refusal')
    expect(report.refusal).toBe('cancelled')
    expect(report.message).not.toContain('cancelled')
    // Nothing half-written left behind.
    expect(await readdir(world.directory)).toEqual([])
  })

  it('shrugs when there is nothing to stop', async () => {
    // The user pressing stop as a download finishes is a race the interface must not have
    // to win.
    const world = await harness()
    expect(world.service.cancel('media-1')).toBe(false)
  })
})

// --- one service per session ----------------------------------------------

function spySession(body: string): MediaSession & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: (url) => {
      calls.push(url)
      return Promise.resolve(
        new Response(body, { headers: { 'content-type': 'application/x-mpegurl' } })
      )
    }
  }
}

const MEDIA_PLAYLIST = '#EXTM3U\n#EXTINF:4.0,\none.ts\n#EXT-X-ENDLIST\n'

describe('one media service per browsing session', () => {
  function sessions(hosts: readonly MediaTabHost[]) {
    return new MediaSessions({ hosts: () => hosts, directory: () => tmpdir(), now: () => T0 })
  }

  it('hands back the same service for the same session', () => {
    const registry = sessions([windowWith({ 11: 'tab-1' })])
    const session = spySession(MEDIA_PLAYLIST)
    expect(registry.forSession(session)).toBe(registry.forSession(session))
    expect(registry.size).toBe(1)
  })

  it('reads the clock itself when the wiring does not supply one', () => {
    // The production wiring passes no clock; only tests do, so the default is the path that
    // actually runs and it has to be the one that is exercised.
    const registry = new MediaSessions({
      hosts: () => [windowWith({ 11: 'tab-1' })],
      directory: () => tmpdir()
    })
    const service = registry.forSession(spySession(MEDIA_PLAYLIST))
    service.observeRequest(request())
    const [finding] = service.list('tab-1').findings.slice(0, 1)
    expect(finding?.discoveredAt).toBeGreaterThan(T0)
  })

  it('reads a private tab’s playlist through that tab’s own session', async () => {
    /*
      The reason this is per session rather than one registry for the browser. Fetching a
      private window's playlist through the default session would send that profile's
      cookies to a host the user deliberately visited in a window whose entire purpose is
      that it cannot be linked to them — and it would usually also fail, so the bug would
      be reported as "downloads do not work in private windows" and fixed with the leak
      still in place.
    */
    const registry = sessions([windowWith({ 11: 'tab-1', 22: 'tab-2' })])
    const normal = spySession(MEDIA_PLAYLIST)
    const priv = spySession(MEDIA_PLAYLIST)

    const privateService = registry.forSession(priv)
    privateService.observeResponse(
      observedResponse({
        url: 'https://example.com/private.m3u8',
        webContentsId: 22,
        headers: { 'content-type': 'application/x-mpegurl' }
      })
    )
    const finding = privateService.list('tab-2').findings[0]!
    await privateService.describe('tab-2', finding.id, 'en')

    expect(priv.calls).toEqual(['https://example.com/private.m3u8'])
    expect(normal.calls).toEqual([])
    expect(registry.forSession(normal).list('tab-2').findings).toEqual([])
  })

  it('fans changes in from every session, including ones created later', () => {
    const registry = sessions([windowWith({ 11: 'tab-1' })])
    const seen: string[] = []
    const stop = registry.onChange((list) => seen.push(list.tabId))

    // Created after the subscription: a window is opened long after the first session
    // exists, and a subscriber that had to be told about each new one would miss them.
    const service = registry.forSession(spySession(MEDIA_PLAYLIST))
    service.observeRequest(request())
    stop()
    service.observeRequest(request({ url: 'https://example.com/second.mp4' }))
    expect(seen).toEqual(['tab-1'])
  })

  it('forgets a closed tab in whichever session held it', () => {
    const registry = sessions([windowWith({ 11: 'tab-1', 22: 'tab-2' })])
    const one = registry.forSession(spySession(MEDIA_PLAYLIST))
    const two = registry.forSession(spySession(MEDIA_PLAYLIST))
    one.observeRequest(request({ webContentsId: 11 }))
    two.observeRequest(request({ webContentsId: 22 }))

    // The caller knows a tab id, not a session; tab ids are unique across the browser, so
    // asking every service is safe and at most one has anything to forget.
    registry.forgetTab('tab-2')
    expect(one.list('tab-1').findings).toHaveLength(1)
    expect(two.list('tab-2').findings).toEqual([])
  })

  it('drops a session’s findings when the session is released', () => {
    // A private session's findings name the addresses a page fetched, which is browsing
    // history by another route. They go when its window does, at a moment something
    // decides — not whenever a collector gets round to it.
    const registry = sessions([windowWith({ 11: 'tab-1' })])
    const session = spySession(MEDIA_PLAYLIST)
    const service = registry.forSession(session)
    service.observeRequest(request())

    registry.release(session)
    expect(registry.size).toBe(0)
    expect(registry.forSession(session).list('tab-1').findings).toEqual([])
  })
})

describe('retrieval bound to a session', () => {
  it('passes a range header and an abort signal through', async () => {
    const seen: Array<{ url: string; init: unknown }> = []
    const fetcher = sessionFetcher({
      fetch: (url, init) => {
        seen.push({ url, init })
        return Promise.resolve(new Response(''))
      }
    })
    const controller = new AbortController()
    await fetcher('https://example.com/one.ts', {
      headers: { Range: 'bytes=0-99' },
      signal: controller.signal
    })
    expect(seen[0]).toMatchObject({
      url: 'https://example.com/one.ts',
      init: { headers: { Range: 'bytes=0-99' }, signal: controller.signal }
    })
  })

  it('sends no keys at all when there is nothing to send', async () => {
    // `exactOptionalPropertyTypes` treats an absent field and one holding `undefined` as
    // different types, and a fetch layer handed the second can turn it into a header named
    // "undefined".
    const seen: unknown[] = []
    const fetcher = sessionFetcher({
      fetch: (_url, init) => {
        seen.push(init)
        return Promise.resolve(new Response(''))
      }
    })
    await fetcher('https://example.com/master.m3u8')
    expect(Object.keys(seen[0] as object)).toEqual([])
  })
})

describe('what the handlers answer with survives the contract', () => {
  /*
    The router validates responses in development. So a handler returning a shape its
    schema does not describe does not produce a wrong value in the interface — it produces a
    rejected invoke, in development only, which is a failure that reaches whoever is working
    and nobody else. These are the three shapes the media channels answer with, parsed by
    the schemas the contract uses.
  */
  it('accepts a finding list straight out of the service', async () => {
    const world = await harness()
    world.service.observeResponse(observedResponse())
    const parsed = mediaFindingListSchema.safeParse(world.service.list('tab-1'))
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('accepts a manifest report, ready and failed alike', async () => {
    const world = await harness()
    world.answer(
      () => new Response(MEDIA_PLAYLIST, { headers: { 'content-type': 'application/x-mpegurl' } })
    )
    world.service.observeResponse(
      observedResponse({
        url: 'https://example.com/hls/media.m3u8',
        headers: { 'content-type': 'application/x-mpegurl' }
      })
    )
    const [finding] = world.service.list('tab-1').findings.slice(0, 1)
    const ready = await world.service.describe('tab-1', finding!.id, 'en')
    expect(mediaManifestReportSchema.safeParse(ready).success).toBe(true)
    // And the state a finding sits in before anyone asks, which is a different member of
    // the union.
    await world.service.whenIdle()
    expect(
      mediaManifestReportSchema.safeParse({ manifest: { status: 'not-loaded' }, message: null })
        .success
    ).toBe(true)
  })

  it('accepts a refusal and rejects a code that is not one', async () => {
    const world = await harness()
    world.service.observeResponse(
      observedResponse({
        url: 'https://example.com/dash/manifest.mpd',
        headers: { 'content-type': 'application/dash+xml' }
      })
    )
    const [finding] = world.service.list('tab-1').findings.slice(0, 1)
    const report = await world.service.download('tab-1', finding!.id, null, 'en')
    expect(mediaDownloadReportSchema.safeParse(report).success).toBe(true)

    // The enumeration is built from `DOWNLOAD_REFUSALS` rather than restated, which is what
    // makes this fail rather than pass silently.
    expect(
      mediaDownloadReportSchema.safeParse({
        ok: false,
        refusal: 'needs-a-muxer',
        message: 'x',
        detail: 'y'
      }).success
    ).toBe(false)
  })
})
