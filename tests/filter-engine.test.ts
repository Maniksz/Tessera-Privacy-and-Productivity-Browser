import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { FilterEngine } from '@main/privacy/FilterEngine.js'
import {
  DEFAULT_LIST_MAX_AGE_MS,
  FILTER_LIST_CACHE_DIRNAME,
  FilterListStore
} from '@main/privacy/FilterListStore.js'
import type { RequestContext } from '@main/privacy/RequestPipeline.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The main-process half: the engine the blocker stage asks, and the cache the
 * lists come from.
 *
 * Nothing here decides policy — that is `src/shared/filters/`. What is worth
 * testing is the translation (Electron's resource names, a document URL, a
 * settings switch) and the cache's failure behaviour, because the failure
 * behaviour is where the wrong choice leaves the user unprotected: a download that
 * fails must not discard the list already on disk.
 */

const EASYLIST_SLICE = [
  '[Adblock Plus 2.0]',
  '! Title: EasyList',
  '||ad.doubleclick.net^',
  '||0emm.com^$third-party',
  '/2x2.gif?$image',
  '@@||ads-static.conde.digital^$domain=wired.com',
  '###AC_ad',
  'advfn.com###APS_300_X_600',
  '&adb=y&adb=y^$popup'
].join('\n')

function withSettings(patch: Partial<SettingsSnapshot>): SettingsSnapshot {
  return { ...defaultSettings(), ...patch }
}

function engineFor(
  lists: readonly string[],
  settings: SettingsSnapshot = defaultSettings()
): FilterEngine {
  return new FilterEngine({ lists, getSettings: () => settings })
}

function context(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    url: 'https://example.com/',
    resourceType: 'script',
    documentUrl: 'https://news.example.org/article',
    method: 'GET',
    settings: defaultSettings(),
    ...overrides
  }
}

describe('FilterEngine network matching', () => {
  const engine = engineFor([EASYLIST_SLICE])

  it('blocks what the lists ask it to', () => {
    expect(engine.matches(context({ url: 'https://ad.doubleclick.net/ddm/x' }))).toBe(true)
  })

  it('leaves an ordinary request alone', () => {
    expect(engine.matches(context({ url: 'https://en.wikipedia.org/wiki/Berlin' }))).toBe(false)
  })

  it('translates Electron’s resource names into the list vocabulary', () => {
    // `/2x2.gif?$image` is scoped to images, and Electron calls that `image`.
    const url = 'https://cdn.example.org/2x2.gif?id=1'
    expect(engine.matches(context({ url, resourceType: 'image' }))).toBe(true)
    expect(engine.matches(context({ url, resourceType: 'script' }))).toBe(false)
  })

  it('treats a resource name it has never seen as `other` rather than guessing', () => {
    // A rule with no type restriction still applies; a type-scoped one does not.
    expect(
      engine.matches(context({ url: 'https://ad.doubleclick.net/x', resourceType: 'somethingNew' }))
    ).toBe(true)
    expect(
      engine.matches(
        context({ url: 'https://cdn.example.org/2x2.gif?id=1', resourceType: 'somethingNew' })
      )
    ).toBe(false)
  })

  it('passes the document URL through, so party rules work', () => {
    const url = 'https://t.0emm.com/pixel.gif'
    expect(engine.matches(context({ url, resourceType: 'image' }))).toBe(true)
    expect(
      engine.matches(context({ url, resourceType: 'image', documentUrl: 'https://www.0emm.com/' }))
    ).toBe(false)
  })

  it('tolerates a request with no owning document', () => {
    expect(
      engine.matches(context({ url: 'https://ad.doubleclick.net/x', documentUrl: null }))
    ).toBe(true)
  })

  it('does not consult privacy.blockerEnabled, which the stage already checks', () => {
    // Checking it twice would make it ambiguous which check governs.
    const off = engineFor([EASYLIST_SLICE], withSettings({ 'privacy.blockerEnabled': false }))
    expect(off.matches(context({ url: 'https://ad.doubleclick.net/x' }))).toBe(true)
  })
})

describe('FilterEngine diagnostics', () => {
  const engine = engineFor([EASYLIST_SLICE])

  it('reports how much of the list it declined, and why', () => {
    // The honest half of a hand-written engine: `$popup` is skipped, and the count
    // is what stops that being invisible.
    expect(engine.diagnostics.unsupported).toBe(1)
    expect(engine.diagnostics.unsupportedByReason).toEqual({ 'unsupported-option:popup': 1 })
  })

  it('reports how many rules it holds', () => {
    expect(engine.networkRuleCount).toBe(4)
    expect(engine.cosmeticRuleCount).toBe(2)
  })

  it('adds up diagnostics across every configured list', () => {
    const two = engineFor([EASYLIST_SLICE, '&popunder=$popup\n||ad.linksynergy.com^'])
    expect(two.diagnostics.unsupportedByReason).toEqual({ 'unsupported-option:popup': 2 })
    expect(two.networkRuleCount).toBe(5)
  })
})

describe('FilterEngine cosmetic queries', () => {
  const engine = engineFor([EASYLIST_SLICE])

  it('answers with the host’s own selectors and the generic ones apart', () => {
    const selectors = engine.cosmeticSelectorsFor('https://uk.advfn.com/quote')
    expect(selectors.specific).toEqual(['#APS_300_X_600'])
    expect(selectors.generic).toEqual(['#AC_ad'])
  })

  it('builds a stylesheet from the host-specific half only', () => {
    // The generic half is 28 916 selectors from the default lists; putting it on
    // every page is a decision for the injector, not for this class.
    expect(engine.cosmeticStylesFor('https://uk.advfn.com/quote')).toBe(
      '#APS_300_X_600 { display: none !important; }'
    )
  })

  it('returns no stylesheet for a host with no rules of its own', () => {
    expect(engine.cosmeticStylesFor('https://en.wikipedia.org/wiki/Berlin')).toBeNull()
  })

  it('honours privacy.cosmeticFiltering, which nothing else is placed to check', () => {
    const off = engineFor([EASYLIST_SLICE], withSettings({ 'privacy.cosmeticFiltering': false }))
    expect(off.cosmeticStylesFor('https://uk.advfn.com/quote')).toBeNull()
    expect(off.cosmeticSelectorsFor('https://uk.advfn.com/quote')).toEqual({
      specific: [],
      generic: []
    })
  })

  it('answers with nothing for a document that has no host', () => {
    expect(engine.cosmeticSelectorsFor('about:blank')).toEqual({ specific: [], generic: [] })
    expect(engine.cosmeticStylesFor('not a url')).toBeNull()
  })
})

describe('FilterEngine.replaceLists', () => {
  it('recompiles in place, so the pipeline’s single listener stays installed', () => {
    // `privacy.blockerLists` applies live. Reinstalling the pipeline to pick up a
    // new list would silently replace its `webRequest` listener, which is the
    // failure `RequestPipeline` exists to prevent.
    const engine = engineFor([EASYLIST_SLICE])
    expect(engine.matches(context({ url: 'https://ad.doubleclick.net/x' }))).toBe(true)

    engine.replaceLists(['||ad.linksynergy.com^'])
    expect(engine.matches(context({ url: 'https://ad.doubleclick.net/x' }))).toBe(false)
    expect(engine.matches(context({ url: 'https://ad.linksynergy.com/x' }))).toBe(true)
    expect(engine.networkRuleCount).toBe(1)
  })

  it('can be emptied', () => {
    const engine = engineFor([EASYLIST_SLICE])
    engine.replaceLists([])
    expect(engine.networkRuleCount).toBe(0)
    expect(engine.diagnostics.lines).toBe(0)
  })
})

async function tempDirectory(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), 'tessera-filters-')), FILTER_LIST_CACHE_DIRNAME)
}

interface Harness {
  readonly directory: string
  readonly store: FilterListStore
  readonly fetchList: ReturnType<typeof vi.fn>
  setNow(value: number): void
}

async function harness(
  bodies: Record<string, string>,
  options: { maxAgeMs?: number } = {}
): Promise<Harness> {
  const directory = await tempDirectory()
  let now = 1_000_000
  const fetchList = vi.fn((url: string): Promise<string> => {
    const body = bodies[url]
    return body === undefined
      ? Promise.reject(new Error(`no stub for ${url}`))
      : Promise.resolve(body)
  })
  const store = new FilterListStore({
    directory,
    fetchList,
    now: () => now,
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs })
  })
  return {
    directory,
    store,
    fetchList,
    setNow: (value) => {
      now = value
    }
  }
}

const LIST_URL = 'https://easylist.to/easylist/easylist.txt'
const PRIVACY_URL = 'https://easylist.to/easylist/easyprivacy.txt'

describe('FilterListStore', () => {
  it('has nothing to load before the first refresh', async () => {
    const { store } = await harness({})
    expect(await store.load([LIST_URL])).toEqual([])
  })

  it('downloads a configured list and serves it from the cache afterwards', async () => {
    const { store, fetchList } = await harness({ [LIST_URL]: EASYLIST_SLICE })

    expect(await store.refresh([LIST_URL])).toEqual([
      { url: LIST_URL, status: 'fetched', reason: null }
    ])
    expect(fetchList).toHaveBeenCalledTimes(1)

    const cached = await store.load([LIST_URL])
    expect(cached).toHaveLength(1)
    expect(cached[0]!.text).toBe(EASYLIST_SLICE)
    expect(cached[0]!.fetchedAt).toBe(1_000_000)
    // Loading reads the cache, never the network — spec 4 forbids a third-party
    // request per use.
    expect(fetchList).toHaveBeenCalledTimes(1)
  })

  it('keeps a copy that is still young rather than fetching again', async () => {
    const { store, fetchList, setNow } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await store.refresh([LIST_URL])

    setNow(1_000_000 + DEFAULT_LIST_MAX_AGE_MS - 1)
    expect(await store.refresh([LIST_URL])).toEqual([
      { url: LIST_URL, status: 'fresh', reason: null }
    ])
    expect(fetchList).toHaveBeenCalledTimes(1)
  })

  it('fetches again once the copy is older than the maximum age', async () => {
    const { store, fetchList, setNow } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await store.refresh([LIST_URL])

    setNow(1_000_000 + DEFAULT_LIST_MAX_AGE_MS)
    expect(await store.refresh([LIST_URL])).toEqual([
      { url: LIST_URL, status: 'fetched', reason: null }
    ])
    expect(fetchList).toHaveBeenCalledTimes(2)
  })

  it('honours a maximum age the caller chose', async () => {
    const { store, fetchList, setNow } = await harness(
      { [LIST_URL]: EASYLIST_SLICE },
      { maxAgeMs: 10 }
    )
    await store.refresh([LIST_URL])
    setNow(1_000_011)
    await store.refresh([LIST_URL])
    expect(fetchList).toHaveBeenCalledTimes(2)
  })

  it('keeps the copy on disk when a download fails', async () => {
    // A browser with a stale list still blocks; a browser with no list does not.
    const { store, directory } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await store.refresh([LIST_URL])

    const stale = 1_000_000 + DEFAULT_LIST_MAX_AGE_MS
    const offline = new FilterListStore({
      directory,
      fetchList: () => Promise.reject(new Error('offline')),
      now: () => stale
    })
    expect(await offline.refresh([LIST_URL])).toEqual([
      { url: LIST_URL, status: 'failed', reason: 'offline' }
    ])
    expect(await offline.load([LIST_URL])).toHaveLength(1)
  })

  it('reports a failure for a list it never had', async () => {
    const { store } = await harness({})
    expect(await store.refresh([LIST_URL])).toEqual([
      { url: LIST_URL, status: 'failed', reason: `no stub for ${LIST_URL}` }
    ])
    expect(await store.load([LIST_URL])).toEqual([])
  })

  it('describes a rejection that is not an Error', async () => {
    const { directory } = await harness({})
    // Not an Error, so `messageOf` has to describe it rather than read `.message`.
    const store = new FilterListStore({
      directory,
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the point of the test
      fetchList: () => Promise.reject('connection reset'),
      now: () => 0
    })
    expect((await store.refresh([LIST_URL]))[0]!.reason).toBe('connection reset')
  })

  it('keeps several lists apart', async () => {
    const { store } = await harness({
      [LIST_URL]: EASYLIST_SLICE,
      [PRIVACY_URL]: '||0emm.com^$third-party'
    })
    await store.refresh([LIST_URL, PRIVACY_URL])

    const cached = await store.load([PRIVACY_URL, LIST_URL])
    // Returned in the order asked for, so list precedence stays the user's.
    expect(cached.map((list) => list.url)).toEqual([PRIVACY_URL, LIST_URL])
  })

  it('names cache files after their host, for a legible cache directory', async () => {
    const { store, directory } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await store.refresh([LIST_URL])
    const names = (await readdir(directory)).filter((name) => name.endsWith('.txt'))
    expect(names).toHaveLength(1)
    expect(names[0]).toMatch(/^easylist\.to-[0-9a-f]{16}\.txt$/)
  })

  it('falls back to a neutral name when the URL has no host to use', async () => {
    const { directory } = await harness({})
    const store = new FilterListStore({
      directory,
      fetchList: () => Promise.resolve('||ad.doubleclick.net^'),
      now: () => 0
    })
    await store.refresh(['file:///srv/lists/custom.txt', 'not a url'])
    const names = (await readdir(directory)).filter((name) => name.endsWith('.txt')).sort()
    expect(names).toHaveLength(2)
    expect(names.every((name) => name.startsWith('list-'))).toBe(true)
  })

  it('skips a manifest entry whose file has been deleted', async () => {
    // The cache is discardable by design, so a missing file is an absent list
    // rather than an error.
    const { store, directory } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await store.refresh([LIST_URL])
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({
      ...manifest,
      [PRIVACY_URL]: { file: 'gone.txt', fetchedAt: 1 }
    }))
    expect((await store.load([PRIVACY_URL, LIST_URL])).map((list) => list.url)).toEqual([LIST_URL])
  })

  it('treats an unreadable manifest as an empty cache rather than failing to start', async () => {
    const { store, directory } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'manifest.json'), '{ not json')
    expect(await store.load([LIST_URL])).toEqual([])

    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ [LIST_URL]: 'wrong shape' }))
    expect(await store.load([LIST_URL])).toEqual([])

    // And it recovers: the next refresh simply downloads.
    expect((await store.refresh([LIST_URL]))[0]!.status).toBe('fetched')
  })

  it('drops the file of a list the user has removed', async () => {
    const { store, directory } = await harness({
      [LIST_URL]: EASYLIST_SLICE,
      [PRIVACY_URL]: '||0emm.com^$third-party'
    })
    await store.refresh([LIST_URL, PRIVACY_URL])
    expect((await readdir(directory)).filter((name) => name.endsWith('.txt'))).toHaveLength(2)

    await store.refresh([LIST_URL])
    expect((await readdir(directory)).filter((name) => name.endsWith('.txt'))).toHaveLength(1)
    expect(await store.load([PRIVACY_URL])).toEqual([])
  })

  it('leaves something in the cache directory it cannot remove', async () => {
    // Failing a refresh over an unexpected entry would be worse than ignoring it.
    const { store, directory } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await mkdir(join(directory, 'not-a-list'), { recursive: true })
    expect((await store.refresh([LIST_URL]))[0]!.status).toBe('fetched')
    expect(await readdir(directory)).toContain('not-a-list')
  })

  it('feeds the engine straight from the cache', async () => {
    const { store } = await harness({ [LIST_URL]: EASYLIST_SLICE })
    await store.refresh([LIST_URL])
    const cached = await store.load([LIST_URL])
    const engine = engineFor(cached.map((list) => list.text))
    expect(engine.matches(context({ url: 'https://ad.doubleclick.net/x' }))).toBe(true)
  })
})
