import type { ElementAttribute, ElementDescription, ElementNode, SelectorProposal } from './picker.js'

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
 * Zod-free and dependency-free: the preload imports it.
 */

/** Core -> preload: "the user asked for the picker in this tab", with everything it needs to draw. */
export const PICKER_START_CHANNEL = 'tessera:picker-start'

/**
 * The picker's own appearance and wording, supplied by the core when the mode starts.
 *
 * Two reasons, and the first is a rule this project holds everywhere else: no user-visible string may be
 * written into the code. The preload cannot read the i18n catalogue — importing it would put every
 * translation into a bundle that runs before every page — so the words have to arrive with the request.
 *
 * The second is that budget. The preload is the tightest one here because it is parsed before every page
 * in every tab, and a stylesheet plus eight sentences is a real fraction of it for a feature most pages
 * never use.
 */
export interface PickerChrome {
  /** The picker's stylesheet, scoped inside a shadow root. */
  readonly styles: string
  /** Shown when the proposed selector is safe to use. */
  readonly hint: string
  /** Keyed by `SelectorWarning`, so a warning the core adds later cannot go unworded. */
  readonly warnings: Readonly<Record<string, string>>
  /** Shown when no rule could be proposed for the element under the pointer. */
  readonly noRule: string
}

/** Total, because a build mismatch must leave a usable picker rather than an unstyled, wordless one. */
export function asPickerChrome(value: unknown): PickerChrome | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Record<string, unknown>
  if (typeof candidate['styles'] !== 'string') return null
  if (typeof candidate['hint'] !== 'string') return null
  if (typeof candidate['noRule'] !== 'string') return null
  const warnings = candidate['warnings']
  if (typeof warnings !== 'object' || warnings === null) return null
  return value as PickerChrome
}

/** Core -> preload: "stop", for a tab that navigated or a user who changed their mind elsewhere. */
export const PICKER_STOP_CHANNEL = 'tessera:picker-stop'

/** Preload -> core, and answered: "what would hide this?" */
export const PICKER_PROPOSE_CHANNEL = 'tessera:picker-propose'

/** Preload -> core: "store that rule." */
export const PICKER_COMMIT_CHANNEL = 'tessera:picker-commit'

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
