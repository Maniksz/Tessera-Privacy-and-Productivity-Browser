import { ipcRenderer } from 'electron'
import {
  MAX_PICKER_CHAIN,
  PICKER_CHAIN_LIMIT_TAGS,
  PICKER_ESCAPED_CHANNEL,
  PICKER_FREEZE_CHANNEL,
  PICKER_MEASURED_CHANNEL,
  PICKER_MEASURE_CHANNEL,
  PICKER_PROPOSE_CHANNEL,
  PICKER_SELECT_CHANNEL,
  PICKER_START_CHANNEL,
  PICKER_STOP_CHANNEL,
  asPickerMeasureRequest,
  asPickerSelectRequest,
  asPickerStart,
  asSelectorProposal,
  describeElement
} from '@shared/filters/picker-wire.js'
import type { PickerStart } from '@shared/filters/picker-wire.js'
import type { PickerCandidate } from '@shared/filters/picker-session.js'
import type { SelectorProposal } from '@shared/filters/picker.js'

/**
 * "Block this element", inside the page.
 *
 * ## What is here, and what used to be
 *
 * Three things, and they are the three that cannot be done anywhere else: the highlight, which needs
 * the page's geometry; the swallowing of the pointer sequence, whose listeners must be registered
 * before any page script; and the measurement, because the document is here (KTD12, KTD8).
 *
 * The confirmation bar is *not* here any more. It is an overlay surface now
 * (`renderer/overlay/PickerBarSurface.tsx`), which is where the words, the buttons and the keyboard
 * contract went with it — this file draws one rectangle and holds no text at all. The click does not
 * write a rule either: it freezes a selection and hands the core a walkable ancestor chain, and a
 * separate confirmation on the bar is what commits (R7).
 *
 * ## Why a page cannot use it
 *
 * Nothing here is exposed on `window`. The mode is entered by a message from the core, sent to one
 * view because the user chose it in the browser's own interface, and the core independently refuses
 * to answer a view it did not start. So a page can neither turn this on nor ask what a selector
 * would match nor write a rule — see `ElementPicker`.
 *
 * ## Why a shadow root, and why on the document element
 *
 * The highlight is an element in the page's document, so the page's own CSS would otherwise style
 * it: a site with `div { position: static !important }` could move or hide it. A closed shadow root
 * also keeps the page's scripts from reading the selector being proposed, which would tell a site
 * exactly which of its elements a user is trying to remove.
 *
 * The host hangs off `documentElement` rather than off `body`, and that is a positioning decision
 * rather than a tidiness one: a `transform` on any ancestor makes it the containing block for
 * `position: fixed` descendants, so a host inside a transformed `<body>` — which is how a great many
 * page transitions and drawer animations are built — would draw the highlight at an offset from the
 * element it is meant to be around.
 */

const HOST_ELEMENT_ID = 'tessera-picker'

const CHAIN_LIMIT = new Set<string>(PICKER_CHAIN_LIMIT_TAGS)

/**
 * The document as it actually is, rather than as the DOM types describe it.
 *
 * `lib.dom` declares `documentElement` non-nullable. A preload runs before the parser has produced
 * it, so the type is wrong for this timing — and the linter's suggestion to drop the check because
 * "it cannot be null" would crash the preload and take the page with it.
 */
// `Omit` and not an intersection: `HTMLElement & (HTMLElement | null)` is still `HTMLElement`, so an
// intersection narrows where this has to widen. The original field has to be removed to be replaced.
const earlyDocument = document as Omit<Document, 'documentElement'> & {
  documentElement: HTMLElement | null
}

/** What one attempt installed, so stopping can undo exactly that. */
interface PickerRun {
  /** The core's name for this attempt. Every message back echoes it, and stale ones are refused. */
  readonly sessionId: string
  readonly box: HTMLElement
  /**
   * The frozen chain as *elements*, index-aligned with the rungs the core was sent; null while the
   * highlight is still following the pointer.
   *
   * The elements are held rather than re-resolved, because the core answers a correction with an
   * index and nothing else. Re-running the selector to find the rung again would resolve it against
   * a document that may have re-rendered since the click, and the bar and the highlight would then
   * be describing two different elements.
   */
  chain: readonly Element[] | null
  readonly teardown: () => void
}

let session: PickerRun | null = null

/**
 * What would hide this element, asked of the core.
 *
 * Synchronous, because this runs on every `mouseover` and an awaited answer would make the highlight
 * lag behind the pointer by a frame or more — which reads as the picker being broken. The answer is
 * also what the bar names: the core updates it as a side effect of answering, so the hover has one
 * round trip rather than two.
 */
function describe(target: Element): SelectorProposal | null {
  let answer: unknown
  try {
    // An `Element` satisfies `PickerElement` structurally — that shape exists so the transcription
    // can be tested without a DOM — so this is a widening to a smaller interface, not an assertion.
    answer = ipcRenderer.sendSync(PICKER_PROPOSE_CHANNEL, describeElement(target))
  } catch {
    return null
  }
  return asSelectorProposal(answer)
}

/**
 * Whether an element the selector matched is still being drawn.
 *
 * Asked of the computed style *and* of the box, because the two answer different questions. A
 * cosmetic rule writes `display: none !important`, so reading `display` reads the rule's own effect
 * rather than inferring it, and `visibility: hidden` is the other thing a hand-written rule does —
 * an element hidden that way keeps its box, so geometry alone would call it visible. The box is what
 * catches everything neither of those says: an ancestor hidden instead of the element, a node
 * detached from the tree between the write and the question, and a slot collapsed to nothing.
 *
 * Nothing here is a verdict. Two counts go back and the session module decides what they mean
 * (KTD8) — "it worked" is a decision, and a hidden element still matches its selector.
 */
function drawn(element: Element): boolean {
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden') return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 || rect.height > 0
}

/**
 * What a selector does to this document: how much it matches, and how much of that is still on
 * screen (R9).
 *
 * Measured here rather than estimated in the core, because the core has no DOM and the estimate it
 * can make is taken against the one element it was told about. A person deciding whether to hide
 * three things or three hundred needs the document's own answer.
 *
 * A selector the document's engine refuses is zero and zero rather than a throw. The core sends only
 * plain CSS, so this is totality rather than distrust — but an exception escaping a listener in a
 * preload is an exception in the page's own script context, and the picker is not worth that.
 */
function matched(selector: string): Element[] {
  try {
    // The picker's own host is an element in this document, so a broad selector matches it. Counted,
    // it would report the picker's presence as the rule's effect — and the host is always drawn, so
    // it would be the one match that makes every rule look ineffective.
    return [...document.querySelectorAll(selector)].filter(
      (element) => element.id !== HOST_ELEMENT_ID
    )
  } catch {
    return []
  }
}

function measure(selector: string): { matches: number; visible: number } {
  const found = matched(selector)
  return { matches: found.length, visible: found.filter(drawn).length }
}

/**
 * The clicked element and the ancestors above it, each already proposed and already counted.
 *
 * Built in one go at the click, which is what makes a later correction instant: the core answers
 * "wider" with an index into this, so no round trip stands between a keypress and the highlight
 * moving, and a page that re-renders between two presses cannot offer a different ancestor the
 * second time.
 *
 * The walk stops at three places, and each stop is a different requirement. `CHAIN_LIMIT` is KTD11 —
 * there is deliberately nothing at or above `body` to widen to. `MAX_PICKER_CHAIN` is the bound the
 * core will enforce anyway, applied here so the rungs beyond it are never proposed. And a rung the
 * core cannot describe ends the chain rather than being skipped: the rungs are *positions*, one
 * unreadable rung rejects the whole click on arrival, and a chain with a hole quietly closed would
 * answer "wider" with an ancestor two steps away.
 */
function chainFrom(target: Element): { elements: Element[]; rungs: PickerCandidate[] } {
  const elements: Element[] = []
  const rungs: PickerCandidate[] = []
  let current: Element | null = target
  while (current !== null && rungs.length < MAX_PICKER_CHAIN) {
    const tag = current.tagName.toLowerCase()
    if (CHAIN_LIMIT.has(tag)) break
    const proposal = describe(current)
    if (proposal === null) break
    elements.push(current)
    // Counted, not measured: a rung wants the number the bar shows, and asking every match of every
    // rung whether it is still drawn would be nine selectors' worth of style recalculation on one
    // click for an answer nothing reads. `visible` matters once, after the rule is written.
    rungs.push({ tag, proposal, matches: matched(proposal.selector).length })
    current = current.parentElement
  }
  return { elements, rungs }
}

/**
 * Moves the highlight onto one element.
 *
 * Hidden rather than drawn when the element reports no box at all. A 0×0 rectangle with a 2px border
 * is a blue dot in the corner of the page pointing at nothing, and it arrives on ordinary pages: a
 * correction can reach a rung whose element was re-rendered away since the click, and a detached
 * element reports nothing but zeroes.
 */
function show(run: PickerRun, target: Element): void {
  const rect = target.getBoundingClientRect()
  // One declaration block rather than five properties, so the previous position goes away with the
  // assignment instead of being partly overwritten by the next one.
  run.box.style.cssText =
    rect.width === 0 && rect.height === 0
      ? 'display:none'
      : `left:${String(rect.left)}px;top:${String(rect.top)}px;width:${String(rect.width)}px;height:${String(rect.height)}px`
}

function start(started: PickerStart): void {
  if (session !== null) return
  const parent = earlyDocument.documentElement
  if (parent === null) return

  const host = document.createElement('div')
  host.id = HOST_ELEMENT_ID
  // `closed`, so the page's scripts cannot read what is being proposed — which would tell a site
  // exactly which of its elements the user is about to remove.
  const root = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = started.styles
  const box = document.createElement('div')
  box.className = 'box'
  root.append(style, box)
  parent.appendChild(host)

  const onMove = (event: MouseEvent): void => {
    // Only the pointer's own hover; see `onClick` for why a page's made-up event is not acted on.
    if (!event.isTrusted) return
    const run = session
    if (run === null) return
    // Once the selection is frozen the highlight belongs to it, not to the pointer: the person is
    // reading the bar, and a highlight still chasing the mouse would be describing something else.
    if (run.chain !== null) return
    const target = event.target
    // The picker's own host is in the page, so it can be hovered.
    if (!(target instanceof Element) || target.id === HOST_ELEMENT_ID) return
    show(run, target)
    // The answer is not read here: what it is *for* at this point is the side effect in the core,
    // which names the element under the pointer in the bar. The proposals that matter are taken
    // again, rung by rung, at the click.
    describe(target)
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

    `click` is still what the picker acts on, and it still arrives: neither cancelling `mousedown` nor
    cancelling `pointerdown` suppresses it. What it does now is freeze rather than commit.

    Swallowed whoever sent it — the browser or the page's own script — and *acted on* only when the
    browser did. The two halves split on purpose, because they cost different things:

      - **Acting on an untrusted event is a power the page does not otherwise have.** The page can see
        the picker is up (its host is an element in the page's document) and can dispatch any event at
        any of its elements. A synthetic `click` would freeze on an element of the page's choosing and
        preview it as the thing the user is about to hide; a synthetic Escape would end the user's
        attempt. So `onClick`, `onKeyDown` and `onMove` ignore anything that is not `isTrusted`, which
        Chromium sets and page script cannot forge — it is an unforgeable property, and this preload's
        isolated world sees its own wrapper of the event rather than the page's.
      - **Swallowing one costs the page nothing it could not do anyway.** Every handler a synthetic
        event would have reached is the page's own code, which the page can call directly; stopping the
        event denies it no capability, only a route. And the user asked for the page to hold still
        while they choose: a script that forwards a click to a link, or opens its own menu by
        dispatching one, is the page acting under the picker exactly as a real press would have. So
        the swallowing stays unconditional and first, and the rule the click handler relies on — every
        way out of it has already taken the event away from the page — needs no exception for origin.
  */
  const swallow = (event: Event): void => {
    if (event.cancelable && !event.type.startsWith('pointer')) event.preventDefault()
    event.stopPropagation()
    event.stopImmediatePropagation()
  }

  const onClick = (event: MouseEvent): void => {
    // Swallowed first and unconditionally, so that every way out of this handler below is a way out
    // that has already taken the click away from the page. Picking an element inside a link must not
    // navigate away from the page being edited, whether or not a chain came of it.
    swallow(event)
    // A click the page dispatched itself chooses nothing; see the comment on `swallow`.
    if (!event.isTrusted) return
    const run = session
    if (run === null) return
    // A second click changes nothing. The sequence is swallowed, but "swallowed" is not
    // "impossible", and a re-freeze would move the selection under somebody reading the selector.
    if (run.chain !== null) return
    const target = event.target
    if (!(target instanceof Element) || target.id === HOST_ELEMENT_ID) return

    const built = chainFrom(target)
    // Nothing describable, or a click on `body` itself. The core refuses an empty chain and would
    // ignore this anyway; not sending it keeps the picker in the state the user can still act in.
    if (built.rungs.length === 0) return
    run.chain = built.elements
    show(run, built.elements[0]!)
    ipcRenderer.send(PICKER_FREEZE_CHANNEL, { sessionId: run.sessionId, chain: built.rungs })
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // The same strictness the pointer sequence gets, and for the same reason: a page listening for
    // Escape on `window` in the capture phase would otherwise close its own dialogue beside this.
    swallow(event)
    // An Escape nobody pressed does not end somebody's attempt; see the comment on `swallow`.
    if (!event.isTrusted) return
    // Told, not merely done. Escape used to tear the page's picker down and say nothing, so the core
    // went on believing this view was picking and the next start found a session already running —
    // half of the state divergence this rebuild exists to remove (R10, R12).
    ipcRenderer.send(PICKER_ESCAPED_CHANNEL, { sessionId: started.sessionId })
    stop()
  }

  /*
    Capture phase throughout, so a page that stops propagation on its own handlers cannot take the
    picker's events away from it.

    Revoked by one signal rather than by ten `removeEventListener` calls, and that is a correctness
    choice rather than a shorter one. A removal has to match its registration in *three* things —
    type, function identity and the capture flag — and a picker that left one `click` listener behind
    would swallow the next click the user made on the page, with nothing on screen to explain why. The
    signal cannot be mismatched: it is the same object every registration was given.
  */
  const listening = new AbortController()
  const options = { capture: true, signal: listening.signal } as const

  /**
   * The press, in the order Chromium dispatches it, minus the `click` that freezes.
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
    sessionId: started.sessionId,
    box,
    chain: null,
    teardown: () => {
      listening.abort()
      host.remove()
    }
  }
}

/**
 * Leaves picker mode, removing everything `start` installed: every listener, and the host with them.
 */
function stop(): void {
  if (session === null) return
  session.teardown()
  session = null
}

/** The attempt this message is about, or null when it names another one — or none. */
function runFor(sessionId: string): PickerRun | null {
  return session?.sessionId === sessionId ? session : null
}

/** Installs the listeners that let the *core* drive the mode. Nothing is exposed to the page. */
export function installElementPicker(): void {
  try {
    ipcRenderer.on(PICKER_START_CHANNEL, (_event, payload: unknown) => {
      const started = asPickerStart(payload)
      // No chrome, no picker. A build mismatch must leave the page alone rather than draw an
      // unstyled rectangle over somebody's document with nothing able to take it off again.
      if (started !== null) start(started)
    })

    ipcRenderer.on(PICKER_STOP_CHANNEL, () => {
      stop()
    })

    /*
      A correction, arriving as an index and nothing else.

      The core holds the chain it was given and moves along it; this side moves the highlight to
      match. Sending a selector back instead would invite this side to re-resolve it against a
      document that may have changed, and the two would then disagree about which element the bar is
      describing.
    */
    ipcRenderer.on(PICKER_SELECT_CHANNEL, (_event, payload: unknown) => {
      const request = asPickerSelectRequest(payload)
      if (request === null) return
      const run = runFor(request.sessionId)
      if (run === null) return
      // An index past the chain, or one arriving before the click that built it. Both mean the core
      // and this page disagree about the attempt, and moving the highlight anywhere would be a guess.
      const chosen = run.chain?.[request.index]
      if (chosen !== undefined) show(run, chosen)
    })

    /*
      The measurement, asked once the preview is off and the stored rule delivered (R13).

      Answered synchronously, in the same turn the request arrives in. The cosmetic stylesheet that
      carries the stored rule was sent before this message and IPC keeps that order, so by the time
      this listener runs the new sheet is already applied — and `getBoundingClientRect` flushes the
      layout it implies. A `requestAnimationFrame` here would buy nothing and would spend part of the
      core's two-second deadline.
    */
    ipcRenderer.on(PICKER_MEASURE_CHANNEL, (_event, payload: unknown) => {
      const request = asPickerMeasureRequest(payload)
      if (request === null || runFor(request.sessionId) === null) return
      ipcRenderer.send(PICKER_MEASURED_CHANNEL, {
        sessionId: request.sessionId,
        ...measure(request.selector)
      })
    })
  } catch (error) {
    console.warn('[picker] could not be installed:', error)
  }
}
