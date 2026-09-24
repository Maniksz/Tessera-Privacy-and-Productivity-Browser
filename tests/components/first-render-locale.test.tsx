import { useLayoutEffect, type ComponentType, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { catalogs } from '@shared/i18n/catalog.js'
import type { Locale } from '@shared/i18n/locale.js'

/**
 * The first frame a renderer draws is already in the user's language, and a renderer loads no language
 * it does not show.
 *
 * Both are about the step before `createRoot`, so both are asserted through the real entries: `main.tsx`,
 * `overlay.tsx`, `history.tsx`, `about.tsx`. Each test starts from a fresh module graph, so nothing the
 * components project's setup loaded (`setup.ts`) is there — what a renderer shows first is what its entry
 * arranged and nothing else.
 *
 * "First frame" is taken literally: the text of the root when the first commit's layout effects run, which
 * is after React has written the DOM and before the browser paints it. The component an entry renders is
 * wrapped in a recorder that reads it there. The old providers started from the bundled English catalogue
 * and swapped the core's answer in from an effect, so that frame was English for a German user — the frame
 * these tests exist to keep out.
 *
 * (A `MutationObserver` was the first way this was measured, and under happy-dom it missed mutations now
 * and then — a test waiting five seconds for a render that had happened. A layout effect is React's own
 * account of the commit.)
 */

interface FakeCore {
  /** The language the core resolves; changing it is what a settings write does. */
  locale: Locale
  calls: string[]
  emit: (channel: string, payload: unknown) => void
  bridge: unknown
}

function fakeCore(initial: Locale, answers: Record<string, unknown> = {}): FakeCore {
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const core: FakeCore = {
    locale: initial,
    calls: [],
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload)
    },
    bridge: undefined
  }
  core.bridge = {
    invoke: (channel: string): Promise<unknown> => {
      core.calls.push(channel)
      if (channel === 'i18n:getCatalog') {
        // What the real handler sends: the resolved locale, and a copy of its whole catalogue.
        return Promise.resolve({ locale: core.locale, messages: { ...catalogs[core.locale] } })
      }
      if (channel in answers) return Promise.resolve(answers[channel])
      return Promise.reject(new Error(`unexpected channel ${channel}`))
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), listener])
      return () => {
        listeners.set(
          channel,
          (listeners.get(channel) ?? []).filter((candidate) => candidate !== listener)
        )
      }
    },
    channels: { invoke: [], event: ['locale:changed'] }
  }
  return core
}

function install(property: 'tessera' | 'tesseraInternal', bridge: unknown): void {
  Object.defineProperty(window, property, { value: bridge, configurable: true, writable: true })
}

/**
 * What each bridge is left as between tests: one that never answers.
 *
 * An entry keeps no handle on its root, so the page a test started stays mounted after it — and the history
 * page's search timer goes on calling the core. Removing the bridge would turn those calls into unhandled
 * rejections attributed to whichever test runs next; a bridge that never answers keeps them quiet.
 */
const inert = {
  invoke: () => new Promise(() => {}),
  on: () => () => {},
  channels: { invoke: [], event: [] }
}

/** Generous, because the first test to run an entry also pays for transforming it. */
const FIRST_RENDER = { timeout: 5000 }

/** The root's text at each mount of the recorded component; `[0]` is the first frame. */
let frames: string[] = []

/**
 * Replaces `exportName` of `module` with a recorder around the real component, or around a stand-in.
 *
 * The recorder is the outermost component the entry renders, so its layout effect is the last of the
 * commit and the root holds everything the first frame will show.
 */
function recordFirstFrame(
  module: string,
  exportName: string,
  rootId: string,
  standIn?: () => Promise<ComponentType>
): void {
  vi.doMock(module, async (importOriginal) => {
    const Inner =
      standIn === undefined
        ? (await importOriginal<Record<string, ComponentType>>())[exportName]!
        : await standIn()
    const Recorder = (): ReactNode => {
      useLayoutEffect(() => {
        frames.push(document.getElementById(rootId)?.textContent ?? '')
      }, [])
      return <Inner />
    }
    return { [exportName]: Recorder }
  })
}

/** One label the tab bar really draws, through the real provider — standing in for a whole surface. */
async function tabBarLabel(): Promise<ComponentType> {
  const { useI18n } = await import('@renderer/i18n.js')
  return function Probe(): ReactNode {
    const { locale, t } = useI18n()
    return <p lang={locale}>{t('menu.window')}</p>
  }
}

function rootElement(id: string): HTMLElement {
  const root = document.createElement('div')
  root.id = id
  document.body.append(root)
  return root
}

/** Which per-locale chunks the fresh graph the entry ran in has loaded. */
async function chunksLoaded(): Promise<Locale[]> {
  const { loadedCatalog } = await import('@shared/i18n/load-catalog.js')
  return (['de', 'en'] as const).filter((locale) => loadedCatalog(locale) !== undefined)
}

/**
 * Makes a locale's chunk fail to load, as a missing or blocked chunk would in the running application.
 *
 * `load-catalog.ts` imports the catalogue modules only through `import()`, so this is the one import that
 * rejects and the rest of the graph loads as usual.
 */
function failChunk(locale: Locale): void {
  vi.doMock(`@shared/i18n/catalog.${locale}.js`, () => {
    throw new Error(`chunk catalog.${locale} failed to load`)
  })
}

const MOCKED = [
  '@renderer/App.js',
  '@renderer/surfaces/OverlaySurface.js',
  '@renderer-internal/HistoryPage.js',
  '@renderer-internal/AboutPage.js',
  '@shared/i18n/catalog.de.js',
  '@shared/i18n/catalog.en.js'
]

beforeEach(() => {
  vi.resetModules()
  frames = []
  document.body.innerHTML = ''
})

afterEach(() => {
  install('tessera', inert)
  install('tesseraInternal', inert)
  for (const module of MOCKED) vi.doUnmock(module)
  vi.unstubAllGlobals()
  document.body.innerHTML = ''
})

describe('the chrome UI', () => {
  it('draws German in its first frame for a German user', async () => {
    expect(catalogs.de['menu.window']).not.toBe(catalogs.en['menu.window'])
    install('tessera', fakeCore('de').bridge)
    recordFirstFrame('@renderer/App.js', 'App', 'root', tabBarLabel)
    const root = rootElement('root')

    await import('@renderer/main.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).toBe(catalogs.de['menu.window'])
    expect(root.querySelector('p')?.lang).toBe('de')
  })

  it('carries no catalogue chunk: the language comes from the core', async () => {
    const core = fakeCore('de')
    install('tessera', core.bridge)
    recordFirstFrame('@renderer/App.js', 'App', 'root', tabBarLabel)
    rootElement('root')

    await import('@renderer/main.js')
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)

    // Asked once, by the entry; the provider starts from that answer instead of asking again.
    expect(core.calls).toEqual(['i18n:getCatalog'])
    expect(await chunksLoaded()).toEqual([])
  })

  it('switches language live by asking the core again, still without a chunk', async () => {
    const core = fakeCore('de')
    install('tessera', core.bridge)
    recordFirstFrame('@renderer/App.js', 'App', 'root', tabBarLabel)
    const root = rootElement('root')

    await import('@renderer/main.js')
    await vi.waitFor(() => expect(root.textContent).toBe(catalogs.de['menu.window']), FIRST_RENDER)

    core.locale = 'en'
    core.emit('settings:changed', { changed: { 'appearance.uiLanguage': 'en' }, snapshot: {} })

    await vi.waitFor(() => expect(root.textContent).toBe(catalogs.en['menu.window']))
    expect(root.querySelector('p')?.lang).toBe('en')
    expect(core.calls).toEqual(['i18n:getCatalog', 'i18n:getCatalog'])
    expect(await chunksLoaded()).toEqual([])
  })

  it('falls back to the English chunk, and still renders, when the core cannot be asked', async () => {
    install('tessera', {
      invoke: () => Promise.reject(new Error('no handler')),
      on: () => () => {}
    })
    recordFirstFrame('@renderer/App.js', 'App', 'root', tabBarLabel)
    rootElement('root')

    await import('@renderer/main.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).toBe(catalogs.en['menu.window'])
    expect(await chunksLoaded()).toEqual(['en'])
  })

  it('still renders, in keys, when the core cannot be asked and the English chunk fails too', async () => {
    /*
      `requestCatalog` promises never to reject, and `main.tsx` renders only once it has settled. The
      first failure is caught before `withReference`; this is the second one, inside it, which used to
      reject the request and leave the window blank.
    */
    install('tessera', {
      invoke: () => Promise.reject(new Error('no handler')),
      on: () => () => {}
    })
    failChunk('en')
    const { requestCatalog } = await import('@renderer/i18n.js')
    const { NO_ANSWER } = await import('@shared/i18n/load-catalog.js')
    await expect(requestCatalog()).resolves.toBe(NO_ANSWER)

    recordFirstFrame('@renderer/App.js', 'App', 'root', tabBarLabel)
    rootElement('root')
    await import('@renderer/main.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).toBe('menu.window')
    expect(await chunksLoaded()).toEqual([])
  })
})

describe('the overlay', () => {
  it('renders before the core answers, so it is subscribed when the first presentation comes', async () => {
    /*
      The one renderer that must not wait. Its first presentation is sent once, at `did-finish-load`, to
      whoever is subscribed, and the subscription is an effect of the first render — see `overlay.tsx`.
      So this holds the answer back and asserts the surface mounted anyway, then that the answer is
      applied when it lands.
    */
    let release: (value: unknown) => void = () => {}
    const held = new Promise((resolve) => {
      release = resolve
    })
    install('tessera', { invoke: () => held, on: () => () => {} })
    recordFirstFrame('@renderer/surfaces/OverlaySurface.js', 'OverlaySurface', 'root', tabBarLabel)
    const root = rootElement('root')

    await import('@renderer/overlay.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).not.toBe(catalogs.de['menu.window'])

    release({ locale: 'de', messages: { ...catalogs.de } })
    await vi.waitFor(() => expect(root.textContent).toBe(catalogs.de['menu.window']))
    expect(await chunksLoaded()).toEqual([])
  })
})

describe('a privileged internal page', () => {
  const answers = { 'history:query': [] }

  it('draws German in its first frame for a German user', async () => {
    const core = fakeCore('de', answers)
    install('tesseraInternal', core.bridge)
    recordFirstFrame('@renderer-internal/HistoryPage.js', 'HistoryPage', 'history-root')
    rootElement('history-root')

    await import('@renderer-internal/history.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).toContain(catalogs.de['history.title'])
    expect(frames[0]).not.toContain(catalogs.en['history.title'])
    // Asked once, by the entry; the page's hooks start from that answer instead of asking again.
    expect(core.calls.filter((call) => call === 'i18n:getCatalog')).toEqual(['i18n:getCatalog'])
    expect(await chunksLoaded()).toEqual([])
  })

  it('switches language live when the core says the locale moved', async () => {
    const core = fakeCore('de', answers)
    install('tesseraInternal', core.bridge)
    const root = rootElement('history-root')

    await import('@renderer-internal/history.js')
    await vi.waitFor(
      () => expect(root.textContent).toContain(catalogs.de['history.title']),
      FIRST_RENDER
    )

    core.locale = 'en'
    core.emit('locale:changed', { locale: 'en' })

    await vi.waitFor(() => expect(root.textContent).toContain(catalogs.en['history.title']))
    expect(root.textContent).not.toContain(catalogs.de['history.title'])
    expect(await chunksLoaded()).toEqual([])
  })
})

describe('a page without a bridge', () => {
  beforeEach(() => {
    vi.stubGlobal('__TESSERA_VERSION__', '1.2.3')
    vi.stubGlobal('__TESSERA_LICENSE__', 'GPL-3.0-or-later')
  })

  it('draws German in its first frame when its address says German, and loads German alone', async () => {
    vi.stubGlobal('location', new URL('tessera://about?lang=de'))
    recordFirstFrame('@renderer-internal/AboutPage.js', 'AboutPage', 'about-root')
    rootElement('about-root')

    await import('@renderer-internal/about.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).toContain('Freie Software')
    expect(frames[0]).not.toContain('Free software')
    expect(await chunksLoaded()).toEqual(['de'])
  })

  it('loads English alone when its address says English', async () => {
    vi.stubGlobal('location', new URL('tessera://about?lang=en'))
    recordFirstFrame('@renderer-internal/AboutPage.js', 'AboutPage', 'about-root')
    rootElement('about-root')

    await import('@renderer-internal/about.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).toContain('Free software')
    expect(await chunksLoaded()).toEqual(['en'])
  })

  it('still renders, in keys, when the chunk its address names fails to load', async () => {
    // The entry renders once `prepareBundledI18n` has settled; a rejection there was a blank page.
    vi.stubGlobal('location', new URL('tessera://about?lang=de'))
    failChunk('de')
    const { prepareBundledI18n } = await import('@renderer-internal/bundled-i18n.js')
    await expect(prepareBundledI18n('?lang=de', 'de-DE')).resolves.toBeUndefined()

    recordFirstFrame('@renderer-internal/AboutPage.js', 'AboutPage', 'about-root')
    rootElement('about-root')
    await import('@renderer-internal/about.js')

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), FIRST_RENDER)
    expect(frames[0]).toContain('about.version')
    expect(frames[0]).not.toContain('Freie Software')
    expect(await chunksLoaded()).toEqual([])
  })
})
