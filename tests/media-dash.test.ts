import { describe, expect, it } from 'vitest'
import { parseDashManifest, parseIsoDuration } from '@shared/media/dash.js'
import { childrenNamed, decodeXmlEntities, descendantsNamed, parseXml } from '@shared/media/xml.js'

/**
 * DASH manifests and the XML reader underneath them.
 *
 * The fixtures follow ISO/IEC 23009-1's structure rather than being invented: the
 * `MPD` / `Period` / `AdaptationSet` / `Representation` nesting and the attribute
 * names (`@mediaPresentationDuration`, `@profiles`, `@bandwidth`, `@width`,
 * `@height`, `@codecs`, `@mimeType`) are the specification's, as is the
 * on-demand-profile shape with `SegmentBase`/`Initialization` and the
 * `ContentProtection` element with the `urn:mpeg:dash:mp4protection:2011` scheme.
 * The key-system UUIDs are the registered ones.
 *
 * What is deliberately *not* tested is segment enumeration, because the parser
 * deliberately does not do it — see the note at the top of `dash.ts`. A test
 * asserting an expanded `SegmentTemplate` would be testing a feature that would
 * then only get as far as a silent video.
 */

/**
 * The on-demand profile with two video representations — the shape ISO/IEC 23009-1
 * uses for a simple presentation, and the case a quality picker exists for.
 */
const ON_DEMAND_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011"
     profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"
     type="static"
     mediaPresentationDuration="PT0H3M1.63S"
     minBufferTime="PT1.5S">
  <Period duration="PT0H3M1.63S">
    <AdaptationSet mimeType="video/mp4" codecs="avc1.42c01e" bitstreamSwitching="true">
      <Representation id="0" width="320" height="240" startWithSAP="1" bandwidth="46986">
        <BaseURL>video-240.mp4</BaseURL>
        <SegmentBase indexRange="837-988">
          <Initialization range="0-836"/>
        </SegmentBase>
      </Representation>
      <Representation id="1" width="640" height="480" startWithSAP="1" bandwidth="91917">
        <BaseURL>video-480.mp4</BaseURL>
        <SegmentBase indexRange="837-988">
          <Initialization range="0-836"/>
        </SegmentBase>
      </Representation>
      <Representation id="2" width="1280" height="720" startWithSAP="1" bandwidth="1900000">
        <BaseURL>video-720.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4" codecs="mp4a.40.2" lang="en">
      <Representation id="audio-en" bandwidth="128000">
        <BaseURL>audio-en.mp4</BaseURL>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="text/vtt" lang="de">
      <Representation id="subs-de" bandwidth="1000">
        <BaseURL>subs-de.vtt</BaseURL>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>
`

/** The same presentation, encrypted: CENC plus a Widevine key system. */
const PROTECTED_MPD = `<?xml version="1.0" encoding="UTF-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" xmlns:cenc="urn:mpeg:cenc:2013"
     profiles="urn:mpeg:dash:profile:isoff-live:2011" type="static"
     mediaPresentationDuration="PT10M">
  <Period>
    <AdaptationSet mimeType="video/mp4" codecs="avc1.640028">
      <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"
                         cenc:default_KID="34e5db32-8625-47cd-ba06-68fca0655a72"/>
      <ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed">
        <cenc:pssh>AAAAOHBzc2gAAAAA7e+LqXnWSs6jyCfc1R0h7Q==</cenc:pssh>
      </ContentProtection>
      <Representation id="v0" width="1920" height="1080" bandwidth="4500000"/>
    </AdaptationSet>
  </Period>
</MPD>
`

describe('DASH manifests', () => {
  it('lists every audio and video representation with its quality', () => {
    const manifest = parseDashManifest(ON_DEMAND_MPD)
    if (manifest.kind !== 'manifest') throw new Error(`expected a manifest, got ${manifest.reason}`)

    expect(manifest.representations.map((one) => one.id)).toEqual(['0', '1', '2', 'audio-en'])
    expect(manifest.representations.map((one) => one.bandwidthBitsPerSecond)).toEqual([
      46986, 91917, 1900000, 128000
    ])
    expect(manifest.representations.map((one) => [one.width, one.height])).toEqual([
      [320, 240],
      [640, 480],
      [1280, 720],
      [null, null]
    ])
    expect(manifest.representations.map((one) => one.track)).toEqual([
      'video',
      'video',
      'video',
      'audio'
    ])
  })

  it('inherits mimeType, codecs and language from the AdaptationSet', () => {
    // 23009-1 lets the common properties sit on the set. A parser that read them
    // only from the Representation would report every quality as untyped.
    const manifest = parseDashManifest(ON_DEMAND_MPD)
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.representations[0]!.codecs).toBe('avc1.42c01e')
    expect(manifest.representations[0]!.mimeType).toBe('video/mp4')
    expect(manifest.representations[3]!.language).toBe('en')
  })

  it('leaves subtitles out of the qualities on offer', () => {
    const manifest = parseDashManifest(ON_DEMAND_MPD)
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.representations.map((one) => one.id)).not.toContain('subs-de')
  })

  it('reads the presentation duration and that it is not live', () => {
    const manifest = parseDashManifest(ON_DEMAND_MPD)
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.durationSeconds).toBeCloseTo(181.63, 2)
    expect(manifest.live).toBe(false)
    expect(manifest.drm.protected).toBe(false)
  })

  it('reads @type="dynamic" as live', () => {
    const manifest = parseDashManifest(
      `<MPD type="dynamic"><Period><AdaptationSet mimeType="video/mp4">
        <Representation id="v0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.live).toBe(true)
  })

  it('falls back to the Period duration when the MPD states none', () => {
    const manifest = parseDashManifest(
      `<MPD><Period duration="PT30S"><AdaptationSet contentType="video">
        <Representation id="v0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.durationSeconds).toBe(30)
  })

  it('reports no duration when neither the MPD nor the Period states one', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet contentType="audio">
        <Representation id="a0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.durationSeconds).toBeNull()
    expect(manifest.representations[0]!.track).toBe('audio')
  })

  it('names Widevine rather than the generic CENC declaration', () => {
    const manifest = parseDashManifest(PROTECTED_MPD)
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.drm).toEqual({
      protected: true,
      scheme: 'widevine',
      detail: 'schemeIdUri=urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed'
    })
  })

  it('reports encryption from mp4protection alone', () => {
    // The generic declaration without a named key system still means the segments
    // are encrypted, so it still has to be refused.
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cenc"/>
        <Representation id="v0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.drm).toEqual({
      protected: true,
      scheme: 'cenc',
      detail: 'schemeIdUri=urn:mpeg:dash:mp4protection:2011, value=cenc'
    })
  })

  it('reports an unrecognised protection scheme as protected all the same', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:uuid:00000000-0000-0000-0000-000000000000"/>
        <Representation id="v0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.drm).toEqual({
      protected: true,
      scheme: 'unknown',
      detail: 'schemeIdUri=urn:uuid:00000000-0000-0000-0000-000000000000'
    })
  })

  it('reports a ContentProtection that names no scheme at all as protected', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="video/mp4">
        <ContentProtection/>
        <Representation id="v0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.drm).toEqual({
      protected: true,
      scheme: 'unknown',
      detail: 'schemeIdUri='
    })
  })

  it('names PlayReady from its registered UUID', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:uuid:9a04f079-9840-4286-ab92-e65be0885f95"/>
        <Representation id="v0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.drm.protected && manifest.drm.scheme).toBe('playready')
  })

  it('finds protection declared on the Representation rather than the set', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="video/mp4">
        <Representation id="v0" bandwidth="1000">
          <ContentProtection schemeIdUri="urn:uuid:94ce86fb-07ff-4f43-adb8-93d2fa968ca2"/>
        </Representation></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.drm.protected && manifest.drm.scheme).toBe('fairplay')
  })

  it('ignores a nonsense bandwidth or resolution', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="video/mp4">
        <Representation id="v0" bandwidth="fast" width="wide"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.representations[0]!.bandwidthBitsPerSecond).toBeNull()
    expect(manifest.representations[0]!.width).toBeNull()
  })

  it('reports a Representation with no id rather than dropping it', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="audio/mp4">
        <Representation bandwidth="64000"/></AdaptationSet></Period></MPD>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.representations[0]!.id).toBeNull()
  })
})

describe('DASH manifests that are broken', () => {
  it('refuses something that is not XML at all', () => {
    expect(parseDashManifest('not xml')).toEqual({ kind: 'invalid', reason: 'not-an-mpd' })
  })

  it('refuses XML whose root is not an MPD', () => {
    expect(parseDashManifest('<html><body>nope</body></html>')).toEqual({
      kind: 'invalid',
      reason: 'not-an-mpd'
    })
  })

  it('refuses an MPD with no audio or video representation', () => {
    expect(
      parseDashManifest(
        `<MPD><Period><AdaptationSet mimeType="text/vtt">
          <Representation id="s0" bandwidth="1000"/></AdaptationSet></Period></MPD>`
      )
    ).toEqual({ kind: 'invalid', reason: 'no-representations' })
  })

  it('refuses an MPD that was cut off mid-element', () => {
    // A truncated download: the root opens, the content is partial. What survives
    // is parsed, and if nothing usable survived it is refused rather than
    // half-reported.
    expect(parseDashManifest('<MPD><Period><AdaptationSet mimeType="video/mp4"')).toEqual({
      kind: 'invalid',
      reason: 'no-representations'
    })
  })

  it('reads what it can from a manifest with a missing closing tag', () => {
    const manifest = parseDashManifest(
      `<MPD><Period><AdaptationSet mimeType="video/mp4">
        <Representation id="v0" bandwidth="1000"/>`
    )
    if (manifest.kind !== 'manifest') throw new Error('expected a manifest')
    expect(manifest.representations).toHaveLength(1)
  })
})

describe('xs:duration', () => {
  it('reads the forms a manifest uses', () => {
    expect(parseIsoDuration('PT0H3M1.63S')).toBeCloseTo(181.63, 2)
    expect(parseIsoDuration('PT1.5S')).toBe(1.5)
    expect(parseIsoDuration('PT10M')).toBe(600)
    expect(parseIsoDuration('P1DT2H3M4S')).toBe(93784)
    expect(parseIsoDuration(' PT30S ')).toBe(30)
  })

  it('refuses a duration with nothing in it', () => {
    expect(parseIsoDuration('P')).toBeNull()
    expect(parseIsoDuration('PT')).toBeNull()
  })

  it('refuses years and months rather than guessing their length', () => {
    expect(parseIsoDuration('P1Y')).toBeNull()
    expect(parseIsoDuration('P1M')).toBeNull()
  })

  it('refuses nonsense', () => {
    expect(parseIsoDuration('three minutes')).toBeNull()
    expect(parseIsoDuration('')).toBeNull()
  })
})

describe('the XML reader', () => {
  it('builds a tree with attributes, text and nesting', () => {
    const root = parseXml('<a x="1"><b y="2">text</b><b y="3"/></a>')
    if (root === null) throw new Error('expected a root')
    expect(root.name).toBe('a')
    expect(root.attributes).toEqual({ x: '1' })
    expect(childrenNamed(root, 'b').map((child) => child.attributes['y'])).toEqual(['2', '3'])
    expect(childrenNamed(root, 'b')[0]!.text).toBe('text')
  })

  it('accepts single-quoted attribute values', () => {
    const root = parseXml('<a x=\'1\' y="2"/>')
    expect(root?.attributes).toEqual({ x: '1', y: '2' })
  })

  it('strips namespace prefixes from names and attributes', () => {
    const root = parseXml('<MPD xmlns:cenc="urn:x"><cenc:pssh cenc:id="k">data</cenc:pssh></MPD>')
    if (root === null) throw new Error('expected a root')
    expect(descendantsNamed(root, 'pssh')).toHaveLength(1)
    expect(descendantsNamed(root, 'pssh')[0]!.attributes['id']).toBe('k')
  })

  it('decodes entities in attribute values', () => {
    // `&amp;` in a segment template is ordinary, and reading it literally
    // produces an address that 404s.
    const root = parseXml('<a href="x.mp4?a=1&amp;b=2"/>')
    expect(root?.attributes['href']).toBe('x.mp4?a=1&b=2')
  })

  it('decodes the predefined and numeric entity forms', () => {
    expect(decodeXmlEntities('&lt;&gt;&amp;&quot;&apos;')).toBe('<>&"\'')
    expect(decodeXmlEntities('&#65;&#x42;&#X43;')).toBe('ABC')
  })

  it('leaves an entity it does not know as written', () => {
    expect(decodeXmlEntities('a&nbsp;b')).toBe('a&nbsp;b')
    expect(decodeXmlEntities('&#0;')).toBe('&#0;')
    expect(decodeXmlEntities('&#99999999;')).toBe('&#99999999;')
  })

  it('discards comments, declarations, CDATA and a doctype', () => {
    const root = parseXml(
      `<?xml version="1.0"?><!DOCTYPE a><a><!-- <b/> --><c><![CDATA[<d/>]]></c></a>`
    )
    if (root === null) throw new Error('expected a root')
    expect(root.name).toBe('a')
    expect(descendantsNamed(root, 'b')).toEqual([])
    expect(descendantsNamed(root, 'd')).toEqual([])
    expect(childrenNamed(root, 'c')).toHaveLength(1)
  })

  it('returns null for a document with no element', () => {
    expect(parseXml('just words')).toBeNull()
    expect(parseXml('')).toBeNull()
  })

  it('ignores a closing tag that matches nothing open', () => {
    // Reparenting everything after it would be worse than ignoring it.
    const root = parseXml('<a><b/></c><d/></a>')
    if (root === null) throw new Error('expected a root')
    expect(root.children.map((child) => child.name)).toEqual(['b', 'd'])
  })

  it('keeps a > that lives inside an attribute value', () => {
    const root = parseXml('<a t="x>y"><b/></a>')
    if (root === null) throw new Error('expected a root')
    expect(root.attributes['t']).toBe('x>y')
    expect(root.children).toHaveLength(1)
  })

  it('closes an unclosed inner element when its parent closes', () => {
    const root = parseXml('<a><b><c>text</a>')
    if (root === null) throw new Error('expected a root')
    expect(descendantsNamed(root, 'c')).toHaveLength(1)
  })
})
