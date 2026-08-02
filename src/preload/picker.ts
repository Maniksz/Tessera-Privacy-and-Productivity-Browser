import { ipcRenderer } from 'electron'
import {
  PICKER_COMMIT_CHANNEL,
  PICKER_PROPOSE_CHANNEL,
  PICKER_START_CHANNEL,
  PICKER_STOP_CHANNEL,
  asPickerChrome,
  asSelectorProposal,
  describeElement,
  type PickerChrome
} from '@shared/filters/picker-wire.js'
import type { SelectorProposal } from '@shared/filters/picker.js'
import { inPageCoordinates } from '@shared/zoom/injection.js'
import { pageZoomPercent } from './page-zoom.js'

/**
 * "Block this element", inside the page.
 *
 * ## Why it is here and not on the overlay layer
 *
 * Everything else in this browser that has to appear over a page is drawn on a transparent topmost view,
 * because the page is a native view and the chrome UI's DOM sits beneath it. A picker cannot work that
 * way: highlighting an element means knowing where that element *is*, and the overlay cannot see into the
 * page's DOM. So the picker is built by this preload, in the page, which is also the only place a
 * `mouseover` on a page element can be observed.
 *
 * ## Why a page cannot use it
 *
 * Nothing here is exposed on `window`. The mode is entered by a message from the core, sent to one view
 * because the user chose it in the browser's own interface, and the core independently refuses to answer
 * a view it did not start. So a page can neither turn this on nor ask what a selector would match nor
 * write a rule — see `ElementPicker`.
 *
 * ## Why a shadow root
 *
 * The highlight and the confirmation bar are elements in the page's document, so the page's own CSS would
 * otherwise style them: a site with `* { box-sizing: border-box }` and a `div { position: static
 * !important }` could move or hide the picker. A closed shadow root also keeps the page's scripts from
 * reading the selector being proposed, which would tell a site exactly which of its elements a user is
 * trying to remove.
 */

const HOST_ELEMENT_ID = 'tessera-picker'

interface PickerUi {
  readonly box: HTMLElement
  readonly bar: HTMLElement
  readonly selectorText: HTMLElement
  readonly noteText: HTMLElement
  destroy(): void
}

/**
 * The document as it actually is, rather than as the DOM types describe it.
 *
 * `lib.dom` declares `body` and `documentElement` non-nullable. A preload runs before the parser has
 * produced `<body>`, so the type is wrong for this timing — and the linter's suggestion to drop the
 * checks because "they cannot be null" would crash the preload and take the page with it.
 */
// `Omit` and not an intersection: `HTMLElement & (HTMLElement | null)` is still `HTMLElement`, so an
// intersection narrows where this has to widen. The original field has to be removed to be replaced.
const earlyDocument = document as Omit<Document, 'body' | 'documentElement'> & {
  body: HTMLElement | null
  documentElement: HTMLElement | null
}

function buildUi(chrome: PickerChrome): PickerUi | null {
  const parent = earlyDocument.body ?? earlyDocument.documentElement
  if (parent === null) return null

  const host = document.createElement('div')
  host.id = HOST_ELEMENT_ID
  // `closed`, so the page's scripts cannot read what is being proposed — which would tell a site exactly
  // which of its elements the user is about to remove.
  const root = host.attachShadow({ mode: 'closed' })

  const style = document.createElement('style')
  style.textContent = chrome.styles
  const box = document.createElement('div')
  box.className = 'box'
  const bar = document.createElement('div')
  bar.className = 'bar'
  const selectorText = document.createElement('span')
  selectorText.className = 'selector'
  const noteText = document.createElement('span')
  noteText.className = 'hint'
  bar.append(selectorText, noteText)
  root.append(style, box, bar)
  parent.appendChild(host)

  return {
    box,
    bar,
    selectorText,
    noteText,
    destroy: () => host.remove()
  }
}

/** The one bit of state the mode needs: what is installed, so stopping can undo exactly that. */
let session: { ui: PickerUi; teardown: () => void } | null = null

function describe(target: Element): SelectorProposal | null {
  let answer: unknown
  try {
    // Synchronous, because this runs on every `mouseover` and an awaited answer would make the highlight
    // lag behind the pointer by a frame or more — which reads as the picker being broken.
    // An `Element` satisfies `PickerElement` structurally — that shape exists so the transcription can
    // be tested without a DOM — so this is a widening to a smaller interface, not an assertion.
    answer = ipcRenderer.sendSync(PICKER_PROPOSE_CHANNEL, describeElement(target))
  } catch {
    return null
  }
  return asSelectorProposal(answer)
}

/**
 * What to say about a proposal, in the user's language.
 *
 * The order is the order of consequence, not the order the warnings arrive in: hiding an ancestor takes the
 * surrounding region with it, which is the one outcome somebody would not undo by clicking again. Only the
 * first is shown — a bar listing four caveats is a bar nobody reads.
 */
function warningText(
  chrome: PickerChrome,
  proposal: SelectorProposal
): { text: string; warn: boolean } {
  const byConsequence = ['matches-ancestor', 'matches-many', 'positional', 'no-stable-feature']
  const [worst] = byConsequence.filter((warning) =>
    (proposal.warnings as readonly string[]).includes(warning)
  )
  if (worst === undefined) return { text: chrome.hint, warn: false }
  const worded = chrome.warnings[worst]
  return {
    // A warning the core added and did not word must still say *something*: silence would read as safe.
    text: worded ?? worst,
    warn: true
  }
}

function start(chrome: PickerChrome): void {
  if (session !== null) return
  const ui = buildUi(chrome)
  if (ui === null) return

  let proposal: SelectorProposal | null = null

  const show = (target: Element): void => {
    const rect = target.getBoundingClientRect()
    /*
      Translated out of client coordinates, because the highlight lives inside the page it highlights.

      A zoomed pane is zoomed by a stylesheet on `:root` now — `shared/zoom/injection.ts` says why —
      so every length written into this box is multiplied on the way to the screen, while the
      rectangle it came from already includes that multiplication. Written back unchanged, the
      highlight drifts further from its element the more the user has zoomed, which reads as the
      picker being broken. `inPageCoordinates` is the one place that arithmetic is explained.
    */
    const zoom = pageZoomPercent()
    const inPage = (value: number): string => String(inPageCoordinates(value, zoom))
    ui.box.style.left = `${inPage(rect.left)}px`
    ui.box.style.top = `${inPage(rect.top)}px`
    ui.box.style.width = `${inPage(rect.width)}px`
    ui.box.style.height = `${inPage(rect.height)}px`

    proposal = describe(target)
    if (proposal === null) {
      ui.selectorText.textContent = ''
      ui.noteText.textContent = chrome.noRule
      ui.noteText.className = 'hint warn'
      return
    }
    ui.selectorText.textContent = proposal.selector
    const note = warningText(chrome, proposal)
    ui.noteText.textContent = note.text
    ui.noteText.className = note.warn ? 'hint warn' : 'hint'
  }

  const onMove = (event: MouseEvent): void => {
    const target = event.target
    // The picker's own host is in the page, so it can be hovered. Skipping it keeps the highlight on the
    // page rather than on the confirmation bar the user is reading.
    if (!(target instanceof Element) || target.id === HOST_ELEMENT_ID) return
    show(target)
  }

  /*
    Everything a press consists of, taken away from the page — not just the `click`.

    Cancelling `click` was the whole of this, and it was reported as not working: *"wenn ich ein
    element blockieren will, dann wird das element dennoch angeklickt"*. It is not that the refusal
    failed; it is that `click` is the *last* event of a press and most of the web does not wait for
    it. A menu opens on `mousedown`, a carousel starts dragging on `pointerdown`, a field takes focus
    on `mousedown`, and a framework's own handler frequently sits on `pointerdown` because that is
    where the latency is. All of those had already happened by the time the picker said no.

    So the whole sequence is swallowed while the picker is up, and the two halves are treated
    differently on purpose:

      - **Propagation is stopped for all of them**, pointer events included. That is what keeps the
        page's own handlers from running, and it is the half that fixes the report.
      - **Default is prevented only for the mouse events.** Cancelling `pointerdown` would suppress
        the compatibility mouse events that follow it, which is a second mechanism doing the first
        one's job and one more thing to reason about. Preventing `mousedown` is what stops focus,
        text selection and the start of a drag; preventing `click` is what stops a link.

    `stopImmediatePropagation` as well as `stopPropagation`, because a page can add its own listener
    on `window` in the capture phase. It cannot get in front of this one — the preload runs before any
    page script — but it would otherwise still run *beside* it.

    `click` is still what commits, and it still arrives: neither cancelling `mousedown` nor cancelling
    `pointerdown` suppresses it.
  */
  const swallow = (event: Event): void => {
    if (event.cancelable && !event.type.startsWith('pointer')) event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  const onClick = (event: MouseEvent): void => {
    // Captured and cancelled: the click must not also reach the page, or picking an element inside a link
    // would navigate away from the page the user was editing.
    event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
    if (proposal !== null) {
      try {
        ipcRenderer.send(PICKER_COMMIT_CHANNEL, proposal.selector)
      } catch {
        // Nothing to do here; the core is the only thing that can store a rule.
      }
    }
    stop()
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    stop()
  }

  // Capture phase throughout, so a page that stops propagation on its own handlers cannot take the
  // picker's events away from it.
  const options = { capture: true } as const

  /**
   * The press, in the order Chromium dispatches it, minus the `click` that commits.
   *
   * `mouseover` is deliberately absent: it is what the highlight follows, and the page seeing a hover
   * costs nothing. `contextmenu` is here because a right-click while picking should not leave the
   * site's own menu on screen over the picker — the browser's own menu is a different mechanism and
   * comes from the core, which is where picker mode is already accounted for.
   */
  const SWALLOWED = [
    'pointerdown',
    'mousedown',
    'pointerup',
    'mouseup',
    'auxclick',
    'dblclick',
    'contextmenu'
  ] as const

  for (const type of SWALLOWED) window.addEventListener(type, swallow, options)
  window.addEventListener('mouseover', onMove, options)
  window.addEventListener('click', onClick, options)
  window.addEventListener('keydown', onKeyDown, options)

  session = {
    ui,
    teardown: () => {
      for (const type of SWALLOWED) window.removeEventListener(type, swallow, options)
      window.removeEventListener('mouseover', onMove, options)
      window.removeEventListener('click', onClick, options)
      window.removeEventListener('keydown', onKeyDown, options)
    }
  }
}

/**
 * Leaves picker mode, removing everything `start` installed.
 *
 * Every listener paired with its removal, and the host element removed with them. A picker that left one
 * `click` handler behind would swallow the next click the user made on the page, with nothing on screen
 * to explain why.
 */
function stop(): void {
  if (session === null) return
  session.teardown()
  session.ui.destroy()
  session = null
}

/** Installs the listeners that let the *core* start and stop the mode. Nothing is exposed to the page. */
export function installElementPicker(): void {
  try {
    ipcRenderer.on(PICKER_START_CHANNEL, (_event, payload: unknown) => {
      const chrome = asPickerChrome(payload)
      // No chrome, no picker. A build mismatch must leave the page alone rather than draw an unstyled,
      // wordless bar the user cannot interpret.
      if (chrome !== null) start(chrome)
    })
    ipcRenderer.on(PICKER_STOP_CHANNEL, () => {
      stop()
    })
  } catch (error) {
    console.warn('[picker] could not be installed:', error)
  }
}
