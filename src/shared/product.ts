/**
 * Who this application says it is.
 *
 * One place, because the name is not one string: it is the window title, the installer's
 * product name, a reverse-DNS identifier that ends up in Windows registry keys and macOS
 * bundle paths, the URL scheme every internal page is served from, and a word inside two
 * dozen translated sentences.
 *
 * Centralising it first paid for itself: renaming the working title `ownbrowser` to Tessera was an
 * edit here plus the package files and a short list of places a `.d.ts` forces to spell it out —
 * not a search through forty files, half of them prose where a replacement would also have hit the
 * word inside unrelated sentences.
 *
 * Deliberately dependency-free: the preload, both renderers and the core all read it.
 *
 * ## The scheme is the expensive part
 *
 * `PRODUCT_SCHEME` is not merely cosmetic. Once a user has a bookmark or a history entry on
 * `tessera://history`, changing it breaks their saved data — which is exactly why the name was
 * settled before any of that data exists.
 */

/**
 * User-visible product name. Appears in titles, menus and translated sentences.
 *
 * Latin for the single stone of a mosaic: many small pieces side by side making one picture, which
 * is what the split view is. Capitalised because it is a proper noun; the scheme and the identifier
 * below are lower case because their formats require it.
 */
export const PRODUCT_NAME = 'Tessera'

/**
 * URL scheme for internal pages, without the colon.
 *
 * Registered as privileged at startup, so it must be a valid scheme name: lower case, no
 * spaces, no underscores.
 */
export const PRODUCT_SCHEME = 'tessera'

/**
 * Reverse-DNS application identifier for installers and the OS.
 *
 * Changing it after a release makes the next installer look like a different application to
 * the operating system, which means an in-place upgrade becomes a second installation.
 */
export const APP_ID = 'de.m3connect.tessera'

/** The scheme with its colon, as `URL.protocol` reports it. */
export const INTERNAL_SCHEME = `${PRODUCT_SCHEME}:`

/**
 * The address of an internal page.
 *
 * Built here rather than by string concatenation at each call site, so a scheme change cannot
 * leave a stale address behind in a menu item nobody clicked during testing.
 */
export function internalUrl(page: string, query?: Readonly<Record<string, string>>): string {
  const base = `${INTERNAL_SCHEME}//${page}`
  if (query === undefined) return base
  const search = new URLSearchParams(query).toString()
  return search === '' ? base : `${base}?${search}`
}

/**
 * ## What is deliberately not here
 *
 * The name of the bridge object on `window` — `window.tessera` and `window.tesseraInternal`.
 * A global's name has to be spelled out in the `.d.ts` declarations that give it a type, and a
 * declaration cannot reference a runtime constant. Renaming those is a separate, mechanical edit
 * across `src/preload/*.d.ts` and the two bridge modules; pretending it is centralised here would
 * be worse than saying so.
 */

/** True when `url` is served by this application rather than by a website. */
export function isInternalScheme(url: string): boolean {
  // Parsed rather than prefix-matched: `tessera://x@evil.example` and
  // `https://evil.example/#tessera://` both defeat a naive `startsWith` check.
  try {
    return new URL(url).protocol === INTERNAL_SCHEME
  } catch {
    return false
  }
}
