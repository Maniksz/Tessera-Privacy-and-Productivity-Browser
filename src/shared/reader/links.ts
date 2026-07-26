/**
 * Which addresses extracted content may carry.
 *
 * Its own module, small as it is, because the reader page needs exactly this and nothing else out of
 * the extraction code. Importing it from `content.ts` would pull the whole extractor — and
 * `filters/identifiers.ts` behind it — into a renderer bundle that only wants to know whether an
 * `href` is safe to put on an anchor. The project already treats a shared module's import graph as a
 * performance decision rather than a stylistic one; see `ARCHITECTURE.md`.
 */

/**
 * An allowlist, because the interesting cases are all in a denylist's blind spot.
 *
 * `javascript:` is the obvious one, but so is `data:text/html`, and so is any scheme the operating
 * system hands to another application. Reader mode renders a *visited site's* links inside an internal
 * page, so this is the one place where a scheme nobody thought about becomes that site's way in.
 */
const LINK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

/**
 * The address a link may keep, or `null`.
 *
 * Parsed rather than prefix-matched: `JaVaScRiPt:`, a leading newline and an embedded tab all defeat a
 * `startsWith` check, and `URL` is the same parser the navigation itself would use — so there is no
 * gap between what this accepts and what the browser would do with it.
 *
 * A refused address is not an error. The run keeps its text and loses its link, so the sentence still
 * reads and the click does nothing, which is the right way round.
 */
export function linkTargetOf(href: string | undefined): string | null {
  if (href === undefined) return null
  try {
    const parsed = new URL(href)
    return LINK_SCHEMES.has(parsed.protocol) ? parsed.href : null
  } catch {
    return null
  }
}
