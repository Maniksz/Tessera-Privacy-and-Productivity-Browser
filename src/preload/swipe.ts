import { ipcRenderer } from 'electron'
import {
  IDLE_SWIPE,
  SWIPE_GESTURE_CHANNEL,
  SWIPE_GESTURE_GAP_MS,
  endSwipe,
  hasRoomToScroll,
  isHorizontalWheel,
  stepSwipe,
  swipeIndicatorOf,
  swipeWheelSample,
  type ScrollBox,
  type SwipeSample,
  type SwipeStep
} from '@shared/gestures/wheel-swipe.js'
import { createSwipeIndicator } from './swipe-indicator.js'

/**
 * The two-finger swipe back and forward, read where the page can still claim the wheel.
 *
 * Every decision is in `shared/gestures/wheel-swipe.ts`. What is left here is what only the DOM can
 * answer — whether anything under the pointer can still scroll sideways — and the registration, which
 * is the zoom gesture's (`zoom.ts`) for the same reasons: **capture** on `window`, so a page's
 * `stopPropagation` cannot hide the event; **passive**, because this never cancels a scroll; and the
 * page's `preventDefault` read **a timer's turn later**, once every listener on the path has run.
 *
 * ## Why the room is measured now and the refusal later
 *
 * They are read at opposite moments on purpose. The room has to be the room *before* this event
 * scrolled anything: measured a turn later, the event that carried a carousel to its edge would find
 * it at the edge and count as a swipe. The refusal is only final after the dispatch. So the first is
 * taken synchronously and handed to the second.
 *
 * Vertical events skip both: they only ever latch a run as a scroll, which needs neither fact — and a
 * timer per ordinary scroll event, in every tab, is the tax `zoom.ts` refuses to pay too.
 *
 * ## When it navigates, and when the arrow goes
 *
 * Both on the silence that ends the gesture (`SWIPE_GESTURE_GAP_MS`), because nothing else says the
 * fingers have lifted: `endSwipe` navigates if the swipe is still armed then, and the arrow slides out
 * either way. The arrow goes at once on `pagehide`: a page left by the swipe it drew may be frozen
 * into the back-forward cache, and coming forward again must not bring the arrow back with it.
 */
export function installSwipeNavigation(): void {
  let tracker = IDLE_SWIPE
  const indicator = createSwipeIndicator()
  let showing = false
  let ending: ReturnType<typeof setTimeout> | undefined

  const apply = (step: SwipeStep): void => {
    tracker = step.state
    if (step.intent !== null) ipcRenderer.send(SWIPE_GESTURE_CHANNEL, step.intent)
  }

  const feed = (sample: SwipeSample): void => {
    apply(stepSwipe(tracker, sample))

    const shown = swipeIndicatorOf(tracker)
    // Ordinary scrolling reaches here on every event; with no arrow up it must cost nothing more.
    if (shown === null && !showing) return
    showing = shown !== null
    indicator.show(shown)
    clearTimeout(ending)
    if (showing) {
      // The arrow is up exactly while a swipe is past the edge, so this is also every run that can navigate.
      ending = setTimeout(() => {
        showing = false
        indicator.show(null)
        apply(endSwipe(tracker))
      }, SWIPE_GESTURE_GAP_MS)
    }
  }

  window.addEventListener('pagehide', () => {
    clearTimeout(ending)
    showing = false
    tracker = IDLE_SWIPE
    indicator.dispose()
  })

  window.addEventListener(
    'wheel',
    (event) => {
      const deltas = swipeWheelSample(event)
      if (deltas === null) return
      const at = event.timeStamp

      if (!isHorizontalWheel(deltas.deltaX, deltas.deltaY)) {
        feed({ at, ...deltas, innerCanScroll: false, viewportCanScroll: false, refused: false })
        return
      }

      const room = roomSideways(event, deltas.deltaX < 0 ? -1 : 1)
      setTimeout(() => feed({ at, ...deltas, ...room, refused: event.defaultPrevented }), 0)
    },
    { capture: true, passive: true }
  )
}

/**
 * Whether a box the event passes through, and separately the viewport, can still scroll its way.
 *
 * Two answers because they mean different things — see `stepSwipe`: an element that scrolled keeps
 * the whole gesture, while the page itself hands it over to the swipe at its edge.
 *
 * `composedPath` rather than walking `parentElement`, so a scroller inside an open shadow root — a
 * web component's carousel — is found as well. A closed one is invisible from here, and a swipe over
 * it behaves as if it were not scrollable: the same as over any element this cannot see into.
 */
function roomSideways(
  event: WheelEvent,
  towards: -1 | 1
): { innerCanScroll: boolean; viewportCanScroll: boolean } {
  const root = document.scrollingElement
  for (const node of event.composedPath()) {
    if (!(node instanceof Element) || node === root) continue
    const style = getComputedStyle(node)
    if (!/^(auto|scroll|overlay)$/.test(style.overflowX)) continue
    // The viewport is not asked: an element that scrolls claims the gesture whatever the page does.
    if (hasRoomToScroll(boxOf(node, style), towards)) {
      return { innerCanScroll: true, viewportCanScroll: false }
    }
  }
  const viewportCanScroll =
    root !== null &&
    viewportScrolls() &&
    hasRoomToScroll(boxOf(root, getComputedStyle(root)), towards)
  return { innerCanScroll: false, viewportCanScroll }
}

/**
 * Whether the user can scroll the viewport sideways at all.
 *
 * `hidden` on the root turns it off; on `body` too, but only while the root leaves it `visible`,
 * because that is the one case in which CSS hands `body`'s overflow to the viewport.
 */
function viewportScrolls(): boolean {
  const closed = (value: string): boolean => value === 'hidden' || value === 'clip'
  const html = getComputedStyle(document.documentElement).overflowX
  if (closed(html)) return false
  // `lib.dom` says `body` always exists; a frameset document, or one torn down mid-gesture, has none.
  const { body } = document as Omit<Document, 'body'> & { body: HTMLElement | null }
  if (html !== 'visible' || body === null) return true
  return !closed(getComputedStyle(body).overflowX)
}

function boxOf(element: Element, style: CSSStyleDeclaration): ScrollBox {
  return {
    scrollLeft: element.scrollLeft,
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    rtl: style.direction === 'rtl'
  }
}
