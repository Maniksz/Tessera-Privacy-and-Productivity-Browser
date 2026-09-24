import { describe, expect, it } from 'vitest'
import {
  AutofillService,
  type AutofillFrame,
  type AutofillVault,
  type AutofillView
} from '@main/passwords/AutofillService.js'
import {
  AutofillSuggest,
  CHROME_ASK_TTL_MS,
  type SuggestTarget,
  type SuggestWindow
} from '@main/passwords/AutofillSuggest.js'
import {
  mayPresentOver,
  surfaceIdentity,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import type { PasswordSummary } from '@shared/passwords/model.js'
import { AUTOFILL_DESCRIBE_CHANNEL, AUTOFILL_SUGGEST_END_CHANNEL } from '@shared/passwords/wire.js'

/**
 * The account picker's life: a press on the badge, an answer on the overlay layer, a fill.
 *
 * `AutofillService` owns *what the answer is* and is tested next door; this file owns everything
 * that only happens because there is a window involved, and every one of those has a way of failing
 * that no rule about credentials would catch:
 *
 *   - **A request left open is `no-user-gesture` switched off for that tab.** The request id *is* the
 *     chrome consent (`shared/passwords/consent.ts`), so the surface's departure has to discard it —
 *     and two departures must not, because in both the flow is still running. Every ending below is
 *     asserted separately, because a catch-all that covered four of five would look exactly like this
 *     suite passing.
 *   - **The master-password prompt must never be raised straight from a page-view message** (R9). The
 *     picker's own Unlock button raises it, and that button is on a surface in browser chrome. A
 *     regression here is invisible: the prompt appears, which is what the user wanted, and the
 *     property that a page cannot summon it is gone.
 *   - **A press that cannot be answered visibly must leave nothing behind** (R8's two named
 *     exceptions). Both are silence, and silence is indistinguishable from a broken feature unless
 *     something asserts that no request was opened either.
 *   - **The layer is faked here as the real one behaves**, announcing departures and comparing
 *     identities, because the ordering between "take our surface down" and "hear that it went" is
 *     precisely where the consent would be thrown away one line too early.
 */

const NOW = 1_700_000_000_000
const VIEW_ID = 7
const SECRET = 'correct-horse-battery-staple'
const LOGIN_URL = 'https://accounts.example.com/login'

const STORED: PasswordSummary = {
  id: 'pw-1',
  origin: 'https://example.com',
  username: 'alice@example.com',
  createdAt: NOW,
  updatedAt: NOW,
  lastUsedAt: null
}

const TILE = { x: 0, y: 0, width: 1000, height: 800 }
const FIELD = { rect: { x: 100, y: 200, width: 240, height: 24 }, scale: 1, offsetX: 0, offsetY: 0 }

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

function formPayload(): Record<string, unknown> {
  return {
    action: '/session',
    fields: [fieldPayload({ type: 'text', name: 'user', autocomplete: 'username' }), fieldPayload()]
  }
}

function pressPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { form: formPayload(), field: FIELD, ...overrides }
}

interface FakeView extends AutofillView {
  readonly sent: Array<{ readonly channel: string; readonly payload: unknown }>
}

function fakeView(): FakeView {
  const sent: Array<{ readonly channel: string; readonly payload: unknown }> = []
  return {
    id: VIEW_ID,
    sent,
    isDestroyed: () => false,
    send: (channel, payload) => {
      sent.push({ channel, payload })
    }
  }
}

/**
 * The overlay layer of one window, behaving the way the real one does.
 *
 * Ranked claims, and a departure announced whenever a surface actually leaves — including the
 * identity comparison, which is what tells an *update* from a replacement. Without that comparison
 * here the test would pass while the real layer discarded the consent on every re-presentation.
 */
interface FakeWindow extends SuggestWindow {
  readonly presented: OverlayPresentation[]
  /** Parks something on the layer without going through the ranking, for the "declined" cases. */
  hold(presentation: OverlayPresentation): void
  onVacated(listener: (presentation: OverlayPresentation) => void): void
}

function fakeWindow(): FakeWindow {
  let current: OverlayState = null
  const presented: OverlayPresentation[] = []
  let vacated: (presentation: OverlayPresentation) => void = () => undefined

  return {
    presented,
    hold: (presentation) => {
      current = presentation
    },
    onVacated: (listener) => {
      vacated = listener
    },
    overlayPresentation: () => current,
    presentOverlay: (presentation) => {
      if (!mayPresentOver(presentation.kind, current)) return
      const outgoing = current
      current = presentation
      presented.push(presentation)
      if (outgoing !== null && surfaceIdentity(outgoing) !== surfaceIdentity(presentation)) {
        vacated(outgoing)
      }
    },
    dismissOverlay: () => {
      const outgoing = current
      current = null
      if (outgoing !== null) vacated(outgoing)
    }
  }
}

interface HarnessOptions {
  readonly unlocked?: boolean
  readonly summaries?: readonly PasswordSummary[]
  /** `null` for a view this browser cannot place — no tile, so nowhere to draw. */
  readonly placed?: boolean
  /** The browsing mode the service is told; `null` for a view that belongs to no window. */
  readonly mode?: 'normal' | null
  /** The tile the view is in; a small one leaves no room for a list. */
  readonly tile?: typeof TILE
}

function harness(options: HarnessOptions = {}) {
  const state = {
    unlocked: options.unlocked ?? true,
    /** Mutable, so a test can take the view off screen between two steps. */
    placed: options.placed ?? true,
    mode: options.mode === undefined ? ('normal' as const) : options.mode
  }
  const summaries = options.summaries ?? [STORED]
  const view = fakeView()
  const window = fakeWindow()
  const unlocks: SuggestWindow[] = []
  let settleUnlock: ((failed?: boolean) => void) | null = null

  const vault: AutofillVault = {
    isUnlocked: () => state.unlocked,
    list: () => [...summaries],
    summaryOf: (id) => summaries.find((summary) => summary.id === id) ?? null,
    secretOf: (id) => (id === STORED.id ? SECRET : null),
    neverSavedOrigins: () => [],
    compareStored: () => 'none',
    writerFor: () => ({
      save: () => 'created',
      neverSaveFor: () => undefined,
      noteUsed: () => undefined
    })
  }

  const service = new AutofillService({
    vault,
    enabled: () => true,
    modeFor: () => state.mode,
    locale: () => 'en',
    now: () => NOW
  })

  let requests = 0
  const clock = { now: NOW }
  const target: SuggestTarget = {
    window,
    tileIndex: 1,
    geometry: { bounds: options.tile ?? TILE, pageZoom: 1 }
  }
  const suggest = new AutofillSuggest({
    service,
    targetFor: () => (state.placed ? target : null),
    requestUnlock: async (host) => {
      unlocks.push(host)
      /*
        Presented the way the real prompt is: synchronously, from inside the call, displacing the
        picker. That displacement is the departure the flow has to survive, so a fake that only
        resolved a promise would test the easy half.
      */
      window.presentOverlay({
        kind: 'master-password',
        requestId: 'mp-1',
        purpose: 'unlock',
        step: 'current',
        filled: 0,
        problem: null,
        minLength: 10
      })
      await new Promise<void>((resolve, reject) => {
        settleUnlock = (failed = false) => {
          window.dismissOverlay()
          if (failed) reject(new Error('the prompt could not be shown'))
          else resolve()
        }
      })
    },
    newRequestId: () => {
      requests += 1
      return `suggest-${requests}`
    },
    now: () => clock.now
  })
  window.onVacated((presentation) => suggest.overlayVacated(presentation))

  /** A real input event in the page view, which is the only thing that opens the picker. */
  const gesture = (): void => service.noteInput(VIEW_ID, { type: 'mouseDown', button: 'left' })

  return {
    service,
    suggest,
    view,
    window,
    clock,
    state,
    unlocks,
    gesture,
    /** Finishes the master-password prompt the way answering it does. */
    finishUnlock: async (failed = false): Promise<void> => {
      settleUnlock?.(failed)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
  }
}

/** The picker on the layer, or `undefined` when something else is there. */
function picker(window: FakeWindow) {
  const presentation = window.overlayPresentation()
  return presentation?.kind === 'autofill-suggest' ? presentation : undefined
}

describe('pressing the badge puts the picker on the overlay layer', () => {
  it('draws the accounts for the site, anchored in the tile the field is in', () => {
    const { suggest, view, window, gesture } = harness()
    gesture()

    suggest.press(view, frame(), pressPayload())

    const surface = picker(window)
    expect(surface?.content).toEqual({
      state: 'entries',
      entries: [{ id: STORED.id, username: STORED.username }]
    })
    expect(surface?.tileIndex).toBe(1)
    // Below the field, inside the tile: the exact arithmetic is `suggest-bounds`'s and tested there.
    expect(surface?.bounds.y).toBeGreaterThan(FIELD.rect.y)
    expect(surface?.bounds.x).toBe(FIELD.rect.x)
  })

  it('opens the fill request that carries the choice, once there is something to choose', () => {
    // KTD4: the press is a page-view gesture with five seconds to live, and the person is about to
    // read a list. The consent that survives that reading is the request this opens.
    const { suggest, service, view, gesture } = harness()
    gesture()

    suggest.press(view, frame(), pressPayload())

    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
    expect(suggest.requestFor(VIEW_ID)).toBe('suggest-1')
    // A fill request open on a view keeps its tab loaded (U15).
    expect(service.waitsOn(VIEW_ID)).toBe(true)
  })

  it('opens no request behind a notice, because a notice has nothing to choose', () => {
    // A consent standing behind a sentence would be a standing permission with no question in front
    // of it — which is `no-user-gesture` switched off for the tab, bought with one press.
    const { suggest, service, view, window, gesture } = harness({ unlocked: false })
    gesture()

    suggest.press(view, frame(), pressPayload())

    expect(picker(window)?.content).toEqual({ state: 'locked' })
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('does nothing at all for a press the browser process did not see', () => {
    /*
      AE3, and R8's first named exception. Nothing on the layer, nothing sent to the page, no request
      open — the three things a page would otherwise learn from, and the third is the one that would
      matter next time.
    */
    const { suggest, service, view, window } = harness()

    suggest.press(view, frame(), pressPayload())

    expect(window.presented).toEqual([])
    expect(view.sent).toEqual([])
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('does nothing while something with a stronger claim holds the layer', () => {
    /*
      R8's second named exception. Checked before the vault is asked anything: `presentOverlay`
      declines silently, so opening the request first would leave a consent standing behind a surface
      that never appeared — and nothing would ever announce its departure, because it never arrived.
    */
    const { suggest, service, view, window, gesture } = harness()
    gesture()
    window.hold({
      kind: 'permission-request',
      requestId: 'perm-1',
      origin: 'https://accounts.example.com',
      subject: 'camera',
      devices: [],
      waiting: 0
    })

    suggest.press(view, frame(), pressPayload())

    expect(window.presented).toEqual([])
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
    expect(suggest.requestFor(VIEW_ID)).toBeNull()
    // Silence towards the page as well, which is what makes this the *exception* rather than a
    // fourth notice: discovering the refusal afterwards would answer a press with "the list went".
    expect(view.sent).toEqual([])
  })

  it('does nothing, and leaves nothing open, for a view it cannot place in a tile', () => {
    const { suggest, service, view, window, gesture } = harness({ placed: false })
    gesture()

    suggest.press(view, frame(), pressPayload())

    expect(window.presented).toEqual([])
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('refuses a press it cannot read, without asking the service anything', () => {
    const { suggest, view, window, gesture } = harness()
    gesture()

    suggest.press(view, frame(), { form: formPayload() })
    suggest.press(view, frame(), { form: formPayload(), field: { ...FIELD, scale: Number.NaN } })

    expect(window.presented).toEqual([])
  })

  it('tells the page the list went when the field is no longer on screen', () => {
    /*
      The page scrolled the field out from under its own badge between reading the rectangle and
      this line. There is nowhere to draw, so nothing is drawn — and the badge has to stop looking
      open, or it would sit lit over a field with no list in front of it for ever.
    */
    const { suggest, service, view, window, gesture } = harness()
    gesture()

    suggest.press(
      view,
      frame(),
      pressPayload({ field: { ...FIELD, rect: { ...FIELD.rect, y: -900 } } })
    )

    expect(window.presented).toEqual([])
    expect(view.sent).toEqual([{ channel: AUTOFILL_SUGGEST_END_CHANNEL, payload: null }])
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('replaces its own picker on a second press rather than stacking a consent', () => {
    const { suggest, service, view, window, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.press(view, frame(), pressPayload())

    expect(suggest.requestFor(VIEW_ID)).toBe('suggest-2')
    expect(picker(window)?.requestId).toBe('suggest-2')
    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
    // Not told the list went: the page is the one pressing again, and the badge stays lit through it.
    expect(view.sent).toEqual([])
  })
})

describe('choosing an account', () => {
  it('sends the page a token, takes the list down, and fills exactly once', () => {
    /*
      The whole flow, end to end, with nothing put in by hand: a gesture the browser process saw, a
      press, a choice in the chrome, and the page redeeming what came back. The consent has to
      outlive the surface by exactly one fill — the picker leaves before the page redeems, and a
      departure that discarded the request would refuse the fill it had just authorised.
    */
    const { suggest, service, view, window, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.choose('suggest-1', STORED.id)

    const [message] = view.sent
    expect(message?.channel).toBe(AUTOFILL_SUGGEST_END_CHANNEL)
    expect(typeof message?.payload).toBe('string')
    expect(picker(window), 'the list stayed up over the field it had just filled').toBeUndefined()

    const token = message?.payload as string
    expect(service.fillFor(view, frame(), { token, form: formPayload() })).toEqual({
      username: STORED.username,
      password: SECRET
    })
    expect(service.fillFor(view, frame(), { token, form: formPayload() })).toBeNull()
  })

  it('sends no account name back to the page, only the token', () => {
    const { suggest, view, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.choose('suggest-1', STORED.id)

    expect(JSON.stringify(view.sent)).not.toContain(STORED.username)
    expect(JSON.stringify(view.sent)).not.toContain(STORED.id)
  })

  it('ignores a choice for a request that is not on screen', () => {
    // A stale id, or an invented one. The answer may only resolve the question it was shown for, and
    // here that rule is stronger than elsewhere: the id is the consent.
    const { suggest, view, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.choose('suggest-9', STORED.id)

    expect(view.sent).toEqual([])
  })
})

describe('unlocking from the picker', () => {
  it('raises the master-password prompt from the button, never from the press', () => {
    /*
      R9. The press from the page view produces a notice with a button; only the button produces the
      prompt. Both halves are asserted, because a build that raised the prompt on the press would
      look perfectly correct to somebody using it.
    */
    const { suggest, view, window, unlocks, gesture } = harness({ unlocked: false })
    gesture()

    suggest.press(view, frame(), pressPayload())
    expect(unlocks, 'the prompt was raised by a message from a page view').toEqual([])
    expect(picker(window)?.content).toEqual({ state: 'locked' })

    suggest.unlock('suggest-1')
    expect(unlocks).toHaveLength(1)
    expect(window.overlayPresentation()?.kind).toBe('master-password')
  })

  it('mints the consent that carries the flow across the prompt', () => {
    // A chrome action in its own right, and it has to be: the person is about to spend half a minute
    // typing, which no five-second gesture window would survive.
    const { suggest, service, view, gesture } = harness({ unlocked: false })
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.unlock('suggest-1')

    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
  })

  it('keeps the request when the prompt displaces the picker, and comes back in its place', async () => {
    /*
      AE1's second half. The prompt outranks this surface, so raising it *is* a departure — and an
      unmarked departure would discard the request the flow is about to come back to. The picker
      returns with the same id, so the layer reads it as an update rather than as a new surface.
    */
    const harnessed = harness({ unlocked: false })
    const { suggest, service, view, window, state, gesture } = harnessed
    gesture()
    suggest.press(view, frame(), pressPayload())
    suggest.unlock('suggest-1')

    state.unlocked = true
    await harnessed.finishUnlock()

    expect(picker(window)?.requestId, 'the badge had to be pressed again').toBe('suggest-1')
    expect(picker(window)?.content).toEqual({
      state: 'entries',
      entries: [{ id: STORED.id, username: STORED.username }]
    })
    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
    expect(view.sent, 'the badge went out while its own list was coming back').toEqual([])
  })

  it('says the vault is still locked when the prompt was cancelled', async () => {
    // R8 all the way through: every ending of the sequence leaves something on screen that says what
    // happened, and the consent the unlock minted goes with the notice it is no longer behind.
    const harnessed = harness({ unlocked: false })
    const { suggest, service, view, window, gesture } = harnessed
    gesture()
    suggest.press(view, frame(), pressPayload())
    suggest.unlock('suggest-1')

    await harnessed.finishUnlock()

    expect(picker(window)?.content).toEqual({ state: 'locked' })
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('ignores an unlock for a request that is not on screen', () => {
    const { suggest, view, unlocks, gesture } = harness({ unlocked: false })
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.unlock('suggest-9')

    expect(unlocks).toEqual([])
  })
})

describe('every way the picker leaves', () => {
  it('discards the request and takes the badge’s highlight back when it is dismissed', () => {
    // Escape, a resize, a lost focus, a layout change, a crashed overlay renderer. None of them knows
    // what autofill is, and all of them arrive here.
    const { suggest, service, view, window, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    window.dismissOverlay()

    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
    expect(suggest.requestFor(VIEW_ID)).toBeNull()
    expect(view.sent).toEqual([{ channel: AUTOFILL_SUGGEST_END_CHANNEL, payload: null }])
  })

  it('discards the request when something with a stronger claim takes the layer', () => {
    const { suggest, service, view, window, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    window.presentOverlay({
      kind: 'master-password',
      requestId: 'mp-2',
      purpose: 'unlock',
      step: 'current',
      filled: 0,
      problem: null,
      minLength: 10
    })

    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
    expect(view.sent).toEqual([{ channel: AUTOFILL_SUGGEST_END_CHANNEL, payload: null }])
  })

  it('closes on the page’s own report of a scroll, a pinch or a press beside it', () => {
    // AE6. The page reports the event and the core takes the surface down, because it is the
    // surface's departure — not the message — that discards the request.
    const { suggest, service, view, window, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.close(view)

    expect(picker(window)).toBeUndefined()
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
    expect(suggest.requestFor(VIEW_ID)).toBeNull()
  })

  it('leaves a surface that is not its own alone when the page says to close', () => {
    /*
      A close can arrive after something else has claimed the layer. An unconditional dismissal then
      takes down a permission prompt — which settles it the safe way, which is refusing a request
      nobody was asked about.
    */
    const { suggest, view, window, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())
    window.presentOverlay({
      kind: 'master-password',
      requestId: 'mp-3',
      purpose: 'unlock',
      step: 'current',
      filled: 0,
      problem: null,
      minLength: 10
    })

    suggest.close(view)

    expect(window.overlayPresentation()?.kind).toBe('master-password')
  })

  it('has nothing to close for a view that never pressed anything', () => {
    const { suggest, view, window } = harness()

    suggest.close(view)

    expect(window.presented).toEqual([])
  })

  it('ignores a departure that belongs to another surface entirely', () => {
    const { suggest, service, view, gesture } = harness()
    gesture()
    suggest.press(view, frame(), pressPayload())

    suggest.overlayVacated({
      kind: 'find-bar',
      sessionId: 'find-1',
      tabId: 'tab-1',
      tileIndex: 0,
      query: 'a',
      matches: 0,
      activeMatch: 0,
      bounds: TILE
    })

    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
  })
})

/** A surface with a stronger claim on the layer than the picker. */
const HELD_PROMPT: OverlayPresentation = {
  kind: 'permission-request',
  requestId: 'perm-1',
  origin: 'https://accounts.example.com',
  subject: 'camera',
  devices: [],
  waiting: 0
}

describe('a fill asked for from browser chrome', () => {
  const KEY = { x: 900, y: 10, width: 32, height: 32 }
  const describes = (view: FakeView): number =>
    view.sent.filter((message) => message.channel === AUTOFILL_DESCRIBE_CHANNEL).length

  it('asks the page where its form is, and takes its answer as the consent', () => {
    // No gesture at all: the question came from browser chrome, which is the other consent (R11).
    const { suggest, service, view, window } = harness()

    suggest.requestFromChrome(view, KEY)
    expect(describes(view)).toBe(1)
    suggest.press(view, frame(), pressPayload())

    expect(picker(window)?.content.state).toBe('entries')
    expect(service.hasChromeRequest(VIEW_ID)).toBe(true)
  })

  it('asks nothing when the view has no tile, or something stronger holds the layer', () => {
    const unplaced = harness({ placed: false })
    unplaced.suggest.requestFromChrome(unplaced.view, KEY)
    expect(describes(unplaced.view)).toBe(0)

    const held = harness()
    held.window.hold(HELD_PROMPT)
    held.suggest.requestFromChrome(held.view, KEY)
    expect(describes(held.view)).toBe(0)
  })

  it('asks nothing for a tab with no live page, which hands over no view at all', () => {
    const { suggest, view, window } = harness()

    suggest.requestFromChrome(null, KEY)
    suggest.press(view, frame(), pressPayload())

    expect(describes(view)).toBe(0)
    expect(picker(window), 'a press counted as the chrome consent').toBeUndefined()
  })

  it('sends nothing into a view that is already gone', () => {
    const { suggest, window } = harness()
    const gone: FakeView = { ...fakeView(), isDestroyed: () => true }

    suggest.requestFromChrome(gone, KEY)
    suggest.press(gone, frame(), pressPayload())

    expect(gone.sent).toEqual([])
    // The question still stands for the moment it was asked in, and its answer is still heard.
    expect(picker(window)?.content.state).toBe('entries')
  })

  it('is answered once, and not at all once the question has gone stale', () => {
    const { suggest, view, window, clock } = harness()

    suggest.requestFromChrome(view, KEY)
    clock.now += CHROME_ASK_TTL_MS + 1
    suggest.press(view, frame(), pressPayload())
    expect(picker(window), 'a late answer counted').toBeUndefined()

    suggest.requestFromChrome(view, KEY)
    clock.now -= 60_000
    suggest.press(view, frame(), pressPayload())
    expect(picker(window), 'a clock that moved back kept the question alive').toBeUndefined()
  })

  it('drops the question when the page says to close, before it has answered', () => {
    const { suggest, view, window } = harness()

    suggest.requestFromChrome(view, KEY)
    suggest.close(view)
    suggest.press(view, frame(), pressPayload())

    expect(picker(window)).toBeUndefined()
  })

  it('leaves no request open when there is nothing to answer with', () => {
    // A view that belongs to no window: the service has nothing to say, so nothing may stay open.
    const { suggest, service, view, window } = harness({ mode: null })

    suggest.requestFromChrome(view, KEY)
    suggest.press(view, frame(), pressPayload())

    expect(picker(window)).toBeUndefined()
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('hangs the list from the key, and abandons it when the tile has no room', () => {
    const roomy = harness()
    roomy.suggest.requestFromChrome(roomy.view, KEY)
    roomy.suggest.press(roomy.view, frame(), pressPayload())
    expect(picker(roomy.window)?.bounds).toMatchObject({ x: KEY.x + KEY.width - 320 })

    const cramped = harness({ tile: { x: 0, y: 0, width: 1000, height: 20 } })
    cramped.suggest.requestFromChrome(cramped.view, KEY)
    cramped.suggest.press(cramped.view, frame(), pressPayload())
    expect(picker(cramped.window)).toBeUndefined()
    expect(cramped.service.hasChromeRequest(VIEW_ID)).toBe(false)
  })
})

describe('the endings that arrive late or find the world changed', () => {
  /*
    The prompt takes minutes, and the page, the layer and the tab can all move while it is up. Each
    case below is a way the flow could end on a picker that is no longer the one on screen — and
    ending that one would take down, or drop the consent of, a surface the user is looking at.
  */
  it('ends the flow when the view left its tile before Unlock was pressed', () => {
    const { suggest, service, view, window, gesture, state } = harness({ unlocked: false })
    gesture()
    suggest.press(view, frame(), pressPayload())
    const shown = picker(window)
    state.placed = false

    suggest.unlock(shown?.requestId ?? '')

    expect(suggest.requestFor(VIEW_ID)).toBeNull()
    expect(service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('ends the flow when the prompt could not be shown at all', async () => {
    const harnessed = harness({ unlocked: false })
    harnessed.gesture()
    harnessed.suggest.press(harnessed.view, frame(), pressPayload())
    harnessed.suggest.unlock(picker(harnessed.window)?.requestId ?? '')

    await harnessed.finishUnlock(true)

    expect(harnessed.suggest.requestFor(VIEW_ID)).toBeNull()
    expect(harnessed.view.sent.at(-1)).toEqual({
      channel: AUTOFILL_SUGGEST_END_CHANNEL,
      payload: null
    })
  })

  it('ends nothing twice when a closed picker’s prompt fails afterwards', async () => {
    const harnessed = harness({ unlocked: false })
    const { suggest, view, window, gesture } = harnessed
    gesture()
    suggest.press(view, frame(), pressPayload())
    suggest.unlock(picker(window)?.requestId ?? '')
    // The page closes the picker while the prompt is up; the prompt then fails, and a new press follows.
    suggest.close(view)
    gesture()
    harnessed.state.unlocked = true
    await harnessed.finishUnlock(true)
    suggest.press(view, frame(), pressPayload())
    const current = suggest.requestFor(VIEW_ID)

    expect(current).not.toBeNull()
    expect(picker(window)?.requestId).toBe(current)
  })

  it('does not come back when the picker was closed while the prompt was up', async () => {
    const harnessed = harness({ unlocked: false })
    const { suggest, view, window, gesture } = harnessed
    gesture()
    suggest.press(view, frame(), pressPayload())
    suggest.unlock(picker(window)?.requestId ?? '')
    suggest.close(view)
    harnessed.state.unlocked = true

    await harnessed.finishUnlock()

    expect(picker(window)).toBeUndefined()
  })

  it('does not come back in a tile it is no longer in, or over a stronger claim', async () => {
    const offscreen = harness({ unlocked: false })
    offscreen.gesture()
    offscreen.suggest.press(offscreen.view, frame(), pressPayload())
    offscreen.suggest.unlock(picker(offscreen.window)?.requestId ?? '')
    offscreen.state.unlocked = true
    offscreen.state.placed = false
    await offscreen.finishUnlock()
    expect(offscreen.suggest.requestFor(VIEW_ID)).toBeNull()

    const outranked = harness({ unlocked: false })
    outranked.gesture()
    outranked.suggest.press(outranked.view, frame(), pressPayload())
    outranked.suggest.unlock(picker(outranked.window)?.requestId ?? '')
    outranked.state.unlocked = true
    const settling = outranked.finishUnlock()
    outranked.window.hold(HELD_PROMPT)
    await settling
    expect(outranked.window.overlayPresentation()).toBe(HELD_PROMPT)
    expect(outranked.suggest.requestFor(VIEW_ID)).toBeNull()
  })

  it('says nothing after the vault reopened for a view that no window owns any more', async () => {
    const harnessed = harness({ unlocked: false })
    harnessed.gesture()
    harnessed.suggest.press(harnessed.view, frame(), pressPayload())
    harnessed.suggest.unlock(picker(harnessed.window)?.requestId ?? '')
    harnessed.state.unlocked = true
    harnessed.state.mode = null

    await harnessed.finishUnlock()

    expect(picker(harnessed.window)).toBeUndefined()
    expect(harnessed.service.hasChromeRequest(VIEW_ID)).toBe(false)
  })

  it('takes down nothing for a view it can no longer place, or a picker that is not its own', () => {
    const unplaced = harness()
    unplaced.gesture()
    unplaced.suggest.press(unplaced.view, frame(), pressPayload())
    unplaced.state.placed = false
    unplaced.suggest.close(unplaced.view)
    expect(picker(unplaced.window)?.requestId).toBe('suggest-1')

    // Another picker reached the layer before the departure of this one was announced.
    const raced = harness()
    raced.gesture()
    raced.suggest.press(raced.view, frame(), pressPayload())
    const shown = picker(raced.window)
    if (shown === undefined) throw new Error('no picker is on screen')
    const other: OverlayPresentation = { ...shown, requestId: 'another-view' }
    raced.window.hold(other)
    raced.suggest.close(raced.view)
    expect(raced.window.overlayPresentation()).toBe(other)
  })

  it('sends nothing into a view that has gone by the time its list ends', () => {
    const { suggest, window, service } = harness()
    let gone = false
    const view: FakeView = { ...fakeView(), isDestroyed: () => gone }
    service.noteInput(view.id, { type: 'mouseDown', button: 'left' })
    suggest.press(view, frame(), pressPayload())
    gone = true

    window.dismissOverlay()

    expect(view.sent).toEqual([])
  })

  it('names its own requests and reads its own clock when it is given neither', () => {
    const { service, view, window } = harness()
    const plain = new AutofillSuggest({
      service,
      targetFor: () => ({ window, tileIndex: 1, geometry: { bounds: TILE, pageZoom: 1 } }),
      requestUnlock: () => Promise.resolve()
    })

    plain.requestFromChrome(view, null)
    plain.press(view, frame(), pressPayload())

    expect(picker(window)?.requestId).toMatch(/^[0-9a-f-]{36}$/)
  })
})
