import { describe, expect, it } from 'vitest'
import { classifyMediaRequest, normalizeContentType } from '@shared/media/detect.js'
import {
  extensionForContainer,
  isRetrievableUrl,
  mediaFileNameFor,
  mediaLabelFor,
  numberedFileName,
  pathExtensionOf,
  resolveMediaUrl
} from '@shared/media/url.js'

/**
 * What counts as media, and what the file ends up called.
 *
 * The case that drives the design is the extension-less one: a CDN address such as
 * `/v/9d2f?token=…` is an `.mp4` and says so only in its `Content-Type`. Both
 * signals therefore have to work on their own, and each has to be able to overrule
 * the other in the direction where it knows more.
 */

function classify(url: string, resourceType = 'media', contentType: string | null = null) {
  return classifyMediaRequest({ url, resourceType, contentType })
}

describe('recognising media by address', () => {
  it('recognises the progressive containers', () => {
    expect(classify('https://example.com/clip.mp4')?.kind).toBe('progressive')
    expect(classify('https://example.com/clip.mp4')?.container).toBe('mp4')
    expect(classify('https://example.com/clip.m4v')?.container).toBe('mp4')
    expect(classify('https://example.com/clip.webm')?.container).toBe('webm')
    expect(classify('https://example.com/talk.m4a')?.container).toBe('m4a')
    expect(classify('https://example.com/talk.mp3')?.container).toBe('mp3')
    expect(classify('https://example.com/talk.oga')?.container).toBe('ogg')
    expect(classify('https://example.com/clip.mov')?.container).toBe('mov')
  })

  it('recognises HLS and DASH manifests', () => {
    expect(classify('https://example.com/master.m3u8', 'xhr')?.kind).toBe('hls')
    expect(classify('https://example.com/master.m3u', 'xhr')?.kind).toBe('hls')
    expect(classify('https://example.com/manifest.mpd', 'xhr')?.kind).toBe('dash')
    // The container is not knowable from the address; the parsed manifest decides.
    expect(classify('https://example.com/master.m3u8', 'xhr')?.container).toBe('unknown')
  })

  it('ignores the query string when reading the extension', () => {
    // Signed media URLs are the normal case, and `endsWith('.m3u8')` fails on
    // every one of them.
    expect(classify('https://cdn.example.com/master.m3u8?token=abc&e=123', 'xhr')?.kind).toBe('hls')
    // The other direction: an extension that only appears in a parameter belongs
    // to the parameter, not to the bytes.
    expect(classify('https://example.com/watch?file=clip.mp4', 'mainFrame')).toBeNull()
  })

  it('does not treat a segment as a file of its own', () => {
    // A ten-minute stream is a few thousand of these. Listing them would bury the
    // one entry the user is looking for.
    expect(classify('https://example.com/seg/00042.ts')).toBeNull()
    expect(classify('https://example.com/seg/00042.m4s')).toBeNull()
    expect(classify('https://example.com/seg/00042', 'media', 'video/mp2t')).toBeNull()
  })
})

describe('recognising media by content type', () => {
  it('recognises an extension-less address from its content type', () => {
    const found = classify('https://cdn.example.com/v/9d2f?token=abc', 'media', 'video/mp4')
    expect(found?.kind).toBe('progressive')
    expect(found?.container).toBe('mp4')
  })

  it('ignores content-type parameters and casing', () => {
    expect(
      classify('https://cdn.example.com/v/1', 'media', 'VIDEO/MP4; codecs="avc1.42E01E"')?.container
    ).toBe('mp4')
    expect(normalizeContentType('  Application/DASH+XML ; charset=utf-8 ')).toBe(
      'application/dash+xml'
    )
    expect(normalizeContentType(null)).toBeNull()
    expect(normalizeContentType('   ')).toBeNull()
  })

  it('recognises every spelling of an HLS playlist', () => {
    for (const type of [
      'application/vnd.apple.mpegurl',
      'application/x-mpegurl',
      'application/mpegurl',
      'audio/mpegurl',
      'audio/x-mpegurl'
    ]) {
      expect(classify('https://cdn.example.com/p/1', 'xhr', type)?.kind, type).toBe('hls')
    }
  })

  it('recognises a DASH manifest from its content type', () => {
    expect(classify('https://cdn.example.com/m/1', 'xhr', 'application/dash+xml')?.kind).toBe(
      'dash'
    )
  })

  it('lets the content type overrule the extension', () => {
    // The server saying what the bytes are beats a guess from the address. A
    // `.mp4` that answers with a playlist is a playlist.
    const found = classify('https://example.com/clip.mp4', 'xhr', 'application/x-mpegurl')
    expect(found?.kind).toBe('hls')
  })

  it('ignores a content type that means nothing', () => {
    expect(classify('https://example.com/download', 'other', 'application/octet-stream')).toBeNull()
    expect(classify('https://example.com/page', 'mainFrame', 'text/html')).toBeNull()
  })

  it('recognises the audio containers by content type', () => {
    expect(classify('https://example.com/a/1', 'media', 'audio/mpeg')?.container).toBe('mp3')
    expect(classify('https://example.com/a/2', 'media', 'audio/mp4')?.container).toBe('m4a')
    expect(classify('https://example.com/a/3', 'media', 'audio/ogg')?.container).toBe('ogg')
    expect(classify('https://example.com/a/4', 'media', 'video/quicktime')?.container).toBe('mov')
  })
})

describe('what is never media', () => {
  it('refuses a resource type whose bytes cannot be media', () => {
    for (const resourceType of ['stylesheet', 'script', 'image', 'font', 'ping', 'webSocket']) {
      expect(classify('https://example.com/clip.mp4', resourceType), resourceType).toBeNull()
    }
  })

  it('refuses an address the session cannot re-request', () => {
    // A `blob:` URL is bytes the page already holds. There is nothing to fetch,
    // so offering a download would offer something that cannot work.
    expect(classify('blob:https://example.com/9d2f-4c', 'media')).toBeNull()
    expect(classify('data:video/mp4;base64,AAAA', 'media')).toBeNull()
    expect(classify('file:///Users/someone/clip.mp4', 'media')).toBeNull()
    expect(classify('not a url at all', 'media')).toBeNull()
  })

  it('does not invent a finding from the resource type alone', () => {
    // `resourceType: 'media'` with no container is what a page assembling its own
    // buffer issues once per segment. There is also nothing to name the file.
    expect(classify('https://cdn.example.com/chunk/00042', 'media')).toBeNull()
  })

  it('allows a top-level navigation straight to a media file', () => {
    expect(classify('https://example.com/clip.mp4', 'mainFrame')?.kind).toBe('progressive')
  })
})

describe('addresses and file names', () => {
  it('reads the extension from the path only', () => {
    expect(pathExtensionOf('https://example.com/a/b/clip.MP4?x=1')).toBe('mp4')
    expect(pathExtensionOf('https://example.com/a/b/clip')).toBe('')
    expect(pathExtensionOf('https://example.com/')).toBe('')
    expect(pathExtensionOf('https://example.com/.hidden')).toBe('')
    expect(pathExtensionOf('nonsense')).toBe('')
  })

  it('knows which addresses can be re-requested', () => {
    expect(isRetrievableUrl('http://example.com/a')).toBe(true)
    expect(isRetrievableUrl('https://example.com/a')).toBe(true)
    expect(isRetrievableUrl('blob:https://example.com/x')).toBe(false)
    expect(isRetrievableUrl('   ')).toBe(false)
  })

  it('resolves a reference against a playlist address', () => {
    const base = 'https://example.com/hls/v/master.m3u8'
    expect(resolveMediaUrl(base, 'seg.ts')).toBe('https://example.com/hls/v/seg.ts')
    expect(resolveMediaUrl(base, '../other/seg.ts')).toBe('https://example.com/hls/other/seg.ts')
    expect(resolveMediaUrl(base, '/root.ts')).toBe('https://example.com/root.ts')
    expect(resolveMediaUrl(base, '//cdn.example.com/x.ts')).toBe('https://cdn.example.com/x.ts')
    expect(resolveMediaUrl(base, 'http://[bad')).toBeNull()
  })

  it('names the file after the container, not after the address', () => {
    // An HLS download comes from `master.m3u8` and is a `.ts` file when it lands.
    expect(mediaFileNameFor('https://example.com/hls/master.m3u8', 'ts')).toBe('master.ts')
    expect(mediaFileNameFor('https://example.com/manifest.mpd', 'mp4')).toBe('manifest.mp4')
    expect(mediaFileNameFor('https://example.com/clip.mp4', 'mp4')).toBe('clip.mp4')
    expect(mediaFileNameFor('https://example.com/v/9d2f?token=abc', 'unknown')).toBe('9d2f.bin')
  })

  it('decodes and sanitises the name it takes from an address', () => {
    expect(mediaFileNameFor('https://example.com/Big%20Buck%20Bunny.mp4', 'mp4')).toBe(
      'Big Buck Bunny.mp4'
    )
    /*
      Anything that could steer a path is replaced; a name is a name, not a route.

      `%2F` is the case that matters. The URL parser leaves it encoded — decoding
      it would change the structure of the address — so it survives to the point
      where this function decodes the segment, and a path separator would then be
      sitting in a string about to be joined onto a directory.
    */
    expect(mediaFileNameFor('https://example.com/a%2Fb.mp4', 'mp4')).toBe('a_b.mp4')
    // A segment that is nothing but traversal reduces to nothing, and nothing
    // becomes the neutral name rather than an empty one.
    expect(mediaFileNameFor('https://example.com/a/..%2F..%2Fetc%2Fpasswd', 'mp4')).toBe(
      'media.mp4'
    )
    // A name made only of characters outside the accepted set reduces to nothing,
    // and the leading separator it would otherwise start with is stripped too.
    expect(mediaFileNameFor('https://example.com/%E2%98%85.mp4', 'mp4')).toBe('media.mp4')
    expect(mediaFileNameFor('https://example.com/%E2%98%85clip.mp4', 'mp4')).toBe('clip.mp4')
    // A stray `%` makes the segment undecodable; the encoded form is kept rather
    // than the name being lost over it.
    expect(mediaFileNameFor('https://example.com/a/%ZZclip.mp4', 'mp4')).toBe('ZZclip.mp4')
  })

  it('falls back to a neutral name when the address carries none', () => {
    expect(mediaFileNameFor('https://example.com/', 'mp4')).toBe('media.mp4')
    expect(mediaFileNameFor('https://example.com/....mp4', 'mp4')).toBe('media.mp4')
    expect(mediaFileNameFor('not a url', 'mp4')).toBe('media.mp4')
  })

  it('caps the length of a name taken from an address', () => {
    const long = `https://example.com/${'a'.repeat(300)}.mp4`
    expect(mediaFileNameFor(long, 'mp4').length).toBeLessThanOrEqual(84)
  })

  it('keeps the site’s own extension in the label the user sees', () => {
    // The label has to match what is on the page; the output name has to match
    // the container. They are different jobs.
    expect(mediaLabelFor('https://example.com/hls/master.m3u8?t=1')).toBe('master.m3u8')
    expect(mediaLabelFor('https://cdn.example.com/v/9d2f')).toBe('9d2f')
  })

  it('numbers a name that is already taken', () => {
    expect(numberedFileName('clip.mp4', 1)).toBe('clip.mp4')
    expect(numberedFileName('clip.mp4', 3)).toBe('clip-3.mp4')
    expect(numberedFileName('clip', 2)).toBe('clip-2')
    expect(numberedFileName('.hidden', 2)).toBe('.hidden-2')
  })

  it('has an extension for every container', () => {
    expect(extensionForContainer('ts')).toBe('ts')
    expect(extensionForContainer('aac')).toBe('aac')
    expect(extensionForContainer('unknown')).toBe('bin')
  })
})
