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

interface StatusReply {
  unreadableEntries: number
  newer?: true
  invalid?: true
  readOnly?: true
}

function installBridge(reply: number | StatusReply): void {
  const status = typeof reply === 'number' ? { unreadableEntries: reply } : reply
  const bridge = {
    invoke: (channel: string): Promise<unknown> => {
      switch (channel) {
        case 'i18n:getCatalog':
          return Promise.resolve({ locale: 'de', messages: {} })
        case 'bookmarks:list':
          return Promise.resolve([news])
        case 'bookmarks:status':
          return Promise.resolve(status)
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

/**
 * What opening the file found, when it was not a clean load (R4). The same lines, under the same
 * conditions, as the passwords page: a newer file says it is read-only in its own sentence, a file
 * copied aside is only called that when the copy was made, and a read-only file says so otherwise.
 */
describe('the state of the bookmarks file', () => {
  const newerLine = /^Eine neuere Version hat diese Lesezeichen gespeichert/
  const invalidLine = /^Die Lesezeichendatei ließ sich nicht lesen/
  const readOnlyLine = /^Die Lesezeichendatei ließ sich nicht sichern/

  function createButtons(): HTMLElement[] {
    return [
      screen.getByRole('button', { name: 'Neuer Ordner' }),
      screen.getByRole('button', { name: 'Aus einer Datei importieren…' })
    ]
  }

  it('says a newer version wrote it, and offers nothing new to add', async () => {
    installBridge({ unreadableEntries: 0, newer: true, readOnly: true })
    render(<BookmarksPage />)
    await waitFor(() => expect(screen.getByText(newerLine)).toBeTruthy())
    // Not said twice: the newer line already says it cannot be changed.
    expect(screen.queryByText(readOnlyLine)).toBeNull()
    expect(screen.queryByText(invalidLine)).toBeNull()
    for (const button of createButtons()) expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('says the file was copied aside when it could not be used and the copy was made', async () => {
    installBridge({ unreadableEntries: 0, invalid: true })
    render(<BookmarksPage />)
    await waitFor(() => expect(screen.getByText(invalidLine)).toBeTruthy())
    expect(screen.queryByText(readOnlyLine)).toBeNull()
    expect(screen.queryByText(newerLine)).toBeNull()
    for (const button of createButtons()) expect(button.hasAttribute('disabled')).toBe(false)
  })

  it('says only that it is read-only when the unusable file could not be copied aside', async () => {
    installBridge({ unreadableEntries: 0, invalid: true, readOnly: true })
    render(<BookmarksPage />)
    await waitFor(() => expect(screen.getByText(readOnlyLine)).toBeTruthy())
    expect(screen.queryByText(invalidLine)).toBeNull()
    for (const button of createButtons()) expect(button.hasAttribute('disabled')).toBe(true)
  })

  it('still counts the unreadable bookmarks beside the newer line', async () => {
    installBridge({ unreadableEntries: 3, newer: true, readOnly: true })
    render(<BookmarksPage />)
    await waitFor(() => expect(screen.getByText(newerLine)).toBeTruthy())
    expect(screen.getByText(/^3 Lesezeichen konnten nicht gelesen/)).toBeTruthy()
  })

  it('says nothing and offers everything when the file loaded cleanly', async () => {
    installBridge({ unreadableEntries: 0 })
    render(<BookmarksPage />)
    await waitFor(() => expect(screen.getByText('News')).toBeTruthy())
    expect(screen.queryByText(newerLine)).toBeNull()
    expect(screen.queryByText(invalidLine)).toBeNull()
    expect(screen.queryByText(readOnlyLine)).toBeNull()
    for (const button of createButtons()) expect(button.hasAttribute('disabled')).toBe(false)
  })
})
