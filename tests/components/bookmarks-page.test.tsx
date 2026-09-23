import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { BookmarksPage } from '@renderer-internal/BookmarksPage.js'
import { BOOKMARK_BAR_ID, type Bookmark } from '@shared/bookmarks/model.js'
import type { OwnBrowserInternalBridge } from '../../src/preload/internal-api.js'

/**
 * What the bookmarks page says about nodes the core kept raw (R3). The nodes themselves never reach
 * the page; the count does, and the page says it only when there is something to say.
 */

function setBridge(bridge: OwnBrowserInternalBridge | undefined): void {
  Object.defineProperty(window, 'tesseraInternal', {
    value: bridge,
    configurable: true,
    writable: true
  })
}

const news: Bookmark = {
  id: 'b1',
  kind: 'bookmark',
  title: 'News',
  url: 'https://news.example/',
  parentId: BOOKMARK_BAR_ID,
  createdAt: 0
}

function installBridge(unreadableEntries: number): void {
  const bridge = {
    invoke: (channel: string): Promise<unknown> => {
      switch (channel) {
        case 'i18n:getCatalog':
          return Promise.resolve({ locale: 'de', messages: {} })
        case 'bookmarks:list':
          return Promise.resolve([news])
        case 'bookmarks:status':
          return Promise.resolve({ unreadableEntries })
        default:
          return Promise.reject(new Error(`unexpected channel ${channel}`))
      }
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  setBridge(bridge as unknown as OwnBrowserInternalBridge)
}

afterEach(() => {
  cleanup()
  setBridge(undefined)
})

describe('bookmarks the core could not read', () => {
  it('counts one in the singular', async () => {
    installBridge(1)
    render(<BookmarksPage />)
    await waitFor(() =>
      expect(screen.getByText(/^Ein Lesezeichen konnte nicht gelesen/)).toBeTruthy()
    )
  })

  it('counts several in the plural', async () => {
    installBridge(4)
    render(<BookmarksPage />)
    await waitFor(() =>
      expect(screen.getByText(/^4 Lesezeichen konnten nicht gelesen/)).toBeTruthy()
    )
  })

  it('says nothing when every bookmark was readable', async () => {
    installBridge(0)
    render(<BookmarksPage />)
    await waitFor(() => expect(screen.getByText('News')).toBeTruthy())
    expect(screen.queryByText(/nicht gelesen/)).toBeNull()
  })
})
