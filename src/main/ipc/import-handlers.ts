import { readFile, stat } from 'node:fs/promises'
import type { IpcMainInvokeEvent } from 'electron'
import { MAX_IMPORT_LENGTH, type ImportReport } from '@shared/bookmarks/import.js'
import { translate, type Locale } from '@shared/i18n/catalog.js'
import { parseChromeBookmarks } from '@shared/import/chrome-bookmarks.js'
import type { HistoryImportCounts, ImportRefusal, ImportSource } from '@shared/import/model.js'
import type { ImportedVisit } from '@shared/import/visits.js'
import type { InvokeHandlerArg, InvokeResponse } from '@shared/ipc/contract.js'
import { internalUrl } from '@shared/product.js'
import {
  readChromiumHistory,
  readFirefoxBookmarks,
  readFirefoxHistory,
  refusalOf,
  type CopyOptions,
  type HistoryRead,
  type ReadOutcome
} from '../import/history-sqlite.js'
import {
  currentMachine,
  detectProfiles,
  type BrowserProfile,
  type Machine
} from '../import/profiles.js'

/**
 * Bookmarks and history from Chrome, Edge, Chromium and Firefox, and the start page's card (U24).
 *
 * ## Why this is not in `handlers.ts`
 *
 * For `omnibox-handlers.ts`'s reasons: that file may only gain call sites (KTD21), and it imports
 * the router, so nothing in it can be tested. Handed the registrar, the stores and the machine, this
 * is an ordinary function a test drives against real files in a temporary home.
 *
 * ## What a request may name
 *
 * A profile id from `import:sources`, and nothing else. Every request finds the profiles again and
 * reads only a file of the one whose id matches, so a page cannot steer the core to a path — the id is
 * a name for something the core itself offered. An id that no longer matches is `missing`.
 *
 * ## When an import is refused before a file is read
 *
 * A history that is read-only in this run (`HistoryStore.readOnly`) is refused, not written to memory
 * and lost at exit; so are read-only and full bookmarks. The history is always previewed first on the
 * page, and the preview says how many entries do not fit under the cap — the import never displaces
 * the own history. A successful import closes the start page's card, which has no more to offer.
 */

type ImportChannel =
  | 'import:sources'
  | 'import:bookmarks'
  | 'import:previewHistory'
  | 'import:history'
  | 'import:offer'
  | 'import:closeOffer'
  | 'import:openSettings'

type ImportChannelContract = {
  [C in ImportChannel]: { request: InvokeHandlerArg<C>; response: InvokeResponse<C> }
}

/** The shape of `ipc/router.ts`'s `handle`, narrowed to these channels. See `SiteHandle`. */
export type ImportHandle = <C extends ImportChannel>(
  channel: C,
  handler: (
    payload: ImportChannelContract[C]['request'],
    event: IpcMainInvokeEvent
  ) => ImportChannelContract[C]['response'] | Promise<ImportChannelContract[C]['response']>
) => void

export interface ImportHandlerDeps {
  readonly handle: ImportHandle
  readonly windows: {
    controllerForWebContents(
      id: number
    ): { createTab(options: { url: string }): unknown } | undefined
  }
  readonly history: {
    readonly readOnly: boolean
    previewImport(visits: readonly ImportedVisit[]): HistoryImportCounts
    importVisits(visits: readonly ImportedVisit[]): HistoryImportCounts
  }
  readonly bookmarks: {
    readonly status: { readonly readOnly?: true }
    readonly importCapacity: number
    importTree(
      report: ImportReport,
      folderTitle: string
    ): { imported: number; skipped: number; duplicates: number }
  }
  readonly quickLinks: { readonly importOfferClosed: boolean; closeImportOffer(): void }
  /** Read per request, so the import folder is named in the language in force. */
  readonly locale: () => Locale
  /** The machine the browsers are looked for on; this one unless a test says otherwise. */
  readonly machine?: Machine
  /** How the SQLite copies are made; the defaults unless a test says otherwise. */
  readonly copy?: CopyOptions
}

const OK = { ok: true } as const

function refused(reason: ImportRefusal): { outcome: 'refused'; reason: ImportRefusal } {
  return { outcome: 'refused' as const, reason }
}

function sourceOf(profile: BrowserProfile): ImportSource {
  return {
    id: profile.id,
    browser: profile.browser,
    profile: profile.profile,
    bookmarks: profile.bookmarksFile !== null,
    history: profile.historyFile !== null
  }
}

/** Chrome's `Bookmarks`: size first, so a file past the importer's bound is never read whole. */
async function readChromeBookmarks(file: string): Promise<ReadOutcome<ImportReport>> {
  try {
    if ((await stat(file)).size > MAX_IMPORT_LENGTH) return { ok: false, reason: 'unreadable' }
    const report = parseChromeBookmarks(await readFile(file, 'utf8'))
    return report === null ? { ok: false, reason: 'unreadable' } : { ok: true, value: report }
  } catch (error) {
    return { ok: false, reason: refusalOf(error) }
  }
}

export function registerImportHandlers(deps: ImportHandlerDeps): void {
  const { handle, history, bookmarks, quickLinks } = deps
  const profiles = (): BrowserProfile[] => detectProfiles(deps.machine ?? currentMachine())
  const find = (id: string): BrowserProfile | undefined =>
    profiles().find((profile) => profile.id === id)

  const readHistory = (profile: BrowserProfile, file: string): Promise<ReadOutcome<HistoryRead>> =>
    profile.browser === 'firefox'
      ? readFirefoxHistory(file, deps.copy)
      : readChromiumHistory(file, deps.copy)

  /** The rows past the reading limit are left out as well, and the page is told so. */
  const withUnread = (counts: HistoryImportCounts, read: HistoryRead): HistoryImportCounts => ({
    ...counts,
    dropped: counts.dropped + read.unread
  })

  handle('import:sources', () => profiles().map(sourceOf))

  handle('import:bookmarks', async ({ source }) => {
    const profile = find(source)
    const file = profile?.bookmarksFile ?? null
    if (profile === undefined || file === null) return refused('missing')
    if (bookmarks.status.readOnly === true) return refused('read-only')
    if (bookmarks.importCapacity === 0) return refused('full')
    const read =
      profile.browser === 'firefox'
        ? await readFirefoxBookmarks(file, deps.copy)
        : await readChromeBookmarks(file)
    if (!read.ok) return refused(read.reason)
    /*
      The HTML import's folder, for every browser: a second import of the same bookmarks — from the
      same profile, from another browser that synced them, or from an HTML file — adds none twice.
    */
    const summary = bookmarks.importTree(
      read.value,
      translate(deps.locale(), 'bookmarks.importedFolder')
    )
    quickLinks.closeImportOffer()
    return { outcome: 'imported' as const, ...summary }
  })

  handle('import:previewHistory', async ({ source }) => {
    const profile = find(source)
    const file = profile?.historyFile ?? null
    if (profile === undefined || file === null) return refused('missing')
    if (history.readOnly) return refused('read-only')
    const read = await readHistory(profile, file)
    if (!read.ok) return refused(read.reason)
    const counts = history.previewImport(read.value.visits)
    return { outcome: 'preview' as const, counts: withUnread(counts, read.value) }
  })

  handle('import:history', async ({ source }) => {
    const profile = find(source)
    const file = profile?.historyFile ?? null
    if (profile === undefined || file === null) return refused('missing')
    if (history.readOnly) return refused('read-only')
    const read = await readHistory(profile, file)
    if (!read.ok) return refused(read.reason)
    const counts = history.importVisits(read.value.visits)
    quickLinks.closeImportOffer()
    return { outcome: 'imported' as const, counts: withUnread(counts, read.value) }
  })

  handle('import:offer', () => ({ show: !quickLinks.importOfferClosed }))

  handle('import:closeOffer', () => {
    quickLinks.closeImportOffer()
    return OK
  })

  /*
    The card's way to the settings page, for `passwords:openManager`'s reason: a page may not navigate
    itself to an internal address. One fixed destination, opened beside the start page that asked.
  */
  handle('import:openSettings', (_payload, event) => {
    deps.windows
      .controllerForWebContents(event.sender.id)
      ?.createTab({ url: `${internalUrl('settings')}#import` })
    return OK
  })
}
