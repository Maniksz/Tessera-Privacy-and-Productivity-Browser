import { describe, expect, it } from 'vitest'
import { parseHlsPlaylist } from '@shared/media/hls.js'
import {
  NOT_PROTECTED,
  bestMuxedVariant,
  sortVariantsByQuality,
  variantById,
  type MediaVariant
} from '@shared/media/model.js'
import { planDownload } from '@shared/media/plan.js'

/**
 * The line between what this feature finishes and what it refuses.
 *
 * Every refusal here is a decision, not a gap, and each one is tested for the
 * reason it carries rather than merely for failing — the interface has to be able
 * to tell the user *why*, and a test that only asserted `ok === false` would let
 * the reasons drift into being interchangeable.
 */

const PLAYLIST_URL = 'https://example.com/hls/index.m3u8'

function hlsPlan(body: string, track: 'muxed' | 'video' | 'audio' = 'muxed') {
  return planDownload({
    source: 'hls',
    playlistUrl: PLAYLIST_URL,
    playlist: parseHlsPlaylist(body, PLAYLIST_URL),
    track
  })
}

function variant(overrides: Partial<MediaVariant>): MediaVariant {
  return {
    id: 'v0',
    url: 'https://example.com/hls/v0.m3u8',
    track: 'muxed',
    bandwidthBitsPerSecond: null,
    width: null,
    height: null,
    codecs: null,
    container: 'unknown',
    language: null,
    name: null,
    ...overrides
  }
}

describe('what can be downloaded', () => {
  it('plans a progressive file as one request', () => {
    const outcome = planDownload({
      source: 'progressive',
      url: 'https://example.com/clip.mp4',
      container: 'mp4'
    })
    expect(outcome).toEqual({
      ok: true,
      plan: {
        kind: 'progressive',
        url: 'https://example.com/clip.mp4',
        fileName: 'clip.mp4',
        container: 'mp4'
      }
    })
  })

  it('plans an MPEG-2 TS playlist as a concatenation', () => {
    // A transport stream has no global header: the segments in order *are* the
    // file, which is why this is the case that can be finished without a muxer.
    const outcome = hlsPlan(`#EXTM3U
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
first.ts
#EXTINF:9.009,
second.ts
#EXT-X-ENDLIST
`)
    if (!outcome.ok) throw new Error(`expected a plan, got ${outcome.refusal}`)
    if (outcome.plan.kind !== 'segments') throw new Error('expected a segment plan')
    expect(outcome.plan.container).toBe('ts')
    expect(outcome.plan.fileName).toBe('index.ts')
    expect(outcome.plan.initSegment).toBeNull()
    expect(outcome.plan.segments.map((segment) => segment.url)).toEqual([
      'https://example.com/hls/first.ts',
      'https://example.com/hls/second.ts'
    ])
  })

  it('plans an fMP4 playlist with its initialisation segment first', () => {
    // Init carries `ftyp`+`moov`, each segment is a `moof`+`mdat` fragment, so
    // init-then-fragments is a valid fragmented MP4.
    const outcome = hlsPlan(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
one.m4s
#EXT-X-ENDLIST
`)
    if (!outcome.ok) throw new Error('expected a plan')
    if (outcome.plan.kind !== 'segments') throw new Error('expected a segment plan')
    expect(outcome.plan.container).toBe('mp4')
    expect(outcome.plan.fileName).toBe('index.mp4')
    expect(outcome.plan.initSegment?.url).toBe('https://example.com/hls/init.mp4')
  })

  it('plans a packed-audio playlist', () => {
    const outcome = hlsPlan('#EXTM3U\n#EXTINF:10.0,\none.aac\n#EXT-X-ENDLIST\n', 'audio')
    if (!outcome.ok) throw new Error('expected a plan')
    expect(outcome.plan.fileName).toBe('index.aac')
  })

  it('carries byte-ranges into the plan', () => {
    const outcome = hlsPlan(`#EXTM3U
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@0
whole.ts
#EXTINF:4.0,
#EXT-X-BYTERANGE:2000
whole.ts
#EXT-X-ENDLIST
`)
    if (!outcome.ok) throw new Error('expected a plan')
    if (outcome.plan.kind !== 'segments') throw new Error('expected a segment plan')
    expect(outcome.plan.segments.map((segment) => segment.byteRange)).toEqual([
      { offset: 0, length: 1000 },
      { offset: 1000, length: 2000 }
    ])
  })
})

describe('what is refused, and why', () => {
  it('refuses an encrypted playlist without attempting anything', () => {
    const outcome = hlsPlan(`#EXTM3U
#EXT-X-KEY:METHOD=AES-128,URI="https://priv.example.com/key.php?r=52"
#EXTINF:9.0,
one.ts
#EXT-X-ENDLIST
`)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.refusal).toBe('drm-protected')
    expect(outcome.detail).toContain('aes-128')
  })

  it('names Widevine in the refusal', () => {
    const outcome = hlsPlan(`#EXTM3U
#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed",URI="skd://x"
#EXTINF:9.0,
one.ts
#EXT-X-ENDLIST
`)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('drm-protected')
    expect(outcome.detail).toContain('widevine')
  })

  it('refuses a live stream because there is no end to download to', () => {
    const outcome = hlsPlan(`#EXTM3U
#EXT-X-TARGETDURATION:8
#EXTINF:7.975,
fileSequence2680.ts
`)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('live-stream')
    expect(outcome.detail).toContain('#EXT-X-ENDLIST')
  })

  it('refuses a video-only variant rather than producing a silent file', () => {
    const outcome = hlsPlan('#EXTM3U\n#EXTINF:4.0,\none.ts\n#EXT-X-ENDLIST\n', 'video')
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('separate-audio-track')
  })

  it('refuses MP4 segments that have no #EXT-X-MAP', () => {
    // Each one is a complete file with its own `moov`; concatenating them
    // produces something no player reads past the first.
    const outcome = hlsPlan(`#EXTM3U
#EXTINF:4.0,
one.mp4
#EXTINF:4.0,
two.mp4
#EXT-X-ENDLIST
`)
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('segments-not-concatenable')
    expect(outcome.detail).toContain('#EXT-X-MAP')
  })

  it('refuses a playlist that turned out to be a master playlist', () => {
    const outcome = hlsPlan('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nlow.m3u8\n')
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('manifest-unavailable')
    expect(outcome.detail).toContain('master playlist')
  })

  it('refuses a playlist that did not parse, and says which way', () => {
    const notPlaylist = hlsPlan('<html>404</html>')
    const empty = hlsPlan('#EXTM3U\n#EXT-X-ENDLIST\n')
    if (notPlaylist.ok || empty.ok) throw new Error('expected refusals')
    expect(notPlaylist.refusal).toBe('manifest-unavailable')
    expect(notPlaylist.detail).toContain('not-a-playlist')
    expect(empty.detail).toContain('no-entries')
  })

  it('refuses DASH, because a representation is one track', () => {
    const outcome = planDownload({ source: 'dash', drm: NOT_PROTECTED })
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('dash-needs-muxer')
    expect(outcome.detail).toContain('muxer')
  })

  it('refuses encrypted DASH for the encryption rather than for the muxing', () => {
    // The more specific reason wins: telling the user it needs a muxer would send
    // them looking for ffmpeg for something ffmpeg cannot do either.
    const outcome = planDownload({
      source: 'dash',
      drm: { protected: true, scheme: 'widevine', detail: 'schemeIdUri=urn:uuid:edef8ba9…' }
    })
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('drm-protected')
  })

  it('refuses an address the session cannot re-request', () => {
    const outcome = planDownload({
      source: 'progressive',
      url: 'blob:https://example.com/9d2f',
      container: 'mp4'
    })
    if (outcome.ok) throw new Error('expected a refusal')
    expect(outcome.refusal).toBe('unsupported-scheme')
  })
})

describe('choosing a quality', () => {
  const variants: readonly MediaVariant[] = [
    variant({ id: 'v0', height: 480, bandwidthBitsPerSecond: 1_280_000 }),
    variant({ id: 'v1', height: 1080, bandwidthBitsPerSecond: 7_680_000 }),
    variant({ id: 'v2', height: 1080, bandwidthBitsPerSecond: 9_000_000 }),
    variant({ id: 'v3', height: 720, bandwidthBitsPerSecond: 2_560_000, track: 'video' }),
    variant({ id: 'a0', track: 'audio' })
  ]

  it('sorts tallest first, then by bitrate, muxed before the rest', () => {
    expect(sortVariantsByQuality(variants).map((one) => one.id)).toEqual([
      'v2',
      'v1',
      'v0',
      'v3',
      'a0'
    ])
  })

  it('defaults to the best variant that can actually be assembled', () => {
    expect(bestMuxedVariant(variants)?.id).toBe('v2')
  })

  it('reports no default when every video variant needs a muxer', () => {
    // Returning the best-looking one would hand back a silent video, which reads
    // as a bug in the browser rather than a property of the stream.
    const separated = variants.filter((one) => one.track !== 'muxed')
    expect(bestMuxedVariant(separated)).toBeNull()
  })

  it('sorts variants with no stated quality at all without losing them', () => {
    const unknown = [variant({ id: 'x' }), variant({ id: 'y' })]
    expect(sortVariantsByQuality(unknown).map((one) => one.id)).toEqual(['x', 'y'])
  })

  it('puts a variant that states a height above one that states none', () => {
    // A playlist may omit `RESOLUTION` on some variants and not others. The ones
    // that said something are the ones a person can choose between.
    expect(
      sortVariantsByQuality([
        variant({ id: 'x', height: null, bandwidthBitsPerSecond: null }),
        variant({ id: 'y', height: 720, bandwidthBitsPerSecond: null })
      ]).map((one) => one.id)
    ).toEqual(['y', 'x'])
  })

  it('falls back to the bitrate when neither states a height', () => {
    expect(
      sortVariantsByQuality([
        variant({ id: 'x', height: null, bandwidthBitsPerSecond: null }),
        variant({ id: 'y', height: null, bandwidthBitsPerSecond: 900_000 })
      ]).map((one) => one.id)
    ).toEqual(['y', 'x'])
  })

  it('finds a variant by id and reports a miss as null', () => {
    expect(variantById(variants, 'v3')?.height).toBe(720)
    expect(variantById(variants, 'nope')).toBeNull()
  })
})
