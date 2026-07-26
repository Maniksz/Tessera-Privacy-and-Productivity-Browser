import type { ManifestState, MediaFinding } from './model.js'

/**
 * What each tab is playing, kept per tab.
 *
 * Per tab rather than per window, and that is the requirement rather than a
 * refinement: a window with four tiles is four pages playing at once, and a
 * finding list that pooled them would offer the user a download from a video they
 * are not looking at. Findings are therefore keyed by tab id, and a tab that
 * navigates loses its own and only its own.
 *
 * Pure functions over an immutable value, in the same division the history and
 * favicon models use: `MediaRegistry` supplies the clock, the network and the
 * identity of the tab, and these functions decide what the collection then looks
 * like. Every one of them returns the *same* state object when nothing changed, so
 * a registry can use identity to decide whether to wake its listeners — a page
 * that re-requests its playlist on every seek would otherwise notify the interface
 * dozens of times a minute for no new information.
 */

export interface MediaFindingsState {
  readonly byTab: Readonly<Record<string, readonly MediaFinding[]>>
}

/**
 * Findings kept per tab.
 *
 * A ceiling exists because the input is unbounded: a page assembling its own
 * buffer can ask for a great many distinct addresses, and a list that grows
 * without limit is a slow memory leak attached to whatever the user left open.
 * Forty is far past what any real page offers and far short of a problem.
 */
export const MAX_FINDINGS_PER_TAB = 40

const NO_FINDINGS: readonly MediaFinding[] = []

export function emptyMediaFindings(): MediaFindingsState {
  return { byTab: {} }
}

/** In discovery order, oldest first. Empty for a tab with nothing. */
export function findingsForTab(state: MediaFindingsState, tabId: string): readonly MediaFinding[] {
  return state.byTab[tabId] ?? NO_FINDINGS
}

export function findFinding(
  state: MediaFindingsState,
  tabId: string,
  findingId: string
): MediaFinding | null {
  return findingsForTab(state, tabId).find((finding) => finding.id === findingId) ?? null
}

/**
 * The fields a repeated observation can change.
 *
 * Compared as one string rather than field by field, because the alternative is a
 * six-clause condition whose branches are individually meaningless — and a
 * condition nobody can hold in their head is one a later edit quietly breaks. The
 * manifest is represented by its status only, which is enough *here*: the merge
 * below never produces a loaded manifest, so two states with the same status are
 * the same state as far as this comparison is concerned.
 */
function fingerprintOf(finding: MediaFinding): string {
  const parts = [
    finding.kind,
    finding.container,
    finding.contentType ?? '',
    String(finding.byteLength ?? -1),
    finding.documentUrl ?? '',
    finding.manifest?.status ?? 'none'
  ]
  return parts.join('|')
}

/**
 * One address seen twice, folded into one finding.
 *
 * The same media is observed at least twice by design — once when the request goes
 * out (address and resource type, no content type) and once when the headers come
 * back (content type, length). They are the same finding, so the second must
 * enrich the first rather than appear beside it.
 *
 * The content type is what makes an observation authoritative. It is the server
 * stating what the bytes are, so it overrules a kind inferred from an extension:
 * an address ending `.mp4` that answers with `application/x-mpegurl` is a
 * playlist, and treating it as a file would produce a download of the playlist
 * text.
 */
function enrich(existing: MediaFinding, candidate: MediaFinding): MediaFinding {
  const authoritative = candidate.contentType !== null
  const kind = authoritative ? candidate.kind : existing.kind
  return {
    ...existing,
    kind,
    container: candidate.container === 'unknown' ? existing.container : candidate.container,
    contentType: candidate.contentType ?? existing.contentType,
    byteLength: candidate.byteLength ?? existing.byteLength,
    documentUrl: existing.documentUrl ?? candidate.documentUrl,
    // A kind that flipped to a manifest needs somewhere to record the manifest;
    // one that was already a manifest keeps whatever has been loaded.
    manifest: kind === 'progressive' ? null : (existing.manifest ?? { status: 'not-loaded' })
  }
}

/**
 * Adds a finding, or folds it into the one already recorded for that address.
 *
 * The candidate's id and timestamp are discarded on a merge: the finding keeps the
 * identity it was first given, so an interface holding a reference to it does not
 * lose its place when the response headers arrive.
 */
export function recordMediaFinding(
  state: MediaFindingsState,
  candidate: MediaFinding,
  maxPerTab: number
): MediaFindingsState {
  const list = findingsForTab(state, candidate.tabId)
  const existing = list.find((finding) => finding.url === candidate.url)

  if (existing === undefined) {
    const appended = [...list, candidate]
    // Oldest first out. The newest finding is the one the user just started
    // playing, which is the one they are asking about.
    const capped =
      appended.length > maxPerTab ? appended.slice(appended.length - maxPerTab) : appended
    return { byTab: { ...state.byTab, [candidate.tabId]: capped } }
  }

  const enriched = enrich(existing, candidate)
  if (fingerprintOf(enriched) === fingerprintOf(existing)) return state
  return {
    byTab: {
      ...state.byTab,
      [candidate.tabId]: list.map((finding) => (finding === existing ? enriched : finding))
    }
  }
}

/**
 * Records what a manifest turned out to contain.
 *
 * A finding that is no longer there is not an error: the load is asynchronous and
 * the tab may have navigated while it was in flight. Returning the state unchanged
 * is how that case is handled everywhere, rather than by the caller checking
 * first and racing anyway.
 */
export function setManifestState(
  state: MediaFindingsState,
  tabId: string,
  findingId: string,
  manifest: ManifestState
): MediaFindingsState {
  const list = findingsForTab(state, tabId)
  if (!list.some((finding) => finding.id === findingId)) return state
  return {
    byTab: {
      ...state.byTab,
      [tabId]: list.map((finding) =>
        finding.id === findingId ? { ...finding, manifest } : finding
      )
    }
  }
}

/**
 * Drops everything a tab found.
 *
 * Called when the tab navigates and when it closes. The key is removed rather than
 * set to an empty array, so a closed tab leaves nothing behind at all — findings
 * name the addresses a page fetched, which is browsing history by another route
 * and has no business outliving the page.
 */
export function forgetTabFindings(state: MediaFindingsState, tabId: string): MediaFindingsState {
  if (!(tabId in state.byTab)) return state
  return {
    byTab: Object.fromEntries(Object.entries(state.byTab).filter(([key]) => key !== tabId))
  }
}
