import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuickLinkTile } from '@renderer-internal/QuickLinkTile.js'
import type { QuickLinkCard } from '@shared/quicklinks/cards.js'
import type { MessageKey } from '@shared/i18n/catalog.js'

/**
 * A start-page card, rendered.
 *
 * Written for one behaviour a unit test cannot see and an end-to-end pass will not reach: the picture
 * cascade. A card prefers the page's screenshot, falls back to the site's icon, and falls back again to
 * the title's initial — and it advances on a *load failure*, which is the ordinary case rather than an
 * error, because nothing is cached for a page until it has been visited.
 *
 * Reaching the second and third steps in the running browser means finding a site with an icon and no
 * screenshot, which is a state that lasts a second and a half. Here it is one `error` event.
 */

/** Keys through unchanged, so an assertion reads as the key rather than as English prose. */
const t = (key: MessageKey, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${Object.values(params).join(',')}`

function card(overrides: Partial<QuickLinkCard> = {}): QuickLinkCard {
  return {
    id: 'l1',
    kind: 'link',
    title: 'Example',
    url: 'https://example.com/page',
    parentId: null,
    createdAt: 1,
    thumbnailUrl: null,
    faviconUrl: null,
    ...overrides
  }
}

function renderTile(link: QuickLinkCard): void {
  render(
    <QuickLinkTile
      link={link}
      index={0}
      childCount={0}
      isDragging={false}
      t={t}
      onOpen={vi.fn()}
      onOpenInNewTab={vi.fn()}
      onEdit={vi.fn()}
      onRemove={vi.fn()}
      onDragStart={vi.fn()}
      onDragEnd={vi.fn()}
      onDropBefore={vi.fn()}
      onMove={vi.fn()}
    />
  )
}

/** The picture element, or `null` when the card has fallen through to its initial. */
function picture(): HTMLImageElement | null {
  return document.querySelector('img.tile__picture')
}

afterEach(cleanup)

describe('which picture a card draws', () => {
  it('prefers the screenshot when both exist', () => {
    renderTile(card({ thumbnailUrl: 'tessera://thumbnail?url=x&v=1', faviconUrl: 'tessera://favicon?site=example.com&v=1' }))
    expect(picture()?.getAttribute('src')).toContain('thumbnail')
  })

  it('marks a screenshot and an icon differently, because they are drawn at different sizes', () => {
    // Not decoration: one rule for both would inflate a 32 px favicon to card height. The class is
    // how the stylesheet tells them apart, so it has to be on the element.
    renderTile(card({ thumbnailUrl: 'tessera://thumbnail?url=x&v=1' }))
    expect(picture()?.className).toContain('tile__picture--thumbnail')

    cleanup()
    renderTile(card({ faviconUrl: 'tessera://favicon?site=example.com&v=1' }))
    expect(picture()?.className).toContain('tile__picture--favicon')
  })

  it('falls back to the icon when the screenshot fails to load', () => {
    /*
      The behaviour the whole design rests on. A miss answers 204 — an empty body that cannot be
      decoded — so `error` is how "nothing cached" arrives, and it must advance rather than leave a
      broken image.
    */
    renderTile(
      card({
        thumbnailUrl: 'tessera://thumbnail?url=x&v=1',
        faviconUrl: 'tessera://favicon?site=example.com&v=1'
      })
    )
    const first = picture()
    expect(first?.getAttribute('src')).toContain('thumbnail')

    fireEvent.error(first!)
    expect(picture()?.getAttribute('src')).toContain('favicon')
  })

  it('falls back to the initial when both fail', () => {
    renderTile(
      card({
        title: 'Wikipedia',
        thumbnailUrl: 'tessera://thumbnail?url=x&v=1',
        faviconUrl: 'tessera://favicon?site=example.com&v=1'
      })
    )
    fireEvent.error(picture()!)
    fireEvent.error(picture()!)

    expect(picture()).toBeNull()
    expect(screen.getByText('W')).toBeTruthy()
  })

  it('shows the initial straight away when nothing is cached', () => {
    // The first-run state for every card, and it must not produce an `<img src="null">` — that
    // requests a file called "null" and draws a broken image.
    renderTile(card({ title: 'example' }))
    expect(picture()).toBeNull()
    expect(screen.getByText('E')).toBeTruthy()
  })

  it('keeps an initial outside the basic plane whole', () => {
    // `codePointAt`, not `[0]`: indexing a string cuts a surrogate pair in half and renders a
    // replacement character.
    renderTile(card({ title: '🌍 Atlas' }))
    expect(screen.getByText('🌍')).toBeTruthy()
  })

  it('draws a glyph for a folder, never a picture', () => {
    // A folder has no address, so it has nothing to have been photographed. The addresses are set
    // here anyway, so this fails if the folder branch is ever dropped.
    renderTile(
      card({ kind: 'folder', url: '', thumbnailUrl: 'tessera://thumbnail?url=x&v=1' })
    )
    expect(picture()).toBeNull()
  })
})

describe('a card as a control', () => {
  it('describes itself with its name and address, not just its name', () => {
    // The card is a single clickable region; without the address in the label there is no way to tell
    // two similarly named tiles apart from the keyboard.
    renderTile(card({ title: 'Example', url: 'https://example.com/page' }))
    expect(
      screen.getByLabelText('start.tileLabel:Example,https://example.com/page')
    ).toBeTruthy()
  })

  it('opens on Enter as well as on click', () => {
    // Spec 7 requires full keyboard operation; drag and drop alone would make this mouse-only.
    const onOpen = vi.fn()
    render(
      <QuickLinkTile
        link={card()}
        index={0}
        childCount={0}
        isDragging={false}
        t={t}
        onOpen={onOpen}
        onOpenInNewTab={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onDragStart={vi.fn()}
        onDragEnd={vi.fn()}
        onDropBefore={vi.fn()}
        onMove={vi.fn()}
      />
    )
    fireEvent.keyDown(screen.getByRole('listitem'), { key: 'Enter' })
    expect(onOpen).toHaveBeenCalledTimes(1)
  })
})
