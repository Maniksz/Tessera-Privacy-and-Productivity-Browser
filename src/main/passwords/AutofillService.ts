import type { Locale } from '@shared/i18n/catalog.js'
import { registrableDomainOfUrl } from '@shared/url/domain.js'
import { chooseFillTargets, type FormDescriptor } from '@shared/passwords/fields.js'
import { decideFill, fillableSubjects, type FillContext } from '@shared/passwords/fill-policy.js'
import { isFillGestureInput } from '@shared/passwords/gesture.js'
import {
  passwordOriginOf,
  resolveSubmittedUsername,
  type BrowsingMode,
  type PasswordSummary,
  type PasswordWriter,
  type SaveCredentialInput
} from '@shared/passwords/model.js'
import { decideSaveOffer, type StoredCredentialState } from '@shared/passwords/save-policy.js'
import {
  AUTOFILL_SAVE_PROMPT_CHANNEL,
  asFillRequest,
  asFormDescriptor,
  asSaveAnswer,
  asSubmissionReport,
  type FillAnswer,
  type FillOffer
} from '@shared/passwords/wire.js'
import { fillChromeFor, saveBarChromeFor } from './chrome.js'

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
 * ## What happens while the vault is locked, and why nothing is drawn in the page
 *
 * Everything below refuses: no suggestion list, no fill, no save bar. `null` rather than a list with
 * an "unlock to fill" row in it, and that is the decision worth defending, because the row is the
 * obvious design and it is wrong twice over.
 *
 * A page can focus a field whenever it likes, so an unlock affordance drawn on focus is *a prompt on
 * page load* wearing different clothes — the exact thing that must not happen, since a prompt that
 * appears unbidden is a prompt people dismiss without reading. Worse, it would be an unlock prompt
 * inside the page's own document, and a user cannot tell our closed shadow root from a `<div>` the site
 * drew to look like it. That makes the master password — the one secret whose loss costs every other
 * one — phishable by any page that can guess what our panel looks like.
 *
 * So the master password is never typed into anything inside a page. The way back is browser chrome a
 * page cannot draw: `tessera://passwords`, whose address bar the page does not control, and a
 * chrome-side prompt raised by a menu item or a keyboard shortcut. `shared/passwords/reveal.ts`
 * predicted that "autofill asks for the master password on the first fill after a lock"; the intent is
 * kept and the *asker* is moved out of the page, which is a deliberate departure from that sentence.
 *
 * The cost, stated: while locked, autofill is silent, and a user who has forgotten they set a master
 * password will think the feature is broken. That is why `PasswordVault` never idle-locks a vault with
 * no master password, so the silence only ever follows a choice the user made.
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
 * passwords, so the offer path is structurally unable to hold one while it is still deciding
 * whether it is allowed to.
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
  readonly #pending = new Map<number, PendingSave>()

  constructor(options: AutofillServiceOptions) {
    this.#options = options
  }

  /** Records a real input event. Called for every `input-event`; most are not gestures. */
  noteInput(viewId: number, input: unknown): void {
    if (!isFillGestureInput(input)) return
    this.#lastGestureAt.set(viewId, this.#options.now())
  }

  /**
   * What could be filled into this form, or `null`.
   *
   * `null` rather than an empty offer, so the preload has one thing to check and cannot draw an
   * empty suggestion list — which would tell a page that the user has *no* credential for it,
   * which is itself a small fact about the user.
   *
   * The offer carries usernames and no passwords. That is not an optimisation: a focus event is
   * something a page can cause at will, so this is the one message on these channels that an
   * attacker can make fire repeatedly, and it has to be worthless when it does.
   */
  offerFor(view: AutofillView, frame: AutofillFrame, reported: unknown): FillOffer | null {
    // First, and before the form is even looked at. A locked vault has no summaries to offer — they
    // are inside the sealed document — so this is a statement of fact rather than a policy, and it
    // means the busiest page-triggerable path in the feature does nothing at all while locked.
    if (!this.#options.vault.isUnlocked()) return null
    const mode = this.#options.modeFor(view.id)
    if (mode === null) return null
    const form = asFormDescriptor(reported)
    if (form === null) return null

    const context = this.#fillContext(view.id, frame, form)
    const fillable = fillableSubjects(context, this.#options.vault.list())
    const [first] = fillable
    if (first === undefined) return null

    const site = registrableDomainOfUrl(frame.url)
    // Reached only when a fill was authorised, and a fill needs a site — so `site` cannot be null
    // here. Guarded rather than asserted because the alternative is a heading reading "undefined".
    if (site === null) return null

    return {
      entries: fillable.map((summary) => ({ id: summary.id, username: summary.username })),
      chrome: fillChromeFor(this.#options.locale(), site)
    }
  }

  /**
   * The credential the user picked, or `null`.
   *
   * Every rule is applied again here, against the form as it is *now*. The offer is not a token
   * that can be spent later: a page that moved the form into a frame, changed its action, or
   * navigated between the suggestion appearing and the click gets a refusal, and so does a
   * renderer that invented an id it was never offered.
   */
  fillFor(view: AutofillView, frame: AutofillFrame, reported: unknown): FillAnswer | null {
    // Checked again here rather than trusted from the offer. The vault can lock between a suggestion
    // being drawn and a click on it — an idle timeout is a clock, not an event the page waits for —
    // and the offer is never a token that can be spent later.
    if (!this.#options.vault.isUnlocked()) return null
    const mode = this.#options.modeFor(view.id)
    if (mode === null) return null
    const request = asFillRequest(reported)
    if (request === null) return null

    const summary = this.#options.vault.summaryOf(request.id)
    if (summary === null) return null

    const context = this.#fillContext(view.id, frame, request.form)
    if (!decideFill(context, summary).allowed) return null

    const password = this.#options.vault.secretOf(request.id)
    if (password === null) return null

    // Through the mode-bound writer, so a private window fills without recording that it did.
    this.#options.vault.writerFor(mode).noteUsed(request.id)
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
    if (!this.#options.vault.isUnlocked()) return
    const mode = this.#options.modeFor(view.id)
    if (mode === null) return
    const report = asSubmissionReport(reported)
    if (report === null) return
    const origin = passwordOriginOf(frame.url)
    if (origin === null) return

    const username = resolveSubmittedUsername(
      this.#options.vault.list(),
      origin,
      report.username
    )
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
    this.#lastGestureAt.delete(viewId)
    this.#pending.delete(viewId)
  }

  /**
   * Drops every submitted credential waiting for an answer. Wired to `PasswordVault.onLock`.
   *
   * Without it a lock would be a half-truth: the key would be gone from the vault while a password the
   * user typed two minutes ago sat in this map for the rest of its two minutes. The gesture timestamps
   * are deliberately left alone — they are a record of input, not a secret, and clearing them would
   * make the next legitimate fill refuse for `no-user-gesture` right after an unlock.
   */
  dropPendingSaves(): void {
    this.#pending.clear()
  }

  /** Whether a save bar is waiting on this view. For tests and diagnostics, never for a decision. */
  hasPendingSave(viewId: number): boolean {
    return this.#pending.has(viewId)
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
    return {
      frameUrl: frame.url,
      topLevelUrl: frame.topLevelUrl,
      isTopLevelFrame: frame.isTopLevel,
      formAction: form.action,
      lastGestureAt: this.#lastGestureAt.get(viewId) ?? null,
      now: this.#options.now(),
      hasFillablePasswordField: chooseFillTargets(form) !== null
    }
  }
}
