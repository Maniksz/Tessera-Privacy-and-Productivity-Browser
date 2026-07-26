import { describe, expect, it } from 'vitest'
import {
  cardImageSequence,
  quickLinkCards,
  type CardImageSources,
  type QuickLinkCard
} from '@shared/quicklinks/cards.js'
import type { QuickLink } from '@shared/quicklinks/model.js'

/**
 * What picture a start-page card draws.
 *
 * Replaces two tests that checked a stored `faviconPath` field. That field is gone because it could
 * only ever be wrong — it named a file in a cache that expires, gets cleared, and is refreshed on
 * every visit — and the tests for it were therefore pinning a defect in place.
 */

function link(overrides: Partial<QuickLink> = {}): QuickLink {
  return {
    id: 'l1',
    kind: 'link',
    title: 'Example',
    url: 'https://example.com/page',
    parentId: null,
    createdAt: 1,
    ...overrides
  }
}

/** Nothing cached: the first-run state, and the one a wiring bug looks exactly like. */
const nothingCached: CardImageSources = {
  findThumbnail: () => null,
  findFavicon: () => null
}

function withBoth(options: { capturedAt?: number; fetchedAt?: number } = {}): CardImageSources {
  return {
    findThumbnail: (pageUrl) => ({ url: pageUrl, capturedAt: options.capturedAt ?? 1_000 }),
    findFavicon: () => ({ domain: 'example.com', fetchedAt: options.fetchedAt ?? 2_000 })
  }
}

function card(overrides: Partial<QuickLinkCard> = {}): QuickLinkCard {
  return { ...link(), thumbnailUrl: null, faviconUrl: null, ...overrides }
}

describe('quickLinkCards', () => {
  it('gives a link both addresses when both are cached', () => {
    const [result] = quickLinkCards([link()], withBoth())
    expect(result?.thumbnailUrl).toContain('tessera://thumbnail')
    expect(result?.faviconUrl).toContain('tessera://favicon')
  })

  it('gives a link neither when nothing is cached yet', () => {
    // Not an error state. It is what every card looks like before its page has been visited, so it
    // has to be a value the renderer can act on rather than something to guard against.
    const [result] = quickLinkCards([link()], nothingCached)
    expect(result?.thumbnailUrl).toBeNull()
    expect(result?.faviconUrl).toBeNull()
  })

  it('gives a folder neither, even when a cache would answer', () => {
    /*
      A folder has no address, so there is nothing to have photographed. The sources here answer for
      anything they are asked, which is what makes this a real check: it fails if the folder branch is
      ever removed, rather than passing because the fake happened to return null.
    */
    const [result] = quickLinkCards([link({ kind: 'folder', url: '' })], withBoth())
    expect(result?.thumbnailUrl).toBeNull()
    expect(result?.faviconUrl).toBeNull()
  })

  it('keeps every stored field untouched', () => {
    const original = link({ title: 'Kept', parentId: 'f1', createdAt: 42 })
    const [result] = quickLinkCards([original], withBoth())
    expect(result).toMatchObject({ title: 'Kept', parentId: 'f1', createdAt: 42, id: 'l1' })
  })

  it('does not store the addresses back onto the link it was given', () => {
    // The caller's list is the persisted one. Writing a derived address into it is how a cache path
    // ended up on disk in the first place.
    const original = link()
    quickLinkCards([original], withBoth())
    expect(Object.hasOwn(original, 'thumbnailUrl')).toBe(false)
    expect(Object.hasOwn(original, 'faviconUrl')).toBe(false)
  })

  it('versions the addresses, so a new picture is a new address', () => {
    /*
      The point of the version, and the reason these addresses cannot be built in the renderer. The
      file name is stable per subject, so without a changing address Chromium keeps drawing the copy
      in its memory cache and a screenshot taken a moment ago never appears.
    */
    const [early] = quickLinkCards([link()], withBoth({ capturedAt: 1_000, fetchedAt: 1_000 }))
    const [later] = quickLinkCards([link()], withBoth({ capturedAt: 9_000, fetchedAt: 9_000 }))
    expect(early?.thumbnailUrl).not.toBe(later?.thumbnailUrl)
    expect(early?.faviconUrl).not.toBe(later?.faviconUrl)
  })

  it('asks the thumbnail cache about the page and the icon cache about the site', () => {
    // Two different keys for the same card: a screenshot is of one page, an icon belongs to a whole
    // site. Passing the page address to both is correct — each store narrows it its own way — but the
    // thumbnail must not be looked up by domain, or every page of a site would share one picture.
    const asked: string[] = []
    quickLinkCards([link({ url: 'https://example.com/deep/page' })], {
      findThumbnail: (pageUrl) => {
        asked.push(pageUrl)
        return null
      },
      findFavicon: (pageUrl) => {
        asked.push(pageUrl)
        return null
      }
    })
    expect(asked).toEqual(['https://example.com/deep/page', 'https://example.com/deep/page'])
  })

  it('handles an empty list', () => {
    expect(quickLinkCards([], withBoth())).toEqual([])
  })
})

describe('cardImageSequence', () => {
  it('puts the screenshot before the icon', () => {
    // The product decision, stated once where the renderer cannot restate it differently: a picture
    // of the page is what people recognise.
    const sequence = cardImageSequence(card({ thumbnailUrl: 'shot', faviconUrl: 'icon' }))
    expect(sequence).toEqual([
      { kind: 'thumbnail', url: 'shot' },
      { kind: 'favicon', url: 'icon' }
    ])
  })

  it('falls back to the icon alone', () => {
    expect(cardImageSequence(card({ faviconUrl: 'icon' }))).toEqual([
      { kind: 'favicon', url: 'icon' }
    ])
  })

  it('offers the screenshot alone when there is no icon', () => {
    expect(cardImageSequence(card({ thumbnailUrl: 'shot' }))).toEqual([
      { kind: 'thumbnail', url: 'shot' }
    ])
  })

  it('is empty when there is nothing, rather than holding a null', () => {
    // A renderer indexing into this must never receive `null` as a `src`: an `<img src="null">`
    // requests a file called "null" and shows a broken image.
    expect(cardImageSequence(card())).toEqual([])
  })

  it('says which cache each address came from', () => {
    // The kind is not decoration. The two are drawn at different sizes, and only this list knows
    // which is which — the renderer walks addresses and cannot tell them apart.
    const sequence = cardImageSequence(card({ faviconUrl: 'icon' }))
    expect(sequence[0]?.kind).toBe('favicon')
  })
})
