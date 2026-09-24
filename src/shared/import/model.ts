/**
 * Importing bookmarks and history from Chrome, Edge, Chromium and Firefox (U24, R39), as both sides
 * see it.
 *
 * Pure and free of zod, so the settings page and the start page can import it at runtime; the wire
 * schemas are in `schema.ts` beside it, which only the core and the contract read.
 *
 * ## What crosses, and what does not
 *
 * The page names a profile by the `id` the core gave it and nothing else — never a path. The core
 * finds the profiles again on every request and reads only a file of one it found (`profiles.ts`), so
 * a page cannot ask for a file the core would not have offered. Passwords are not imported here at
 * all: the CSV import of the password manager is the one way in, and the section says so.
 */

/**
 * The settings page's four channels: the profiles on offer, and each import. `channels.ts` spreads
 * them into its lists; named here, beside the shapes they carry, so that file stays under its bar.
 */
export const IMPORT_SECTION_CHANNELS = [
  'import:sources',
  'import:bookmarks',
  'import:previewHistory',
  'import:history'
] as const

/**
 * The start page's card (Q3): whether to show it, closing it for good, and the way to the settings
 * page's section. The card can import nothing itself.
 */
export const IMPORT_CARD_CHANNELS = [
  'import:offer',
  'import:closeOffer',
  'import:openSettings'
] as const

export const IMPORT_BROWSERS = ['chrome', 'edge', 'chromium', 'firefox'] as const

export type ImportBrowser = (typeof IMPORT_BROWSERS)[number]

/** Product names, the same in every language, so they cost the catalogue nothing. */
export const IMPORT_BROWSER_NAMES: Readonly<Record<ImportBrowser, string>> = {
  chrome: 'Chrome',
  edge: 'Edge',
  chromium: 'Chromium',
  firefox: 'Firefox'
}

/** One profile of another browser, as the settings page lists it. */
export interface ImportSource {
  /** The core's name for the profile; the only thing a request carries back. */
  readonly id: string
  readonly browser: ImportBrowser
  /** The profile's own name where the browser keeps one, its folder's otherwise. */
  readonly profile: string
  readonly bookmarks: boolean
  readonly history: boolean
}

/**
 * Why nothing was imported. One sentence each on the page.
 *
 * `locked` is the other browser holding its file: the page asks to close it. `read-only` is this
 * run's own store refusing writes (a newer file, an original that could not be copied aside), which
 * the import must not paper over by writing to memory only.
 */
export const IMPORT_REFUSALS = ['missing', 'locked', 'unreadable', 'read-only', 'full'] as const

export type ImportRefusal = (typeof IMPORT_REFUSALS)[number]

export type BookmarkImportOutcome =
  | {
      readonly outcome: 'imported'
      readonly imported: number
      readonly skipped: number
      /** Already in the folder they would have gone to, by address; not added again. */
      readonly duplicates: number
    }
  | { readonly outcome: 'refused'; readonly reason: ImportRefusal }

/** What a history import does, told before it is confirmed and again after. */
export interface HistoryImportCounts {
  /** New entries, taken into free room only. */
  readonly added: number
  /** Addresses already in the history: one entry, visit counts summed. */
  readonly merged: number
  /** New entries past the history's cap. Left out; the own history is never displaced. */
  readonly dropped: number
  /** Addresses the history does not keep, and visits dated in the future. */
  readonly skipped: number
}

export type HistoryImportOutcome =
  | { readonly outcome: 'preview' | 'imported'; readonly counts: HistoryImportCounts }
  | { readonly outcome: 'refused'; readonly reason: ImportRefusal }

/** The start page's card: shown until it is closed once, or an import succeeds (Q3). */
export interface ImportOffer {
  readonly show: boolean
}
