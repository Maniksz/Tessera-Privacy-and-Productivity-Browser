import { randomUUID } from 'node:crypto'
import type { Locale } from '@shared/i18n/catalog.js'
import type { AutofillSuggestContent } from '@shared/overlay/surface.js'
import { registrableDomainOfUrl } from '@shared/url/domain.js'
import { consentFor } from '@shared/passwords/consent.js'
import { chooseFillTargets, type FormDescriptor } from '@shared/passwords/fields.js'
import {
  countPageMatches,
  decideFill,
  fillableSubjects,
  type FillContext
} from '@shared/passwords/fill-policy.js'
import { isFillGestureInput } from '@shared/passwords/gesture.js'
import {
  passwordOriginOf,
  resolveSubmittedUsername,
  type AutofillKeyState,
  type BrowsingMode,
  type PasswordSummary,
  type PasswordWriter,
  type SaveCredentialInput
} from '@shared/passwords/model.js'
import { decideSaveOffer, type StoredCredentialState } from '@shared/passwords/save-policy.js'
import {
  AUTOFILL_BADGE_CHANNEL,
  AUTOFILL_SAVE_PROMPT_CHANNEL,
  asFillRequest,
  asSaveAnswer,
  asSubmissionReport,
  type FillAnswer
} from '@shared/passwords/wire.js'
import { badgeChromeFor, saveBarChromeFor } from './chrome.js'

/**
 * Autofill's core half: what may be offered, what may be filled, and what may be saved.
 *
 * ## Why this class knows nothing about Electron
 *
 * Every fact it needs about a view arrives as a plain value, and the subscription that produces
 * those values lives in `install-autofill.ts`. That is not tidiness: it is what makes "a framed
 * login page is not filled" and "a private window does not offer to save" unit tests instead of
 * things only a running browser can be asked. This is the most security-sensitive decision path in
 * the project, and a decision path exercised only by hand is one nobody has checked.
 *
 * ## Why the frame facts come from the core and never from the message
 *
 * `AutofillFrame` is built from Electron's frame tree — `event.senderFrame.url`, `.top`, `.parent`
 * — not from anything the renderer said about itself. A compromised renderer is exactly the case
 * where the preload's account of where it is cannot be trusted, so the address, the frame's depth
 * and the browsing mode are all read on this side. What *must* come from the renderer is the shape
 * of the form, because only the renderer can see the DOM; every field of it is length-capped and
 * type-checked in `wire.ts` before it is looked at.
 *
 * ## Where a password is, and for how long
 *
 * Two places, both narrow. `fillFor` fetches one secret after the decision has already been made
 * and hands it straight back. `#pending` holds one submitted credential per view while the save bar
 * is up, for at most `PENDING_SAVE_TTL_MS`, because the sign-in that produced it usually navigates
 * and the bar has to survive that navigation to be asked at all. Both are stated rather than
 * discovered; the second is the one weakness of this design that cannot be removed without
 * removing the save prompt.
 *
 * ## What happens while the vault is locked, and where the answer is drawn
 *
 * Nothing is filled and nothing is offered to save. What the user gets instead is a sentence — "the
 * vault is locked" — and a button, and the whole decision is *where those are drawn*.
 *
 * Not in the page. A page can focus a field whenever it likes, so an unlock affordance drawn on
 * focus is a prompt on page load wearing different clothes; and a user cannot tell our closed shadow
 * root from a `<div>` the site drew to look like it, which would make the master password — the one
 * secret whose loss costs every other one — phishable by any page that can guess what our panel
 * looks like.
 *
 * So it is drawn on the overlay layer, which no page can read or imitate into, and it appears only
 * after a press on the badge that the browser process itself saw. Even then it is not the
 * master-password prompt: it is a notice with an Unlock button, and pressing *that* — an action in
 * browser chrome — is what raises the prompt (R9). Without that step the highest-ranked surface in
 * the program would be raisable by a message from a page view.
 *
 * `shared/passwords/reveal.ts` predicted that "autofill asks for the master password on the first
 * fill after a lock"; the intent is kept and the *asker* is moved two steps out of the page, which is
 * a deliberate departure from that sentence.
 */

/** The frame a message came from, as the core reads it. Never as the renderer describes it. */
export interface AutofillFrame {
  readonly url: string
  readonly isTopLevel: boolean
  /** `null` when the frame tree could not be read — a frame torn down mid-message. */
  readonly topLevelUrl: string | null
}

/** The slice of a `WebContents` this service uses. Electron's own object satisfies it. */
export interface AutofillView {
  readonly id: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
}

/**
 * The slice of `PasswordStore` autofill touches.
 *
 * Written out rather than importing the class, for the reason `SafeStorageLike` exists: a test
 * supplies a fake vault and exercises the real decision paths. It also documents the surface — and
 * the absence in it is the point. There is no method here that returns the collection *with*
 * passwords, so the path that builds the account picker is structurally unable to hold one while it
 * is still deciding whether it is allowed to.
 */
export interface AutofillVault {
  /**
   * Whether the vault is open at all.
   *
   * On this interface rather than derived from an empty `list()`, and the difference is a bug that
   * would otherwise be shipped. A locked vault answers `[]` to `list()` and `'none'` to
   * `compareStored`, which reads to `decideSaveOffer` as "a site with no stored credential" — so the
   * save bar would go up on every sign-in while locked, the user would press Save, and
   * `discardingPasswordWriter` would drop it. A prompt that appears, is answered, and does nothing is
   * worse than no prompt: it teaches people that this browser's questions do not matter.
   *
   * So the state is asked about explicitly. See `PasswordVault`.
   */
  isUnlocked(): boolean
  list(): PasswordSummary[]
  summaryOf(id: string): PasswordSummary | null
  secretOf(id: string): string | null
  neverSavedOrigins(): string[]
  compareStored(url: string, username: string, password: string): StoredCredentialState
  writerFor(mode: BrowsingMode): PasswordWriter
}

export interface AutofillServiceOptions {
  readonly vault: AutofillVault
  /**
   * Whether the user wants any of this. `passwords.autofill`.
   *
   * Read per call rather than captured, so switching it off reaches the form already on screen —
   * spec 5's promise, and here it is the one that matters most: somebody turning this off is usually
   * turning it off *because* of the page in front of them.
   *
   * Checked at the four ways in — the badge's report, the picker, the fill and a submission —
   * rather than at one central point,
   * because there is no central point: the three arrive on their own channels from a preload that
   * knows nothing about settings. Gating them all is what makes "off" mean off rather than "off
   * unless the page asks a different way".
   */
  readonly enabled: () => boolean
  /**
   * The browsing mode of the window a view belongs to, or `null` when it belongs to none.
   *
   * `null` refuses everything. A view this browser cannot place — a devtools window, something
   * being torn down — is not a tab of ours, and the default for anything unaccounted for has to be
   * "no". Refusing to *fill* there costs a user nothing they will notice; guessing would put a
   * credential into a document nobody can name.
   */
  readonly modeFor: (viewId: number) => BrowsingMode | null
  /** Read per call, so a language change reaches the next form rather than the next restart. */
  readonly locale: () => Locale
  readonly now: () => number
}

/**
 * How long a submitted credential waits for an answer.
 *
 * Two minutes, and the number is a compromise with an honest cost. A sign-in normally navigates,
 * often through a redirect or two, and the bar has to be asked on the page the user lands on — so
 * the credential must outlive the navigation. It is held in main-process memory for that window
 * and dropped as soon as the user answers, the origin changes, or the time runs out.
 */
export const PENDING_SAVE_TTL_MS = 120_000

/**
 * One submitted credential awaiting an answer.
 *
 * `origin` rather than only `url`, because it is what the bar's survival is keyed on: a redirect
 * inside the site keeps the offer, a move to another site drops it. Filing the eventual save under
 * the origin recorded *here* rather than wherever the view ended up is what stops a redirect chain
 * from parking the credential on the wrong site.
 */
interface PendingSave {
  readonly origin: string
  readonly url: string
  readonly username: string
  readonly password: string
  readonly kind: 'create' | 'update'
  readonly at: number
  /**
   * How many times the bar may still be put up: once now, once on the page the sign-in lands on.
   *
   * Bounded because `dom-ready` fires per document, and a page that reloads itself in a loop would
   * otherwise raise the same question for ever — which is how a prompt teaches people to dismiss
   * prompts without reading them.
   */
  promptsLeft: number
}

export class AutofillService {
  readonly #options: AutofillServiceOptions
  /**
   * When the core last saw a real input event in a view.
   *
   * Keyed by web-contents id and removed when the view goes. This is the whole of the gesture
   * story: the renderer never gets to claim a gesture, because the number it would have to lie
   * about lives here. See `gesture.ts`.
   */
  readonly #lastGestureAt = new Map<number, number>()
  /**
   * The chrome-side fill request open for a view, at most one, keyed by web-contents id.
   *
   * This is the whole of the second consent source, and its narrowness *is* the security property:
   * an entry here means the user asked for a fill from browser chrome for this view and has not yet
   * been served. It is written only by `noteChromeRequest`, which no message from a page can reach,
   * and it is removed by the first authorised fill and by every one of the five events that end the
   * request — see `consent.ts`. While it exists, `no-user-gesture` is satisfied for this view, so
   * anything that leaves it behind turns the rule off for that tab for good.
   */
  readonly #openRequest = new Map<number, string>()
  /**
   * The one-time proof of a choice, per view, and the entry it stands for.
   *
   * The page never learns an entry's id. It is handed a token instead, and this map is the only
   * place the two are ever associated — so the whole of what a captured token buys is the one
   * credential the user chose, once, on the document that was in front of them. It is burned on
   * redemption and dropped by every ending that drops a chrome request, because a token that
   * outlived its document would be spendable on whatever the next one contains.
   */
  readonly #fillToken = new Map<number, { readonly token: string; readonly entryId: string }>()
  readonly #pending = new Map<number, PendingSave>()
  /**
   * The views whose last report said a fillable password field has focus.
   *
   * Only ever a reason to *offer* a way in from browser chrome — the page context menu's item — never
   * a reason to fill: a page can make this true whenever it likes, and what it buys is a menu item
   * that opens the same picker, under the same rules, as the toolbar key.
   */
  readonly #fillable = new Set<number>()

  constructor(options: AutofillServiceOptions) {
    this.#options = options
  }

  /** Records a real input event. Called for every `input-event`; most are not gestures. */
  noteInput(viewId: number, input: unknown): void {
    if (!isFillGestureInput(input)) return
    this.#lastGestureAt.set(viewId, this.#options.now())
  }

  /**
   * A view reports whether the user is standing in a form that could be filled.
   *
   * Answers whether the core wants to hear this view's input events, and that answer is the whole
   * reason this message exists. Listening to `input-event` in every tab costs a main-process round
   * trip per mouse press for tabs that will never fill anything, so the subscription is attached on
   * demand — and until now the thing it was attached on demand *by* was a non-null offer, which
   * `decideFill` refused for want of the very gesture the listener was there to record. The feature
   * could not fill anything, and nothing failed. The gate has to be something a page can report
   * before any rule has been applied, and the shape of the form in front of the user is it.
   *
   * The report carries no form, no address and no answer: it is one boolean about whether a
   * fillable password field has focus, which is a fact the page already has. It is *not* consent —
   * `noteInput` is still the only thing that records one, and it is still fed only by the browser
   * process. A page that lies here buys itself an input listener and nothing else.
   */
  noteFillableForm(view: AutofillView, reported: unknown): boolean {
    // Before anything else: somebody who switched autofill off must not have their input events
    // reported to the main process at all, which is the cost this subscription carries.
    this.#fillable.delete(view.id)
    if (!this.#options.enabled()) return false
    if (reported !== true) return false
    this.#fillable.add(view.id)
    /*
      The badge's wording, in the same breath.

      This is the whole of what the page is told before the badge is pressed: a stylesheet and one
      translated label. It asks the vault nothing (AE2) and says nothing about it, which is what
      makes it safe to answer a message a page can cause at will.

      It is also the reason a badge is not drawn where the feature is switched off: the answer never
      arrives, so there is no control offering something that would not happen. The one press that
      *can* be answered with "switched off" is a badge already on screen when the setting changed —
      see `badgePressed`, and `enabled` above for why that case exists at all.
    */
    view.send(AUTOFILL_BADGE_CHANNEL, badgeChromeFor(this.#options.locale()))
    return true
  }

  /**
   * The user asked for a fill from browser chrome. Opens the one request this view may have.
   *
   * Called from the toolbar, the shortcut and the context menu — never from a message that arrived
   * from a page view. The id is the one the chrome surface was raised with, so the answer that comes
   * back can be matched to the question, and so `consentHolds` can refuse a consent for a request
   * that has since been closed.
   *
   * A second call replaces the first: one open request per view is the invariant, and two would mean
   * two live consents where the user made one gesture.
   */
  noteChromeRequest(viewId: number, requestId: string): void {
    this.#openRequest.set(viewId, requestId)
  }

  /**
   * Closes the open chrome request for a view, if there is one.
   *
   * Wired to every ending a request can have other than being served: the surface leaving the
   * overlay layer, the user dismissing it, the view's main frame navigating, the vault locking, and
   * the view going away. Each is its own call rather than one catch-all, because a consent left
   * open is `no-user-gesture` switched off for that tab.
   */
  dropChromeRequest(viewId: number): void {
    this.#openRequest.delete(viewId)
  }

  /** Whether this view's page last said a fillable password field has focus, with autofill on. */
  hasFillableFocus(viewId: number): boolean {
    return this.#fillable.has(viewId) && this.#options.enabled()
  }

  /**
   * What the toolbar key shows for the page at `pageUrl` (R10).
   *
   * The consent-free predicate and a domain match, never `decideFill` with a consent nobody gave
   * (KTD11): the key is drawn before there is a press, a form or a frame to decide about. So it is
   * optimistic, and it may be — the fill it leads to is decided in full when it happens.
   */
  keyState(pageUrl: string | null): AutofillKeyState {
    if (!this.#options.enabled()) return { vault: 'off', matches: 0 }
    if (!this.#options.vault.isUnlocked()) return { vault: 'locked', matches: 0 }
    const matches = pageUrl === null ? 0 : countPageMatches(pageUrl, this.#options.vault.list())
    return { vault: 'open', matches }
  }

  /** Whether a chrome-side fill request is open on this view. For tests and diagnostics. */
  hasChromeRequest(viewId: number): boolean {
    return this.#openRequest.has(viewId)
  }

  /**
   * The user pressed the badge. What the account picker should say, or `null` for "say nothing".
   *
   * `null` is the first of R8's two named exceptions and the only silent answer this method has: the
   * browser process saw no real input event in this view, so the press was not a person's. Answering
   * it would be an answer to the *page*, which is both a small leak and a way for any document to
   * put a surface on the overlay layer whenever it liked. A page that calls `.click()` on our badge
   * gets nothing at all (AE3).
   *
   * Deliberately a *page-input* consent and not any consent. A chrome request left open from an
   * earlier flow would otherwise satisfy this, and then one genuine press would license every forged
   * one after it for as long as the request stood.
   */
  badgePressed(
    view: AutofillView,
    frame: AutofillFrame,
    form: FormDescriptor
  ): AutofillSuggestContent | null {
    const seen = consentFor(
      // `openRequestId: null` on purpose: the only thing that may open this surface from a page view
      // is an input event the browser process dispatched into it.
      { lastGestureAt: this.#lastGestureAt.get(view.id) ?? null, openRequestId: null },
      this.#options.now()
    )
    if (seen === null) return null
    return this.suggestFor(view, frame, form)
  }

  /**
   * What the account picker should say for this view and this form.
   *
   * Reached from the badge once the press has been verified, and again after the user has unlocked
   * the vault — which is why the gesture check is *not* here: by then the consent is the chrome
   * request the Unlock button opened, and the person has spent half a minute typing a master
   * password, which no five-second window would have survived (KTD4).
   *
   * Every branch says something, because "nothing happened" is the answer a user cannot tell from a
   * broken browser (R8). The order is the product's, not the code's convenience: the setting first,
   * because switching it off should not produce a lecture about the page; then the page's own rules,
   * so an unencrypted page is named as such whatever the vault holds; then the vault.
   */
  suggestFor(
    view: AutofillView,
    frame: AutofillFrame,
    form: FormDescriptor
  ): AutofillSuggestContent | null {
    if (!this.#options.enabled()) return { state: 'disabled' }
    // A view this browser cannot place is not a tab of ours, and there is no tile to draw a list in.
    if (this.#options.modeFor(view.id) === null) return null

    const context = this.#fillContext(view.id, frame, form)
    /*
      The page as its own subject, which is one predicate rather than two.

      `decideFill` weighs two kinds of rule: those about the page in front of the user — a gesture, a
      password field, the scheme, the frame, the form's action — and those that compare a *stored*
      origin against it. Handing it the page's own address makes the second kind compare the page
      with itself, so what survives is exactly the first kind, with its reason intact (KTD6). The
      alternative was a second list of the same rules written out here, and `fill-policy.ts` says at
      length what happens to two predicates over time.
    */
    const page = decideFill(context, { origin: frame.url })
    if (!page.allowed) return { state: 'refused', reason: page.reason }

    // Asked after the page rules, and before the list: a locked vault has no summaries at all — they
    // are inside the sealed document — so an empty list here would read as "nothing saved for you".
    if (!this.#options.vault.isUnlocked()) return { state: 'locked' }

    const fillable = fillableSubjects(context, this.#options.vault.list())
    if (fillable.length === 0) return { state: 'empty' }
    return {
      state: 'entries',
      entries: fillable.map((summary) => ({ id: summary.id, username: summary.username }))
    }
  }

  /**
   * The user chose an entry. Mints the one-time proof the page redeems for it (KTD8).
   *
   * The entry's own id is deliberately not what travels: it is a durable reference, so a renderer
   * that kept one could ask for that credential again on a later document. A token is minted for one
   * choice, remembered here beside the id it stands for, and burned by the first redemption —
   * successful or not.
   *
   * One per view, replaced rather than accumulated. Two live tokens would mean two choices from one
   * list, and the list only ever asks once.
   */
  noteFillChoice(viewId: number, entryId: string): string {
    const token = randomUUID()
    this.#fillToken.set(viewId, { token, entryId })
    return token
  }

  /**
   * The credential the user picked, or `null`.
   *
   * Every rule is applied again here, against the form as it is *now*. The choice is not a licence
   * that can be spent later: a page that moved the form into a frame, changed its action, or
   * navigated between the list appearing and the click gets a refusal, and so does a renderer that
   * invented a token nobody minted.
   */
  fillFor(view: AutofillView, frame: AutofillFrame, reported: unknown): FillAnswer | null {
    // Both checked again here rather than trusted from the choice. The setting can be switched off
    // and the vault can lock between a list being drawn and a click on it — an idle timeout is a
    // clock, not an event the page waits for.
    if (!this.#options.enabled()) return null
    if (!this.#options.vault.isUnlocked()) return null
    const mode = this.#options.modeFor(view.id)
    if (mode === null) return null
    const request = asFillRequest(reported)
    if (request === null) return null

    /*
      Redeemed and burned in the same breath, before any rule is applied.

      Burned even when what follows refuses, and that is the difference between a one-time proof and
      a retry counter: a token that survived its own refusal would let a page ask again — from a
      subframe, with a rewritten action, after a navigation — until one of the attempts happened to
      pass. The user chose once, so there is one attempt.
    */
    const held = this.#fillToken.get(view.id)
    if (held?.token !== request.token) return null
    this.#fillToken.delete(view.id)

    const summary = this.#options.vault.summaryOf(held.entryId)
    if (summary === null) return null

    const context = this.#fillContext(view.id, frame, request.form)
    if (!decideFill(context, summary).allowed) return null

    /*
      Spent here, on the authorisation rather than on the answer.

      A chrome consent is good for one fill. Releasing it after the secret was fetched would leave it
      alive when the fetch fails — an entry deleted between the decision and the read — and a consent
      that survives its own refusal is one a page can retry against. A page-input gesture is
      deliberately *not* consumed: it is a record of input with a five-second life of its own, and
      spending it would refuse the second field of a two-step sign-in.
    */
    if (context.consent?.source === 'chrome-action') this.#openRequest.delete(view.id)

    const password = this.#options.vault.secretOf(held.entryId)
    if (password === null) return null

    // Through the mode-bound writer, so a private window fills without recording that it did.
    this.#options.vault.writerFor(mode).noteUsed(held.entryId)
    return { username: summary.username, password }
  }

  /**
   * A form carrying a password was submitted. Decides whether to ask about saving it.
   *
   * The vault is read here even in a private window, and that is deliberate rather than an
   * oversight: filling in a private window is allowed, so reading is too. Only writing is not, and
   * `decideSaveOffer` refuses a private window before anything can be written.
   *
   * A submission to a page whose form posts somewhere else is *not* refused, and the reason is
   * that refusing would protect nothing: the credential has already left. What does the protecting
   * is that the entry is filed under the origin of the page it was typed into — so a password
   * given to `phishing.example` is remembered for `phishing.example` and is never offered on the
   * site it was stolen from.
   */
  reportSubmission(view: AutofillView, frame: AutofillFrame, reported: unknown): void {
    /*
      The most important of the three locked refusals, and the one an emergent check would get wrong.

      `decideSaveOffer` would read a locked vault as "no stored credential, nothing on the never-here
      list" and answer `create` — so the bar would go up on every single sign-in and pressing Save
      would do nothing. It is also the only path here that arrives holding a password, so returning
      before `#pending` is written means the submitted credential is dropped on the spot instead of
      being kept in main-process memory against an unlock that may never come.
    */
    if (!this.#options.enabled()) return
    if (!this.#options.vault.isUnlocked()) return
    const mode = this.#options.modeFor(view.id)
    if (mode === null) return
    const report = asSubmissionReport(reported)
    if (report === null) return
    const origin = passwordOriginOf(frame.url)
    if (origin === null) return

    const username = resolveSubmittedUsername(this.#options.vault.list(), origin, report.username)
    const offer = decideSaveOffer({
      mode,
      frameUrl: frame.url,
      isTopLevelFrame: frame.isTopLevel,
      topLevelUrl: frame.topLevelUrl,
      // A length, never the value. See `save-policy.ts`.
      passwordLength: report.password.length,
      neverSaved: this.#options.vault.neverSavedOrigins(),
      existing: this.#options.vault.compareStored(frame.url, username, report.password)
    })
    if (offer.offer === 'none') return

    this.#pending.set(view.id, {
      origin,
      url: frame.url,
      username,
      password: report.password,
      kind: offer.offer,
      at: this.#options.now(),
      promptsLeft: 2
    })
    this.#prompt(view)
  }

  /**
   * A document finished loading. Re-raises a pending save if it belongs to this page.
   *
   * Without this the feature would never show its bar in the common case: a sign-in navigates, the
   * document the bar was drawn in is gone, and the question is never asked. The origin has to
   * match, so landing on a different site drops the offer instead of asking about it there.
   */
  documentReady(view: AutofillView, frame: AutofillFrame): void {
    const pending = this.#pending.get(view.id)
    if (pending === undefined) return
    if (this.#expired(pending)) {
      this.#pending.delete(view.id)
      return
    }
    if (passwordOriginOf(frame.url) !== pending.origin) {
      this.#pending.delete(view.id)
      return
    }
    this.#prompt(view)
  }

  /**
   * A navigation started. Drops a pending save that has left its site.
   *
   * Not every navigation, deliberately: the navigation a sign-in causes is the one the bar has to
   * survive. Only leaving the origin counts, which is also what the user would mean by "I have
   * moved on".
   */
  noteNavigation(viewId: number, url: string): void {
    /*
      The chrome request goes on *any* main-frame navigation, unlike the pending save.

      The two are held to different standards on purpose. A save bar has to survive the redirect a
      sign-in causes, because the question is about the page the user came from. A consent is about
      the document in front of the user right now: the form it was granted for is gone, and a
      consent that outlived its document would be spent on whatever the next one contains — which
      a page can choose. The unredeemed choice token goes in the same line and for the same reason.
    */
    this.#openRequest.delete(viewId)
    this.#fillToken.delete(viewId)
    const pending = this.#pending.get(viewId)
    if (pending === undefined) return
    if (passwordOriginOf(url) !== pending.origin) this.#pending.delete(viewId)
  }

  /**
   * What the user pressed on the save bar.
   *
   * The credential comes from `#pending`, not from the message, so the answer that crosses on a
   * click carries no secret — and a forged answer can at worst store a credential the user had
   * just typed into that very page, which is an unwanted row rather than a leak.
   *
   * Every answer clears the pending state, `dismiss` included. A bar that came back after being
   * dismissed would be worse than one that never appeared.
   */
  answerSave(view: AutofillView, reported: unknown): void {
    const pending = this.#pending.get(view.id)
    this.#pending.delete(view.id)
    const answer = asSaveAnswer(reported)
    if (pending === undefined || answer === null || answer === 'dismiss') return
    if (this.#expired(pending)) return
    /*
      The vault locked while the bar was up.

      The credential has already been deleted from `#pending` above, so this returns having dropped it.
      Not stored under a discarding writer and reported as saved, and not held until the next unlock:
      "the vault is closed" has to mean the same thing whether the closing happened before the question
      or during it.
    */
    if (!this.#options.vault.isUnlocked()) return

    const mode = this.#options.modeFor(view.id)
    if (mode === null) return
    const writer = this.#options.vault.writerFor(mode)

    if (answer === 'never') {
      writer.neverSaveFor(pending.url)
      return
    }
    const input: SaveCredentialInput = {
      url: pending.url,
      username: pending.username,
      password: pending.password
    }
    // The outcome is deliberately not reported back to the page. "Saved" or "rejected" is
    // information about the vault's contents, and the page is the least trustworthy audience for
    // it — the passwords tab is where the truth is visible.
    writer.save(input)
  }

  /** Drops everything held for a view. Called when it is destroyed. */
  forget(viewId: number): void {
    this.#fillable.delete(viewId)
    this.#lastGestureAt.delete(viewId)
    this.#openRequest.delete(viewId)
    this.#fillToken.delete(viewId)
    this.#pending.delete(viewId)
  }

  /**
   * What a lock means to the state held here. Wired to `PasswordVault.onLock`.
   *
   * Three things go. Every submitted credential waiting for an answer, because otherwise a lock would
   * be a half-truth: the key would be gone from the vault while a password the user typed two
   * minutes ago sat in this map for the rest of its two minutes. And every open chrome request,
   * because the fill it was granted for cannot be served from a sealed vault — leaving it would
   * carry consent across the unlock and let it be spent on a form the user never came back to. And
   * every unredeemed choice token, which is the same argument one step further along: the credential
   * it stands for cannot be read out of a sealed vault, so keeping it would only preserve a way to
   * ask again later.
   *
   * The gesture timestamps are deliberately left alone — they are a record of input, not a secret,
   * and clearing them would make the next legitimate fill refuse for `no-user-gesture` right after
   * an unlock.
   */
  dropPendingSaves(): void {
    this.#openRequest.clear()
    this.#fillToken.clear()
    this.#pending.clear()
  }

  /** Whether a save bar is waiting on this view. For tests and diagnostics, never for a decision. */
  hasPendingSave(viewId: number): boolean {
    return this.#pending.has(viewId)
  }

  /** A save bar or a chrome fill request is waiting on this view. Tab unloading keeps such a tab (U15). */
  waitsOn(viewId: number): boolean {
    return this.#pending.has(viewId) || this.#openRequest.has(viewId)
  }

  #prompt(view: AutofillView): void {
    const pending = this.#pending.get(view.id)
    if (pending === undefined || pending.promptsLeft <= 0) return
    if (view.isDestroyed()) return
    const site = registrableDomainOfUrl(pending.url)
    if (site === null) return
    pending.promptsLeft -= 1
    view.send(
      AUTOFILL_SAVE_PROMPT_CHANNEL,
      saveBarChromeFor({
        locale: this.#options.locale(),
        kind: pending.kind,
        site,
        username: pending.username
      })
    )
  }

  #expired(pending: PendingSave): boolean {
    const now = this.#options.now()
    // A timestamp in the future is a clock that moved, not a fresh submission.
    return now < pending.at || now - pending.at > PENDING_SAVE_TTL_MS
  }

  #fillContext(viewId: number, frame: AutofillFrame, form: FormDescriptor): FillContext {
    const now = this.#options.now()
    const openRequestId = this.#openRequest.get(viewId) ?? null
    return {
      frameUrl: frame.url,
      topLevelUrl: frame.topLevelUrl,
      isTopLevelFrame: frame.isTopLevel,
      formAction: form.action,
      // Both sources, weighed by the one function that knows what either is worth. Neither is built
      // from the message: the timestamp was taken by the core, the request was opened by the core.
      consent: consentFor(
        { lastGestureAt: this.#lastGestureAt.get(viewId) ?? null, openRequestId },
        now
      ),
      openRequestId,
      now,
      hasFillablePasswordField: chooseFillTargets(form) !== null
    }
  }
}
