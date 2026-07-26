import { describe, expect, it } from 'vitest'
import {
  MediaRegistry,
  type MediaRequestObservation,
  type MediaResponseObservation
} from '@main/media/MediaRegistry.js'
import type { MediaFetcher } from '@main/media/fetch.js'
import type { MediaFinding } from '@shared/media/model.js'

/**
 * The registry: what each tab is playing, from the traffic the browser already
 * makes.
 *
 * Nothing here touches the network or the real clock. The fetcher is injected,
 * which is the same seam that keeps Electron's session-bound retrieval — and
 * therefore the proxy, the DNS settings, the request pipeline and the kill switch —
 * in the picture in production. A test that reached the network would be testing
 * the leak rather than the feature.
 *
 * The observations are shaped exactly as the hook in
 * `src/main/privacy/RequestPipeline.ts` hands them over, so these tests double as
 * the specification of that hook.
 */

const T0 = 1_700_000_000_000

/** A page in tab-1, one in tab-2. Four tiles is the case this exists for. */
const TAB_BY_CONTENTS: Readonly<Record<number, string>> = { 11: 'tab-1', 22: 'tab-2' }

interface Harness {
  registry: MediaRegistry
  requests: string[]
  answer(responder: (url: string) => Response): void
  request(observation: Partial<MediaRequestObservation>): void
  respond(observation: Partial<MediaResponseObservation>): void
  changes: Array<{ tabId: string; ids: string[] }>
}

function harness(options: { maxFindingsPerTab?: number; maxManifestBytes?: number } = {}): Harness {
  const requests: string[] = []
  let responder: (url: string) => Response = () => new Response('', { status: 404 })

  const fetcher: MediaFetcher = (url) => {
    requests.push(url)
    return Promise.resolve(responder(url))
  }

  const registry = new MediaRegistry({
    fetch: fetcher,
    now: () => T0,
    resolveTabId: (id) => (id === null ? null : (TAB_BY_CONTENTS[id] ?? null)),
    ...(options.maxFindingsPerTab === undefined
      ? {}
      : { maxFindingsPerTab: options.maxFindingsPerTab }),
    ...(options.maxManifestBytes === undefined
      ? {}
      : { maxManifestBytes: options.maxManifestBytes })
  })

  const changes: Array<{ tabId: string; ids: string[] }> = []
  registry.onChange((tabId, findings) => {
    changes.push({ tabId, ids: findings.map((one) => one.id) })
  })

  return {
    registry,
    requests,
    changes,
    answer: (next) => {
      responder = next
    },
    request: (observation) =>
      registry.observeRequest({
        url: 'https://example.com/clip.mp4',
        resourceType: 'media',
        documentUrl: 'https://example.com/watch',
        webContentsId: 11,
        ...observation
      }),
    respond: (observation) =>
      registry.observeResponse({
        url: 'https://example.com/clip.mp4',
        resourceType: 'media',
        documentUrl: 'https://example.com/watch',
        webContentsId: 11,
        contentType: 'video/mp4',
        contentLength: 4096,
        statusCode: 200,
        ...observation
      })
  }
}

function playlistResponse(body: string, contentType = 'application/x-mpegurl'): Response {
  return new Response(body, { headers: { 'content-type': contentType } })
}

const MASTER = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
`

/** RFC 8216 §8.6's shape: video variants plus a separate audio rendition. */
const MASTER_WITH_ALTERNATIVE_AUDIO = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,LANGUAGE="en",URI="main/english-audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480,AUDIO="aac"
low/video-only.m3u8
`

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
first.ts
#EXTINF:3.003,
second.ts
#EXT-X-ENDLIST
`

describe('attributing findings to tabs', () => {
  it('records a progressive file for the tab that asked for it', () => {
    const world = harness()
    world.request({})

    const found = world.registry.findingsFor('tab-1')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({
      tabId: 'tab-1',
      url: 'https://example.com/clip.mp4',
      kind: 'progressive',
      container: 'mp4',
      label: 'clip.mp4',
      discoveredAt: T0,
      documentUrl: 'https://example.com/watch',
      manifest: null
    })
    expect(world.registry.findingsFor('tab-2')).toEqual([])
  })

  it('keeps four tiles playing four videos apart', () => {
    const world = harness()
    world.request({ webContentsId: 11, url: 'https://a.example/one.mp4' })
    world.request({ webContentsId: 22, url: 'https://b.example/two.mp4' })

    expect(world.registry.findingsFor('tab-1').map((one) => one.url)).toEqual([
      'https://a.example/one.mp4'
    ])
    expect(world.registry.findingsFor('tab-2').map((one) => one.url)).toEqual([
      'https://b.example/two.mp4'
    ])
  })

  it('drops a request that belongs to no known tab', () => {
    // A devtools window, or a view being torn down. Attributing it to a guess
    // would put a stranger's video in somebody's panel.
    const world = harness()
    world.request({ webContentsId: 99 })
    world.request({ webContentsId: null })
    expect(world.changes).toEqual([])
  })

  it('counts an observation that threw rather than letting it escape', () => {
    // This runs inside `onBeforeRequest`, before a callback the page is waiting
    // on. An exception there would look like a page that never loads.
    const registry = new MediaRegistry({
      fetch: () => Promise.reject(new Error('never called')),
      now: () => T0,
      resolveTabId: () => {
        throw new Error('the tab registry blew up')
      }
    })
    expect(() =>
      registry.observeRequest({
        url: 'https://example.com/clip.mp4',
        resourceType: 'media',
        documentUrl: null,
        webContentsId: 11
      })
    ).not.toThrow()
    expect(registry.diagnostics.failedObservations).toBe(1)
  })
})

describe('learning from response headers', () => {
  it('recognises an extension-less address from its content type', () => {
    // The ordinary case, not the exception: a CDN address with no extension whose
    // `Content-Type` is the only statement of what the bytes are.
    const world = harness()
    const url = 'https://cdn.example.com/v/9d2f?token=abc'
    world.request({ url })
    expect(world.registry.findingsFor('tab-1')).toEqual([])

    world.respond({ url, contentType: 'video/mp4; codecs="avc1.42E01E"', contentLength: 8192 })
    expect(world.registry.findingsFor('tab-1')[0]).toMatchObject({
      kind: 'progressive',
      container: 'mp4',
      contentType: 'video/mp4',
      byteLength: 8192
    })
  })

  it('folds the response into the finding the request created', () => {
    const world = harness()
    world.request({})
    world.respond({})
    const found = world.registry.findingsFor('tab-1')
    expect(found).toHaveLength(1)
    expect(found[0]!.byteLength).toBe(4096)
  })

  it('ignores an error response whatever its address ends in', () => {
    const world = harness()
    world.respond({ statusCode: 404, contentType: 'text/html' })
    expect(world.registry.findingsFor('tab-1')).toEqual([])
  })

  it('drops a response that belongs to no known tab', () => {
    const world = harness()
    world.respond({ webContentsId: 99 })
    expect(world.changes).toEqual([])
  })

  it('records a top-level navigation straight to a media file', () => {
    // The request clears the tab, and the response then records what the tab is
    // now showing. Order does the work; no special case needed.
    const world = harness()
    world.request({ resourceType: 'mainFrame' })
    world.respond({ resourceType: 'mainFrame' })
    expect(world.registry.findingsFor('tab-1')).toHaveLength(1)
  })
})

describe('findings and the life of a page', () => {
  it('discards a tab’s findings when it navigates', () => {
    const world = harness()
    world.request({})
    expect(world.registry.findingsFor('tab-1')).toHaveLength(1)

    world.request({ resourceType: 'mainFrame', url: 'https://elsewhere.example/' })
    expect(world.registry.findingsFor('tab-1')).toEqual([])
  })

  it('leaves the other tabs alone when one navigates', () => {
    const world = harness()
    world.request({ webContentsId: 11, url: 'https://a.example/one.mp4' })
    world.request({ webContentsId: 22, url: 'https://b.example/two.mp4' })
    world.request({ webContentsId: 11, resourceType: 'mainFrame', url: 'https://a.example/next' })

    expect(world.registry.findingsFor('tab-1')).toEqual([])
    expect(world.registry.findingsFor('tab-2')).toHaveLength(1)
  })

  it('discards findings when a tab closes', () => {
    const world = harness()
    world.request({})
    world.registry.forgetTab('tab-1')
    expect(world.registry.findingsFor('tab-1')).toEqual([])
  })

  it('says nothing when there was nothing to forget', () => {
    const world = harness()
    world.registry.forgetTab('tab-1')
    expect(world.changes).toEqual([])
  })

  it('notifies once per real change and stays quiet otherwise', () => {
    const world = harness()
    world.request({})
    world.request({})
    world.request({})
    // Three identical observations, one change. Seeking in a player re-requests
    // the same addresses over and over.
    expect(world.changes).toHaveLength(1)
    expect(world.changes[0]!.tabId).toBe('tab-1')
  })

  it('stops notifying once the listener is released', () => {
    const world = harness()
    const seen: string[] = []
    const stop = world.registry.onChange((tabId) => seen.push(tabId))
    world.request({ url: 'https://example.com/a.mp4' })
    stop()
    world.request({ url: 'https://example.com/b.mp4' })
    expect(seen).toEqual(['tab-1'])
  })

  it('holds a tab to its ceiling', () => {
    const world = harness({ maxFindingsPerTab: 2 })
    for (const name of ['a', 'b', 'c']) {
      world.request({ url: `https://example.com/${name}.mp4` })
    }
    expect(world.registry.findingsFor('tab-1').map((one) => one.label)).toEqual(['b.mp4', 'c.mp4'])
  })
})

describe('reading a manifest, on demand', () => {
  function withManifest(
    body: string,
    contentType = 'application/x-mpegurl',
    url = 'https://example.com/hls/master.m3u8'
  ): { harness: Harness; finding: MediaFinding } {
    const world = harness()
    world.answer(() => playlistResponse(body, contentType))
    world.respond({ url, resourceType: 'xhr', contentType, contentLength: null })
    const finding = world.registry.findingsFor('tab-1')[0]
    if (finding === undefined) throw new Error('expected a finding')
    return { harness: world, finding }
  }

  it('does not fetch anything until asked', () => {
    // A second request to an address the page already asked for, for a panel the
    // user may never open, is exactly what a privacy browser should not do
    // speculatively.
    const { harness: world, finding } = withManifest(MASTER)
    expect(world.requests).toEqual([])
    expect(finding.manifest).toEqual({ status: 'not-loaded' })
  })

  it('lists a master playlist’s qualities, best first', async () => {
    const { harness: world, finding } = withManifest(MASTER)
    const manifest = await world.registry.describe('tab-1', finding.id)
    if (manifest?.status !== 'ready') throw new Error(`expected ready, got ${manifest?.status}`)

    expect(world.requests).toEqual(['https://example.com/hls/master.m3u8'])
    expect(manifest.variants.map((one) => [one.height, one.bandwidthBitsPerSecond])).toEqual([
      [1080, 7680000],
      [480, 1280000]
    ])
    expect(manifest.variants.map((one) => one.url)).toEqual([
      'https://example.com/hls/1080p.m3u8',
      'https://example.com/hls/480p.m3u8'
    ])
    expect(manifest.variants.every((one) => one.track === 'muxed')).toBe(true)
    expect(manifest.drm.protected).toBe(false)
    expect(manifest.live).toBe(false)
  })

  it('offers an alternative audio rendition as a quality of its own', async () => {
    // The video variants need a muxer; the audio rendition is self-contained and
    // is one of the few things on such a page that can be downloaded whole.
    const { harness: world, finding } = withManifest(MASTER_WITH_ALTERNATIVE_AUDIO)
    const manifest = await world.registry.describe('tab-1', finding.id)
    if (manifest?.status !== 'ready') throw new Error('expected ready')

    expect(manifest.variants.map((one) => [one.id, one.track])).toEqual([
      ['v0', 'video'],
      ['a0', 'audio']
    ])
    expect(manifest.variants[1]).toMatchObject({
      url: 'https://example.com/hls/main/english-audio.m3u8',
      language: 'en',
      name: 'English'
    })
  })

  it('shows AVERAGE-BANDWIDTH when a variant omits the mandatory BANDWIDTH', async () => {
    const { harness: world, finding } = withManifest(
      '#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1000000\nlow.m3u8\n'
    )
    const manifest = await world.registry.describe('tab-1', finding.id)
    if (manifest?.status !== 'ready') throw new Error('expected ready')
    expect(manifest.variants[0]!.bandwidthBitsPerSecond).toBe(1000000)
  })

  it('reports a media playlist as one quality with a duration', async () => {
    const { harness: world, finding } = withManifest(MEDIA_PLAYLIST)
    const manifest = await world.registry.describe('tab-1', finding.id)
    if (manifest?.status !== 'ready') throw new Error('expected ready')
    // Empty means "one quality, at the finding's own address". Inventing a single
    // variant would put a redundant choice in front of the user.
    expect(manifest.variants).toEqual([])
    expect(manifest.durationSeconds).toBeCloseTo(12.012, 3)
  })

  it('reports encryption without attempting anything', async () => {
    const { harness: world, finding } = withManifest(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="skd://x"
#EXTINF:4.0,
one.ts
#EXT-X-ENDLIST
`)
    const manifest = await world.registry.describe('tab-1', finding.id)
    if (manifest?.status !== 'ready') throw new Error('expected ready')
    expect(manifest.drm).toMatchObject({ protected: true, scheme: 'widevine' })
  })

  it('lists a DASH manifest’s representations', async () => {
    const { harness: world, finding } = withManifest(
      `<MPD type="static" mediaPresentationDuration="PT3M">
        <Period>
          <AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
            <Representation id="v0" width="1280" height="720" bandwidth="2500000"/>
            <Representation id="v1" width="1920" height="1080" bandwidth="4500000"/>
          </AdaptationSet>
          <AdaptationSet mimeType="audio/mp4" lang="de">
            <Representation id="a0" bandwidth="128000"/>
          </AdaptationSet>
        </Period>
      </MPD>`,
      'application/dash+xml',
      'https://example.com/dash/manifest.mpd'
    )
    const manifest = await world.registry.describe('tab-1', finding.id)
    if (manifest?.status !== 'ready') throw new Error('expected ready')

    expect(manifest.variants.map((one) => [one.name, one.height, one.track])).toEqual([
      ['v1', 1080, 'video'],
      ['v0', 720, 'video'],
      ['a0', null, 'audio']
    ])
    // A representation has no single address; saying so beats a URL that leads
    // nowhere.
    expect(manifest.variants.every((one) => one.url === null)).toBe(true)
    expect(manifest.durationSeconds).toBe(180)
  })

  it('reports a manifest that could not be retrieved', async () => {
    const world = harness()
    world.answer(() => new Response('nope', { status: 503 }))
    world.respond({
      url: 'https://example.com/hls/master.m3u8',
      resourceType: 'xhr',
      contentType: 'application/x-mpegurl',
      contentLength: null
    })
    const finding = world.registry.findingsFor('tab-1')[0]!
    expect(await world.registry.describe('tab-1', finding.id)).toEqual({
      status: 'failed',
      reason: 'unreachable',
      detail: 'HTTP 503'
    })
  })

  it('reports a retrieval that threw', async () => {
    const world = harness()
    world.answer(() => {
      throw new Error('net::ERR_CONNECTION_RESET')
    })
    world.respond({
      url: 'https://example.com/hls/master.m3u8',
      resourceType: 'xhr',
      contentType: 'application/x-mpegurl',
      contentLength: null
    })
    const finding = world.registry.findingsFor('tab-1')[0]!
    const manifest = await world.registry.describe('tab-1', finding.id)
    expect(manifest).toEqual({
      status: 'failed',
      reason: 'unreachable',
      detail: 'net::ERR_CONNECTION_RESET'
    })
  })

  it('reports a retrieval that threw something that is not an Error', async () => {
    // A rejected promise carrying a string is what a few native layers produce,
    // and `error.message` on it is `undefined` — which would put "undefined" in
    // front of the user as the reason.
    const world = harness()
    // Typed as `unknown` because that is what a caller actually receives, and
    // because the lint rule rightly objects to throwing a bare string on purpose.
    const notAnError: unknown = 'ERR_ABORTED'
    world.answer(() => {
      throw notAnError
    })
    world.respond({
      url: 'https://example.com/hls/master.m3u8',
      resourceType: 'xhr',
      contentType: 'application/x-mpegurl',
      contentLength: null
    })
    const finding = world.registry.findingsFor('tab-1')[0]!
    expect(await world.registry.describe('tab-1', finding.id)).toEqual({
      status: 'failed',
      reason: 'unreachable',
      detail: 'ERR_ABORTED'
    })
  })

  it('refuses a manifest larger than the ceiling, by its declared length', async () => {
    const world = harness({ maxManifestBytes: 32 })
    world.answer(
      () =>
        new Response('#EXTM3U', {
          headers: { 'content-type': 'application/x-mpegurl', 'content-length': '9999' }
        })
    )
    world.respond({
      url: 'https://example.com/hls/master.m3u8',
      resourceType: 'xhr',
      contentType: 'application/x-mpegurl',
      contentLength: null
    })
    const finding = world.registry.findingsFor('tab-1')[0]!
    const manifest = await world.registry.describe('tab-1', finding.id)
    expect(manifest).toMatchObject({ status: 'failed', reason: 'too-large' })
    expect(manifest?.status === 'failed' && manifest.detail).toContain('declared')
  })

  it('refuses a manifest larger than the ceiling that declared nothing', async () => {
    // The declared length is a claim. This is the check that counts, and the pair
    // of tests is here because a parser that only trusted the header would buffer
    // whatever a server chose to send.
    const world = harness({ maxManifestBytes: 32 })
    world.answer(() => playlistResponse(`#EXTM3U\n#EXTINF:4.0,\n${'a'.repeat(200)}.ts\n`))
    world.respond({
      url: 'https://example.com/hls/master.m3u8',
      resourceType: 'xhr',
      contentType: 'application/x-mpegurl',
      contentLength: null
    })
    const finding = world.registry.findingsFor('tab-1')[0]!
    const manifest = await world.registry.describe('tab-1', finding.id)
    expect(manifest).toMatchObject({ status: 'failed', reason: 'too-large' })
    expect(manifest?.status === 'failed' && manifest.detail).not.toContain('declared')
  })

  it('reports something that is not a manifest at all', async () => {
    const { harness: world, finding } = withManifest('<html>login required</html>')
    expect(await world.registry.describe('tab-1', finding.id)).toEqual({
      status: 'failed',
      reason: 'not-a-manifest',
      detail: 'no #EXTM3U on the first line'
    })
  })

  it('reports a playlist with nothing in it', async () => {
    const { harness: world, finding } = withManifest('#EXTM3U\n#EXT-X-ENDLIST\n')
    expect(await world.registry.describe('tab-1', finding.id)).toMatchObject({
      status: 'failed',
      reason: 'no-variants'
    })
  })

  it('reports an MPD that is not one, and one with no representation', async () => {
    const notAnMpd = withManifest('nonsense', 'application/dash+xml')
    const empty = withManifest(
      '<MPD><Period/></MPD>',
      'application/dash+xml',
      'https://example.com/dash/other.mpd'
    )
    expect(await notAnMpd.harness.registry.describe('tab-1', notAnMpd.finding.id)).toMatchObject({
      reason: 'not-a-manifest'
    })
    expect(await empty.harness.registry.describe('tab-1', empty.finding.id)).toMatchObject({
      reason: 'no-variants'
    })
  })

  it('has no manifest to describe for a progressive file', async () => {
    const world = harness()
    world.request({})
    const finding = world.registry.findingsFor('tab-1')[0]!
    expect(await world.registry.describe('tab-1', finding.id)).toBeNull()
    expect(world.requests).toEqual([])
  })

  it('has nothing to describe for a finding that is gone', async () => {
    const world = harness()
    expect(await world.registry.describe('tab-1', 'media-99')).toBeNull()
  })

  it('reads a manifest once, however many callers ask', async () => {
    const { harness: world, finding } = withManifest(MASTER)
    const [first, second] = await Promise.all([
      world.registry.describe('tab-1', finding.id),
      world.registry.describe('tab-1', finding.id)
    ])
    expect(world.requests).toHaveLength(1)
    expect(first).toEqual(second)
    expect(world.registry.diagnostics.manifestsLoaded).toBe(1)
  })

  it('returns the stored result on a later ask without fetching again', async () => {
    const { harness: world, finding } = withManifest(MASTER)
    await world.registry.describe('tab-1', finding.id)
    const again = await world.registry.describe('tab-1', finding.id)
    expect(again?.status).toBe('ready')
    expect(world.requests).toHaveLength(1)
  })

  it('drops a manifest whose tab navigated while it was in flight', async () => {
    const { harness: world, finding } = withManifest(MASTER)
    const inFlight = world.registry.describe('tab-1', finding.id)
    world.request({ resourceType: 'mainFrame', url: 'https://elsewhere.example/' })
    await inFlight
    expect(world.registry.findingsFor('tab-1')).toEqual([])
  })

  it('settles when no manifest load is outstanding', async () => {
    const { harness: world, finding } = withManifest(MASTER)
    await world.registry.whenIdle()
    void world.registry.describe('tab-1', finding.id)
    await world.registry.whenIdle()
    expect(world.registry.findingsFor('tab-1')[0]!.manifest).toMatchObject({ status: 'ready' })
  })

  it('marks a finding as pending while its manifest is being read', async () => {
    const { harness: world, finding } = withManifest(MASTER)
    const inFlight = world.registry.describe('tab-1', finding.id)
    expect(world.registry.findingsFor('tab-1')[0]!.manifest).toEqual({ status: 'pending' })
    await inFlight
  })
})
