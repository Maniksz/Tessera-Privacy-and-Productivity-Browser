import { randomUUID } from 'node:crypto'
import type { MasterPasswordPresentation, OverlayPresentation } from '@shared/overlay/surface.js'
import {
  boundedAppend,
  promptKeyAction,
  stepsFor,
  type MasterPasswordIntent,
  type MasterPasswordPromptProblem,
  type MasterPasswordPurpose,
  type MasterPasswordRequestOutcome,
  type MasterPasswordStep,
  type PromptAction,
  type PromptKey,
  type UnlockRequestOutcome
} from '@shared/passwords/prompt.js'
import {
  MIN_MASTER_PASSWORD_LENGTH,
  assessMasterPassword,
  vaultHasMasterPassword,
  type MasterPasswordOutcome,
  type UnlockOutcome,
  type VaultStatus
} from '@shared/passwords/vault.js'
import type { OverlayVacancyReason } from '../permissions/vacancy.js'

/**
 * Asks for the master password, checks it, and never lets it leave this process.
 *
 * ## The decision this class exists to implement
 *
 * A renderer must not be able to send a master password, and no channel may accept one. That rules
 * out every ordinary design: a field on the passwords page, a field in the chrome UI, a field on the
 * overlay layer whose value is read back — each of them ends with a renderer holding the one secret
 * whose loss costs all the others, and with a channel that has to be trusted to carry it.
 *
 * So the prompt is split against the grain. The **surface** is a display: it is told how many
 * characters have been typed and draws that many bullets (`MasterPasswordPresentation`). The
 * **characters** are read off the overlay view's own input pipeline in the main process and taken out
 * of it before the renderer is dispatched to — `OverlayLayer` does that for the kinds
 * `capturesKeyboard` names, and hands them here through `overlay-keys.ts`. This class is the only
 * subscriber, and it is the only place in the program where a master password is assembled.
 *
 * What that buys, precisely: there is no code path from a renderer to a master password, so a
 * compromised chrome renderer, a compromised overlay surface and a page that has somehow reached the
 * chrome bridge all fail to obtain one — not because a check refuses them but because there is
 * nothing to ask for. What it costs is written down in `shared/passwords/prompt.ts` and is not small:
 * no IME, no caret, no selection.
 *
 * ## Why the sequence is one question at a time
 *
 * There is one buffer, because there is one input pipeline. A three-field form would need a hand-built
 * focus model, three buffers and a way to move between them, all of it in the main process, all of it
 * between a person and their own vault. Asking `current`, then `new`, then `repeat` needs none of that.
 *
 * ## What is never revealed
 *
 * `UnlockRequestOutcome` is four words and none of them is about the vault's contents. In particular a
 * locked vault whose key file carries *no* master password does not get a prompt at all and does not
 * get a distinct answer: it is reopened and reported `unlocked`, because asking for a password that
 * would be checked against nothing is the theatre `reveal.ts` refuses. And a wrong candidate answers
 * `wrong-password` whether the vault holds one credential or five hundred — the status returned
 * alongside carries no count, by construction (`VaultStatus`).
 *
 * ## The weakness that remains, named
 *
 * The assembled candidate is a JavaScript string for as long as the derivation runs, and a string
 * cannot be overwritten. The buffer is an array of single characters precisely so that typing does not
 * strew prefixes of the password across the heap (see `boundedAppend`), and the arrays are emptied the
 * moment they are used — but the one joined copy is out of reach of anything this language offers.
 * `PasswordVault.#dropKey` makes the same admission about the vault key, where a `Uint8Array` at least
 * can be zeroed.
 */

/**
 * The window a prompt appears in.
 *
 * The two methods this uses, written out rather than importing `BrowserWindowController` — the reason
 * `PermissionHost` exists, and the reason "a departure with no answer settles as cancelled" is a test
 * rather than a claim.
 */
export interface MasterPasswordHost {
  presentOverlay(presentation: OverlayPresentation): void
  dismissOverlay(): void
}

/**
 * The slice of the vault this touches.
 *
 * Three of the four methods take or check a secret, which is why they are named here: this interface
 * *is* the list of places a master password goes, and it is four lines long.
 */
export interface MasterPasswordVault {
  status(): VaultStatus
  unlock(masterPassword: string): Promise<UnlockOutcome>
  /** Proof only: opens the stored key file with the candidate and drops the result. */
  verifyMasterPassword(candidate: string): Promise<boolean>
  setMasterPassword(request: {
    readonly current: string | null
    readonly next: string | null
  }): Promise<MasterPasswordOutcome>
}

export interface MasterPasswordPromptOptions {
  readonly vault: MasterPasswordVault
  /**
   * The system clipboard's text.
   *
   * Injected, and read in the main process: `clipboard.readText()` in the application. Paste has to
   * work — the length floor pushes people towards passphrases they keep somewhere else — and routing
   * it through the renderer would undo the whole point of this class for the one case where the
   * pasted text is most likely to be the real master password.
   */
  readonly readClipboard: () => string
  /** Injected so a test can name its requests; defaults to `randomUUID`. */
  readonly newRequestId?: () => string
}

/** One question sequence, on screen. */
interface Pending {
  readonly id: string
  readonly host: MasterPasswordHost
  readonly purpose: MasterPasswordPurpose
  readonly steps: readonly MasterPasswordStep[]
  index: number
  /** What has been typed for the question on screen. Characters, not a string; see `boundedAppend`. */
  buffer: string[]
  /** The proven current password, once a `current` step has passed. */
  current: string[] | null
  /** The proposed new one, once a `new` step has passed. */
  next: string[] | null
  problem: MasterPasswordPromptProblem | null
  /** Everything a `submit` has to wait for, so a second Return cannot start a second derivation. */
  busy: boolean
  settle(outcome: UnlockRequestOutcome | MasterPasswordRequestOutcome): void
}

export class MasterPasswordPrompt {
  readonly #vault: MasterPasswordVault
  readonly #readClipboard: () => string
  readonly #newRequestId: () => string
  /**
   * One question per window, keyed by request id.
   *
   * By id rather than by host because that is how an answer and a departure both arrive — naming the
   * surface, not the window. A `Map` of one entry in almost every case, and a `Map` rather than a
   * single field because two windows may each be asking.
   */
  readonly #pending = new Map<string, Pending>()

  constructor(options: MasterPasswordPromptOptions) {
    this.#vault = options.vault
    this.#readClipboard = options.readClipboard
    this.#newRequestId = options.newRequestId ?? ((): string => randomUUID())
  }

  /**
   * Opens the vault, asking for the master password if there is one to ask for.
   *
   * Three cases answer without a prompt, and each of them would be worse as a prompt:
   *
   *   - **Already open.** `unlocked`, at once. A dialogue here would ask for something that has already
   *     been proved.
   *   - **Unreadable.** `unreadable`. No password can open a key file whose wrapping is gone, and a
   *     field that cannot succeed is the definition of theatre — the passwords page has a panel that
   *     says what the way out is.
   *   - **Locked with no master password.** Reopened silently and reported `unlocked`. This is the
   *     state an explicit `passwords:lock` leaves a vault in when the user never set one, and the honest
   *     thing is to reopen it rather than to ask for a secret that would be checked against nothing.
   *     It is also the one case where an answer could have revealed something about the vault, and it
   *     deliberately shares its answer with the ordinary success.
   */
  async requestUnlock(host: MasterPasswordHost | null): Promise<UnlockRequestOutcome> {
    // Nowhere to draw it, so nobody can answer it. The same rule as `PermissionArbiter.ask`.
    if (host === null) return 'cancelled'
    const status = this.#vault.status()
    if (status.unlocked) return 'unlocked'
    if (status.unreadable) return 'unreadable'
    if (!vaultHasMasterPassword(status.protection)) {
      const outcome = await this.#vault.unlock('')
      return outcome === 'unreadable' ? 'unreadable' : 'unlocked'
    }
    return this.#ask<UnlockRequestOutcome>(host, 'unlock')
  }

  /**
   * Sets, changes or removes the master password.
   *
   * The *purpose* is derived from the vault's actual state rather than taken from the caller, and the
   * derivation always errs towards demanding proof: `set` on a vault that already has a master password
   * becomes `change`, so it asks for the existing one first. A caller that could turn `change` into
   * `set` would have found the one route to replacing the lock without opening it.
   */
  async requestMasterPassword(
    host: MasterPasswordHost | null,
    intent: MasterPasswordIntent
  ): Promise<MasterPasswordRequestOutcome> {
    if (host === null) return 'cancelled'
    const status = this.#vault.status()
    // The key is not in this process, so there is nothing to re-wrap. Unlock first.
    if (!status.unlocked) return 'locked'
    const hasMaster = vaultHasMasterPassword(status.protection)
    if (intent === 'remove') {
      if (!hasMaster) return 'not-protected'
      return this.#ask<MasterPasswordRequestOutcome>(host, 'remove')
    }
    return this.#ask<MasterPasswordRequestOutcome>(host, hasMaster ? 'change' : 'set')
  }

  /**
   * One keystroke, from `onOverlayKey`.
   *
   * Matched against the presentation the layer captured it for, so a keystroke can only ever reach the
   * question that was on screen when it was pressed. An id that names nothing is dropped: the prompt can
   * have been settled between the key press and this call, and the first settlement is the one that
   * counts.
   */
  key(presentation: OverlayPresentation, input: PromptKey): void {
    if (presentation.kind !== 'master-password') return
    const pending = this.#pending.get(presentation.requestId)
    if (pending === undefined) return

    const action = promptKeyAction(input)
    switch (action.kind) {
      case 'append':
        pending.buffer = boundedAppend(pending.buffer, action.text)
        break
      case 'paste':
        pending.buffer = boundedAppend(pending.buffer, this.#readClipboard())
        break
      case 'backspace':
        pending.buffer = pending.buffer.slice(0, -1)
        break
      case 'clear':
        pending.buffer = []
        break
      case 'submit':
        void this.#submit(pending)
        return
      case 'cancel':
        this.#finish(pending, 'cancelled')
        return
      case 'ignore':
        // Nothing changed, so nothing is re-sent. A presentation per ignored modifier key would be a
        // message per keystroke of every shortcut the user happens to try.
        return
    }
    /*
      A problem is cleared by typing, not by pressing Continue again.

      "That was not it" has to stop being on screen the moment the person starts a new attempt, or the
      refusal of the *previous* attempt sits above the one they are making now.
    */
    pending.problem = null
    this.#present(pending)
  }

  /**
   * Continue or Cancel, from `passwords:answerPrompt`.
   *
   * The mouse route. Every keyboard route is handled above, in the core, because this surface's keys
   * never reach a renderer — so this channel exists for the two buttons and carries nothing but which
   * one was pressed.
   */
  answer(requestId: string, action: PromptAction): void {
    const pending = this.#pending.get(requestId)
    if (pending === undefined) return
    if (action === 'cancel') {
      this.#finish(pending, 'cancelled')
      return
    }
    void this.#submit(pending)
  }

  /**
   * The prompt left the screen without an answer. Wired to `onOverlayVacancy`.
   *
   * `cancelled`, always, and never `wrong-password`: a window resize, a lost focus or a closed window is
   * the browser taking the question away, not the user getting their own master password wrong. Reporting
   * it as a wrong password would make the passwords page say "that was not it" about something nobody
   * finished typing.
   */
  overlayVacated(presentation: OverlayPresentation, _reason: OverlayVacancyReason): void {
    if (presentation.kind !== 'master-password') return
    const pending = this.#pending.get(presentation.requestId)
    if (pending === undefined) return
    /*
      Settled without dismissing. There is nothing left to take down — the layer has already replaced
      or destroyed this surface — and calling `dismissOverlay` here would take down whatever displaced
      it, which for a permission prompt means refusing a request nobody was asked about.
    */
    this.#forget(pending)
    pending.settle('cancelled')
  }

  /** Whether a question is on screen. For tests and diagnostics, never for a decision. */
  get pendingCount(): number {
    return this.#pending.size
  }

  // --- internals -----------------------------------------------------------

  #ask<T extends UnlockRequestOutcome | MasterPasswordRequestOutcome>(
    host: MasterPasswordHost,
    purpose: MasterPasswordPurpose
  ): Promise<T> {
    /*
      One question per window, and a second request is answered rather than queued.

      Unlike a permission prompt there is nothing to queue *for*: every caller of this wants the same
      thing — the vault open — so the one on screen will serve them all, and the honest answer to the
      second is "you were not asked". Queueing would also mean two questions sharing one input
      pipeline, which is the one thing the single-buffer design cannot support.
    */
    for (const pending of this.#pending.values()) {
      if (pending.host === host) return Promise.resolve('cancelled' as T)
    }

    return new Promise<T>((resolve) => {
      const [first] = stepsFor(purpose)
      const pending: Pending = {
        id: this.#newRequestId(),
        host,
        purpose,
        steps: stepsFor(purpose),
        index: 0,
        buffer: [],
        current: null,
        next: null,
        problem: null,
        busy: false,
        settle: (outcome) => resolve(outcome as T)
      }
      // Unreachable: every purpose has at least one step, and `satisfies` on the table says so. Guarded
      // rather than asserted because the alternative is a prompt with no question on it.
      if (first === undefined) {
        resolve('cancelled' as T)
        return
      }
      this.#pending.set(pending.id, pending)
      this.#present(pending)
    })
  }

  #present(pending: Pending): void {
    const [step] = pending.steps.slice(pending.index, pending.index + 1)
    if (step === undefined) return
    const presentation: MasterPasswordPresentation = {
      kind: 'master-password',
      requestId: pending.id,
      purpose: pending.purpose,
      step,
      filled: pending.buffer.length,
      problem: pending.problem,
      minLength: MIN_MASTER_PASSWORD_LENGTH
    }
    pending.host.presentOverlay(presentation)
  }

  /**
   * Continue was pressed, or Return.
   *
   * Guarded by `busy` because a derivation takes about half a second by design (`scrypt`, N = 2^17) and
   * Return auto-repeats: without it a held key would start a dozen of them, and the vault would be
   * derived against a buffer that was being emptied underneath them.
   */
  async #submit(pending: Pending): Promise<void> {
    if (pending.busy) return
    const [step] = pending.steps.slice(pending.index, pending.index + 1)
    if (step === undefined) return
    const candidate = pending.buffer.join('')

    if (step === 'current') {
      pending.busy = true
      try {
        await this.#useCurrent(pending, candidate)
      } catch (error) {
        this.#fail(pending, error)
      } finally {
        pending.busy = false
      }
      return
    }

    if (step === 'new') {
      const problem = assessMasterPassword(candidate)
      if (problem !== null) {
        this.#retry(pending, problem)
        return
      }
      pending.next = pending.buffer
      this.#advance(pending)
      return
    }

    /*
      The repeat, and a mismatch goes back two steps rather than one.

      Somebody who mistyped does not know *which* of the two they mistyped, so asking only for the
      repeat again would let them confirm a password they did not mean — and this is the operation whose
      mistakes cannot be discovered later: the vault would be re-wrapped under something nobody knows.
    */
    if (pending.next?.join('') !== candidate) {
      this.#wipe(pending.next)
      pending.next = null
      pending.index = Math.max(0, pending.index - 1)
      this.#retry(pending, 'mismatch')
      return
    }

    pending.busy = true
    try {
      await this.#commit(pending, candidate)
    } catch (error) {
      this.#fail(pending, error)
    } finally {
      pending.busy = false
    }
  }

  /**
   * The vault could not do the work at all, as opposed to refusing the candidate.
   *
   * `PasswordVault` answers a wrong password and a broken rule as *values*, so nothing that reaches here
   * is about what the user typed. What reaches here is an I/O failure on `passwords.key` — no permission,
   * a full disk, a device that went away — which `unlock`, `verifyMasterPassword` and `setMasterPassword`
   * all deliberately rethrow rather than flatten into "wrong password".
   *
   * Two things have to happen and neither is optional.
   *
   * **The request has to settle.** Otherwise `passwords:requestUnlock` is left holding a promise nothing
   * will ever resolve, which is the defect `OVERLAY_AWAITS_ANSWER` exists to prevent — reached here by a
   * different route than a vanished surface, with the same cost. And it has to settle *visibly*: the
   * previous behaviour left the question on screen with a Continue button that did nothing, which is
   * indistinguishable to the user from a mistyped password and cannot be told apart by retrying.
   *
   * **It has to be caught here.** `#submit` is started with `void` from both `key()` and `answer()`, so an
   * escaping rejection is an unhandled one — and Node terminates the process for those by default. A disk
   * error while somebody was unlocking their vault would take the whole browser down with it.
   *
   * The word differs by purpose because the two callers have different vocabularies, and in both the
   * honest reading is "no password will help with this": `unreadable` for an unlock, `locked` for a
   * set, change or remove, which is the value that already means "there is no key to re-wrap".
   */
  #fail(pending: Pending, error: unknown): void {
    /*
      The message is the operating system's and names a path, never a candidate — and it is logged rather
      than returned, because a rejected invoke becomes an English sentence on a translated page. The
      buffers go a line later, in `#forget`.
    */
    console.error('[passwords] the vault could not be used for this prompt:', String(error))
    this.#finish(pending, pending.purpose === 'unlock' ? 'unreadable' : 'locked')
  }

  /**
   * The existing master password was typed. Uses it, or refuses it here rather than three steps later.
   *
   * For `unlock` this *is* the whole operation. For `change` and `remove` it is proof, checked now
   * against the stored key file — the alternative would be discovering a mistyped current password only
   * after the user had chosen and repeated a new one, and then throwing all three away.
   */
  async #useCurrent(pending: Pending, candidate: string): Promise<void> {
    if (pending.purpose === 'unlock') {
      const outcome = await this.#vault.unlock(candidate)
      if (outcome === 'wrong-password') {
        this.#retry(pending, 'wrong-password')
        return
      }
      if (outcome === 'unreadable') {
        this.#finish(pending, 'unreadable')
        return
      }
      // `unlocked` and `not-protected` both mean the document is open, which is what was asked.
      this.#finish(pending, 'unlocked')
      return
    }

    if (!(await this.#vault.verifyMasterPassword(candidate))) {
      this.#retry(pending, 'wrong-password')
      return
    }
    pending.current = pending.buffer
    if (pending.purpose === 'remove') {
      await this.#commit(pending, '')
      return
    }
    this.#advance(pending)
  }

  /** Rewrites `passwords.key`. The document is not touched; see `PasswordVault.setMasterPassword`. */
  async #commit(pending: Pending, _repeat: string): Promise<void> {
    const outcome = await this.#vault.setMasterPassword({
      current: pending.current === null ? null : pending.current.join(''),
      next: pending.purpose === 'remove' || pending.next === null ? null : pending.next.join('')
    })
    /*
      `wrong-password` here should be unreachable — the current password was proved a moment ago — and is
      mapped rather than swallowed. It becomes reachable the day another window changes the master
      password while this prompt is open, and the honest report then is that the proof went stale.
    */
    this.#finish(pending, outcome)
  }

  #advance(pending: Pending): void {
    pending.index += 1
    pending.buffer = []
    pending.problem = null
    this.#present(pending)
  }

  /** Says what was wrong and asks the same question again, with an empty field. */
  #retry(pending: Pending, problem: MasterPasswordPromptProblem): void {
    this.#wipe(pending.buffer)
    pending.buffer = []
    pending.problem = problem
    this.#present(pending)
  }

  /** Settles the request, drops every candidate, and takes the surface down. */
  #finish(pending: Pending, outcome: UnlockRequestOutcome | MasterPasswordRequestOutcome): void {
    /*
      Forgotten before the layer is told, for the reason `PermissionArbiter.answer` gives from the other
      side: `dismissOverlay` announces the departure, `overlayVacated` would find this request still
      pending and settle it as cancelled — overwriting the outcome that was just determined.
    */
    this.#forget(pending)
    pending.host.dismissOverlay()
    pending.settle(outcome)
  }

  #forget(pending: Pending): void {
    this.#pending.delete(pending.id)
    this.#wipe(pending.buffer)
    this.#wipe(pending.current)
    this.#wipe(pending.next)
    pending.buffer = []
    pending.current = null
    pending.next = null
  }

  /**
   * Empties a character array in place.
   *
   * Best effort, and worth the two lines for the same reason `PasswordVault.#dropKey` is: what this
   * removes reliably is the *live* copy, which is the one a long-running main process would otherwise
   * keep for hours and the one a crash dump finds. The single-character strings themselves are interned
   * by V8 and are not secrets on their own — the secret is their order, and that is what goes.
   */
  #wipe(buffer: string[] | null): void {
    if (buffer === null) return
    buffer.fill('')
    buffer.length = 0
  }
}
