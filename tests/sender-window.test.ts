import { describe, expect, it } from 'vitest'
import {
  windowOfSender,
  windowOfTab,
  type SenderContents,
  type SenderWindowCandidate
} from '@main/browser/sender-window.js'

/**
 * Which window an IPC call acts for.
 *
 * Covered case by case because a wrong answer here is not a cosmetic slip: the settings page of a
 * private window that resolved to the focused normal window wrote its filter rule into the normal
 * profile. `WindowRegistry` is Electron-bound and excluded from coverage, so these fakes stand in for
 * a `BrowserWindowController` — structurally, which is also what the registry hands over.
 */

interface FakeWindow extends SenderWindowCandidate {
  readonly name: string
  readonly focused: boolean
}

function contents(id: number, destroyed = false): SenderContents {
  return {
    get id(): number {
      // Electron throws on a destroyed object's properties; a fake that did not would hide a
      // lookup that reads the id before asking whether it may.
      if (destroyed) throw new Error('Object has been destroyed')
      return id
    },
    isDestroyed: () => destroyed
  }
}

function fakeWindow(options: {
  name: string
  chrome: readonly number[]
  tabs?: readonly SenderContents[]
  destroyed?: boolean
  focused?: boolean
}): FakeWindow {
  return {
    name: options.name,
    focused: options.focused ?? false,
    window: { isDestroyed: () => options.destroyed ?? false },
    ownsChromeWebContents: (id) => options.chrome.includes(id),
    tabs: (options.tabs ?? []).map((webContents) => ({ view: { webContents } }))
  }
}

describe('windowOfSender', () => {
  it("answers with a private window's own tab even while a normal window has the focus", () => {
    const normal = fakeWindow({ name: 'normal', chrome: [1], tabs: [contents(10)], focused: true })
    const privateWindow = fakeWindow({ name: 'private', chrome: [2], tabs: [contents(20)] })

    expect(windowOfSender([normal, privateWindow], contents(20))?.name).toBe('private')
  })

  it("answers with the chrome renderer's window", () => {
    const first = fakeWindow({ name: 'first', chrome: [1], focused: true })
    const second = fakeWindow({ name: 'second', chrome: [2] })

    expect(windowOfSender([first, second], contents(2))?.name).toBe('second')
  })

  it("answers with the overlay surface's window, which owns it like the chrome does", () => {
    // `ownsChromeWebContents` answers for both; the overlay is just another id it knows.
    const first = fakeWindow({ name: 'first', chrome: [1, 11], focused: true })
    const second = fakeWindow({ name: 'second', chrome: [2, 22] })

    expect(windowOfSender([first, second], contents(22))?.name).toBe('second')
  })

  it('finds nothing for a destroyed sender, rather than guessing', () => {
    const only = fakeWindow({ name: 'only', chrome: [1], tabs: [contents(10)], focused: true })

    expect(windowOfSender([only], contents(10, true))).toBeUndefined()
    expect(windowOfSender([only], contents(1, true))).toBeUndefined()
  })

  it('does not fall back to the focused window for a sender nobody owns', () => {
    const focused = fakeWindow({
      name: 'focused',
      chrome: [1],
      tabs: [contents(10)],
      focused: true
    })

    expect(windowOfSender([focused], contents(99))).toBeUndefined()
  })

  it('finds nothing when there is no window at all', () => {
    expect(windowOfSender([], contents(1))).toBeUndefined()
  })

  it('skips a destroyed window, even one that still claims the chrome id', () => {
    const closing = fakeWindow({
      name: 'closing',
      chrome: [1],
      tabs: [contents(10)],
      destroyed: true
    })
    const open = fakeWindow({ name: 'open', chrome: [2] })

    expect(windowOfSender([closing, open], contents(1))).toBeUndefined()
    expect(windowOfSender([closing, open], contents(10))).toBeUndefined()
  })

  it('prefers the chrome match over a tab match for the same id', () => {
    // Cannot happen with real ids, which Electron never reuses at once; pinned so the order the
    // registry has always used — chrome first — is a decision and not an accident.
    const tabOwner = fakeWindow({ name: 'tab-owner', chrome: [1], tabs: [contents(5)] })
    const chromeOwner = fakeWindow({ name: 'chrome-owner', chrome: [5] })

    expect(windowOfSender([tabOwner, chromeOwner], contents(5))?.name).toBe('chrome-owner')
  })
})

describe('windowOfTab', () => {
  it('finds the window whose tab shows the given contents', () => {
    const first = fakeWindow({ name: 'first', chrome: [1], tabs: [contents(10), contents(11)] })
    const second = fakeWindow({ name: 'second', chrome: [2], tabs: [contents(20), contents(21)] })

    expect(windowOfTab([first, second], 21)?.name).toBe('second')
    expect(windowOfTab([first, second], 10)?.name).toBe('first')
  })

  it("is not satisfied by a chrome renderer's id", () => {
    // The element picker and the password manager act on a *page*; the chrome is not one.
    const only = fakeWindow({ name: 'only', chrome: [1], tabs: [contents(10)] })

    expect(windowOfTab([only], 1)).toBeUndefined()
  })

  it('steps over a destroyed tab without reading its id, and keeps looking', () => {
    const first = fakeWindow({ name: 'first', chrome: [1], tabs: [contents(30, true)] })
    const second = fakeWindow({ name: 'second', chrome: [2], tabs: [contents(30)] })

    expect(windowOfTab([first, second], 30)?.name).toBe('second')
  })

  it('steps over a destroyed window without asking its tabs', () => {
    const closing = fakeWindow({
      name: 'closing',
      chrome: [1],
      tabs: [contents(10)],
      destroyed: true
    })

    expect(windowOfTab([closing], 10)).toBeUndefined()
  })

  it('finds nothing for an id no tab has', () => {
    const only = fakeWindow({ name: 'only', chrome: [1], tabs: [contents(10)] })

    expect(windowOfTab([only], 99)).toBeUndefined()
  })
})
