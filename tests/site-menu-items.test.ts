import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import {
  UNLISTED_TOPICS,
  listedPermissions,
  permissionOriginOf,
  siteMenuTemplate,
  type SiteMenuDeps
} from '@main/menu/site-menu-items.js'
import { blockerMenuTemplate } from '@main/menu/blocker-menu-items.js'
import { securityStateOf } from '@shared/site/model.js'
import type { SitePermission } from '@main/permissions/model.js'
import { PERMISSION_TOPICS } from '@shared/overlay/permission.js'

/**
 * The menu behind the lock (U19, R33): what the page in front of the user is allowed, filtered and zoomed
 * to, in one place.
 *
 * The assertions that matter most are the ones about what is *not* there. Camera, microphone and screen
 * sharing stay exactly as they are today (Key Decision, R33), so a stored camera answer must neither be
 * listed nor be swept away by "forget all" — the second is the one a careless implementation gets wrong
 * while every visible label still looks right.
 */

const ORIGIN = 'https://shop.example'

function answer(overrides: Partial<SitePermission> = {}): SitePermission {
  return { origin: ORIGIN, topic: 'geolocation', decision: 'allow', decidedAt: 100, ...overrides }
}

function site(overrides: Partial<SiteMenuDeps> = {}): SiteMenuDeps {
  return {
    locale: 'en',
    blockedOnPage: 3,
    userRules: [],
    blockerEnabled: true,
    host: 'shop.example',
    blockerEnabledOnSite: true,
    onBlockElement: vi.fn(),
    onOpenSettings: vi.fn(),
    onRefreshLists: vi.fn(),
    onSetBlockerEnabled: vi.fn(),
    onSetBlockerEnabledOnSite: vi.fn(),
    onSetRuleEnabled: vi.fn(),
    onRemoveRules: vi.fn(),
    security: 'secure',
    origin: ORIGIN,
    privateWindow: false,
    storedPermissions: [],
    zoomPercent: 100,
    fingerprintMode: 'uniform',
    onForgetPermissions: vi.fn(),
    onZoom: vi.fn(),
    onSetFingerprintMode: vi.fn(),
    ...overrides
  }
}

function labels(items: readonly MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => (typeof item.label === 'string' ? [item.label] : []))
}

function find(
  items: readonly MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions {
  const item = items.find((candidate) => candidate.label === label)
  if (item === undefined) throw new Error(`no item "${label}" in ${labels(items).join(' | ')}`)
  return item
}

function submenuOf(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  if (!Array.isArray(item.submenu)) throw new Error(`"${String(item.label)}" has no submenu`)
  return item.submenu
}

function click(item: MenuItemConstructorOptions): void {
  if (item.click === undefined) throw new Error(`"${String(item.label)}" cannot be clicked`)
  ;(item.click as () => void)()
}

describe('the connection status', () => {
  it('opens with the status of the connection, which is a statement and not a command', () => {
    const [first, second] = siteMenuTemplate(site())
    expect(first).toEqual({ label: 'Connection is encrypted', enabled: false })
    expect(second).toEqual({ type: 'separator' })
  })

  it.each([
    ['http://shop.example/', false, 'Connection is not encrypted'],
    ['https://shop.example/', false, 'Connection is encrypted'],
    ['https://shop.example/', true, 'Certificate is not valid'],
    ['tessera://settings/', false, 'Tessera page'],
    ['about:blank', false, 'Tessera page'],
    ['', false, 'Tessera page']
  ] as const)('reads %s (certificate rejected: %s) as "%s"', (url, rejected, expected) => {
    const menu = siteMenuTemplate(site({ security: securityStateOf(url, rejected) }))
    expect(menu[0]?.label).toBe(expected)
  })

  it('does not let a rejected certificate outrank an internal page', () => {
    expect(securityStateOf('tessera://start/', true)).toBe('internal')
  })

  it('speaks the menu’s language', () => {
    expect(siteMenuTemplate(site({ locale: 'de', security: 'insecure' }))[0]?.label).toBe(
      'Verbindung ist nicht verschlüsselt'
    )
  })
})

describe('the blocker, merged in', () => {
  it('carries the blocker menu unchanged, so the shield and the lock open the same thing', () => {
    const deps = site()
    const menu = siteMenuTemplate(deps)
    const blocker = blockerMenuTemplate(deps)
    expect(menu.slice(2, 2 + blocker.length).map((item) => item.label)).toEqual(
      blocker.map((item) => item.label)
    )
    expect(labels(menu)).toContain('3 requests blocked on this page')
  })

  it('writes the per-site exemption through the same callback the blocker menu always used', () => {
    const onSetBlockerEnabledOnSite = vi.fn()
    click(find(siteMenuTemplate(site({ onSetBlockerEnabledOnSite })), 'Blocking on this site'))
    expect(onSetBlockerEnabledOnSite).toHaveBeenCalledWith('shop.example', false)
  })
})

describe('the stored permissions', () => {
  it('lists the location and not the camera, for a site that has both', () => {
    const menu = siteMenuTemplate(
      site({ storedPermissions: [answer({ topic: 'camera' }), answer({ topic: 'geolocation' })] })
    )
    expect(labels(menu)).toContain('Location: Allowed')
    expect(labels(menu).some((label) => /camera/i.test(label))).toBe(false)
  })

  it('keeps camera, microphone and screen sharing out of the list, and nothing else', () => {
    expect([...UNLISTED_TOPICS].sort()).toEqual(['camera', 'display-capture', 'microphone'])
    const everything = PERMISSION_TOPICS.map((topic) => answer({ topic }))
    const listed = listedPermissions(everything, ORIGIN).map((entry) => entry.topic)
    expect(listed).toEqual(PERMISSION_TOPICS.filter((topic) => !UNLISTED_TOPICS.has(topic)))
  })

  it('lists only the origin the menu is about, in the order the topics are declared', () => {
    const listed = listedPermissions(
      [
        answer({ topic: 'notifications' }),
        answer({ origin: 'https://other.example', topic: 'midi' }),
        answer({ topic: 'geolocation', decision: 'deny' })
      ],
      ORIGIN
    )
    expect(listed.map((entry) => entry.topic)).toEqual(['geolocation', 'notifications'])
  })

  it('says whether each answer was yes or no', () => {
    const menu = siteMenuTemplate(
      site({
        storedPermissions: [
          answer({ topic: 'geolocation', decision: 'allow' }),
          answer({ topic: 'notifications', decision: 'deny' })
        ]
      })
    )
    expect(labels(menu)).toEqual(
      expect.arrayContaining(['Location: Allowed', 'Notifications: Blocked'])
    )
  })

  it('forgets exactly that origin and that topic', () => {
    const onForgetPermissions = vi.fn()
    const menu = siteMenuTemplate(
      site({
        storedPermissions: [answer({ topic: 'geolocation' }), answer({ topic: 'notifications' })],
        onForgetPermissions
      })
    )
    click(find(submenuOf(find(menu, 'Location: Allowed')), 'Forget'))
    expect(onForgetPermissions).toHaveBeenCalledTimes(1)
    expect(onForgetPermissions).toHaveBeenCalledWith(ORIGIN, ['geolocation'])
  })

  it('forgets everything it lists and leaves the camera where it was', () => {
    const onForgetPermissions = vi.fn()
    const menu = siteMenuTemplate(
      site({
        storedPermissions: [
          answer({ topic: 'camera' }),
          answer({ topic: 'geolocation' }),
          answer({ topic: 'notifications' })
        ],
        onForgetPermissions
      })
    )
    click(find(menu, 'Forget all permissions for this site (2)'))
    expect(onForgetPermissions).toHaveBeenCalledWith(ORIGIN, ['geolocation', 'notifications'])
  })

  it('says so when nothing is stored, rather than showing an empty section', () => {
    const menu = siteMenuTemplate(site({ storedPermissions: [answer({ topic: 'microphone' })] }))
    expect(find(menu, 'No saved permissions for this site').enabled).toBe(false)
    expect(labels(menu).some((label) => label.startsWith('Forget all'))).toBe(false)
  })

  it('shows no stored permission in a private window, even if one were handed over', () => {
    const menu = siteMenuTemplate(
      site({ privateWindow: true, storedPermissions: [answer({ topic: 'geolocation' })] })
    )
    expect(labels(menu)).not.toContain('Location: Allowed')
    expect(find(menu, 'Permissions are not saved in private windows').enabled).toBe(false)
  })

  it('has no permission section for a document without an origin', () => {
    const menu = siteMenuTemplate(
      site({ origin: null, host: null, security: 'internal', storedPermissions: [answer()] })
    )
    expect(labels(menu).some((label) => /permission/i.test(label))).toBe(false)
    expect(labels(menu)).not.toContain('Location: Allowed')
  })

  it('names every listed topic in both languages', () => {
    for (const locale of ['en', 'de'] as const) {
      const everything = PERMISSION_TOPICS.map((topic) => answer({ topic }))
      const permissionLabels = labels(
        siteMenuTemplate(site({ locale, storedPermissions: everything }))
      ).filter((label) => label.includes(':') && !label.includes('%'))
      expect(permissionLabels).toHaveLength(PERMISSION_TOPICS.length - UNLISTED_TOPICS.size)
      for (const label of permissionLabels) expect(label).not.toMatch(/[{}]|site\./)
    }
  })

  it('reads the origin a permission is stored under from the page address', () => {
    expect(permissionOriginOf('https://shop.example/cart?id=1')).toBe(ORIGIN)
    expect(permissionOriginOf('http://shop.example:8080/')).toBe('http://shop.example:8080')
    expect(permissionOriginOf('tessera://settings/')).toBeNull()
    expect(permissionOriginOf('about:blank')).toBeNull()
    expect(permissionOriginOf('not a url')).toBeNull()
  })
})

describe('the zoom of this tile', () => {
  it('shows the tile’s zoom and steps it in, out and back', () => {
    const onZoom = vi.fn()
    const zoom = submenuOf(find(siteMenuTemplate(site({ zoomPercent: 110, onZoom })), 'Zoom: 110%'))
    click(find(zoom, 'Zoom In'))
    click(find(zoom, 'Zoom Out'))
    click(find(zoom, 'Reset Zoom'))
    expect(onZoom.mock.calls).toEqual([['in'], ['out'], ['reset']])
  })

  it('writes the percentage the German way in German', () => {
    expect(labels(siteMenuTemplate(site({ locale: 'de', zoomPercent: 90 })))).toContain(
      'Zoom: 90 %'
    )
  })
})

describe('the fingerprint mode', () => {
  it('is a checkbox that switches the setting to the other mode', () => {
    const onSetFingerprintMode = vi.fn()
    const on = find(siteMenuTemplate(site({ onSetFingerprintMode })), 'Fingerprint protection')
    expect(on.type).toBe('checkbox')
    expect(on.checked).toBe(true)
    click(on)
    const off = find(
      siteMenuTemplate(site({ fingerprintMode: 'off', onSetFingerprintMode })),
      'Fingerprint protection'
    )
    expect(off.checked).toBe(false)
    click(off)
    expect(onSetFingerprintMode.mock.calls).toEqual([['off'], ['uniform']])
  })

  it('says that a tab opened before the change keeps the old plan', () => {
    const menu = siteMenuTemplate(site())
    const note = find(menu, 'Applies to tabs opened after a change')
    expect(note.enabled).toBe(false)
    expect(menu.at(-1)).toBe(note)
  })
})
