import {
  AutofillService,
  type AutofillFrame,
  type AutofillVault,
  type AutofillView
} from '@main/passwords/AutofillService.js'
import { AutofillSuggest, type SuggestWindow } from '@main/passwords/AutofillSuggest.js'
import {
  wireAutofillView,
  type AutofillHost,
  type SyncReply
} from '@main/passwords/autofill-wiring.js'
import {
  mayPresentOver,
  surfaceIdentity,
  type AutofillSuggestPresentation,
  type OverlayPresentation,
  type OverlayState
} from '@shared/overlay/surface.js'
import type { BrowsingMode, PasswordSummary, SaveCredentialInput } from '@shared/passwords/model.js'
import {
  AUTOFILL_DESCRIBE_CHANNEL,
  AUTOFILL_FILLABLE_CHANNEL,
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_PRESS_CHANNEL,
  AUTOFILL_SUGGEST_END_CHANNEL
} from '@shared/passwords/wire.js'
import type { Rect } from '@shared/ui/anchor.js'

/**
 * Autofill's real wiring — `wireAutofillView`, `AutofillService` and `AutofillSuggest` — over fakes
 * of the three things only Electron has: a view, a window's overlay layer, and the vault.
 *
 * For `tests/autofill-wiring.test.ts` and `tests/features/steps/passwords.steps.ts`, and the one rule
 * both depend on is written here rather than in either of them: **nothing in this file hands the
 * service a gesture.** The input event reaches the service the way it does in a browser — dispatched
 * into a view the wiring decided to listen to — and a harness that recorded one itself would prove
 * only that the service can hold one. That is exactly the blindness that let autofill ship unable to
 * fill anything. `tests/autofill-wiring.test.ts` asserts it over this file's own source.
 */

export const NOW = 1_700_000_000_000
export const VIEW_ID = 7
export const SECRET = 'correct-horse-battery-staple'
export const LOGIN_URL = 'https://accounts.example.com/login'

export const STORED: PasswordSummary = {
  id: 'pw-1',
  origin: 'https://example.com',
  username: 'alice@example.com',
  createdAt: NOW,
  updatedAt: NOW,
  lastUsedAt: null
}

/** The field's rectangle as the preload reports it, well inside the tile. */
export const FIELD = {
  rect: { x: 100, y: 200, width: 240, height: 24 },
  scale: 1,
  offsetX: 0,
  offsetY: 0
}
const TILE = { x: 0, y: 80, width: 1000, height: 700 }

export function frame(overrides: Partial<AutofillFrame> = {}): AutofillFrame {
  return { url: LOGIN_URL, isTopLevel: true, topLevelUrl: LOGIN_URL, ...overrides }
}

function control(overrides: Record<string, unknown>): Record<string, unknown> {
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

/** An ordinary sign-in form, as a renderer reports one. */
export function formPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: '/session',
    fields: [control({ type: 'text', name: 'user', autocomplete: 'username' }), control({})],
    ...overrides
  }
}

/** A real `input-event` payload of the kind `gesture.ts` accepts: a left press. */
export const LEFT_PRESS = { type: 'mouseDown', button: 'left' }

export interface FakeView extends AutofillView {
  readonly sent: Array<{ readonly channel: string; readonly payload: unknown }>
  destroy(): void
}

function fakeView(): FakeView {
  const sent: Array<{ readonly channel: string; readonly payload: unknown }> = []
  let destroyed = false
  return {
    id: VIEW_ID,
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

/** A view's events, raised in the order Electron raises them. */
export interface FakeHost extends AutofillHost {
  ask(channel: string, payload: unknown, from?: AutofillFrame): SyncReply
  tell(channel: string, payload: unknown, from?: AutofillFrame): void
  /** An input event, as Electron dispatches one into the view. Delivered only if anybody listens. */
  input(value?: unknown): void
  navigate(url: string): void
  loaded(url: string): void
  destroy(): void
  readonly listening: boolean
  readonly subscriptions: number
}

function fakeHost(view: FakeView): FakeHost {
  let sync: ((channel: string, frame: AutofillFrame, payload: unknown) => SyncReply) | null = null
  let message: ((channel: string, frame: AutofillFrame, payload: unknown) => void) | null = null
  let navigated: ((url: string) => void) | null = null
  let ready: ((url: string) => void) | null = null
  let destroyed: (() => void) | null = null
  let listener: ((value: unknown) => void) | null = null
  let subscriptions = 0

  return {
    view,
    onSyncMessage: (next) => {
      sync = next
    },
    onMessage: (next) => {
      message = next
    },
    onInput: (next) => {
      subscriptions += 1
      listener = next
      return () => {
        listener = null
      }
    },
    onMainFrameNavigation: (next) => {
      navigated = next
    },
    onDocumentReady: (next) => {
      ready = next
    },
    onDestroyed: (next) => {
      destroyed = next
    },
    ask: (channel, payload, from = frame()) => sync?.(channel, from, payload) ?? null,
    tell: (channel, payload, from = frame()) => message?.(channel, from, payload),
    input: (value = LEFT_PRESS) => listener?.(value),
    navigate: (url) => navigated?.(url),
    loaded: (url) => ready?.(url),
    destroy: () => {
      view.destroy()
      destroyed?.()
    },
    get listening() {
      return listener !== null
    },
    get subscriptions() {
      return subscriptions
    }
  }
}

/** One window's overlay layer, ranking claims and announcing departures the way the real one does. */
interface FakeWindow extends SuggestWindow {
  onVacated(listener: (presentation: OverlayPresentation) => void): void
}

function fakeWindow(): FakeWindow {
  let current: OverlayState = null
  let vacated: (presentation: OverlayPresentation) => void = () => undefined
  return {
    onVacated: (listener) => {
      vacated = listener
    },
    overlayPresentation: () => current,
    presentOverlay: (presentation) => {
      if (!mayPresentOver(presentation.kind, current)) return
      const outgoing = current
      current = presentation
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

export interface WiredOptions {
  readonly unlocked?: boolean
  readonly enabled?: boolean
  readonly summaries?: readonly PasswordSummary[]
}

export type WriterCall =
  | { readonly mode: BrowsingMode; readonly call: 'save'; readonly input: SaveCredentialInput }
  | { readonly mode: BrowsingMode; readonly call: 'never'; readonly url: string }
  | { readonly mode: BrowsingMode; readonly call: 'used'; readonly id: string }

/** The real wiring, driven only through what a page view, the overlay and the vault would do. */
export function wiredAutofill(options: WiredOptions = {}) {
  const state = { unlocked: options.unlocked ?? true, enabled: options.enabled ?? true }
  const clock = { now: NOW }
  const summaries = options.summaries ?? [STORED]
  const reads = { lists: 0, secrets: 0 }
  const writes: WriterCall[] = []
  const unlockRequests: SuggestWindow[] = []
  let settleUnlock: ((unlocked: boolean) => void) | null = null

  const vault: AutofillVault = {
    isUnlocked: () => state.unlocked,
    list: () => {
      reads.lists += 1
      return [...summaries]
    },
    summaryOf: (id) => summaries.find((summary) => summary.id === id) ?? null,
    secretOf: (id) => {
      reads.secrets += 1
      return id === STORED.id ? SECRET : null
    },
    neverSavedOrigins: () => [],
    compareStored: () => 'none',
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
    modeFor: () => 'normal',
    locale: () => 'en',
    now: () => clock.now
  })
  const window = fakeWindow()
  const view = fakeView()
  let requests = 0
  const suggest = new AutofillSuggest({
    service,
    targetFor: () => ({ window, tileIndex: 0, geometry: { bounds: TILE, pageZoom: 1 } }),
    requestUnlock: async (host) => {
      unlockRequests.push(host)
      // Presented from inside the call, displacing the picker, as the real prompt is.
      window.presentOverlay({
        kind: 'master-password',
        requestId: 'mp-1',
        purpose: 'unlock',
        step: 'current',
        filled: 0,
        problem: null,
        minLength: 10
      })
      await new Promise<void>((resolve) => {
        settleUnlock = (unlocked) => {
          state.unlocked = unlocked
          window.dismissOverlay()
          resolve()
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
  const host = fakeHost(view)
  wireAutofillView(service, suggest, host)

  const picker = (): AutofillSuggestPresentation | undefined => {
    const presentation = window.overlayPresentation()
    return presentation?.kind === 'autofill-suggest' ? presentation : undefined
  }
  /** Every "the list has gone" the page was sent, oldest first: `null`, or the token of a choice. */
  const endings = (): unknown[] =>
    view.sent
      .filter((message) => message.channel === AUTOFILL_SUGGEST_END_CHANNEL)
      .map((message) => message.payload)

  return {
    service,
    suggest,
    host,
    view,
    window,
    state,
    clock,
    reads,
    writes,
    unlockRequests,
    picker,
    endings,
    /** The preload saying a fillable field has focus, or that it no longer has. */
    reportFillable: (fillable = true): void => host.tell(AUTOFILL_FILLABLE_CHANNEL, fillable),
    /** A press on the badge, as the preload reports it: the form and the field's rectangle. */
    pressBadge: (): void =>
      host.tell(AUTOFILL_PRESS_CHANNEL, { form: formPayload(), field: FIELD }),
    /** The overlay's answer for the first entry, as `passwords:answerSuggestion` delivers it. */
    chooseFirst: (): void => {
      const shown = picker()
      if (shown?.content.state !== 'entries') throw new Error('no list of accounts is on screen')
      const [first] = shown.content.entries
      if (first === undefined) throw new Error('the list is empty')
      suggest.choose(shown.requestId, first.id)
    },
    /** The picker's Unlock button, as `passwords:answerSuggestion` delivers it. */
    pressUnlock: (): void => {
      const shown = picker()
      if (shown === undefined) throw new Error('no picker is on screen')
      suggest.unlock(shown.requestId)
    },
    /** Answers the master-password prompt; resolves once the picker has had its turn. */
    answerPrompt: async (unlocked: boolean): Promise<void> => {
      settleUnlock?.(unlocked)
      await Promise.resolve()
      await Promise.resolve()
    },
    /** Browser chrome asking for a fill: the toolbar key, the shortcut, the context menu. */
    askFromChrome: (anchor: Rect | null = null): void => suggest.requestFromChrome(view, anchor),
    /** Whether browser chrome's question reached the page. */
    askedToDescribe: (): boolean =>
      view.sent.some((message) => message.channel === AUTOFILL_DESCRIBE_CHANNEL),
    /** The preload redeeming the token it was sent, with the form as it is now. */
    redeem: (token: unknown, from?: AutofillFrame, form: unknown = formPayload()): unknown =>
      host.ask(AUTOFILL_FILL_CHANNEL, { token, form }, from)?.answer ?? null
  }
}
