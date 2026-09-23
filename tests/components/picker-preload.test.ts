/** @vitest-environment happy-dom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_PICKER_CHAIN,
  PICKER_ESCAPED_CHANNEL,
  PICKER_FREEZE_CHANNEL,
  PICKER_MEASURED_CHANNEL,
  PICKER_MEASURE_CHANNEL,
  PICKER_PROPOSE_CHANNEL,
  PICKER_SELECT_CHANNEL,
  PICKER_START_CHANNEL,
  PICKER_STOP_CHANNEL,
  asElementDescription
} from '@shared/filters/picker-wire.js'
import type { PickerCandidate } from '@shared/filters/picker-session.js'

/**
 * The page half of the element picker: the click that freezes, the chain it hands over, and what the
 * document says a selector actually did.
 *
 * ## Why this file is in `tests/components/` although it renders no component
 *
 * Because what it needs is a **document**. Every decision in `src/preload/picker.ts` is about one:
 * where the host hangs, which element a capture-phase listener saw, how many things a selector
 * matches and whether any of them is still drawn. The `unit` project runs in `environment: node`
 * and, since a `.ts` test first needed a DOM, explicitly excludes this folder — so a DOM test here
 * would fail on `document` being undefined for reasons that have nothing to do with the code. The
 * `components` project is happy-dom and takes `.ts` as well as `.tsx`, for exactly this case; the
 * procedural filter matcher is already here on the same grounds.
 *
 * ## What this file cannot prove, and who does
 *
 * That a *real* pointer lands where the picker thinks it does. `docs/solutions/ui-issues/
 * chrome-popups-behind-content-views.md` is the case in this project's own history where a
 * synthetic `element.click()` passed while real hit-testing was broken, so nothing below calls
 * `.click()`. What it does instead is drive the whole sequence Chromium dispatches —
 * `pointerdown → mousedown → pointerup → mouseup → click` — through the same capture-phase
 * listeners the browser would, and assert that the page's own handlers never ran. That is the
 * strongest statement a test without an OS pointer can make. The rest is the manual gate in the
 * plan's verification contract: a real click on an element with its own `pointerdown` handler, in
 * the running application.
 *
 * ## Why the preload module is imported rather than reimplemented
 *
 * `installElementPicker` holds module-level state — one session, its listeners, its host — and every
 * bug this unit repairs was in that state's lifetime rather than in a pure function. `electron` is
 * the only thing stubbed, and it is stubbed as a message bus rather than as a set of expectations,
 * so what these tests read is what the core would receive.
 */

const bus = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  const sent: { channel: string; payload: unknown }[] = []
  return {
    listeners,
    sent,
    /** What the core answers a hover or a rung with. Replaced per test where the answer matters. */
    propose: (_description: unknown): unknown => null,
    ipcRenderer: {
      on(channel: string, listener: (event: unknown, payload: unknown) => void): void {
        listeners.set(channel, listener)
      },
      send(channel: string, payload: unknown): void {
        sent.push({ channel, payload })
      },
      sendSync(channel: string, payload: unknown): unknown {
        if (channel !== PICKER_PROPOSE_CHANNEL) return null
        return bus.propose(payload)
      }
    }
  }
})

vi.mock('electron', () => ({ ipcRenderer: bus.ipcRenderer }))

const { installElementPicker } = await import('../../src/preload/picker.js')

installElementPicker()

const SESSION = 'picker-1'
const STYLES = '.box { border: 2px solid blue }'

/** A proposal for whatever the page described: its id, else its first class, else its tag. */
function selectorOf(payload: unknown): { selector: string; estimatedMatches: number } | null {
  const described = asElementDescription(payload)
  if (described === null) return null
  const selector =
    described.id !== null
      ? `#${described.id}`
      : (described.classes[0] ?? '').length > 0
        ? `.${described.classes[0] ?? ''}`
        : described.tag
  return { selector, estimatedMatches: 1 }
}

function deliver(channel: string, payload: unknown): void {
  bus.listeners.get(channel)?.({}, payload)
}

function begin(sessionId = SESSION): void {
  deliver(PICKER_START_CHANNEL, {
    sessionId,
    styles: STYLES,
    hint: 'hint',
    noRule: 'no rule',
    warnings: {}
  })
}

function messages(channel: string): unknown[] {
  return bus.sent.filter((message) => message.channel === channel).map((message) => message.payload)
}

/** The host the preload puts in the page, or null once it has taken it out again. */
function hostElement(): Element | null {
  return document.getElementById('tessera-picker')
}

/**
 * A box for an element, because happy-dom has no layout.
 *
 * Everything reports 0×0 here, which the preload reads as "not drawn" — correct for a real browser
 * and useless as a fixture, since it would make every assertion about visibility pass for the wrong
 * reason. So the elements that are meant to be on screen are given one, and the stub doubles as the
 * only way to observe the highlight: the shadow root is closed, so where the box was moved to can be
 * read from *which element was asked for its geometry* and from nowhere else.
 */
function withBox(element: Element, width = 100, height = 20): ReturnType<typeof vi.fn> {
  const rect = vi.fn(() => ({ left: 5, top: 7, width, height }) as unknown as DOMRect)
  element.getBoundingClientRect = rect
  return rect
}

/**
 * An event marked as the browser's own, which is what a real pointer or key produces.
 *
 * The picker acts only on `isTrusted` events — a page can dispatch any event it likes at its own
 * elements, and a synthetic click must not choose what the user is offered to hide. happy-dom does not
 * implement `isTrusted` at all, so every event here reads `undefined`, which the preload treats as
 * untrusted — exactly what it must do with one. This stamps the flag on to stand in for the OS.
 *
 * A page cannot do the same in Chromium, which is why the check is a real boundary rather than a
 * convention: `isTrusted` is an unforgeable own property there (redefining it throws), and the
 * preload runs in an isolated world that sees its own wrapper of the event, not the page's.
 */
function trusted<T extends Event>(event: T): T {
  Object.defineProperty(event, 'isTrusted', { value: true })
  return event
}

/**
 * The full press, as Chromium dispatches it, on a real target.
 *
 * `dispatchEvent` and not `element.click()`: the point is that each event travels the tree and meets
 * the picker's capture-phase listener on `window` before the target's own handlers. Trusted unless
 * the test is about a press the page made up.
 */
function press(target: Element, { fromPage = false }: { fromPage?: boolean } = {}): Event[] {
  const fired: Event[] = []
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const event = type.startsWith('pointer')
      ? new PointerEvent(type, { bubbles: true, cancelable: true })
      : new MouseEvent(type, { bubbles: true, cancelable: true })
    target.dispatchEvent(fromPage ? event : trusted(event))
    fired.push(event)
  }
  return fired
}

/** Escape, as the keyboard sends it. */
function escape(target: EventTarget = document.body): KeyboardEvent {
  const event = trusted(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  )
  target.dispatchEvent(event)
  return event
}

/** Records every event of a press that reached the element itself, in either phase. */
function watch(target: Element): string[] {
  const seen: string[] = []
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'keydown']) {
    target.addEventListener(type, () => seen.push(type))
    window.addEventListener(type, () => seen.push(`window:${type}`), { capture: true })
  }
  return seen
}

beforeEach(() => {
  bus.sent.length = 0
  bus.propose = selectorOf
  document.body.innerHTML = ''
  for (const stray of document.querySelectorAll('#tessera-picker')) stray.remove()
})

afterEach(() => {
  deliver(PICKER_STOP_CHANNEL, undefined)
})

describe('entering the mode', () => {
  it('anchors its host on the document element rather than on body', () => {
    /*
      A `transform` on any ancestor becomes the containing block for `position: fixed` descendants,
      and page transitions and drawer animations put one on `<body>` constantly. Hung there, the
      highlight would be drawn at an offset from the element it is meant to be around — a picker that
      points next to the thing you are trying to block.
    */
    begin()
    expect(hostElement()?.parentElement).toBe(document.documentElement)
    expect(document.body.querySelector('#tessera-picker')).toBeNull()
  })

  it('refuses a start that names no attempt, because every answer has to echo one', () => {
    deliver(PICKER_START_CHANNEL, { styles: STYLES, hint: 'h', noRule: 'n', warnings: {} })
    expect(hostElement()).toBeNull()
  })

  it('draws a highlight and no bar', () => {
    // The bar is an overlay surface now (KTD1). What is left here is one rectangle, and this is what
    // keeps it from growing a second user interface inside the page again.
    begin()
    const host = hostElement()
    expect(host).not.toBeNull()
    // A closed shadow root: the page's scripts must not be able to read what is being proposed.
    expect(host?.shadowRoot).toBeNull()
    expect(host?.textContent).toBe('')
  })
})

describe('the click, driven as a real press', () => {
  it('freezes the selection and lets nothing through to the page', () => {
    /*
      The reported defect, in one assertion: *"wenn ich ein element blockieren will, dann wird das
      element dennoch angeklickt"*. `click` is the last event of a press and most of the web does not
      wait for it — a menu opens on `mousedown`, a framework's handler sits on `pointerdown` — so the
      whole sequence has to be taken away, not only the end of it.
    */
    document.body.innerHTML = '<main><button id="buy" class="cta">Buy</button></main>'
    const button = document.getElementById('buy')!
    begin()
    const seen = watch(button)

    const fired = press(button)

    expect(seen).toEqual([])
    // Default prevented for the mouse events, so no focus, no selection, no navigation. Not for the
    // pointer events: cancelling those suppresses the compatibility mouse events that follow.
    expect(fired.filter((event) => event.defaultPrevented).map((event) => event.type)).toEqual([
      'mousedown',
      'mouseup',
      'click'
    ])
  })

  it('sends the clicked element first and then outwards', () => {
    document.body.innerHTML =
      '<div class="page"><section class="slot"><i id="x"></i></section></div>'
    begin()
    press(document.getElementById('x')!)

    const [report] = messages(PICKER_FREEZE_CHANNEL) as {
      sessionId: string
      chain: PickerCandidate[]
    }[]
    expect(report?.sessionId).toBe(SESSION)
    expect(report?.chain.map((rung) => rung.tag)).toEqual(['i', 'section', 'div'])
    expect(report?.chain[0]?.proposal.selector).toBe('#x')
  })

  it('stops the chain below body, whatever the tree above it is', () => {
    // KTD11, applied here as well as in the core: `html##html` empties the page, and `body` very
    // nearly does. A rung that would be cut on arrival is not worth a round trip or a count.
    document.body.innerHTML = '<div class="wrap"><p class="line">text</p></div>'
    begin()
    press(document.querySelector('.line')!)

    const [report] = messages(PICKER_FREEZE_CHANNEL) as { chain: PickerCandidate[] }[]
    expect(report?.chain.map((rung) => rung.tag)).toEqual(['p', 'div'])
  })

  it('counts every rung in the open document rather than estimating it', () => {
    // R9. The estimate the core can make is taken against the one element it was told about; a
    // person deciding whether to hide one thing or three needs the document's own answer.
    document.body.innerHTML =
      '<div class="wrap"><span class="ad"></span><span class="ad"></span><span class="ad"></span></div>'
    begin()
    press(document.querySelectorAll('.ad')[1]!)

    const [report] = messages(PICKER_FREEZE_CHANNEL) as { chain: PickerCandidate[] }[]
    expect(report?.chain[0]).toMatchObject({ tag: 'span', matches: 3 })
    expect(report?.chain[1]).toMatchObject({ tag: 'div', matches: 1 })
  })

  it('never offers more rungs than the core would accept', () => {
    // Every rung is presented, previewed and measured. The bound is the core's, applied here so the
    // work beyond it is never done rather than done and thrown away.
    let markup = '<i id="deep"></i>'
    for (let depth = 0; depth < MAX_PICKER_CHAIN + 5; depth += 1) markup = `<div>${markup}</div>`
    document.body.innerHTML = markup
    begin()
    press(document.getElementById('deep')!)

    const [report] = messages(PICKER_FREEZE_CHANNEL) as { chain: PickerCandidate[] }[]
    expect(report?.chain).toHaveLength(MAX_PICKER_CHAIN)
  })

  it('ends the chain at a rung the core cannot describe instead of leaving a hole in it', () => {
    /*
      The rungs are *positions* — index 0 is the clicked element and widening counts outwards — and
      one unreadable rung rejects the whole click on arrival. A hole quietly closed would answer
      "wider" with an ancestor two steps away, which is the one mistake in this feature a person
      cannot see before they confirm it.
    */
    document.body.innerHTML =
      '<div class="wrap"><section class="slot"><i id="x"></i></section></div>'
    begin()
    bus.propose = (payload) => {
      const proposal = selectorOf(payload)
      return proposal?.selector === '.slot' ? null : proposal
    }
    press(document.getElementById('x')!)

    const [report] = messages(PICKER_FREEZE_CHANNEL) as { chain: PickerCandidate[] }[]
    expect(report?.chain.map((rung) => rung.tag)).toEqual(['i'])
  })

  it('says nothing at all when no rung could be described', () => {
    // A click the core would refuse anyway. Not sending it leaves the picker in the state the user
    // can still act in, rather than in one waiting for an answer that will not come.
    document.body.innerHTML = '<i id="x"></i>'
    begin()
    bus.propose = () => null
    press(document.getElementById('x')!)

    expect(messages(PICKER_FREEZE_CHANNEL)).toEqual([])
  })

  it('reports one click however many arrive', () => {
    // The sequence is swallowed, but "swallowed" is not "impossible". A second freeze would move the
    // selection under somebody who is reading the selector.
    document.body.innerHTML = '<div class="wrap"><i id="x"></i></div>'
    begin()
    press(document.getElementById('x')!)
    press(document.getElementById('x')!)

    expect(messages(PICKER_FREEZE_CHANNEL)).toHaveLength(1)
  })
})

describe('walking the frozen chain', () => {
  /** The three rungs' geometry stubs, in chain order: the clicked element, then outwards. */
  function freeze(): ReturnType<typeof vi.fn>[] {
    document.body.innerHTML =
      '<div class="wrap"><section class="slot"><i id="x"></i></section></div>'
    const rungs = [
      withBox(document.getElementById('x')!, 40, 10),
      withBox(document.querySelector('.slot')!, 120, 60),
      withBox(document.querySelector('.wrap')!, 300, 200)
    ]
    begin()
    press(document.getElementById('x')!)
    for (const rung of rungs) rung.mockClear()
    return rungs
  }

  it('moves the highlight onto the rung the core chose', () => {
    /*
      The only observation a test outside a browser can make of a closed shadow root, and it is the
      right one: the highlight is positioned from the chosen element's own geometry, so the element
      that is asked for it *is* the element the highlight moved to. The chain is held as elements
      rather than re-resolved from a selector, which is why an index is all the core has to send.
    */
    const [clicked, slot, wrap] = freeze()
    deliver(PICKER_SELECT_CHANNEL, { sessionId: SESSION, index: 1 })
    expect(slot).toHaveBeenCalled()
    expect(clicked).not.toHaveBeenCalled()
    expect(wrap).not.toHaveBeenCalled()

    deliver(PICKER_SELECT_CHANNEL, { sessionId: SESSION, index: 0 })
    expect(clicked).toHaveBeenCalled()
  })

  it('ignores a correction that names another attempt', () => {
    // A late answer for an attempt that is over, in a view where a second one has since started.
    const [, slot] = freeze()
    deliver(PICKER_SELECT_CHANNEL, { sessionId: 'picker-99', index: 1 })
    expect(slot).not.toHaveBeenCalled()
  })

  it('survives a rung whose element left the document before the correction arrived', () => {
    // Ordinary on a page that re-renders: the chain is elements, and one of them can be detached by
    // the time somebody presses "wider". A detached element reports nothing but zeroes, and a 0×0
    // rectangle with a border is a blue dot in the corner pointing at nothing.
    freeze()
    const slot = document.querySelector('.slot')!
    slot.getBoundingClientRect = (): DOMRect =>
      ({ left: 0, top: 0, width: 0, height: 0 }) as unknown as DOMRect
    slot.remove()
    expect(() => {
      deliver(PICKER_SELECT_CHANNEL, { sessionId: SESSION, index: 1 })
    }).not.toThrow()
  })

  it('ignores an index past the end of the chain', () => {
    const rungs = freeze()
    deliver(PICKER_SELECT_CHANNEL, { sessionId: SESSION, index: 50 })
    for (const rung of rungs) expect(rung).not.toHaveBeenCalled()
  })

  it('ignores a correction that arrives before anything was frozen', () => {
    document.body.innerHTML = '<i id="x"></i>'
    const clicked = withBox(document.getElementById('x')!)
    begin()
    clicked.mockClear()
    deliver(PICKER_SELECT_CHANNEL, { sessionId: SESSION, index: 0 })
    expect(clicked).not.toHaveBeenCalled()
  })
})

describe('measuring what a rule did', () => {
  /** The two counts of the last answer, with the echoed session dropped — it has its own test. */
  function ask(selector: string, sessionId = SESSION): { matches: number; visible: number } | null {
    deliver(PICKER_MEASURE_CHANNEL, { sessionId, selector })
    const answers = messages(PICKER_MEASURED_CHANNEL) as {
      sessionId: string
      matches: number
      visible: number
    }[]
    const answer = answers.at(-1)
    return answer === undefined ? null : { matches: answer.matches, visible: answer.visible }
  }

  it('echoes the attempt the question named', () => {
    // Every message back carries it, and the core discards one naming a different attempt: a
    // measurement is two round trips late by construction, and the ways a session ends are mostly
    // not clicks.
    document.body.innerHTML = '<i class="ad"></i>'
    begin()
    deliver(PICKER_MEASURE_CHANNEL, { sessionId: SESSION, selector: '.ad' })
    expect(messages(PICKER_MEASURED_CHANNEL)).toEqual([
      { sessionId: SESSION, matches: 1, visible: 0 }
    ])
  })

  it('counts what the selector matches in the document', () => {
    document.body.innerHTML = '<i class="ad"></i><i class="ad"></i><i class="ad"></i>'
    begin()
    expect(ask('.ad')?.matches).toBe(3)
  })

  it("never counts the picker's own host", () => {
    /*
      The host is an element in this document, so a broad selector matches it — and it is always
      drawn. Counted, it would be the one match that makes every rule look ineffective, and the
      picker would report its own presence as the rule's effect.
    */
    document.body.innerHTML = '<div class="wrap"></div>'
    withBox(document.querySelector('.wrap')!)
    begin()
    withBox(hostElement()!)
    expect(ask('div')).toEqual({ matches: 1, visible: 1 })
  })

  it('answers a selector that matches nothing with zero rather than with an error', () => {
    // Not a failure: an advert loaded a second later can still be caught by the same rule, so the
    // session module calls this "does not work here" (KTD8, OQ1) and nothing here calls it wrong.
    document.body.innerHTML = '<p>text</p>'
    begin()
    expect(ask('.ad')).toEqual({ matches: 0, visible: 0 })
  })

  it('survives a selector the document refuses to parse', () => {
    // The core sends plain CSS, so this is totality rather than distrust — but an exception escaping
    // a listener in a preload is an exception in the page's own script context.
    begin()
    expect(ask('div[')).toEqual({ matches: 0, visible: 0 })
  })

  it('counts a match that is still on screen as visible', () => {
    // The half that makes the measurement worth taking: a hidden element still matches its selector,
    // so a count alone would report success whatever the rule did.
    document.body.innerHTML = '<i class="ad"></i>'
    withBox(document.querySelector('.ad')!)
    begin()
    expect(ask('.ad')).toEqual({ matches: 1, visible: 1 })
  })

  it('does not count one a rule has switched off', () => {
    // What a cosmetic rule actually writes: `display: none !important`.
    document.body.innerHTML = '<i class="ad" style="display: none"></i>'
    withBox(document.querySelector('.ad')!)
    begin()
    expect(ask('.ad')).toEqual({ matches: 1, visible: 0 })
  })

  it('does not count one hidden by visibility, which keeps its box', () => {
    // Geometry alone would call this drawn: `visibility: hidden` leaves the element's box exactly
    // where it was. Some hand-written rules hide this way rather than with `display`.
    document.body.innerHTML = '<i class="ad" style="visibility: hidden"></i>'
    withBox(document.querySelector('.ad')!)
    begin()
    expect(ask('.ad')).toEqual({ matches: 1, visible: 0 })
  })

  it('does not count one collapsed to no size at all', () => {
    // The case neither style property names: an ancestor hidden instead of the element, or a slot
    // whose content went and left it at nothing.
    document.body.innerHTML = '<i class="ad"></i>'
    begin()
    expect(ask('.ad')).toEqual({ matches: 1, visible: 0 })
  })

  it('refuses to measure for an attempt that is not this one', () => {
    document.body.innerHTML = '<i class="ad"></i>'
    begin()
    expect(ask('.ad', 'picker-99')).toBeNull()
  })

  it('refuses to measure when no attempt is running at all', () => {
    // The channel is the core's, but a preload answers whatever reaches it. A measurement of a
    // document nobody asked about would arrive at the core naming a session it has already ended.
    document.body.innerHTML = '<i class="ad"></i>'
    expect(ask('.ad')).toBeNull()
  })
})

describe('events the page made up', () => {
  /*
    The page can see the picker is up — its host is an element in the page's own document — and it can
    dispatch any event it likes. Acting on those would hand it two powers it has no other way to get:
    choosing which of its elements the user is shown as the thing to hide, and ending the user's attempt
    with an Escape nobody pressed. What it still gets is swallowing, on purpose; see the preload.
  */

  it('does not freeze on a click the page dispatched itself, and still swallows it', () => {
    document.body.innerHTML = '<main><button id="buy" class="cta">Buy</button></main>'
    const button = document.getElementById('buy')!
    begin()
    const seen = watch(button)

    press(button, { fromPage: true })
    expect(messages(PICKER_FREEZE_CHANNEL)).toEqual([])
    expect(seen).toEqual([])

    // The user's own press afterwards is the one that freezes.
    press(button)
    expect(messages(PICKER_FREEZE_CHANNEL)).toHaveLength(1)
  })

  it('does not end the attempt on an Escape the page dispatched itself', () => {
    begin()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)

    expect(messages(PICKER_ESCAPED_CHANNEL)).toEqual([])
    expect(hostElement()).not.toBeNull()
    expect(event.defaultPrevented).toBe(true)
  })

  it('does not follow a hover the page made up', () => {
    // A synthetic `mouseover` would move the highlight and have the bar name an element the pointer is
    // not over — the same choice made for the user, one step earlier.
    document.body.innerHTML = '<i id="x"></i>'
    const target = document.getElementById('x')!
    const rect = withBox(target)
    const asked: unknown[] = []
    bus.propose = (payload) => {
      asked.push(payload)
      return selectorOf(payload)
    }
    begin()

    target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(asked).toEqual([])
    expect(rect).not.toHaveBeenCalled()

    target.dispatchEvent(trusted(new MouseEvent('mouseover', { bubbles: true })))
    expect(asked).toHaveLength(1)
  })
})

describe('leaving the mode', () => {
  it('tells the core about Escape instead of only tearing itself down', () => {
    /*
      The message that did not exist, and its absence is half of the state divergence this rebuild
      repairs: Escape cleared the page's own picker and said nothing, so the core went on believing
      the view was picking and the next start found a session already running.
    */
    begin()
    const seen = watch(document.body)
    const event = escape()

    expect(messages(PICKER_ESCAPED_CHANNEL)).toEqual([{ sessionId: SESSION }])
    expect(hostElement()).toBeNull()
    // The same strictness the pointer sequence gets. A page listening for Escape on `window` in the
    // capture phase would otherwise close its own dialogue beside this.
    expect(seen).toEqual([])
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves nothing behind when the core says stop', () => {
    /*
      A picker that left one `click` handler behind would swallow the next click the user made on the
      page, with nothing on screen to explain why — so the proof is not that the host is gone but
      that a press reaches the page again.
    */
    document.body.innerHTML = '<button id="buy">Buy</button>'
    const button = document.getElementById('buy')!
    begin()
    deliver(PICKER_STOP_CHANNEL, undefined)

    expect(hostElement()).toBeNull()
    const seen = watch(button)
    press(button)
    expect(seen).toEqual([
      'window:pointerdown',
      'pointerdown',
      'window:mousedown',
      'mousedown',
      'window:pointerup',
      'pointerup',
      'window:mouseup',
      'mouseup',
      'window:click',
      'click'
    ])
    expect(messages(PICKER_FREEZE_CHANNEL)).toEqual([])
  })

  it('starts again after an Escape without a reload', () => {
    // AE6. A second start finding leftover state was the observable half of the divergence.
    begin()
    escape()
    begin('picker-2')
    expect(hostElement()).not.toBeNull()

    document.body.innerHTML = '<div class="wrap"><i id="x"></i></div>'
    press(document.getElementById('x')!)
    const [report] = messages(PICKER_FREEZE_CHANNEL) as { sessionId: string }[]
    expect(report?.sessionId).toBe('picker-2')
  })
})
