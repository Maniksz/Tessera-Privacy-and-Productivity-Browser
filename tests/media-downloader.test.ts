import { existsSync, readdirSync } from 'node:fs'
import { chmod, mkdir, readdir, readFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MediaDownloader, type DownloadProgress } from '@main/media/MediaDownloader.js'
import { MAX_SAVE_PATH_ATTEMPTS } from '@main/downloads/target-path.js'
import type { MediaFetcher } from '@main/media/fetch.js'
import type { ManifestState, MediaFinding, MediaVariant } from '@shared/media/model.js'

/**
 * Downloading: what comes out complete, and what is refused with a reason.
 *
 * Nothing here reaches the network or the real clock. The fetcher is injected —
 * the same seam that keeps Electron's session-bound retrieval, and therefore the
 * proxy and the kill switch, in the picture in production.
 *
 * The assertions read the file off the disk rather than trusting the returned byte
 * count, because "the segments were concatenated in the right order" is a property
 * of the file and not of the bookkeeping.
 */

const T0 = 1_700_000_000_000

const PLAYLIST_URL = 'https://example.com/hls/index.m3u8'

interface Harness {
  downloader: MediaDownloader
  directory: string
  requests: Array<{ url: string; range: string | null }>
  answer(responder: (url: string) => Response): void
  tick(ms: number): void
}

async function harness(
  options: { maxBytes?: number; maxSegments?: number; directory?: string } = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'tessera-media-'))
  const directory = options.directory ?? join(root, 'downloads')
  const requests: Array<{ url: string; range: string | null }> = []
  let responder: (url: string) => Response = () => new Response('', { status: 404 })
  let clock = T0

  const fetcher: MediaFetcher = (url, init) => {
    requests.push({ url, range: init?.headers?.['Range'] ?? null })
    return Promise.resolve(responder(url))
  }

  return {
    downloader: new MediaDownloader({
      fetch: fetcher,
      now: () => clock,
      directory,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.maxSegments === undefined ? {} : { maxSegments: options.maxSegments })
    }),
    directory,
    requests,
    answer: (next) => {
      responder = next
    },
    tick: (ms) => {
      clock += ms
    }
  }
}

function finding(overrides: Partial<MediaFinding> = {}): MediaFinding {
  return {
    id: 'media-1',
    tabId: 'tab-1',
    url: PLAYLIST_URL,
    documentUrl: 'https://example.com/watch',
    kind: 'hls',
    container: 'unknown',
    contentType: 'application/x-mpegurl',
    byteLength: null,
    label: 'index.m3u8',
    discoveredAt: T0,
    manifest: { status: 'not-loaded' },
    ...overrides
  }
}

function variant(overrides: Partial<MediaVariant>): MediaVariant {
  return {
    id: 'v0',
    url: 'https://example.com/hls/1080p.m3u8',
    track: 'muxed',
    bandwidthBitsPerSecond: 7_680_000,
    width: 1920,
    height: 1080,
    codecs: null,
    container: 'unknown',
    language: null,
    name: null,
    ...overrides
  }
}

/** A described manifest with these qualities and no encryption. */
function ready(variants: readonly MediaVariant[]): ManifestState {
  return {
    status: 'ready',
    variants,
    durationSeconds: null,
    live: false,
    drm: { protected: false }
  }
}

/** Bytes with a recognisable first byte, so order is visible in the file. */
function segmentBody(marker: number, length = 8): Response {
  const bytes = new Uint8Array(length).fill(marker)
  return new Response(bytes)
}

const TS_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
first.ts
#EXTINF:9.009,
second.ts
#EXTINF:3.003,
third.ts
#EXT-X-ENDLIST
`

describe('downloading a progressive file', () => {
  it('writes the bytes and reports where they went', async () => {
    const world = await harness()
    world.answer(
      () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          headers: { 'content-length': '4' }
        })
    )

    const progress: DownloadProgress[] = []
    world.tick(0)
    const result = await world.downloader.download(
      finding({
        kind: 'progressive',
        url: 'https://example.com/clip.mp4',
        container: 'mp4',
        manifest: null
      }),
      null,
      { onProgress: (one) => progress.push(one) }
    )

    if (!result.ok) throw new Error(`expected a download, got ${result.refusal}: ${result.detail}`)
    expect(result.filePath).toBe(join(world.directory, 'clip.mp4'))
    expect(result.byteLength).toBe(4)
    expect([...(await readFile(result.filePath))]).toEqual([1, 2, 3, 4])
    expect(progress).toEqual([
      { receivedBytes: 4, totalBytes: 4, completedParts: 1, totalParts: 1 }
    ])
  })

  it('times the download from the injected clock', async () => {
    const world = await harness()
    world.answer(() => new Response(new Uint8Array([1])))
    const result = await world.downloader.run({
      kind: 'progressive',
      url: 'https://example.com/clip.mp4',
      fileName: 'clip.mp4',
      container: 'mp4'
    })
    if (!result.ok) throw new Error('expected a download')
    expect(result.startedAt).toBe(T0)
    expect(result.finishedAt).toBe(T0)
  })

  it('leaves no .part file behind', async () => {
    const world = await harness()
    world.answer(() => new Response(new Uint8Array([1])))
    await world.downloader.run({
      kind: 'progressive',
      url: 'https://example.com/clip.mp4',
      fileName: 'clip.mp4',
      container: 'mp4'
    })
    expect(await readdir(world.directory)).toEqual(['clip.mp4'])
  })

  it('numbers the file rather than overwriting one that is there', async () => {
    const world = await harness()
    world.answer(() => new Response(new Uint8Array([9])))
    const plan = {
      kind: 'progressive' as const,
      url: 'https://example.com/clip.mp4',
      fileName: 'clip.mp4',
      container: 'mp4' as const
    }
    await world.downloader.run(plan)
    const second = await world.downloader.run(plan)
    if (!second.ok) throw new Error('expected a download')
    expect(second.filePath).toBe(join(world.directory, 'clip-2.mp4'))
    expect((await readdir(world.directory)).sort()).toEqual(['clip-2.mp4', 'clip.mp4'])
  })

  it('accepts a response with no body at all', async () => {
    const world = await harness()
    world.answer(() => new Response(null, { status: 204 }))
    const result = await world.downloader.run({
      kind: 'progressive',
      url: 'https://example.com/empty.mp4',
      fileName: 'empty.mp4',
      container: 'mp4'
    })
    if (!result.ok) throw new Error('expected a download')
    expect(result.byteLength).toBe(0)
  })
})

describe('downloading a segmented stream', () => {
  it('concatenates MPEG-2 TS segments in order', async () => {
    // A transport stream has no global header, so the segments in order *are* the
    // file. Reading it back is what proves the order.
    const world = await harness()
    world.answer((url) => {
      if (url === PLAYLIST_URL) return new Response(TS_PLAYLIST)
      if (url.endsWith('first.ts')) return segmentBody(0x11, 4)
      if (url.endsWith('second.ts')) return segmentBody(0x22, 4)
      return segmentBody(0x33, 4)
    })

    const progress: DownloadProgress[] = []
    const result = await world.downloader.download(finding(), null, {
      onProgress: (one) => progress.push(one)
    })

    if (!result.ok) throw new Error(`expected a download, got ${result.refusal}`)
    expect(result.filePath).toBe(join(world.directory, 'index.ts'))
    expect([...(await readFile(result.filePath))]).toEqual([
      0x11, 0x11, 0x11, 0x11, 0x22, 0x22, 0x22, 0x22, 0x33, 0x33, 0x33, 0x33
    ])
    // Segments have no knowable total, so the progress bar counts parts.
    expect(progress.map((one) => [one.completedParts, one.totalParts, one.totalBytes])).toEqual([
      [1, 3, null],
      [2, 3, null],
      [3, 3, null]
    ])
  })

  it('writes the fMP4 initialisation segment before the fragments', async () => {
    // Init carries `ftyp`+`moov`. A fragmented MP4 whose header arrives second is
    // not a file.
    const world = await harness()
    world.answer((url) => {
      if (url === PLAYLIST_URL) {
        return new Response(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
one.m4s
#EXT-X-ENDLIST
`)
      }
      return url.endsWith('init.mp4') ? segmentBody(0xaa, 2) : segmentBody(0xbb, 2)
    })

    const result = await world.downloader.download(finding(), null)
    if (!result.ok) throw new Error(`expected a download, got ${result.refusal}`)
    expect(result.filePath).toBe(join(world.directory, 'index.mp4'))
    expect([...(await readFile(result.filePath))]).toEqual([0xaa, 0xaa, 0xbb, 0xbb])
  })

  it('fetches a byte-range segment with an inclusive Range header', async () => {
    // Inclusive at both ends. An off-by-one here duplicates or drops a byte per
    // segment, and nothing reports it — the file simply does not play.
    const world = await harness()
    world.answer((url) =>
      url === PLAYLIST_URL
        ? new Response(`#EXTM3U
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@0
whole.ts
#EXTINF:4.0,
#EXT-X-BYTERANGE:2000
whole.ts
#EXT-X-ENDLIST
`)
        : segmentBody(0x01, 2)
    )

    await world.downloader.download(finding(), null)
    expect(world.requests.slice(1).map((one) => one.range)).toEqual([
      'bytes=0-999',
      'bytes=1000-2999'
    ])
  })

  it('follows the variant the user chose', async () => {
    const world = await harness()
    world.answer((url) =>
      url.endsWith('480p.m3u8') ? new Response(TS_PLAYLIST) : segmentBody(0x01, 1)
    )

    const result = await world.downloader.download(
      finding({
        manifest: ready([
          variant({ id: 'v0', url: 'https://example.com/hls/1080p.m3u8' }),
          variant({ id: 'v1', url: 'https://example.com/hls/480p.m3u8', height: 480 })
        ])
      }),
      'v1'
    )
    if (!result.ok) throw new Error(`expected a download, got ${result.refusal}`)
    expect(world.requests[0]!.url).toBe('https://example.com/hls/480p.m3u8')
  })

  it('defaults to the best variant that can be assembled', async () => {
    const world = await harness()
    world.answer((url) =>
      url.endsWith('.m3u8') ? new Response(TS_PLAYLIST) : segmentBody(0x01, 1)
    )

    await world.downloader.download(
      finding({
        manifest: ready([
          variant({ id: 'v0', url: 'https://example.com/hls/720p.m3u8', height: 720 }),
          variant({ id: 'v1', url: 'https://example.com/hls/1080p.m3u8', height: 1080 }),
          variant({
            id: 'v2',
            url: 'https://example.com/hls/4k.m3u8',
            height: 2160,
            track: 'video'
          })
        ])
      }),
      null
    )
    // The 4K stream is taller and carries no sound. Picking it would hand back a
    // silent file, so the tallest *muxed* one wins.
    expect(world.requests[0]!.url).toBe('https://example.com/hls/1080p.m3u8')
  })
})

describe('refusing a download', () => {
  it('refuses an encrypted playlist', async () => {
    const world = await harness()
    world.answer(
      () =>
        new Response(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://priv.example.com/key.php?r=52"
#EXTINF:9.0,
one.ts
#EXT-X-ENDLIST
`)
    )
    const result = await world.downloader.download(finding(), null)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('drm-protected')
    // Nothing was written, and nothing was left half-written.
    expect(await readdir(world.directory).catch(() => [])).toEqual([])
  })

  it('refuses a master playlist whose session key declares encryption, without a request', async () => {
    const world = await harness()
    const result = await world.downloader.prepare(
      finding({
        manifest: {
          status: 'ready',
          variants: [variant({})],
          durationSeconds: null,
          live: false,
          drm: { protected: true, scheme: 'fairplay', detail: 'METHOD=SAMPLE-AES' }
        }
      }),
      null
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('drm-protected')
    expect(world.requests).toEqual([])
  })

  it('refuses DASH with the reason a muxer is needed', async () => {
    const world = await harness()
    const result = await world.downloader.download(
      finding({ kind: 'dash', url: 'https://example.com/dash/manifest.mpd' }),
      null
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('dash-needs-muxer')
    expect(world.requests).toEqual([])
  })

  it('refuses a live stream', async () => {
    const world = await harness()
    world.answer(() => new Response('#EXTM3U\n#EXTINF:8.0,\nfileSequence2680.ts\n'))
    const result = await world.downloader.download(finding(), null)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('live-stream')
  })

  it('refuses when every video variant needs a muxer', async () => {
    const world = await harness()
    const result = await world.downloader.prepare(
      finding({
        manifest: ready([
          variant({ id: 'v0', track: 'video' }),
          variant({ id: 'v1', track: 'video', height: 720 })
        ])
      }),
      null
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('separate-audio-track')
    expect(world.requests).toEqual([])
  })

  it('refuses a variant id that no manifest offers', async () => {
    const world = await harness()
    const result = await world.downloader.prepare(
      finding({ manifest: ready([variant({ id: 'v0' })]) }),
      'v9'
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('manifest-unavailable')
    expect(result.detail).toContain('v9')
  })

  it('refuses a variant that has no address of its own', async () => {
    const world = await harness()
    const result = await world.downloader.prepare(
      finding({ manifest: ready([variant({ id: 'r0', url: null })]) }),
      'r0'
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('manifest-unavailable')
    expect(result.detail).toContain('no address')
  })

  it('refuses when the playlist cannot be retrieved at download time', async () => {
    // It parsed when the panel was opened and 403s now: a login expired, or a
    // signed URL did.
    const world = await harness()
    world.answer(() => new Response('nope', { status: 403 }))
    const result = await world.downloader.download(finding(), null)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('manifest-unavailable')
    expect(result.detail).toBe('HTTP 403')
  })

  it('refuses a playlist with more segments than the ceiling', async () => {
    const world = await harness({ maxSegments: 2 })
    world.answer(() => new Response(TS_PLAYLIST))
    const result = await world.downloader.download(finding(), null)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('too-large')
    expect(result.detail).toContain('3 segments')
  })

  it('stops at the first segment that fails, and removes the partial file', async () => {
    // A file with a hole in it is not a download. It plays for forty seconds and
    // then stops for no visible reason, which is worse than a clear refusal.
    const world = await harness()
    world.answer((url) => {
      if (url === PLAYLIST_URL) return new Response(TS_PLAYLIST)
      if (url.endsWith('first.ts')) return segmentBody(0x11, 4)
      return new Response('gone', { status: 404 })
    })

    const result = await world.downloader.download(finding(), null)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('segment-unavailable')
    expect(result.detail).toContain('second.ts')
    expect(await readdir(world.directory)).toEqual([])
  })

  it('reports a segment retrieval that threw', async () => {
    const world = await harness()
    world.answer((url) => {
      if (url === PLAYLIST_URL) return new Response(TS_PLAYLIST)
      throw new Error('net::ERR_NAME_NOT_RESOLVED')
    })
    const result = await world.downloader.download(finding(), null)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('segment-unavailable')
    expect(result.detail).toBe('net::ERR_NAME_NOT_RESOLVED')
  })

  it('stops past the byte ceiling', async () => {
    const world = await harness({ maxBytes: 6 })
    world.answer((url) => (url === PLAYLIST_URL ? new Response(TS_PLAYLIST) : segmentBody(0x11, 4)))
    const result = await world.downloader.download(finding(), null)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('too-large')
    expect(await readdir(world.directory)).toEqual([])
  })

  it('reports a directory it cannot create', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-media-'))
    const blocked = join(root, 'not-a-directory')
    await writeFile(blocked, 'in the way')

    const world = await harness({ directory: join(blocked, 'downloads') })
    world.answer(() => new Response(new Uint8Array([1])))
    const result = await world.downloader.run({
      kind: 'progressive',
      url: 'https://example.com/clip.mp4',
      fileName: 'clip.mp4',
      container: 'mp4'
    })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('write-failed')
  })

  it('reports a directory it may not write into', async () => {
    const world = await harness()
    await mkdir(world.directory, { recursive: true })
    await chmod(world.directory, 0o500)
    world.answer(() => new Response(new Uint8Array([1])))
    try {
      const result = await world.downloader.run({
        kind: 'progressive',
        url: 'https://example.com/clip.mp4',
        fileName: 'clip.mp4',
        container: 'mp4'
      })
      if (result.ok) throw new Error('expected a refusal')
      expect(result.refusal).toBe('write-failed')
    } finally {
      await chmod(world.directory, 0o700)
    }
  })
})

describe('where a media download lands (media plan R23)', () => {
  const PLAN = {
    kind: 'progressive' as const,
    url: 'https://example.com/clip.mp4',
    fileName: 'clip.mp4',
    container: 'mp4' as const
  }

  it('reserves its target before the first byte, and says where', async () => {
    // The downloads row needs the path the moment the transfer starts, and "reserved" has to mean
    // something on disk: another download choosing a name now must see this one as taken.
    const world = await harness()
    const seen: Array<{ target: string; partial: string[] }> = []
    world.answer(() => new Response(new Uint8Array([1])))

    const result = await world.downloader.run(PLAN, {
      onTarget: (target) => {
        seen.push({ target, partial: readdirSync(world.directory) })
      }
    })

    if (!result.ok) throw new Error('expected a download')
    expect(seen).toEqual([
      { target: join(world.directory, 'clip.mp4'), partial: ['clip.mp4.part'] }
    ])
    expect(result.filePath).toBe(seen[0]?.target)
  })

  it('gives two downloads of one name two targets, even when they start together', async () => {
    /*
      Two players on one page both call their playlist `index.m3u8`, so the same name twice is the
      ordinary case. Numbered by the rule `target-path.ts` uses for every download — and reserved on
      disk, because two downloads starting in the same tick both saw a free name before.
    */
    const world = await harness()
    let marker = 0
    world.answer(() => {
      marker += 1
      return segmentBody(marker, 2)
    })

    const [first, second] = await Promise.all([
      world.downloader.run(PLAN),
      world.downloader.run(PLAN)
    ])

    if (!first.ok || !second.ok) throw new Error('expected two downloads')
    expect(new Set([first.filePath, second.filePath])).toEqual(
      new Set([join(world.directory, 'clip.mp4'), join(world.directory, 'clip-2.mp4')])
    )
    const contents = [await readFile(first.filePath), await readFile(second.filePath)]
    expect(contents.map((bytes) => [...bytes].sort())).toEqual(
      expect.arrayContaining([
        [1, 1],
        [2, 2]
      ])
    )
  })

  it('counts a name another download is still writing as taken', async () => {
    const world = await harness()
    await mkdir(world.directory, { recursive: true })
    await writeFile(join(world.directory, 'clip.mp4.part'), 'someone else')
    world.answer(() => new Response(new Uint8Array([1])))

    const result = await world.downloader.run(PLAN)
    if (!result.ok) throw new Error('expected a download')
    expect(result.filePath).toBe(join(world.directory, 'clip-2.mp4'))
  })

  it('writes into the platform folder when the setting is empty', async () => {
    // `downloads.directory` defaults to empty, and an empty directory joined to a name is a path
    // relative to wherever the process happens to run.
    const root = await mkdtemp(join(tmpdir(), 'tessera-media-'))
    const fallbackDirectory = join(root, 'Downloads')
    const downloader = new MediaDownloader({
      fetch: () => Promise.resolve(new Response(new Uint8Array([1]))),
      now: () => T0,
      directory: '',
      fallbackDirectory
    })

    const result = await downloader.run(PLAN)
    if (!result.ok) throw new Error(`expected a download, got ${result.refusal}: ${result.detail}`)
    expect(result.filePath).toBe(join(fallbackDirectory, 'clip.mp4'))
  })

  it('keeps a name inside the directory, whatever the plan called it', async () => {
    // A plan builder never produces a name with a directory in it; a caller handing over its own
    // still gets the sanitiser every other download goes through.
    const world = await harness()
    world.answer(() => new Response(new Uint8Array([1])))

    const result = await world.downloader.run({ ...PLAN, fileName: '../../missing/clip.mp4' })
    if (!result.ok) throw new Error('expected a download')
    expect(result.filePath).toBe(join(world.directory, 'clip.mp4'))
  })

  it('refuses when no name is free', async () => {
    const world = await harness()
    await mkdir(world.directory, { recursive: true })
    await writeFile(join(world.directory, 'clip.mp4'), 'x')
    for (let attempt = 2; attempt <= MAX_SAVE_PATH_ATTEMPTS; attempt += 1) {
      await writeFile(join(world.directory, `clip-${attempt}.mp4`), 'x')
    }
    world.answer(() => new Response(new Uint8Array([1])))

    const result = await world.downloader.run(PLAN)
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('write-failed')
    expect(world.requests).toEqual([])
  })
})

describe('addresses a stream may not send the browser to (media plan R25)', () => {
  function playlistWith(segment: string): string {
    return `#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:9.0,\nfirst.ts\n#EXTINF:9.0,\n${segment}\n#EXT-X-ENDLIST\n`
  }

  it.each([
    'http://127.0.0.1/second.ts',
    'http://10.0.0.1/second.ts',
    'http://[::1]/second.ts',
    'file:///etc/passwd',
    'data:video/mp2t;base64,AAAA',
    'blob:https://example.com/9d2f'
  ])('refuses a playlist with a segment at %s, before writing anything', async (segment) => {
    const world = await harness()
    world.answer((url) =>
      url === PLAYLIST_URL ? new Response(playlistWith(segment)) : segmentBody(0x11, 4)
    )

    const result = await world.downloader.download(finding(), null)

    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('address-not-allowed')
    // Only the playlist was asked for: not the first, public segment, and never the other one.
    expect(world.requests.map((one) => one.url)).toEqual([PLAYLIST_URL])
    expect(existsSync(world.directory) ? await readdir(world.directory) : []).toEqual([])
  })

  it('refuses an initialisation segment on the local network', async () => {
    const world = await harness()
    const result = await world.downloader.run({
      kind: 'segments',
      fileName: 'index.mp4',
      container: 'mp4',
      initSegment: { url: 'http://192.168.0.1/init.mp4', byteRange: null },
      segments: [{ url: 'https://example.com/hls/one.m4s', byteRange: null }]
    })
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('address-not-allowed')
    expect(result.detail).toContain('192.168.0.1')
    expect(world.requests).toEqual([])
  })

  it('refuses a quality whose playlist is on the local network, without asking it', async () => {
    const world = await harness()
    world.answer(() => new Response(TS_PLAYLIST))

    const result = await world.downloader.download(
      finding({
        manifest: ready([variant({ id: 'v0', url: 'http://169.254.169.254/latest/1080p.m3u8' })])
      }),
      null
    )

    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('address-not-allowed')
    expect(world.requests).toEqual([])
  })

  it('refuses a progressive file on this computer', async () => {
    const world = await harness()
    world.answer(() => new Response(new Uint8Array([1])))

    const result = await world.downloader.download(
      finding({ kind: 'progressive', url: 'http://localhost:8080/clip.mp4', manifest: null }),
      null
    )

    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('address-not-allowed')
    expect(world.requests).toEqual([])
  })
})

describe('stopping a download', () => {
  it('refuses before the first request when already aborted', async () => {
    const world = await harness()
    world.answer(() => segmentBody(0x11, 4))
    const controller = new AbortController()
    controller.abort()

    const result = await world.downloader.run(
      {
        kind: 'segments',
        fileName: 'index.ts',
        container: 'ts',
        initSegment: null,
        segments: [{ url: 'https://example.com/hls/first.ts', byteRange: null }]
      },
      { signal: controller.signal }
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('cancelled')
    expect(world.requests).toEqual([])
    expect(await readdir(world.directory)).toEqual([])
  })

  it('stops between segments when the user presses stop', async () => {
    const world = await harness()
    const controller = new AbortController()
    world.answer(() => {
      // Aborted while the first segment is in flight, which is when a user
      // actually presses the button.
      controller.abort()
      return segmentBody(0x11, 4)
    })

    const result = await world.downloader.run(
      {
        kind: 'segments',
        fileName: 'index.ts',
        container: 'ts',
        initSegment: null,
        segments: [
          { url: 'https://example.com/hls/first.ts', byteRange: null },
          { url: 'https://example.com/hls/second.ts', byteRange: null }
        ]
      },
      { signal: controller.signal }
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('cancelled')
    expect(world.requests).toHaveLength(1)
  })

  it('reports a retrieval aborted mid-flight as cancelled rather than as a failure', async () => {
    const world = await harness()
    const controller = new AbortController()
    world.answer(() => {
      controller.abort()
      throw new Error('The operation was aborted')
    })

    const result = await world.downloader.run(
      {
        kind: 'progressive',
        url: 'https://example.com/clip.mp4',
        fileName: 'clip.mp4',
        container: 'mp4'
      },
      { signal: controller.signal }
    )
    if (result.ok) throw new Error('expected a refusal')
    expect(result.refusal).toBe('cancelled')
  })

  it('passes the signal on to the fetcher', async () => {
    // Without this the request keeps running after the user stopped it, and the
    // bytes keep arriving over whatever tunnel they were arriving over.
    const world = await harness()
    const controller = new AbortController()
    let seen: AbortSignal | undefined
    const downloader = new MediaDownloader({
      fetch: (_url, init) => {
        seen = init?.signal
        return Promise.resolve(new Response(new Uint8Array([1])))
      },
      now: () => T0,
      directory: world.directory
    })

    await downloader.run(
      {
        kind: 'progressive',
        url: 'https://example.com/clip.mp4',
        fileName: 'clip.mp4',
        container: 'mp4'
      },
      { signal: controller.signal }
    )
    expect(seen).toBe(controller.signal)
  })
})
