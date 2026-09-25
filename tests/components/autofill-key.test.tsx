import { act, cleanup, fireEvent, render, screen } from '@testing-library/preact'
import { afterEach, describe, expect, it } from 'vitest'
import { AutofillKey, useAutofillKeyState } from '@renderer/components/AutofillKey.js'
import type { AutofillKeyState } from '@shared/passwords/model.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * The toolbar's password key (autofill U6): three states a person can tell apart, what each press
 * does, and where its state comes from.
 *
 * What would go wrong without these: a key stuck on "nothing saved" because nobody asked the core
 * (the plan's "not permanently without matches at rest"), a locked key that opens a picker saying
 * "locked" instead of the prompt (R13), and a key that tells the chrome renderer a username — the
 * state is a word and a count, and the name travels nowhere near this button.
 */

const calls: Array<{ channel: string; payload?: unknown }> = []
const listeners = new Map<string, (payload: unknown) => void>()

function installBridge(pulled: AutofillKeyState): void {
  calls.length = 0
  listeners.clear()
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return Promise.resolve(channel === 'passwords:autofillState' ? pulled : { ok: true })
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
}

const titles = shortcutTitles('win32')
const OPEN_TWO: AutofillKeyState = { vault: 'open', matches: 2 }
const OPEN_NONE: AutofillKeyState = { vault: 'open', matches: 0 }
const LOCKED: AutofillKeyState = { vault: 'locked', matches: 0 }

afterEach(cleanup)

describe('what the key shows', () => {
  it('draws three states that differ in name and in shape, not only in colour', () => {
    installBridge(OPEN_NONE)
    const { rerender } = render(<AutofillKey state={LOCKED} titleWithShortcut={titles} />)
    const locked = screen.getByRole('button')
    expect(locked.getAttribute('aria-label')).toBe('Passwords are locked — unlock')
    expect(locked.querySelector('[data-part="lock"]')).not.toBeNull()

    rerender(<AutofillKey state={OPEN_TWO} titleWithShortcut={titles} />)
    const matches = screen.getByRole('button')
    expect(matches.getAttribute('aria-label')).toBe('Fill in a saved password (2 for this site)')
    expect(matches.querySelector('[data-part="dot"]')).not.toBeNull()
    expect(matches.querySelector('[data-part="lock"]')).toBeNull()

    rerender(<AutofillKey state={OPEN_NONE} titleWithShortcut={titles} />)
    const none = screen.getByRole('button')
    expect(none.getAttribute('aria-label')).toBe('No password saved for this site')
    expect(none.querySelector('[data-part="dot"]')).toBeNull()
  })

  it('is not there while autofill is switched off', () => {
    installBridge(OPEN_NONE)
    render(<AutofillKey state={{ vault: 'off', matches: 0 }} titleWithShortcut={titles} />)

    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names its shortcut only while it fills', () => {
    installBridge(OPEN_NONE)
    const { rerender } = render(<AutofillKey state={OPEN_TWO} titleWithShortcut={titles} />)
    expect(screen.getByRole('button').title).toContain('Ctrl+Shift+K')

    rerender(<AutofillKey state={LOCKED} titleWithShortcut={titles} />)
    expect(screen.getByRole('button').title).not.toContain('Ctrl+Shift+K')
  })
})

describe('what a press on the key does', () => {
  it('asks for the master-password prompt while the vault is locked, never for the list (R13)', () => {
    installBridge(LOCKED)
    render(<AutofillKey state={LOCKED} titleWithShortcut={titles} />)

    fireEvent.click(screen.getByRole('button'))

    expect(calls.map(({ channel }) => channel)).toEqual(['passwords:requestUnlock'])
  })

  it('asks for a fill from browser chrome with its own rectangle while the vault is open', () => {
    installBridge(OPEN_TWO)
    render(<AutofillKey state={OPEN_TWO} titleWithShortcut={titles} />)
    const button = screen.getByRole('button')
    button.getBoundingClientRect = () => new DOMRect(900, 40, 32, 32)

    fireEvent.click(button)

    expect(calls).toEqual([
      {
        channel: 'passwords:fillFromToolbar',
        payload: { anchor: { x: 900, y: 40, width: 32, height: 32 } }
      }
    ])
  })
})

describe('where the state comes from', () => {
  function Harness({ page }: { page: string }): React.ReactNode {
    return <AutofillKey state={useAutofillKeyState(page)} titleWithShortcut={titles} />
  }

  it('asks the core when the page changes rather than staying on "nothing saved"', async () => {
    installBridge(OPEN_TWO)
    const { rerender } = render(<Harness page="tab-1 https://example.com/" />)
    expect(await screen.findByRole('button', { name: /2 for this site/ })).not.toBeNull()

    rerender(<Harness page="tab-2 https://other.example/" />)

    expect(calls.filter(({ channel }) => channel === 'passwords:autofillState')).toHaveLength(2)
  })

  it('takes the pushed state when the vault locks itself', async () => {
    installBridge(OPEN_TWO)
    render(<Harness page="tab-1" />)
    await screen.findByRole('button', { name: /2 for this site/ })

    void act(() => {
      listeners.get('passwords:autofillStateChanged')?.(LOCKED)
    })

    expect(screen.getByRole('button').getAttribute('aria-label')).toBe(
      'Passwords are locked — unlock'
    )
  })

  it('stops listening when it goes', () => {
    installBridge(OPEN_TWO)
    const { unmount } = render(<Harness page="tab-1" />)

    unmount()

    expect(listeners.has('passwords:autofillStateChanged')).toBe(false)
  })
})
