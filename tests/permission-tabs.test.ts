import { describe, expect, it, vi } from 'vitest'
import { PermissionTabs } from '@main/browser/permission-tabs.js'
import type { PermissionTabChange } from '@main/permissions/model.js'

/**
 * What a window tells the permission arbiter about its tabs (spec 4), out of the window controller.
 *
 * The part that is new is `replaced`: a discarded tab comes back in a new view with a new `webContents` id
 * (U15), and a question waiting on the old id must end while a question from the new one reaches the dialogue.
 */

function book(): {
  tabs: PermissionTabs<{ name: string }>
  heard: PermissionTabChange[]
  a: { name: string }
  b: { name: string }
} {
  const tabs = new PermissionTabs<{ name: string }>()
  const heard: PermissionTabChange[] = []
  tabs.subscribe((change) => heard.push(change))
  const a = { name: 'a' }
  const b = { name: 'b' }
  tabs.add(a, 1, 'https://a.example/')
  return { tabs, heard, a, b }
}

describe('PermissionTabs', () => {
  it('knows a tab by the id it was added with, and nothing for a tab it was not given', () => {
    const { tabs, a, b } = book()
    expect(tabs.idOf(a)).toBe(1)
    expect(tabs.idOf(b)).toBeNull()
    expect(tabs.idOf(undefined)).toBeNull()
  })

  it('reports a commit to a new address once, and a repeat of the same address never', () => {
    const { tabs, heard, a, b } = book()
    tabs.navigated(a, 'https://a.example/')
    tabs.navigated(b, 'https://b.example/')
    expect(heard).toEqual([])
    tabs.navigated(a, 'https://c.example/')
    tabs.navigated(a, 'https://c.example/')
    expect(heard).toEqual([{ kind: 'navigated', webContentsId: 1, url: 'https://c.example/' }])
  })

  it('reports a closed tab under the id it had, and says nothing of a tab it never knew', () => {
    const { tabs, heard, a, b } = book()
    tabs.closed(b)
    tabs.closed(a)
    expect(heard).toEqual([{ kind: 'closed', webContentsId: 1 }])
  })

  it('moves a tab to its new view: the old id ends, the new one is the tab (U15)', () => {
    const { tabs, heard, a, b } = book()
    tabs.replaced(b, 9)
    expect(heard).toEqual([])
    tabs.replaced(a, 7)
    expect(tabs.idOf(a)).toBe(7)
    expect(heard).toEqual([{ kind: 'closed', webContentsId: 1 }])
    // The address is kept, so the first commit in the new view at the same place is not a navigation.
    tabs.navigated(a, 'https://a.example/')
    tabs.navigated(a, 'https://a.example/next')
    expect(heard.at(-1)).toEqual({
      kind: 'navigated',
      webContentsId: 7,
      url: 'https://a.example/next'
    })
  })

  it('reports the tab in front once per change', () => {
    const { tabs, heard } = book()
    tabs.activated(null)
    tabs.activated(1)
    tabs.activated(1)
    tabs.activated(2)
    expect(heard).toEqual([{ kind: 'activated' }, { kind: 'activated' }])
  })

  it('tells everyone the window went, then nobody anything', () => {
    const { tabs, heard, a } = book()
    tabs.gone()
    tabs.closed(a)
    expect(heard).toEqual([{ kind: 'gone' }])
  })

  it('stops telling a listener that unsubscribed', () => {
    const tabs = new PermissionTabs<object>()
    const heard: PermissionTabChange[] = []
    const off = tabs.subscribe((change) => heard.push(change))
    off()
    tabs.activated(3)
    expect(heard).toEqual([])
  })

  it('keeps telling the others when one listener throws', () => {
    const tabs = new PermissionTabs<object>()
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const heard: PermissionTabChange[] = []
    tabs.subscribe(() => {
      throw new Error('broken')
    })
    tabs.subscribe((change) => heard.push(change))
    tabs.activated(3)
    expect(heard).toEqual([{ kind: 'activated' }])
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})
