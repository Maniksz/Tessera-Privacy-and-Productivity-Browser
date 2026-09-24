import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { catalogs, type MessageKey } from '@shared/i18n/catalog.js'
import { MAX_HISTORY_ENTRIES } from '@shared/history/model.js'
import type {
  BookmarkImportOutcome,
  HistoryImportOutcome,
  ImportSource
} from '@shared/import/model.js'
import { ImportSection, type ImportHost } from '@renderer-internal/ImportSection.js'
import { ImportOfferCard, type ImportOfferHost } from '@renderer-internal/ImportOfferCard.js'

/**
 * „Importieren" on the settings page and the card on the start page (U24, R39, Q3).
 *
 * The core decides and reads; these hold the page to its half: a profile named by id only, the history
 * previewed — with what does not fit said beforehand — before a second press imports it, a refusal
 * said in a sentence, and the card gone for good once closed.
 */

const t = (key: MessageKey, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${Object.values(params).join(',')}`

const CHROME: ImportSource = {
  id: 'chrome:Default',
  browser: 'chrome',
  profile: 'Ada',
  bookmarks: true,
  history: true
}
const FIREFOX: ImportSource = {
  id: 'firefox:p',
  browser: 'firefox',
  profile: 'default',
  bookmarks: true,
  history: false
}

interface Recorded {
  bookmarks: string[]
  previews: string[]
  imports: string[]
  html: number
  passwords: number
}

function host(
  overrides: {
    sources?: readonly ImportSource[] | 'fails'
    bookmarks?: BookmarkImportOutcome
    preview?: HistoryImportOutcome
    imported?: HistoryImportOutcome
    html?: { imported: number; skipped: number; cancelled: boolean } | 'fails'
  } = {}
): { host: ImportHost; recorded: Recorded } {
  const recorded: Recorded = { bookmarks: [], previews: [], imports: [], html: 0, passwords: 0 }
  const counts = { added: 1_000, merged: 3, dropped: 4_000, skipped: 2 }
  return {
    recorded,
    host: {
      sources: () =>
        overrides.sources === 'fails'
          ? Promise.reject(new Error('no'))
          : Promise.resolve(overrides.sources ?? [CHROME, FIREFOX]),
      importBookmarks: (source) => {
        recorded.bookmarks.push(source)
        return Promise.resolve(
          overrides.bookmarks ?? { outcome: 'imported', imported: 5, skipped: 1, duplicates: 2 }
        )
      },
      previewHistory: (source) => {
        recorded.previews.push(source)
        return Promise.resolve(overrides.preview ?? { outcome: 'preview', counts })
      },
      importHistory: (source) => {
        recorded.imports.push(source)
        return Promise.resolve(overrides.imported ?? { outcome: 'imported', counts })
      },
      importHtml: () => {
        recorded.html += 1
        return overrides.html === 'fails'
          ? Promise.reject(new Error('no'))
          : Promise.resolve(overrides.html ?? { imported: 4, skipped: 0, cancelled: false })
      },
      openPasswordManager: () => {
        recorded.passwords += 1
        return Promise.reject(new Error('the page is gone'))
      },
      t
    }
  }
}

afterEach(() => {
  cleanup()
  location.hash = ''
})

describe('the import section', () => {
  it('lists the profiles by browser and name, and imports the chosen one’s bookmarks', async () => {
    const { host: importing, recorded } = host()
    render(<ImportSection host={importing} />)
    const select = await screen.findByLabelText<HTMLSelectElement>('import.source')
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Chrome — Ada',
      'Firefox — default'
    ])
    fireEvent.click(screen.getByRole('button', { name: 'import.bookmarks' }))
    expect(await screen.findByText('import.bookmarksDone:5,2,1')).toBeTruthy()
    expect(recorded.bookmarks).toEqual(['chrome:Default'])
  })

  it('previews the history first, says what does not fit, and imports on the second press', async () => {
    const { host: importing, recorded } = host()
    render(<ImportSection host={importing} />)
    fireEvent.click(await screen.findByRole('button', { name: 'import.history' }))
    expect(await screen.findByText('import.historyPreview:1000,3,2')).toBeTruthy()
    expect(screen.getByText('import.historyDropped:4000')).toBeTruthy()
    expect(recorded.imports).toEqual([])

    fireEvent.click(screen.getByRole('button', { name: 'import.historyConfirm' }))
    expect(await screen.findByText('import.historyDone:1000,3')).toBeTruthy()
    expect(recorded.previews).toEqual(['chrome:Default'])
    expect(recorded.imports).toEqual(['chrome:Default'])
    expect(screen.queryByRole('button', { name: 'import.historyConfirm' })).toBeNull()
  })

  it('says nothing about a limit when everything fits, and can be cancelled', async () => {
    const { host: importing, recorded } = host({
      preview: { outcome: 'preview', counts: { added: 2, merged: 0, dropped: 0, skipped: 0 } }
    })
    render(<ImportSection host={importing} />)
    fireEvent.click(await screen.findByRole('button', { name: 'import.history' }))
    await screen.findByText('import.historyPreview:2,0,0')
    expect(screen.queryByText(/import\.historyDropped/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'passwords.cancel' }))
    expect(screen.queryByText('import.historyPreview:2,0,0')).toBeNull()
    expect(recorded.imports).toEqual([])
  })

  it('offers only what the chosen profile has, and forgets a preview when another is chosen', async () => {
    const { host: importing } = host()
    render(<ImportSection host={importing} />)
    const history = await screen.findByRole<HTMLButtonElement>('button', {
      name: 'import.history'
    })
    fireEvent.click(history)
    await screen.findByText('import.historyPreview:1000,3,2')
    fireEvent.change(screen.getByLabelText('import.source'), { target: { value: 'firefox:p' } })
    expect(history.disabled).toBe(true)
    expect(screen.queryByText('import.historyPreview:1000,3,2')).toBeNull()
  })

  it('does not show a preview that answers after another profile was chosen as that one’s', async () => {
    const EDGE: ImportSource = { ...CHROME, id: 'edge:Default', browser: 'edge', profile: 'Bob' }
    const { host: importing, recorded } = host({ sources: [CHROME, EDGE] })
    let answer: (outcome: HistoryImportOutcome) => void = () => undefined
    importing.previewHistory = (source) => {
      recorded.previews.push(source)
      return new Promise((resolve) => {
        answer = resolve
      })
    }
    render(<ImportSection host={importing} />)
    fireEvent.click(await screen.findByRole('button', { name: 'import.history' }))
    fireEvent.change(screen.getByLabelText('import.source'), { target: { value: 'edge:Default' } })
    answer({ outcome: 'preview', counts: { added: 7, merged: 0, dropped: 0, skipped: 0 } })
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'import.history' }).disabled
      ).toBe(false)
    )
    // Chrome's counts are not shown for Edge, so there is nothing to confirm for it.
    expect(screen.queryByText('import.historyPreview:7,0,0')).toBeNull()
    expect(screen.queryByRole('button', { name: 'import.historyConfirm' })).toBeNull()
    expect(recorded.previews).toEqual(['chrome:Default'])
    expect(recorded.imports).toEqual([])
  })

  it('asks to close the other browser when its file is locked, and says every other refusal', async () => {
    const { host: importing } = host({
      preview: { outcome: 'refused', reason: 'locked' },
      bookmarks: { outcome: 'refused', reason: 'full' },
      imported: { outcome: 'refused', reason: 'read-only' }
    })
    render(<ImportSection host={importing} />)
    fireEvent.click(await screen.findByRole('button', { name: 'import.history' }))
    expect(await screen.findByText('import.locked:Chrome')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'import.bookmarks' }))
    expect(await screen.findByText('import.full:Chrome')).toBeTruthy()
  })

  it('says a refused import after a preview, and a failed call as a failure', async () => {
    const { host: importing } = host({ imported: { outcome: 'refused', reason: 'read-only' } })
    render(<ImportSection host={importing} />)
    fireEvent.click(await screen.findByRole('button', { name: 'import.history' }))
    fireEvent.click(await screen.findByRole('button', { name: 'import.historyConfirm' }))
    expect(await screen.findByText('import.readOnly:Chrome')).toBeTruthy()

    cleanup()
    const failing = host({ html: 'fails' })
    render(<ImportSection host={failing.host} />)
    fireEvent.click(screen.getByRole('button', { name: 'bookmarks.import' }))
    expect(await screen.findByText('backup.failed')).toBeTruthy()
  })

  it('says so when no browser is found, and still offers the HTML file and the passwords', async () => {
    const { host: importing, recorded } = host({ sources: [] })
    render(<ImportSection host={importing} />)
    expect(await screen.findByText('import.none')).toBeTruthy()
    expect(screen.queryByLabelText('import.source')).toBeNull()
    expect(screen.getByText('import.htmlHint')).toBeTruthy()
    expect(screen.getByText('import.passwords')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'bookmarks.import' }))
    expect(await screen.findByText('bookmarks.importResult:4,0')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'settings.openPasswordManager' }))
    await waitFor(() => expect(recorded.passwords).toBe(1))
    expect(recorded.html).toBe(1)
  })

  it('says nothing when the file picker is closed', async () => {
    const { host: importing } = host({ html: { imported: 0, skipped: 0, cancelled: true } })
    render(<ImportSection host={importing} />)
    fireEvent.click(screen.getByRole('button', { name: 'bookmarks.import' }))
    await waitFor(() =>
      expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'bookmarks.import' }).disabled
      ).toBe(false)
    )
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reports a list that could not be read, and scrolls into view when opened from the card', async () => {
    location.hash = '#import'
    let scrolled = 0
    HTMLElement.prototype.scrollIntoView = function () {
      scrolled += 1
    }
    const { host: importing } = host({ sources: 'fails' })
    render(<ImportSection host={importing} />)
    expect(await screen.findByText('backup.failed')).toBeTruthy()
    cleanup()
    render(<ImportSection host={host().host} />)
    await screen.findByLabelText('import.source')
    expect(scrolled).toBe(1)
  })

  it('names the history’s cap in both languages as the history holds it', () => {
    expect(catalogs.en['import.historyDropped']).toContain(MAX_HISTORY_ENTRIES.toLocaleString('en'))
    expect(catalogs.de['import.historyDropped']).toContain(MAX_HISTORY_ENTRIES.toLocaleString('de'))
  })
})

describe('the start page’s card', () => {
  function card(show: boolean | 'fails'): { host: ImportOfferHost; calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      host: {
        offer: () =>
          show === 'fails' ? Promise.reject(new Error('no')) : Promise.resolve({ show }),
        close: () => {
          calls.push('close')
          return Promise.reject(new Error('gone'))
        },
        openSettings: () => {
          calls.push('open')
          return Promise.reject(new Error('gone'))
        },
        t
      }
    }
  }

  it('offers the import and leads to the settings page', async () => {
    const { host: offer, calls } = card(true)
    render(<ImportOfferCard host={offer} />)
    expect(await screen.findByText('start.importOffer')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'start.importOpen' }))
    await waitFor(() => expect(calls).toEqual(['open']))
    // Still there: opening the section is not closing the card.
    expect(screen.getByText('start.importOffer')).toBeTruthy()
  })

  it('goes away when closed, and tells the core so it stays away', async () => {
    const { host: offer, calls } = card(true)
    render(<ImportOfferCard host={offer} />)
    fireEvent.click(await screen.findByRole('button', { name: 'start.importClose' }))
    expect(screen.queryByText('start.importOffer')).toBeNull()
    await waitFor(() => expect(calls).toEqual(['close']))
  })

  it('shows nothing once closed before, or when the core cannot be asked', async () => {
    for (const show of [false, 'fails'] as const) {
      const { container } = render(<ImportOfferCard host={card(show).host} />)
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(container.textContent).toBe('')
      cleanup()
    }
  })
})
