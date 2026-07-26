import { internalUrl } from '../product.js'

/**
 * The address of a reader view.
 *
 * Shared because both ends need it and they are in different processes: the core builds the address
 * when it opens the tab, and the page reads the id back out of its own location. Two spellings of one
 * query parameter is the sort of mismatch that produces an empty page with nothing to explain it.
 */

/** The `tessera://reader` page name. Must match `INTERNAL_PAGES` and `KNOWN_PAGES`. */
export const READER_PAGE = 'reader'

export const READER_ID_PARAM = 'id'

/**
 * Where one extraction is shown.
 *
 * The id goes in the address rather than being resolved from the sender, which is the opposite of
 * what `history:open` does — and for a reason: the core creates the reader tab, so at the moment the
 * address is built there is no sender yet to resolve. Putting it in the address also means a reload
 * of the reader tab fetches the same extraction rather than an empty one.
 */
export function readerUrlFor(id: string): string {
  return internalUrl(READER_PAGE, { [READER_ID_PARAM]: id })
}

/**
 * The extraction id in a `?id=…` query string, or null.
 *
 * Total: a page opened by hand, or a link a site wrote to `tessera://reader`, has no id and gets the
 * `expired` refusal rather than an exception. Parsed with `URLSearchParams` rather than split by
 * hand, because a value containing an escaped separator is exactly the input a hand-rolled parser
 * gets wrong.
 */
export function readerIdOf(search: string): string | null {
  const id = new URLSearchParams(search).get(READER_ID_PARAM)
  return id === null || id === '' ? null : id
}
