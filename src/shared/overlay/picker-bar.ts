import type { Rect } from '../ui/anchor.js'

/**
 * The vocabulary the element picker's confirmation bar is described in, and where it sits.
 *
 * ## Why it lives beside the overlay surface rather than with the filters
 *
 * The same reason `permission.ts` does: three parties have to agree on these names — the core, which
 * runs the picking session and decides what the bar shows; the overlay renderer, which draws it; and
 * the IPC contract, which validates the word coming back. The renderer is a renderer, so the names
 * cannot live in `@main`, and a confirmation bar is a *presentation*, so they belong with the rest of
 * what the topmost layer can show.
 *
 * The rest of the picker's shared model — what a selector proposal is, how a rule text is built — stays
 * in `shared/filters/`, because none of it is about a surface.
 *
 * Zod-free and Electron-free, like everything both renderers import at runtime.
 */

/**
 * What the bar is showing, which is the session's state as far as a person can see it.
 *
 * `showing` — the pointer is walking the page and nothing is chosen yet. The bar names the selector
 *   under the pointer and offers no confirmation, because there is nothing to confirm.
 * `frozen` — a click has fixed the selection. This is the state the whole feature exists for: the
 *   selector and its measured match count are on screen, and they can be widened and narrowed before
 *   anything is written.
 * `writing` — the rule is going to the user's own rules. A waiting state rather than an instant, so a
 *   second press of Confirm cannot write twice.
 * `measuring` — the rule is written and the provisional preview has been taken back off the page; what
 *   is being established now is whether the *stored* rule actually hides anything.
 * `outcome` — the attempt is over and has a name. Every path arrives here, including the refusals: the
 *   defect this feature is being rebuilt around is a picker that closed and said nothing.
 *
 * There is deliberately no `ended` here. A session that has ended has no bar on the layer, and a mode
 * meaning "not on screen" would be a second way to express an absence the layer already expresses by
 * holding nothing.
 */
export const PICKER_BAR_MODES = ['showing', 'frozen', 'writing', 'measuring', 'outcome'] as const

export type PickerBarMode = (typeof PICKER_BAR_MODES)[number]

/**
 * What a person can do to the bar, as one word.
 *
 * The whole payload of the action channel, and that is the design rather than an economy. The core
 * already holds the selection, the proposed selector and the rule text it would write; a message that
 * carried any of them would let the sender choose what gets written, and the sender is a renderer. So
 * the words name *intentions* and the core resolves each against its own session state — the precedent
 * `permissions:answer` set, where the answer is an enum and the question is the core's.
 *
 * `cancel` is here rather than being left to a plain `overlay:dismiss` on purpose: a dismissal takes
 * down whatever is up, and a cancel that arrived a moment after a consent dialogue had claimed the
 * layer would take the dialogue down — which the safe default turns into a refusal nobody gave. Named,
 * it can only ever end the bar.
 */
export const PICKER_BAR_ACTIONS = [
  'confirm',
  'cancel',
  'widen',
  'narrow',
  'undo',
  'open-rules'
] as const

export type PickerBarAction = (typeof PICKER_BAR_ACTIONS)[number]

/**
 * "Block this element": what has been chosen, what it would hide, and what became of it.
 *
 * ## Why the result appears here rather than in the page
 *
 * The picker used to draw its own bar into the document it was picking in, and that is the reason a
 * click could fail five different ways without anybody finding out: the surface that would have carried
 * the news tore itself down in the same breath as the message that asked for the rule. It also cannot
 * work everywhere it is needed — a document that carries no picker surface at all is exactly the kind
 * of document a refusal has to be reported on.
 *
 * So the news arrives on the window's own layer, where the browser can always speak, and the page is
 * left to do the one thing only it can do: show what disappeared.
 *
 * ## Why the whole visible state is one message
 *
 * The bar holds no opinion of its own. Every field below is the core's answer to "what should be on
 * screen right now", and the surface renders it — the find bar's rule, for the find bar's reason: two
 * places accumulating the same state eventually disagree, and the one that is wrong is always the one
 * the user is looking at. The cost is that the presentation is re-sent as the selection is refined and
 * as measurements arrive, which is what `sessionId` is for; see `surfaceIdentity`.
 */
export interface PickerBarPresentation {
  kind: 'picker-bar'
  /**
   * Identity of the *picking session*, not of the bar.
   *
   * Two jobs, both load-bearing, and both taken from the find bar. The layer tells an update from a
   * departure by it, so a new match count does not read as the bar leaving — which here would end the
   * session the moment it had something to report. And the session that owns a departed bar is found by
   * it, which is how a bar the layer took down for reasons of its own still gets its provisional rule
   * lifted off the page.
   */
  sessionId: string
  /** The tile picked in. Also its label: "block an element in tile 2" is what a screen reader reads. */
  tileIndex: number
  /** The box, in window coordinates — the bounds the layer takes while this is up. */
  bounds: Rect
  /** The tab picked in. Never empty: there is no picker session without a document to pick in. */
  tabId: string
  mode: PickerBarMode
  /**
   * The selector that would be written, in the form the user is being asked to accept.
   *
   * Shown at every stage rather than only once frozen: a person cannot judge "wider" and "narrower"
   * without seeing what changed, and a confirmation that hides what it confirms is not one.
   */
  selector: string
  /**
   * How many elements the selector hits in the open document, or `null` while nothing has been measured.
   *
   * `null` rather than `0`, and the difference is the whole point of measuring at all: zero means "this
   * rule changes nothing here", which is a real and reportable finding, while "not yet counted" is the
   * absence of a finding. Collapsed into one value, a measurement in flight would announce the finding
   * before it was made.
   */
  matches: number | null
  /**
   * Whether the selection can still be pulled outwards, and inwards.
   *
   * Carried rather than left for the surface to guess, because the core is the only side that holds the
   * ancestor chain — and because a control that silently does nothing at the end of the chain is the
   * defect this feature is being rebuilt to remove, reproduced in miniature. `canWiden` is false once the
   * selection has reached the outermost element the chain allows, which stops below `body`: a step past
   * that selects the document itself, and a rule for it empties the page.
   */
  canWiden: boolean
  canNarrow: boolean
  /**
   * What became of the attempt, as a key, or `null` while it is still going on.
   *
   * A key rather than a sentence: the sentence is looked up in `text` below, under `outcome.${outcome}`.
   * A key rather than an enum declared here, too, and that is deliberate — the set of outcomes belongs to
   * the picking session, which is where they are produced and where they are held to being exhaustive.
   * Two lists of the same eight names in two modules is how a ninth outcome comes to render as nothing at
   * all; the surface renders the key itself if it does not recognise it, which is a name on screen
   * instead of an empty bar.
   */
  outcome: string | null
  /**
   * Whether there is a written rule to take back.
   *
   * The one thing about an outcome the bar cannot work out from an opaque key, and the difference
   * matters: "already there, disabled" and "saved but it changes nothing here" both name a rule that
   * exists, while "no host" and "limit reached" name one that was never written. Offering Undo for the
   * second pair would be a button that removes something the user never added.
   */
  canUndo: boolean
  /**
   * Every word the bar can say, already in the language the interface is in.
   *
   * The core's, like every other field here: the prose lives in `main/privacy/picker-bar-text.ts` rather
   * than in the renderer's catalogue, and that module says why — the catalogue is one measured chunk that
   * every renderer parses, and only this surface ever shows these sentences. The whole table travels,
   * not just the sentence the current mode needs, so the surface still chooses which one a mode says and
   * still resolves an outcome by its key.
   *
   * A record of strings rather than a type naming each key, on the precedent of `userrules:list`: a word
   * missing from it renders as its own key, which is a name on screen rather than an unlabelled button.
   * `{index}` and `{count}` arrive as placeholders and are filled in by the surface.
   */
  text: Readonly<Record<string, string>>
}

/**
 * Tall enough for the selector, the match count and a row of controls.
 *
 * Two rows rather than the find bar's one, because this bar has to *say* things: a selector long enough
 * to recognise, a measured count, and — in `outcome` — a sentence naming what became of the attempt.
 */
export const PICKER_BAR_HEIGHT = 96

/** Wide enough for a selector and six controls, without covering a third of the page. */
export const PICKER_BAR_WIDTH = 420

/** The gap between the bar and the tile's edges. The find bar's, so the two read as one family. */
export const PICKER_BAR_INSET = 8

/**
 * The bar's rectangle inside the tile being picked in.
 *
 * ## Why the tile and not the window
 *
 * The layer swallows every pointer event inside its own bounds, so whatever this rectangle covers is
 * taken out of the page underneath for as long as the bar is up. Sized to the window, a bar raised over
 * one tile of a `2x2` split would make three other live pages unclickable — and it would not even say
 * which of the four it was picking in. The find bar answered the same question the same way; this is
 * that rule applied to a surface that has more to show.
 *
 * ## Why the top-right corner
 *
 * The element being picked is under the pointer, and the pointer is wherever the user put it. A bar
 * pinned to a corner is the one placement that never lands on the thing being chosen, and the top-right
 * corner is the find bar's, which keeps a person from having to learn two conventions for two surfaces
 * that behave alike. The two can never be on the layer together, so the shared corner costs nothing.
 *
 * Both dimensions are clamped to the *inset* tile rather than to the whole one: clamped to the full
 * width, a narrow tile would put the bar's left edge over its neighbour. A tile too small to hold
 * anything yields a zero-sized rectangle, which the core refuses rather than presenting an invisible
 * surface that holds the layer against everything else.
 */
export function pickerBarBounds(tileRect: Rect): Rect {
  const available = {
    width: Math.max(0, tileRect.width - PICKER_BAR_INSET * 2),
    height: Math.max(0, tileRect.height - PICKER_BAR_INSET * 2)
  }
  const width = Math.min(PICKER_BAR_WIDTH, available.width)
  const height = Math.min(PICKER_BAR_HEIGHT, available.height)
  return {
    // Right-aligned, so the bar grows away from the page's text column rather than across it.
    x: tileRect.x + tileRect.width - width - PICKER_BAR_INSET,
    y: tileRect.y + PICKER_BAR_INSET,
    width,
    height
  }
}
