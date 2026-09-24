import { randomUUID } from 'node:crypto'
import type { OverlayPresentation } from '@shared/overlay/surface.js'
import {
  subjectDevices,
  type PermissionAnswer,
  type PermissionSubject
} from '@shared/overlay/permission.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import {
  UNANSWERED,
  answerPermissionCheck,
  resolvePermissionRequest,
  unaskedPrompting,
  type PermissionCheck,
  type PermissionOutcome,
  type PermissionRequestDetails
} from '../session/permission-policy.js'
import type { BrowsingMode } from '../data/HistoryStore.js'
import {
  endsPrompt,
  promptForActiveTab,
  type PermissionTabChange,
  type SitePermissionRules
} from './model.js'
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
 * ## Why a question waits for its own tab
 *
 * A dialogue is shown only while the tab that asked is the one in front. A page in a background tab
 * asking for the location would otherwise put its question over whatever the user is looking at, and
 * the user would answer for the page they can see — consent collected in the wrong context, which is
 * the same failure as an embedded frame being attributed to its page. So a question from a background
 * tab waits in its place in the queue and comes up when its tab does; a dialogue whose tab goes to the
 * background is taken down and *put back*, unanswered and unsettled, because leaving a tab is not an
 * answer. Only the tab closing or its page moving to another site ends a question early — see
 * `endsPrompt` — and that refuses once, like every other way of nobody answering.
 *
 * The window says which tab is in front and reports what changes it (`PermissionHost`); this class
 * listens only while it has something queued for that window, and lets go when the queue empties.
 *
 * ## Why nothing here is allowed to leave a request unanswered
 *
 * Every path settles the promise. A dismissed or displaced dialogue, a closed window, a crashed
 * surface, a full queue: each one resolves to `UNANSWERED`. An unsettled request is a page that
 * hangs with no error and no explanation, and it is the failure this class is mostly written to
 * avoid.
 *
 * ## Why only a person's answer is remembered
 *
 * `UNANSWERED` refuses exactly as `block` does, and unlike `block` it leaves nothing on disk. It used
 * to be `block`, which made every one of those paths a *remembered* refusal: a window closed with
 * eight location prompts queued left eight sites blocked for good, and not one of them had been
 * refused by anybody. The only way to a remembered answer is now `answer`, which is `permissions:answer`
 * — the buttons, and Escape, which the surface sends as `block`.
 */

/**
 * The window a prompt appears in.
 *
 * Implemented by `BrowserWindowController`, and declared here as the things this actually uses
 * rather than imported from it. That keeps the arbiter testable without a `BrowserWindow`, which is
 * the difference between "two simultaneous requests queue" being a test and being a claim.
 */
export interface PermissionHost {
  readonly privateMode: boolean
  presentOverlay(presentation: OverlayPresentation): void
  dismissOverlay(): void
  /**
   * The `webContents` id of the tab in front — the only page a dialogue may appear over — or `null`
   * when there is none. Asked each time a dialogue could appear rather than tracked from events, so
   * the answer is always the window's own.
   */
  activeTabWebContentsId(): number | null
  /**
   * Reports what can move or end a waiting question: another tab coming to the front, a tab
   * navigating or closing, the window going. Returns the way off, which the arbiter takes as soon
   * as nothing is queued for this window.
   */
  onPermissionTabChange(listener: (change: PermissionTabChange) => void): () => void
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
  /** The tab that asked. The dialogue appears only while it is in front. */
  readonly webContentsId: number
  readonly origin: string
  readonly subject: PermissionSubject
  /**
   * Everyone waiting on this one answer.
   *
   * A list rather than a single resolver because identical requests are coalesced: two frames of
   * one site asking for the microphone are one dialogue and two pending promises, and both have to
   * be settled by the single answer.
   */
  readonly settlers: Array<(outcome: PermissionOutcome) => void>
}

/** Everything one window has asked and not yet had answered. */
interface WindowQueue {
  /** Oldest first. Replaced rather than spliced, so a removal can never take the wrong entry. */
  prompts: readonly PendingPrompt[]
  /**
   * The prompt on screen, or `null`.
   *
   * Only this one can be answered, and only this one's departure from the layer means anything. A
   * prompt put back when its tab went to the background is still in `prompts` and no longer here, so
   * the dismissal that took it down — and a click that lands a moment later — both pass it by.
   */
  shown: PendingPrompt | null
  /**
   * The `waiting` count last sent for `shown`.
   *
   * Kept so `#present` can tell "already on screen" from "on screen, but saying the wrong number".
   * Without it the count froze at whatever it was when the first request arrived — which is zero — and
   * the whole point of showing it was that a person about to answer three prompts is told before the
   * first one, or the second reads as the first one refusing to close.
   */
  shownWaiting: number
  /** Stops listening to the window's tabs. Called the moment the queue is dropped. */
  readonly unsubscribe: () => void
}

export class PermissionArbiter {
  /**
   * One queue per window.
   *
   * Keyed by the host object itself and dropped as soon as it empties, so a closed window leaves
   * nothing behind. A `WeakMap` would not do: the queues have to be searchable by request id, since
   * an answer arrives over IPC naming only the id.
   */
  readonly #queues = new Map<PermissionHost, WindowQueue>()

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
   *
   * `webContentsId` is the tab that asked, and the dialogue waits for it to be in front.
   */
  ask(
    request: PermissionRequestDetails,
    host: PermissionHost | null,
    webContentsId: number
  ): Promise<boolean> {
    /*
      The settings still answer: a camera set to `allow` was granted before any of this was wired,
      and a request the registry could not place in a window is no reason to start refusing it. Only
      a question that would need a dialogue is refused — unanswered, so nothing is remembered.
    */
    if (host === null)
      return resolvePermissionRequest(request, unaskedPrompting(this.#getSettings()))

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
      prompt: (prompt) => this.#enqueue(host, webContentsId, prompt.origin, prompt.subject)
    })
  }

  /**
   * Answers a synchronous check for a session of the given kind. Wired to the check handler.
   *
   * The mode comes from where the session was created rather than from a window, because a check
   * can arrive without a `webContents` — a service worker's — and still has to read the right
   * memory: a private session reads `forgetfulSitePermissions`, so a grant from the normal profile
   * never shows through as `granted` there.
   */
  check(check: PermissionCheck, mode: BrowsingMode): boolean {
    const rules = this.#rulesFor(mode)
    return answerPermissionCheck(check, {
      settings: this.#getSettings(),
      recall: (origin, subject) => rules.recall(origin, subject)
    })
  }

  /**
   * The user chose something. Called by `permissions:answer`.
   *
   * An id that names nothing on screen is ignored rather than treated as an error: the surface can
   * send an answer for a prompt that has just been settled some other way — the window lost focus a
   * fraction before the click landed — and the first settlement is the one that counts. The same
   * holds for a prompt put back because its tab went to the background: the click was aimed at a
   * dialogue that is no longer there, and the question will be asked again when the tab returns.
   */
  answer(requestId: string, answer: PermissionAnswer): void {
    const found = this.#showing(requestId)
    if (found === null) return
    const [host, queue, pending] = found
    this.#remove(queue, pending)
    this.#settle(pending, answer)

    /*
      The next prompt replaces this one directly; only a tab with nothing more to ask dismisses.
      `shown` still names the answered prompt, which is how `#present` knows the layer holds
      something to take down.

      Dismissing first would hand focus back to the chrome UI and take it away again a moment
      later, which for a keyboard user means the focus ring landing somewhere they did not ask for
      between two dialogues.
    */
    this.#present(host, queue)
  }

  /**
   * A prompt left the screen without being answered. Wired to `onOverlayVacancy`.
   *
   * Refusing is the only safe reading: the dialogue is gone, so whatever the user was about to
   * choose was not chosen. Spec 4 is explicit that an unanswered prompt counts as denied — denied
   * *this once*, which is why it settles `UNANSWERED` and not `block`: nobody refused the site.
   *
   * It used to say that this is where "unanswered" mostly happens, because a resize and a focus
   * change both took the layer down. Neither does any more: `DISMISSED_ON_INTERRUPTION` in
   * `window-events.ts` leaves every surface somebody is waiting on standing, precisely so that a
   * notification stealing focus stops answering "Blockieren" for a user who never read the question.
   * A prompt now leaves unanswered only through a stronger surface displacing it or the window
   * closing — Escape is an answer, sent over `permissions:answer` as `block` — so this path is rarer
   * than it was, and each of those is a real departure rather than an interruption. The safe reading
   * is unchanged; only the frequency is.
   */
  overlayVacated(presentation: OverlayPresentation, reason: OverlayVacancyReason): void {
    if (presentation.kind !== 'permission-request') return
    // Only the prompt on screen can leave it. One this class took down itself — answered, or put
    // back for a tab in the background — is no longer `shown`, and its departure is passed by.
    const found = this.#showing(presentation.requestId)
    if (found === null) return
    const [host, queue, pending] = found

    if (reason === 'gone') {
      // No layer left to present into, and `presentOverlay` on a destroyed window throws. Everything
      // still queued for it is refused here rather than left waiting for a dialogue that cannot
      // appear.
      this.#abandon(host, queue)
      return
    }
    this.#remove(queue, pending)
    // Off screen already, by somebody else's hand: nothing for `#present` to dismiss.
    queue.shown = null
    this.#settle(pending, UNANSWERED)
    this.#present(host, queue)
  }

  /** Requests waiting or on screen for a window. For tests and diagnostics. */
  pendingCount(host: PermissionHost): number {
    return this.#queues.get(host)?.prompts.length ?? 0
  }

  /** Whether a question from this tab is waiting or on screen. Tab unloading keeps such a tab (U15). */
  waitsOn(webContentsId: number): boolean {
    for (const queue of this.#queues.values()) {
      if (queue.prompts.some((prompt) => prompt.webContentsId === webContentsId)) return true
    }
    return false
  }

  // --- internals -----------------------------------------------------------

  #enqueue(
    host: PermissionHost,
    webContentsId: number,
    origin: string,
    subject: PermissionSubject
  ): Promise<PermissionOutcome> {
    const existing = this.#queues.get(host)
    const prompts = existing?.prompts ?? []

    /*
      The same question from the same tab, already asked. One dialogue, two answers delivered from it.

      The same tab and not merely the same site: joined across tabs, the second tab's page would wait
      on a dialogue that can only appear over the first one.
    */
    const same = prompts.find(
      (p) => p.webContentsId === webContentsId && p.origin === origin && p.subject === subject
    )
    if (same !== undefined) {
      return new Promise<PermissionOutcome>((resolve) => same.settlers.push(resolve))
    }

    if (prompts.length >= this.#maxQueued) {
      // Bounded, and the bound refuses rather than drops: a dropped request is a page that waits
      // forever, which is the one outcome worse than a denial nobody asked for. Unanswered, because
      // nobody was asked: the site is refused this once and asked again next time.
      console.warn(`[permissions] refusing ${subject} for ${origin}: too many prompts waiting`)
      return Promise.resolve(UNANSWERED)
    }

    const pending: PendingPrompt = {
      id: this.#newRequestId(),
      webContentsId,
      origin,
      subject,
      settlers: []
    }
    const queue = existing ?? this.#open(host)
    queue.prompts = [...queue.prompts, pending]
    const answer = new Promise<PermissionOutcome>((resolve) => pending.settlers.push(resolve))
    this.#present(host, queue)
    return answer
  }

  /**
   * A queue for a window that had none, listening to its tabs from now on.
   *
   * Opened only once a question is actually queued, so a window whose every request the settings
   * answered is never listened to at all.
   */
  #open(host: PermissionHost): WindowQueue {
    const queue: WindowQueue = {
      prompts: [],
      shown: null,
      shownWaiting: 0,
      unsubscribe: host.onPermissionTabChange((change) => {
        this.#tabChanged(host, change)
      })
    }
    this.#queues.set(host, queue)
    return queue
  }

  /** Drops a window's queue and stops listening to it. Settles nothing: callers do that first. */
  #close(host: PermissionHost, queue: WindowQueue): void {
    this.#queues.delete(host)
    queue.unsubscribe()
  }

  /**
   * Something about the window's tabs changed: refuse what nobody can answer any more, then put the
   * right question on screen.
   *
   * Refused this once, like every other way of nobody answering — the tab that asked closed, or its
   * page moved to another site, and neither is anybody's decision about the site.
   */
  #tabChanged(host: PermissionHost, change: PermissionTabChange): void {
    const queue = this.#queues.get(host)
    // A change can still arrive in the same turn the last request settled. Nothing is waiting on it.
    if (queue === undefined) return
    if (change.kind === 'gone') {
      // The layer is gone with the window, so presenting or dismissing would throw.
      this.#abandon(host, queue)
      return
    }
    const ended = queue.prompts.filter((prompt) => endsPrompt(prompt, change))
    queue.prompts = queue.prompts.filter((prompt) => !ended.includes(prompt))
    for (const pending of ended) this.#settle(pending, UNANSWERED)
    this.#present(host, queue)
  }

  /**
   * Makes the layer agree with the queue: the oldest question of the tab in front on screen, or
   * nothing.
   *
   * Nothing to show while something is shown takes it down — the tab in front changed, or its last
   * question was just answered — and a question taken down this way stays queued if it was not
   * settled. `shown` is cleared *before* the dismissal, because the layer reports it synchronously
   * and `overlayVacated` must not read the arbiter's own dismissal as a prompt left unanswered.
   *
   * The count sent is the questions still to come from the same tab: those are the ones that follow
   * this dialogue directly. One waiting in another tab appears only when that tab is brought forward,
   * and counting it here would tell the user this site has more to ask.
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
  #present(host: PermissionHost, queue: WindowQueue): void {
    const head = promptForActiveTab(queue.prompts, host.activeTabWebContentsId())
    if (head === null) {
      const wasShown = queue.shown !== null
      queue.shown = null
      if (queue.prompts.length === 0) this.#close(host, queue)
      if (wasShown) host.dismissOverlay()
      return
    }
    const waiting =
      queue.prompts.filter((prompt) => prompt.webContentsId === head.webContentsId).length - 1
    if (queue.shown === head && queue.shownWaiting === waiting) return

    // Recorded before presenting: replacing a prompt on the layer reports the one it replaced, and
    // that one must already read as put back rather than as unanswered.
    queue.shown = head
    queue.shownWaiting = waiting
    host.presentOverlay({
      kind: 'permission-request',
      requestId: head.id,
      origin: head.origin,
      subject: head.subject,
      devices: [...subjectDevices(head.subject)],
      waiting
    })
  }

  /** The window, queue and prompt for a request id, if that request is the one on screen. */
  #showing(requestId: string): [PermissionHost, WindowQueue, PendingPrompt] | null {
    for (const [host, queue] of this.#queues) {
      if (queue.shown?.id === requestId) return [host, queue, queue.shown]
    }
    return null
  }

  /**
   * Takes a prompt out of its queue. The queue itself stays until `#present` finds it empty, so the
   * layer is dismissed and the window let go of in one place.
   */
  #remove(queue: WindowQueue, pending: PendingPrompt): void {
    queue.prompts = queue.prompts.filter((prompt) => prompt !== pending)
  }

  /** Refuses everything still queued for a window whose layer has gone. */
  #abandon(host: PermissionHost, queue: WindowQueue): void {
    this.#close(host, queue)
    for (const pending of queue.prompts) this.#settle(pending, UNANSWERED)
  }

  #settle(pending: PendingPrompt, outcome: PermissionOutcome): void {
    for (const settle of pending.settlers) settle(outcome)
  }
}
