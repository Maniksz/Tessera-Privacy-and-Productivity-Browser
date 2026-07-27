import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pageKeyAction, pageKeystrokeOf, type PageKeystroke } from '@main/browser/page-keys.js'
import { DEFAULT_BINDINGS } from '@shared/shortcuts/bindings.js'
import { platformSchema, type EscalationLevel } from '@shared/model.js'

/**
 * `Escape` in a page (spec 2, spec 9).
 *
 * What breaks in the product if these rules are wrong, one per rule:
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

describe('the two keys this matcher knows, against the table it comes from', () => {
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
    const known: Record<string, { stop: readonly string[]; escape: readonly string[] }> = {
      win32: { stop: ['Escape'], escape: ['Escape'] },
      linux: { stop: ['Escape'], escape: ['Escape'] },
      darwin: { stop: ['Command+.', 'Escape'], escape: ['Escape'] }
    }

    for (const platform of platformSchema.options) {
      const expected = known[platform]
      expect(expected, `${platform} is not covered by this test`).toBeDefined()
      expect(DEFAULT_BINDINGS[platform].stop, `${platform} stop`).toEqual(expected?.stop)
      expect(DEFAULT_BINDINGS[platform].escape, `${platform} escape`).toEqual(expected?.escape)
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
