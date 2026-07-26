import { readerUrlFor } from '@shared/reader/address.js'
import { extractArticle } from '@shared/reader/extract.js'
import { refusedOutcome, type ReaderOutcome } from '@shared/reader/outcome.js'
import { harvestDocument, type ReaderPageScriptHost } from './harvest.js'

/**
 * Reader mode, from the menu item to the reader tab.
 *
 * ## Why the result is held in the core rather than passed in the address
 *
 * The obvious alternative is to put the extracted article in the URL and let the page read it out.
 * That fails twice over: an article does not fit in an address, and a reader page whose content came
 * from its own address could be handed content by anything that can open an address — which includes
 * any visited site, since `tessera://` pages are reachable by link. Holding the extraction here and
 * passing an id means the page can only ever be shown something the user asked for.
 *
 * ## Why a bounded map
 *
 * Every entry is the text of a page the user read, held in the core's memory. A map that grew for the
 * session would slowly become a record of everything they had read in this window — the kind of store
 * this browser goes out of its way not to keep. `READER_HISTORY_LIMIT` entries is enough for the
 * reasons an id is fetched twice (a reload, a restored tab, the same reader view dropped into a second
 * tile) and nothing is written to disk.
 *
 * ## Why the reader opens in a new tab
 *
 * Toggling in place is what other browsers do and it would need the original page reloaded to get
 * back, throwing away its scroll position and restarting its media. A second tab keeps both, and in
 * this browser it also means the article and its source can sit side by side in two tiles — which is
 * the one thing this browser is for.
 *
 * ## Electron-free on purpose
 *
 * Neither this file nor `harvest.ts` imports Electron. The two shapes below are the smallest thing a
 * `Tab` and a `BrowserWindowController` have to be, so the whole path — harvest, refuse, remember,
 * open — is exercised in tests against plain objects rather than only by a smoke test.
 */

export interface ReaderHostTab {
  readonly view: { readonly webContents: ReaderPageScriptHost }
}

export interface ReaderHost {
  activeTab(): ReaderHostTab | undefined
  createTab(options: { url: string }): unknown
}

/**
 * How many extractions the core keeps.
 *
 * Sixteen: enough that reloading a reader tab, or putting one in another tile, still finds its
 * article, and small enough that this cannot become a log of a reading session.
 */
export const READER_HISTORY_LIMIT = 16

export class ReaderService {
  readonly #outcomes = new Map<string, ReaderOutcome>()
  #sequence = 0

  /**
   * Reads the active tab and opens the reader view on it.
   *
   * Returns the id, or `null` when there was no tab to read — a window whose tile is empty. A
   * *refusal* is not a null: the reader tab still opens and says why, because "nothing happened when
   * I chose Reader Mode" is the one outcome a user cannot act on.
   */
  async open(host: ReaderHost): Promise<string | null> {
    const tab = host.activeTab()
    if (tab === undefined) return null

    const id = this.#remember(await this.#read(tab))
    host.createTab({ url: readerUrlFor(id) })
    return id
  }

  /** The extraction for an id, or the `expired` refusal — never a throw, never someone else's. */
  outcomeFor(id: string): ReaderOutcome {
    return this.#outcomes.get(id) ?? refusedOutcome('expired', '')
  }

  async #read(tab: ReaderHostTab): Promise<ReaderOutcome> {
    const { webContents } = tab.view
    try {
      // The address is read first and separately: on the `unreadable` path it is the only thing left
      // to offer the user, and it is also the call most likely to throw, because a destroyed view
      // still has an object here.
      const url = webContents.getURL()
      const document = await harvestDocument(webContents)
      return document === null ? refusedOutcome('unreadable', url) : extractArticle(document)
    } catch {
      return refusedOutcome('unreadable', '')
    }
  }

  #remember(outcome: ReaderOutcome): string {
    this.#sequence += 1
    const id = `reader-${String(this.#sequence)}`
    this.#outcomes.set(id, outcome)
    // `Math.max` rather than a size check: with nothing to evict the slice is empty and the loop does
    // not run, so there is no branch here that a test would have to construct a case for.
    const excess = Math.max(0, this.#outcomes.size - READER_HISTORY_LIMIT)
    for (const stale of [...this.#outcomes.keys()].slice(0, excess)) {
      this.#outcomes.delete(stale)
    }
    return id
  }
}
