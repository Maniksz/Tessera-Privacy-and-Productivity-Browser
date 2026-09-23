import { describe, expect, it } from 'vitest'
import { WindowRecency, downloadWindowFor } from '@main/browser/window-recency.js'

/**
 * Which window a download belongs to, and which window inherits a closing one's downloads.
 *
 * Both are the window registry's questions, asked here of plain objects: the registry itself builds
 * Electron windows and cannot be constructed under Node, so the rules live beside it and it only
 * supplies the facts.
 */

interface FakeWindow {
  readonly name: string
  readonly session: string
  readonly contents: readonly number[]
}

const owns = (window: FakeWindow, webContentsId: number): boolean =>
  window.contents.includes(webContentsId)

const normalA: FakeWindow = { name: 'normal A', session: 'default', contents: [1, 11, 12] }
const normalB: FakeWindow = { name: 'normal B', session: 'default', contents: [2, 21] }
const privateC: FakeWindow = { name: 'private C', session: 'private-1', contents: [3, 31] }

function recency(...mostRecentLast: FakeWindow[]): WindowRecency<FakeWindow> {
  const order = new WindowRecency<FakeWindow>()
  for (const window of mostRecentLast) order.touch(window)
  return order
}

describe('WindowRecency', () => {
  it('puts the window focused last first', () => {
    const order = recency(normalA, normalB, privateC)
    order.touch(normalA)

    expect(order.mostRecentFirst.map((window) => window.name)).toEqual([
      'normal A',
      'private C',
      'normal B'
    ])
  })

  it('forgets a closed window', () => {
    const order = recency(normalA, normalB)
    order.forget(normalB)

    expect(order.mostRecentFirst).toEqual([normalA])
    expect(order.latest(() => true)).toBe(normalA)
  })

  it('finds the most recent window of a kind, or none', () => {
    const order = recency(normalA, privateC)

    expect(order.latest((window) => window.session === 'default')).toBe(normalA)
    expect(order.latest((window) => window.session === 'private-9')).toBeUndefined()
  })
})

describe('downloadWindowFor', () => {
  it('files a download from a tab under that tab’s window, however focus lies', () => {
    const order = recency(normalA, normalB)

    expect(downloadWindowFor({ id: 11 }, 'default', order.mostRecentFirst, owns)).toBe(normalA)
  })

  it('falls back to the window of the same session focused last when there is no web contents', () => {
    // Focus went to the private window last; it does not share the default session, so it is passed over.
    const order = recency(normalB, normalA, privateC)

    expect(downloadWindowFor(undefined, 'default', order.mostRecentFirst, owns)).toBe(normalA)
  })

  it('falls back the same way for web contents no window owns', () => {
    const order = recency(normalA, normalB)

    expect(downloadWindowFor({ id: 99 }, 'default', order.mostRecentFirst, owns)).toBe(normalB)
  })

  it('does not file a download from a private window’s tab under a window of another session', () => {
    const order = recency(privateC, normalA)

    expect(downloadWindowFor({ id: 31 }, 'default', order.mostRecentFirst, owns)).toBe(normalA)
  })

  it('names no window when no window of that session is open', () => {
    const order = recency(normalA)

    expect(downloadWindowFor(undefined, 'private-2', order.mostRecentFirst, owns)).toBeUndefined()
  })
})
