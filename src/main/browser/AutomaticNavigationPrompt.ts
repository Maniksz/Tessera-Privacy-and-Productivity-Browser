import type { OverlayPresentation } from '@shared/overlay/surface.js'
import type { AutomaticNavigationKind } from './automatic-navigation.js'

/**
 * The dialogue that answers "this page wants to open something — did you ask for that?".
 *
 * ## Why this is not `PermissionArbiter`
 *
 * The two look alike and settle differently, and the difference decides the design.
 *
 * A permission request is a **promise held open in a page**. `getUserMedia` is waiting, so refusing a
 * second request because a first one is on screen would hand the page a "no" that no human gave — which
 * is why that class queues, coalesces and caps, with a long docblock about never leaving a request
 * unanswered.
 *
 * Here there is no promise. A popup that does not open simply does not open, and a navigation that is
 * refused leaves the page exactly where it was — which is what was asked for: *"sonst bleiben wir auf der
 * seite"*. That removes the reason for a queue, and it removes it in the direction that helps: a page
 * firing popups in a loop is the abusive case this feature exists for, and the correct answer to the
 * second one arriving while the first is still being read is **no**, not "get in line". A queue would let
 * a page put nine dialogues in front of the user, each of which has to be dismissed.
 *
 * So: one prompt per window, a second request for the same thing joins it, and anything else while it is
 * up is refused. Every path settles, for the same reason `PermissionArbiter` insists on it — a caller
 * whose callback never runs is a navigation that neither happens nor visibly fails.
 *
 * ## Why the pending request is keyed by url and kind
 *
 * A page that calls `window.open(sameUrl)` from a loop, or two frames of one site asking together,
 * produce one dialogue and one answer. Keyed by what the user is being *asked* rather than by which view
 * asked, because the question on screen names the address and nothing else — two views asking about one
 * address is one question, and answering it twice would be asking the user to repeat themselves.
 */

/** The window this prompt appears in. Structurally satisfied by `BrowserWindowController`. */
export interface AutomaticNavigationHost {
  presentOverlay(presentation: OverlayPresentation): void
  dismissOverlay(): void
}

export interface AutomaticNavigationPromptOptions {
  host: AutomaticNavigationHost
  /** Injected so a test can name its requests; defaults to a counter. */
  newRequestId?: () => string
}

interface Pending {
  readonly id: string
  readonly kind: AutomaticNavigationKind
  readonly url: string
  /** Every caller waiting on this question — a coalesced request adds one. */
  readonly settle: Array<(permitted: boolean) => void>
}

export class AutomaticNavigationPrompt {
  readonly #host: AutomaticNavigationHost
  readonly #newRequestId: () => string
  #pending: Pending | null = null
  #counter = 0

  constructor(options: AutomaticNavigationPromptOptions) {
    this.#host = options.host
    this.#newRequestId = options.newRequestId ?? (() => `nav-${++this.#counter}`)
  }

  /** True while a dialogue is on screen, so the caller can tell a refusal from a pending question. */
  get isAsking(): boolean {
    return this.#pending !== null
  }

  /**
   * Puts the question up, or answers it immediately if it cannot be asked.
   *
   * `settle` is called exactly once on every path.
   */
  ask(
    request: { kind: AutomaticNavigationKind; url: string; host: string },
    settle: (permitted: boolean) => void
  ): void {
    const existing = this.#pending
    if (existing !== null) {
      // The same question again: join it, and be answered with it.
      if (existing.kind === request.kind && existing.url === request.url) {
        existing.settle.push(settle)
        return
      }
      /*
        A different question while one is up. Refused rather than queued — see the docblock. The page is
        told nothing either way, so the only thing this costs is a popup that would have been the second
        of several.
      */
      settle(false)
      return
    }

    const id = this.#newRequestId()
    this.#pending = { id, kind: request.kind, url: request.url, settle: [settle] }
    this.#host.presentOverlay({
      kind: 'navigation-request',
      requestId: id,
      navigationKind: request.kind,
      url: request.url,
      host: request.host
    })
  }

  /**
   * The answer a person gave.
   *
   * `requestId` is checked against the prompt actually on screen, and a mismatch is ignored. The same
   * rule the permission prompt has, for the same reason: a stale reply — the surface answering a question
   * that has already been taken down and replaced — would settle the *current* request with an answer
   * given to a different one.
   */
  answer(requestId: string, permitted: boolean): void {
    const pending = this.#pending
    if (pending?.id !== requestId) return
    this.#pending = null
    this.#host.dismissOverlay()
    for (const settle of pending.settle) settle(permitted)
  }

  /**
   * The prompt went away without being answered — dismissed, displaced, the window resized.
   *
   * Refuses, because "the user made it go away" cannot be read as consent, and because the fallback the
   * feature was asked for is to stay on the page.
   *
   * Takes the id, and that is not defensive politeness: the overlay layer announces a departure to the
   * whole application rather than to one window (see `permissions/vacancy.ts` for why), so without the
   * check a prompt vanishing in one window would refuse the question a *second* window still has on
   * screen. Safe to call when nothing is pending, and when the id belongs to somebody else.
   */
  cancel(requestId: string): void {
    const pending = this.#pending
    if (pending?.id !== requestId) return
    this.#pending = null
    for (const settle of pending.settle) settle(false)
  }
}
