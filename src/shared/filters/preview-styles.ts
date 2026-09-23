import { cosmeticCss, hostChain } from './cosmetic.js'
import { hostnameOfUrl } from './model.js'
import { describeUserRule, type UserRuleDetail } from './user-rules.js'

/**
 * The host-specific stylesheet one **view** is served: the engine's answer for the document, plus
 * whatever that single view — and no other — is currently being shown on top of it.
 *
 * ## Why an addition exists at all
 *
 * `FilterEngine.replaceUserRules` is a single slot for the whole program, fed from the rule store
 * on disk by `FilterSubscription.reloadUserRules`. Two things need a rule to reach exactly one
 * place and neither can use it:
 *
 *   - The element picker's **preview**. R4 says the preview is the real rule running through the
 *     real injection path — the picker has no hiding mechanism of its own, because two mechanisms
 *     for "is this element hidden" is precisely the confusion this feature was reported for. But a
 *     provisional rule in the global slot would hide the element in every window that happens to
 *     be on the same site, including ones nobody is picking in.
 *   - The **session rules** of a private window. They belong to that window's mode and must not be
 *     written to disk or leak into the normal windows sharing the same engine. Put them in the
 *     global slot and a private rule applies everywhere; leave them out and it applies nowhere.
 *
 * So the host-specific delivery became view-bound (KTD3), and this module is the arithmetic behind
 * it: engine answer in, text to deliver out.
 *
 * ## Why this is not in `CosmeticInjector.ts`
 *
 * That file is on `vitest.config.ts`'s coverage exclude list, and the entry says why: it speaks to
 * `app.on('web-contents-created')` and a live `WebContents`, so nothing it decides can be reached
 * by a test. It is admitted there on the understanding that its decisions live somewhere else, and
 * this is where these ones went. What stays over there is the map from view to addition text and
 * the send; everything that can be *wrong* — which lines are honoured, how they are appended, what
 * a revocation restores — is here, where `tests/filter-injection.test.ts` can hold it.
 *
 * ## Why a rule text rather than a selector
 *
 * The addition arrives as filter-list syntax and goes through `describeUserRule`, the same reading
 * a written rule gets. KTD3 asks for that in as many words, and the reason is that a preview which
 * accepted more than the store does would be a way around the store's refusals: `||ads.example^`
 * is a request-blocking rule and `##+js(…)` is code to run in the page, and neither becomes
 * acceptable by being called provisional. The selectors that survive are then translated by
 * `cosmeticCss`, which is the same last gate every other selector passes on its way into a page.
 *
 * Zod-free, Electron-free and Node-free like the rest of `shared/filters`; `tests/architecture.test.ts`
 * holds that line, and it matters here because the injector's own imports reach this file.
 */

/**
 * Why a line of an addition contributed nothing.
 *
 * Four reasons rather than one boolean, because each needs a different sentence and only one of
 * them means the user made a mistake. They are deliberately not `ADD_USER_RULE_OUTCOMES`: those
 * answer "what happened when this was **stored**", and a line can store perfectly well and still
 * have no business in *this* view's stylesheet.
 */
export const ADDITION_REFUSALS = [
  /** The parser makes nothing of it: bad syntax, network syntax, a scriptlet, an unreadable selector. */
  'unreadable',
  /**
   * `#@#` — a line that cancels a selector somebody else contributed.
   *
   * There is nothing here to cancel: the host stylesheet is finished text by the time it arrives,
   * and an addition can only add. Taking the selector at face value would be worse than refusing,
   * because it would *hide* the element the line asks to bring back.
   */
  'exception',
  /**
   * A rule for the procedural engine, which this path is not.
   *
   * `.box:has-text(Anzeige)` is evaluated in the page against text and computed style. The CSS it
   * starts from — `.box` — is strictly broader than the rule, so writing that into a stylesheet
   * would hide every box on the page instead of the one the rule names.
   */
  'procedural',
  /**
   * A good rule, scoped to a host this document is not — or kept off this one by a `~host` in its
   * domain list.
   *
   * R20 from the other side: a preview cannot follow the page. The view navigates, the injector
   * re-serves, and the rule the picker is still holding no longer belongs to what is open.
   */
  'other-host'
] as const

export type AdditionRefusal = (typeof ADDITION_REFUSALS)[number]

/** A line that contributed nothing, kept verbatim so a surface can quote it back (R17). */
export interface RefusedAdditionLine {
  /** The line as given, trimmed. */
  readonly text: string
  readonly reason: AdditionRefusal
}

/** What became of one addition text. */
export interface AdditionReport {
  /** The CSS it contributed, or null when it contributed none. */
  readonly css: string | null
  /** The lines that contributed nothing, in the order they were given. Empty is the good case. */
  readonly refused: readonly RefusedAdditionLine[]
}

export interface ViewStylesheetRequest {
  /**
   * The document being served, exactly as it was passed to `FilterEngine.cosmeticStylesFor`.
   *
   * A URL rather than a hostname, so the injector hands one value to both and cannot hand two
   * different ones. Deriving the host is `hostnameOfUrl`'s job here rather than a line in the file
   * this module exists to keep decisions out of.
   */
  readonly documentUrl: string
  /** What the engine computed for this host. `null` and `''` both mean "nothing of its own". */
  readonly hostStyles: string | null
  /** The picker's provisional rule; absent when nothing is being previewed. */
  readonly preview?: string | null
  /**
   * The mode-bound editor's enabled rules as one body, `enabledUserRuleText`-style; absent when the
   * window has none.
   */
  readonly session?: string | null
}

export interface ViewStylesheet {
  /**
   * The text to deliver.
   *
   * `null` only when there was nothing at all to say — and, with no addition, exactly what came in,
   * so that "nothing to hide" survives the round trip unchanged. The injector's own convention of
   * sending `''` to mean "stop hiding" is its to apply, not this module's to invent.
   */
  readonly css: string | null
  /** What became of the preview text; `null` when none was given. */
  readonly preview: AdditionReport | null
  /** What became of the session text; `null` when none was given. */
  readonly session: AdditionReport | null
}

/**
 * The stylesheet for one view, and what its additions came to.
 *
 * Total: every input has an answer, and a line that cannot be honoured is reported rather than
 * thrown. Revoking is this same call without the addition text — there is deliberately no second
 * route back, because a second route is a second thing that can be forgotten in one of the eleven
 * events that end a picker.
 *
 * The additions are **appended** as rules of their own rather than merged into the host rule's
 * selector list. Merging would mean re-reading a string this module did not write, which is a
 * second selector parser; and it would put a provisional selector inside the same all-or-nothing
 * CSS rule as the site's working ones, where one member the browser cannot read discards every
 * other member with it.
 *
 * Pure, so calling it twice with the same request yields the same string. That is the idempotence
 * that matters, and it holds only because the input is always the *engine's* stylesheet: a caller
 * that fed the previous answer back in would grow the addition on every refresh.
 */
export function viewStylesheet(request: ViewStylesheetRequest): ViewStylesheet {
  // Empty rather than null for a document with no host — `about:blank`, a `data:` document. The
  // injector never serves one (`injectableDocumentUrl` refuses them), so this is the shape of the
  // answer rather than a case: a host-scoped line matches nothing and is refused, while a line the
  // writer chose to leave generic is generic wherever it is served.
  const hostname = hostnameOfUrl(request.documentUrl) ?? ''
  const preview = request.preview ?? null
  const session = request.session ?? null

  const previewReport = preview === null ? null : additionFor(preview, hostname)
  const sessionReport = session === null ? null : additionFor(session, hostname)

  // Session first, preview last: the session's rules are the standing ones and the preview is the
  // thing being tried on top of them. The order changes no outcome — every rule here carries
  // `!important` and the same specificity — which is exactly why it has to be fixed somewhere
  // rather than left to fall out of the argument order at a call site.
  const additions: string[] = []
  for (const report of [sessionReport, previewReport]) {
    if (report !== null && report.css !== null) additions.push(report.css)
  }

  return {
    css: composed(request.hostStyles, additions),
    preview: previewReport,
    session: sessionReport
  }
}

/**
 * The host stylesheet with the additions after it.
 *
 * Returns the host stylesheet *verbatim* when there is nothing to add — including `null`, and
 * including an empty string somebody passed through. That is what makes a revocation restore
 * exactly what the engine said, rather than something equivalent to it.
 */
function composed(hostStyles: string | null, additions: readonly string[]): string | null {
  if (additions.length === 0) return hostStyles
  const host = hostStyles ?? ''
  return host === '' ? additions.join('\n') : [host, ...additions].join('\n')
}

/**
 * One addition text, read line by line.
 *
 * Line by line because a session's rules are a list, and a list is where isolation matters: the
 * rule somebody typed wrong sits between two that are right, and losing all three would look, to
 * them, exactly like the browser ignoring them. Blank lines are skipped rather than refused —
 * `enabledUserRuleText` joins with newlines and yields `''` for an empty list, so both arrive here
 * in ordinary use and neither is a mistake anybody made.
 */
function additionFor(text: string, hostname: string): AdditionReport {
  const chain = new Set(hostChain(hostname))
  const selectors: string[] = []
  const refused: RefusedAdditionLine[] = []

  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const verdict = readLine(trimmed, chain)
    if (verdict.taken) selectors.push(verdict.selector)
    else refused.push({ text: trimmed, reason: verdict.reason })
  }

  // `cosmeticCss` and not a template of our own: it is the last gate on what enters a page, it
  // answers null for a batch that filtered down to nothing, and it writes the one declaration —
  // `display: none !important` — that every other route into a stylesheet writes.
  return { css: cosmeticCss(selectors), refused }
}

/** What one line of an addition amounts to: a selector to append, or a reason it is not one. */
type LineVerdict =
  | { readonly taken: true; readonly selector: string }
  | { readonly taken: false; readonly reason: AdditionRefusal }

function readLine(line: string, chain: ReadonlySet<string>): LineVerdict {
  const detail = describeUserRule(line)
  if (detail === null) return { taken: false, reason: 'unreadable' }
  const refusal = kindRefusal(detail)
  if (refusal !== null) return { taken: false, reason: refusal }
  // A rule naming no host applies everywhere by its writer's own choosing. One naming hosts has to
  // name this one, matched against the host's parent domains exactly as `cosmeticSelectorsFor`
  // matches a list's rules — a rule for `example.com` applies on `www.example.com`.
  const scoped = detail.hosts.length > 0 && !detail.hosts.some((host) => chain.has(host))
  // And a `~host` keeps it off that host and below, as the engine's own matching does
  // (`isExcluded` in cosmetic.ts) — so the same line behaves the same in a private window.
  const excluded = detail.excludedHosts.some((host) => chain.has(host))
  return scoped || excluded
    ? { taken: false, reason: 'other-host' }
    : { taken: true, selector: detail.selector }
}

/**
 * The refusals that follow from what a readable rule *is*, whichever document it is served to. Null for a
 * rule an addition can carry on a host it names.
 */
function kindRefusal(detail: UserRuleDetail): 'exception' | 'procedural' | null {
  if (detail.isException) return 'exception'
  if (detail.kind === 'procedural') return 'procedural'
  return null
}

/**
 * Whether a rule can reach a page as an addition at all: on the hosts it names, `viewStylesheet` would
 * take it.
 *
 * What a private window's editor asks before it holds a rule (`SessionUserRuleEditor`). That editor's rules
 * reach its pages through this module and nowhere else, so a rule this answers `false` for — a procedural
 * one, a `#@#` exception — would be listed as working and do nothing. Asked here rather than restated
 * there, so the editor's refusal and the stylesheet's cannot drift apart: both are `kindRefusal`.
 */
export function isAdditionRule(text: string): boolean {
  const detail = describeUserRule(text)
  return detail !== null && kindRefusal(detail) === null
}
