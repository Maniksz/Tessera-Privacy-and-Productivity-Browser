import { faviconUrl } from '../favicons/model.js'
import { thumbnailUrl } from '../thumbnails/model.js'
import type { QuickLink } from './model.js'

/**
 * What picture a start-page card should draw, and in which order to try.
 *
 * ## Why this is derived rather than stored
 *
 * A quick link used to carry a `faviconPath` field on disk. That field could only ever be wrong: the
 * icon it named lives in a cache that expires, gets cleared with "clear data", and is refreshed
 * whenever the site is visited again — so the stored path and the cache would drift apart, and the
 * drift would show as a card with no picture and no explanation. The link's *address* is the only
 * durable fact; everything else about its appearance follows from it.
 *
 * Removing the field is also the safe direction for an existing profile: zod strips keys a schema
 * does not mention, so a file written by an older build still loads. Renaming it would not have been.
 *
 * ## Why the addresses come from here and not from the page
 *
 * Both are versioned — `?v=` carries the capture time — and only the core knows it. Without the
 * version the file name is stable per subject, so Chromium would go on drawing the copy in its memory
 * cache and a freshly taken screenshot would not appear until the page was reloaded. Handing the page
 * a pre-built address keeps that entirely in one place.
 */

/** A stored quick link plus where its picture comes from. Never persisted. */
export interface QuickLinkCard extends QuickLink {
  /**
   * The page's own screenshot, or `null` when none has been taken.
   *
   * Preferred over the icon, per the product decision: a picture of the page is what people
   * recognise, and it is the difference between a wall of letters and a wall of pages.
   */
  thumbnailUrl: string | null
  /** The site's icon — the fallback when there is no screenshot yet, which is the first-run case. */
  faviconUrl: string | null
}

/** What a card needs to know about the two caches. Both answer `null` for "nothing yet". */
export interface CardImageSources {
  /** `ThumbnailStore.find`, narrowed to the two fields an address is built from. */
  findThumbnail(pageUrl: string): { url: string; capturedAt: number } | null
  /** `FaviconStore.find`, likewise. */
  findFavicon(pageUrl: string): { domain: string; fetchedAt: number } | null
}

/**
 * Attaches the picture addresses to a list of links.
 *
 * A folder gets neither, and that is not an oversight: a folder has no address, so there is nothing
 * to have photographed and no site to have an icon for. It draws its own glyph.
 */
export function quickLinkCards(
  links: readonly QuickLink[],
  sources: CardImageSources
): QuickLinkCard[] {
  return links.map((link) => {
    if (link.kind === 'folder') {
      return { ...link, thumbnailUrl: null, faviconUrl: null }
    }
    const shot = sources.findThumbnail(link.url)
    const icon = sources.findFavicon(link.url)
    return {
      ...link,
      thumbnailUrl: shot === null ? null : thumbnailUrl(shot),
      faviconUrl: icon === null ? null : faviconUrl(icon)
    }
  })
}

/** Which of the two caches an address came from. */
export type CardImageKind = 'thumbnail' | 'favicon'

export interface CardImage {
  kind: CardImageKind
  url: string
}

/**
 * The pictures a card should try, best first.
 *
 * Separate from the card itself because the *order* is the decision, and it is one the renderer must
 * not restate: a component that reached for `faviconUrl` first would silently prefer icons, and
 * nothing would fail. Returning a list also reduces the renderer's job to "try the next one when this
 * fails", with no policy in it.
 *
 * The kind travels with the address because the two are drawn differently and only this list knows
 * which is which. A screenshot fills the card; an icon is a 48 px badge in the middle of it. Stretching
 * a 32 px favicon to card height — which is what a single rule for both does — is worse than showing
 * the initial.
 */
export function cardImageSequence(card: QuickLinkCard): CardImage[] {
  const candidates: Array<[CardImageKind, string | null]> = [
    ['thumbnail', card.thumbnailUrl],
    ['favicon', card.faviconUrl]
  ]
  return candidates
    .filter((entry): entry is [CardImageKind, string] => entry[1] !== null)
    .map(([kind, url]) => ({ kind, url }))
}
