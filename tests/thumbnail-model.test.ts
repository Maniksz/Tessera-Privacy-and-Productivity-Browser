import { describe, expect, it } from 'vitest'
import {
  MAX_THUMBNAIL_ENTRIES,
  MAX_THUMBNAIL_TITLE_LENGTH,
  THUMBNAIL_MAX_AGE_MS,
  THUMBNAIL_SETTLE_DELAY_MS,
  THUMBNAIL_TARGET,
  discardingThumbnailCapturer,
  emptyThumbnailCounts,
  emptyThumbnailIndex,
  findThumbnailEntry,
  planThumbnail,
  putThumbnailEntry,
  repairThumbnailIndex,
  thumbnailAlternative,
  thumbnailIsStale,
  thumbnailKeyOf,
  thumbnailPageOf,
  thumbnailSiteOf,
  thumbnailTitleOf,
  thumbnailUrl,
  type ThumbnailEntry,
  type ThumbnailSize
} from '@shared/thumbnails/model.js'

/**
 * The thumbnail rules, without a clock, a camera or a disk.
 *
 * Everything here is a pure function, which is the point of the division: the
 * decisions worth arguing about — what a page's identity is, what gets cropped away,
 * what a screen reader is told — are decided in functions a test can call directly,
 * and the store is left with the parts that need the world.
 */

const T0 = 1_700_000_000_000

function entry(overrides: Partial<ThumbnailEntry> = {}): ThumbnailEntry {
  return {
    url: 'https://example.com/',
    title: 'Example',
    width: 480,
    height: 300,
    byteLength: 24_000,
    capturedAt: T0,
    ...overrides
  }
}

describe('what a page is identified by', () => {
  it('keeps the address, because the picture is of a page and not of a site', () => {
    // The opposite of the favicon cache, deliberately: an icon belongs to the site,
    // a screenshot belongs to the page.
    expect(thumbnailKeyOf('https://example.com/docs/intro')).toBe(
      'https://example.com/docs/intro'
    )
    expect(thumbnailKeyOf('https://example.com/a')).not.toBe(thumbnailKeyOf('https://example.com/b'))
  })

  it('treats one document as one picture, however it was linked to', () => {
    // The fragment names a place inside the same document, and a campaign parameter
    // names how the user arrived. Neither changes what a screenshot would show.
    expect(thumbnailKeyOf('https://example.com/post#comments')).toBe('https://example.com/post')
    expect(thumbnailKeyOf('https://example.com/post?utm_source=newsletter')).toBe(
      'https://example.com/post'
    )
    expect(thumbnailKeyOf('https://example.com/post?id=7&utm_campaign=x')).toBe(
      'https://example.com/post?id=7'
    )
  })

  it('refuses everything that is not a site page', () => {
    // `file:` is the interesting one: history keeps those, and this deliberately does
    // not. A screenshot of a local document is a copy of it in the cache directory.
    expect(thumbnailKeyOf('file:///Users/someone/tax-return.pdf')).toBeNull()
    expect(thumbnailKeyOf('tessera://start')).toBeNull()
    expect(thumbnailKeyOf('about:blank')).toBeNull()
    expect(thumbnailKeyOf('data:text/html,<p>hi')).toBeNull()
    expect(thumbnailKeyOf('not a url at all')).toBeNull()
    expect(thumbnailKeyOf('')).toBeNull()
  })

  it('refuses an address longer than anything agrees on', () => {
    const long = `https://example.com/${'a'.repeat(2100)}`
    expect(thumbnailKeyOf(long)).toBeNull()
  })

  it('names the site an entry belongs to, and admits when it cannot', () => {
    expect(thumbnailSiteOf('https://blog.example.co.uk/post')).toBe('example.co.uk')
    // Entries come back from a file a user can edit, so this really can fail.
    expect(thumbnailSiteOf('nonsense')).toBeNull()
  })

  it('collapses a title the way a page delivers it', () => {
    expect(thumbnailTitleOf('  Example\n\tPage  ')).toBe('Example Page')
    expect(thumbnailTitleOf('x'.repeat(400))).toHaveLength(MAX_THUMBNAIL_TITLE_LENGTH)
    expect(thumbnailTitleOf('   ')).toBe('')
  })
})

describe('the address a renderer draws from', () => {
  it('carries a version, so a new picture is a new address', () => {
    const first = thumbnailUrl(entry())
    const second = thumbnailUrl(entry({ capturedAt: T0 + 1 }))

    expect(first).toContain('thumbnail')
    expect(first).not.toBe(second)
    // The file name is stable per page, so without the version Chromium would go on
    // drawing the copy in its memory cache and the card would never update.
    expect(thumbnailPageOf(first)).toBe('https://example.com/')
    expect(thumbnailPageOf(second)).toBe('https://example.com/')
  })

  it('survives a page address with a query of its own', () => {
    const url = thumbnailUrl(entry({ url: 'https://example.com/search?q=a%20b&page=2' }))
    expect(thumbnailPageOf(url)).toBe('https://example.com/search?q=a%20b&page=2')
  })

  it('cannot be steered anywhere by a crafted address', () => {
    // An internal page is reachable from a link, so this string is untrusted input. It
    // is normalised into a key that is only ever compared against the index.
    expect(thumbnailPageOf('tessera://thumbnail?url=../../etc/passwd')).toBeNull()
    expect(thumbnailPageOf('tessera://thumbnail?url=file:///etc/passwd')).toBeNull()
    expect(thumbnailPageOf('tessera://thumbnail')).toBeNull()
    expect(thumbnailPageOf('nonsense')).toBeNull()
  })
})

describe('fitting a window into a card', () => {
  const target: Readonly<ThumbnailSize> = { width: 480, height: 300 }

  it('scales a normal window down and takes nothing off it', () => {
    // 1600×1000 is already 16:10, so there is nothing to crop — and asking the platform
    // to crop an image to its own bounds is work for no reason.
    const plan = planThumbnail({ width: 1600, height: 1000 }, target)
    expect(plan).toEqual({ crop: null, resize: target, size: target })
  })

  it('takes the top of a page that is taller than the card', () => {
    const plan = planThumbnail({ width: 1440, height: 2400 }, target)
    // The header, the logo, the headline: the part that makes a page recognisable. The
    // bottom of a long page is whatever happened to be below the fold.
    expect(plan?.crop).toEqual({ x: 0, y: 0, width: 1440, height: 900 })
    expect(plan?.size).toEqual(target)
  })

  it('takes a centred column out of an ultrawide window', () => {
    const plan = planThumbnail({ width: 3440, height: 1000 }, target)
    // Centred rather than left-anchored: a very wide window usually has the page in the
    // middle with margins either side.
    expect(plan?.crop).toEqual({ x: 920, y: 0, width: 1600, height: 1000 })
    expect(plan?.size).toEqual(target)
  })

  it('never invents pixels for a small window', () => {
    const plan = planThumbnail({ width: 320, height: 240 }, target)
    // Cropped to the card's proportions but not stretched to its size: upscaling would
    // spend three times the bytes on pixels nobody photographed.
    expect(plan).toEqual({
      crop: { x: 0, y: 0, width: 320, height: 200 },
      resize: null,
      size: { width: 320, height: 200 }
    })
  })

  it('stores nothing larger than the card, whatever the window was', () => {
    // The invariant the persistence schema asserts, checked across the shapes a real
    // window takes: phone-sized, square, portrait, ultrawide, 4K.
    const shapes: ThumbnailSize[] = [
      { width: 390, height: 844 },
      { width: 800, height: 800 },
      { width: 1024, height: 1366 },
      { width: 3440, height: 1440 },
      { width: 3840, height: 2160 },
      { width: 1, height: 1 }
    ]
    for (const shape of shapes) {
      const plan = planThumbnail(shape, THUMBNAIL_TARGET)
      expect(plan, `${shape.width}x${shape.height}`).not.toBeNull()
      expect(plan!.size.width).toBeLessThanOrEqual(THUMBNAIL_TARGET.width)
      expect(plan!.size.height).toBeLessThanOrEqual(THUMBNAIL_TARGET.height)
    }
  })

  it('gives up on a window with no usable size', () => {
    // A view that has never painted reports one of these. It is a normal thing to
    // happen rather than a fault, so it is an answer and not a throw.
    const degenerate: ThumbnailSize[] = [
      { width: Number.NaN, height: 300 },
      { width: 480, height: Number.NaN },
      { width: 0, height: 300 },
      { width: 480, height: 0 },
      { width: -480, height: 300 },
      { width: Number.POSITIVE_INFINITY, height: 300 }
    ]
    for (const size of degenerate) {
      expect(planThumbnail(size, target), `${size.width}x${size.height}`).toBeNull()
    }
  })
})

describe('what a screen reader is told', () => {
  it('says what the page is, never its address', () => {
    const alternative = thumbnailAlternative(
      entry({ url: 'https://news.example.com/2026/07/a-long-slug?ref=x', title: 'Hacker News' }),
      ''
    )
    expect(alternative).toEqual({ text: 'Hacker News', reason: 'describes' })
    // The failure this rules out: a screen reader spelling out punctuation for ten
    // seconds while the listener waits to find out what the card is.
    expect(alternative.text).not.toContain('http')
  })

  it('falls back to the site when the page reported no title', () => {
    expect(thumbnailAlternative(entry({ title: '' }), '')).toEqual({
      text: 'example.com',
      reason: 'describes'
    })
  })

  it('stays silent when the card already says it', () => {
    // An image inside a link labelled "Wikipedia" must not also announce "Wikipedia":
    // the listener hears it twice and cannot tell whether there are two links.
    expect(thumbnailAlternative(entry({ title: 'Wikipedia' }), 'Wikipedia')).toEqual({
      text: '',
      reason: 'duplicate'
    })
    expect(thumbnailAlternative(entry({ title: 'wikipedia' }), '  Wikipedia ')).toEqual({
      text: '',
      reason: 'duplicate'
    })
    // Containment both ways: the same duplication with extra words is still duplication.
    expect(thumbnailAlternative(entry({ title: 'GitHub · Where software is built' }), 'GitHub'))
      .toEqual({ text: '', reason: 'duplicate' })
    expect(thumbnailAlternative(entry({ title: 'GitHub' }), 'GitHub · my starred repos')).toEqual({
      text: '',
      reason: 'duplicate'
    })
  })

  it('adds the title when the card label is something else entirely', () => {
    // A renamed card — the user called it "Work", the page calls itself something
    // useful. Here the image genuinely carries information the label does not.
    expect(thumbnailAlternative(entry({ title: 'Jira — Sprint board' }), 'Work')).toEqual({
      text: 'Jira — Sprint board',
      reason: 'describes'
    })
  })

  it('admits when it knows nothing rather than inventing filler', () => {
    // Both are gone: no title, and an address the URL parser cannot read — which a
    // hand-edited index can produce, since the schema only asks for a non-empty string.
    expect(thumbnailAlternative({ url: 'not-a-url', title: '' }, 'Work')).toEqual({
      text: '',
      reason: 'nothing-to-say'
    })
  })
})

describe('aging', () => {
  it('is current until the window closes, then wants a new picture', () => {
    expect(thumbnailIsStale(entry(), T0)).toBe(false)
    expect(thumbnailIsStale(entry(), T0 + THUMBNAIL_MAX_AGE_MS - 1)).toBe(false)
    expect(thumbnailIsStale(entry(), T0 + THUMBNAIL_MAX_AGE_MS)).toBe(true)
    expect(thumbnailIsStale(entry(), T0 + 500, 100)).toBe(true)
  })

  it('treats a picture from the future as stale', () => {
    // A profile copied between machines, a resume from suspend, an NTP correction. The
    // other reading would pin a wrong picture in place for a week plus the clock jump.
    expect(thumbnailIsStale(entry({ capturedAt: T0 + 1 }), T0)).toBe(true)
  })

  it('has a settle delay and a size the wiring can read', () => {
    // Named constants rather than numbers spread through the wiring: the delay is the
    // whole "when" decision, and the size is what the card is drawn at.
    expect(THUMBNAIL_SETTLE_DELAY_MS).toBeGreaterThan(0)
    expect(THUMBNAIL_TARGET).toEqual({ width: 480, height: 300 })
  })
})

describe('the index', () => {
  it('starts empty, with counters for every way a capture can fail', () => {
    expect(emptyThumbnailIndex()).toEqual({ version: 1, shots: [] })
    const counts = emptyThumbnailCounts()
    expect(counts).toMatchObject({ captures: 0, stored: 0, fresh: 0, kept: 0 })
    expect(Object.values(counts.rejected).every((value) => value === 0)).toBe(true)
  })

  it('replaces a page rather than accumulating pictures of it', () => {
    const first = entry({ capturedAt: T0 })
    const second = entry({ capturedAt: T0 + 10, byteLength: 30_000 })
    const change = putThumbnailEntry([first], second)

    expect(change.shots).toEqual([second])
    expect(change.evicted).toEqual([])
  })

  it('keeps the most recent first and reports what the cap pushed out', () => {
    const old = entry({ url: 'https://old.example/', capturedAt: T0 })
    const middle = entry({ url: 'https://middle.example/', capturedAt: T0 + 10 })
    const fresh = entry({ url: 'https://fresh.example/', capturedAt: T0 + 20 })

    const change = putThumbnailEntry([old, middle], fresh, 2)
    expect(change.shots.map((shot) => shot.url)).toEqual([
      'https://fresh.example/',
      'https://middle.example/'
    ])
    // Returned rather than dropped silently: each one has a file behind it that a pure
    // function cannot delete, and a forgotten entry means a picture nothing can remove.
    expect(change.evicted).toEqual([old])
  })

  it('defaults to the shipped cap', () => {
    const many = Array.from({ length: MAX_THUMBNAIL_ENTRIES + 2 }, (_unused, index) =>
      entry({ url: `https://example.com/${index}`, capturedAt: T0 + index })
    )
    const change = putThumbnailEntry(many, entry({ url: 'https://new.example/', capturedAt: T0 }))
    expect(change.shots).toHaveLength(MAX_THUMBNAIL_ENTRIES)
    expect(change.evicted).toHaveLength(3)
  })

  it('finds a page however the caller spells the address', () => {
    const shots = [entry({ url: 'https://example.com/post' })]
    expect(findThumbnailEntry(shots, 'https://example.com/post#reply')?.url).toBe(
      'https://example.com/post'
    )
    expect(findThumbnailEntry(shots, 'https://example.com/post?utm_medium=mail')?.url).toBe(
      'https://example.com/post'
    )
    expect(findThumbnailEntry(shots, 'https://example.com/other')).toBeNull()
    expect(findThumbnailEntry(shots, '../../etc/passwd')).toBeNull()
  })

  it('repairs a file that has two entries for one page', () => {
    const older = entry({ capturedAt: T0, byteLength: 10_000 })
    const newer = entry({ capturedAt: T0 + 5, byteLength: 20_000 })
    // Either order in the file, same answer: both name the same file, and the newer
    // picture has already overwritten it.
    expect(repairThumbnailIndex([older, newer])).toEqual([newer])
    expect(repairThumbnailIndex([newer, older])).toEqual([newer])
  })

  it('repairs an over-long, unordered file', () => {
    const shots = [
      entry({ url: 'https://a.example/', capturedAt: T0 }),
      entry({ url: 'https://b.example/', capturedAt: T0 + 20 }),
      entry({ url: 'https://c.example/', capturedAt: T0 + 10 })
    ]
    expect(repairThumbnailIndex(shots, 2).map((shot) => shot.url)).toEqual([
      'https://b.example/',
      'https://c.example/'
    ])
  })
})

describe('a private window', () => {
  it('is handed a capturer with nothing behind it', async () => {
    // Not a bound closure with a flag: an object holding no store, no directory and no
    // camera, so there is nothing for a forgotten check to leak into.
    expect(discardingThumbnailCapturer.shouldCapture('https://secret.example/')).toBe(false)
    expect(await discardingThumbnailCapturer.capture({
      url: 'https://secret.example/',
      title: 'Secret',
      viewId: 3
    })).toEqual({ kind: 'rejected', reason: 'private-mode' })
  })
})
