import { classifyOmniboxInput } from '../url/omnibox.js'

/**
 * Quick links for the start page — the Speed Dial from spec 1.
 *
 * ## Why this file has no zod import
 *
 * The runtime schemas live in `schema.ts`, not here, and that separation is a
 * performance decision rather than a stylistic one. The start page needs
 * `childrenOf` and `countChildren`; if those sat next to the schemas, importing
 * one would pull the whole validation library into the renderer bundle. It did,
 * costing roughly half a megabyte of parse and compile work on every window open
 * — which is invisible on a fast desktop and very much not on an older laptop.
 *
 * The rule that follows: `shared` modules imported by a renderer stay free of
 * heavyweight dependencies, and validation lives in its own module that only the
 * core and the IPC contract import. A bundle-size test enforces it.
 *
 * ## Why every operation is pure
 *
 * Each takes the current list and returns a new one, so the tree rules — no folder
 * inside a folder, no folder moved into its own child, contiguous sibling order —
 * exist in one testable place instead of being re-implemented across a store, an
 * IPC handler and a drag handler.
 *
 * Sibling order is array order within the same `parentId`. There is deliberately
 * no position field: two sources of ordering truth drift, and a reorder then has
 * to repair state instead of just moving an element.
 */

export const QUICK_LINK_KINDS = ['link', 'folder'] as const
export type QuickLinkKind = (typeof QUICK_LINK_KINDS)[number]

export const MAX_TITLE_LENGTH = 80
export const MAX_QUICK_LINKS = 500

export interface QuickLink {
  id: string
  kind: QuickLinkKind
  title: string
  /** Always empty for folders. */
  url: string
  /** `null` means top level. Only links may sit inside a folder. */
  parentId: string | null
  createdAt: number
}

export interface QuickLinkDocument {
  version: 1
  links: QuickLink[]
}

export function emptyQuickLinkDocument(): QuickLinkDocument {
  return { version: 1, links: [] }
}

export function isQuickLinkKind(value: unknown): value is QuickLinkKind {
  return typeof value === 'string' && (QUICK_LINK_KINDS as readonly string[]).includes(value)
}

// --- errors ------------------------------------------------------------------
// Named types rather than bare strings, so an IPC handler can map them to a
// message the user can act on instead of a generic failure.

export class QuickLinkNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Quick link not found: ${id}`)
    this.name = 'QuickLinkNotFoundError'
  }
}

export class InvalidQuickLinkUrlError extends Error {
  constructor(readonly input: string) {
    super(`Not a usable address: ${input}`)
    this.name = 'InvalidQuickLinkUrlError'
  }
}

export class QuickLinkNestingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuickLinkNestingError'
  }
}

export class QuickLinkLimitError extends Error {
  constructor(readonly limit: number) {
    super(`Cannot hold more than ${limit} quick links`)
    this.name = 'QuickLinkLimitError'
  }
}

// --- reads -------------------------------------------------------------------

/** Direct children of a folder, or the top level for `null`, in display order. */
/*
  Generic over the element, so a caller holding richer objects gets them back.

  The start page holds `QuickLinkCard`s — links plus the addresses of their pictures — and a signature
  fixed to `QuickLink` would silently widen them back on the way through, taking the pictures with it.
  Neither function looks at anything a card adds, so there is nothing here to constrain further.
*/
export function childrenOf<T extends QuickLink>(links: readonly T[], parentId: string | null): T[] {
  return links.filter((link) => link.parentId === parentId)
}

export function findLink<T extends QuickLink>(links: readonly T[], id: string): T | undefined {
  return links.find((link) => link.id === id)
}

/** A folder's child count, for the tile's "3 items" label. */
export function countChildren(links: readonly QuickLink[], folderId: string): number {
  return links.reduce((total, link) => (link.parentId === folderId ? total + 1 : total), 0)
}

// --- url handling ------------------------------------------------------------

/**
 * Turns typed text into a storable URL.
 *
 * Reuses the address bar's classifier, so `example.com` becomes
 * `https://example.com` here exactly as it would in the omnibox. Search terms are
 * rejected rather than silently turned into a search URL — a tile that quietly
 * became a search for what you typed is worse than a refusal.
 */
export function normalizeQuickLinkUrl(input: string): string {
  const intent = classifyOmniboxInput(input)
  if (intent.kind !== 'url') throw new InvalidQuickLinkUrlError(input)
  return intent.url
}

/** Fallback title from a URL, for when the user leaves the name blank. */
export function titleFromUrl(url: string): string {
  try {
    const { hostname, pathname } = new URL(url)
    if (hostname !== '') return hostname.replace(/^www\./, '')
    // `tessera://start` and friends have no host worth showing.
    return pathname.replace(/^\/+/, '') || url
  } catch {
    return url
  }
}

function cleanTitle(title: string, url: string): string {
  const trimmed = title.trim().slice(0, MAX_TITLE_LENGTH)
  return trimmed === '' ? titleFromUrl(url).slice(0, MAX_TITLE_LENGTH) : trimmed
}

// --- writes ------------------------------------------------------------------

export interface CreateLinkInput {
  kind: QuickLinkKind
  title: string
  /** Raw user input; normalised here. Ignored for folders. */
  url?: string
  parentId?: string | null
  /** Position among siblings; appended when omitted. */
  index?: number
}

export interface CreateContext {
  id: string
  now: number
}

/**
 * Adds a link or folder.
 *
 * `id` and `now` come from the caller so the function stays pure and tests do not
 * have to freeze the clock.
 */
export function createLink(
  links: readonly QuickLink[],
  input: CreateLinkInput,
  context: CreateContext
): QuickLink[] {
  if (links.length >= MAX_QUICK_LINKS) throw new QuickLinkLimitError(MAX_QUICK_LINKS)

  const parentId = input.parentId ?? null
  if (parentId !== null) {
    const parent = findLink(links, parentId)
    if (parent === undefined) throw new QuickLinkNotFoundError(parentId)
    if (parent.kind !== 'folder') {
      throw new QuickLinkNestingError('Quick links can only be placed inside a folder')
    }
    // One level of folders keeps the start page navigable and the rules simple.
    if (input.kind === 'folder') {
      throw new QuickLinkNestingError('Folders cannot be nested')
    }
  }

  const url = input.kind === 'folder' ? '' : normalizeQuickLinkUrl(input.url ?? '')

  const link: QuickLink = {
    id: context.id,
    kind: input.kind,
    title: cleanTitle(input.title, url),
    url,
    parentId,
    createdAt: context.now
  }

  return insertAmongSiblings([...links], link, parentId, input.index)
}

export interface UpdateLinkPatch {
  title?: string
  /** Raw user input; normalised. Rejected for folders, which have no URL. */
  url?: string
}

export function updateLink(
  links: readonly QuickLink[],
  id: string,
  patch: UpdateLinkPatch
): QuickLink[] {
  const existing = findLink(links, id)
  if (existing === undefined) throw new QuickLinkNotFoundError(id)

  if (patch.url !== undefined && existing.kind === 'folder') {
    throw new QuickLinkNestingError('A folder has no address')
  }

  const url = patch.url === undefined ? existing.url : normalizeQuickLinkUrl(patch.url)
  const title = patch.title === undefined ? existing.title : cleanTitle(patch.title, url)

  const next: QuickLink = {
    ...existing,
    title,
    url
  }

  return links.map((link) => (link.id === id ? next : link))
}

/**
 * Removes a link, or a folder together with everything inside it.
 *
 * Deleting a folder's children with it is deliberate: leaving them behind with a
 * dangling `parentId` would make them invisible but still counted, which reads as
 * data loss without actually freeing anything.
 */
export function removeLink(links: readonly QuickLink[], id: string): QuickLink[] {
  const existing = findLink(links, id)
  if (existing === undefined) throw new QuickLinkNotFoundError(id)

  const doomed = new Set<string>([id])
  if (existing.kind === 'folder') {
    for (const link of links) {
      if (link.parentId === id) doomed.add(link.id)
    }
  }
  return links.filter((link) => !doomed.has(link.id))
}

/**
 * Moves a link to a new parent and position — the drag-and-drop operation.
 *
 * Rejects moving a folder into a folder, and moving anything into itself.
 */
export function moveLink(
  links: readonly QuickLink[],
  id: string,
  parentId: string | null,
  toIndex: number
): QuickLink[] {
  const existing = findLink(links, id)
  if (existing === undefined) throw new QuickLinkNotFoundError(id)

  if (parentId !== null) {
    if (parentId === id) throw new QuickLinkNestingError('Cannot move an item into itself')
    const parent = findLink(links, parentId)
    if (parent === undefined) throw new QuickLinkNotFoundError(parentId)
    if (parent.kind !== 'folder') {
      throw new QuickLinkNestingError('Quick links can only be placed inside a folder')
    }
    if (existing.kind === 'folder') {
      throw new QuickLinkNestingError('Folders cannot be nested')
    }
  }

  const withoutMoved = links.filter((link) => link.id !== id)
  const moved: QuickLink = { ...existing, parentId }
  return insertAmongSiblings(withoutMoved, moved, parentId, toIndex)
}

/**
 * Places `link` into `list` so it lands at `index` among the items sharing
 * `parentId`.
 *
 * The list is flat and holds every parent's children, so a sibling index has to be
 * translated into an absolute one. Appending when `index` is out of range is the
 * forgiving choice: a drag that overshoots the last tile should land at the end,
 * not fail.
 */
function insertAmongSiblings(
  list: QuickLink[],
  link: QuickLink,
  parentId: string | null,
  index?: number
): QuickLink[] {
  const siblingIndices = list.reduce<number[]>((acc, item, position) => {
    if (item.parentId === parentId) acc.push(position)
    return acc
  }, [])

  const target = index ?? siblingIndices.length
  const clamped = Math.max(0, Math.min(Math.trunc(target), siblingIndices.length))

  const absolute =
    clamped >= siblingIndices.length
      ? // After the last sibling — or at the end of the list when there are none.
        (siblingIndices.at(-1) ?? list.length - 1) + 1
      : siblingIndices[clamped]!

  const next = [...list]
  next.splice(absolute, 0, link)
  return next
}

/**
 * Re-parents entries that reference a missing or non-folder parent.
 *
 * Runs when the file is read: a hand-edited or partially written document must not
 * leave items permanently invisible, and moving them to the top level is
 * recoverable where hiding them is not.
 */
export function repairTree(links: readonly QuickLink[]): QuickLink[] {
  const folders = new Set(links.filter((link) => link.kind === 'folder').map((link) => link.id))
  return links.map((link) => {
    if (link.parentId === null) return link
    // A folder can never have a parent, and a link's parent must be a folder.
    if (link.kind === 'folder' || !folders.has(link.parentId)) {
      return { ...link, parentId: null }
    }
    return link
  })
}
