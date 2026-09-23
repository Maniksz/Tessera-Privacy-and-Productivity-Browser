import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUTOFILL_FILLABLE_CHANNEL,
  AUTOFILL_FILL_CHANNEL,
  AUTOFILL_OFFER_CHANNEL
} from '@shared/passwords/wire.js'

/**
 * The preload's half of autofill, in a document: what it reports as focus moves, and what a press on
 * its own list does to that focus.
 *
 * The core's half is `tests/autofill-service.test.ts`, which drives the wiring in the order the
 * preload sends things. This is where that order comes from, and the one place the two ways focus
 * can leave a field are told apart: to another field, which reports that field, and to nothing at
 * all, which fires `focusout` and no `focusin` — the case that used to leave the core listening to
 * every press in the tab.
 */

const ipc = vi.hoisted(() => ({
  send: vi.fn<(channel: string, payload?: unknown) => void>(),
  sendSync: vi.fn<(channel: string, payload?: unknown) => unknown>(),
  on: vi.fn()
}))

vi.mock('electron', () => ({ ipcRenderer: ipc }))

const OFFER = {
  entries: [{ id: 'pw-1', username: 'ada' }],
  chrome: { styles: '', title: 'Saved for example.com', noUsernameLabel: 'No username' }
}

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

function fillableReports(): unknown[] {
  return ipc.send.mock.calls
    .filter(([channel]) => channel === AUTOFILL_FILLABLE_CHANNEL)
    .map(([, value]) => value)
}

/** The entries of the list on screen now; a list that was taken down keeps its detached root. */
function listEntries(): HTMLButtonElement[] {
  return roots
    .filter((root) => root.host.isConnected)
    .flatMap((root) => [...root.querySelectorAll<HTMLButtonElement>('button.entry')])
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
})

afterAll(() => {
  Element.prototype.attachShadow = attachShadow
})

beforeEach(() => {
  ipc.send.mockReset()
  ipc.sendSync.mockReset()
  ipc.sendSync.mockImplementation((channel) => {
    if (channel === AUTOFILL_OFFER_CHANNEL) return OFFER
    if (channel === AUTOFILL_FILL_CHANNEL) return { username: 'ada', password: 'hunter2' }
    return undefined
  })
})

afterEach(() => {
  ;(document.activeElement as HTMLElement | null)?.blur()
  document.body.innerHTML = ''
  roots.length = 0
})

describe('what the preload reports as focus moves', () => {
  it('reports a fillable field on focus and asks for the offer straight after', () => {
    const { password } = signInForm()

    password.focus()

    expect(fillableReports()).toEqual([true])
    expect(ipc.sendSync).toHaveBeenCalledWith(AUTOFILL_OFFER_CHANNEL, expect.anything())
    expect(listEntries().map((entry) => entry.textContent)).toEqual(['ada'])
  })

  it('reports "no longer" when focus leaves the field for nothing at all', () => {
    // A press on blank page space: `focusout` fires and no `focusin` follows, so this is the only
    // chance to release the core's input listener.
    const { password } = signInForm()
    password.focus()

    password.blur()

    expect(fillableReports()).toEqual([true, false])
    expect(listEntries()).toEqual([])
  })

  it('ends on the new field when focus moves from one fillable field to the other', () => {
    const { username, password } = signInForm()
    username.focus()

    password.focus()

    expect(fillableReports().at(-1)).toBe(true)
  })

  it('ends on "no" when focus moves to something that is not a fillable field', () => {
    const { password, other } = signInForm()
    password.focus()

    other.focus()

    expect(fillableReports().at(-1)).toBe(false)
  })
})

describe('a press on the list', () => {
  it('does not take focus from the field, so the list is still there for the click', () => {
    const { password } = signInForm()
    password.focus()
    const [entry] = listEntries()

    const press = new MouseEvent('mousedown', { bubbles: true, cancelable: true, composed: true })
    entry?.dispatchEvent(press)

    expect(press.defaultPrevented).toBe(true)
  })

  it('fills the form from the entry that was clicked', () => {
    const { username, password } = signInForm()
    password.focus()

    listEntries()[0]?.click()

    expect(ipc.sendSync).toHaveBeenCalledWith(
      AUTOFILL_FILL_CHANNEL,
      expect.objectContaining({ id: 'pw-1' })
    )
    expect(password.value).toBe('hunter2')
    expect(username.value).toBe('ada')
  })
})
