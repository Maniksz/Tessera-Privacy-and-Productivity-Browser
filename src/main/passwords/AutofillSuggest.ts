import { randomUUID } from 'node:crypto'
import {
  mayPresentOver,
  type AutofillSuggestContent,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import {
  autofillSuggestBounds,
  autofillSuggestBoundsAt,
  type SuggestViewGeometry
} from '@shared/passwords/suggest-bounds.js'
import {
  AUTOFILL_DESCRIBE_CHANNEL,
  AUTOFILL_SUGGEST_END_CHANNEL,
  asSuggestPress
} from '@shared/passwords/wire.js'
import type { Rect } from '@shared/ui/anchor.js'
import type { FormDescriptor } from '@shared/passwords/fields.js'
import type { ReportedFieldRect } from '@shared/passwords/suggest-bounds.js'
import type { AutofillFrame, AutofillService, AutofillView } from './AutofillService.js'

/**
 * The account picker's life, from a press on the badge to a value in the field.
 *
 * ## Why this is not in `AutofillService`
 *
 * The service decides; this arranges. Everything here is about a *window* — whether the overlay
 * layer can be had, which tile the field is in, what the master-password prompt did — and none of it
 * is a rule about credentials. Keeping the two apart is what lets the service stay a pure decision
 * table and lets this be driven from a test with an object literal, which matters more here than
 * usual: the sequence below has four ways to end and one of them raises the highest-ranked surface
 * in the program.
 *
 * ## The one thing that is easy to get wrong
 *
 * A request id *is* a consent (`shared/passwords/consent.ts`). So every departure of this surface
 * has to discard it — otherwise `no-user-gesture` is switched off for that tab for good — and
 * exactly two departures must **not**, because in both the flow is still running:
 *
 *   - the user chose, and the fill that spends the consent has not happened yet;
 *   - the user pressed Unlock, and the master-password prompt has taken the layer from us.
 *
 * That is what `settling` is. Everything else — Escape, a resize, a permission prompt arriving, a
 * crashed overlay renderer, the window closing — arrives at `overlayVacated` with `settling` unset
 * and takes the request down with it.
 *
 * ## Why the page is told when the list leaves
 *
 * The badge stays drawn while its list is open, because the overlay renderer takes the focus off the
 * field the moment the list appears and a badge bound to focus alone would vanish exactly when it
 * worked (R1). The page cannot know when the list left, so it is told — and it is told on every
 * ending, which is why `AUTOFILL_SUGGEST_END_CHANNEL` carries the chosen token as well: a choice is
 * a departure too, and two channels would have been two chances to leave a badge lit over a field
 * with nothing in front of it.
 */

/** The overlay layer of one window, as this needs it. `BrowserWindowController` satisfies it. */
export interface SuggestWindow {
  presentOverlay(presentation: OverlayPresentation): void
  dismissOverlay(): void
  /** What is on the layer now, so nothing here can take down a surface that is not its own. */
  overlayPresentation(): OverlayState
}

/**
 * Where a page view is: its window's layer, its tile, and the geometry the list is placed from.
 *
 * `null` for a view this browser cannot place — a devtools window, a tab loaded but off screen —
 * and then there is nowhere to draw a list, which is the same answer as being refused the layer.
 */
export interface SuggestTarget {
  readonly window: SuggestWindow
  readonly tileIndex: number
  readonly geometry: SuggestViewGeometry
}

export interface AutofillSuggestOptions {
  readonly service: AutofillService
  readonly targetFor: (viewId: number) => SuggestTarget | null
  /**
   * Raises the master-password prompt in this window and resolves when it has been answered.
   *
   * A function rather than the prompt itself, for the reason every host in this project is one: it
   * is the difference between "the picker never raises the prompt directly" being a test and being
   * a sentence in a comment.
   */
  readonly requestUnlock: (window: SuggestWindow) => Promise<unknown>
  /** Injected so a test can name its requests; defaults to `randomUUID`. */
  readonly newRequestId?: () => string
  /** Injected so a test can age a chrome request; defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * How long the page has to describe its form after browser chrome asked it to.
 *
 * The answer is a message the page sends anyway when its badge is pressed, so the question is the
 * only thing that makes it count as chrome consent — and a question left open would let the page
 * put the picker up whenever it liked afterwards. Two seconds is a round trip with a slow page in it.
 */
export const CHROME_ASK_TTL_MS = 2000

/** One account picker, on screen or on its way back. */
interface LiveSuggest {
  readonly requestId: string
  readonly view: AutofillView
  readonly frame: AutofillFrame
  /** The form as the page described it at the press. Re-described by the preload before any fill. */
  readonly form: FormDescriptor
  readonly field: ReportedFieldRect
  /** The toolbar key's rectangle when the key asked, so the list hangs from it; else the field. */
  readonly anchor: Rect | null
  /**
   * Set while this feature is taking its own surface off the layer on purpose.
   *
   * `'choice'` — the consent has to outlive the surface by exactly one fill.
   * `'unlock'` — the master-password prompt is displacing us and we are coming back.
   */
  settling: 'choice' | 'unlock' | null
}

export class AutofillSuggest {
  readonly #options: AutofillSuggestOptions
  readonly #service: AutofillService
  readonly #newRequestId: () => string
  /** By request id, because that is how an answer and a departure both arrive. */
  readonly #live = new Map<string, LiveSuggest>()
  /** By view, because that is how the page's own "close it" arrives. At most one per view. */
  readonly #byView = new Map<number, LiveSuggest>()
  /** Views browser chrome has asked to describe their form, with where the list should hang. */
  readonly #asked = new Map<number, { readonly anchor: Rect | null; readonly at: number }>()
  readonly #now: () => number

  constructor(options: AutofillSuggestOptions) {
    this.#options = options
    this.#service = options.service
    this.#newRequestId = options.newRequestId ?? ((): string => randomUUID())
    this.#now = options.now ?? Date.now
  }

  /**
   * The user asked for a fill from browser chrome: the toolbar key, the shortcut, the context menu.
   *
   * Only the page can say where its form is, so it is asked to describe it (`AUTOFILL_DESCRIBE_CHANNEL`)
   * and answers the way a badge press does. What makes that answer a chrome consent (R11) is this
   * call, which no message from a page view reaches: it is remembered here, once, for a moment, and
   * spent by the first press that arrives. `anchor` is the key's rectangle, or `null` to hang the
   * list from the field as a badge would.
   *
   * Nothing is asked for when the layer cannot be had, for `press`'s reason: a request nothing can
   * answer visibly must leave nothing open behind it.
   */
  requestFromChrome(view: AutofillView, anchor: Rect | null): void {
    const target = this.#options.targetFor(view.id)
    if (target === null) return
    if (!mayPresentOver('autofill-suggest', target.window.overlayPresentation())) return
    this.#asked.set(view.id, { anchor, at: this.#now() })
    if (!view.isDestroyed()) view.send(AUTOFILL_DESCRIBE_CHANNEL, null)
  }

  /**
   * The badge was pressed. Answers with a surface, or with nothing.
   *
   * Nothing, twice over, and both are R8's named exceptions rather than oversights. The layer is
   * checked *before* the vault is asked anything, so a press that cannot be answered visibly leaves
   * no request open behind it — the mistake `FindController.open` makes the same guard against.
   */
  press(view: AutofillView, frame: AutofillFrame, reported: unknown): void {
    const request = asSuggestPress(reported)
    if (request === null) return

    const target = this.#options.targetFor(view.id)
    if (target === null) return
    /*
      Exception two: something with a stronger claim holds the layer.

      Asked here rather than discovered afterwards. `presentOverlay` declines silently, so opening
      the request first would leave a consent standing for a surface that never appeared — and
      nothing would ever announce its departure, because it never arrived.
    */
    if (!mayPresentOver('autofill-suggest', target.window.overlayPresentation())) return

    /*
      Exception one: the browser process saw no input event in this view, so this was not a person —
      unless browser chrome asked for exactly this a moment ago, which is the other consent (R4).
    */
    const asked = this.#takeAsk(view.id)
    const requestId = asked === null ? null : this.#newRequestId()
    /*
      The chrome request is opened *before* the rules are asked, because it is the consent they weigh:
      `suggestFor` decides with `decideFill`, whose first rule is that one. It is opened here, where
      browser chrome's question is being answered, and nowhere a page's message alone could reach.
    */
    if (requestId !== null) this.#service.noteChromeRequest(view.id, requestId)
    const content =
      asked === null
        ? this.#service.badgePressed(view, frame, request.form)
        : this.#service.suggestFor(view, frame, request.form)
    if (content === null) {
      if (requestId !== null) this.#service.dropChromeRequest(view.id)
      return
    }

    /*
      One picker per view. A second press replaces the first rather than stacking a second consent.

      Taken down without telling the page, unlike every other ending: the page is the one pressing
      again, and a "the list has gone" arriving between its press and the new list would put the
      badge's highlight out under the surface that is about to appear.
    */
    const previous = this.#byView.get(view.id)
    if (previous !== undefined) {
      this.#forget(previous)
      this.#takeDown(previous)
    }

    const live: LiveSuggest = {
      requestId: requestId ?? this.#newRequestId(),
      view,
      frame,
      form: request.form,
      field: request.field,
      anchor: asked?.anchor ?? null,
      settling: null
    }
    this.#live.set(live.requestId, live)
    this.#byView.set(view.id, live)
    if (!this.#present(live, content)) this.#abandon(live)
  }

  /**
   * The page says the list should go: a press beside it, a scroll, a pinch, a resize (AE6).
   *
   * The page is not obeyed about anything except this, and it costs nothing to obey: the worst a
   * page can do by lying is close its own user's list, which the user can reopen with one press.
   */
  close(view: AutofillView): void {
    this.#asked.delete(view.id)
    const live = this.#byView.get(view.id)
    if (live === undefined) return
    this.#forget(live)
    this.#service.dropChromeRequest(view.id)
    this.#takeDown(live)
  }

  /**
   * The user picked an account.
   *
   * The order below is the whole of it. The token is minted while the consent is still open; the
   * surface is marked as leaving on purpose, so its departure does not throw that consent away; and
   * only then is the page told, because the page's next act is to redeem the token synchronously.
   */
  choose(requestId: string, entryId: string): void {
    const live = this.#live.get(requestId)
    if (live === undefined) return
    const token = this.#service.noteFillChoice(live.view.id, entryId)
    live.settling = 'choice'
    this.#takeDown(live)
    this.#forget(live)
    this.#send(live, token)
  }

  /**
   * Unlock was pressed on the picker.
   *
   * This is the step R9 exists for: the master-password prompt is raised by a press on a surface in
   * browser chrome, never by a message from a page view. It is also an action in browser chrome in
   * its own right, so it mints the consent that carries the rest of the flow — the person is about
   * to spend half a minute typing, which no gesture window would survive (KTD4).
   */
  unlock(requestId: string): void {
    const live = this.#live.get(requestId)
    if (live?.settling !== null) return
    const target = this.#options.targetFor(live.view.id)
    if (target === null) {
      this.#abandon(live)
      return
    }
    /*
      Marked before the prompt is raised, and that ordering is load-bearing: `requestUnlock`
      presents synchronously, which displaces this surface, which announces a departure — and an
      unmarked departure discards the request this flow is about to come back to.
    */
    live.settling = 'unlock'
    this.#service.noteChromeRequest(live.view.id, live.requestId)
    void this.#options
      .requestUnlock(target.window)
      .then(() => {
        this.#reopen(live)
      })
      .catch(() => {
        // A prompt that could not be shown at all. The flow ends the way every other refusal does —
        // unless a new press has replaced it meanwhile, whose request is not this one to end.
        if (this.#live.get(live.requestId) === live) this.#abandon(live)
      })
  }

  /**
   * The picker left the overlay layer. Wired to `onOverlayVacancy`.
   *
   * Escape, a resize, a lost focus, a layout change, a permission prompt claiming the layer, a
   * crashed overlay renderer, the window closing. None of them knows what autofill is, and every one
   * of them has to end the request and take the badge's highlight off the page.
   */
  overlayVacated(presentation: OverlayPresentation): void {
    if (presentation.kind !== 'autofill-suggest') return
    const live = this.#live.get(presentation.requestId)
    if (live === undefined) return
    // Ours, and on purpose. The choice and the unlock each clean up on their own terms.
    if (live.settling !== null) return
    this.#abandon(live)
  }

  /** Which request is open on a view, or `null`. For tests and diagnostics. */
  requestFor(viewId: number): string | null {
    return this.#byView.get(viewId)?.requestId ?? null
  }

  // --- internals -------------------------------------------------------------

  /** The chrome request for this view, spent by this call, or `null` if none is standing. */
  #takeAsk(viewId: number): { readonly anchor: Rect | null } | null {
    const asked = this.#asked.get(viewId)
    this.#asked.delete(viewId)
    if (asked === undefined) return null
    const age = this.#now() - asked.at
    return age >= 0 && age <= CHROME_ASK_TTL_MS ? asked : null
  }

  /**
   * Decides again with the vault open, and puts the answer up in place of the notice.
   *
   * In place: same request id, so `surfaceIdentity` reads it as an update rather than as one surface
   * leaving and another arriving — which would announce a departure and discard the consent the
   * unlock just minted.
   */
  #reopen(live: LiveSuggest): void {
    if (this.#live.get(live.requestId) !== live) return
    live.settling = null
    const content = this.#service.suggestFor(live.view, live.frame, live.form)
    if (content === null || !this.#present(live, content)) this.#abandon(live)
  }

  /**
   * Puts the picker on the layer. `false` when there is nowhere to put it.
   *
   * Nowhere is ordinary rather than exceptional: the field scrolled off screen between the press and
   * this line, or the tile is too small to hold a list clear of its own edges. See
   * `autofillSuggestBounds`, which answers `null` rather than clamping a list onto a field that is
   * not there.
   */
  #present(live: LiveSuggest, content: AutofillSuggestContent): boolean {
    const target = this.#options.targetFor(live.view.id)
    if (target === null) return false
    if (!mayPresentOver('autofill-suggest', target.window.overlayPresentation())) return false
    const bounds =
      live.anchor === null
        ? autofillSuggestBounds({ field: live.field, view: target.geometry, content })
        : autofillSuggestBoundsAt({ anchor: live.anchor, view: target.geometry, content })
    if (bounds === null) return false

    /*
      The consent is minted for the one state a fill can follow from, and dropped for every other.

      A notice has nothing to choose, so a consent behind it would be a standing permission with no
      question in front of it. The `locked` notice is the interesting case: it drops the request
      too, and gets a fresh one from the Unlock button, which is an action in browser chrome and can
      therefore mint one honestly.
    */
    if (content.state === 'entries') {
      this.#service.noteChromeRequest(live.view.id, live.requestId)
    } else {
      this.#service.dropChromeRequest(live.view.id)
    }

    target.window.presentOverlay({
      kind: 'autofill-suggest',
      requestId: live.requestId,
      tileIndex: target.tileIndex,
      bounds,
      content
    })
    return true
  }

  /** Ends the flow the ordinary way: no request, no surface, and the badge's highlight off. */
  #abandon(live: LiveSuggest): void {
    this.#forget(live)
    this.#service.dropChromeRequest(live.view.id)
    this.#takeDown(live)
    this.#send(live, null)
  }

  /**
   * Drops a picker from both indexes. Only ever handed the view's *current* picker: a replaced one is
   * forgotten at the moment it is replaced, and the two late endings — the prompt settling, the prompt
   * failing — check that their picker is still the live one before they get here.
   */
  #forget(live: LiveSuggest): void {
    this.#live.delete(live.requestId)
    this.#byView.delete(live.view.id)
  }

  /**
   * Takes the layer down only if it is still showing *this* picker.
   *
   * Never a plain dismiss, for `FindController`'s reason: a close can arrive after something else
   * has claimed the layer, and dismissing then would take down a permission prompt — which settles
   * it the safe way, which is refusing a request nobody was asked about.
   */
  #takeDown(live: LiveSuggest): void {
    const target = this.#options.targetFor(live.view.id)
    if (target === null) return
    const current = target.window.overlayPresentation()
    if (current?.kind !== 'autofill-suggest') return
    if (current.requestId !== live.requestId) return
    target.window.dismissOverlay()
  }

  #send(live: LiveSuggest, token: string | null): void {
    if (live.view.isDestroyed()) return
    live.view.send(AUTOFILL_SUGGEST_END_CHANNEL, token)
  }
}
