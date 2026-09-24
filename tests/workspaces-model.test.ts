import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_NAME,
  WORKSPACE_CHANNELS,
  emptyWorkspaceDocument,
  fractionsOf,
  planOpening,
  removeWorkspace,
  repairWorkspaces,
  saveWorkspace,
  seatsFor,
  summarize,
  workspaceName,
  type Workspace
} from '@shared/workspaces/model.js'

/**
 * Workspaces (U21, R35, KTD15): a layout, its dividers and a URL per tile, under a name.
 *
 * Positional like an arrangement, and unlike one addressed by URLs rather than tab ids, so it survives
 * a restart without the session. Every rule is here; the store supplies the id and the clock and the
 * handlers act on a window.
 */

function workspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: 'ws-1',
    name: 'Research',
    layoutId: '1x2',
    fractions: { v: 0.5 },
    seats: ['https://a.example/', 'https://b.example/'],
    savedAt: 1,
    ...overrides
  }
}

describe('a workspace’s seats', () => {
  it('gives a 2×2 with three occupied tiles four seats, one of them empty', () => {
    const seats = seatsFor('2x2', ['https://a.example/', null, 'https://c.example/', 'https://d/'])
    expect(seats).toEqual(['https://a.example/', null, 'https://c.example/', 'https://d/'])
    expect(seats).toHaveLength(4)
  })

  it('has exactly one seat per tile, padding a short list and cutting a long one', () => {
    expect(seatsFor('1x3', ['https://a.example/'])).toEqual(['https://a.example/', null, null])
    expect(seatsFor('1x1', ['https://a.example/', 'https://b.example/'])).toEqual([
      'https://a.example/'
    ])
  })

  it('counts a tile with no address or a blank page as empty', () => {
    expect(seatsFor('1x4', ['', 'about:blank', undefined, 'https://d.example/'])).toEqual([
      null,
      null,
      null,
      'https://d.example/'
    ])
  })
})

describe('a workspace’s dividers', () => {
  it('keeps the layout’s own dividers, as they were', () => {
    expect(fractionsOf('2x2', { v: 0.3, h: 0.7 })).toEqual({ v: 0.3, h: 0.7 })
  })

  it('drops a divider the layout does not have and fills one it lacks', () => {
    expect(fractionsOf('1x2', { v: 0.25, h: 0.9 })).toEqual({ v: 0.25 })
    expect(fractionsOf('1+2', { v: 0.4 })).toEqual({ v: 0.4, hRight: 0.5 })
  })
})

describe('a name', () => {
  it('is trimmed, with runs of white space made one', () => {
    expect(workspaceName('  Deep   work \n')).toBe('Deep work')
  })

  it('is refused when nothing is left, or when it is longer than the menu can show', () => {
    expect(workspaceName('   ')).toBeNull()
    expect(workspaceName('x'.repeat(MAX_WORKSPACE_NAME))).toBe('x'.repeat(MAX_WORKSPACE_NAME))
    expect(workspaceName('x'.repeat(MAX_WORKSPACE_NAME + 1))).toBeNull()
  })
})

describe('saving', () => {
  it('adds a workspace under a new name at the end', () => {
    const before = [workspace()]
    const added = workspace({ id: 'ws-2', name: 'Mail' })
    const result = saveWorkspace(before, added, false)
    expect(result.outcome).toBe('saved')
    expect(result.workspaces).toEqual([workspace(), added])
    expect(before).toEqual([workspace()])
  })

  it('leaves the old workspace unchanged when the name is taken and nothing confirmed it', () => {
    const before = [workspace(), workspace({ id: 'ws-2', name: 'Mail' })]
    const result = saveWorkspace(
      before,
      workspace({ id: 'ws-3', name: ' research ', layoutId: '1x1', seats: [null] }),
      false
    )
    expect(result).toEqual({ outcome: 'exists', workspaces: before })
  })

  it('overwrites the old workspace in its place, under its id, once confirmed', () => {
    const before = [workspace(), workspace({ id: 'ws-2', name: 'Mail' })]
    const replacement = workspace({ id: 'ws-3', name: 'RESEARCH', layoutId: '1x1', seats: [null] })
    const result = saveWorkspace(before, replacement, true)
    expect(result.outcome).toBe('saved')
    expect(result.workspaces).toEqual([{ ...replacement, id: 'ws-1' }, before[1]])
  })

  it('treats a confirmation for a name nobody has as an ordinary save', () => {
    const result = saveWorkspace([], workspace(), true)
    expect(result).toEqual({ outcome: 'saved', workspaces: [workspace()] })
  })
})

describe('removing', () => {
  it('removes the workspace with that id and nothing else', () => {
    const other = workspace({ id: 'ws-2', name: 'Mail' })
    expect(removeWorkspace([workspace(), other], 'ws-1')).toEqual([other])
    expect(removeWorkspace([other], 'ws-9')).toEqual([other])
  })
})

describe('the menu’s list', () => {
  it('lists names and layouts only, by name', () => {
    const list = summarize([
      workspace({ id: 'b', name: 'mail', layoutId: '2x2', seats: [null, null, null, null] }),
      workspace({ id: 'a', name: 'Ärger' }),
      workspace({ id: 'c', name: 'Code' })
    ])
    expect(list).toEqual([
      { id: 'a', name: 'Ärger', layoutId: '1x2' },
      { id: 'c', name: 'Code', layoutId: '1x2' },
      { id: 'b', name: 'mail', layoutId: '2x2' }
    ])
  })
})

describe('opening', () => {
  const tabs = [
    { id: 't1', url: 'https://b.example/' },
    { id: 't2', url: 'https://a.example/' },
    { id: 't3', url: 'https://a.example/' }
  ]

  it('takes a matching open tab rather than a new one, in strip order', () => {
    expect(planOpening(['https://a.example/', 'https://c.example/'], tabs)).toEqual([
      { tabId: 't2' },
      { url: 'https://c.example/' }
    ])
  })

  it('never seats one tab twice: the second seat with that address takes the next tab', () => {
    expect(
      planOpening(['https://a.example/', 'https://a.example/', 'https://a.example/'], tabs)
    ).toEqual([{ tabId: 't2' }, { tabId: 't3' }, { url: 'https://a.example/' }])
  })

  it('leaves an empty seat empty', () => {
    expect(planOpening([null, 'https://b.example/'], tabs)).toEqual([null, { tabId: 't1' }])
  })
})

describe('a loaded document', () => {
  it('starts empty at version 1', () => {
    expect(emptyWorkspaceDocument()).toEqual({ version: 1, workspaces: [] })
  })

  it('heals seats and dividers to the layout, and keeps what it does not know', () => {
    const loaded = [
      { ...workspace({ seats: ['https://a.example/'], fractions: { v: 0.3, h: 1 } }), extra: 7 }
    ]
    expect(repairWorkspaces(loaded)).toEqual([
      { ...workspace({ seats: ['https://a.example/', null], fractions: { v: 0.3 } }), extra: 7 }
    ])
  })

  it('drops a workspace with no usable name, and the second of two with one id or one name', () => {
    const loaded = [
      workspace(),
      workspace({ id: 'ws-2', name: '  ' }),
      workspace({ id: 'ws-1', name: 'Other' }),
      workspace({ id: 'ws-3', name: 'research' }),
      workspace({ id: 'ws-4', name: '  Mail  ' })
    ]
    expect(repairWorkspaces(loaded)).toEqual([workspace(), workspace({ id: 'ws-4', name: 'Mail' })])
  })

  it('cuts a name longer than the menu shows rather than losing the workspace', () => {
    const long = 'y'.repeat(MAX_WORKSPACE_NAME + 5)
    expect(repairWorkspaces([workspace({ name: long })])).toEqual([
      workspace({ name: 'y'.repeat(MAX_WORKSPACE_NAME) })
    ])
  })
})

describe('the channels', () => {
  it('are the four the layout menu uses, and all of them are the workspaces’', () => {
    expect([...WORKSPACE_CHANNELS]).toEqual([
      'workspaces:list',
      'workspaces:save',
      'workspaces:open',
      'workspaces:remove'
    ])
  })
})
