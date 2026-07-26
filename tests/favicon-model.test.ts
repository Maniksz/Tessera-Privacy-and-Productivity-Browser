import { describe, expect, it } from 'vitest'
import {
  FAVICON_MAX_AGE_MS,
  FAVICON_REJECTIONS,
  MAX_FAVICON_BYTES,
  MAX_FAVICON_SOURCE_URL_LENGTH,
  advertisedIconSize,
  chooseFaviconCandidate,
  declaredLengthOf,
  discardingFaviconCache,
  emptyFaviconCounts,
  emptyFaviconIndex,
  faviconDomainKey,
  faviconDomainOf,
  faviconIsStale,
  faviconSiteOf,
  faviconUrl,
  findFaviconEntry,
  iconCandidateRank,
  looksLikeImageType,
  putFaviconEntry,
  repairFaviconIndex,
  sniffFaviconType,
  type FaviconEntry
} from '@shared/favicons/model.js'

/**
 * The favicon rules, on their own.
 *
 * Everything here is pure, so nothing in this file touches a clock, a disk or a network.
 * The two decisions worth reading closely are which candidate gets followed — the cache
 * spends exactly one request per site, so choosing badly means the icon is simply wrong
 * for a month — and what counts as an acceptable image, which is the part that treats a
 * visited site as untrusted input.
 */

const T0 = 1_700_000_000_000

function entry(patch: Partial<FaviconEntry> = {}): FaviconEntry {
  return {
    domain: 'example.com',
    contentType: 'image/png',
    byteLength: 120,
    fetchedAt: T0,
    sourceUrl: 'https://example.com/favicon.ico',
    ...patch
  }
}

/** A body with a real signature in front, so sniffing accepts it. */
function bytesOf(signature: readonly number[], length = 32): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set(signature, 0)
  return bytes
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

describe('the cache key', () => {
  it('is the registrable domain of the page', () => {
    expect(faviconDomainOf('https://www.example.com/some/article?x=1')).toBe('example.com')
    expect(faviconDomainOf('http://blog.example.co.uk/')).toBe('example.co.uk')
  })

  it('is nothing for a page that has no site', () => {
    // A local document has no host to ask, and an internal page is ours already.
    expect(faviconDomainOf('file:///home/user/notes.html')).toBeNull()
    expect(faviconDomainOf('tessera://start')).toBeNull()
    expect(faviconDomainOf('about:blank')).toBeNull()
    expect(faviconDomainOf('not a url at all')).toBeNull()
  })

  it('refuses a host longer than DNS allows, because it becomes a file name', () => {
    const host = `${'a'.repeat(250)}.com`
    expect(host.length).toBeGreaterThan(253)
    expect(faviconDomainOf(`https://${host}/`)).toBeNull()
  })

  it('accepts an address or a bare domain for a lookup', () => {
    expect(faviconDomainKey('https://shop.example.com/cart')).toBe('example.com')
    expect(faviconDomainKey('shop.example.com')).toBe('example.com')
    expect(faviconDomainKey('')).toBeNull()
  })
})

describe('the address a renderer draws from', () => {
  it('carries the site and a version that changes when the icon does', () => {
    const url = faviconUrl(entry({ fetchedAt: T0 }))
    expect(url).toContain('site=example.com')
    expect(url).toContain(`v=${T0.toString(36)}`)
    // Without the version, a refreshed icon would keep the address Chromium already has
    // a copy of, and the old picture would stay on screen.
    expect(faviconUrl(entry({ fetchedAt: T0 + 1 }))).not.toBe(url)
  })

  it('reads the site back out for the protocol handler', () => {
    expect(faviconSiteOf(faviconUrl(entry()))).toBe('example.com')
    expect(faviconSiteOf(faviconUrl(entry({ domain: 'example.co.uk' })))).toBe('example.co.uk')
  })

  it('answers nothing for an address that names no site', () => {
    expect(faviconSiteOf('tessera://favicon')).toBeNull()
    expect(faviconSiteOf('nonsense')).toBeNull()
  })
})

describe('choosing which candidate to follow', () => {
  it('reads the size a candidate advertises', () => {
    expect(advertisedIconSize('https://e.example/favicon-32x32.png')).toBe(32)
    expect(advertisedIconSize('https://e.example/icons/icon_192.png')).toBe(192)
    expect(advertisedIconSize('https://e.example/apple-touch-icon.png')).toBe(180)
    expect(advertisedIconSize('https://e.example/favicon.ico')).toBe(0)
  })

  it('treats an unadvertised candidate as middling rather than smallest', () => {
    // A bare favicon.ico usually holds 32 and 48 px images, so it is a better source for
    // a start-page card than a link that explicitly says 16.
    expect(iconCandidateRank('https://e.example/favicon.ico')).toBeGreaterThan(
      iconCandidateRank('https://e.example/favicon-16x16.png')
    )
  })

  it('prefers the largest useful candidate', () => {
    const chosen = chooseFaviconCandidate([
      'https://e.example/favicon-16x16.png',
      'https://e.example/favicon.ico',
      'https://e.example/apple-touch-icon.png'
    ])
    expect(chosen).toBe('https://e.example/apple-touch-icon.png')
  })

  it('ranks an oversized candidate below every usable one', () => {
    // A 1024 px icon is the candidate most likely to blow the byte cap, and there is
    // only one request to spend.
    const chosen = chooseFaviconCandidate([
      'https://e.example/icon-1024.png',
      'https://e.example/favicon.ico'
    ])
    expect(chosen).toBe('https://e.example/favicon.ico')
    // Still ordered among themselves, so the least bad wins when that is all there is.
    expect(iconCandidateRank('https://e.example/icon-512.png')).toBeGreaterThan(
      iconCandidateRank('https://e.example/icon-1024.png')
    )
  })

  it('keeps the page order when two candidates rank the same', () => {
    expect(
      chooseFaviconCandidate(['https://e.example/a.ico', 'https://e.example/b.ico'])
    ).toBe('https://e.example/a.ico')
  })

  it('follows nothing but http and https', () => {
    expect(
      chooseFaviconCandidate([
        'data:image/png;base64,iVBORw0KGgo=',
        'blob:https://e.example/1234',
        'javascript:void 0'
      ])
    ).toBeNull()
    expect(chooseFaviconCandidate([])).toBeNull()
    expect(chooseFaviconCandidate(['://broken'])).toBeNull()
  })

  it('refuses a candidate address longer than the store would keep', () => {
    const long = `https://e.example/${'a'.repeat(MAX_FAVICON_SOURCE_URL_LENGTH)}.png`
    expect(chooseFaviconCandidate([long])).toBeNull()
    // And it does not take the whole list down with it.
    expect(chooseFaviconCandidate([long, 'https://e.example/favicon.ico'])).toBe(
      'https://e.example/favicon.ico'
    )
  })
})

describe('judging a response before reading it', () => {
  it('accepts an image type and refuses a page', () => {
    expect(looksLikeImageType('image/png')).toBe(true)
    expect(looksLikeImageType('IMAGE/PNG; charset=binary')).toBe(true)
    // The common failure: a soft 404 answering with the site's error page.
    expect(looksLikeImageType('text/html; charset=utf-8')).toBe(false)
    expect(looksLikeImageType('application/json')).toBe(false)
  })

  it('accepts a missing or empty type, because the bytes decide anyway', () => {
    // Plenty of servers send no type at all for a .ico file; refusing on a header nobody
    // guarantees would drop real icons.
    expect(looksLikeImageType(null)).toBe(true)
    expect(looksLikeImageType('')).toBe(true)
  })

  it('reads a claimed length, and nothing else', () => {
    expect(declaredLengthOf('4096')).toBe(4096)
    expect(declaredLengthOf(' 4096 ')).toBe(4096)
    expect(declaredLengthOf(null)).toBeNull()
    expect(declaredLengthOf('a lot')).toBeNull()
    expect(declaredLengthOf('-5')).toBeNull()
    expect(declaredLengthOf('1e30')).toBeNull()
  })
})

describe('what the bytes actually are', () => {
  it('recognises every accepted format', () => {
    expect(sniffFaviconType(bytesOf(PNG))).toBe('image/png')
    expect(sniffFaviconType(bytesOf([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(sniffFaviconType(bytesOf([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniffFaviconType(bytesOf([0x00, 0x00, 0x01, 0x00, 0x01]))).toBe('image/x-icon')

    const webp = bytesOf([0x52, 0x49, 0x46, 0x46])
    webp.set([0x57, 0x45, 0x42, 0x50], 8)
    expect(sniffFaviconType(webp)).toBe('image/webp')
  })

  it('refuses a RIFF container that is not WebP', () => {
    // A WAV file starts the same way; only the tag at offset 8 separates them.
    const wav = bytesOf([0x52, 0x49, 0x46, 0x46])
    wav.set([0x57, 0x41, 0x56, 0x45], 8)
    expect(sniffFaviconType(wav)).toBeNull()
  })

  it('refuses a cursor, which shares the icon header', () => {
    expect(sniffFaviconType(bytesOf([0x00, 0x00, 0x02, 0x00, 0x01]))).toBeNull()
  })

  it('refuses an SVG, deliberately', () => {
    // An SVG is a document that may carry script and reference external resources.
    // Drawing one inside the browser's own interface would reintroduce exactly the
    // third-party requests this cache exists to prevent.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
    expect(sniffFaviconType(svg)).toBeNull()
  })

  it('refuses a body too short to be anything, without reading past its end', () => {
    expect(sniffFaviconType(new Uint8Array(0))).toBeNull()
    expect(sniffFaviconType(new Uint8Array([0x89, 0x50]))).toBeNull()
    // A truncated RIFF header stops at the length check rather than the tag.
    expect(sniffFaviconType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull()
  })

  it('refuses an HTML page that claimed to be an image', () => {
    const html = new TextEncoder().encode('<!doctype html><title>Not found</title>')
    expect(sniffFaviconType(html)).toBeNull()
  })
})

describe('aging', () => {
  it('holds an icon current for a month', () => {
    expect(faviconIsStale(entry(), T0)).toBe(false)
    expect(faviconIsStale(entry(), T0 + FAVICON_MAX_AGE_MS - 1)).toBe(false)
    expect(faviconIsStale(entry(), T0 + FAVICON_MAX_AGE_MS)).toBe(true)
  })

  it('takes a custom age, which is how the tests avoid waiting a month', () => {
    expect(faviconIsStale(entry(), T0 + 500, 1_000)).toBe(false)
    expect(faviconIsStale(entry(), T0 + 1_000, 1_000)).toBe(true)
  })

  it('treats a timestamp from the future as stale', () => {
    // A copied profile, a resumed laptop or an NTP correction all produce one, and the
    // other reading would pin a wrong icon in place for a month plus the jump.
    expect(faviconIsStale(entry({ fetchedAt: T0 + 1 }), T0)).toBe(true)
  })
})

describe('the index', () => {
  it('starts empty and versioned', () => {
    expect(emptyFaviconIndex()).toEqual({ version: 1, icons: [] })
  })

  it('keeps one entry per site, most recently retrieved first', () => {
    const first = putFaviconEntry([], entry({ domain: 'a.example', fetchedAt: T0 }))
    const second = putFaviconEntry(first.icons, entry({ domain: 'b.example', fetchedAt: T0 + 10 }))
    expect(second.icons.map((icon) => icon.domain)).toEqual(['b.example', 'a.example'])
    expect(second.evicted).toEqual([])
  })

  it('replaces a site rather than adding a second copy', () => {
    const first = putFaviconEntry([], entry({ fetchedAt: T0, byteLength: 100 }))
    const second = putFaviconEntry(first.icons, entry({ fetchedAt: T0 + 10, byteLength: 200 }))
    expect(second.icons).toHaveLength(1)
    expect(second.icons.at(0)?.byteLength).toBe(200)
  })

  it('reports what the cap pushed out, because each entry has a file behind it', () => {
    const one = putFaviconEntry([], entry({ domain: 'a.example', fetchedAt: T0 }), 2)
    const two = putFaviconEntry(one.icons, entry({ domain: 'b.example', fetchedAt: T0 + 1 }), 2)
    const three = putFaviconEntry(two.icons, entry({ domain: 'c.example', fetchedAt: T0 + 2 }), 2)

    expect(three.icons.map((icon) => icon.domain)).toEqual(['c.example', 'b.example'])
    // The least recently retrieved goes, and comes back so its file can be removed.
    expect(three.evicted.map((icon) => icon.domain)).toEqual(['a.example'])
  })

  it('finds a site by address or by domain, and nothing by nonsense', () => {
    const icons = [entry({ domain: 'example.com' })]
    expect(findFaviconEntry(icons, 'https://www.example.com/x')?.domain).toBe('example.com')
    expect(findFaviconEntry(icons, 'example.com')?.domain).toBe('example.com')
    expect(findFaviconEntry(icons, 'other.org')).toBeNull()
    expect(findFaviconEntry(icons, '')).toBeNull()
  })

  it('cannot be talked into finding a file outside the cache', () => {
    // The key is only ever compared against the index, never joined into a path, so a
    // crafted value finds nothing at all.
    const icons = [entry()]
    expect(findFaviconEntry(icons, '../../etc/passwd')).toBeNull()
    expect(findFaviconEntry(icons, '/etc/passwd')).toBeNull()
  })
})

describe('repairing a loaded index', () => {
  it('keeps the newer of two entries for one site, in either order', () => {
    const older = entry({ fetchedAt: T0, byteLength: 100 })
    const newer = entry({ fetchedAt: T0 + 10, byteLength: 200 })
    expect(repairFaviconIndex([older, newer]).map((icon) => icon.byteLength)).toEqual([200])
    expect(repairFaviconIndex([newer, older]).map((icon) => icon.byteLength)).toEqual([200])
  })

  it('restores the order and the cap the write path maintains', () => {
    const icons = [
      entry({ domain: 'a.example', fetchedAt: T0 }),
      entry({ domain: 'b.example', fetchedAt: T0 + 20 }),
      entry({ domain: 'c.example', fetchedAt: T0 + 10 })
    ]
    expect(repairFaviconIndex(icons).map((icon) => icon.domain)).toEqual([
      'b.example',
      'c.example',
      'a.example'
    ])
    expect(repairFaviconIndex(icons, 2).map((icon) => icon.domain)).toEqual([
      'b.example',
      'c.example'
    ])
  })
})

describe('the cache a private window holds', () => {
  it('does nothing and says why', async () => {
    // Structural, not conventional: this object has no store, no directory and no
    // fetcher, so a call site that forgets to check cannot leak an icon.
    const outcome = await discardingFaviconCache.ensure('https://secret.example/', [
      'https://secret.example/favicon.ico'
    ])
    expect(outcome).toEqual({ kind: 'rejected', reason: 'private-mode' })
  })
})

describe('the counters', () => {
  it('starts every reason at zero, so a rejection can only be visible', () => {
    const counts = emptyFaviconCounts()
    expect(counts).toMatchObject({ requests: 0, stored: 0, reused: 0, kept: 0 })
    for (const reason of FAVICON_REJECTIONS) {
      expect(counts.rejected[reason], reason).toBe(0)
    }
  })

  it('bounds an icon at 64 KiB', () => {
    // Named here so a change to the constant is a change to a test as well.
    expect(MAX_FAVICON_BYTES).toBe(65_536)
  })
})
