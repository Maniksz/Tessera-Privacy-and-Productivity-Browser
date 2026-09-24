import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IpcMainInvokeEvent, MenuItemConstructorOptions } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  registerSiteHandlers,
  type SiteHandle,
  type SiteHandlerDeps,
  type SiteMenuTab,
  type SiteMenuWindow
} from '@main/ipc/site-handlers.js'
import { PermissionStore } from '@main/data/PermissionStore.js'
import type { UserRuleTextEditor } from '@main/data/UserRuleStore.js'
import { withSiteExemption } from '@shared/filters/site-exemption.js'
import {
  defaultSettings,
  type SettingsKey,
  type SettingsSnapshot,
  type SettingValue
} from '@shared/settings/definitions.js'
import type { SecurityState } from '@shared/model.js'

/**
 * `site:menu`, the handler behind the lock and the shield (U19).
 *
 * Reachable here because the registrar is handed in rather than imported, the arrangement
 * `media-handlers.ts` set up. What is tested is what the template cannot see: which tab the menu is
 * about, which answers a window is handed, and what each click writes.
 */

const EVENT = undefined as unknown as IpcMainInvokeEvent

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-site-menu-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

interface FakeTab extends SiteMenuTab {
  zoomCalls: Array<number | 'reset'>
}

function fakeTab(url: string, security: SecurityState = 'secure'): FakeTab {
  const zoomCalls: Array<number | 'reset'> = []
  return {
    zoomCalls,
    zoomPercent: 100,
    toState: () => ({ url, blockedRequests: 2, security }),
    setZoomPercent: (percent) => zoomCalls.push(percent),
    resetZoom: () => zoomCalls.push('reset'),
    view: { webContents: { id: 7, isDestroyed: () => false } }
  }
}

interface FakeWindow extends SiteMenuWindow {
  readonly tabs: readonly FakeTab[]
}

/** Two tiles; the first is the active one, which is the tile the address bar speaks for. */
function fakeWindow(privateMode = false): FakeWindow {
  const tabs = [fakeTab('https://shop.example/cart'), fakeTab('https://shop.example/other')]
  return { privateMode, tabs, resolveTab: () => tabs[0], createTab: vi.fn() }
}

function fakeSettings(
  overrides: Partial<SettingsSnapshot> = {}
): SiteHandlerDeps<FakeWindow>['settings'] & {
  writes: Array<[string, unknown]>
} {
  const values: SettingsSnapshot = { ...defaultSettings(), ...overrides }
  const writes: Array<[string, unknown]> = []
  return {
    writes,
    get: <K extends SettingsKey>(key: K): SettingValue<K> => values[key],
    set: (key, value) => {
      writes.push([key, value])
    }
  }
}

const editor = {
  list: () => [],
  setEnabled: () => true,
  remove: () => true,
  canSetEnabled: () => true,
  canRemove: () => true
} as unknown as UserRuleTextEditor

interface Harness {
  open(): MenuItemConstructorOptions[] | undefined
  settings: ReturnType<typeof fakeSettings>
}

function harness(options: {
  window: FakeWindow | undefined
  store: PermissionStore
  settings?: ReturnType<typeof fakeSettings>
  editor?: UserRuleTextEditor
}): Harness {
  let registered: ((payload: undefined, event: IpcMainInvokeEvent) => unknown) | undefined
  const handle = ((channel: string, handler: typeof registered) => {
    expect(channel).toBe('site:menu')
    registered = handler
  }) as unknown as SiteHandle
  const settings = options.settings ?? fakeSettings()
  let shown: MenuItemConstructorOptions[] | undefined
  registerSiteHandlers<FakeWindow>({
    handle,
    windows: { resolve: () => options.window },
    settings,
    locale: () => 'en',
    permissions: options.store,
    rulesFor: () => options.editor ?? editor,
    startPicker: vi.fn(),
    refreshFilters: vi.fn(),
    showMenu: (template) => {
      shown = template
    }
  })
  return {
    settings,
    open: () => {
      shown = undefined
      expect(registered?.(undefined, EVENT)).toEqual({ ok: true })
      return shown
    }
  }
}

async function store(): Promise<PermissionStore> {
  const opened = await PermissionStore.open({
    filePath: join(directory, 'permissions.json'),
    debounceMs: 0
  })
  const rules = opened.rulesFor('normal')
  rules.remember('https://shop.example', 'camera', 'allow')
  rules.remember('https://shop.example', 'geolocation', 'allow')
  return opened
}

function find(items: readonly MenuItemConstructorOptions[] | undefined, label: string) {
  const item = items?.find((candidate) => candidate.label === label)
  if (item === undefined) throw new Error(`no item "${label}"`)
  return item
}

function click(item: MenuItemConstructorOptions): void {
  ;(item.click as () => void)()
}

function submenu(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return item.submenu as MenuItemConstructorOptions[]
}

describe('site:menu', () => {
  it('shows the location answer and not the camera one, and forgets exactly that', async () => {
    const permissions = await store()
    const forget = vi.spyOn(permissions, 'forget')
    const menu = harness({ window: fakeWindow(), store: permissions }).open()

    const labels = menu?.map((item) => item.label)
    expect(labels).toContain('Location: Allowed')
    expect(labels?.some((label) => typeof label === 'string' && /camera/i.test(label))).toBe(false)

    click(find(submenu(find(menu, 'Location: Allowed')), 'Forget'))
    expect(forget).toHaveBeenCalledExactlyOnceWith('https://shop.example', ['geolocation'])
    expect(permissions.list().map((site) => site.topic)).toEqual(['camera'])
    await permissions.flush()
  })

  it('shows a private window none of the stored answers', async () => {
    const permissions = await store()
    const menu = harness({ window: fakeWindow(true), store: permissions }).open()
    expect(menu?.map((item) => item.label)).not.toContain('Location: Allowed')
    expect(find(menu, 'Permissions are not saved in private windows').enabled).toBe(false)
    await permissions.flush()
  })

  it('writes the same exemption the blocker menu wrote', async () => {
    const permissions = await store()
    const exempt = ['news.example']
    const settings = fakeSettings({ 'privacy.blockerOffForSites': exempt })
    const menu = harness({ window: fakeWindow(), store: permissions, settings }).open()

    click(find(menu, 'Blocking on this site'))
    expect(settings.writes).toEqual([
      ['privacy.blockerOffForSites', [...withSiteExemption(exempt, 'shop.example', true)]]
    ])
    expect(settings.writes[0]?.[1]).toEqual(['news.example', 'shop.example'])
    await permissions.flush()
  })

  it('switches blocking back on for a site the user had exempted', async () => {
    const permissions = await store()
    const settings = fakeSettings({ 'privacy.blockerOffForSites': ['shop.example'] })
    const menu = harness({ window: fakeWindow(), store: permissions, settings }).open()
    const item = find(menu, 'Blocking on this site')
    expect(item.checked).toBe(false)
    click(item)
    expect(settings.writes).toEqual([['privacy.blockerOffForSites', []]])
    await permissions.flush()
  })

  it('keeps the blocker menu’s other items wired to the same calls', async () => {
    const permissions = await store()
    const window = fakeWindow()
    const startPicker = vi.fn()
    const refreshFilters = vi.fn()
    let registered: ((payload: undefined, event: IpcMainInvokeEvent) => unknown) | undefined
    let shown: MenuItemConstructorOptions[] = []
    registerSiteHandlers<FakeWindow>({
      handle: ((_channel: string, handler: typeof registered) => {
        registered = handler
      }) as unknown as SiteHandle,
      windows: { resolve: () => window },
      settings: fakeSettings(),
      locale: () => 'en',
      permissions,
      rulesFor: () => editor,
      startPicker,
      refreshFilters,
      showMenu: (template) => {
        shown = template
      }
    })
    registered?.(undefined, EVENT)

    click(find(shown, 'Block element…'))
    click(find(shown, 'Update filter lists now'))
    click(find(submenu(find(shown, 'My rules (0)')), 'Manage in settings…'))
    expect(startPicker).toHaveBeenCalledWith(7)
    expect(refreshFilters).toHaveBeenCalledOnce()
    expect(window.createTab).toHaveBeenCalledWith({ url: 'tessera://settings' })
    await permissions.flush()
  })

  it('starts no picker on a page that went while the menu was up', async () => {
    const permissions = await store()
    const window = fakeWindow()
    const startPicker = vi.fn()
    let registered: ((payload: undefined, event: IpcMainInvokeEvent) => unknown) | undefined
    let shown: MenuItemConstructorOptions[] = []
    registerSiteHandlers<FakeWindow>({
      handle: ((_channel: string, handler: typeof registered) => {
        registered = handler
      }) as unknown as SiteHandle,
      windows: { resolve: () => window },
      settings: fakeSettings(),
      locale: () => 'en',
      permissions,
      rulesFor: () => editor,
      startPicker,
      refreshFilters: vi.fn(),
      showMenu: (template) => {
        shown = template
      }
    })
    registered?.(undefined, EVENT)
    // What Electron's getter gives once the page has gone.
    Object.assign(window.tabs[0]!, { view: { webContents: undefined } })

    click(find(shown, 'Block element…'))
    expect(startPicker).not.toHaveBeenCalled()
    await permissions.flush()
  })

  it('switches and deletes the site’s rules through the sender’s editor', async () => {
    const permissions = await store()
    const rule = {
      id: 'r1',
      text: 'shop.example##.ad',
      enabled: true,
      createdAt: 1,
      origin: 'picker' as const
    }
    const setEnabled = vi.fn(() => true)
    const remove = vi.fn(() => true)
    const canSetEnabled = vi.fn(() => true)
    const canRemove = vi.fn(() => true)
    const own = { ...editor, list: () => [rule], setEnabled, remove, canSetEnabled, canRemove }
    const menu = harness({ window: fakeWindow(), store: permissions, editor: own }).open()
    const rules = submenu(find(menu, 'My rules (1)'))

    click(find(rules, 'shop.example##.ad'))
    click(find(rules, 'Delete my rules for this site (1)'))
    expect(setEnabled).toHaveBeenCalledWith('r1', false)
    expect(remove).toHaveBeenCalledWith('r1')
    expect(canSetEnabled).toHaveBeenCalledWith('r1', false)
    expect(canRemove).toHaveBeenCalledWith('r1')
    await permissions.flush()
  })

  it('zooms the tile the menu was opened for and no other', async () => {
    const permissions = await store()
    const window = fakeWindow()
    const menu = harness({ window, store: permissions }).open()
    const zoom = submenu(find(menu, 'Zoom: 100%'))

    click(find(zoom, 'Zoom In'))
    click(find(zoom, 'Zoom Out'))
    click(find(zoom, 'Reset Zoom'))
    expect(window.tabs[0]?.zoomCalls).toEqual([110, 90, 'reset'])
    expect(window.tabs[1]?.zoomCalls).toEqual([])
    await permissions.flush()
  })

  it('switches the fingerprint mode and the global blocker through the settings', async () => {
    const permissions = await store()
    const h = harness({ window: fakeWindow(), store: permissions })
    const menu = h.open()
    click(find(menu, 'Fingerprint protection'))
    click(find(menu, 'Blocking enabled'))
    expect(h.settings.writes).toEqual([
      ['fingerprint.mode', 'off'],
      ['privacy.blockerEnabled', false]
    ])
    await permissions.flush()
  })

  it('opens nothing without a window or a tab', async () => {
    const permissions = await store()
    expect(harness({ window: undefined, store: permissions }).open()).toBeUndefined()
    const empty: FakeWindow = { ...fakeWindow(), resolveTab: () => undefined }
    expect(harness({ window: empty, store: permissions }).open()).toBeUndefined()
    await permissions.flush()
  })
})
