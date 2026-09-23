import { app, webContents, type WebContents } from 'electron'
import {
  PICKER_ESCAPED_CHANNEL,
  PICKER_FREEZE_CHANNEL,
  PICKER_MEASURED_CHANNEL,
  PICKER_MEASURE_CHANNEL,
  PICKER_PROPOSE_CHANNEL,
  PICKER_SELECT_CHANNEL,
  PICKER_START_CHANNEL,
  PICKER_STOP_CHANNEL,
  asElementDescription,
  asPickerEscape,
  asPickerFreezeReport,
  asPickerMeasurement
} from '@shared/filters/picker-wire.js'
import { cosmeticRuleFor, proposeSelector } from '@shared/filters/picker.js'
import {
  pickerStep,
  selectedCandidate,
  type PickerAbortReason,
  type PickerEvent,
  type PickerOutcome,
  type PickerScope,
  type PickerSession,
  type PickerStepResult
} from '@shared/filters/picker-session.js'
import type { PickerChrome } from '@shared/filters/picker-wire.js'
import type { PickerBarAction } from '@shared/overlay/picker-bar.js'
import {
  mayPresentOver,
  type OverlayKind,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import type { Locale } from '@shared/i18n/catalog.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { Rect } from '@shared/ui/anchor.js'
import { onOverlayVacancy, type OverlayVacancyReason } from '../permissions/vacancy.js'
import { navigationAbortReason, pickableDocument, vacancyAbortReason } from './picker-entry.js'
import { pickerBarPresentation } from './picker-presentation.js'
import type { UserRuleEditor } from '../data/UserRuleStore.js'

/**
 * The element picker's core half: wiring, and nothing that decides anything.
 *
 * ## Why a session rather than a set of views
 *
 * This class used to hold a `Set` of views the core had started, and cleared it on two of the eleven
 * events that end a picker. Escape in the page cleared the page's own overlay and told the core
 * nothing, so the core went on believing that view was picking; a click that stored a rule could fail
 * five different ways and every one of them looked, from the outside, like the overlay closing and
 * nothing happening. Neither could be caught by a test, because everything this file touches is
 * `app.on('web-contents-created')` and a live `WebContents` — which is why it is on
 * `vitest.config.ts`'s coverage exclude list, and why the entry there says it is admitted *because*
 * its decisions were extracted.
 *
 * They are now in three places, and none of them is here:
 *
 *   - `shared/filters/picker-session.ts` — the lifecycle. Which transitions exist, which messages
 *     decide nothing, and which of the eight named answers of R1 an attempt ends with. A start is a
 *     transition too, which is what makes `pickerStep` the single precondition all three entries
 *     share (R19): `no-host` and `not-filterable` are refusals of the machine, not checks written
 *     three times.
 *   - `picker-entry.ts` — what the core can see and the module cannot: whether a document may carry
 *     a rule at all, what an Electron navigation event means, what a vacated overlay means.
 *   - `picker-presentation.ts` — what the bar is told.
 *
 * What is left below is effects: send a message, put a surface up, hand a rule to an editor, lift a
 * preview. If a branch about *what should happen* settles here again, it has settled in a file no
 * test can reach.
 *
 * ## The privilege model, which decides the whole shape
 *
 * Every message from a page's preload is, from here, a message from a renderer — and a renderer can
 * be compromised. So "may this view propose selectors?" is answered from the session the *core*
 * started when the user chose the picker in that tab, never from anything the message carries. A view
 * with no live session gets `null`, whatever it sends.
 *
 * That is the whole of the privilege story. A page cannot enter picker mode: the entry is a message
 * from here to one view, sent because the user clicked something in the browser's own interface.
 *
 * ## Why a picked rule may only hide
 *
 * `describeUserRule` in `user-rules.ts` refuses any rule that would block a network request, and this
 * only ever produces `hostname##selector` for a hostname read here off the view rather than out of a
 * message. Hiding a banner and cutting a site off are very different powers, and they must not sit
 * behind the same click. The preview goes through the same reading a second time on its way into a
 * document (`viewStylesheet`), so a selector a renderer invented cannot smuggle a scriptlet in
 * either.
 *
 * ## What a private window cannot do, and is not told it can
 *
 * `duplicate-disabled` names a rule that is already stored and switched off, and the bar's route out
 * of it is the rule manager. In a *private* window that route cannot finish the job: the session
 * editor adds rules of its own and changes only those, and switching a rule stored on disk back on is
 * a write to the stored set, which a private window may not make — the rule manager shows it there as
 * the profile's, without a switch. So the rule stays off there. The wording sends
 * the user to their rules rather than claiming a switch that would not take, and this is the note
 * saying why rather than a promise nobody could keep.
 */

/**
 * The window a picking session's bar appears in, and the tile it appears over.
 *
 * Declared as the seven things this actually uses rather than imported from
 * `BrowserWindowController`, exactly as `FindHost` is and for the same reason: it is the difference
 * between "the bar appears in the window that was picked in" being a test and being a claim.
 *
 * Resolved once, when a session starts, and held for its life. A session outlives its view — a tab
 * closed under an open bar has to take the bar down — so looking the window up again from a view that
 * has gone would leave the surface on screen.
 */
export interface PickerHost {
  readonly windowId: number
  readonly tabId: string
  readonly tileIndex: number
  /** The tile's rectangle in window coordinates, read per presentation because tiles move. */
  tileRect(): Rect
  presentOverlay(presentation: OverlayPresentation): void
  /** By kind, never wholesale: a dismissal must not be able to answer a consent dialogue. */
  dismissOverlayKind(kind: OverlayKind): boolean
  overlayPresentation(): OverlayState
  /** Opens the rule manager, in this window. The second half of R15. */
  openRules(): void
}

export interface ElementPickerOptions {
  /**
   * The picker's stylesheet: the one thing that still crosses into the page.
   *
   * It carried wording too, once, and the preload never had to hold a translation catalogue for it. The
   * words are the confirmation bar's now, and they travel on the bar's presentation; see `locale` below.
   */
  readonly chrome: () => PickerChrome
  /** Read per start, because whether this document may be filtered is a live answer. */
  readonly getSettings: () => SettingsSnapshot
  /**
   * The language the interface is in, read per presentation.
   *
   * The bar's words are resolved here in the core (`picker-bar-text.ts`) and sent with every
   * presentation, so this is asked each time rather than once per session: a language changed under an
   * open bar is in force by the next thing the bar says. A closure rather than `getSettings`, because
   * `'system'` means the desktop's language and only `app.getLocale()` knows what that is.
   */
  readonly locale: () => Locale
  /**
   * Where a picked rule goes. Bound to a browsing mode by `UserRuleStore.editorFor`, so a private
   * window's picker writes nothing to disk — which is a property of the object rather than a check
   * here. Held for the life of the attempt, so Undo takes the rule back through the same seam.
   */
  readonly editorFor: (webContentsId: number) => UserRuleEditor | null
  /** The window and tile a view belongs to, or `null` for a view that is in neither. */
  readonly hostFor: (webContentsId: number) => PickerHost | null
  /**
   * Shows one view a provisional rule, or takes it back with `null`.
   *
   * `CosmeticInjector.setPreview`, which delivers immediately — the revocation has to be a state of
   * the *page* by the time the next line runs, because the next line is a measurement.
   */
  readonly preview: (webContentsId: number, ruleText: string | null) => void
  /** Overridable so a test does not have to wait for it. */
  readonly measureTimeoutMs?: number
}

/**
 * How long the page has to answer a measurement before the answer is taken to be "nothing observed".
 *
 * A deadline is needed at all because the alternative is a bar that says "checking" for ever: the
 * page may be hung, or may be running a preload built before this channel existed. Two seconds is
 * far past the frame plus follow-up the measurement itself takes (OQ1), so reaching it means no
 * answer is coming rather than that one is late.
 *
 * Timing out reports `saved-ineffective`, which is the safe direction of the two: telling somebody a
 * rule did nothing when it did is something they can check, and telling them it worked when the page
 * is unchanged is the original defect.
 */
const MEASURE_DEADLINE_MS = 2_000

/**
 * Session ids are per process and monotonic; only their distinctness is relied upon.
 *
 * Module-level rather than per instance, `nextFindSessionId`'s arrangement: two pickers in one
 * process — which is what a test suite is — would otherwise both mint `picker-1`, and the overlay
 * layer's vacancy announcement, which names a surface rather than a window, would be resolved by the
 * wrong one of them.
 */
let sequence = 0

/** Everything the wiring needs beside the session, which the pure module has no business holding. */
interface PickerAttempt {
  readonly sessionId: string
  readonly host: PickerHost
  /** The selector under the pointer while nothing is frozen. Presentation only. */
  hovered: string
  /** The rule *this attempt* wrote, so Undo can take back exactly it and nothing else. */
  written: { readonly ruleId: string; readonly editor: UserRuleEditor } | null
}

export class ElementPicker {
  readonly #options: ElementPickerOptions
  /**
   * The one session in the whole program, fenced by `pickerStep`'s signature rather than by a map.
   *
   * Kept even once it has ended: an ended session is what makes a late answer from a page decide
   * nothing, and it is what the bar is still showing an outcome for.
   */
  #session: PickerSession | null = null
  #attempt: PickerAttempt | null = null
  /**
   * The deadline on the page's measurement, cleared at every end.
   *
   * Held here rather than on the attempt, and where it is held is the point. It lived on the attempt,
   * and a bar leaving the layer drops the attempt *before* it aborts — deliberately, see
   * `#overlayVacated` — so the end that should have cleared it found no attempt to clear it on. The
   * timer then outlived its session and fired into the next one in the same view. There is one
   * session in the program, so there is one deadline, and nothing about clearing it should depend on
   * which record happens still to be held.
   */
  #deadline: ReturnType<typeof setTimeout> | null = null

  constructor(options: ElementPickerOptions) {
    this.#options = options
  }

  install(): void {
    /*
      Every way a bar can leave the layer, in one place.

      The layer is taken down by things that know nothing about picking: a window resize, a lost
      focus, a layout change, a consent dialogue, a crashed surface, the window closing. Each of them
      leaves a provisional rule injected into a live document unless something lifts it, and the
      bar's own Cancel is routed the same way — so there is one path out rather than six, exactly as
      `FindController` arranged for a highlight.
    */
    onOverlayVacancy((presentation, reason) => {
      this.#overlayVacated(presentation, reason)
    })

    app.on('web-contents-created', (_event, contents) => {
      contents.on('ipc-message-sync', (event, channel, ...args) => {
        if (channel !== PICKER_PROPOSE_CHANNEL) return
        event.returnValue = this.#propose(contents, args[0])
      })

      contents.on('ipc-message', (_ipcEvent, channel, ...args) => {
        if (channel === PICKER_FREEZE_CHANNEL) {
          this.#freeze(contents, args[0])
          return
        }
        if (channel === PICKER_MEASURED_CHANNEL) {
          this.#measured(contents, args[0])
          return
        }
        if (channel !== PICKER_ESCAPED_CHANNEL) return
        this.#escaped(contents, args[0])
      })

      /*
        Three of R11's events arrive as one subscription, and the third is the one that used to be
        missed: a same-document navigation. The user asked to pick something on *this* page, and a
        page that moved underneath the selection has taken the element away whether or not it
        reloaded to do it.
      */
      contents.on('did-start-navigation', (...args: unknown[]) => {
        const reason = navigationAbortReason(args[0], contents.getURL())
        if (reason !== null) this.#abort({ of: 'view', viewId: contents.id }, reason)
      })
      contents.once('destroyed', () => {
        this.#abort({ of: 'view', viewId: contents.id }, 'tab-closed')
      })
    })

    // The last of R11, and the only one that is about the program rather than about a view or a
    // window: a preview must not be the last thing a document is left holding on the way out.
    app.on('before-quit', () => {
      this.#abort({ of: 'program' }, 'app-quit')
    })
  }

  /**
   * Puts one view into picker mode, or says what stopped it.
   *
   * Called by all three entries — the page's context menu, the keyboard route through
   * `picker:start`, and the blocker menu — and every one of them gets the same answer, because the
   * precondition is `pickerStep`'s rather than each caller's. A refusal is *reported*: the bar goes
   * up in its outcome mode naming what is wrong with this document, which is the whole of F5. The
   * boolean is for the caller that has a return value to fill in.
   */
  start(webContentsId: number): boolean {
    const view = webContents.fromId(webContentsId)
    if (view === undefined || view.isDestroyed()) return false
    const host = this.#options.hostFor(webContentsId)
    // No window or no tile means nowhere to draw the bar, and a picker whose answers cannot be shown
    // is the silence this feature is being rebuilt to remove.
    if (host === null) return false
    /*
      Declined outright while something with a stronger claim holds the layer, and asked before
      anything happens — `FindController.open`'s rule, for its reason. Presenting can be refused by a
      consent dialogue, and the refusal is silent; start the session first and a page would be
      carrying a highlight and a preview with nothing on screen to explain either, because a surface
      that was never presented never departs and so is never announced.
    */
    if (!mayPresentOver('picker-bar', host.overlayPresentation())) return false

    sequence += 1
    const sessionId = `picker-${String(sequence)}`
    const pickable = pickableDocument(view.getURL(), this.#options.getSettings())
    const result = pickerStep(this.#session, {
      ask: 'start',
      sessionId,
      viewId: webContentsId,
      windowId: host.windowId,
      host: pickable.host,
      filterable: pickable.filterable
    })

    // Whatever was running ends first, in whatever window — including when this start is about to be
    // refused. An old session must not survive a refusal that has nothing to do with it.
    this.#release(result.did === 'started' || result.did === 'refused' ? result.displaced : null)
    /*
      And whatever an *ended* attempt left on screen goes too, which the line above cannot do.

      An attempt that finished with an answer — saved, refused, already there — is over, so it is not
      displaced and `#release` has nothing to end; but its bar is still up, naming the outcome and
      offering Close and Undo. Once the record below names the new attempt, every press on that bar
      names one the core no longer holds and is refused, Escape included, and the vacancy it would
      announce on leaving is ignored for the same reason: a surface nothing can take down.

      The record is dropped *before* the dismissal, `#overlayVacated`'s order for its reason: the
      departure is announced synchronously, and it must find no attempt to abort.

      Only in another window. In the same one the new presentation replaces the old bar in place — a
      picker bar is named by its session, so the layer treats it as a new surface and announces the
      old one's departure, which the new record ignores. Taking it down first there would hand focus
      to the chrome and straight back, a keystroke's worth of interference for nothing on screen.
    */
    const previous = this.#attempt
    this.#attempt = null
    if (previous !== null && previous.host.windowId !== host.windowId) {
      previous.host.dismissOverlayKind('picker-bar')
    }
    this.#attempt = { sessionId, host, hovered: '', written: null }

    if (result.did === 'refused') {
      this.#session = null
      this.#present(null, result.outcome)
      return false
    }
    if (result.did !== 'started') {
      // `pickerStep` answers a start with one of the two above and nothing else; this is the shape
      // of the union rather than a case, and it leaves no session behind if that ever changes.
      this.#attempt = null
      return false
    }

    this.#session = result.session
    view.send(PICKER_START_CHANNEL, { ...this.#options.chrome(), sessionId })
    this.#present(result.session, null)
    return true
  }

  /** The contract channel's way out, which is an abort like every other. */
  stop(webContentsId: number): void {
    this.#abort({ of: 'view', viewId: webContentsId }, 'cancelled')
  }

  /**
   * One word from the confirmation bar, resolved against the core's own state.
   *
   * The message carries an intention and a session and nothing else — no selector, no rule text —
   * so a renderer cannot choose what gets written. `false` means nothing happened, which is an
   * ordinary answer here: the ways a session ends are mostly not clicks, and a press that raced one
   * of them has arrived for an attempt that is over.
   */
  barAction(sessionId: string, action: PickerBarAction): boolean {
    const attempt = this.#attempt
    if (attempt?.sessionId !== sessionId) return false
    switch (action) {
      case 'cancel':
        // Through the layer, not through the session: the departure is what lifts the preview, and
        // routing Cancel anywhere else would be a second way out for the one thing that must have
        // exactly one.
        return attempt.host.dismissOverlayKind('picker-bar')
      case 'widen':
        return this.#move('widen')
      case 'narrow':
        return this.#move('narrow')
      case 'confirm':
        return this.#confirm()
      case 'undo':
        return this.#undo(attempt)
      case 'open-rules':
        attempt.host.openRules()
        attempt.host.dismissOverlayKind('picker-bar')
        return true
    }
  }

  // --- messages from the page ------------------------------------------------

  #propose(contents: WebContents, reported: unknown): unknown {
    const session = this.#liveIn(contents.id)
    if (session?.state !== 'showing') return null
    const target = asElementDescription(reported)
    if (target === null) return null
    /*
      The estimate is taken against the target alone rather than against a survey of the page.

      Sending every element on every hover would be the whole document across a process boundary many
      times a second. What that costs is precision in `estimatedMatches` — it counts the target and
      whatever else the description contains — and it costs nothing after the click, where the count
      on screen is the page's own `querySelectorAll` (R9).
    */
    const proposal = proposeSelector({ target, page: [target] })

    /*
      The bar names what the pointer is over, and is re-presented only when that changes.

      `mouseover` fires when the pointer enters a different element rather than on every pixel, so
      this is a handful of updates per gesture — but presenting focuses the layer's renderer
      (`takesFocus`), and re-presenting an unchanged bar would be a keystroke's worth of interference
      for no change on screen. The find bar guards its own count updates the same way.
    */
    const attempt = this.#attempt
    if (attempt !== null && attempt.hovered !== proposal.selector) {
      attempt.hovered = proposal.selector
      this.#present(session, null)
    }
    return proposal
  }

  #freeze(contents: WebContents, reported: unknown): void {
    const report = asPickerFreezeReport(reported)
    if (report === null) return
    const session = this.#liveIn(contents.id)
    if (session?.sessionId !== report.sessionId) return
    const result = this.#step({
      ask: 'freeze',
      at: { of: 'view', viewId: contents.id },
      chain: report.chain
    })
    if (result.did !== 'changed') return
    this.#applySelection(result.session)
  }

  #measured(contents: WebContents, reported: unknown): void {
    const measurement = asPickerMeasurement(reported)
    if (measurement === null) return
    const session = this.#liveIn(contents.id)
    if (session?.sessionId !== measurement.sessionId) return
    this.#stopWaiting()
    this.#step({
      ask: 'measured',
      at: { of: 'view', viewId: contents.id },
      matches: measurement.matches,
      visible: measurement.visible
    })
  }

  #escaped(contents: WebContents, reported: unknown): void {
    const escape = asPickerEscape(reported)
    if (escape === null) return
    const session = this.#liveIn(contents.id)
    if (session?.sessionId !== escape.sessionId) return
    this.#abort({ of: 'view', viewId: contents.id }, 'escaped')
  }

  // --- the bar's five decisions ----------------------------------------------

  #move(ask: 'widen' | 'narrow'): boolean {
    const session = this.#session
    if (session === null) return false
    const result = this.#step({ ask, at: { of: 'window', windowId: session.windowId } })
    if (result.did !== 'changed') return false
    this.#applySelection(result.session)
    return true
  }

  #confirm(): boolean {
    const session = this.#session
    if (session === null) return false
    const result = this.#step({ ask: 'confirm', at: { of: 'window', windowId: session.windowId } })
    // Ignored for a second press: writing and measuring are two round trips, and the press that
    // would write a second rule arrives before the first answer does. The guard is the machine's,
    // not the bar's.
    if (result.did !== 'changed') return false
    this.#present(result.session, null)
    this.#write(result.session)
    return true
  }

  #undo(attempt: PickerAttempt): boolean {
    const written = attempt.written
    // Only a rule this attempt wrote. The two duplicate outcomes name a rule that was already there
    // and that this attempt did not create, and a button that deleted one of those would be removing
    // something the user wrote on another day and has not asked about.
    if (written === null) return false
    // Through the same mode-bound editor that wrote it, so a private window takes back its own rule
    // and leaves the stored set alone. The removal re-serves every open view, which is what makes
    // the element come back without a reload (AE14).
    if (!written.editor.remove(written.ruleId)) return false
    attempt.written = null
    attempt.host.dismissOverlayKind('picker-bar')
    return true
  }

  /**
   * The write, and the order that follows it.
   *
   * R13 in four lines, and the first of them is the one the whole requirement is about: the preview
   * comes off *before* anything is measured. Left on, the measurement would find the element hidden
   * by the provisional rule and report success whatever the stored rule does — which is precisely the
   * claim this feature was reported for making.
   *
   * Re-loading and re-delivering are not called here and that is deliberate: `editor.add` notifies
   * its listeners synchronously, and those listeners are where the engine is re-compiled and every
   * open view re-served (`index.ts`). A second delivery from this file would be a second mechanism
   * for the one thing that must have exactly one.
   */
  #write(session: PickerSession): void {
    const chosen = selectedCandidate(session)
    const editor = this.#options.editorFor(session.viewId)
    if (chosen === null || editor === null) {
      // The view left its window between the press and this line. Nothing was written and nothing
      // can be, so the attempt ends rather than borrowing an outcome from the rule model that the
      // rule model never gave.
      this.#abort({ of: 'view', viewId: session.viewId }, 'tab-closed')
      return
    }

    const written = editor.add({
      text: cosmeticRuleFor(session.host, chosen.proposal.selector),
      origin: 'picker'
    })
    const result = this.#step({ ask: 'written', at: { of: 'program' }, outcome: written.outcome })
    // Anything but `added` is final and has already ended the attempt with its own name: refused by
    // the parser, already there, already there and switched off, or no room left.
    if (result.did !== 'changed') return

    // Remembered before the bar is told, because "there is something to take back" is one of the
    // fields it is told. `rule` is filled for `added`, which is the only outcome that reaches here.
    const attempt = this.#attempt
    if (attempt !== null && written.rule !== null) {
      attempt.written = { ruleId: written.rule.id, editor }
    }
    this.#options.preview(session.viewId, null)
    this.#present(result.session, null)
    this.#requestMeasurement(result.session, chosen.proposal.selector)
  }

  #requestMeasurement(session: PickerSession, selector: string): void {
    this.#send(session.viewId, PICKER_MEASURE_CHANNEL, {
      sessionId: session.sessionId,
      selector
    })
    this.#stopWaiting()
    this.#deadline = setTimeout(() => {
      this.#deadline = null
      /*
        Only for the session it was armed for. Every end clears this, so a timer that fires for another
        session is one that an end missed — and the step below is addressed to a *view*, which a new
        session in the same tab satisfies. Answered there, it would report "no answer came" to an
        attempt whose page has not been asked yet.
      */
      if (this.#session?.sessionId !== session.sessionId) return
      // No answer is coming. Reported as a measurement of nothing rather than as an error, because
      // that is what the session makes of it: stored, and no effect observed here.
      this.#step({
        ask: 'measured',
        at: { of: 'view', viewId: session.viewId },
        matches: 0,
        visible: 0
      })
    }, this.#options.measureTimeoutMs ?? MEASURE_DEADLINE_MS)
  }

  // --- the machine, and the effects of a step --------------------------------

  #step(event: PickerEvent): PickerStepResult {
    const result = pickerStep(this.#session, event)
    if (result.did === 'changed') this.#session = result.session
    if (result.did === 'ended') this.#end(result.ended, result.outcome)
    return result
  }

  #abort(at: PickerScope, reason: PickerAbortReason): void {
    this.#step({ ask: 'abort', at, reason })
  }

  /**
   * Over. The preview comes off the page, the page's own picker is told, and the bar either names
   * the outcome or leaves.
   *
   * The record is updated before anything is dismissed, and the order is load-bearing:
   * `dismissOverlayKind` announces the departure synchronously, and a session still recorded as
   * running would then be ended a second time by its own bar leaving.
   */
  #end(ended: PickerSession, outcome: PickerOutcome | null): void {
    this.#session = ended
    this.#clear(ended)
    if (outcome !== null) {
      this.#present(ended, outcome)
      return
    }
    // Abandoned rather than answered — cancelled, navigated away from, displaced. There is nothing
    // to report, so the layer holds nothing and the attempt's record goes with it.
    const attempt = this.#attempt
    this.#attempt = null
    attempt?.host.dismissOverlayKind('picker-bar')
  }

  /** A start displaced whatever was running, possibly in another window. Same ending, no bar. */
  #release(displaced: PickerSession | null): void {
    if (displaced === null) return
    this.#end(displaced, null)
  }

  #clear(session: PickerSession): void {
    this.#stopWaiting()
    // Unconditional, including for a session that never froze anything: one call, one state of the
    // page, and no branch here about whether there was something to lift.
    this.#options.preview(session.viewId, null)
    this.#send(session.viewId, PICKER_STOP_CHANNEL, undefined)
  }

  #stopWaiting(): void {
    if (this.#deadline === null) return
    clearTimeout(this.#deadline)
    this.#deadline = null
  }

  /** A correction, applied to all three of the places that have to agree about it. */
  #applySelection(session: PickerSession): void {
    const chosen = selectedCandidate(session)
    if (chosen === null || session.selection === null) return
    this.#options.preview(session.viewId, cosmeticRuleFor(session.host, chosen.proposal.selector))
    this.#send(session.viewId, PICKER_SELECT_CHANNEL, {
      sessionId: session.sessionId,
      index: session.selection.index
    })
    this.#present(session, null)
  }

  #present(session: PickerSession | null, outcome: PickerOutcome | null): void {
    const attempt = this.#attempt
    if (attempt === null) return
    const presentation = pickerBarPresentation({
      session,
      sessionId: attempt.sessionId,
      hovered: attempt.hovered,
      outcome,
      canUndo: attempt.written !== null,
      locale: this.#options.locale(),
      place: {
        tabId: attempt.host.tabId,
        tileIndex: attempt.host.tileIndex,
        tileRect: attempt.host.tileRect()
      }
    })
    // Nothing to show: an abandoned attempt, or a tile too small to hold a bar. An invisible surface
    // would be worse than none — it would hold the layer against everything else.
    if (presentation === null) {
      attempt.host.dismissOverlayKind('picker-bar')
      return
    }
    attempt.host.presentOverlay(presentation)
  }

  #overlayVacated(presentation: OverlayPresentation, reason: OverlayVacancyReason): void {
    if (presentation.kind !== 'picker-bar') return
    const attempt = this.#attempt
    if (attempt?.sessionId !== presentation.sessionId) return
    /*
      The record goes before the abort.

      The bar has left, so nothing can be pressed on it any more — including Undo, whose rule id this
      record is the only holder of. Dropping it first is also what keeps `#end` from trying to take
      down a surface that has already gone. It no longer strands the measurement deadline, which is not
      on the record (see `#deadline`): the abort's `#clear` finds it without one.
    */
    this.#attempt = null
    this.#abort({ of: 'window', windowId: attempt.host.windowId }, vacancyAbortReason(reason))
  }

  // --- plumbing --------------------------------------------------------------

  /** The session, if there is a live one and it is this view's. The whole of the privilege check. */
  #liveIn(webContentsId: number): PickerSession | null {
    const session = this.#session
    if (session === null || session.state === 'ended') return null
    return session.viewId === webContentsId ? session : null
  }

  #send(webContentsId: number, channel: string, payload: unknown): void {
    const view = webContents.fromId(webContentsId)
    if (view === undefined || view.isDestroyed()) return
    view.send(channel, payload)
  }
}
