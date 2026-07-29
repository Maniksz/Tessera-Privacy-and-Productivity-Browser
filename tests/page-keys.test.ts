import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CLOSE_TAB_FALLBACK_DELAY_MS,
  CloseTabFallback,
  pageKeyAction,
  pageKeystrokeOf,
  type PageKeystroke
} from '@main/browser/page-keys.js'
import { DEFAULT_BINDINGS } from '@shared/shortcuts/bindings.js'
import { platformSchema, type EscalationLevel } from '@shared/model.js'

/**
 * Keys in a page (spec 2, spec 9).
 *
 * What breaks in the product if these rules are wrong, one per rule:
 *
 *   - **Recognising the close-tab chord outside window fullscreen** gives the command two live
 *     routes at once, so one press closes two tabs and there is no undo. Its own section says why
 *     it is here at all and what the guard against a double close is.
 *
 *   - **Acting when nothing is loading and nothing is escalated** makes every `Escape` a page receives
 *     also call `webContents.stop()` and walk a ladder with no rungs — a browser that reacts to a key
 *     it was not given.
 *   - **Not acting while a load is in flight** leaves `stop` exactly as dead as it was: it appears in
 *     the settings list and cancels nothing.
 *   - **Reading `keyUp` or auto-repeat as a press** turns "one rung per press" into "as many rungs as
 *     the keyboard sends", so holding `Escape` falls out of a page's fullscreen, un-maximises the tile
 *     and leaves the window's fullscreen in one gesture.
 *   - **Accepting a modified `Escape`** has the browser answering to `Shift+Escape` and
 *     `Control+Escape`, keys it never claimed and the settings screen never names.
 *
 * The last rule — that the page keeps the keystroke — is not a decision this module can express at all:
 * nothing here is handed the means to consume anything. It is a property of the subscription in
 * `Tab.ts`, and the last test in this file is the only mechanical guard there can be over it without a
 * browser process.
 */

const press = (overrides: Partial<PageKeystroke> = {}): PageKeystroke => ({
  type: 'keyDown',
  key: 'Escape',
  control: false,
  alt: false,
  shift: false,
  meta: false,
  isAutoRepeat: false,
  ...overrides
})

const state = (loading: boolean, escalation: EscalationLevel = 'none'): {
  loading: boolean
  escalation: EscalationLevel
} => ({ loading, escalation })

describe('what Escape means in a page', () => {
  it('cancels a load that is in flight', () => {
    expect(pageKeyAction(press(), 'win32', state(true))).toBe('stop-load')
  })

  it('cancels the load rather than leaving fullscreen, when both apply', () => {
    /*
      The order `bindings.ts` states, and the reason it gives: a load that has finished arriving cannot
      be un-fetched, while the ladder is still one press away. The cost is that press, and it is the
      cheaper of the two mistakes.
    */
    expect(pageKeyAction(press(), 'win32', state(true, 'window-fullscreen'))).toBe('stop-load')
  })

  it('steps down the ladder when nothing is loading', () => {
    for (const escalation of ['tile-fullscreen', 'tile-maximized', 'window-fullscreen'] as const) {
      expect(pageKeyAction(press(), 'win32', state(false, escalation)), escalation).toBe(
        'escape-ladder'
      )
    }
  })

  it('does nothing at all with nothing loading and nothing escalated', () => {
    // The ordinary case: a page, a caret in one of its fields, a dialogue of its own. The browser has
    // no answer to give, so it does not take a turn — no `stop()`, no relayout, no broadcast.
    expect(pageKeyAction(press(), 'win32', state(false, 'none'))).toBe('nothing')
  })
})

describe('which keystrokes count as a press', () => {
  it('ignores the release', () => {
    expect(pageKeyAction(press({ type: 'keyUp' }), 'win32', state(false, 'tile-maximized'))).toBe(
      'nothing'
    )
  })

  it('ignores auto-repeat while the key is held', () => {
    expect(
      pageKeyAction(press({ isAutoRepeat: true }), 'win32', state(false, 'window-fullscreen'))
    ).toBe('nothing')
  })

  it('ignores every other key', () => {
    for (const key of ['a', 'Enter', 'Tab', 'F5']) {
      expect(pageKeyAction(press({ key }), 'win32', state(true, 'tile-maximized')), key).toBe(
        'nothing'
      )
    }
  })

  it('ignores a modified Escape', () => {
    const modifiers = ['control', 'alt', 'shift', 'meta'] as const
    for (const modifier of modifiers) {
      expect(
        pageKeyAction(press({ [modifier]: true }), 'win32', state(true, 'tile-maximized')),
        modifier
      ).toBe('nothing')
    }
  })
})

describe('the macOS stop key', () => {
  it('cancels a load in flight', () => {
    expect(pageKeyAction(press({ key: '.', meta: true }), 'darwin', state(true))).toBe('stop-load')
  })

  it('is not a route into the ladder', () => {
    /*
      `Command+.` is `stop`'s primary key on macOS and `stop` only. Someone in a fullscreen tile who
      presses it has asked to stop a load; `Escape` is the key spec 9 gives the ladder, and one key
      doing both jobs would leave the mac with no way to ask for only the first.
    */
    expect(
      pageKeyAction(press({ key: '.', meta: true }), 'darwin', state(false, 'window-fullscreen'))
    ).toBe('nothing')
  })

  it('is macOS only, because that is where the table puts it', () => {
    for (const platform of ['win32', 'linux'] as const) {
      expect(
        pageKeyAction(press({ key: '.', meta: true }), platform, state(true)),
        platform
      ).toBe('nothing')
    }
  })

  it('needs Command alone', () => {
    // `Control+Command+.` is not a binding this project writes down anywhere.
    expect(
      pageKeyAction(press({ key: '.', meta: true, control: true }), 'darwin', state(true))
    ).toBe('nothing')
  })
})

describe('the close-tab chord, which is only a fallback', () => {
  /*
    Reported from real use: "in f11 funktioniert kein strg+w", confirmed as `Command+W` on macOS —
    working normally, dead in window fullscreen. The cause is Electron's promotion of an unhandled
    key from a child `WebContentsView` to the application menu, which is not code this repository
    has; this decision is a second route to the same command for exactly that state.

    What breaks if these are wrong: **too wide** and every `Command+W` outside fullscreen closes two
    tabs, one per route, with no undo. **Too narrow** and the key stays dead where it was reported.
  */
  it('closes the tab when the window is fullscreen and the menu has stopped answering', () => {
    expect(
      pageKeyAction(press({ key: 'w', meta: true }), 'darwin', state(false, 'window-fullscreen'))
    ).toBe('close-tab')
    expect(
      pageKeyAction(press({ key: 'w', control: true }), 'win32', state(false, 'window-fullscreen'))
    ).toBe('close-tab')
  })

  it('does nothing at any other escalation, because there the menu works', () => {
    // The narrowing is the whole safety argument. A second route where the first one already fires
    // closes two tabs for one press.
    for (const escalation of ['none', 'tile-fullscreen', 'tile-maximized'] as const) {
      expect(
        pageKeyAction(press({ key: 'w', meta: true }), 'darwin', state(false, escalation)),
        escalation
      ).toBe('nothing')
    }
  })

  it('closes the tab rather than stopping its load', () => {
    // Unlike `Escape`, this chord means one thing. Someone pressing it on a page that is still
    // fetching has asked to close that page, and `stop` has its own key.
    expect(
      pageKeyAction(press({ key: 'w', meta: true }), 'darwin', state(true, 'window-fullscreen'))
    ).toBe('close-tab')
  })

  it('takes the platform’s own modifier and refuses the other one', () => {
    // `Control+W` on macOS is not a binding this project writes down, and `Command+W` on Windows is
    // not one either. Answering to both would be the browser claiming keys the settings list omits.
    expect(
      pageKeyAction(press({ key: 'w', control: true }), 'darwin', state(false, 'window-fullscreen'))
    ).toBe('nothing')
    expect(
      pageKeyAction(press({ key: 'w', meta: true }), 'win32', state(false, 'window-fullscreen'))
    ).toBe('nothing')
    expect(
      pageKeyAction(
        press({ key: 'w', meta: true, control: true }),
        'darwin',
        state(false, 'window-fullscreen')
      )
    ).toBe('nothing')
  })

  it('refuses a bare W, and Shift+W with it', () => {
    // Typing the letter into a page's text field must not close the page.
    expect(pageKeyAction(press({ key: 'w' }), 'win32', state(false, 'window-fullscreen'))).toBe(
      'nothing'
    )
    expect(
      pageKeyAction(press({ key: 'W', shift: true, control: true }), 'win32', state(false, 'window-fullscreen'))
    ).toBe('nothing')
  })

  it('survives Caps Lock', () => {
    /*
      Caps Lock reports `key: 'W'` with `shift: false`, so a comparison against `'w'` alone would
      leave `Command+W` dead in fullscreen for anyone who had left it on — and nowhere else, which
      is a bug report nobody could reproduce.
    */
    expect(
      pageKeyAction(press({ key: 'W', meta: true }), 'darwin', state(false, 'window-fullscreen'))
    ).toBe('close-tab')
  })

  it('ignores the release and auto-repeat, the same as every other key here', () => {
    for (const overrides of [{ type: 'keyUp' }, { isAutoRepeat: true }]) {
      expect(
        pageKeyAction(
          press({ key: 'w', meta: true, ...overrides }),
          'darwin',
          state(false, 'window-fullscreen')
        ),
        JSON.stringify(overrides)
      ).toBe('nothing')
    }
  })
})

describe('the guard that makes a double close impossible', () => {
  /*
    Both routes firing would close two tabs for one press and lose a page with no undo, so the
    fallback does not close anything itself until the menu has demonstrably not done it.

    A fake clock rather than real timers: what is being asserted is the *order* of arm, cancel and
    fire, and a test that waited would be asserting a duration nobody promised.
  */
  const fallback = (): {
    closed: string[]
    run: () => void
    pending: () => boolean
    delays: number[]
    guard: CloseTabFallback
  } => {
    const closed: string[] = []
    const delays: number[] = []
    let scheduled: (() => void) | null = null
    const guard = new CloseTabFallback({
      closeTab: (tabId) => closed.push(tabId),
      after: (delayMs, task) => {
        delays.push(delayMs)
        scheduled = task
        return () => {
          scheduled = null
        }
      }
    })
    return {
      closed,
      delays,
      guard,
      pending: () => scheduled !== null,
      run: () => {
        const task = scheduled
        scheduled = null
        task?.()
      }
    }
  }

  it('closes nothing until the delay has passed', () => {
    const h = fallback()
    h.guard.arm('tab-a')
    expect(h.closed).toEqual([])
    expect(h.guard.armed).toBe(true)
    expect(h.delays).toEqual([CLOSE_TAB_FALLBACK_DELAY_MS])

    h.run()
    expect(h.closed).toEqual(['tab-a'])
    expect(h.guard.armed).toBe(false)
  })

  it('closes nothing at all when the menu got there first', () => {
    /*
      **The assertion this whole design exists for.** The window calls `cancel` on every close from
      any route, so the accelerator arriving — even a moment before the delay expires — leaves the
      fallback with nothing to do.
    */
    const h = fallback()
    h.guard.arm('tab-a')
    h.guard.cancel()

    expect(h.pending(), 'the timer was left running').toBe(false)
    h.run()
    expect(h.closed).toEqual([])
  })

  it('re-arming replaces the pending close rather than queueing a second', () => {
    const h = fallback()
    h.guard.arm('tab-a')
    h.guard.arm('tab-b')
    h.run()
    expect(h.closed).toEqual(['tab-b'])
  })

  it('is idle after it has fired, so the window cancelling its own close is harmless', () => {
    // The fallback closes through the window, and the window cancels on every close — so the fired
    // fallback would be cancelling itself mid-flight if it were still armed at that point.
    const h = fallback()
    h.guard.arm('tab-a')
    h.run()
    expect(h.guard.armed).toBe(false)
    h.guard.cancel()
    expect(h.closed).toEqual(['tab-a'])
  })

  it('tolerates a cancel with nothing armed', () => {
    // Every close in the window calls this, and almost none of them follow a keystroke.
    const h = fallback()
    expect(() => h.guard.cancel()).not.toThrow()
    expect(h.guard.armed).toBe(false)
  })
})

describe('the three keys this matcher knows, against the table it comes from', () => {
  it('answers to every accelerator the binding table gives stop and escape', () => {
    /*
      A fitness function, and the one test here that will actually fail one day.

      The matcher spells out two key shapes; the binding table is where a third would be added, and it
      is three files away from this decision. A key added there and not here is the same silent failure
      the whole "twelve dead keys" episode was made of: the settings screen lists it, nothing rejects
      it, and it does nothing. Written as the expected *set* per platform rather than as a loop over a
      translator, because a translator from an accelerator string to a keystroke would be a second
      implementation of the matcher — and a test that reimplements the thing it checks agrees with
      itself no matter which of the two is wrong.
    */
    const known: Record<
      string,
      { stop: readonly string[]; escape: readonly string[]; closeTab: readonly string[] }
    > = {
      win32: { stop: ['Escape'], escape: ['Escape'], closeTab: ['Control+W'] },
      linux: { stop: ['Escape'], escape: ['Escape'], closeTab: ['Control+W'] },
      darwin: { stop: ['Command+.', 'Escape'], escape: ['Escape'], closeTab: ['Command+W'] }
    }

    for (const platform of platformSchema.options) {
      const expected = known[platform]
      expect(expected, `${platform} is not covered by this test`).toBeDefined()
      expect(DEFAULT_BINDINGS[platform].stop, `${platform} stop`).toEqual(expected?.stop)
      expect(DEFAULT_BINDINGS[platform].escape, `${platform} escape`).toEqual(expected?.escape)
      /*
        `closeTab` is here for a different reason from the other two, and a sharper one. They are
        matched here *because* they can have no menu item; this one has one, and the matcher only
        duplicates it for the state where it stops being reached. A second accelerator added to this
        row would therefore be a key the menu answers and this does not — the dead-key failure again,
        in the one place a second route makes it invisible rather than merely silent.
      */
      expect(DEFAULT_BINDINGS[platform].closeTab, `${platform} closeTab`).toEqual(expected?.closeTab)
      expect(
        DEFAULT_BINDINGS[platform].closeTab.length,
        `${platform} closeTab has a sibling accelerator this matcher does not know`
      ).toBe(1)
    }
  })
})

describe('reading Electron’s input payload', () => {
  it('reads a full keystroke', () => {
    expect(
      pageKeystrokeOf({
        type: 'keyDown',
        key: 'Escape',
        code: 'Escape',
        control: false,
        alt: false,
        shift: true,
        meta: false,
        isAutoRepeat: false,
        location: 0,
        modifiers: ['shift']
      })
    ).toEqual({
      type: 'keyDown',
      key: 'Escape',
      control: false,
      alt: false,
      shift: true,
      meta: false,
      isAutoRepeat: false
    })
  })

  it('refuses anything that is not a keystroke', () => {
    // Every kind of input arrives on this subscription: wheels, gestures, mouse moves with no `key` at
    // all. Reading one of those as a keystroke would be a `key` of `undefined` compared against
    // `'Escape'` — harmless by luck rather than by rule.
    expect(pageKeystrokeOf(null)).toBeNull()
    expect(pageKeystrokeOf('keyDown')).toBeNull()
    expect(pageKeystrokeOf({ type: 'mouseMove', x: 4, y: 9 })).toBeNull()
    expect(pageKeystrokeOf({ key: 'Escape' })).toBeNull()
  })

  it('reads an absent modifier as not held', () => {
    /*
      The modifiers are the same object's own booleans and have never been absent. Refusing the whole
      keystroke over one would trade a working `Escape` for a field that does not go missing, so they
      are read rather than validated — and this says which way that goes.
    */
    expect(pageKeystrokeOf({ type: 'keyDown', key: 'Escape' })).toEqual({
      type: 'keyDown',
      key: 'Escape',
      control: false,
      alt: false,
      shift: false,
      meta: false,
      isAutoRepeat: false
    })
  })
})

describe('the keystroke the page always keeps', () => {
  it('never lets the browser take it away', () => {
    /*
      A source scan, because what is being asserted is the *absence* of one call in a file that cannot
      run outside a browser process — and it is the assertion this whole design turns on. Neither a
      caret in a page's text field nor a page's own `Escape` handler is visible from the main process
      when `before-input-event` fires, and both outrank the browser's ladder, so the only rule that
      cannot be wrong about them is to consume nothing.

      Losing that would be silent: every test above would still pass, and the symptom would be a website
      whose dialogue will not close, or a search box that cannot be cleared, on whichever pages happen
      to have a subresource still loading.

      Comments are stripped first, the same way `architecture.test.ts` does it for its own scans: the
      docblock over that subscription has to be able to *say* which call it is not making, and a scan
      over the raw text would trip on the sentence explaining itself.
    */
    const source = readFileSync(join(process.cwd(), 'src/main/browser/Tab.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

    expect(code, 'the keystroke subscription is gone, so Escape reaches nothing').toContain(
      "on('before-input-event'"
    )
    expect(code, 'something in Tab.ts now consumes a keystroke; see page-keys.ts').not.toContain(
      'preventDefault'
    )
  })
})
