import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HistoryPage } from '@renderer-internal/HistoryPage.js'
import type { HistoryVisit } from '@shared/history/model.js'
import type { OwnBrowserInternalBridge } from '../../src/preload/internal-api.js'

/**
 * The history page, rendered.
 *
 * The first component test in this project, and it exists because a metric asked for it: past a few
 * thousand lines of interface, one end-to-end pass is not coverage. The smoke test proves the page
 * is served and can talk to the core; it cannot practically prove what the page does when a call is
 * refused, when a search finds nothing, or when two visits fall on different days.
 *
 * The bridge is replaced rather than mocked at the module level: `bridge.ts` reads
 * `window.tesseraInternal` on every call, which is exactly the seam a page in a sandboxed
 * renderer has. Testing through it means testing the same path the real page takes.
 */

interface BridgeCall {
  channel: string
  payload: unknown
}

/**
 * Puts a bridge on the window, or takes it off again.
 *
 * `defineProperty` rather than assignment because `internal-api.d.ts` declares the property
 * `readonly` — which is right: a page must not be able to swap its own bridge, and the preload
 * installs it once. A test replacing it is the one legitimate exception, and going through
 * `defineProperty` makes that exception visible instead of hiding it behind a widening cast.
 */
function setBridge(bridge: OwnBrowserInternalBridge | undefined): void {
  Object.defineProperty(window, 'tesseraInternal', {
    value: bridge,
    configurable: true,
    writable: true
  })
}

/** Fixed, so "today" and "yesterday" do not depend on when the suite runs. */
const NOW = new Date(2026, 6, 26, 15, 0)

function visit(overrides: Partial<HistoryVisit> & { url: string }): HistoryVisit {
  return {
    title: 'Example',
    firstVisitedAt: NOW.getTime(),
    lastVisitedAt: NOW.getTime(),
    visitCount: 1,
    ...overrides
  }
}

function installBridge(options: {
  entries?: HistoryVisit[]
  /** Channels that reject, standing in for a privilege the page does not have. */
  refuse?: Record<string, string>
}): { calls: BridgeCall[] } {
  const calls: BridgeCall[] = []
  const entries = options.entries ?? []

  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      const refusal = options.refuse?.[channel]
      if (refusal !== undefined) return Promise.reject(new Error(refusal))
      switch (channel) {
        case 'i18n:getCatalog':
          return Promise.resolve({ locale: 'en', messages: {} })
        case 'history:query': {
          const text = (payload as { text?: string } | undefined)?.text
          if (text === undefined) return Promise.resolve(entries)
          const needle = text.toLowerCase()
          return Promise.resolve(
            entries.filter(
              (entry) =>
                entry.url.toLowerCase().includes(needle) ||
                entry.title.toLowerCase().includes(needle)
            )
          )
        }
        case 'history:removeVisit':
        case 'history:removeDomain':
        case 'history:clear':
          return Promise.resolve({ removed: 1 })
        case 'history:open':
          return Promise.resolve({ url: (payload as { url: string }).url })
        default:
          return Promise.reject(new Error(`unexpected channel ${channel}`))
      }
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }

  // One cast, at the boundary: `invoke` is generic over the channel union and this stands in for it
  // with a switch. The channel names inside are the ones the page is actually allowed to call.
  setBridge(bridge as unknown as OwnBrowserInternalBridge)
  return { calls }
}

beforeEach(() => {
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  setBridge(undefined)
})

describe('an empty history', () => {
  it('says so rather than showing an empty page', async () => {
    installBridge({})
    render(<HistoryPage />)
    // The distinction that matters: "nothing yet" is not the same message as "nothing matched".
    await waitFor(() => expect(screen.getByText(/Nothing here yet/i)).toBeTruthy())
  })

  it('disables clearing, because there is nothing to clear', async () => {
    installBridge({})
    render(<HistoryPage />)
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Clear all history/i })
      expect((button as HTMLButtonElement).disabled).toBe(true)
    })
  })
})

describe('a history with entries', () => {
  it('groups visits by calendar day', async () => {
    installBridge({
      entries: [
        visit({ url: 'https://today.example/', title: 'Today page' }),
        visit({
          url: 'https://yesterday.example/',
          title: 'Yesterday page',
          lastVisitedAt: new Date(2026, 6, 25, 23, 0).getTime()
        })
      ]
    })
    render(<HistoryPage />)

    await waitFor(() => expect(screen.getByText('Today page')).toBeTruthy())
    // The 23:00 visit is sixteen hours old and still belongs under yesterday — the calendar rule,
    // visible from the outside.
    expect(screen.getByRole('heading', { name: /Yesterday/i })).toBeTruthy()
    expect(screen.getByText('Yesterday page')).toBeTruthy()
  })

  it('shows the address once when an entry has no title', async () => {
    // A row with no readable text is a row the user cannot decide about — but showing the same
    // address as both title and subtitle is noise. This test found that and now pins it.
    installBridge({ entries: [visit({ url: 'https://example.com/deep/page', title: '' })] })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getAllByText('example.com/deep/page')).toHaveLength(1))
  })

  it('names the site, not the whole address, on the forget-this-site button', async () => {
    /*
      Two buttons sit next to each other and do very different things: one forgets this page, the
      other forgets every page on the site. They must not read the same.

      This found a real defect. The page called `registrableDomain`, which takes a *host* and returns
      anything it does not recognise unchanged — so with a full address in hand it announced
      "example.com/deep/page" for both.
    */
    installBridge({ entries: [visit({ url: 'https://blog.example.com/deep/page', title: 'Deep' })] })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByText('Deep')).toBeTruthy())

    expect(screen.getByRole('button', { name: /Remove everything from example\.com$/i })).toBeTruthy()
    // And the per-page button still names the page.
    expect(screen.getByRole('button', { name: /Remove Deep from history/i })).toBeTruthy()
  })

  it('shows both title and address when they differ', async () => {
    installBridge({ entries: [visit({ url: 'https://example.com/deep/page', title: 'Deep page' })] })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByText('Deep page')).toBeTruthy())
    expect(screen.getByText('example.com/deep/page')).toBeTruthy()
  })

  it('says how often a page was visited, singular and plural apart', async () => {
    installBridge({
      entries: [
        visit({ url: 'https://once.example/', title: 'Once' }),
        visit({ url: 'https://often.example/', title: 'Often', visitCount: 7 })
      ]
    })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByText(/Visited once/i)).toBeTruthy())
    expect(screen.getByText(/Visited 7 times/i)).toBeTruthy()
  })
})

describe('searching', () => {
  it('asks the core rather than filtering what it already has', async () => {
    /*
      The behaviour a unit test cannot see and the smoke test does not check. Filtering in place
      would search only the entries already fetched — correct-looking until the history is longer
      than one page, then silently incomplete.
    */
    const { calls } = installBridge({
      entries: [visit({ url: 'https://example.com/', title: 'Example' })]
    })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByText('Example')).toBeTruthy())

    const search = screen.getByRole('searchbox', { name: /Search history/i })
    await act(async () => {
      // `fireEvent.change` rather than setting `.value` and dispatching by hand: React reads the
      // value through a property descriptor it has replaced, so a raw assignment is invisible to it.
      fireEvent.change(search, { target: { value: 'nothing' } })
      // The page debounces, so the query is not sent on the keystroke itself.
      await new Promise((resolve) => setTimeout(resolve, 200))
    })

    const queries = calls.filter((call) => call.channel === 'history:query')
    expect(queries.some((call) => (call.payload as { text?: string }).text === 'nothing')).toBe(true)
  })

  it('distinguishes "no matches" from "nothing yet"', async () => {
    installBridge({ entries: [visit({ url: 'https://example.com/', title: 'Example' })] })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByText('Example')).toBeTruthy())

    const search = screen.getByRole('searchbox', { name: /Search history/i })
    await act(async () => {
      fireEvent.change(search, { target: { value: 'zzz' } })
      await new Promise((resolve) => setTimeout(resolve, 200))
    })

    await waitFor(() => expect(screen.getByText(/No page matches/i)).toBeTruthy())
  })
})

describe('when the core refuses', () => {
  it('shows the refusal instead of leaving the list unchanged', async () => {
    /*
      The most important thing this file checks. A delete button that silently does nothing teaches
      the user not to trust it — and with a per-page privilege model, a refusal is a state the page
      can genuinely reach if its allowlist is ever wrong.
    */
    installBridge({
      entries: [visit({ url: 'https://example.com/', title: 'Example' })],
      refuse: { 'history:removeVisit': 'internal page history may not call "history:removeVisit"' }
    })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByText('Example')).toBeTruthy())

    const remove = screen.getByRole('button', { name: /Remove Example from history/i })
    await act(async () => {
      remove.click()
      await Promise.resolve()
    })

    await waitFor(() => {
      const notice = screen.getByRole('status')
      expect(notice.textContent).toContain('may not call')
    })
  })

  it('survives a page whose bridge is missing entirely', async () => {
    // What a document loaded outside the internal scheme sees. It must render, not throw.
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy())
  })
})

describe('following an entry', () => {
  it('goes through the channel that resolves to this tab', async () => {
    // `history:open`, never `nav:navigate` — the page may steer itself and nothing else.
    const { calls } = installBridge({
      entries: [visit({ url: 'https://example.com/', title: 'Example' })]
    })
    render(<HistoryPage />)
    await waitFor(() => expect(screen.getByText('Example')).toBeTruthy())

    await act(async () => {
      screen.getByRole('button', { name: /Open Example/i }).click()
      await Promise.resolve()
    })

    expect(calls.some((call) => call.channel === 'history:open')).toBe(true)
    expect(calls.some((call) => call.channel === 'nav:navigate')).toBe(false)
  })
})
