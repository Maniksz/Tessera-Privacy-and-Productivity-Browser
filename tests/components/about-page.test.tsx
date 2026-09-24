import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AboutPage } from '@renderer-internal/AboutPage.js'
import { PRODUCT_NAME } from '@shared/product.js'

/**
 * `tessera://about`: who the application is, in the user's language, with no bridge to ask anyone.
 *
 * The page is served without privileges (it is not in `INTERNAL_PAGES`), so it cannot fetch the
 * catalogue the core resolved. It chooses between the bundled catalogues by `navigator.language`
 * instead — the same path the HTTPS-only interstitial takes. The version and the licence are build
 * constants fed from `package.json` by `electron.vite.config.ts`; here they are stubbed with the same
 * values, and `tests/architecture.test.ts` checks the built chunk carries them.
 *
 * The last block loads the tab preload itself for that address and checks it hands the page nothing.
 */

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
  version: string
  license: string
}

function setLanguage(language: string): void {
  Object.defineProperty(window.navigator, 'language', { value: language, configurable: true })
}

beforeEach(() => {
  vi.stubGlobal('__TESSERA_VERSION__', pkg.version)
  vi.stubGlobal('__TESSERA_LICENSE__', pkg.license)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('what the about page says', () => {
  it('names the product, the version from the build constant and the licence', () => {
    setLanguage('en-GB')
    render(<AboutPage />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(PRODUCT_NAME)
    expect(screen.getByText(`Version ${pkg.version}`)).toBeTruthy()
    expect(pkg.license).toBe('GPL-3.0-or-later')
    expect(document.body.textContent).toContain('GPL-3.0-or-later')
  })

  it('shows whatever version the build put in, not one of its own', () => {
    setLanguage('en')
    vi.stubGlobal('__TESSERA_VERSION__', '9.8.7-test')
    render(<AboutPage />)
    expect(screen.getByText('Version 9.8.7-test')).toBeTruthy()
  })

  it('speaks German to a German browser', () => {
    setLanguage('de-DE')
    render(<AboutPage />)
    expect(document.body.textContent).toContain('Freie Software')
    expect(document.documentElement.lang).toBe('de')
    expect(document.title).toBe(`Über ${PRODUCT_NAME}`)
  })

  it('follows the language the core put in its address over a masked navigator.language', () => {
    // Help › About opens `tessera://about?lang=…`; with fingerprint masking the page reads `en-US`.
    setLanguage('en-US')
    vi.stubGlobal('location', new URL('tessera://about?lang=de'))
    render(<AboutPage />)
    expect(document.body.textContent).toContain('Freie Software')
    expect(document.documentElement.lang).toBe('de')
  })

  it('falls back to English for a language it has no catalogue for', () => {
    setLanguage('fr')
    render(<AboutPage />)
    expect(document.body.textContent).toContain('Free software')
    expect(document.body.textContent).not.toContain('Freie Software')
    expect(document.documentElement.lang).toBe('en')
    expect(document.title).toBe(`About ${PRODUCT_NAME}`)
  })

  it('renders with no bridge on the window at all', () => {
    setLanguage('en')
    expect((window as { tesseraInternal?: unknown }).tesseraInternal).toBeUndefined()
    render(<AboutPage />)
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy()
  })
})

/*
  The preload, run for real against the page's address.

  Its dependencies with side effects are replaced: `electron` (no main process here), the installers
  for masking, filtering, picker and autofill, and `markPreloadRan`, which defines a non-configurable
  global and so could not run twice in one document. What is left is exactly the decision under test —
  which address gets `tesseraInternal`.
*/
const { exposed } = vi.hoisted(() => ({ exposed: [] as string[] }))

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (name: string) => {
      exposed.push(name)
    },
    executeInMainWorld: () => undefined
  },
  ipcRenderer: {
    sendSync: () => {
      throw new Error('no core in a component test')
    },
    invoke: () => Promise.resolve(undefined),
    on: () => undefined,
    removeListener: () => undefined
  }
}))
vi.mock('../../src/preload/bridge.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  markPreloadRan: () => undefined
}))
vi.mock('../../src/preload/cosmetic.js', () => ({ installCosmeticFiltering: () => undefined }))
vi.mock('../../src/preload/picker.js', () => ({ installElementPicker: () => undefined }))
vi.mock('../../src/preload/autofill.js', () => ({ installAutofill: () => undefined }))
vi.mock('../../src/preload/zoom.js', () => ({ installZoomGesture: () => undefined }))
vi.mock('../../src/preload/swipe.js', () => ({ installSwipeNavigation: () => undefined }))

// A computed specifier, so the components project does not pull the whole preload into its type check
// (it lists the preload modules it tests one by one; see `tsconfig.components.json`).
const PRELOAD = '../../src/preload/index.js'

async function exposedAt(address: string): Promise<string[]> {
  exposed.length = 0
  vi.stubGlobal('location', new URL(address))
  vi.resetModules()
  await import(/* @vite-ignore */ PRELOAD)
  return [...exposed]
}

describe('the bridge at tessera://about', () => {
  it('is not handed out', async () => {
    expect(await exposedAt('tessera://about/')).toEqual([])
  })

  it('is handed out to a privileged page, so the check above can fail', async () => {
    expect(await exposedAt('tessera://downloads/')).toEqual(['tesseraInternal'])
  })
})
