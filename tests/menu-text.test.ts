import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { catalogs, LOCALES, type Locale } from '@shared/i18n/catalog.js'
import { PRODUCT_NAME } from '@shared/product.js'
import type { Platform } from '@shared/model.js'
import { buildApplicationMenu, type MenuDeps } from '@main/menu/appMenu.js'
import { isMenuTextKey, menuLabel, menuTexts, type MenuTextKey } from '@main/menu/menu-text.js'

// Hoisted above the imports. `buildFromTemplate` hands the template back, so the test reads exactly
// what Electron would be given.
vi.mock('electron', () => ({
  Menu: {
    buildFromTemplate: (template: unknown) => template,
    setApplicationMenu: () => undefined
  },
  app: { name: 'Tessera' }
}))

/**
 * The native menus' labels, held to the rules the message catalogue is held to.
 *
 * These labels left `shared/i18n/catalog.*` for the core (see `main/menu/menu-text.ts`), and with that
 * they left the reach of the catalogue's checks in `tests/ipc-contract.test.ts`. The compiler still
 * refuses a German table with a missing or extra key; what it cannot see — a key set that differs at
 * runtime, an empty string, a placeholder a translation dropped, a key that ended up in both tables — is
 * written out again here, on the pattern `tests/update-text.test.ts` set.
 */
describe('the menu text tables', () => {
  const keys = Object.keys(menuTexts.en) as MenuTextKey[]

  it('has the same keys in every locale, and no German extra', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(menuTexts[locale]).sort(), locale).toEqual([...keys].sort())
    }
  })

  it('has no empty string anywhere in it', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(menuTexts[locale][key].trim(), `${locale}/${key}`).not.toBe('')
      }
    }
  })

  it('keeps placeholders consistent across locales', () => {
    // A translation that drops {count} loses the one fact the blocker's first line exists to state.
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()

    for (const key of keys) {
      const reference = placeholders(menuTexts.en[key])
      for (const locale of LOCALES) {
        expect(placeholders(menuTexts[locale][key]), `${locale}/${key}`).toEqual(reference)
      }
    }
  })

  it('shares no key with the catalogue', () => {
    // `menuLabel` decides which table answers by the key alone; a key in both would make that a guess.
    expect(keys.filter((key) => Object.hasOwn(catalogs.en, key))).toEqual([])
  })

  it('holds only keys that no renderer or shared module names', () => {
    /*
      The whole point of the table. A key a renderer reads has to stay in the catalogue, or the surface
      that draws it shows the raw key — `menu.window`, `menu.tools.downloads`, the zoom buttons and the
      layout names are the ones that did. A quoted key anywhere under `src/renderer` or `src/shared` is
      how a new reader would show up.
    */
    const sources = (directory: string): string[] =>
      readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(entry.name) ? [path] : []
      })
    const files = [
      ...sources(join(process.cwd(), 'src/renderer')),
      ...sources(join(process.cwd(), 'src/shared'))
    ]
    expect(files.length).toBeGreaterThan(0)

    const readers = files.flatMap((file) => {
      const text = readFileSync(file, 'utf8')
      return keys
        .filter((key) => ["'", '"', '`'].some((quote) => text.includes(`${quote}${key}${quote}`)))
        .map((key) => `${key} in ${file}`)
    })
    expect(readers).toEqual([])
  })
})

describe('menuLabel', () => {
  it('reads the core table for a key it has', () => {
    expect(isMenuTextKey('menu.file.newTab')).toBe(true)
    expect(menuLabel('de', 'menu.file.newTab')).toBe('Neuer Tab')
  })

  it('reads the catalogue for any other key', () => {
    expect(isMenuTextKey('menu.window')).toBe(false)
    expect(menuLabel('de', 'menu.window')).toBe('Fenster')
    expect(menuLabel('en', 'updates.checkNow')).toBe('Check for Updates…')
  })

  it('does not mistake an inherited property for a key', () => {
    expect(isMenuTextKey('toString')).toBe(false)
  })

  it('fills placeholders with the catalogue’s rules, {app} included', () => {
    expect(menuLabel('de', 'menu.help.about')).toBe(`Über ${PRODUCT_NAME}`)
    expect(menuLabel('en', 'blocker.myRules', { count: 3 })).toBe('My rules (3)')
  })
})

/** Every label in a template, submenus flattened, separators dropped. */
function labelsOf(items: readonly MenuItemConstructorOptions[]): string[] {
  return items.flatMap((item) => [
    ...(typeof item.label === 'string' ? [item.label] : []),
    ...(Array.isArray(item.submenu) ? labelsOf(item.submenu) : [])
  ])
}

function applicationMenu(locale: Locale, platform: Platform): MenuItemConstructorOptions[] {
  const deps = {
    windows: { focused: () => undefined, controllers: [] },
    settings: { get: () => ({}) },
    locale,
    platform,
    checkForUpdates: () => undefined
  } as unknown as MenuDeps
  return buildApplicationMenu(deps) as unknown as MenuItemConstructorOptions[]
}

describe('the application menu', () => {
  const platforms: Platform[] = ['darwin', 'linux', 'win32']

  it('shows no raw key and no unfilled placeholder, in any locale or platform', () => {
    // A key that left the catalogue and was not found in the core table would surface as itself.
    for (const locale of LOCALES) {
      for (const platform of platforms) {
        for (const label of labelsOf(applicationMenu(locale, platform))) {
          expect(label, `${locale}/${platform}`).not.toMatch(/^(menu|blocker|page|updates)\./)
          expect(label, `${locale}/${platform}`).not.toContain('{')
        }
      }
    }
  })

  it('keeps its headings in both languages', () => {
    const headings = (locale: Locale, platform: Platform): unknown[] =>
      applicationMenu(locale, platform).map((item) => item.label)

    expect(headings('en', 'linux')).toEqual([
      'File',
      'Edit',
      'View',
      'History',
      'Bookmarks',
      'Split View',
      'Tools',
      'Window',
      'Help'
    ])
    expect(headings('de', 'linux')).toEqual([
      'Datei',
      'Bearbeiten',
      'Ansicht',
      'Verlauf',
      'Lesezeichen',
      'Split View',
      'Werkzeuge',
      'Fenster',
      'Hilfe'
    ])
    // macOS puts the application menu first, named after the application.
    expect(headings('de', 'darwin')[0]).toBe('Tessera')
  })

  it('labels items from the core table and from the catalogue side by side', () => {
    const german = labelsOf(applicationMenu('de', 'linux'))
    // From `menu-text.*`.
    expect(german).toEqual(
      expect.arrayContaining(['Neuer Tab', 'Kachel maximieren', 'Alles löschen und beenden'])
    )
    expect(german).toContain(`Über ${PRODUCT_NAME}`)
    // From the catalogue, which a renderer shares: zoom, downloads, layouts, the update check.
    expect(german).toEqual(
      expect.arrayContaining(['Vergrößern', 'Downloads', 'Zwei Spalten', 'Nach Updates suchen…'])
    )
  })

  it('offers the macOS-only entries on macOS alone', () => {
    const mac = labelsOf(applicationMenu('en', 'darwin'))
    const linux = labelsOf(applicationMenu('en', 'linux'))
    expect(mac).toContain('Zoom')
    expect(linux).not.toContain('Zoom')
    expect(mac).toContain('Close Window')
    expect(linux).toContain('Quit')
  })
})
