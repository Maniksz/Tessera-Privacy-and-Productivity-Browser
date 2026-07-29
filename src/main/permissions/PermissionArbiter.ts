import { randomUUID } from 'node:crypto'
import type { OverlayPresentation } from '@shared/overlay/surface.js'
import {
  subjectDevices,
  type PermissionAnswer,
  type PermissionSubject
} from '@shared/overlay/permission.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import {
  resolvePermissionRequest,
  type PermissionRequestDetails
} from '../session/permission-policy.js'
import type { BrowsingMode } from '../data/HistoryStore.js'
import type { SitePermissionRules } from './model.js'
import type { OverlayVacancyReason } from './vacancy.js'

/**
 * Turns "the settings say ask" into a dialogue on screen and an answer a page can act on.
 *
 * ## Why one window can show one prompt, and what happens to the second
 *
 * There is one overlay layer per window and it shows one thing at a time. Two pages in two tiles
 * can ask at the same moment, so a decision is forced. This queues, first come first served, and
 * refuses nothing on its own.
 *
 * Refusing the second request instead would have been simpler and is wrong in a way that matters:
 * the page would be handed a "no" that no human ever gave, which is worse than a delay because it
 * is indistinguishable from a real refusal — and it would let a page in one tile deny another
 * page's request just by asking first. A queue makes the second page *wait*, which is precisely
 * what a permission API is built to do: the promise stays pending until it is answered.
 *
 * Two guards keep the queue from becoming its own problem:
 *
 *  - **Coalescing.** A second request for the same permission from the same origin joins the one
 *    already queued and gets the same answer. A page that calls `getUserMedia` in a loop, or two
 *    frames of one site asking together, produce one dialogue rather than a parade of identical
 *    ones.
 *  - **A cap.** Past `maxQueued` distinct questions the rest are refused. A window with nine
 *    unanswered prompts stacked behind it is not waiting for a person, and an unbounded queue is a
 *    way to make the browser unusable — every dismissal would reveal another dialogue.
 *
 * The queue is per window, because a prompt is modal to the window it appears in. Two windows
 * prompt independently.
 *
 * ## Why nothing here is allowed to leave a request unanswered
 *
 * Every path settles the promise. A dismissed dialogue, a resized window, a closed window, a
 * crashed surface, a full queue: each one resolves to `block`. An unsettled request is a page that
 * hangs with no error and no explanation, and it is the failure this class is mostly written to
 * avoid.
 */

/**
 * The window a prompt appears in.
 *
 * Structurally satisfied by `BrowserWindowController`, and declared here as the three things this
 * actually uses rather than imported from it. That keeps the arbiter testable without a
 * `BrowserWindow`, which is the difference between "two simultaneous requests queue" being a test
 * and being a claim.
 */
export interface PermissionHost {
  readonly privateMode: boolean
  presentOverlay(presentation: OverlayPresentation): void
  dismissOverlay(): void
}

export interface PermissionArbiterOptions {
  /** Bound to the browsing mode of the window that asked; see `PermissionStore.rulesFor`. */
  rulesFor(mode: BrowsingMode): SitePermissionRules
  getSettings(): SettingsSnapshot
  /** Injected so a test can name its requests; defaults to `randomUUID`. */
  newRequestId?: () => string
  /** Overridden in tests; defaults to `MAX_QUEUED_PROMPTS`. */
  maxQueued?: number
}

/**
 * How many distinct questions one window will hold.
 *
 * Chosen for what a person can be expected to work through in one sitting rather than for a
 * technical limit. Past it, refusing is the safe direction.
 */
export const MAX_QUEUED_PROMPTS = 8

interface PendingPrompt {
  readonly id: string
  readonly host: PermissionHost
  readonly origin: string
  readonly subject: PermissionSubject
  /**
   * Everyone waiting on this one answer.
   *
   * A list rather than a single resolver because identical requests are coalesced: two frames of
   * one site asking for the microphone are one dialogue and two pending promises, and both have to
   * be settled by the single answer.
   */
  readonly settlers: Array<(answer: PermissionAnswer) => void>
  presented: boolean
  /**
   * The `waiting` count last sent for this prompt, or `null` before it was ever shown.
   *
   * Kept so `#present` can tell "already on screen" from "on screen, but saying the wrong number".
   * Without it the count froze at whatever it was when the first request arrived — which is zero — and
   * the whole point of showing it was that a person about to answer three prompts is told before the
   * first one, or the second reads as the first one refusing to close.
   */
  presentedWaiting: number | null
}

export class PermissionArbiter {
  /**
   * One queue per window.
   *
   * Keyed by the host object itself and dropped as soon as it empties, so a closed window leaves
   * nothing behind. A `WeakMap` would not do: the queues have to be searchable by request id, since
   * an answer arrives over IPC naming only the id.
   */
  readonly #queues = new Map<PermissionHost, PendingPrompt[]>()

  readonly #rulesFor: (mode: BrowsingMode) => SitePermissionRules
  readonly #getSettings: () => SettingsSnapshot
  readonly #newRequestId: () => string
  readonly #maxQueued: number

  constructor(options: PermissionArbiterOptions) {
    this.#rulesFor = options.rulesFor
    this.#getSettings = options.getSettings
    this.#newRequestId = options.newRequestId ?? (() => randomUUID())
    this.#maxQueued = options.maxQueued ?? MAX_QUEUED_PROMPTS
  }

  /**
   * Answers one request from a page: `true` grants it.
   *
   * `host` is `null` when the request could not be attributed to a window — a view already
   * detached, a frame from a window closing as the request arrived. There is nowhere to show a
   * dialogue, so nobody can answer it, so it is refused. That is the same rule as everywhere else
   * here, applied to the one case where the browser itself is the reason nobody was asked.
   */
  ask(request: PermissionRequestDetails, host: PermissionHost | null): Promise<boolean> {
    if (host === null) return Promise.resolve(false)

    /*
      The mode is resolved once, here, and the rules object is bound before the dialogue appears.

      `BrowserWindowController` carries a boolean, and this is the single place it becomes the named
      pair the store insists on. Binding it up front rather than at the moment of writing means the
      answer cannot be filed against the wrong mode by anything that happens while the user is
      reading the dialogue — including the window closing.
    */
    const mode: BrowsingMode = host.privateMode ? 'private' : 'normal'
    const rules = this.#rulesFor(mode)

    return resolvePermissionRequest(request, {
      settings: this.#getSettings(),
      recall: (origin, subject) => rules.recall(origin, subject),
      remember: (origin, subject, decision) => {
        rules.remember(origin, subject, decision)
      },
      prompt: (prompt) => this.#enqueue(host, prompt.origin, prompt.subject)
    })
  }

  /**
   * The user chose something. Called by `permissions:answer`.
   *
   * An id that names nothing is ignored rather than treated as an error: the surface can send an
   * answer for a prompt that has just been settled some other way — the window lost focus a
   * fraction before the click landed — and the first settlement is the one that counts.
   */
  answer(requestId: string, answer: PermissionAnswer): void {
    const pending = this.#take(requestId)
    if (pending === null) return
    this.#settle(pending, answer)

    /*
      The next prompt replaces this one directly; only an empty queue dismisses.

      Dismissing first would hand focus back to the chrome UI and take it away again a moment
      later, which for a keyboard user means the focus ring landing somewhere they did not ask for
      between two dialogues.
    */
    if (!this.#present(pending.host)) pending.host.dismissOverlay()
  }

  /**
   * A prompt left the screen without being answered. Wired to `onOverlayVacancy`.
   *
   * Refusing is the only safe reading: the dialogue is gone, so whatever the user was about to
   * choose was not chosen. Spec 4 is explicit that an unanswered prompt counts as denied.
   *
   * It used to say that this is where "unanswered" mostly happens, because a resize and a focus
   * change both took the layer down. Neither does any more: `DISMISSED_ON_INTERRUPTION` in
   * `window-events.ts` leaves every surface somebody is waiting on standing, precisely so that a
   * notification stealing focus stops answering "Blockieren" for a user who never read the question.
   * A prompt now leaves unanswered only through Escape, a stronger surface displacing it, or the
   * window closing — so this path is rarer than it was, and each of those three is a real departure
   * rather than an interruption. The safe reading is unchanged; only the frequency is.
   */
  overlayVacated(presentation: OverlayPresentation, reason: OverlayVacancyReason): void {
    if (presentation.kind !== 'permission-request') return
    const pending = this.#take(presentation.requestId)
    if (pending === null) return
    this.#settle(pending, 'block')

    if (reason === 'gone') {
      // No layer left to present into, and `presentOverlay` on a destroyed window throws. Everything
      // still queued for it is refused here rather than left waiting for a dialogue that cannot
      // appear.
      this.#abandon(pending.host)
      return
    }
    this.#present(pending.host)
  }

  /** Requests waiting or on screen for a window. For tests and diagnostics. */
  pendingCount(host: PermissionHost): number {
    return this.#queues.get(host)?.length ?? 0
  }

  // --- internals -----------------------------------------------------------

  #enqueue(
    host: PermissionHost,
    origin: string,
    subject: PermissionSubject
  ): Promise<PermissionAnswer> {
    const queue = this.#queues.get(host) ?? []
    this.#queues.set(host, queue)

    const [same] = queue.filter((p) => p.origin === origin && p.subject === subject).slice(0, 1)
    if (same !== undefined) {
      // The same question, already asked. One dialogue, two answers delivered from it.
      return new Promise<PermissionAnswer>((resolve) => same.settlers.push(resolve))
    }

    if (queue.length >= this.#maxQueued) {
      // Bounded, and the bound refuses rather than drops: a dropped request is a page that waits
      // forever, which is the one outcome worse than a denial nobody asked for.
      console.warn(`[permissions] refusing ${subject} for ${origin}: too many prompts waiting`)
      return Promise.resolve('block')
    }

    const pending: PendingPrompt = {
      id: this.#newRequestId(),
      host,
      origin,
      subject,
      settlers: [],
      presented: false,
      presentedWaiting: null
    }
    queue.push(pending)
    const answer = new Promise<PermissionAnswer>((resolve) => pending.settlers.push(resolve))
    this.#present(host)
    return answer
  }

  /**
   * Puts the head of a window's queue on screen. `false` means there was nothing to show.
   *
   * Re-sent when the number of prompts behind it changes, and not otherwise. Both halves matter and they
   * looked like they conflicted:
   *
   *   - A prompt already being read must not be *re-presented for its own sake*, or the surface takes
   *     focus again and the user loses the button they had tabbed to.
   *   - The waiting count has to be current, or a second request queued behind an open dialogue is never
   *     announced and reads as the first one failing to close.
   *
   * They only conflict if re-sending necessarily re-focuses. It does not: the surface keys its focus
   * effect on `requestId`, so the same request arriving again with a new count updates the text and
   * leaves the keyboard where it was. That is a property the two sides have to agree on, which is why it
   * is written down on both.
   */
  #present(host: PermissionHost): boolean {
    const queue = this.#queues.get(host)
    if (queue === undefined) return false
    const [head] = queue.slice(0, 1)
    if (head === undefined) {
      this.#queues.delete(host)
      return false
    }
    const waiting = queue.length - 1
    if (head.presented && head.presentedWaiting === waiting) return true

    head.presented = true
    head.presentedWaiting = waiting
    host.presentOverlay({
      kind: 'permission-request',
      requestId: head.id,
      origin: head.origin,
      subject: head.subject,
      devices: [...subjectDevices(head.subject)],
      waiting
    })
    return true
  }

  /** Removes a request from whichever window's queue holds it. */
  #take(requestId: string): PendingPrompt | null {
    for (const [host, queue] of this.#queues) {
      const index = queue.findIndex((pending) => pending.id === requestId)
      if (index < 0) continue
      const [pending] = queue.splice(index, 1)
      if (queue.length === 0) this.#queues.delete(host)
      return pending ?? null
    }
    return null
  }

  /** Refuses everything still queued for a window whose layer has gone. */
  #abandon(host: PermissionHost): void {
    const queue = this.#queues.get(host) ?? []
    this.#queues.delete(host)
    for (const pending of queue) this.#settle(pending, 'block')
  }

  #settle(pending: PendingPrompt, answer: PermissionAnswer): void {
    for (const settle of pending.settlers) settle(answer)
  }
}
