import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { LayoutMenuSurface } from '@renderer/surfaces/LayoutMenuSurface.js'
import type { LayoutMenuPresentation } from '@shared/overlay/surface.js'
import type { SaveOutcome, WorkspaceMenu } from '@shared/workspaces/model.js'

/**
 * The layout menu's workspaces (U21): "Save as…" and the saved list, below the seven layouts.
 *
 * The part is fetched the first time the menu opens (the overlay's main chunk has a budget), so every
 * test waits for it. The bridge is a recording fake: what is pinned is which channel the menu calls with
 * what, and what it shows for each answer — a taken name asks before anything is overwritten, a newer
 * file says it is read-only, and a private window shows the entry disabled.
 */

interface Call {
  channel: string
  payload: unknown
}

const presentation: LayoutMenuPresentation = {
  kind: 'layout-menu',
  anchor: { x: 10, y: 10, width: 40, height: 30 },
  current: '1x1'
}

const research = { id: 'ws1', name: 'Research', layoutId: '2x2' as const }

function installBridge(options: { menu?: Partial<WorkspaceMenu>; saves?: SaveOutcome[] }): Call[] {
  const calls: Call[] = []
  let menu: WorkspaceMenu = {
    workspaces: [research],
    canSave: true,
    readOnly: false,
    ...options.menu
  }
  const saves = [...(options.saves ?? [])]
  const answer = (channel: string, payload: unknown): unknown => {
    if (channel === 'workspaces:list') return menu
    if (channel === 'workspaces:save') {
      const outcome = saves.shift() ?? 'saved'
      if (outcome === 'saved') {
        const { name } = payload as { name: string }
        menu = { ...menu, workspaces: [...menu.workspaces, { id: 'ws2', name, layoutId: '1x1' }] }
      }
      return { outcome }
    }
    if (channel === 'workspaces:remove') {
      menu = { ...menu, workspaces: [] }
      return { outcome: 'removed' }
    }
    return { outcome: 'opened' }
  }
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      return Promise.resolve(answer(channel, payload))
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
  return calls
}

function renderMenu(): void {
  render(<LayoutMenuSurface presentation={presentation} platform="win32" overrides={{}} />)
}

const saveAs = (): Promise<HTMLElement> => screen.findByRole('menuitem', { name: 'Save as…' })

const saves = (calls: Call[]): unknown[] =>
  calls.filter((call) => call.channel === 'workspaces:save').map((call) => call.payload)

async function typeName(name: string): Promise<void> {
  fireEvent.click(await saveAs())
  fireEvent.change(screen.getByRole('textbox', { name: 'Workspace name' }), {
    target: { value: name }
  })
  fireEvent.click(screen.getByRole('button', { name: 'Save' }))
}

afterEach(cleanup)

describe('the saved workspaces', () => {
  it('lists them below the layouts and opens one by its id', async () => {
    const calls = installBridge({})
    renderMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Research' }))
    expect(calls.at(-1)).toEqual({ channel: 'workspaces:open', payload: { id: 'ws1' } })
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(7)
  })

  it('removes one and shows the list again', async () => {
    const calls = installBridge({})
    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Research' }))
    await waitFor(() => expect(screen.queryByRole('menuitem', { name: 'Research' })).toBeNull())
    expect(calls).toContainEqual({ channel: 'workspaces:remove', payload: { id: 'ws1' } })
  })

  it('reaches the entries with the arrow keys, from the layouts', async () => {
    installBridge({})
    renderMenu()
    const item = await screen.findByRole('menuitem', { name: 'Research' })
    const last = screen.getAllByRole('menuitemradio').at(-1)
    last?.focus()
    fireEvent.keyDown(last as HTMLElement, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(item)
  })
})

describe('saving', () => {
  it('saves the window under the name typed and lists it', async () => {
    const calls = installBridge({})
    renderMenu()
    await typeName('  Mail ')
    expect(await screen.findByRole('menuitem', { name: 'Mail' })).toBeTruthy()
    expect(saves(calls)).toEqual([{ name: '  Mail ', replace: false }])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('does not offer to save a name with nothing in it', async () => {
    installBridge({})
    renderMenu()
    fireEvent.click(await saveAs())
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true)
  })

  it('asks before overwriting a taken name, and overwrites only once confirmed', async () => {
    const calls = installBridge({ saves: ['exists', 'saved'] })
    renderMenu()
    await typeName('Research')
    expect(await screen.findByText('Replace “Research”?')).toBeTruthy()
    expect(saves(calls)).toEqual([{ name: 'Research', replace: false }])

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(screen.queryByText('Replace “Research”?')).toBeNull())
    expect(saves(calls)).toEqual([
      { name: 'Research', replace: false },
      { name: 'Research', replace: true }
    ])
  })

  it('keeps the old workspace when the question is cancelled, and lets the name be changed', async () => {
    const calls = installBridge({ saves: ['exists'] })
    renderMenu()
    await typeName('Research')
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    const field = screen.getByRole('textbox', { name: 'Workspace name' })
    expect(field).toHaveProperty('value', 'Research')
    expect(saves(calls)).toEqual([{ name: 'Research', replace: false }])
  })

  it('says a newer version’s file is read-only when saving meets one', async () => {
    installBridge({ saves: ['read-only'] })
    renderMenu()
    await typeName('Late')
    expect(await screen.findByText('Saved by a newer version: read only.')).toBeTruthy()
    expect((await saveAs()).hasAttribute('disabled')).toBe(true)
  })

  it('keeps the name field, and the focus in it, for an answer that saved nothing', async () => {
    // `invalid` is a window that went away meanwhile. The list is asked again and the menu measured
    // again, and that later pass must not hand the focus back to the current layout.
    const calls = installBridge({ saves: ['invalid'] })
    renderMenu()
    await typeName('Gone')
    await waitFor(() =>
      expect(calls.filter((call) => call.channel === 'workspaces:list')).toHaveLength(2)
    )
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Workspace name' }))
  })
})

describe('a file or a window that may not be written', () => {
  it('shows a newer version’s file read-only from the start, with nothing to remove', async () => {
    installBridge({ menu: { readOnly: true } })
    renderMenu()
    expect(await screen.findByText('Saved by a newer version: read only.')).toBeTruthy()
    expect((await saveAs()).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: 'Remove Research' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Research' })).toBeTruthy()
  })

  it('shows “Save as…” disabled in a private window, which may still open', async () => {
    installBridge({ menu: { canSave: false } })
    renderMenu()
    expect((await saveAs()).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Research' })).toBeTruthy()
  })
})
