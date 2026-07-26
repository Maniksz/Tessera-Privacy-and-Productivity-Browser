import { describe, expect, it, vi } from 'vitest'
import { READER_ID_PARAM, READER_PAGE, readerIdOf, readerUrlFor } from '@shared/reader/address.js'
import { linkTargetOf } from '@shared/reader/links.js'
import { MIN_PROSE_MASS, refusedOutcome } from '@shared/reader/outcome.js'
import { extractArticle } from '@shared/reader/extract.js'
import { readerGetRequestSchema, readerOutcomeSchema } from '@shared/reader/schema.js'
import {
  HARVEST_NODE_BUDGET,
  MAX_HARVEST_DEPTH,
  NEVER_CONTENT_TAGS
} from '@shared/reader/wire.js'
import { harvestDocument, harvestSource, type ReaderPageScriptHost } from '@main/reader/harvest.js'
import {
  READER_HISTORY_LIMIT,
  ReaderService,
  type ReaderHost
} from '@main/reader/ReaderService.js'
import { openReaderMode, readerOutcomeFor } from '@main/reader/reader-mode.js'
import { documentationPage, newsArticleWithSidebar } from './reader-fixtures.js'

/**
 * The core's half of reader mode: getting a page's DOM across, holding the result, opening the tab.
 *
 * Neither module under test imports Electron. The two host shapes are the smallest thing a `Tab` and a
 * `BrowserWindowController` have to be, which is what lets the whole path — harvest, refuse, remember,
 * open — be exercised here rather than only by the smoke test.
 */

/** A page that answers `executeJavaScript` with whatever it was given. */
function pageAnswering(answer: unknown, url = 'https://example.test/a'): ReaderPageScriptHost {
  return {
    executeJavaScript: () => Promise.resolve(answer),
    getURL: () => url
  }
}

interface Opened {
  readonly urls: string[]
  readonly host: ReaderHost
}

function hostFor(page: ReaderPageScriptHost | undefined): Opened {
  const urls: string[] = []
  return {
    urls,
    host: {
      activeTab: () => (page === undefined ? undefined : { view: { webContents: page } }),
      createTab: (options) => urls.push(options.url)
    }
  }
}

describe('the injected transcription', () => {
  const source = harvestSource()

  it('carries its constants from the shared module rather than restating them', () => {
    // A skip list spelled out again in the injected text is a skip list that can disagree with the one
    // the extractor consults, and neither side could tell.
    for (const tag of NEVER_CONTENT_TAGS) {
      expect(source, tag).toContain(`"${tag}"`)
    }
    expect(source).toContain(String(HARVEST_NODE_BUDGET))
    expect(source).toContain(String(MAX_HARVEST_DEPTH))
  })

  it('is an expression, so `executeJavaScript` resolves to its value', () => {
    expect(source.trimStart().startsWith('(')).toBe(true)
    expect(source.trimEnd().endsWith(')()')).toBe(true)
  })

  it('cannot throw out of the page: every failure comes back as a value', () => {
    expect(source).toContain('catch (error)')
    expect(source).toContain('readerHarvestError')
  })
})

describe('reading a page', () => {
  it('parses a document the page described', async () => {
    const source = newsArticleWithSidebar()
    const document = await harvestDocument(pageAnswering(JSON.stringify(source)))
    expect(document?.url).toBe(source.url)
  })

  it('gives up on anything that is not a string', async () => {
    // The script returns a JSON string. A page that has replaced it can return whatever it likes.
    expect(await harvestDocument(pageAnswering({ root: 'nice try' }))).toBeNull()
  })

  it('gives up on a string that is not JSON', async () => {
    expect(await harvestDocument(pageAnswering('<html>'))).toBeNull()
  })

  it('gives up on the error marker the script returns when the page defeated it', async () => {
    expect(await harvestDocument(pageAnswering('{"readerHarvestError":"boom"}'))).toBeNull()
  })

  it('gives up when the view has gone away mid-call', async () => {
    const gone: ReaderPageScriptHost = {
      executeJavaScript: () => Promise.reject(new Error('Render frame was disposed')),
      getURL: () => 'https://example.test/a'
    }
    expect(await harvestDocument(gone)).toBeNull()
  })
})

describe('opening the reader view', () => {
  it('extracts the active tab and opens the reader on the result', async () => {
    const service = new ReaderService()
    const source = documentationPage()
    const { host, urls } = hostFor(pageAnswering(JSON.stringify(source)))

    const id = await service.open(host)
    expect(id).not.toBeNull()
    expect(urls).toEqual([readerUrlFor(id ?? '')])

    const outcome = service.outcomeFor(id ?? '')
    expect(outcome.kind).toBe('article')
    expect(outcome.measurement.mass).toBeGreaterThanOrEqual(MIN_PROSE_MASS)
  })

  it('does nothing when the window has no tab to read', async () => {
    const service = new ReaderService()
    const { host, urls } = hostFor(undefined)
    expect(await service.open(host)).toBeNull()
    expect(urls).toEqual([])
  })

  it('opens the reader anyway when the page could not be read, and says which page it was', async () => {
    // A refusal is not a failure. "Nothing happened when I chose Reader Mode" is the one outcome a
    // user cannot act on, so the tab opens either way and words its own refusal.
    const service = new ReaderService()
    const { host, urls } = hostFor(pageAnswering('not json', 'https://example.test/opaque'))
    const id = await service.open(host)
    expect(urls).toHaveLength(1)
    const outcome = service.outcomeFor(id ?? '')
    expect(outcome.kind === 'refused' ? outcome.reason : '').toBe('unreadable')
    expect(outcome.url).toBe('https://example.test/opaque')
  })

  it('survives a tab whose address cannot even be read', async () => {
    const service = new ReaderService()
    const destroyed: ReaderPageScriptHost = {
      executeJavaScript: () => Promise.resolve(''),
      getURL: () => {
        throw new Error('Object has been destroyed')
      }
    }
    const { host } = hostFor(destroyed)
    const id = await service.open(host)
    const outcome = service.outcomeFor(id ?? '')
    expect(outcome.kind === 'refused' ? outcome.reason : '').toBe('unreadable')
    expect(outcome.url).toBe('')
  })

  it('answers an id it is not holding with a refusal rather than with somebody else’s article', () => {
    expect(new ReaderService().outcomeFor('reader-99')).toEqual(refusedOutcome('expired', ''))
  })

  it('holds a bounded number of extractions, because each one is a page somebody read', async () => {
    const service = new ReaderService()
    const { host } = hostFor(pageAnswering(JSON.stringify(documentationPage())))
    const ids: string[] = []
    for (let count = 0; count <= READER_HISTORY_LIMIT; count += 1) {
      ids.push((await service.open(host)) ?? '')
    }
    const [oldest] = ids
    const [newest] = ids.slice(-1)
    expect(service.outcomeFor(oldest ?? '').kind === 'refused').toBe(true)
    expect(service.outcomeFor(newest ?? '').kind).toBe('article')
  })
})

describe('the entry points the menu and the handler use', () => {
  it('ignores a window that is not there', () => {
    // The menu resolves the focused window and may have none; a menu item that threw would take the
    // whole menu build with it next time.
    expect(() => openReaderMode(undefined)).not.toThrow()
  })

  it('answers an unknown id through the module instance', () => {
    expect(readerOutcomeFor('reader-nothing').kind).toBe('refused')
  })

  it('reports a tab that could not be opened at all, since nothing on screen could', async () => {
    const failing: ReaderHost = {
      activeTab: () => ({ view: { webContents: pageAnswering('not json') } }),
      createTab: () => {
        throw new Error('window is closing')
      }
    }
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    openReaderMode(failing)
    await vi.waitFor(() => {
      expect(logged).toHaveBeenCalled()
    })
    logged.mockRestore()
  })
})

describe('the reader address', () => {
  it('round-trips an id', () => {
    const url = readerUrlFor('reader-7')
    expect(url).toContain(`//${READER_PAGE}`)
    expect(readerIdOf(new URL(url).search)).toBe('reader-7')
  })

  it('has no id when the address was written by hand or linked to from a website', () => {
    expect(readerIdOf('')).toBeNull()
    expect(readerIdOf(`?${READER_ID_PARAM}=`)).toBeNull()
    expect(readerIdOf('?other=1')).toBeNull()
  })
})

describe('the contract shapes', () => {
  it('validates a real extraction, blockquotes, lists and tables included', () => {
    const outcome = extractArticle(documentationPage())
    expect(readerOutcomeSchema.parse(outcome)).toEqual(outcome)
  })

  it('validates a refusal', () => {
    const outcome = refusedOutcome('expired', '')
    expect(readerOutcomeSchema.parse(outcome)).toEqual(outcome)
  })

  it('refuses a request with no id, so the handler never looks one up', () => {
    expect(readerGetRequestSchema.safeParse({ id: '' }).success).toBe(false)
    expect(readerGetRequestSchema.safeParse({}).success).toBe(false)
    expect(readerGetRequestSchema.safeParse({ id: 'reader-1' }).success).toBe(true)
  })
})

describe('addresses extracted content may carry', () => {
  it('keeps only the schemes a page is allowed to send the user to', () => {
    expect(linkTargetOf('https://example.test/a')).toBe('https://example.test/a')
    expect(linkTargetOf('mailto:a@b.test')).toBe('mailto:a@b.test')
    // Parsed rather than prefix-matched: each of these defeats a `startsWith` check.
    expect(linkTargetOf('javascript:alert(1)')).toBeNull()
    expect(linkTargetOf('JaVaScRiPt:alert(1)')).toBeNull()
    expect(linkTargetOf('\njavascript:alert(1)')).toBeNull()
    expect(linkTargetOf('data:text/html,<script>x</script>')).toBeNull()
    expect(linkTargetOf('/relative/path')).toBeNull()
    expect(linkTargetOf(undefined)).toBeNull()
  })
})
