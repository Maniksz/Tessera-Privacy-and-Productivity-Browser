import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PermissionSurface } from '../../src/renderer/src/surfaces/PermissionSurface.js'
import type { PermissionRequestPresentation } from '@shared/overlay/surface.js'
import { DEFAULT_LOCALE, catalogs } from '@shared/i18n/catalog.js'

/**
 * The permission dialogue's buttons, and when they listen.
 *
 * A dialogue that takes a click the instant it appears can be answered by a click the user aimed at
 * something else: a page asks at the moment it expects a click — a button it drew under where the
 * dialogue will open, a game that makes the user click fast — and the click lands on "Allow". The
 * same trick works through focus: the user clicks back into the window and the first click answers.
 * So the buttons ignore input for a moment after the dialogue appears and after the window regains
 * focus, and only these tests can say they do: the dialogue looks identical either way.
 *
 * The bridge is replaced rather than mocked at the module level, for the reason the find bar's test
 * gives: `bridge.ts` reads `window.tessera` on every call.
 */

interface Call {
  channel: string
  payload: unknown
}

function installBridge(): Call[] {
  const calls: Call[] = []
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return Promise.resolve({ ok: true })
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', {
    value: bridge,
    configurable: true,
    writable: true
  })
  return calls
}

const messages = catalogs[DEFAULT_LOCALE] as Record<string, string>

function label(key: string): string {
  return messages[key] ?? key
}

function presentation(
  overrides: Partial<PermissionRequestPresentation> = {}
): PermissionRequestPresentation {
  return {
    kind: 'permission-request',
    requestId: 'req-1',
    origin: 'https://example.com',
    subject: 'geolocation',
    devices: [],
    waiting: 0,
    ...overrides
  }
}

function answers(calls: readonly Call[]): unknown[] {
  return calls.filter((call) => call.channel === 'permissions:answer').map((call) => call.payload)
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

function allowOnce(): void {
  fireEvent.click(screen.getByRole('button', { name: label('permission.allowOnce') }))
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a click too soon after the dialogue appears', () => {
  it('is ignored at 100 ms and taken at 600 ms', () => {
    const calls = installBridge()
    render(<PermissionSurface presentation={presentation()} />)

    wait(100)
    allowOnce()
    expect(answers(calls), 'a click 100 ms after the dialogue appeared answered it').toEqual([])

    wait(500)
    allowOnce()
    expect(answers(calls)).toEqual([{ requestId: 'req-1', answer: 'allow-once' }])
  })

  it('holds every button, the refusing ones included', () => {
    // A refusal is remembered too, and a page tricking one out of the user is still a decision nobody made.
    const calls = installBridge()
    render(<PermissionSurface presentation={presentation()} />)
    for (const key of ['permission.block', 'permission.allowOnce', 'permission.allowAlways']) {
      fireEvent.click(screen.getByRole('button', { name: label(key) }))
    }
    expect(answers(calls)).toEqual([])
  })

  it('starts over for the next request replacing this one in place', () => {
    // The core presents the next queued question into the same surface; it is a new dialogue to read.
    const calls = installBridge()
    const { rerender } = render(<PermissionSurface presentation={presentation()} />)
    wait(600)

    rerender(<PermissionSurface presentation={presentation({ requestId: 'req-2' })} />)
    allowOnce()
    expect(answers(calls), 'the next dialogue inherited the first one being ready').toEqual([])

    wait(600)
    allowOnce()
    expect(answers(calls)).toEqual([{ requestId: 'req-2', answer: 'allow-once' }])
  })

  it('does not start over when only the waiting count changes', () => {
    const calls = installBridge()
    const { rerender } = render(<PermissionSurface presentation={presentation()} />)
    wait(600)
    rerender(<PermissionSurface presentation={presentation({ waiting: 1 })} />)
    allowOnce()
    expect(answers(calls)).toEqual([{ requestId: 'req-1', answer: 'allow-once' }])
  })

  it('still lets Escape refuse at once', () => {
    // Escape is a key, not a click, and it only ever refuses: nothing a page gains by timing it.
    const calls = installBridge()
    render(<PermissionSurface presentation={presentation()} />)
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' })
    expect(answers(calls)).toEqual([{ requestId: 'req-1', answer: 'block' }])
  })
})

describe('a click right after the window regains focus', () => {
  it('is ignored, and taken once the moment has passed', () => {
    const calls = installBridge()
    render(<PermissionSurface presentation={presentation()} />)
    wait(600)

    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    allowOnce()
    expect(answers(calls), 'the click that focused the window answered the dialogue').toEqual([])

    wait(600)
    allowOnce()
    expect(answers(calls)).toEqual([{ requestId: 'req-1', answer: 'allow-once' }])
  })

  it('is held for the whole moment again after each focus', () => {
    const calls = installBridge()
    render(<PermissionSurface presentation={presentation()} />)
    wait(400)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    // 600 ms after the dialogue appeared, but only 200 ms after the focus.
    wait(200)
    allowOnce()
    expect(answers(calls)).toEqual([])
  })

  it('stops listening once the dialogue is gone', () => {
    installBridge()
    const remove = vi.spyOn(window, 'removeEventListener')
    const { unmount } = render(<PermissionSurface presentation={presentation()} />)
    unmount()
    expect(remove).toHaveBeenCalledWith('focus', expect.any(Function))
  })
})
