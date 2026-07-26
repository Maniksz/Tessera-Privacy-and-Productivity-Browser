import { describe, expect, it } from 'vitest'
import { drmFromKeyAttributes, parseAttributeList, parseHlsPlaylist } from '@shared/media/hls.js'

/**
 * The HLS parser, against RFC 8216's own examples.
 *
 * The fixtures in the first block are the playlists printed in RFC 8216 §8,
 * verbatim, with one mechanical change noted where it applies: the RFC wraps long
 * `#EXT-X-MEDIA` lines with a trailing backslash for the sake of the document's
 * margins, and a real playlist has them on one line.
 *
 * Using the specification's examples rather than invented ones is the point. An
 * invented fixture tests the parser against the author's memory of the format,
 * which is exactly the thing that is wrong when a parser is wrong.
 */

const PLAYLIST_URL = 'https://example.com/hls/master.m3u8'

/** RFC 8216 §8.1, Simple Media Playlist. */
const SIMPLE_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-VERSION:3
#EXTINF:9.009,
http://media.example.com/first.ts
#EXTINF:9.009,
http://media.example.com/second.ts
#EXTINF:3.003,
http://media.example.com/third.ts
#EXT-X-ENDLIST
`

/** RFC 8216 §8.2, Live Media Playlist Using HTTPS. No `#EXT-X-ENDLIST`. */
const LIVE_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:8
#EXT-X-MEDIA-SEQUENCE:2680

#EXTINF:7.975,
https://priv.example.com/fileSequence2680.ts
#EXTINF:7.941,
https://priv.example.com/fileSequence2681.ts
#EXTINF:7.975,
https://priv.example.com/fileSequence2682.ts
`

/** RFC 8216 §8.3, Playlist with Encrypted Media Segments. */
const ENCRYPTED_MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-MEDIA-SEQUENCE:7794
#EXT-X-TARGETDURATION:15

#EXT-X-KEY:METHOD=AES-128,URI="https://priv.example.com/key.php?r=52"

#EXTINF:2.833,
http://media.example.com/fileSequence52-A.ts
#EXTINF:15.0,
http://media.example.com/fileSequence52-B.ts
#EXTINF:13.333,
http://media.example.com/fileSequence52-C.ts

#EXT-X-KEY:METHOD=AES-128,URI="https://priv.example.com/key.php?r=53"

#EXTINF:15.0,
http://media.example.com/fileSequence53-A.ts
`

/** RFC 8216 §8.4, Master Playlist. */
const MASTER_PLAYLIST = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AVERAGE-BANDWIDTH=1000000
http://example.com/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,AVERAGE-BANDWIDTH=2000000
http://example.com/mid.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000,AVERAGE-BANDWIDTH=6000000
http://example.com/hi.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5"
http://example.com/audio-only.m3u8
`

/** RFC 8216 §8.5, Master Playlist with I-Frame Playlists. */
const MASTER_WITH_IFRAMES = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000
low/audio-video.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=86000,URI="low/iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=2560000
mid/audio-video.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=150000,URI="mid/iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=7680000
hi/audio-video.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=550000,URI="hi/iframe.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5"
audio-only.m3u8
`

/**
 * RFC 8216 §8.6, Master Playlist with Alternative Audio.
 *
 * The `#EXT-X-MEDIA` lines are joined: the RFC breaks them with a trailing
 * backslash so they fit the page, which is a property of the document rather than
 * of the format. `CODECS="..."` is the RFC's own placeholder and is kept as
 * written — it doubles as a test that a quoted value survives intact.
 */
const MASTER_WITH_ALTERNATIVE_AUDIO = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES,AUTOSELECT=YES,LANGUAGE="en",URI="main/english-audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Deutsch",DEFAULT=NO,AUTOSELECT=YES,LANGUAGE="de",URI="main/german-audio.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Commentary",DEFAULT=NO,AUTOSELECT=NO,LANGUAGE="en",URI="commentary/audio-only.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,CODECS="...",AUDIO="aac"
low/video-only.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,CODECS="...",AUDIO="aac"
mid/video-only.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000,CODECS="...",AUDIO="aac"
hi/video-only.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.5",AUDIO="aac"
main/english-audio.m3u8
`

/**
 * A master playlist carrying `RESOLUTION`, `FRAME-RATE` and a two-codec `CODECS`.
 *
 * §8 has no example with a resolution in it, so this one is built from the
 * attribute definitions in §4.3.4.2 — the attribute names and value forms are the
 * specification's, the numbers are a 480p/720p/1080p ladder. It exists because
 * `RESOLUTION` is what a person actually chooses a quality by, and because
 * `CODECS="avc1.640028,mp4a.40.2"` is the comma-inside-quotes case that a naive
 * split gets wrong.
 */
const MASTER_WITH_RESOLUTIONS = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480,CODECS="avc1.4d401f,mp4a.40.2"
480p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000,RESOLUTION=1280x720,FRAME-RATE=25.000,CODECS="avc1.4d401f,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=7680000,RESOLUTION=1920x1080,FRAME-RATE=25.000,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8
`

describe('HLS master playlists', () => {
  it('reads every quality out of the specification’s master playlist', () => {
    const playlist = parseHlsPlaylist(MASTER_PLAYLIST, PLAYLIST_URL)
    if (playlist.kind !== 'master') throw new Error(`expected a master, got ${playlist.kind}`)

    expect(playlist.variants.map((variant) => variant.bandwidthBitsPerSecond)).toEqual([
      1280000, 2560000, 7680000, 65000
    ])
    expect(playlist.variants.map((variant) => variant.averageBandwidthBitsPerSecond)).toEqual([
      1000000,
      2000000,
      6000000,
      null
    ])
    expect(playlist.variants.map((variant) => variant.url)).toEqual([
      'http://example.com/low.m3u8',
      'http://example.com/mid.m3u8',
      'http://example.com/hi.m3u8',
      'http://example.com/audio-only.m3u8'
    ])
    // No `AUDIO` attribute anywhere: every variant carries its own sound, so
    // every one of them can be downloaded.
    expect(playlist.variants.every((variant) => variant.audioGroupId === null)).toBe(true)
    expect(playlist.drm.protected).toBe(false)
  })

  it('resolves relative variant URIs against the playlist address', () => {
    const playlist = parseHlsPlaylist(MASTER_WITH_IFRAMES, PLAYLIST_URL)
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.variants.map((variant) => variant.url)).toEqual([
      'https://example.com/hls/low/audio-video.m3u8',
      'https://example.com/hls/mid/audio-video.m3u8',
      'https://example.com/hls/hi/audio-video.m3u8',
      'https://example.com/hls/audio-only.m3u8'
    ])
  })

  it('leaves I-frame-only streams out of the qualities on offer', () => {
    // They are Variant Streams by grammar and trick-play by purpose. Offering
    // `low/iframe.m3u8` beside the real qualities would be offering a download of
    // a slideshow.
    const playlist = parseHlsPlaylist(MASTER_WITH_IFRAMES, PLAYLIST_URL)
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.variants).toHaveLength(4)
    expect(playlist.variants.map((variant) => variant.url).join(' ')).not.toContain('iframe')
  })

  it('reads resolutions, frame rates and a comma-bearing CODECS list', () => {
    const playlist = parseHlsPlaylist(MASTER_WITH_RESOLUTIONS, PLAYLIST_URL)
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.variants.map((variant) => [variant.width, variant.height])).toEqual([
      [854, 480],
      [1280, 720],
      [1920, 1080]
    ])
    // The comma inside the quoted value did not split the attribute in two, which
    // is what would have lost `RESOLUTION` on the way past it.
    expect(playlist.variants[2]!.codecs).toBe('avc1.640028,mp4a.40.2')
  })

  it('offers each alternative audio rendition as a quality of its own', () => {
    const playlist = parseHlsPlaylist(MASTER_WITH_ALTERNATIVE_AUDIO, PLAYLIST_URL)
    if (playlist.kind !== 'master') throw new Error('expected a master')

    // Every variant names an AUDIO group, so none of them carries sound.
    expect(playlist.variants.map((variant) => variant.audioGroupId)).toEqual([
      'aac',
      'aac',
      'aac',
      'aac'
    ])
    expect(playlist.renditions.map((rendition) => [rendition.name, rendition.language])).toEqual([
      ['English', 'en'],
      ['Deutsch', 'de'],
      ['Commentary', 'en']
    ])
    expect(playlist.renditions[1]!.url).toBe('https://example.com/hls/main/german-audio.m3u8')
    expect(playlist.renditions.every((rendition) => rendition.type === 'AUDIO')).toBe(true)
  })

  it('ignores a rendition that has no URI of its own', () => {
    // A rendition without `URI` is muxed into the variants; there is nothing
    // separate to offer, and inventing an address for it would offer a 404.
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AUDIO="aac"
low.m3u8
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.renditions).toEqual([])
  })

  it('records a rendition that states nothing but its URI', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-MEDIA:URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000
low.m3u8
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.renditions[0]).toEqual({
      type: 'UNKNOWN',
      groupId: null,
      name: null,
      language: null,
      url: 'https://example.com/hls/audio.m3u8'
    })
  })

  it('falls back to AVERAGE-BANDWIDTH when BANDWIDTH is missing', () => {
    // `BANDWIDTH` is mandatory, so this is a packager being wrong — and a number
    // in front of the user beats a blank where the quality should be.
    const playlist = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=1000000\nlow.m3u8\n',
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.variants[0]!.bandwidthBitsPerSecond).toBeNull()
    expect(playlist.variants[0]!.averageBandwidthBitsPerSecond).toBe(1000000)
  })

  it('reads a master-level #EXT-X-SESSION-KEY as encryption', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",KEYFORMATVERSIONS="1"
#EXT-X-STREAM-INF:BANDWIDTH=1280000
low.m3u8
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.drm).toEqual({
      protected: true,
      scheme: 'fairplay',
      detail: 'METHOD=SAMPLE-AES, KEYFORMAT=com.apple.streamingkeydelivery'
    })
  })
})

describe('HLS media playlists', () => {
  it('reads the specification’s simple media playlist', () => {
    const playlist = parseHlsPlaylist(SIMPLE_MEDIA_PLAYLIST, PLAYLIST_URL)
    if (playlist.kind !== 'media')
      throw new Error(`expected a media playlist, got ${playlist.kind}`)

    expect(playlist.segments.map((segment) => segment.url)).toEqual([
      'http://media.example.com/first.ts',
      'http://media.example.com/second.ts',
      'http://media.example.com/third.ts'
    ])
    expect(playlist.segments.map((segment) => segment.durationSeconds)).toEqual([
      9.009, 9.009, 3.003
    ])
    expect(playlist.durationSeconds).toBeCloseTo(21.021, 3)
    expect(playlist.targetDurationSeconds).toBe(10)
    expect(playlist.live).toBe(false)
    expect(playlist.container).toBe('ts')
    expect(playlist.initSegment).toBeNull()
    expect(playlist.drm.protected).toBe(false)
  })

  it('treats a playlist with no #EXT-X-ENDLIST as live', () => {
    const playlist = parseHlsPlaylist(LIVE_MEDIA_PLAYLIST, PLAYLIST_URL)
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.live).toBe(true)
    expect(playlist.segments).toHaveLength(3)
    expect(playlist.targetDurationSeconds).toBe(8)
  })

  it('accepts #EXT-X-PLAYLIST-TYPE:VOD as a promise not to grow', () => {
    // A packager that states VOD and forgets the end tag should not turn a
    // finished film into something the downloader refuses as live.
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-TARGETDURATION:10
#EXTINF:9.009,
first.ts
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.live).toBe(false)
  })

  it('reports the encryption in the specification’s encrypted playlist', () => {
    const playlist = parseHlsPlaylist(ENCRYPTED_MEDIA_PLAYLIST, PLAYLIST_URL)
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.segments).toHaveLength(4)
    expect(playlist.drm).toEqual({
      protected: true,
      scheme: 'aes-128',
      detail: 'METHOD=AES-128'
    })
  })

  it('keeps an encrypted verdict when a later key says METHOD=NONE', () => {
    // Part of the span is encrypted, so a whole-file download is not on offer. A
    // verdict that could be cleared by a later tag would depend on where the
    // parse happened to stop.
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:10
#EXT-X-KEY:METHOD=AES-128,URI="key.php"
#EXTINF:9.0,
one.ts
#EXT-X-KEY:METHOD=NONE
#EXTINF:9.0,
two.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.drm.protected).toBe(true)
  })

  it('recognises fMP4 segments by their #EXT-X-MAP', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:4
#EXT-X-MAP:URI="init.mp4"
#EXTINF:4.0,
segment-1.m4s
#EXTINF:4.0,
segment-2.m4s
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.container).toBe('mp4')
    expect(playlist.initSegment).toEqual({
      url: 'https://example.com/hls/init.mp4',
      durationSeconds: 0,
      byteRange: null
    })
  })

  it('reads a byte-range on the initialisation segment', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-MAP:URI="whole.mp4",BYTERANGE="1200@0"
#EXTINF:4.0,
#EXT-X-BYTERANGE:5000@1200
whole.mp4
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.initSegment?.byteRange).toEqual({ offset: 0, length: 1200 })
    expect(playlist.segments[0]!.byteRange).toEqual({ offset: 1200, length: 5000 })
  })

  it('continues a byte-range from the previous sub-range when the offset is omitted', () => {
    // RFC 8216 §4.3.2.2: without `@o` the range starts where the previous one
    // ended, and only within the same resource.
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000@0
whole.ts
#EXTINF:4.0,
#EXT-X-BYTERANGE:2000
whole.ts
#EXTINF:4.0,
#EXT-X-BYTERANGE:3000
whole.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.segments.map((segment) => segment.byteRange)).toEqual([
      { offset: 0, length: 1000 },
      { offset: 1000, length: 2000 },
      { offset: 3000, length: 3000 }
    ])
  })

  it('drops a byte-range with no offset and nothing to continue from', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXTINF:4.0,
#EXT-X-BYTERANGE:1000
first.ts
#EXTINF:4.0,
second.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    // The range is undefined, so the sub-range is not recorded; the whole
    // resource is what remains, which is the only defensible reading.
    expect(playlist.segments[0]!.byteRange).toBeNull()
  })

  it('ignores an unparseable byte-range', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXTINF:4.0,
#EXT-X-BYTERANGE:not-a-number
first.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.segments[0]!.byteRange).toBeNull()
  })

  it('falls back to MPEG-2 TS for segments with no extension', () => {
    // `/seg/00042?token=…` is ordinary, and RFC 8216 §3.1 makes the transport
    // stream the format a segment is in unless an #EXT-X-MAP says otherwise.
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXTINF:4.0,
https://cdn.example.com/seg/00042?token=abc
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.container).toBe('ts')
  })

  it('recognises a packed-audio playlist', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXTINF:10.0,
one.aac
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.container).toBe('aac')
  })
})

describe('HLS playlists that are broken', () => {
  it('refuses a document with no #EXTM3U', () => {
    expect(parseHlsPlaylist('#EXTINF:9.0,\nfirst.ts\n', PLAYLIST_URL)).toEqual({
      kind: 'invalid',
      reason: 'not-a-playlist'
    })
  })

  it('refuses an empty document', () => {
    expect(parseHlsPlaylist('', PLAYLIST_URL)).toEqual({
      kind: 'invalid',
      reason: 'not-a-playlist'
    })
  })

  it('tolerates a byte-order mark before the #EXTM3U', () => {
    const playlist = parseHlsPlaylist(
      '\uFEFF#EXTM3U\n#EXTINF:4.0,\none.ts\n#EXT-X-ENDLIST\n',
      PLAYLIST_URL
    )
    expect(playlist.kind).toBe('media')
  })

  it('refuses a playlist with neither a variant nor a segment', () => {
    expect(parseHlsPlaylist('#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST\n', PLAYLIST_URL)).toEqual({
      kind: 'invalid',
      reason: 'no-entries'
    })
  })

  it('skips a URI line that no #EXTINF introduced', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
stray.ts
#EXTINF:4.0,
real.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.segments.map((segment) => segment.url)).toEqual([
      'https://example.com/hls/real.ts'
    ])
  })

  it('drops a segment whose duration is not a number', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXTINF:later,
broken.ts
#EXTINF:4.0,
real.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.segments).toHaveLength(1)
    expect(playlist.durationSeconds).toBe(4)
  })

  it('survives a truncated playlist whose last #EXTINF has no URI', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.0,
one.ts
#EXTINF:4.0,`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.segments).toHaveLength(1)
    // No #EXT-X-ENDLIST arrived, and a truncated download is indistinguishable
    // from a live playlist. Live is the safer of the two readings.
    expect(playlist.live).toBe(true)
  })

  it('skips a URI that cannot be resolved at all', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXTINF:4.0,
http://[not-a-host/one.ts
#EXTINF:4.0,
good.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.segments.map((segment) => segment.url)).toEqual([
      'https://example.com/hls/good.ts'
    ])
  })

  it('skips a variant whose URI cannot be resolved', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000
http://[not-a-host/low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2560000
mid.m3u8
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.variants.map((variant) => variant.bandwidthBitsPerSecond)).toEqual([2560000])
  })

  it('ignores an #EXT-X-MAP with no URI or an unresolvable one', () => {
    const withoutUri = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-MAP:BYTERANGE="10@0"\n#EXTINF:4.0,\none.ts\n#EXT-X-ENDLIST\n',
      PLAYLIST_URL
    )
    const withBadUri = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-MAP:URI="http://[bad/init.mp4"\n#EXTINF:4.0,\none.ts\n#EXT-X-ENDLIST\n',
      PLAYLIST_URL
    )
    if (withoutUri.kind !== 'media' || withBadUri.kind !== 'media') {
      throw new Error('expected media playlists')
    }
    expect(withoutUri.initSegment).toBeNull()
    expect(withBadUri.initSegment).toBeNull()
  })

  it('ignores a rendition whose URI cannot be resolved', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="English",URI="http://[bad/audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1280000,AUDIO="aac"
low.m3u8
`,
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.renditions).toEqual([])
  })

  it('prefers the variant list when a playlist claims to be both', () => {
    const playlist = parseHlsPlaylist(
      `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1280000
low.m3u8
#EXTINF:4.0,
segment.ts
#EXT-X-ENDLIST
`,
      PLAYLIST_URL
    )
    expect(playlist.kind).toBe('master')
  })

  it('ignores a nonsense RESOLUTION rather than reporting half of one', () => {
    const playlist = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=wide\nlow.m3u8\n',
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect([playlist.variants[0]!.width, playlist.variants[0]!.height]).toEqual([null, null])
  })

  it('ignores a nonsense BANDWIDTH', () => {
    const playlist = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=lots\nlow.m3u8\n',
      PLAYLIST_URL
    )
    if (playlist.kind !== 'master') throw new Error('expected a master')
    expect(playlist.variants[0]!.bandwidthBitsPerSecond).toBeNull()
  })

  it('ignores a negative target duration', () => {
    const playlist = parseHlsPlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:-4\n#EXTINF:4.0,\none.ts\n#EXT-X-ENDLIST\n',
      PLAYLIST_URL
    )
    if (playlist.kind !== 'media') throw new Error('expected a media playlist')
    expect(playlist.targetDurationSeconds).toBeNull()
  })
})

describe('attribute lists', () => {
  it('keeps a comma that lives inside a quoted value', () => {
    expect(
      parseAttributeList('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",AUDIO="aac"')
    ).toEqual({
      BANDWIDTH: '1280000',
      CODECS: 'avc1.4d401f,mp4a.40.2',
      AUDIO: 'aac'
    })
  })

  it('upper-cases names and trims whitespace', () => {
    expect(parseAttributeList('bandwidth=1000, resolution=640x360')).toEqual({
      BANDWIDTH: '1000',
      RESOLUTION: '640x360'
    })
  })

  it('drops a piece that is not an assignment', () => {
    expect(parseAttributeList('BANDWIDTH=1000,,DEFAULT')).toEqual({ BANDWIDTH: '1000' })
  })

  it('leaves an unterminated quote alone rather than eating a character', () => {
    expect(parseAttributeList('NAME="')).toEqual({ NAME: '"' })
  })
})

describe('key declarations', () => {
  it('reads METHOD=NONE as unencrypted', () => {
    expect(drmFromKeyAttributes({ METHOD: 'NONE' })).toEqual({ protected: false })
  })

  it('treats a key tag with no METHOD as unencrypted', () => {
    expect(drmFromKeyAttributes({})).toEqual({ protected: false })
  })

  it('names Widevine from the KEYFORMAT UUID', () => {
    // The registered system id, as HLS carries it for SAMPLE-AES-CTR.
    expect(
      drmFromKeyAttributes({
        METHOD: 'SAMPLE-AES-CTR',
        KEYFORMAT: 'urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'
      })
    ).toEqual({
      protected: true,
      scheme: 'widevine',
      detail: 'METHOD=SAMPLE-AES-CTR, KEYFORMAT=urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'
    })
  })

  it('names PlayReady from the KEYFORMAT UUID', () => {
    expect(
      drmFromKeyAttributes({
        METHOD: 'SAMPLE-AES',
        KEYFORMAT: 'urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95'
      })
    ).toMatchObject({ protected: true, scheme: 'playready' })
  })

  it('reads SAMPLE-AES with the identity key format as sample-aes', () => {
    expect(drmFromKeyAttributes({ METHOD: 'SAMPLE-AES' })).toEqual({
      protected: true,
      scheme: 'sample-aes',
      detail: 'METHOD=SAMPLE-AES'
    })
  })

  it('reports an unrecognised method as protected all the same', () => {
    // The refusal must not depend on recognising the scheme. Something is
    // encrypting the segments, and that is enough to decline.
    expect(drmFromKeyAttributes({ METHOD: 'AES-256-SOMETHING' })).toEqual({
      protected: true,
      scheme: 'unknown',
      detail: 'METHOD=AES-256-SOMETHING'
    })
  })
})
