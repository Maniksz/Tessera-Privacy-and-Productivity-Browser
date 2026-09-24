import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOFILL_BADGE_CHANNEL,
  AUTOFILL_CLOSE_CHANNEL,
  AUTOFILL_DESCRIBE_CHANNEL,
  AUTOFILL_FILLABLE_CHANNEL,
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_PRESS_CHANNEL,
  AUTOFILL_SUGGEST_END_CHANNEL
} from '@shared/passwords/wire.js'

/**
 * The preload's half of autofill, in a document: what it reports as focus moves, the badge it draws,
 * and what a press on that badge sends.
 *
 * The core's half is `tests/autofill-service.test.ts` and `tests/autofill-wiring.test.ts`, which drive
 * the wiring in the order the preload sends things. This is where that order comes from, and the one
 * place the ways focus can leave a field are told apart: to another field, which reports that field;
 * to nothing at all, which fires `focusout` and no `focusin` — the case that used to leave the core
 * listening to every press in the tab; and to the badge, which is still the same form (AE10).
 *
 * The list of accounts is not here, and that absence is tested too: it is drawn on the overlay layer
 * (R5), so a focus in the page asks the core nothing about the vault (R2, AE2).
 */

const ipc = vi.hoisted(() => ({
  send: vi.fn<(channel: string, payload?: unknown) => void>(),
  sendSync: vi.fn<(channel: string, payload?: unknown) => unknown>(),
  on: vi.fn<(channel: string, listener: (event: unknown, payload: unknown) => void) => void>()
}))

vi.mock('electron', () => ({ ipcRenderer: ipc }))

const BADGE_CHROME = { styles: '', label: 'Fill in a saved password' }

/** Shadow roots the preload attached, reachable although they are closed. */
const roots: ShadowRoot[] = []
const attachShadow = Element.prototype.attachShadow

function signInForm(): {
  username: HTMLInputElement
  password: HTMLInputElement
  other: HTMLButtonElement
} {
  document.body.innerHTML = `
    <form action="/login">
      <input id="username" name="username" autocomplete="username">
      <input id="password" name="password" type="password" autocomplete="current-password">
    </form>
    <button id="other" type="button">elsewhere</button>`
  for (const input of document.querySelectorAll('input')) {
    // happy-dom lays nothing out, and a zero-sized field is one the preload rightly ignores.
    input.getBoundingClientRect = () => new DOMRect(10, 10, 200, 30)
  }
  return {
    username: document.getElementById('username') as HTMLInputElement,
    password: document.getElementById('password') as HTMLInputElement,
    other: document.getElementById('other') as HTMLButtonElement
  }
}

/** What the core heard on one channel, in order. */
function sentOn(channel: string): unknown[] {
  return ipc.send.mock.calls.filter(([name]) => name === channel).map(([, value]) => value)
}

/** The badge on screen now; a badge that was taken down keeps its detached root. */
function badge(): HTMLButtonElement | null {
  const live = roots.filter((root) => root.host.isConnected)
  return (
    live.flatMap((root) => [...root.querySelectorAll<HTMLButtonElement>('button.badge')])[0] ?? null
  )
}

/** A message from the core, delivered the way `ipcRenderer.on` would deliver it. */
function fromCore(channel: string, payload: unknown): void {
  for (const [name, listener] of ipc.on.mock.calls) {
    if (name === channel) listener({}, payload)
  }
}

/** Focus moving from one element to another, in the order a browser fires the two events. */
function moveFocus(from: HTMLElement, to: HTMLElement): void {
  from.dispatchEvent(
    new FocusEvent('focusout', { bubbles: true, composed: true, relatedTarget: to })
  )
  to.focus()
}

// Installed once: the listeners go on `window`, which every test in this file shares, and a second
// install would report every focus twice.
beforeAll(async () => {
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = attachShadow.call(this, { ...init, mode: 'open' })
    roots.push(root)
    return root
  }
  const { installAutofill } = await import('../../src/preload/autofill.js')
  installAutofill()
  // What the core answers the first fillable report with; kept for the life of the document.
  fromCore(AUTOFILL_BADGE_CHANNEL, BADGE_CHROME)
})

afterAll(() => {
  Element.prototype.attachShadow = attachShadow
})

beforeEach(() => {
  ipc.send.mockReset()
  ipc.sendSync.mockReset()
  ipc.sendSync.mockImplementation((channel) =>
    channel === AUTOFILL_FILL_CHANNEL ? { username: 'ada', password: 'hunter2' } : undefined
  )
})

afterEach(() => {
  // Whatever a test left open is closed the way a new document would close it.
  window.dispatchEvent(new Event('pagehide'))
  ;(document.activeElement as HTMLElement | null)?.blur()
  document.body.innerHTML = ''
  roots.length = 0
})

describe('a focus in the page', () => {
  it('draws the badge from the shape of the form and asks the core nothing about the vault', () => {
    // AE2: the only message a focus sends is the one boolean. No synchronous round trip, no form.
    const { password } = signInForm()

    password.focus()

    expect(badge()?.ariaLabel).toBe(BADGE_CHROME.label)
    expect(ipc.sendSync).not.toHaveBeenCalled()
    expect(ipc.send.mock.calls).toEqual([[AUTOFILL_FILLABLE_CHANNEL, true]])
  })

  it('draws no badge on a field a fill would not write to', () => {
    document.body.innerHTML = '<input id="search" name="q">'
    const search = document.getElementById('search') as HTMLInputElement
    search.getBoundingClientRect = () => new DOMRect(10, 10, 200, 30)

    search.focus()

    expect(badge()).toBeNull()
    expect(sentOn(AUTOFILL_FILLABLE_CHANNEL)).toEqual([false])
  })
})

describe('what the preload reports as focus moves', () => {
  it('reports "no longer" when focus leaves the field for nothing at all', () => {
    // A press on blank page space: `focusout` fires and no `focusin` follows, so this is the only
    // chance to release the core's input listener.
    const { password } = signInForm()
    password.focus()

    password.blur()

    expect(sentOn(AUTOFILL_FILLABLE_CHANNEL)).toEqual([true, false])
    expect(badge()).toBeNull()
  })

  it('ends on the new field when focus moves from one fillable field to the other', () => {
    const { username, password } = signInForm()
    username.focus()

    moveFocus(username, password)

    expect(sentOn(AUTOFILL_FILLABLE_CHANNEL).at(-1)).toBe(true)
    expect(badge()).not.toBeNull()
  })

  it('ends on "no" when focus moves to something that is not a fillable field', () => {
    const { password, other } = signInForm()
    password.focus()

    moveFocus(password, other)

    expect(sentOn(AUTOFILL_FILLABLE_CHANNEL).at(-1)).toBe(false)
    expect(badge()).toBeNull()
  })

  it('does not report "no longer" when Tab moves from the field to its badge', () => {
    // AE10. The badge is the next stop in the tab order, and the form is still the one in front of
    // the user. Reporting "gone" here would release the listener that records the Return about to
    // press the badge, and the core would answer that press with nothing.
    const { password } = signInForm()
    password.focus()
    const key = badge()
    if (key === null) throw new Error('no badge was drawn')

    moveFocus(password, key)

    expect(sentOn(AUTOFILL_FILLABLE_CHANNEL)).toEqual([true])
    expect(badge()).toBe(key)
  })
})

describe('a press on the badge', () => {
  it('sends the form and the field rectangle, and nothing is asked of the vault', () => {
    const { password } = signInForm()
    password.focus()

    badge()?.click()

    const [press] = sentOn(AUTOFILL_PRESS_CHANNEL)
    expect(press).toMatchObject({
      form: { action: '/login' },
      field: { rect: { x: 10, y: 10, width: 200, height: 30 }, scale: 1 }
    })
    expect(ipc.sendSync).not.toHaveBeenCalled()
  })

  it('keeps the badge while its list is open, though the overlay has taken the focus', () => {
    // AE10 and R1. The list is drawn in a view of the browser's, so the page loses focus entirely the
    // moment it appears — and the listener must stay, since the list's own answer is still to come.
    const { password } = signInForm()
    password.focus()
    const key = badge()
    if (key === null) throw new Error('no badge was drawn')
    moveFocus(password, key)
    key.click()

    key.dispatchEvent(new FocusEvent('focusout', { bubbles: true, composed: true }))

    expect(badge()).toBe(key)
    expect(sentOn(AUTOFILL_FILLABLE_CHANNEL)).toEqual([true])
  })

  it('lets the badge go with the list, and not before', () => {
    const { password } = signInForm()
    password.focus()
    badge()?.click()
    password.blur()
    expect(badge(), 'the badge left while its list was still open').not.toBeNull()

    fromCore(AUTOFILL_SUGGEST_END_CHANNEL, null)

    expect(badge()).toBeNull()
  })

  it('keeps the badge after the list when the caret is still on the badge', () => {
    // Escape on the list, from a badge reached by keyboard: the user is where they were.
    const { password } = signInForm()
    password.focus()
    const key = badge()
    if (key === null) throw new Error('no badge was drawn')
    moveFocus(password, key)
    key.click()

    fromCore(AUTOFILL_SUGGEST_END_CHANNEL, null)

    expect(badge()).toBe(key)
  })
})

describe('the list closing from the page', () => {
  it('asks the core to close it on a scroll, once however many scroll events follow', () => {
    // AE6: the rectangle the list was placed from is stale the moment the page moves.
    const { password } = signInForm()
    password.focus()
    badge()?.click()

    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('scroll'))

    expect(sentOn(AUTOFILL_CLOSE_CHANNEL)).toEqual([null])
  })

  it('asks the core to close it on a resize and on a press beside field and badge', () => {
    const { password, other } = signInForm()
    password.focus()
    badge()?.click()
    window.dispatchEvent(new Event('resize'))
    expect(sentOn(AUTOFILL_CLOSE_CHANNEL)).toHaveLength(1)

    badge()?.click()
    other.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    expect(sentOn(AUTOFILL_CLOSE_CHANNEL)).toHaveLength(2)
  })

  it('does not close a list that is not open', () => {
    const { password } = signInForm()
    password.focus()

    window.dispatchEvent(new Event('scroll'))

    expect(sentOn(AUTOFILL_CLOSE_CHANNEL)).toEqual([])
  })
})

describe('a choice on the list', () => {
  it('redeems the token once, with the form as it is now, and writes both fields', () => {
    const { username, password } = signInForm()
    password.focus()
    badge()?.click()

    fromCore(AUTOFILL_SUGGEST_END_CHANNEL, 'a-token')

    expect(ipc.sendSync).toHaveBeenCalledTimes(1)
    expect(ipc.sendSync).toHaveBeenCalledWith(AUTOFILL_FILL_CHANNEL, {
      token: 'a-token',
      form: expect.objectContaining({ action: '/login' })
    })
    expect(password.value).toBe('hunter2')
    expect(username.value).toBe('ada')
  })

  it('puts the caret back into the field afterwards', () => {
    // The list took the focus out of the document while it was open.
    const { password } = signInForm()
    password.focus()
    badge()?.click()
    password.blur()

    fromCore(AUTOFILL_SUGGEST_END_CHANNEL, 'a-token')

    expect(document.activeElement).toBe(password)
  })

  it('writes nothing when the core refuses the token', () => {
    const { password } = signInForm()
    password.focus()
    badge()?.click()
    ipc.sendSync.mockReturnValue(null)

    fromCore(AUTOFILL_SUGGEST_END_CHANNEL, 'a-token')

    expect(password.value).toBe('')
  })
})

describe('a fill asked for from browser chrome', () => {
  // The toolbar key, the shortcut, the context menu: the core asks where the form is (R11, R12).
  it('describes the form with the caret in it, the way a badge press does', () => {
    const { password } = signInForm()
    password.focus()

    fromCore(AUTOFILL_DESCRIBE_CHANNEL, null)

    expect(sentOn(AUTOFILL_PRESS_CHANNEL)).toEqual([
      expect.objectContaining({ form: expect.objectContaining({ action: '/login' }) })
    ])
  })

  it('describes the first field a fill would write to when the caret is elsewhere', () => {
    // The address bar has the caret while the key is pressed; the page's own focus is nowhere.
    const { username, password } = signInForm()

    fromCore(AUTOFILL_DESCRIBE_CHANNEL, null)
    fromCore(AUTOFILL_SUGGEST_END_CHANNEL, 'a-token')

    expect(sentOn(AUTOFILL_PRESS_CHANNEL)).toHaveLength(1)
    expect(password.value).toBe('hunter2')
    expect(username.value).toBe('ada')
  })

  it('says nothing on a page with no form a fill could write to', () => {
    document.body.innerHTML = '<input id="search" name="q">'

    fromCore(AUTOFILL_DESCRIBE_CHANNEL, null)

    expect(ipc.send).not.toHaveBeenCalled()
  })

  it('fills nothing for a token that arrives with no press before it', () => {
    const { password } = signInForm()

    fromCore(AUTOFILL_SUGGEST_END_CHANNEL, 'a-token')

    expect(ipc.sendSync).not.toHaveBeenCalled()
    expect(password.value).toBe('')
  })
})

describe('what the preload no longer carries', () => {
  it('holds no list of accounts and asks nothing on focus (KTD7, KTD10)', () => {
    const source = readFileSync(join(process.cwd(), 'src/preload/autofill.ts'), 'utf8')
    expect(source).not.toMatch(/showSuggestion|hideSuggestion|AUTOFILL_OFFER_CHANNEL|FillOffer/)
    // One synchronous call is left, and it is the fill: redeeming a token the core minted.
    expect(source.match(/sendSync\(/g)).toHaveLength(1)
    expect(source).toMatch(/sendSync\(AUTOFILL_FILL_CHANNEL,/)
  })
})
