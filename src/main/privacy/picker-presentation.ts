import {
  canNarrowSelection,
  canWidenSelection,
  selectedCandidate,
  type PickerOutcome,
  type PickerSession
} from '@shared/filters/picker-session.js'
import { pickerBarBounds, type PickerBarMode } from '@shared/overlay/picker-bar.js'
import type { Locale } from '@shared/i18n/catalog.js'
import type { PickerBarPresentation } from '@shared/overlay/surface.js'
import type { Rect } from '@shared/ui/anchor.js'
import { pickerBarText } from './picker-bar-text.js'

/**
 * The picking session, as the confirmation bar has to receive it.
 *
 * ## Why this is a module and not four lines in `ElementPicker`
 *
 * The bar holds no opinion of its own — every field it draws is the core's answer to "what should be
 * on screen right now" — which means every one of those answers is decided here. Which mode a state
 * shows as, which selector is named while nothing is frozen yet, whether a count is a finding or an
 * absence of one, whether Undo may be offered: each can be wrong in a way that produces a
 * perfectly ordinary-looking bar. `ElementPicker.ts` is on the coverage exclude list and cannot hold
 * any of them.
 *
 * ## Why it is core-side rather than beside `pickerBarBounds`
 *
 * The vocabulary is shared because three parties speak it; the *derivation* is not, because only the
 * core has a session to derive from. `shared/find/bar.ts` sits on the other side of that line and
 * nothing is gained by copying it here: a renderer that imported this would be a renderer holding a
 * session, which is the arrangement R12 exists to prevent.
 */

/** Where a bar goes: the tab it belongs to and the tile it is drawn in. */
export interface PickerBarPlace {
  readonly tabId: string
  readonly tileIndex: number
  /** The tile's rectangle in window coordinates — the space `pickerBarBounds` works in. */
  readonly tileRect: Rect
}

export interface PickerBarRequest {
  /**
   * The session, or `null` for a start that was refused before one existed.
   *
   * The refusals of F5 have no session by construction — `no-host` and `not-filterable` are decided
   * at the start, which is precisely why they are decided there — and they still have to be said. A
   * bar that could only describe a running session would be a bar that says nothing on exactly the
   * documents where the refusal is the only thing worth saying.
   */
  readonly session: PickerSession | null
  /** Identity of the attempt, which a refused one has as much as a running one. */
  readonly sessionId: string
  /**
   * The selector under the pointer, while nothing is frozen.
   *
   * Deliberately not session state — it changes many times a second and no transition depends on it
   * — so it arrives here from the propose channel instead. Empty until the pointer has found
   * something a rule could be written for.
   */
  readonly hovered: string
  /** What became of the attempt, or `null` while it is still going on. */
  readonly outcome: PickerOutcome | null
  /** Whether *this* attempt wrote a rule that is still there to take back. */
  readonly canUndo: boolean
  /**
   * The language the interface is in *now*, so a change of setting reaches the next thing the bar says
   * rather than the next session. The words themselves are in `picker-bar-text.ts`.
   */
  readonly locale: Locale
  readonly place: PickerBarPlace
}

/**
 * The bar for one moment of one attempt, or `null` when there should be none.
 *
 * `null` in two cases, and they are different absences. An ended session with no outcome is an
 * abandoned attempt — cancelled, navigated away from, displaced — and it has nothing to report, so
 * the layer holds nothing. A tile too small to hold the bar yields an empty rectangle, and an
 * invisible surface would be worse than no surface: it would hold the layer against everything else
 * while showing nobody anything.
 */
export function pickerBarPresentation(request: PickerBarRequest): PickerBarPresentation | null {
  const mode = barMode(request.session)
  if (mode === 'outcome' && request.outcome === null) return null

  const bounds = pickerBarBounds(request.place.tileRect)
  if (bounds.width === 0 || bounds.height === 0) return null

  const chosen = request.session === null ? null : selectedCandidate(request.session)
  return {
    kind: 'picker-bar',
    sessionId: request.sessionId,
    tileIndex: request.place.tileIndex,
    bounds,
    tabId: request.place.tabId,
    mode,
    /*
      The chosen rung's selector once there is one, and the hovered one until then.

      Both, rather than only the frozen selector, because "wider" and "narrower" cannot be judged
      without seeing what they changed — and because a bar that showed nothing at all while the
      pointer walks the page would give a person no reason to believe the picker is running.
    */
    selector: chosen?.proposal.selector ?? request.hovered,
    /*
      The count is the rung's own, measured in the open document, and `null` before anything has been
      measured. `null` rather than `0`: zero is the finding "this rule changes nothing here", and a
      bar that announced it while the answer was still on its way would be announcing a finding
      nobody had made.
    */
    matches: chosen?.matches ?? null,
    canWiden: request.session !== null && canWidenSelection(request.session),
    canNarrow: request.session !== null && canNarrowSelection(request.session),
    outcome: request.outcome,
    canUndo: request.canUndo,
    text: pickerBarText(request.locale)
  }
}

/**
 * Which of the bar's five modes a session state shows as.
 *
 * Four of them are the session's own first four states by the same names, which is why this is a
 * mapping and not a translation. The fifth is `ended`, and it becomes `outcome` — there is
 * deliberately no bar mode meaning "not on screen", because the layer expresses that by holding
 * nothing.
 *
 * A refused start has no session and shows as `outcome` too: it *is* an outcome, arrived at without
 * passing through any of the states in between.
 */
function barMode(session: PickerSession | null): PickerBarMode {
  if (session === null) return 'outcome'
  switch (session.state) {
    case 'showing':
      return 'showing'
    case 'frozen':
      return 'frozen'
    case 'writing':
      return 'writing'
    case 'measuring':
      return 'measuring'
    case 'ended':
      return 'outcome'
  }
}
