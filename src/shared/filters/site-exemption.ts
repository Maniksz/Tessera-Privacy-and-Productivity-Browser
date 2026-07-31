import { matchHostRule } from '../url/domain.js'

/**
 * Sites the user has switched the blocker off for, and what "off" covers.
 *
 * ## Why this exists
 *
 * `blocker-menu-items.ts` already argues the need: *"a blocker with no visible off switch for the
 * current site is a blocker people uninstall"*. What that menu had was the **global** switch, so the
 * only way to read a page the blocker breaks was to stop blocking everywhere and remember to turn it
 * back on. Nobody remembers. The switch that gets used is the per-site one, and its absence is why the
 * global one is dangerous.
 *
 * ## What it does not cover, which is the part worth deciding on purpose
 *
 * Exactly two things: the filter-list stage in `RequestPipeline`, and cosmetic filtering. Nothing else.
 *
 * The temptation is to make it mean "no privacy measures on this site at all", because that is what
 * uBlock Origin's trusted-site switch does and it is one line either way. It is refused here because
 * the reason somebody reaches for this switch is *"this page is broken"*, and the measures they would
 * silently lose have nothing to do with a broken page: HTTPS-only mode, third-party cookie blocking,
 * referrer trimming, the telemetry host list, fingerprint masking. Turning those off to make a layout
 * work would be trading something the user cannot see for something they can, without telling them.
 *
 * So the promise is narrow and stated: an exempt site is one this browser does not *filter*. It is
 * still a site this browser protects.
 *
 * ## Why a host list rather than a per-tab flag
 *
 * A flag on the tab would be lost on navigation, on restore, and on opening the same site in a second
 * tile — three ways for the page to break again with the switch still apparently on. A host survives all
 * of them, and it is auditable: the list is a setting, so it is visible on the settings page and can be
 * edited there rather than only accumulating from menu clicks.
 *
 * Zod-free, like the rest of this directory: the settings surface and the blocker menu both need the
 * *type* and the decision, and a value import of the validation library reaches the renderer bundle.
 */

/** A hostname, or `null` for a document with no host to key an exemption on. */
export type ExemptionSubject = string | null

/**
 * The hostname an exemption would be keyed on, or `null` if there is none.
 *
 * `null` for an internal page, a `file:` document, an `about:` URL and anything unparseable — the same
 * boundary `canPickElement` uses in the blocker menu, and for the same reason: a rule needs a host, and
 * offering to switch blocking off for a document that has none is offering something that cannot be
 * stored.
 *
 * The hostname rather than the registrable domain, so `docs.example.com` can be exempt without
 * `shop.example.com` following it. Matching then walks *up*: an exemption written for `example.com`
 * covers both, because `hostMatchesRule` matches whole labels from the right. That is the asymmetry the
 * user wants — narrow by default, broad on request — and it comes free from the existing matcher.
 */
export function exemptionHostOf(documentUrl: string | null): ExemptionSubject {
  if (documentUrl === null || documentUrl === '') return null
  let parsed: URL
  try {
    parsed = new URL(documentUrl)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return parsed.hostname === '' ? null : parsed.hostname.toLowerCase()
}

/**
 * Whether filtering is switched off for this document.
 *
 * Takes the document URL rather than a host so every caller asks the same question of the same input —
 * the pipeline has a `documentUrl`, the injector has one, and the menu has a tab's URL. A second place
 * deriving the host is a second place to get subdomains wrong.
 *
 * A document with no host is never exempt. That is the safe direction and it is also the only coherent
 * one: there is nothing in the list it could match.
 */
export function filteringExemptFor(
  documentUrl: string | null,
  exemptSites: readonly string[]
): boolean {
  if (exemptSites.length === 0) return false
  const host = exemptionHostOf(documentUrl)
  if (host === null) return false
  return matchHostRule(host, exemptSites) !== null
}

/**
 * The list with this host added or removed — the menu's toggle, as a pure function.
 *
 * Returns the list unchanged when there is nothing to do, so a caller can compare by identity and skip
 * a settings write that would broadcast a change nobody made.
 *
 * Removing takes out **every** entry that covers the host, not just an exact match. Otherwise switching
 * blocking back on for `docs.example.com` while an `example.com` exemption is in the list would appear
 * to do nothing: the menu would show the switch back on and the page would still not be filtered. One
 * click, one honest outcome.
 */
export function withSiteExemption(
  exemptSites: readonly string[],
  host: string,
  exempt: boolean
): readonly string[] {
  const normalized = host.trim().toLowerCase()
  if (normalized === '') return exemptSites

  if (exempt) {
    if (matchHostRule(normalized, exemptSites) !== null) return exemptSites
    return [...exemptSites, normalized]
  }

  const kept = exemptSites.filter((entry) => !hostCoveredBy(normalized, entry))
  return kept.length === exemptSites.length ? exemptSites : kept
}

/** Whether `entry` is an exemption that covers `host`. The direction matters; see `withSiteExemption`. */
function hostCoveredBy(host: string, entry: string): boolean {
  return matchHostRule(host, [entry]) !== null
}
