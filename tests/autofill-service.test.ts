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
import { FILL_GESTURE_WINDOW_MS } from '@shared/passwords/fill-policy.js'
import type { BrowsingMode, PasswordSummary, SaveCredentialInput } from '@shared/passwords/model.js'
import type { PromptKey } from '@shared/passwords/prompt.js'
import type { StoredCredentialState } from '@shared/passwords/save-policy.js'
import {
  AUTOFILL_SAVE_PROMPT_CHANNEL,
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
 *   - A private window does not offer to save, and a fill in one is noted through a writer bound to
 *     that mode — so a private sign-in leaves no timestamp on disk.
 *   - `dropPendingSaves` is what makes a lock mean what it says. Autofill holds one submitted
 *     credential per view in memory while its save bar is up; without this, a password the user
 *     typed two minutes ago outlives the lock for the rest of the bar's life.
 *   - `noteNavigation` and `documentReady` together are the whole reason the save bar is ever seen:
 *     a sign-in navigates, so the offer has to survive that navigation and be raised again on the
 *     page the user landed on. Get the second half wrong and the feature fails silently — the bar is
 *     drawn into a document that is already gone and the question is never asked.
 *   - `offerFor` and `fillFor` answer a value rather than throwing, because they are answered
 *     synchronously into a preload and a throw there takes the whole page down with it.
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
  mode: BrowsingMode | null
  locale: Locale
}

interface HarnessOptions {
  readonly unlocked?: boolean
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

function fillPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: STORED.id, form: formPayload(), ...overrides }
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

describe('an offer is built from the frame the core read, not from the message', () => {
  it('offers the usernames saved for the site, worded for the site the frame is on', () => {
    const { service, view } = harness()
    press(service)

    const offer = service.offerFor(view, frame(), formPayload())

    expect(offer?.entries).toEqual([{ id: STORED.id, username: STORED.username }])
    // The registrable domain, not the frame's host or its path: the heading names the site the user
    // thinks they are on, and it is assembled here because the preload has no translator.
    expect(offer?.chrome.title).toBe('Saved for example.com')
  })

  it('puts no password in the offer, which a page can make fire whenever it likes', () => {
    // A focus event is the one message on these channels an attacker can trigger repeatedly, so it
    // has to be worthless when it does. The type says so; this says so of the value that was built.
    const { service, view } = harness()
    press(service)

    expect(JSON.stringify(service.offerFor(view, frame(), formPayload()))).not.toContain(SECRET)
  })

  it('answers null rather than an empty offer when the site has nothing saved', () => {
    // Not an empty suggestion list: drawing one would tell the page that the user has *no*
    // credential for it, which is itself a small fact about the user.
    const { service, view } = harness({
      summaries: [{ ...STORED, origin: 'https://other.example' }]
    })
    press(service)

    expect(service.offerFor(view, frame(), formPayload())).toBeNull()
  })

  it('answers a value rather than throwing when the description is not a form', () => {
    // Answered synchronously into a preload, where a throw takes the whole page down with it.
    const { service, view } = harness()
    press(service)

    expect(service.offerFor(view, frame(), 'not a form')).toBeNull()
    expect(service.offerFor(view, frame(), { action: null, fields: 'lots' })).toBeNull()
    expect(service.offerFor(view, frame(), undefined)).toBeNull()
  })

  it('offers nothing while the vault is locked, without asking it for a list at all', () => {
    /*
      The busiest page-triggerable path in the feature, and the refusal comes before the form is even
      looked at. A locked vault answers `[]` to `list()`, so a check derived from an empty list would
      read as "a site with no credentials" — the service asks about the state instead.
    */
    const { service, view, reads } = harness({ unlocked: false })
    press(service)

    expect(service.offerFor(view, frame(), formPayload())).toBeNull()
    expect(reads.lists, 'a locked vault was asked for its summaries').toBe(0)
  })

  it('offers nothing to a view this browser cannot place in a window', () => {
    // A devtools window, or something being torn down. Anything unaccounted for has to mean no.
    const { service, view } = harness({ mode: null })
    press(service)

    expect(service.offerFor(view, frame(), formPayload())).toBeNull()
  })

  it('offers nothing to a login page somebody else has framed', () => {
    /*
      The refusal itself is `fill-policy.ts`'s, and tested there. What is asserted here is that the
      service builds its context out of the frame facts it was handed — the message has no field with
      which to claim otherwise — so a subframe gets nothing even though the same call from the top
      document is served.
    */
    const { service, view } = harness()
    press(service)

    expect(
      service.offerFor(
        view,
        frame({ isTopLevel: false, topLevelUrl: 'https://evil.example/' }),
        formPayload()
      )
    ).toBeNull()
    expect(
      service.offerFor(view, frame(), formPayload()),
      'the same form at the top was refused too'
    ).not.toBeNull()
  })

  it('offers nothing when the frame claims the top while the document above it is another site', () => {
    const { service, view } = harness()
    press(service)

    expect(
      service.offerFor(view, frame({ topLevelUrl: 'https://evil.example/' }), formPayload())
    ).toBeNull()
  })

  it('offers nothing when the frame tree could not be read', () => {
    // A frame torn down mid-message. "Unknown" has to mean no, not "probably the same".
    const { service, view } = harness()
    press(service)

    expect(service.offerFor(view, frame({ topLevelUrl: null }), formPayload())).toBeNull()
  })

  it('reads the language on every offer, so a change reaches the next form and not the next restart', () => {
    const { service, view, state } = harness()
    press(service)

    expect(service.offerFor(view, frame(), formPayload())?.chrome.title).toBe(
      'Saved for example.com'
    )
    state.locale = 'de'
    expect(service.offerFor(view, frame(), formPayload())?.chrome.title).toBe(
      'Gespeichert für example.com'
    )
  })
})

describe('a fill needs an input event the browser process itself saw', () => {
  it('serves a fill inside the gesture window', () => {
    const { service, view } = harness()
    press(service)

    expect(service.fillFor(view, frame(), fillPayload())).toEqual({
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

    expect(service.fillFor(view, frame(), fillPayload())).toBeNull()
    expect(reads.secrets, 'a refused fill fetched the password anyway').toEqual([])
  })

  it('refuses a fill whose gesture has gone stale', () => {
    // A click banked a minute ago is not consent to a form the user has not touched since.
    const { service, view, clock } = harness()
    press(service)
    clock.now += FILL_GESTURE_WINDOW_MS + 1

    expect(service.fillFor(view, frame(), fillPayload())).toBeNull()
  })

  it('does not take a pointer drifting across the page for a gesture', () => {
    // `noteInput` is called for *every* input event; most are not gestures. A mouse resting over a
    // page while the user reads would otherwise hold the window open for as long as they stayed.
    const { service, view } = harness()
    service.noteInput(VIEW_ID, { type: 'mouseMove' })

    expect(service.fillFor(view, frame(), fillPayload())).toBeNull()

    press(service)
    expect(service.fillFor(view, frame(), fillPayload())).not.toBeNull()
  })

  it('keeps the record per view, so a click in one tab does not authorise a fill in another', () => {
    // The map is keyed by web-contents id for this reason: a background tab must not be able to
    // spend a gesture the user made in the tab they are looking at.
    const { service, view } = harness()
    press(service, OTHER_VIEW_ID)

    expect(service.fillFor(view, frame(), fillPayload())).toBeNull()
  })
})

describe('the fill answer, and the trace it leaves', () => {
  it('notes the use through the writer bound to the window the view belongs to', () => {
    const { service, view, writes } = harness()
    press(service)
    service.fillFor(view, frame(), fillPayload())

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

    expect(service.fillFor(view, frame(), fillPayload())?.password).toBe(SECRET)
    expect(writes).toEqual([{ mode: 'private', call: 'used', id: STORED.id }])
  })

  it('refuses an id the renderer was never offered', () => {
    const { service, view, writes } = harness()
    press(service)

    expect(service.fillFor(view, frame(), fillPayload({ id: 'pw-invented' }))).toBeNull()
    expect(writes).toEqual([])
  })

  it('refuses a fill for a form whose action has been rewritten since the offer', () => {
    /*
      The offer is not a token that can be spent later. Between the suggestion being drawn and the
      click on it, a script on the page can rewrite the form's action — so every rule is applied
      again, against the form as it is *now*, and against the same id that was offered a moment ago.
    */
    const { service, view } = harness()
    press(service)
    expect(
      service.offerFor(view, frame(), formPayload()),
      'nothing was offered to spend'
    ).not.toBeNull()

    const moved = fillPayload({ form: formPayload({ action: 'https://evil.example/collect' }) })
    expect(service.fillFor(view, frame(), moved)).toBeNull()
  })

  it('refuses a fill that arrives from a subframe after being offered at the top', () => {
    // The other half of "not a token": a page that moved the form into a frame between the offer and
    // the click gets a refusal, because the frame facts are read again on this side.
    const { service, view } = harness()
    press(service)
    service.offerFor(view, frame(), formPayload())

    expect(service.fillFor(view, frame({ isTopLevel: false }), fillPayload())).toBeNull()
  })

  it('answers a value rather than throwing when the request is not a request', () => {
    const { service, view } = harness()
    press(service)

    expect(service.fillFor(view, frame(), 'pw-1')).toBeNull()
    expect(service.fillFor(view, frame(), fillPayload({ id: '' }))).toBeNull()
    expect(service.fillFor(view, frame(), { id: STORED.id })).toBeNull()
  })

  it('refuses a fill after the vault locked between the suggestion and the click', () => {
    // An idle timeout is a clock, not an event the page waits for, so this is an ordinary race. The
    // secret must not be fetched on the way to the refusal.
    const { service, view, state, reads } = harness()
    press(service)
    expect(service.offerFor(view, frame(), formPayload())).not.toBeNull()

    state.unlocked = false
    expect(service.fillFor(view, frame(), fillPayload())).toBeNull()
    expect(reads.secrets).toEqual([])
  })

  it('refuses when the entry disappeared between the decision and the fetch', () => {
    // Deleted on the passwords page while the suggestion was on screen. Nothing is filled, and no
    // use is recorded for a fill that did not happen.
    const { service, view, writes } = harness({ secrets: {} })
    press(service)

    expect(service.fillFor(view, frame(), fillPayload())).toBeNull()
    expect(writes).toEqual([])
  })

  it('refuses a fill into a view this browser cannot place in a window', () => {
    const { service, view } = harness({ mode: null })
    press(service)

    expect(service.fillFor(view, frame(), fillPayload())).toBeNull()
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

    expect(service.fillFor(view, frame(), fillPayload())?.password).toBe(SECRET)
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
      service.fillFor(view, frame(), fillPayload()),
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
