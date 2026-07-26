import type { OverlayPresentation } from '@shared/overlay/surface.js'

/**
 * Told whenever a surface that something was waiting on leaves the overlay layer.
 *
 * ## The failure this exists to prevent
 *
 * The overlay layer is taken down by things that know nothing about what was on it. A window
 * resize dismisses it, because a resize moves the button an anchored menu was placed against. So
 * does losing window focus, and so does a layout change. For a menu that is exactly right. For a
 * permission prompt it means a page's `getUserMedia` promise never settles — never resolves, never
 * rejects — and the site simply hangs, with no error anywhere and nothing on screen to explain it.
 *
 * So the layer reports every departure, and whoever was waiting settles it the safe way: refused
 * (spec 4 — an unanswered prompt is a denied one).
 *
 * ## Why a module-level registry rather than a constructor option
 *
 * The layer is created by the window controller, which knows nothing about permissions and should
 * not have to. The thing that must hear about a vanished prompt is one arbiter for the whole
 * application. Threading a callback from there through the window registry and the window
 * controller would put a permission concern into two option bags that have no other reason to
 * mention it — and every future waiting surface would widen the same two signatures again.
 *
 * The cost is a mutable module-level set, so `onOverlayVacancy` returns its own unsubscribe and
 * tests use it.
 */

/**
 * Why the surface went.
 *
 * The distinction is load-bearing for what happens next, not for the refusal:
 *
 * `dismissed` — the layer is free again, so the next queued request can be shown.
 * `replaced` — something else took the layer. The next request is shown anyway; a modal prompt
 *   outranks whatever displaced it, and the alternative is a queue that waits for a signal that
 *   never comes.
 * `gone` — there is no layer any more: the window closed, or the surface's renderer crashed.
 *   Nothing further may be presented, and everything still queued for that window has to be
 *   refused rather than left waiting for a dialogue that can no longer appear.
 */
export type OverlayVacancyReason = 'dismissed' | 'replaced' | 'gone'

export type OverlayVacancyListener = (
  presentation: OverlayPresentation,
  reason: OverlayVacancyReason
) => void

const listeners = new Set<OverlayVacancyListener>()

export function onOverlayVacancy(listener: OverlayVacancyListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Announces a departure.
 *
 * A copy of the set is iterated so a listener that unsubscribes while being called cannot skip the
 * next one, and each call is guarded: a listener that throws must not stop the others, and must
 * certainly not stop the layer from changing what it shows — the alternative is a crashed overlay
 * that stays on screen swallowing every click.
 */
export function notifyOverlayVacancy(
  presentation: OverlayPresentation,
  reason: OverlayVacancyReason
): void {
  for (const listener of [...listeners]) {
    try {
      listener(presentation, reason)
    } catch (error) {
      console.error('[overlay] a vacancy listener threw:', error)
    }
  }
}
