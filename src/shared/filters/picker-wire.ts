import type {
  ElementAttribute,
  ElementDescription,
  ElementNode,
  SelectorProposal
} from './picker.js'
import type { PickerCandidate } from './picker-session.js'

/**
 * The element picker, across the process boundary.
 *
 * ## The privilege model, which decides the whole shape
 *
 * A visited page has no IPC bridge at all (spec 6) — only its preload can reach `ipcRenderer`. So the
 * picker's user interface is built by the preload, inside the page, and every message here is spoken by
 * the preload. Nothing is exposed on `window`, which means a page cannot enter picker mode, cannot ask
 * what a selector would match, and cannot write a rule.
 *
 * Entering is therefore a message *from* the core, sent to one view because the user chose that tab. A
 * page that receives it did not ask for it and cannot cause it.
 *
 * ## Why the transcription is here and not in the preload
 *
 * `proposeSelector` in `picker.ts` works on plain data — that is what makes the interesting half of the
 * picker testable without a browser. Turning a DOM element into that data has decisions in it (which
 * attributes to carry, how deep to walk, what `:nth-child` position means) and each of them can be
 * quietly wrong, so it lives here where a test can reach it rather than in the preload where it cannot.
 *
 * ## Why every message names the attempt it belongs to
 *
 * A picking session is a conversation with two slow steps in it — a rule goes to the store, and the
 * page is then asked to measure what became of it — and the ways it ends are mostly not clicks: a
 * navigation, a closed tab, a consent dialogue taking the layer. So an answer can arrive for an
 * attempt that is over, in a view where a *second* attempt has since started, and resolved against
 * "whatever this view is doing now" it would confirm a selection nobody chose or report a
 * measurement of the wrong document. Every message below therefore carries the `sessionId` the core
 * minted at the start, and the core discards anything that names a different one. This is the same
 * correlation `picker:barAction` carries for the bar; the page needs it for the same reason.
 *
 * Zod-free and dependency-free: the preload imports it. `PickerCandidate` is imported as a *type*
 * only, so the session module's runtime — and the rule model behind it — stays out of the preload
 * bundle while both halves still describe a chain with one declaration.
 */

/** Core -> preload: "the user asked for the picker in this tab", with everything it needs to draw. */
export const PICKER_START_CHANNEL = 'tessera:picker-start'

/**
 * The picker's own appearance, supplied by the core when the mode starts.
 *
 * One field, and it used to be four. The other three were sentences — a hint, a "no rule for this
 * element", a table wording each selector warning — because the picker drew a bar inside the page and
 * the preload cannot read the i18n catalogue: importing it would put every translation into a bundle
 * that is parsed before every page in every tab. The bar is an overlay surface now, so the words are
 * read there, in the renderer's own language, and sending them into the document would be shipping a
 * second copy of them to a place nothing reads them from.
 *
 * The stylesheet stays, and for the same reason the words left: the highlight *is* in the page, and
 * `src/main/privacy/picker-chrome.ts` says why its colours are literals rather than custom properties.
 */
export interface PickerChrome {
  /** The highlight's stylesheet, scoped inside a shadow root. */
  readonly styles: string
}

/**
 * What starts one attempt: which attempt it is, and what it looks like.
 *
 * The identity travels *on* the chrome rather than beside it. It was a compatibility decision with a
 * short life — for one step of the plan a preload built before the rebuild ran against a core built
 * after it, and a `{ sessionId, chrome }` envelope would have made that preload refuse to start at
 * all. That step is over; the shape is kept because there is now nothing in a start that is not one
 * of these two things, and an envelope around a single field would be ceremony.
 */
export interface PickerStart extends PickerChrome {
  /** The core's name for this attempt. Echoed by every message the page sends back. */
  readonly sessionId: string
}

/**
 * Total, because a build mismatch must leave the page alone rather than draw something into it.
 *
 * Without a stylesheet the highlight is an unstyled `<div>` over somebody's document; without a
 * session there is nothing to answer for, so nothing could take it off again.
 */
export function asPickerStart(value: unknown): PickerStart | null {
  const named = namedSession(value)
  if (named === null || typeof named['styles'] !== 'string') return null
  return value as PickerStart
}

/** Core -> preload: "stop", for a tab that navigated or a user who changed their mind elsewhere. */
export const PICKER_STOP_CHANNEL = 'tessera:picker-stop'

/** Preload -> core, and answered: "what would hide this?" */
export const PICKER_PROPOSE_CHANNEL = 'tessera:picker-propose'

/**
 * Preload -> core: the click. The selection is frozen on what this message carries.
 *
 * ## Why the page sends a chain rather than an element
 *
 * Widening and narrowing walk the ancestors of the clicked element, and neither the core nor the
 * session module has a DOM to walk. So the page hands over every rung the user may reach — each one
 * already proposed through the synchronous channel above and already *counted in the open document*
 * — and a correction afterwards is a move along an index rather than another round trip. See
 * `picker-session.ts` for what that buys: an instant correction, a chain that cannot drift under the
 * person reading it, and the upper bound of KTD11 applied once.
 *
 * ## Why a selector coming from the page is not a new privilege
 *
 * It is the same one the commit message carried before, and it is bounded by the two gates that were
 * always there rather than by trust in the sender. The text is built here as `host##selector` for the
 * host the *core* read off the view, and it then passes `describeUserRule` on its way into the store
 * and `viewStylesheet` on its way into the page — both of which refuse a network rule, a scriptlet
 * and an exception. The worst a compromised renderer achieves is hiding something on its own site.
 */
export const PICKER_FREEZE_CHANNEL = 'tessera:picker-freeze'

export interface PickerFreezeReport {
  readonly sessionId: string
  /** The clicked element first, then outwards. Cut at `body` by `pickableChain` on arrival. */
  readonly chain: readonly PickerCandidate[]
}

export function asPickerFreezeReport(value: unknown): PickerFreezeReport | null {
  const named = namedSession(value)
  if (named === null) return null
  const reported = named['chain']
  if (!Array.isArray(reported) || reported.length === 0) return null
  if (reported.length > MAX_PICKER_CHAIN) return null
  const chain: PickerCandidate[] = []
  for (const rung of reported) {
    const candidate = asPickerCandidate(rung)
    // One unreadable rung invalidates the whole click rather than being skipped: the rungs are
    // *positions*, and a chain with a hole in it would answer "wider" with the wrong ancestor.
    if (candidate === null) return null
    chain.push(candidate)
  }
  return { sessionId: named['sessionId'] as string, chain }
}

/** One rung, as the page reports it. */
export function asPickerCandidate(value: unknown): PickerCandidate | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate['tag'] !== 'string' || candidate['tag'] === '') return null
  if (!countLike(candidate['matches'])) return null
  if (asSelectorProposal(candidate['proposal']) === null) return null
  return value as PickerCandidate
}

/**
 * Core -> preload: "the chosen rung is now this one", so the highlight follows a correction.
 *
 * An index rather than a selector or a description, because the page is the side that built the
 * chain and still holds it. Sending the selector back would invite the page to re-resolve it against
 * a document that may have changed, and the two sides would then disagree about which element the
 * bar is describing.
 */
export const PICKER_SELECT_CHANNEL = 'tessera:picker-select'

export interface PickerSelectRequest {
  readonly sessionId: string
  /** Index into the chain this session was frozen with; 0 is the clicked element. */
  readonly index: number
}

export function asPickerSelectRequest(value: unknown): PickerSelectRequest | null {
  const named = namedSession(value)
  if (named === null || !countLike(named['index'])) return null
  return value as PickerSelectRequest
}

/**
 * Core -> preload: "count this selector, and say how much of it is still drawn."
 *
 * Sent once the preview has been lifted and the stored rule delivered (R13), which is the whole
 * reason the question is asked at this moment and not another: asked earlier it would measure the
 * preview, and the answer would say the rule works whatever the rule does.
 */
export const PICKER_MEASURE_CHANNEL = 'tessera:picker-measure'

export interface PickerMeasureRequest {
  readonly sessionId: string
  /** A plain CSS selector — the core never sends rule text into a page. */
  readonly selector: string
}

export function asPickerMeasureRequest(value: unknown): PickerMeasureRequest | null {
  const named = namedSession(value)
  if (named === null) return null
  if (typeof named['selector'] !== 'string' || named['selector'] === '') return null
  return value as PickerMeasureRequest
}

/**
 * Preload -> core: what the document actually shows.
 *
 * Two numbers and no verdict. "It worked" is a decision, and decisions belong to the session module
 * (KTD8): a hidden element still matches its selector, so a count alone proves nothing, and nothing
 * matching is not success either — it means the element left the document, which the rule may have
 * had nothing to do with.
 */
export const PICKER_MEASURED_CHANNEL = 'tessera:picker-measured'

export interface PickerMeasurement {
  readonly sessionId: string
  /** How many elements the selector matched. */
  readonly matches: number
  /** How many of those are still being drawn. */
  readonly visible: number
}

export function asPickerMeasurement(value: unknown): PickerMeasurement | null {
  const named = namedSession(value)
  if (named === null) return null
  if (!countLike(named['matches']) || !countLike(named['visible'])) return null
  return value as PickerMeasurement
}

/**
 * Preload -> core: Escape, in the page.
 *
 * The message that did not exist, and its absence is half of the state divergence this plan repairs:
 * Escape tore the page's own picker down and told the core nothing, so the core went on believing the
 * view was picking and the next start found a session already running. The bar holds the keyboard
 * while it is up, so this arrives only when the page had the focus after all — which is exactly the
 * case nobody would think to test, and therefore the case worth having a channel for.
 */
export const PICKER_ESCAPED_CHANNEL = 'tessera:picker-escaped'

export interface PickerEscape {
  readonly sessionId: string
}

export function asPickerEscape(value: unknown): PickerEscape | null {
  return namedSession(value) === null ? null : (value as PickerEscape)
}

/** The half of every guard above that is the same: an object naming a session. */
function namedSession(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate['sessionId'] !== 'string' || candidate['sessionId'] === '') return null
  return candidate
}

/**
 * A count, as a renderer may send one.
 *
 * `Number.isInteger` rather than `typeof === 'number'`, because `NaN`, `Infinity` and `1.5` are all
 * numbers and none of them is a number of elements. Negative is refused for the same reason: it
 * would reach the bar as a match count and the presentation has nothing sensible to do with it.
 */
function countLike(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

/**
 * How far up the tree a description reaches.
 *
 * `proposeSelector` looks for an ancestor with a usable name of its own to scope a weak selector under.
 * Eight levels is past every real page's advert container — a slot is two or three elements below a
 * region that has a name — and the bound matters because the description crosses a process boundary
 * with every hover.
 */
export const MAX_ANCESTOR_DEPTH = 8

/**
 * How many rungs a frozen chain may have: the clicked element plus the ancestors a description reaches.
 *
 * A bound rather than a trust, and the cost of not having one is concrete: every rung is presented,
 * previewed and measured, so a renderer sending ten thousand of them would be a bar with a scrollbar
 * on it and a great deal of work in the core for a gesture that produced eight.
 */
export const MAX_PICKER_CHAIN = MAX_ANCESTOR_DEPTH + 1

/**
 * The tags the walkable chain stops below: KTD11's hard upper bound.
 *
 * Here rather than beside the transition it governs, because **both** sides apply it and for
 * different reasons. The page cuts before it builds a rung, so an ancestor that would be dropped on
 * arrival is never proposed and never counted — a round trip and a `querySelectorAll` saved on every
 * click, and the outermost rung the bar offers is then the outermost one that exists. The core cuts
 * again in `pickableChain`, because a chain from a renderer is not a chain to be trusted.
 *
 * Two enforcement points, one declaration. Written twice, the copy that drifted would be the one
 * offering `html##html` — a selector that empties the page, on a page the user then has to look at
 * to decide whether to keep it.
 */
export const PICKER_CHAIN_LIMIT_TAGS = ['body', 'html'] as const

/**
 * How many of an element's attributes are carried.
 *
 * `identifiers.ts` refuses most of them anyway; this is about the size of the message rather than about
 * which are usable. A framework-generated element can carry dozens of `data-` attributes holding
 * serialised state, and none of those is a selector anybody wants.
 */
export const MAX_ATTRIBUTES = 12

/** The smallest element shape the transcription needs. Satisfied by a real `Element`. */
export interface PickerElement {
  readonly tagName: string
  readonly id: string
  readonly classList: Iterable<string>
  readonly attributes: Iterable<{ readonly name: string; readonly value: string }>
  readonly parentElement: PickerElement | null
  /** The parent's element children, in document order. Used only for the positional index. */
  readonly children?: Iterable<PickerElement> | undefined
}

function attributesOf(element: PickerElement): readonly ElementAttribute[] {
  const carried: ElementAttribute[] = []
  for (const attribute of element.attributes) {
    if (carried.length >= MAX_ATTRIBUTES) break
    // `class` and `id` are carried in their own fields; repeating them here would let a selector be
    // written as `[id="x"]` when `#x` says the same thing more briefly and more robustly.
    if (attribute.name === 'class' || attribute.name === 'id') continue
    carried.push({ name: attribute.name, value: attribute.value })
  }
  return carried
}

/**
 * Which position this element holds among its parent's element children, 1-based.
 *
 * `0` for the document element and for an element whose parent cannot be read — and `0` is what
 * `SelectorStep` uses to mean "does not constrain position", so an unknown index degrades into a
 * selector that is less specific rather than one that is wrong.
 */
function childIndexOf(element: PickerElement): number {
  const children = element.parentElement?.children
  if (children === undefined) return 0
  let index = 0
  for (const child of children) {
    index += 1
    if (child === element) return index
  }
  return 0
}

function nodeOf(element: PickerElement): ElementNode {
  return {
    tag: element.tagName.toLowerCase(),
    id: element.id === '' ? null : element.id,
    classes: [...element.classList].filter((name) => name !== ''),
    attributes: attributesOf(element),
    childIndex: childIndexOf(element)
  }
}

/**
 * Transcribes an element and its ancestors into the plain data `proposeSelector` works on.
 *
 * Nearest ancestor first, up to `MAX_ANCESTOR_DEPTH`. The walk stops at a missing parent rather than
 * assuming a document element exists, because an element detached from the tree between the hover and
 * the transcription is an ordinary thing on a page that re-renders.
 */
export function describeElement(element: PickerElement): ElementDescription {
  const ancestors: ElementNode[] = []
  let current = element.parentElement
  while (current !== null && ancestors.length < MAX_ANCESTOR_DEPTH) {
    ancestors.push(nodeOf(current))
    current = current.parentElement
  }
  return { ...nodeOf(element), ancestors }
}

/** What the core sends back for a hover. Total, because an old build may answer anything. */
export function asSelectorProposal(value: unknown): SelectorProposal | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate['selector'] !== 'string' || candidate['selector'] === '') return null
  if (typeof candidate['estimatedMatches'] !== 'number') return null
  return value as SelectorProposal
}

/** What the core receives. Total in the other direction: a renderer can send anything. */
export function asElementDescription(value: unknown): ElementDescription | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate['tag'] !== 'string' || candidate['tag'] === '') return null
  if (!Array.isArray(candidate['ancestors'])) return null
  return value as ElementDescription
}
