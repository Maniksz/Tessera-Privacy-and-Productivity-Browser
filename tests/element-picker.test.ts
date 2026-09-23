import { beforeEach, describe, expect, it, vi } from 'vitest'
import { COSMETIC_SPECIFIC_CHANNEL } from '@shared/filters/injection.js'
import {
  PICKER_ESCAPED_CHANNEL,
  PICKER_FREEZE_CHANNEL,
  PICKER_MEASURED_CHANNEL,
  PICKER_MEASURE_CHANNEL,
  PICKER_PROPOSE_CHANNEL,
  PICKER_SELECT_CHANNEL,
  PICKER_START_CHANNEL,
  PICKER_STOP_CHANNEL
} from '@shared/filters/picker-wire.js'
import type { PickerCandidate } from '@shared/filters/picker-session.js'
import { notifyOverlayVacancy } from '@main/permissions/vacancy.js'
import {
  surfaceIdentity,
  type OverlayKind,
  type OverlayPresentation,
  type OverlayState,
  type PickerBarPresentation
} from '@shared/overlay/surface.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import type { AddRuleResult, UserRuleEditor } from '@main/data/UserRuleStore.js'
import type { UserRule, UserRuleInput } from '@shared/filters/user-rules.js'

/**
 * The picker's wiring: which view is spoken to, in what order, and what the bar is left showing.
 *
 * ## Why this file exists although `ElementPicker.ts` is excluded from coverage
 *
 * It is excluded because it speaks to `app.on('web-contents-created')` and a live `WebContents`, and
 * it stays excluded — nothing here moves it off. Every *decision* it used to hold now lives in
 * `picker-session.ts`, `picker-entry.ts` and `picker-presentation.ts`, and each of those is asserted
 * against directly elsewhere.
 *
 * What is left is sequencing, and sequencing is exactly what this feature was reported broken for. A
 * preview that is still on the page when the stored rule is measured reports success whatever the
 * rule does (R13). A message accepted from a view whose session is not running is a page choosing
 * what gets written. An end that lifts no preview leaves part of a document hidden by a rule that
 * was never saved. None of those is a wrong answer from a pure function; all of them are the wrong
 * order of two calls, which is the one thing a fake application object can catch.
 * `tests/filter-injection.test.ts` established the shape.
 */

const electron = vi.hoisted(() => {
  const created: Array<(event: unknown, contents: unknown) => void> = []
  const quitting: Array<() => void> = []
  const views = new Map<number, unknown>()
  return {
    app: {
      on(event: string, handler: (...args: unknown[]) => void): void {
        if (event === 'web-contents-created') created.push(handler)
        if (event === 'before-quit') quitting.push(handler)
      }
    },
    webContents: {
      fromId(id: number): unknown {
        return views.get(id)
      }
    },
    /** Dropped between tests, so a previous test's picker cannot answer this test's view. */
    reset(): void {
      created.length = 0
      quitting.length = 0
      views.clear()
    },
    open(view: { id: number }): void {
      views.set(view.id, view)
      for (const handler of [...created]) handler({}, view)
    },
    quit(): void {
      for (const handler of [...quitting]) handler()
    }
  }
})

vi.mock('electron', () => ({ app: electron.app, webContents: electron.webContents }))

const { ElementPicker } = await import('@main/privacy/ElementPicker.js')
const { CosmeticInjector } = await import('@main/privacy/CosmeticInjector.js')
const { FilterEngine } = await import('@main/privacy/FilterEngine.js')

const DOCUMENT = 'https://example.com/article'

/** One element, as the page transcribes it for a hover. */
const ELEMENT = {
  tag: 'div',
  id: '',
  classes: ['ad-slot'],
  attributes: [],
  childIndex: 1,
  ancestors: []
}

/** Something with a stronger claim on the layer: the surface a page can raise by asking. */
function consentDialogue(): OverlayPresentation {
  return {
    kind: 'permission-request',
    requestId: 'p-1',
    origin: 'https://example.com',
    subject: 'camera',
    devices: [],
    waiting: 0
  }
}

/** A view, reduced to what the picker actually speaks to. */
class FakeView {
  readonly id: number
  url: string
  readonly sent: Array<{ readonly channel: string; readonly payload: unknown }> = []
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  #destroyed = false

  constructor(id: number, url: string) {
    this.id = id
    this.url = url
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const existing = this.#listeners.get(event) ?? []
    existing.push(handler)
    this.#listeners.set(event, existing)
    return this
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    return this.on(event, handler)
  }

  getURL(): string {
    return this.url
  }

  isDestroyed(): boolean {
    return this.#destroyed
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }

  /** A message from the page's preload. */
  tell(channel: string, payload: unknown): void {
    this.emit('ipc-message', {}, channel, payload)
  }

  /** The synchronous hover question, answered the way a page really asks it. */
  ask(payload: unknown): unknown {
    const event: { returnValue: unknown } = { returnValue: undefined }
    this.emit('ipc-message-sync', event, PICKER_PROPOSE_CHANNEL, payload)
    return event.returnValue
  }

  /** The host-stylesheet question a new document asks at `document-start`, answered synchronously. */
  askStyles(): unknown {
    const event: { returnValue: unknown } = { returnValue: undefined }
    this.emit('ipc-message-sync', event, COSMETIC_SPECIFIC_CHANNEL, this.url)
    return event.returnValue
  }

  navigate(details: { isMainFrame?: boolean; isSameDocument?: boolean; url?: string }): void {
    this.emit('did-start-navigation', details)
  }

  destroy(): void {
    this.#destroyed = true
    this.emit('destroyed')
  }

  lastOn(channel: string): unknown {
    return this.sent.filter((entry) => entry.channel === channel).at(-1)?.payload
  }

  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.#listeners.get(event) ?? []) handler(...args)
  }
}

/**
 * A window's overlay layer, reduced to the three things the picker uses and the one it depends on:
 * that a departure is announced. The real layer announces synchronously from inside `dismissKind`,
 * and the ordering bug that behaviour causes is a real one — a session still recorded as running
 * would be ended a second time by its own bar leaving — so the fake announces the same way.
 */
class FakeWindow {
  readonly windowId: number
  presented: OverlayState = null
  readonly opened: string[] = []

  constructor(windowId: number) {
    this.windowId = windowId
  }

  present(presentation: OverlayPresentation): void {
    const outgoing = this.presented
    this.presented = presentation
    if (outgoing === null) return
    if (surfaceIdentity(outgoing) === surfaceIdentity(presentation)) return
    notifyOverlayVacancy(outgoing, 'replaced')
  }

  dismissKind(kind: OverlayKind): boolean {
    const outgoing = this.presented
    if (outgoing?.kind !== kind) return false
    this.presented = null
    notifyOverlayVacancy(outgoing, 'dismissed')
    return true
  }

  /** What something with a stronger claim does to the layer. */
  claim(presentation: OverlayPresentation): void {
    const outgoing = this.presented
    this.presented = presentation
    if (outgoing !== null) notifyOverlayVacancy(outgoing, 'replaced')
  }

  bar(): PickerBarPresentation | null {
    return this.presented?.kind === 'picker-bar' ? this.presented : null
  }
}

/** The rule editor, reduced to what one attempt does to it. */
class FakeEditor implements UserRuleEditor {
  readonly added: string[] = []
  readonly removed: string[] = []
  answer: AddRuleResult = { outcome: 'added', rule: null }
  #sequence = 0

  add(input: UserRuleInput): AddRuleResult {
    this.added.push(input.text)
    if (this.answer.outcome !== 'added') return this.answer
    this.#sequence += 1
    const rule: UserRule = {
      id: `rule-${String(this.#sequence)}`,
      text: input.text,
      enabled: true,
      createdAt: 0,
      origin: input.origin
    }
    return { outcome: 'added', rule }
  }

  setEnabled(): boolean {
    return true
  }

  remove(id: string): boolean {
    this.removed.push(id)
    return true
  }

  list(): UserRule[] {
    return []
  }

  forHost(): UserRule[] {
    return []
  }

  enabledText(): string {
    return ''
  }

  onChange(): () => void {
    return () => undefined
  }
}

interface Harness {
  picker: InstanceType<typeof ElementPicker>
  view: FakeView
  window: FakeWindow
  editor: FakeEditor
  /** Every preview call in order: what was delivered to which view, `null` for a revocation. */
  previews: Array<{ id: number; rule: string | null }>
  /** Preview calls and page messages interleaved, which is how an ordering is asserted. */
  timeline: string[]
}

function harnessFor(
  options: {
    url?: string
    settings?: Partial<SettingsSnapshot>
    tileIndex?: number | null
    /** An editor that does more than record, for a test that needs the rule to reach an engine. */
    editor?: FakeEditor
    /** Where a preview goes besides the record, for the same kind of test. */
    preview?: (id: number, rule: string | null) => void
  } = {}
): Harness {
  const view = new FakeView(1, options.url ?? DOCUMENT)
  const window = new FakeWindow(3)
  const editor = options.editor ?? new FakeEditor()
  const previews: Array<{ id: number; rule: string | null }> = []
  const timeline: string[] = []
  const settings = { ...defaultSettings(), ...options.settings }

  const picker = new ElementPicker({
    chrome: () => ({ styles: '.box{}', hint: 'hint', noRule: 'none', warnings: {} }),
    getSettings: () => settings,
    locale: () => 'en',
    editorFor: () => editor,
    preview: (id, rule) => {
      previews.push({ id, rule })
      timeline.push(rule === null ? 'preview:off' : 'preview:on')
      options.preview?.(id, rule)
    },
    hostFor: (id) =>
      id === view.id
        ? {
            windowId: window.windowId,
            tabId: 'tab-1',
            tileIndex: options.tileIndex ?? 0,
            tileRect: () => ({ x: 0, y: 0, width: 1200, height: 800 }),
            presentOverlay: (presentation) => {
              window.present(presentation)
            },
            dismissOverlayKind: (kind) => window.dismissKind(kind),
            overlayPresentation: () => window.presented,
            openRules: () => window.opened.push('settings')
          }
        : null,
    measureTimeoutMs: 20
  })
  picker.install()
  electron.open(view)

  const send = view.send.bind(view)
  view.send = (channel: string, payload: unknown): void => {
    timeline.push(`send:${channel}`)
    send(channel, payload)
  }

  return { picker, view, window, editor, previews, timeline }
}

function candidate(selector: string, tag = 'div', matches = 3): PickerCandidate {
  return {
    tag,
    proposal: {
      selector,
      estimatedMatches: matches,
      strategy: 'class',
      warnings: [],
      refused: []
    },
    matches
  }
}

/** Start, click, and be frozen on `.ad-slot` with `section` above it. */
function frozen(harness: Harness): string {
  harness.picker.start(harness.view.id)
  const sessionId = harness.window.bar()?.sessionId ?? ''
  harness.view.tell(PICKER_FREEZE_CHANNEL, {
    sessionId,
    chain: [candidate('.ad-slot'), candidate('#rail', 'section', 1)]
  })
  return sessionId
}

beforeEach(() => {
  electron.reset()
})

describe('starting, and refusing to', () => {
  it('tells the view and raises the bar for a document that can carry a rule', () => {
    const harness = harnessFor()
    expect(harness.picker.start(harness.view.id)).toBe(true)
    const start = harness.view.lastOn(PICKER_START_CHANNEL) as { sessionId: string; hint: string }
    expect(start.hint).toBe('hint')
    expect(start.sessionId).not.toBe('')
    expect(harness.window.bar()?.mode).toBe('showing')
  })

  it('starts nothing on a file: document and says so on the bar', () => {
    /*
      AE2, and the reason the precondition is the session's rather than each entry's: all three
      routes in — the page menu, the keyboard route through `picker:start`, and the blocker menu —
      call this one method, so there is one answer rather than three that drift.
    */
    const harness = harnessFor({ url: 'file:///home/me/notes.html' })
    expect(harness.picker.start(harness.view.id)).toBe(false)
    expect(harness.window.bar()?.outcome).toBe('not-filterable')
    expect(harness.view.lastOn(PICKER_START_CHANNEL)).toBeUndefined()
  })

  it('starts nothing on an internal page and says so on the bar', () => {
    const harness = harnessFor({ url: 'tessera://settings' })
    expect(harness.picker.start(harness.view.id)).toBe(false)
    expect(harness.window.bar()?.outcome).toBe('not-filterable')
  })

  it('refuses while filtering is switched off for the site in front of the user', () => {
    const harness = harnessFor({ settings: { 'privacy.blockerOffForSites': ['example.com'] } })
    expect(harness.picker.start(harness.view.id)).toBe(false)
    expect(harness.window.bar()?.outcome).toBe('not-filterable')
  })

  it('declines silently while something with a stronger claim holds the layer', () => {
    /*
      A consent dialogue outranks this bar, so presenting would be refused — and the refusal is
      silent. Starting anyway would leave a page highlighted and previewed with nothing on screen to
      explain either, because a surface that was never presented never departs and so is never
      announced.
    */
    const harness = harnessFor()
    harness.window.presented = consentDialogue()
    expect(harness.picker.start(harness.view.id)).toBe(false)
    expect(harness.view.lastOn(PICKER_START_CHANNEL)).toBeUndefined()
  })

  it('takes down the session a second start displaced, wherever it was', () => {
    const harness = harnessFor()
    const first = frozen(harness)
    harness.picker.start(harness.view.id)
    const second = harness.window.bar()?.sessionId
    expect(second).not.toBe(first)
    // The displaced session's provisional rule comes off the page; leaving it there would be part of
    // a document hidden by a rule nobody can find.
    expect(harness.previews.at(-1)).toEqual({ id: 1, rule: null })
  })
})

describe('the click, the correction and the confirmation', () => {
  it('previews the frozen selector in the picked view and nowhere else', () => {
    const harness = harnessFor()
    frozen(harness)
    expect(harness.previews.at(-1)).toEqual({ id: 1, rule: 'example.com##.ad-slot' })
    const bar = harness.window.bar()
    expect(bar?.mode).toBe('frozen')
    expect(bar?.selector).toBe('.ad-slot')
    // Counted in the open document by the page (R9), not estimated from the element alone.
    expect(bar?.matches).toBe(3)
  })

  it('discards a click from a view whose session is not running', () => {
    // The whole of the privilege check: a view the core did not start decides nothing, whatever it
    // sends.
    const harness = harnessFor()
    const bystander = new FakeView(2, DOCUMENT)
    electron.open(bystander)
    harness.picker.start(harness.view.id)
    const sessionId = harness.window.bar()?.sessionId ?? ''
    bystander.tell(PICKER_FREEZE_CHANNEL, { sessionId, chain: [candidate('.anything')] })
    expect(harness.window.bar()?.mode).toBe('showing')
    expect(harness.previews).toEqual([])
  })

  it('discards a click naming an attempt that is not the one running', () => {
    const harness = harnessFor()
    harness.picker.start(harness.view.id)
    harness.view.tell(PICKER_FREEZE_CHANNEL, {
      sessionId: 'picker-stale',
      chain: [candidate('.anything')]
    })
    expect(harness.window.bar()?.mode).toBe('showing')
  })

  it('proposes nothing for a view that was never started', () => {
    const harness = harnessFor()
    expect(harness.view.ask(ELEMENT)).toBeNull()
  })

  it('proposes nothing for a second view while another one is picking', () => {
    /*
      The session is one for the whole program, so "there is a session" is not the question — "is it
      this view's" is. Answered here, a page in another tab could ask what would hide any element it
      chose to describe, which is the one thing a selector proposal tells a site: which of its
      elements somebody is about to remove.
    */
    const harness = harnessFor()
    const bystander = new FakeView(2, DOCUMENT)
    electron.open(bystander)
    harness.picker.start(harness.view.id)
    expect(harness.view.ask(ELEMENT)).not.toBeNull()
    expect(bystander.ask(ELEMENT)).toBeNull()
  })

  it('moves the preview, the bar and the page’s highlight together on a correction', () => {
    const harness = harnessFor()
    const sessionId = frozen(harness)
    expect(harness.picker.barAction(sessionId, 'widen')).toBe(true)
    expect(harness.previews.at(-1)).toEqual({ id: 1, rule: 'example.com###rail' })
    expect(harness.window.bar()?.selector).toBe('#rail')
    expect(harness.view.lastOn(PICKER_SELECT_CHANNEL)).toEqual({ sessionId, index: 1 })
    // KTD11 from the presentation's side: there is nothing above the last rung, and the control says
    // so rather than doing nothing when pressed.
    expect(harness.window.bar()?.canWiden).toBe(false)
    expect(harness.picker.barAction(sessionId, 'widen')).toBe(false)
  })

  it('lifts the preview before it asks the page to measure the stored rule', () => {
    /*
      R13, and the ordering is the requirement rather than the reading order. With the preview still
      delivered, the measurement finds the element hidden by the *provisional* rule and reports
      success whatever the stored one does — which is the claim this feature was reported for making.
    */
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')

    expect(harness.editor.added).toEqual(['example.com##.ad-slot'])
    const revoked = harness.timeline.lastIndexOf('preview:off')
    const measured = harness.timeline.indexOf(`send:${PICKER_MEASURE_CHANNEL}`)
    expect(measured).toBeGreaterThan(-1)
    expect(revoked).toBeLessThan(measured)
    expect(harness.view.lastOn(PICKER_MEASURE_CHANNEL)).toEqual({ sessionId, selector: '.ad-slot' })
    expect(harness.window.bar()?.mode).toBe('measuring')
  })

  it('reports a rule that hid something as saved and effective', () => {
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    harness.view.tell(PICKER_MEASURED_CHANNEL, { sessionId, matches: 3, visible: 0 })
    const bar = harness.window.bar()
    expect(bar?.mode).toBe('outcome')
    expect(bar?.outcome).toBe('saved-effective')
    expect(bar?.canUndo).toBe(true)
  })

  it('reports a rule that hid nothing as saved and ineffective rather than as success', () => {
    // AE4. Two facts, kept apart: the saving worked and the hiding did not.
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    harness.view.tell(PICKER_MEASURED_CHANNEL, { sessionId, matches: 3, visible: 3 })
    expect(harness.window.bar()?.outcome).toBe('saved-ineffective')
  })

  it('discards a measurement that names another attempt', () => {
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    harness.view.tell(PICKER_MEASURED_CHANNEL, {
      sessionId: 'picker-stale',
      matches: 3,
      visible: 0
    })
    expect(harness.window.bar()?.mode).toBe('measuring')
  })

  it('answers each refusal of the rule model by name, and measures nothing', () => {
    for (const outcome of [
      'invalid',
      'duplicate-active',
      'duplicate-disabled',
      'limit-reached'
    ] as const) {
      electron.reset()
      const harness = harnessFor()
      harness.editor.answer = { outcome, rule: null }
      const sessionId = frozen(harness)
      harness.picker.barAction(sessionId, 'confirm')
      const bar = harness.window.bar()
      expect(bar?.outcome, outcome).toBe(outcome)
      // Nothing was written, so there is nothing to take back and nothing to measure.
      expect(bar?.canUndo, outcome).toBe(false)
      expect(harness.view.lastOn(PICKER_MEASURE_CHANNEL), outcome).toBeUndefined()
      expect(harness.previews.at(-1), outcome).toEqual({ id: 1, rule: null })
    }
  })

  it('ignores a second confirm while the first is still being answered', () => {
    // The press that would write a second rule arrives before the first answer does: somebody
    // pressing Return again because nothing has visibly happened yet is the expected case.
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    expect(harness.picker.barAction(sessionId, 'confirm')).toBe(false)
    expect(harness.editor.added).toHaveLength(1)
  })

  it('assumes nothing happened when the page never answers a measurement', async () => {
    /*
      A deadline is needed because the alternative is a bar that says "checking" for ever. Timing out
      reports no effect, which is the safe direction of the two: a rule reported as doing nothing is
      something a person can check, and one reported as working over an unchanged page is the
      original defect.
    */
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(harness.window.bar()?.outcome).toBe('saved-ineffective')
  })
})

describe('taking it back, and going to the rules', () => {
  it('removes exactly the rule this attempt wrote', () => {
    // AE14. The removal goes through the same mode-bound editor that wrote it, whose change re-serves
    // every open view — which is what makes the element come back without a reload.
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    harness.view.tell(PICKER_MEASURED_CHANNEL, { sessionId, matches: 3, visible: 0 })
    expect(harness.picker.barAction(sessionId, 'undo')).toBe(true)
    expect(harness.editor.removed).toEqual(['rule-1'])
    // The bar goes with it: there is nothing left to say about an attempt that has been undone.
    expect(harness.window.bar()).toBeNull()
    expect(harness.picker.barAction(sessionId, 'undo')).toBe(false)
  })

  it('offers no undo for a rule this attempt did not write', () => {
    // "Already there, switched off" names a rule the user wrote on another day. A button that deleted
    // it would be removing something they never asked about.
    const harness = harnessFor()
    harness.editor.answer = { outcome: 'duplicate-disabled', rule: null }
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    expect(harness.picker.barAction(sessionId, 'undo')).toBe(false)
    expect(harness.editor.removed).toEqual([])
  })

  it('opens the rule manager in the window that asked', () => {
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    harness.view.tell(PICKER_MEASURED_CHANNEL, { sessionId, matches: 0, visible: 0 })
    expect(harness.picker.barAction(sessionId, 'open-rules')).toBe(true)
    expect(harness.window.opened).toEqual(['settings'])
    expect(harness.window.bar()).toBeNull()
  })

  it('takes no word at all for an attempt that is over', () => {
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'cancel')
    for (const action of ['confirm', 'widen', 'narrow', 'undo', 'open-rules', 'cancel'] as const) {
      expect(harness.picker.barAction(sessionId, action), action).toBe(false)
    }
  })
})

describe('every way one ends', () => {
  /** What must be true of the page and the layer after any of R11's events. */
  function expectFinished(harness: Harness): void {
    expect(harness.previews.at(-1)).toEqual({ id: 1, rule: null })
    expect(harness.timeline.lastIndexOf(`send:${PICKER_STOP_CHANNEL}`)).toBeGreaterThan(-1)
    expect(harness.window.bar()).toBeNull()
    // R12's other half: the core no longer treats the view as picking, so a late hover from a page
    // that has not caught up decides nothing.
    expect(harness.view.ask(ELEMENT)).toBeNull()
  }

  it('ends on Cancel from the bar', () => {
    const harness = harnessFor()
    const sessionId = frozen(harness)
    expect(harness.picker.barAction(sessionId, 'cancel')).toBe(true)
    expectFinished(harness)
  })

  it('ends on Escape from the page, which used to tell the core nothing', () => {
    // Half of the state divergence this plan repairs: Escape tore the page's own picker down and the
    // core went on believing the view was picking.
    const harness = harnessFor()
    const sessionId = frozen(harness)
    harness.view.tell(PICKER_ESCAPED_CHANNEL, { sessionId })
    expect(harness.window.bar()).toBeNull()
    expectFinished(harness)
  })

  it('ends on a same-document navigation', () => {
    // AE10. The old picker cleared its state on `did-start-navigation` and a single-page application
    // changing route never produced one that mattered.
    const harness = harnessFor()
    frozen(harness)
    harness.view.navigate({ isMainFrame: true, isSameDocument: true, url: `${DOCUMENT}#gallery` })
    expect(harness.window.bar()).toBeNull()
    expectFinished(harness)
  })

  it('survives a navigation in a subframe', () => {
    const harness = harnessFor()
    frozen(harness)
    harness.view.navigate({ isMainFrame: false, isSameDocument: false, url: 'https://ads.test/' })
    expect(harness.window.bar()?.mode).toBe('frozen')
  })

  it('ends when a higher-ranking surface takes the layer', () => {
    /*
      AE11. The bar's departure is announced and the session lifts its preview from there — one path
      out rather than one per cause, which is what stops a resize, a lost focus or a consent dialogue
      from leaving a document hidden by a rule that was never saved.
    */
    const harness = harnessFor()
    frozen(harness)
    harness.window.claim(consentDialogue())
    expect(harness.previews.at(-1)).toEqual({ id: 1, rule: null })
    expect(harness.view.ask(ELEMENT)).toBeNull()
  })

  it('ends when the tab it was picking in closes', () => {
    const harness = harnessFor()
    frozen(harness)
    harness.view.destroy()
    expect(harness.window.bar()).toBeNull()
  })

  it('ends when the application is quitting', () => {
    const harness = harnessFor()
    frozen(harness)
    electron.quit()
    expect(harness.previews.at(-1)).toEqual({ id: 1, rule: null })
    expect(harness.window.bar()).toBeNull()
  })

  it('ends through the contract channel’s stop, which had no caller before', () => {
    const harness = harnessFor()
    frozen(harness)
    harness.picker.stop(harness.view.id)
    expect(harness.window.bar()).toBeNull()
    expectFinished(harness)
  })

  it('starts again afterwards, with nothing of the previous attempt left', () => {
    // AE6: no reload in between, and no state from the last go interferes.
    const harness = harnessFor()
    const first = frozen(harness)
    harness.picker.barAction(first, 'cancel')
    expect(harness.picker.start(harness.view.id)).toBe(true)
    expect(harness.window.bar()?.mode).toBe('showing')
    expect(harness.window.bar()?.sessionId).not.toBe(first)
  })
})

describe('a picked rule across rapid reloads', () => {
  /** The rule editor as the application wires it: a stored rule recompiles the engine and re-serves. */
  class StoringEditor extends FakeEditor {
    readonly #onStored: (text: string) => void
    #text = ''

    constructor(onStored: (text: string) => void) {
      super()
      this.#onStored = onStored
    }

    override add(input: UserRuleInput): AddRuleResult {
      const result = super.add(input)
      if (result.outcome === 'added') {
        this.#text = this.#text === '' ? input.text : `${this.#text}\n${input.text}`
        this.#onStored(this.#text)
      }
      return result
    }
  }

  it('is in every new document’s first answer, and nothing is pushed while reloading', () => {
    /*
      The core's half of "reloading quickly sometimes shows the element". It was not the cause — the
      page applied the answer too late (`tests/components/cosmetic-preload.test.ts`) — and this is what
      rules the core out, and keeps it ruled out: after a pick is confirmed and measured, every reload
      is a new document that asks once and gets the rule, and the navigation itself pushes nothing a
      half-built document could receive in place of it.
    */
    const settings = defaultSettings()
    const engine = new FilterEngine({ lists: ['[Adblock Plus 2.0]'], getSettings: () => settings })
    const injector = new CosmeticInjector({
      getSettings: () => settings,
      stylesFor: (url) => engine.cosmeticStylesFor(url),
      openFeed: (url) => engine.openCosmeticFeed(url),
      scriptletsFor: () => [],
      proceduralFor: () => []
    })
    injector.install()
    const harness = harnessFor({
      // `index.ts`'s `userRules.onChange`, in its order: recompile, then re-serve.
      editor: new StoringEditor((text) => {
        engine.replaceUserRules(text)
        injector.refresh()
      }),
      preview: (id, rule) => {
        injector.setPreview(id, rule)
      }
    })
    const ruled = '.ad-slot { display: none !important; }'
    const pushes = (): unknown[] =>
      harness.view.sent
        .filter((entry) => entry.channel === COSMETIC_SPECIFIC_CHANNEL)
        .map((entry) => entry.payload)

    harness.view.askStyles()
    const sessionId = frozen(harness)
    harness.picker.barAction(sessionId, 'confirm')
    harness.view.tell(PICKER_MEASURED_CHANNEL, { sessionId, matches: 3, visible: 0 })
    expect(harness.window.bar()?.outcome).toBe('saved-effective')

    const before = pushes().length
    for (let reload = 0; reload < 10; reload += 1) {
      harness.view.navigate({ isMainFrame: true, isSameDocument: false, url: DOCUMENT })
      expect(harness.view.askStyles(), `reload ${String(reload)}`).toContain(ruled)
    }
    expect(pushes().slice(before)).toEqual([])
  })
})
