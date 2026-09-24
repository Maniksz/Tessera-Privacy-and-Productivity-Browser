import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AutofillService,
  PENDING_SAVE_TTL_MS,
  type AutofillFrame,
  type AutofillVault,
  type AutofillView
} from '@main/passwords/AutofillService.js'
import { notifyOverlayKey, onOverlayKey } from '@main/passwords/overlay-keys.js'
import type { Locale } from '@shared/i18n/catalog.js'
import type { MasterPasswordPresentation } from '@shared/overlay/surface.js'
import { FILL_GESTURE_WINDOW_MS } from '@shared/passwords/consent.js'
import type { FormDescriptor } from '@shared/passwords/fields.js'
import type { BrowsingMode, PasswordSummary, SaveCredentialInput } from '@shared/passwords/model.js'
import type { PromptKey } from '@shared/passwords/prompt.js'
import type { StoredCredentialState } from '@shared/passwords/save-policy.js'
import {
  AUTOFILL_BADGE_CHANNEL,
  AUTOFILL_SAVE_PROMPT_CHANNEL,
  asBadgeChrome,
  asFormDescriptor,
  asSaveBarChrome,
  type SaveBarChrome
} from '@shared/passwords/wire.js'

/**
 * The service that holds autofill's per-view state, and what breaks in the product when it is wrong.
 *
 * The pure policies are tested elsewhere — `passwords-fill-policy.test.ts` owns "may this credential
 * go into this form", `passwords-save-policy.test.ts` owns "may the browser offer to remember this
 * one", `passwords-wire.test.ts` owns what a renderer is allowed to send. None of them is retested
 * here. What is only testable here is the part that keeps state per view and decides what to *do*
 * with those answers, and every one of these decisions has a product consequence:
 *
 *   - The frame facts are the ones the core read from the frame tree, never anything the message
 *     said, so a framed login page is not filled and a subframe gets nothing. A compromised
 *     renderer is the case that rule exists for, and it is the case where its own account of where
 *     it is worth nothing.
 *   - A fill needs an input event the *browser process* saw, inside five seconds. `noteInput` is fed
 *     from Electron's `input-event`, which never fires for a page calling `.click()`. Without the
 *     per-view record kept here, a hidden form harvests a credential on page load.
 *   - A fill asked for from browser chrome has no page-view input event behind it and cannot have
 *     one, so the core opens a request and that request *is* the consent. It is one-shot and bound:
 *     spent by the fill it authorises, and dropped by five separate endings. Left open, it would be
 *     `no-user-gesture` switched off for that tab, which is the rule the whole file exists for.
 *   - The per-view wiring is *not* driven here. It lives in `tests/autofill-wiring.test.ts`, which
 *     never records a gesture by hand: the defect it guards against was a circle between two correct
 *     halves — the input listener attached only after an offer, and the offer refused for want of
 *     the input — and a test that supplies the gesture itself, as this file does, cannot see it.
 *   - A private window does not offer to save, and a fill in one is noted through a writer bound to
 *     that mode — so a private sign-in leaves no timestamp on disk.
 *   - `dropPendingSaves` is what makes a lock mean what it says. Autofill holds one submitted
 *     credential per view in memory while its save bar is up; without this, a password the user
 *     typed two minutes ago outlives the lock for the rest of the bar's life.
 *   - `noteNavigation` and `documentReady` together are the whole reason the save bar is ever seen:
 *     a sign-in navigates, so the offer has to survive that navigation and be raised again on the
 *     page the user landed on. Get the second half wrong and the feature fails silently — the bar is
 *     drawn into a document that is already gone and the question is never asked.
 *   - `fillFor` answers a value rather than throwing, because it is answered synchronously into a
 *     preload and a throw there takes the whole page down with it.
 *   - A choice travels back to the page as a one-time token rather than as the entry's id, so the
 *     association between the two lives only here, and only until the token is redeemed (KTD8).
 *
 * The second half of the file is `overlay-keys.ts`, the registry that carries master-password
 * keystrokes. Its security property is what its `catch` does *not* say.
 */

const NOW = 1_700_000_000_000
const VIEW_ID = 7
const OTHER_VIEW_ID = 8

/** The one secret in the fixture. Asserted absent from every payload that must not carry it. */
const SECRET = 'correct-horse-battery-staple'
/** What the user has just typed into the page, as a submission reports it. */
const SUBMITTED = 'a-password-typed-two-minutes-ago'

const LOGIN_URL = 'https://accounts.example.com/login'
const LOGIN_ORIGIN = 'https://accounts.example.com'

/** Saved for the registrable domain, which is what a login on `accounts.` is offered from. */
const STORED: PasswordSummary = {
  id: 'pw-1',
  origin: 'https://example.com',
  username: 'alice@example.com',
  createdAt: NOW - 86_400_000,
  updatedAt: NOW - 86_400_000,
  lastUsedAt: null
}

/** The same credential filed under the exact origin of the login page, for the nameless-form case. */
const STORED_AT_LOGIN_ORIGIN: PasswordSummary = { ...STORED, origin: LOGIN_ORIGIN }

/**
 * A `WebContents` as narrow as the service's own use of one, and deliberately no narrower or wider.
 *
 * `id`, `isDestroyed()` and `send()` are all of it. There is no `getURL`, and that absence is the
 * point rather than an omission: if the service ever reached for the view's own address instead of
 * the frame address the core read from the frame tree, these tests would not compile.
 */
interface FakeView extends AutofillView {
  readonly sent: Array<{ readonly channel: string; readonly payload: unknown }>
  destroy(): void
}

function fakeView(id: number = VIEW_ID): FakeView {
  const sent: Array<{ readonly channel: string; readonly payload: unknown }> = []
  let destroyed = false
  return {
    id,
    sent,
    destroy: () => {
      destroyed = true
    },
    isDestroyed: () => destroyed,
    send: (channel, payload) => {
      sent.push({ channel, payload })
    }
  }
}

/**
 * A write the service asked for, with the mode of the writer it asked for it through.
 *
 * The mode travels with the call because that is the decision under test: `PasswordVault` supplies a
 * discarding writer for a private window, so what the service has to get right is *which* writer it
 * asks for.
 */
type WriterCall =
  | { readonly mode: BrowsingMode; readonly call: 'save'; readonly input: SaveCredentialInput }
  | { readonly mode: BrowsingMode; readonly call: 'never'; readonly url: string }
  | { readonly mode: BrowsingMode; readonly call: 'used'; readonly id: string }

interface ComparedCall {
  readonly url: string
  readonly username: string
  readonly password: string
}

interface HarnessState {
  unlocked: boolean
  /** `passwords.autofill`. Mutable, so a test can switch the feature off between two calls. */
  enabled: boolean
  mode: BrowsingMode | null
  locale: Locale
}

interface HarnessOptions {
  readonly unlocked?: boolean
  readonly enabled?: boolean
  readonly summaries?: readonly PasswordSummary[]
  readonly secrets?: Readonly<Record<string, string>>
  readonly neverSaved?: readonly string[]
  readonly stored?: StoredCredentialState
  readonly mode?: BrowsingMode | null
  readonly locale?: Locale
}

interface Harness {
  readonly service: AutofillService
  readonly view: FakeView
  /** Mutable, so a test can lock the vault or unplace the view between two calls. */
  readonly state: HarnessState
  readonly clock: { now: number }
  readonly writes: WriterCall[]
  /** What the service asked the vault for, to show what it did *not* ask for while refusing. */
  readonly reads: { lists: number; secrets: string[]; compared: ComparedCall[] }
}

function harness(options: HarnessOptions = {}): Harness {
  const clock = { now: NOW }
  const state: HarnessState = {
    unlocked: options.unlocked ?? true,
    enabled: options.enabled ?? true,
    mode: options.mode === undefined ? 'normal' : options.mode,
    locale: options.locale ?? 'en'
  }
  const summaries = options.summaries ?? [STORED]
  const secrets = options.secrets ?? { [STORED.id]: SECRET }
  const writes: WriterCall[] = []
  const reads: Harness['reads'] = { lists: 0, secrets: [], compared: [] }

  const vault: AutofillVault = {
    isUnlocked: () => state.unlocked,
    list: () => {
      reads.lists += 1
      return [...summaries]
    },
    summaryOf: (id) => summaries.find((summary) => summary.id === id) ?? null,
    secretOf: (id) => {
      reads.secrets.push(id)
      return secrets[id] ?? null
    },
    neverSavedOrigins: () => [...(options.neverSaved ?? [])],
    compareStored: (url, username, password) => {
      reads.compared.push({ url, username, password })
      return options.stored ?? 'none'
    },
    writerFor: (mode) => ({
      save: (input) => {
        writes.push({ mode, call: 'save', input })
        return 'created'
      },
      neverSaveFor: (url) => {
        writes.push({ mode, call: 'never', url })
      },
      noteUsed: (id) => {
        writes.push({ mode, call: 'used', id })
      }
    })
  }

  const service = new AutofillService({
    vault,
    enabled: () => state.enabled,
    modeFor: () => state.mode,
    locale: () => state.locale,
    now: () => clock.now
  })
  return { service, view: fakeView(), state, clock, writes, reads }
}

function frame(overrides: Partial<AutofillFrame> = {}): AutofillFrame {
  return { url: LOGIN_URL, isTopLevel: true, topLevelUrl: LOGIN_URL, ...overrides }
}

function fieldPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'password',
    name: 'password',
    id: '',
    autocomplete: 'current-password',
    visible: true,
    editable: true,
    hasValue: false,
    ...overrides
  }
}

/** An ordinary sign-in form, as a renderer reports one. Validated by `wire.ts` on arrival. */
function formPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: '/session',
    fields: [
      fieldPayload({ type: 'text', name: 'user', autocomplete: 'username' }),
      fieldPayload()
    ],
    ...overrides
  }
}

/**
 * The same form, parsed.
 *
 * `badgePressed` takes a descriptor rather than a message, because by the time it is called the
 * message has already been through `asSuggestPress` — which is where a malformed one is refused, and
 * where that refusal is tested. Built through the real guard so the fixture cannot drift from what
 * a renderer is actually allowed to send.
 */
function form(overrides: Record<string, unknown> = {}): FormDescriptor {
  const descriptor = asFormDescriptor(formPayload(overrides))
  if (descriptor === null) throw new Error('the form fixture is not a form')
  return descriptor
}

/**
 * A fill request as the preload sends one: the token the core minted for a choice, and the form now.
 *
 * Minting is part of the fixture because it is part of the flow — the page never holds an entry id
 * (KTD8), so there is no way to ask for a fill that does not begin with the core recording a choice.
 */
function chose(
  service: AutofillService,
  options: { id?: string; viewId?: number; form?: unknown } = {}
): Record<string, unknown> {
  return {
    token: service.noteFillChoice(options.viewId ?? VIEW_ID, options.id ?? STORED.id),
    form: options.form ?? formPayload()
  }
}

function reportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { form: formPayload(), username: STORED.username, password: SUBMITTED, ...overrides }
}

/**
 * A real `input-event` payload of the kind `gesture.ts` accepts.
 *
 * Only the browser process ever produces one, which is the whole of why the gesture is trustworthy.
 */
function press(service: AutofillService, viewId: number = VIEW_ID): void {
  service.noteInput(viewId, { type: 'mouseDown', button: 'left' })
}

/** Every save bar the service put up, read back through the guard the preload reads it with. */
function barsOn(view: FakeView): Array<SaveBarChrome | null> {
  return view.sent.map((message) => asSaveBarChrome(message.payload))
}

function barMessages(view: FakeView): Array<string | undefined> {
  return barsOn(view).map((chrome) => chrome?.message)
}

describe('what the badge answers, built from the frame the core read', () => {
  it('lists the accounts saved for the site, and nothing else about them', () => {
    const { service, view } = harness()
    press(service)

    expect(service.badgePressed(view, frame(), form())).toEqual({
      state: 'entries',
      entries: [{ id: STORED.id, username: STORED.username }]
    })
  })

  it('says nothing at all to a press the browser process did not see', () => {
    /*
      AE3, and the first of R8's two named exceptions. A page can focus a field and call `.click()`
      on our badge whenever it likes; neither produces an `input-event`, which only the browser
      process dispatches. An answer here would be an answer to the page, and it would let any
      document put a surface on the overlay layer at will.
    */
    const { service, view, reads } = harness()

    expect(service.badgePressed(view, frame(), form())).toBeNull()
    expect(reads.lists, 'the vault was asked something for a press nobody made').toBe(0)
  })

  it('says nothing to a press whose gesture has gone stale', () => {
    const { service, view, clock } = harness()
    press(service)
    clock.now += FILL_GESTURE_WINDOW_MS + 1

    expect(service.badgePressed(view, frame(), form())).toBeNull()
  })

  it('is not satisfied by a chrome request left open from an earlier flow', () => {
    /*
      Deliberately a *page-input* consent rather than any consent. A request still open would
      otherwise stand in for the press — so one genuine press would license every forged one after
      it, for as long as the request stood, which is the standing permission the one-shot rule exists
      to deny.
    */
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, 'fill-request-1')

    expect(service.badgePressed(view, frame(), form())).toBeNull()
  })

  it('keeps the record per view, so a press in one tab does not open a list in another', () => {
    const { service, view } = harness()
    press(service, OTHER_VIEW_ID)

    expect(service.badgePressed(view, frame(), form())).toBeNull()
  })

  it('puts no password in the answer, whatever the state', () => {
    // The surface is drawn by our own renderer, so it may see account names — and nothing more. The
    // type says so; this says so of the value that was built.
    const { service, view } = harness()
    press(service)

    expect(JSON.stringify(service.badgePressed(view, frame(), form()))).not.toContain(SECRET)
  })

  it('says that nothing is saved rather than answering with an empty list', () => {
    // AE2's second half. `empty` is a sentence the surface renders; a list of nothing would be a
    // blank box, which is the "nothing happened" answer R8 abolishes.
    const { service, view } = harness({
      summaries: [{ ...STORED, origin: 'https://other.example' }]
    })
    press(service)

    expect(service.badgePressed(view, frame(), form())).toEqual({ state: 'empty' })
  })

  it('says the vault is locked, without asking it for a list at all', () => {
    /*
      AE1's first half, and the reason the answer is a *state* rather than an absence: a locked vault
      answers `[]` to `list()`, so a check derived from an empty list would read as "a site with no
      credentials" and the user would be told nothing is saved when plenty is.
    */
    const { service, view, reads } = harness({ unlocked: false })
    press(service)

    expect(service.badgePressed(view, frame(), form())).toEqual({ state: 'locked' })
    expect(reads.lists, 'a locked vault was asked for its summaries').toBe(0)
  })

  it('names the setting when autofill has been switched off under an open badge', () => {
    /*
      AE9. Reachable exactly when a badge is already on screen and the setting changes underneath it:
      `noteFillableForm` refuses to subscribe to a view's input while the feature is off, so with it
      off from the start there is no gesture, no badge wording, and therefore no badge to press.
      Switching it off while a form is on screen is the case `enabled` is read per call for.
    */
    const { service, view, state } = harness()
    press(service)
    state.enabled = false

    expect(service.badgePressed(view, frame(), form())).toEqual({ state: 'disabled' })
  })

  it('names the reason a page was refused rather than saying nothing was found', () => {
    // AE4, and KTD6. "This page is not encrypted" and "nothing is saved" are different sentences,
    // and only one of them is something the user can act on.
    const { service, view } = harness()
    press(service)
    const insecure = 'http://shop.example/login'

    expect(
      service.badgePressed(view, frame({ url: insecure, topLevelUrl: insecure }), form())
    ).toEqual({ state: 'refused', reason: 'insecure-page' })
  })

  it('names a form with nothing to fill, rather than offering accounts for a search box', () => {
    const { service, view } = harness()
    press(service)

    expect(
      service.badgePressed(view, frame(), form({ fields: [fieldPayload({ type: 'text' })] }))
    ).toEqual({ state: 'refused', reason: 'no-password-field' })
  })

  it('refuses a login page somebody else has framed, and names that as the reason', () => {
    /*
      The refusal itself is `fill-policy.ts`'s, and tested there. What is asserted here is that the
      service builds its context out of the frame facts it was handed — the message has no field with
      which to claim otherwise — so a subframe is refused even though the same call from the top
      document is served.
    */
    const { service, view } = harness()
    press(service)

    expect(
      service.badgePressed(
        view,
        frame({ isTopLevel: false, topLevelUrl: 'https://evil.example/' }),
        form()
      )
    ).toEqual({ state: 'refused', reason: 'cross-origin-frame' })
    expect(
      service.badgePressed(view, frame(), form()),
      'the same form at the top was served'
    ).toEqual({ state: 'entries', entries: [{ id: STORED.id, username: STORED.username }] })
  })

  it('refuses when the frame claims the top while the document above it is another site', () => {
    const { service, view } = harness()
    press(service)

    expect(
      service.badgePressed(view, frame({ topLevelUrl: 'https://evil.example/' }), form())
    ).toEqual({ state: 'refused', reason: 'cross-origin-frame' })
  })

  it('refuses when the frame tree could not be read', () => {
    // A frame torn down mid-message. "Unknown" has to mean no, not "probably the same".
    const { service, view } = harness()
    press(service)

    expect(service.badgePressed(view, frame({ topLevelUrl: null }), form())).toEqual({
      state: 'refused',
      reason: 'cross-origin-frame'
    })
  })

  it('says nothing to a view this browser cannot place in a window', () => {
    // A devtools window, or something being torn down. There is no tile to draw a list in, and
    // anything unaccounted for has to mean no.
    const { service, view } = harness({ mode: null })
    press(service)

    expect(service.badgePressed(view, frame(), form())).toBeNull()
  })
})

describe('the badge\u2019s own wording, which is all the page is told before it is pressed', () => {
  it('is sent when a view reports a fillable form, and carries nothing about the vault', () => {
    // AE2's first half. The page learns that a badge exists and what to call it; the vault is not
    // asked anything until the badge has actually been pressed.
    const { service, view, reads } = harness()

    expect(service.noteFillableForm(view, true)).toBe(true)

    const [message] = view.sent
    expect(message?.channel).toBe(AUTOFILL_BADGE_CHANNEL)
    expect(asBadgeChrome(message?.payload)?.label).toBe('Fill in a saved password')
    expect(JSON.stringify(view.sent)).not.toContain(STORED.username)
    expect(reads.lists).toBe(0)
  })

  it('is not sent while autofill is switched off, so no badge is drawn at all', () => {
    // The honest answer to "the feature is off" is no affordance, rather than a control that would
    // do nothing. It is also what keeps the input subscription off in those views.
    const { service, view } = harness({ enabled: false })

    expect(service.noteFillableForm(view, true)).toBe(false)
    expect(view.sent).toEqual([])
  })

  it('is not sent for a focus that left the form', () => {
    const { service, view } = harness()

    expect(service.noteFillableForm(view, false)).toBe(false)
    expect(view.sent).toEqual([])
  })

  it('reads the language on every report, so a change reaches the next form not the next restart', () => {
    const { service, view, state } = harness()

    service.noteFillableForm(view, true)
    state.locale = 'de'
    service.noteFillableForm(view, true)

    expect(view.sent.map((message) => asBadgeChrome(message.payload)?.label)).toEqual([
      'Fill in a saved password',
      'Gespeichertes Passwort einsetzen'
    ])
  })
})

describe('a fill needs an input event the browser process itself saw', () => {
  it('serves a fill inside the gesture window', () => {
    const { service, view } = harness()
    press(service)

    expect(service.fillFor(view, frame(), chose(service))).toEqual({
      username: STORED.username,
      password: SECRET
    })
  })

  it('refuses a fill with no gesture before it, and fetches no secret while refusing', () => {
    /*
      The attack: a page appends an off-screen login form on load and submits it. `noteInput` is fed
      from Electron's `input-event`, which fires only for input the browser process dispatched — so a
      page calling `.click()` cannot produce the number this refusal is made of.

      The second assertion is the one worth keeping: a refused fill must never have reached for the
      password at all.
    */
    const { service, view, reads } = harness()

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
    expect(reads.secrets, 'a refused fill fetched the password anyway').toEqual([])
  })

  it('refuses a fill whose gesture has gone stale', () => {
    // A click banked a minute ago is not consent to a form the user has not touched since.
    const { service, view, clock } = harness()
    press(service)
    clock.now += FILL_GESTURE_WINDOW_MS + 1

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
  })

  it('does not take a pointer drifting across the page for a gesture', () => {
    // `noteInput` is called for *every* input event; most are not gestures. A mouse resting over a
    // page while the user reads would otherwise hold the window open for as long as they stayed.
    const { service, view } = harness()
    service.noteInput(VIEW_ID, { type: 'mouseMove' })

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()

    press(service)
    expect(service.fillFor(view, frame(), chose(service))).not.toBeNull()
  })

  it('keeps the record per view, so a click in one tab does not authorise a fill in another', () => {
    // The map is keyed by web-contents id for this reason: a background tab must not be able to
    // spend a gesture the user made in the tab they are looking at.
    const { service, view } = harness()
    press(service, OTHER_VIEW_ID)

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
  })
})

describe('the fill answer, and the trace it leaves', () => {
  it('notes the use through the writer bound to the window the view belongs to', () => {
    const { service, view, writes } = harness()
    press(service)
    service.fillFor(view, frame(), chose(service))

    expect(writes).toEqual([{ mode: 'normal', call: 'used', id: STORED.id }])
  })

  it('fills in a private window through the private writer, leaving no timestamp behind', () => {
    /*
      Filling in a private window is allowed — a private window is about leaving no trace, not about
      being a different person. What must not happen is the `lastUsedAt` write, and the writer that
      cannot perform it is `PasswordVault`'s job to supply. The service's part, asserted here, is
      that it asks for the writer for the mode this view is in rather than the normal one.
    */
    const { service, view, writes } = harness({ mode: 'private' })
    press(service)

    expect(service.fillFor(view, frame(), chose(service))?.password).toBe(SECRET)
    expect(writes).toEqual([{ mode: 'private', call: 'used', id: STORED.id }])
  })

  it('refuses a token nobody minted, however plausible it looks', () => {
    const { service, view, writes } = harness()
    press(service)

    expect(
      service.fillFor(view, frame(), { token: 'tok-invented', form: formPayload() })
    ).toBeNull()
    expect(writes).toEqual([])
  })

  it('refuses an entry id used as a token, which is what the page used to be handed', () => {
    // KTD8's whole point: the page never holds a durable reference to a vault entry, so the id that
    // *would* have worked before this change buys nothing now.
    const { service, view, reads } = harness()
    press(service)

    expect(service.fillFor(view, frame(), { token: STORED.id, form: formPayload() })).toBeNull()
    expect(reads.secrets).toEqual([])
  })

  it('burns the token, so the same choice cannot be redeemed twice', () => {
    // The user chose once. A page chooses when it sends, and it can send the same message again the
    // instant the first one lands.
    const { service, view } = harness()
    press(service)
    const request = chose(service)

    expect(service.fillFor(view, frame(), request)).not.toBeNull()
    expect(service.fillFor(view, frame(), request)).toBeNull()
  })

  it('burns the token even when the rules refuse the attempt it was spent on', () => {
    /*
      The difference between a one-time proof and a retry counter. A token that survived its own
      refusal would let a page try again — from a subframe, with a rewritten action, after a
      navigation — until one attempt happened to pass.
    */
    const { service, view } = harness()
    press(service)
    const request = chose(service)

    expect(service.fillFor(view, frame({ isTopLevel: false }), request)).toBeNull()
    expect(service.fillFor(view, frame(), request), 'the token outlived its refusal').toBeNull()
  })

  it('keeps the token per view, so one tab cannot redeem another tab’s choice', () => {
    const { service, view } = harness()
    press(service)

    expect(service.fillFor(view, frame(), chose(service, { viewId: OTHER_VIEW_ID }))).toBeNull()
  })

  it('refuses a fill for a form whose action has been rewritten since the choice', () => {
    /*
      A choice is not a licence that can be spent later. Between the list being drawn and the click
      on it, a script on the page can rewrite the form's action — so every rule is applied again,
      against the form as it is *now*, and against the entry the token stands for.
    */
    const { service, view } = harness()
    press(service)
    const moved = chose(service, { form: formPayload({ action: 'https://evil.example/collect' }) })

    expect(service.fillFor(view, frame(), moved)).toBeNull()
  })

  it('refuses a fill that arrives from a subframe after the list was drawn at the top', () => {
    // The other half of "not a licence": a page that moved the form into a frame between the choice
    // and the fill gets a refusal, because the frame facts are read again on this side.
    const { service, view } = harness()
    press(service)

    expect(service.fillFor(view, frame({ isTopLevel: false }), chose(service))).toBeNull()
  })

  it('answers a value rather than throwing when the request is not a request', () => {
    const { service, view } = harness()
    press(service)

    expect(service.fillFor(view, frame(), 'pw-1')).toBeNull()
    expect(service.fillFor(view, frame(), { token: '', form: formPayload() })).toBeNull()
    expect(service.fillFor(view, frame(), { token: STORED.id })).toBeNull()
  })

  it('refuses a fill after the vault locked between the list and the click', () => {
    // An idle timeout is a clock, not an event the page waits for, so this is an ordinary race. The
    // secret must not be fetched on the way to the refusal.
    const { service, view, state, reads } = harness()
    press(service)
    const request = chose(service)

    state.unlocked = false
    expect(service.fillFor(view, frame(), request)).toBeNull()
    expect(reads.secrets).toEqual([])
  })

  it('refuses when the entry disappeared between the decision and the fetch', () => {
    // Deleted on the passwords page while the list was on screen. Nothing is filled, and no use is
    // recorded for a fill that did not happen.
    const { service, view, writes } = harness({ secrets: {} })
    press(service)

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
    expect(writes).toEqual([])
  })

  it('refuses when the entry was deleted before its token was redeemed', () => {
    // The summary itself is gone, not only the secret: nothing to decide about, nothing fetched.
    const { service, view, reads } = harness({ summaries: [] })
    press(service)

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
    expect(reads.secrets).toEqual([])
  })

  it('refuses a fill into a view this browser cannot place in a window', () => {
    const { service, view } = harness({ mode: null })
    press(service)

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
  })
})

describe('a submitted credential, and whether the browser offers to remember it', () => {
  it('puts the save bar up on the view that submitted, asking about the site', () => {
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    const [message] = view.sent.slice(0, 1)
    expect(message?.channel).toBe(AUTOFILL_SAVE_PROMPT_CHANNEL)
    expect(barMessages(view)).toEqual(['Save the password for example.com?'])
    expect(service.hasPendingSave(VIEW_ID)).toBe(true)
  })

  it('keeps a view with a save bar waiting from being unloaded, and no other (U15)', () => {
    const { service, view } = harness()
    expect(service.waitsOn(VIEW_ID)).toBe(false)
    service.reportSubmission(view, frame(), reportPayload())
    expect(service.waitsOn(VIEW_ID)).toBe(true)
    expect(service.waitsOn(VIEW_ID + 1)).toBe(false)
  })

  it('names the account on the bar and puts the password nowhere in it', () => {
    // The bar has to say whose password it is about; it must not carry the password itself, because
    // the payload crosses into the page's own document to be drawn there.
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    const [bar] = barsOn(view).slice(0, 1)
    expect(bar?.username).toBe(STORED.username)
    expect(JSON.stringify(view.sent)).not.toContain(SUBMITTED)
  })

  it('asks the update question when the site already holds a different password for that name', () => {
    /*
      Which of the two questions is asked is not cosmetic: "save" and "update" have different
      consequences, and a user told the first while the second is about to happen has been
      misinformed about losing something. `save-policy.ts` decides which; the service has to carry
      that answer into the wording.
    */
    const { service, view } = harness({ stored: 'different-password' })
    service.reportSubmission(view, frame(), reportPayload())

    expect(barMessages(view)).toEqual(['Update the saved password for example.com?'])
  })

  it('does not offer to remember anything in a private window, and keeps nothing in memory', () => {
    // The refusal is `save-policy.ts`'s. What matters here is that the mode reached it *before*
    // `#pending` was written: this is the one path that arrives holding a password.
    const { service, view } = harness({ mode: 'private' })
    service.reportSubmission(view, frame(), reportPayload())

    expect(view.sent).toEqual([])
    expect(service.hasPendingSave(VIEW_ID), 'a private submission was held in memory').toBe(false)
  })

  it('keeps nothing and asks nothing while the vault is locked', () => {
    /*
      The most consequential of the locked refusals. A locked vault would look to `decideSaveOffer`
      like a site with no stored credential, so the bar would go up on every sign-in, the user would
      press Save, and the discarding writer would drop it — a prompt that appears, is answered and
      does nothing teaches people that this browser's questions do not matter.
    */
    const { service, view, reads } = harness({ unlocked: false })
    service.reportSubmission(view, frame(), reportPayload())

    expect(view.sent).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
    expect(reads.compared, 'the submitted password was handed to a locked vault').toEqual([])
  })

  it('asks nothing about a submission from a view it cannot place in a window', () => {
    // A view this browser cannot name is not a tab of ours, and this is the one path that arrives
    // holding a password — so it returns before the credential is written down anywhere.
    const { service, view } = harness({ mode: null })
    service.reportSubmission(view, frame(), reportPayload())

    expect(view.sent).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('asks nothing on a site where the user has already answered never here', () => {
    const { service, view } = harness({ neverSaved: [LOGIN_ORIGIN] })
    service.reportSubmission(view, frame(), reportPayload())

    expect(view.sent).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('asks nothing about a submission from a frame', () => {
    const { service, view } = harness()
    service.reportSubmission(view, frame({ isTopLevel: false }), reportPayload())

    expect(view.sent).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('asks nothing about a document that has no origin to file a credential under', () => {
    // The browser's own pages, `file:`, `data:`. There is no site to remember anything for.
    const { service, view } = harness()
    service.reportSubmission(
      view,
      frame({ url: 'tessera://start', topLevelUrl: 'tessera://start' }),
      reportPayload()
    )

    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('asks nothing about a report it cannot read', () => {
    const { service, view } = harness()
    service.reportSubmission(view, frame(), 'a password, honestly')
    service.reportSubmission(view, frame(), { username: 'alice', password: 'p' })

    expect(view.sent).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('reads a nameless submission as the one account the site has, on the bar and in the write', () => {
    /*
      A change-password form usually has no name field, so its submission reports an empty username.
      Which account that is belongs to `resolveSubmittedUsername`, tested in `passwords-model`; what
      is asserted here is that the service used the resolved name for all three of the things that
      follow — the comparison, the wording, and the credential it eventually stores. Saved as an
      empty name it would become a second, nameless entry beside the real one.
    */
    const { service, view, writes, reads } = harness({ summaries: [STORED_AT_LOGIN_ORIGIN] })
    service.reportSubmission(view, frame(), reportPayload({ username: '' }))

    expect(reads.compared).toEqual([
      { url: LOGIN_URL, username: STORED.username, password: SUBMITTED }
    ])
    const [bar] = barsOn(view).slice(0, 1)
    expect(bar?.username).toBe(STORED.username)

    service.answerSave(view, 'save')
    expect(writes).toEqual([
      {
        mode: 'normal',
        call: 'save',
        input: { url: LOGIN_URL, username: STORED.username, password: SUBMITTED }
      }
    ])
  })

  it('draws no bar into a view that is already gone', () => {
    // A sign-in that closed the tab. The pending credential is released by `forget`, which
    // `install-autofill` wires to the view's own `destroyed` event.
    const { service, view } = harness()
    view.destroy()
    service.reportSubmission(view, frame(), reportPayload())

    expect(view.sent).toEqual([])
  })
})

describe('the save bar survives the navigation a sign-in causes, and nothing else', () => {
  it('keeps the offer across a redirect inside the site', () => {
    // The navigation the bar has to survive: a sign-in normally redirects, often twice, and the
    // question has to be asked on the page the user lands on.
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.noteNavigation(VIEW_ID, `${LOGIN_ORIGIN}/welcome?first=1`)

    expect(service.hasPendingSave(VIEW_ID)).toBe(true)
  })

  it('drops the offer once the view has moved to another site', () => {
    // What a user would mean by "I have moved on". Nothing is left to be stored afterwards either.
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.noteNavigation(VIEW_ID, 'https://other.example/')

    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
    service.answerSave(view, 'save')
    expect(writes).toEqual([])
  })

  it('drops the offer when the sign-in hands off to another host of the same site', () => {
    /*
      Survival is keyed on the exact origin recorded at submission, while a *fill* is decided on the
      registrable domain. So a sign-in on `accounts.example.com` that lands on `www.example.com` is
      not asked about — the strict reading of "has left its site". Asserted because it is the current
      behaviour and the direction of any future change should be a deliberate one.
    */
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.noteNavigation(VIEW_ID, 'https://www.example.com/app')

    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('drops the offer when the address it moved to has no origin at all', () => {
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.noteNavigation(VIEW_ID, 'about:blank')

    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('has nothing to drop once the question has been answered', () => {
    // The navigation a Save press itself causes arrives after the credential is gone, and must not
    // write anything a second time.
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())
    service.answerSave(view, 'save')

    service.noteNavigation(VIEW_ID, 'https://other.example/')

    expect(writes).toHaveLength(1)
  })
})

describe('the bar is raised again on the page the sign-in landed on', () => {
  it('asks again when the document that loaded is the page the credential belongs to', () => {
    /*
      Without this the feature fails silently in its most common case: the bar was drawn into the
      document the sign-in navigated away from, so the question is never seen and no password is ever
      offered for saving.
    */
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.documentReady(view, frame({ url: `${LOGIN_ORIGIN}/welcome` }))

    expect(barMessages(view)).toEqual([
      'Save the password for example.com?',
      'Save the password for example.com?'
    ])
  })

  it('asks at most twice, so a page reloading itself cannot ask for ever', () => {
    // `dom-ready` fires per document. A page in a reload loop would otherwise raise the same
    // question without end, which is how a prompt teaches people to dismiss prompts unread.
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.documentReady(view, frame())
    service.documentReady(view, frame())

    expect(view.sent).toHaveLength(2)
  })

  it('drops the offer instead of asking about it on a page belonging to another site', () => {
    // Landing somewhere else is not the redirect a sign-in caused, and the credential must not be
    // offered for saving against the site the user happens to be looking at now.
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.documentReady(view, frame({ url: 'https://other.example/' }))

    expect(view.sent).toHaveLength(1)
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('drops an offer that has waited longer than its time', () => {
    // The credential is held in main-process memory for this window and no longer; a document that
    // loads afterwards finds nothing to ask about.
    const { service, view, clock } = harness()
    service.reportSubmission(view, frame(), reportPayload())
    clock.now += PENDING_SAVE_TTL_MS + 1

    service.documentReady(view, frame())

    expect(view.sent).toHaveLength(1)
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('draws nothing when a document loads in a view with no question waiting', () => {
    // Every page load in every tab arrives here, so the ordinary case is that there is nothing to do.
    const { service, view } = harness()

    service.documentReady(view, frame())

    expect(view.sent).toEqual([])
  })

  it('does not bring back a bar the user dismissed', () => {
    // A dismissal that came back on the next document would be worse than a bar that never appeared.
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())
    service.answerSave(view, 'dismiss')

    service.documentReady(view, frame())

    expect(view.sent).toHaveLength(1)
  })
})

describe('what the user pressed on the save bar', () => {
  it('stores the credential through the writer for the window the view belongs to', () => {
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.answerSave(view, 'save')

    expect(writes).toEqual([
      {
        mode: 'normal',
        call: 'save',
        input: { url: LOGIN_URL, username: STORED.username, password: SUBMITTED }
      }
    ])
  })

  it('files the credential under the page it was typed into, not wherever the view ended up', () => {
    /*
      What stops a redirect chain from parking a credential on the wrong site — and what makes a
      password given to a phishing page be remembered for the phishing page, so it is never offered
      on the site it was stolen from.
    */
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())
    service.noteNavigation(VIEW_ID, `${LOGIN_ORIGIN}/oauth/callback`)
    service.documentReady(view, frame({ url: `${LOGIN_ORIGIN}/dashboard` }))

    service.answerSave(view, 'save')

    const [write] = writes.slice(0, 1)
    expect(write?.call === 'save' ? write.input.url : null).toBe(LOGIN_URL)
  })

  it('writes a never-saved origin for never here, and stores no credential', () => {
    // Kept so the bar is not nagware: a site the user has decided not to trust the manager with must
    // not ask again on every sign-in.
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.answerSave(view, 'never')

    expect(writes).toEqual([{ mode: 'normal', call: 'never', url: LOGIN_URL }])
  })

  it('writes nothing at all for a dismissal', () => {
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.answerSave(view, 'dismiss')

    expect(writes).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('writes nothing for an answer it does not recognise, and keeps nothing after it', () => {
    // A renderer chooses what it sends on this channel. An unknown verb is not a save, and the
    // credential is dropped rather than left waiting for a better-formed second attempt.
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.answerSave(view, 'save-everywhere')

    expect(writes).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('answers once: a second press stores nothing more', () => {
    // A forged or repeated answer can at worst store the credential the user had just typed into
    // that page — and only once, because the pending state is cleared on the first.
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.answerSave(view, 'save')
    service.answerSave(view, 'save')

    expect(writes).toHaveLength(1)
  })

  it('writes nothing when no question was up at all', () => {
    const { service, view, writes } = harness()

    service.answerSave(view, 'save')

    expect(writes).toEqual([])
  })

  it('writes nothing when the vault locked while the bar was up', () => {
    /*
      "The vault is closed" has to mean the same thing whether the closing happened before the
      question or during it. Not stored through a discarding writer and reported as saved, and not
      held until the next unlock: the credential is dropped, and no writer is asked for.
    */
    const { service, view, state, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    state.unlocked = false
    service.answerSave(view, 'save')

    expect(writes).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
  })

  it('writes nothing once the offer has outlived its window', () => {
    // Two minutes is how long a credential may sit in memory; an answer after that has nothing to
    // store, which is the same answer as pressing Save on a bar nobody was holding a credential for.
    const { service, view, clock, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())
    clock.now += PENDING_SAVE_TTL_MS + 1

    service.answerSave(view, 'save')

    expect(writes).toEqual([])
  })

  it('writes nothing when the clock has moved backwards under the offer', () => {
    // A timestamp in the future is a resumed laptop or an NTP correction, not a fresh submission, and
    // treating it as one would make the two-minute window unbounded.
    const { service, view, clock, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())
    clock.now -= 1

    service.answerSave(view, 'save')

    expect(writes).toEqual([])
  })

  it('writes nothing for a view that no longer belongs to a window', () => {
    const { service, view, state, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    state.mode = null
    service.answerSave(view, 'save')

    expect(writes).toEqual([])
  })
})

describe('a lock means the same thing to a bar that is already up', () => {
  it('drops every submitted credential waiting for an answer', () => {
    /*
      Wired to `PasswordVault.onLock`. Without it a lock would be a half-truth: the key would be gone
      from the vault while a password the user typed two minutes ago sat in this map for the rest of
      its two minutes.
    */
    const { service, view } = harness()
    const other = fakeView(OTHER_VIEW_ID)
    service.reportSubmission(view, frame(), reportPayload())
    service.reportSubmission(other, frame(), reportPayload())

    service.dropPendingSaves()

    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
    expect(service.hasPendingSave(OTHER_VIEW_ID)).toBe(false)
  })

  it('leaves nothing for a later answer to store', () => {
    // The bar is still on screen — it lives in the page's document — so the answer still arrives.
    // It has to find nothing.
    const { service, view, writes } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.dropPendingSaves()
    service.answerSave(view, 'save')

    expect(writes).toEqual([])
  })

  it('raises no bar afterwards on the page the sign-in lands on', () => {
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.dropPendingSaves()
    service.documentReady(view, frame())

    expect(view.sent).toHaveLength(1)
  })

  it('keeps the record of input, so the first fill after an unlock is not refused', () => {
    // Deliberately not cleared: a gesture timestamp is a record of input, not a secret, and dropping
    // it would make the fill immediately after an unlock refuse for want of a gesture — which the
    // user would read as the feature being broken by their own unlock.
    const { service, view } = harness()
    press(service)

    service.dropPendingSaves()

    expect(service.fillFor(view, frame(), chose(service))?.password).toBe(SECRET)
  })
})

describe('a destroyed view leaves nothing behind', () => {
  it('releases both the pending credential and the record of input', () => {
    const { service, view, writes } = harness()
    press(service)
    service.reportSubmission(view, frame(), reportPayload())

    service.forget(VIEW_ID)

    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
    expect(
      service.fillFor(view, frame(), chose(service)),
      'the gesture outlived the view'
    ).toBeNull()
    service.answerSave(view, 'save')
    expect(writes).toEqual([])
  })

  it('leaves the other views alone', () => {
    // One tab closing must not take the save bar out of another.
    const { service, view } = harness()
    service.reportSubmission(view, frame(), reportPayload())

    service.forget(OTHER_VIEW_ID)

    expect(service.hasPendingSave(VIEW_ID)).toBe(true)
  })
})

/**
 * The second consent source: a fill the user asked for from browser chrome.
 *
 * A toolbar press, a shortcut or a context-menu item happens in a view the page cannot reach and
 * never touches the page's input pipeline, so it can produce no `input-event` in the tab — there is
 * nothing for `noteInput` to record and nothing a five-second window could be measured from. Its
 * proof is its provenance, and the core states that proof by opening a request.
 *
 * Everything below is about the price of that: while the request is open, `no-user-gesture` is
 * satisfied for the view, so a request nobody closed is the rule switched off for that tab. Each
 * ending is asserted on its own, because a catch-all that covered four of the five would look
 * exactly like this suite passing.
 */
describe('a fill the user asked for from browser chrome', () => {
  const REQUEST = 'fill-request-1'

  it('authorises a fill with no input event in the page at all', () => {
    // AE5. The rest of the rules are `fill-policy.ts`'s and are tested there against the same
    // consent; what is asserted here is that the core mints one from a request it opened itself.
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, REQUEST)

    expect(service.fillFor(view, frame(), chose(service))?.password).toBe(SECRET)
  })

  it('builds a list with no input event either, so there is something to choose from', () => {
    /*
      The path the Unlock button takes back: by the time the person has typed a master password the
      five-second gesture window is long gone, so the list has to be decidable from the chrome
      request alone. `suggestFor` is the entry point that does not demand a press of its own.
    */
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, REQUEST)

    expect(service.suggestFor(view, frame(), form())).toEqual({
      state: 'entries',
      entries: [{ id: STORED.id, username: STORED.username }]
    })
  })

  it('does not spend the request on merely being asked what could be filled', () => {
    // The list is drawn before the user has picked anything. Spending the one-shot on the question
    // would refuse the answer.
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, REQUEST)

    service.suggestFor(view, frame(), form())

    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
  })

  it('is spent by the first fill it authorises', () => {
    // AE8. The page can ask again on its own channel the moment the first fill lands — a renderer
    // chooses when it sends — and the second attempt has to find nothing left.
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, REQUEST)

    expect(service.fillFor(view, frame(), chose(service))).not.toBeNull()

    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
  })

  it('is spent even when the entry disappeared between the decision and the fetch', () => {
    // Deleted on the passwords page while the surface was up. The consent was already used to
    // authorise; leaving it alive would let the page retry against a refusal it caused.
    const { service, view } = harness({ secrets: {} })
    service.noteChromeRequest(VIEW_ID, REQUEST)

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('is not spent by a fill the rules refused, because none was authorised', () => {
    // A refusal is not a use. The user asked for a fill and has not had one, so the request stands
    // until one of its endings — otherwise a page could burn the consent by racing with a subframe.
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, REQUEST)

    expect(service.fillFor(view, frame({ isTopLevel: false }), chose(service))).toBeNull()
    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
  })

  it('is left unspent while a page-view gesture would have served', () => {
    // The one-shot is the scarce one. Spending it when an ordinary press was available would cost
    // the user their next fill for nothing.
    const { service, view } = harness()
    press(service)
    service.noteChromeRequest(VIEW_ID, REQUEST)

    expect(service.fillFor(view, frame(), chose(service))).not.toBeNull()
    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
  })

  it('does not spend a page gesture, so a two-step sign-in fills its second field too', () => {
    // The contrast that makes the paragraph above true: an input event is a record with a life of
    // its own, not a token, and the five-second window is the only thing that ends it.
    const { service, view } = harness()
    press(service)

    expect(service.fillFor(view, frame(), chose(service))).not.toBeNull()
    expect(service.fillFor(view, frame(), chose(service))).not.toBeNull()
  })

  it('belongs to the view it was opened for', () => {
    // A request opened for the tab the user is looking at must not authorise a fill in a background
    // tab, for the same reason the gesture record is keyed by view.
    const { service, view } = harness()
    service.noteChromeRequest(OTHER_VIEW_ID, REQUEST)

    expect(service.fillFor(view, frame(), chose(service))).toBeNull()
  })

  it('is opened by nothing that arrives from a page view', () => {
    /*
      The property that keeps the second source out of the page's reach. Every message a preload can
      send is played through here, and none of them may leave a consent behind — if one did, a page
      could mint the very thing the gesture rule exists to withhold.
    */
    const { service, view } = harness()

    service.badgePressed(view, frame(), form())
    press(service)
    service.badgePressed(view, frame(), form())
    service.fillFor(view, frame(), chose(service))
    service.reportSubmission(view, frame(), reportPayload())
    service.answerSave(view, 'save')
    service.documentReady(view, frame())
    service.noteFillableForm(view, true)

    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })
})

describe('every ending of a chrome request, one at a time', () => {
  const REQUEST = 'fill-request-1'

  /** Opens a request, applies one ending, and reports what is left of the consent. */
  function afterEnding(ending: (service: AutofillService, view: AutofillView) => void): {
    open: boolean
    filled: boolean
  } {
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, REQUEST)
    ending(service, view)
    return {
      open: service.hasChromeRequest(VIEW_ID),
      filled: service.fillFor(view, frame(), chose(service)) !== null
    }
  }

  it('drops it when the surface leaves the overlay layer', () => {
    // The user pressed Escape, or something higher-ranking took the layer. Either way the question
    // is no longer on screen, and a consent nobody can see is one nobody can withdraw.
    expect(afterEnding((service) => service.dropChromeRequest(VIEW_ID))).toEqual({
      open: false,
      filled: false
    })
  })

  it('drops it on any main-frame navigation, including one inside the same site', () => {
    /*
      Stricter than the pending save deliberately, and the asymmetry is the point: a save bar is
      about the page the user came *from* and has to survive the redirect a sign-in causes, while a
      consent is about the document in front of them. The form it was granted for is gone.
    */
    expect(
      afterEnding((service) => service.noteNavigation(VIEW_ID, `${LOGIN_ORIGIN}/welcome`))
    ).toEqual({ open: false, filled: false })
  })

  it('drops it when the vault locks', () => {
    // The fill it was granted for cannot be served from a sealed vault. Carrying it across the
    // unlock would let it be spent on a form the user never came back to.
    expect(afterEnding((service) => service.dropPendingSaves())).toEqual({
      open: false,
      filled: false
    })
  })

  it('drops it when the view is forgotten', () => {
    expect(afterEnding((service) => service.forget(VIEW_ID))).toEqual({
      open: false,
      filled: false
    })
  })

  it('leaves the other views alone when one of them ends', () => {
    const { service, view } = harness()
    service.noteChromeRequest(VIEW_ID, REQUEST)
    service.noteChromeRequest(OTHER_VIEW_ID, 'fill-request-2')

    service.dropChromeRequest(OTHER_VIEW_ID)

    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
    expect(service.fillFor(view, frame(), chose(service))).not.toBeNull()
  })

  it('has nothing to drop for a view that never asked', () => {
    const { service } = harness()

    service.dropChromeRequest(VIEW_ID)

    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })
})

/**
 * The gate the input listener hangs on, which is the whole of the defect this replaces.
 *
 * `input-event` is not attached for the life of a view: every mouse press in every tab would cost a
 * main-process round trip, for tabs that will never fill anything. The gate used to be a non-null
 * offer — and `decideFill` refuses an offer for want of the gesture the listener was there to record,
 * so no view ever got one and autofill could not fill anything at all, in any tab, ever, with every
 * test passing. What gates it now is a fact the page can state before any rule has been applied.
 */
describe('whether the core wants to hear the input events of a view', () => {
  it('wants them once a view reports a fillable form', () => {
    const { service, view } = harness()

    expect(service.noteFillableForm(view, true)).toBe(true)
  })

  it('stops wanting them once the field is no longer there', () => {
    const { service, view } = harness()

    expect(service.noteFillableForm(view, false)).toBe(false)
  })

  it('never wants them while autofill is switched off', () => {
    // Somebody who switched this off must not have their presses in every tab reported to the main
    // process, which is the cost the subscription carries.
    const { service, view } = harness({ enabled: false })

    expect(service.noteFillableForm(view, true)).toBe(false)
  })

  it('reads anything that is not exactly true as no', () => {
    // A renderer chooses what it sends. The report is one boolean and nothing else is a report.
    const { service, view } = harness()

    const reports: Array<{ readonly named: string; readonly reported: unknown }> = [
      { named: 'the string true', reported: 'true' },
      { named: 'a number', reported: 1 },
      { named: 'an object', reported: {} },
      { named: 'an array', reported: [] },
      { named: 'null', reported: null },
      { named: 'nothing at all', reported: undefined }
    ]
    for (const { named, reported } of reports) {
      expect(service.noteFillableForm(view, reported), named).toBe(false)
    }
  })
})

describe('what the toolbar key and the context menu may know', () => {
  it('shows a locked vault as locked, and counts nothing while it is', () => {
    const { service, reads } = harness({ unlocked: false })

    expect(service.keyState(LOGIN_URL)).toEqual({ vault: 'locked', matches: 0 })
    expect(reads.lists, 'a sealed vault was asked for its summaries').toBe(0)
  })

  it('counts the entries saved for the page, and none for another site', () => {
    const { service } = harness()

    expect(service.keyState(LOGIN_URL)).toEqual({ vault: 'open', matches: 1 })
    expect(service.keyState('https://other.example/')).toEqual({ vault: 'open', matches: 0 })
    expect(service.keyState(null)).toEqual({ vault: 'open', matches: 0 })
  })

  it('is off while autofill is switched off, whatever the vault holds', () => {
    const { service } = harness({ enabled: false })

    expect(service.keyState(LOGIN_URL)).toEqual({ vault: 'off', matches: 0 })
  })

  it('knows a fillable field has focus only from the page’s last report, and forgets it', () => {
    const { service, view, state } = harness()
    expect(service.hasFillableFocus(VIEW_ID)).toBe(false)

    service.noteFillableForm(view, true)
    expect(service.hasFillableFocus(VIEW_ID)).toBe(true)
    state.enabled = false
    expect(service.hasFillableFocus(VIEW_ID), 'offered with autofill switched off').toBe(false)
    state.enabled = true

    service.noteFillableForm(view, false)
    expect(service.hasFillableFocus(VIEW_ID)).toBe(false)
    service.noteFillableForm(view, true)
    service.forget(VIEW_ID)
    expect(service.hasFillableFocus(VIEW_ID)).toBe(false)
  })

  it('does not take a report made while switched off as a fillable field', () => {
    const { service, view, state } = harness({ enabled: false })

    service.noteFillableForm(view, true)
    state.enabled = true

    expect(service.hasFillableFocus(VIEW_ID)).toBe(false)
  })
})

/**
 * The registry that carries master-password keystrokes from the overlay layer to the one service
 * collecting them.
 *
 * It is module-level state, so every subscription below is undone through the unsubscribe
 * `onOverlayKey` hands back — a listener leaked out of one test would be called by the next one,
 * which for this registry means receiving characters of a master password it never asked for.
 */
describe('the keystrokes taken out of the input pipeline', () => {
  const undo: Array<() => void> = []

  afterEach(() => {
    for (const unsubscribe of undo.splice(0)) unsubscribe()
    vi.restoreAllMocks()
  })

  function listen(
    listener: (presentation: MasterPasswordPresentation, input: PromptKey) => void
  ): void {
    undo.push(
      onOverlayKey((presentation, input) => {
        if (presentation.kind !== 'master-password') return
        listener(presentation, input)
      })
    )
  }

  const PROMPT: MasterPasswordPresentation = {
    kind: 'master-password',
    requestId: 'mp-1',
    purpose: 'unlock',
    step: 'current',
    filled: 0,
    problem: null,
    minLength: 12
  }

  function keystroke(overrides: Partial<PromptKey> = {}): PromptKey {
    return {
      type: 'keyDown',
      key: 'a',
      control: false,
      meta: false,
      alt: false,
      shift: false,
      isComposing: false,
      ...overrides
    }
  }

  it('hands a listener the surface and the keystroke it was notified with', () => {
    const seen: Array<{ requestId: string; key: string }> = []
    listen((presentation, input) => {
      seen.push({ requestId: presentation.requestId, key: input.key })
    })

    notifyOverlayKey(PROMPT, keystroke({ key: 'q' }))

    expect(seen).toEqual([{ requestId: 'mp-1', key: 'q' }])
  })

  it('stops calling a listener that has unsubscribed', () => {
    // The only way to stop receiving master-password characters, and therefore the only way a test
    // can be written here at all.
    const seen: string[] = []
    const unsubscribe = onOverlayKey((_presentation, input) => {
      seen.push(input.key)
    })
    // Also handed to the cleanup: unsubscribing twice is harmless, and a failure before the call
    // below would otherwise leave this listener collecting keystrokes for the rest of the file.
    undo.push(unsubscribe)

    notifyOverlayKey(PROMPT, keystroke({ key: 'x' }))
    unsubscribe()
    notifyOverlayKey(PROMPT, keystroke({ key: 'y' }))

    expect(seen).toEqual(['x'])
  })

  it('calls the next listener after one has thrown', () => {
    // A keystroke lost because an unrelated subscriber threw would be a character silently missing
    // from a master password — an entry the user cannot reproduce and cannot see the reason for.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    listen(() => {
      throw new Error('the first listener is unwell')
    })
    listen((_presentation, input) => {
      seen.push(input.key)
    })

    notifyOverlayKey(PROMPT, keystroke({ key: 'z' }))

    expect(seen).toEqual(['z'])
  })

  it('logs that a listener threw and nothing whatever about the keystroke', () => {
    /*
      The security-relevant one. The thing that threw was handed a character of a master password,
      and an error message is the most-copied string in any program — into a terminal, an issue, a
      crash report. So the `catch` discards the error object entirely rather than logging it.
    */
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    listen((presentation, input) => {
      throw new Error(`could not handle ${input.key} for ${presentation.requestId}`)
    })

    notifyOverlayKey({ ...PROMPT, requestId: 'mp-unrepeatable' }, keystroke({ key: 'ß' }))

    expect(spy).toHaveBeenCalledTimes(1)
    const logged = spy.mock.calls.flat().map(String).join(' ')
    expect(logged, 'a master password character reached a log line').not.toContain('ß')
    expect(logged, "the thrower's own message was logged").not.toContain('could not handle')
    expect(logged, 'the surface being typed into was named').not.toContain('mp-unrepeatable')
  })

  it('does not skip a listener that an earlier one removed mid-notification', () => {
    // The set is copied before it is walked, so the list of subscribers cannot change underneath a
    // keystroke that is already being delivered. Walking the live set instead would drop this
    // character for the second listener — a bullet on screen that the buffer never received.
    const seen: string[] = []
    // Registered first, so it is the one called first: insertion order is iteration order.
    let removeSecond: (() => void) | null = null
    undo.push(
      onOverlayKey(() => {
        removeSecond?.()
      })
    )
    const second = onOverlayKey((_presentation, input) => {
      seen.push(input.key)
    })
    undo.push(second)
    removeSecond = second

    notifyOverlayKey(PROMPT, keystroke({ key: 'k' }))
    notifyOverlayKey(PROMPT, keystroke({ key: 'l' }))

    expect(seen, 'the keystroke in flight was lost, or the removal did not take').toEqual(['k'])
  })
})

/**
 * `passwords.autofill`, which until now was not a thing anybody could switch off.
 *
 * The feature reads every login form in every page and can put a secret into one, and it had no way
 * out — reported as there being no Passwords section in the settings at all, of which this was the
 * missing half that mattered. The switch is checked at all three ways in rather than at one central
 * point, because there is no central point: the three arrive on their own channels from a preload
 * that knows nothing about settings.
 *
 * What is asserted here is that each of the three refuses on its own. A test that only covered the
 * badge would leave "off" meaning "no list, but still fills and still asks to save", which is the
 * shape a partial gate always takes.
 */
describe('autofill switched off', () => {
  it('names the setting rather than building a list, and does not ask the vault for one', () => {
    // The same standard the locked vault is held to: the busiest page-triggerable path must not even
    // reach the summaries, because reaching them is how a list of the user's accounts gets built.
    const { service, view, reads } = harness({ enabled: false })
    press(service)

    expect(service.badgePressed(view, frame(), form())).toEqual({ state: 'disabled' })
    expect(reads.lists, 'a switched-off feature asked the vault for its summaries').toBe(0)
  })

  it('fills nothing, even for a choice made before it was switched off', () => {
    /*
      A choice is never a licence that can be spent later. Somebody switching this off usually does
      it *because* of the form in front of them, so the list they are looking at was drawn while it
      was still on — and a click on it must not go through.
    */
    const { service, view, state, reads } = harness()
    press(service)
    const request = chose(service)

    state.enabled = false
    expect(service.fillFor(view, frame(), request)).toBeNull()
    expect(reads.secrets, 'a secret was fetched for a fill that was refused').toEqual([])
  })

  it('does not offer to save what was submitted, and keeps nothing while it decides not to', () => {
    /*
      The path that arrives holding a password. Returning before anything is stored means the
      credential is dropped where it was read rather than sitting in main-process memory for two
      minutes against a bar that is never going up.
    */
    const { service, view, writes } = harness({ enabled: false })
    service.reportSubmission(view, frame(), reportPayload())

    expect(view.sent).toEqual([])
    expect(service.hasPendingSave(VIEW_ID)).toBe(false)
    expect(writes).toEqual([])
  })

  it('is read per call, so switching it back on needs no new page', () => {
    // Spec 5, and the reason `enabled` is a function rather than a value: a captured flag would make
    // this a setting that applies to the next document rather than to this one.
    const { service, view, state } = harness({ enabled: false })
    press(service)
    expect(service.badgePressed(view, frame(), form())).toEqual({ state: 'disabled' })

    state.enabled = true
    expect(service.badgePressed(view, frame(), form())).toEqual({
      state: 'entries',
      entries: [{ id: STORED.id, username: STORED.username }]
    })
  })
})
