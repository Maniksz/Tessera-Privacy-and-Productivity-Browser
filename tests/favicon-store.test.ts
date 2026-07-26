import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FaviconStore, type FaviconFetcher } from '@main/data/FaviconStore.js'
import { plainJsonDocumentCodec } from '@main/data/JsonStore.js'
import {
  MAX_FAVICON_BYTES,
  discardingFaviconCache,
  type FaviconEntry,
  type FaviconIndex
} from '@shared/favicons/model.js'

/**
 * The favicon store: the one request per site, what it refuses, and who may write.
 *
 * Nothing here touches the network or the real clock. The fetcher is injected, which is
 * the same seam that keeps Electron's session-bound retrieval — and therefore the proxy,
 * the DNS settings and the kill switch — in the picture in production; a test that
 * reached the network would be testing the leak instead of the feature.
 *
 * Assertions about "nothing was stored" read the directory rather than trusting the
 * in-memory answer, because the trace a private window must not leave is on disk.
 */

const T0 = 1_700_000_000_000
const PAGE = 'https://www.example.com/some/article'
const ICON = 'https://www.example.com/favicon.ico'
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

type Responder = (url: string) => Response | Promise<Response>

function pngBytes(length = 64): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set(PNG_SIGNATURE, 0)
  // A recognisable tail, so a test can tell one body from another on disk.
  bytes.set([length & 0xff], length - 1)
  return bytes
}

function imageResponse(bytes: Uint8Array, init: ResponseInit = {}): Response {
  return new Response(bytes, { headers: { 'content-type': 'image/png' }, ...init })
}

interface Harness {
  store: FaviconStore
  directory: string
  /** Every address the store asked for, in order. */
  requests: string[]
  answer(responder: Responder): void
  tick(ms: number): void
}

async function harness(
  options: { maxAgeMs?: number; maxEntries?: number; directory?: string } = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'tessera-favicons-'))
  const directory = options.directory ?? join(root, 'favicons')
  const requests: string[] = []
  let responder: Responder = () => imageResponse(pngBytes())
  let clock = T0

  const fetcher: FaviconFetcher = (url) => {
    requests.push(url)
    return Promise.resolve(responder(url))
  }

  const store = await FaviconStore.open({
    directory,
    fetch: fetcher,
    now: () => clock,
    // No debounce: the assertions read the file straight after a write.
    debounceMs: 0,
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries })
  })

  return {
    store,
    directory,
    requests,
    answer: (next) => {
      responder = next
    },
    tick: (ms) => {
      clock += ms
    }
  }
}

async function storedIcons(directory: string): Promise<FaviconEntry[]> {
  const text = await readFile(join(directory, 'index.json'), 'utf8')
  return (JSON.parse(text) as FaviconIndex).icons
}

/**
 * Where a site's icon lives, derived the same way the store derives it.
 *
 * Restated here rather than imported, because the store keeps it private on purpose: the path must
 * come from the key and never from the index, so that a corrupted index cannot point the protocol
 * handler at a file outside the directory. A test that read the store's own answer would confirm
 * only that the store agrees with itself. The assertion further down that the name is a hash and
 * not the domain is what keeps this copy honest.
 */
function iconPath(directory: string, domain: string): string {
  const digest = createHash('sha256').update(domain.toLowerCase(), 'utf8').digest('hex')
  return join(directory, `${digest.slice(0, 32)}.icon`)
}

describe('retrieving an icon', () => {
  it('takes it from the site itself, once, and puts it on disk', async () => {
    const h = await harness()
    const outcome = await h.store.cacheFor('normal').ensure(PAGE, [ICON])

    expect(outcome).toEqual({
      kind: 'stored',
      entry: {
        domain: 'example.com',
        contentType: 'image/png',
        byteLength: 64,
        fetchedAt: T0,
        sourceUrl: ICON
      }
    })
    // The site, not a favicon service.
    expect(h.requests).toEqual([ICON])

    const file = iconPath(h.directory, 'example.com')
    expect(new Uint8Array(await readFile(file))).toEqual(pngBytes())

    await h.store.flush()
    expect((await storedIcons(h.directory)).map((icon) => icon.domain)).toEqual(['example.com'])
    expect(h.store.counts).toMatchObject({ requests: 1, stored: 1, reused: 0, kept: 0 })
  })

  it('asks for nothing the second time', async () => {
    const h = await harness()
    const cache = h.store.cacheFor('normal')
    const first = await cache.ensure(PAGE, [ICON])
    const second = await cache.ensure('https://www.example.com/another', [ICON])

    expect(second.kind).toBe('cached')
    expect(second).toEqual({ kind: 'cached', entry: h.store.find('example.com')?.entry })
    expect(first.kind).toBe('stored')
    // The requirement, measured: one request for the site, no matter how many pages.
    expect(h.requests).toEqual([ICON])
    expect(h.store.counts.reused).toBe(1)
  })

  it('shares one entry across subdomains', async () => {
    const h = await harness()
    const cache = h.store.cacheFor('normal')
    await cache.ensure('https://www.example.com/', ['https://www.example.com/favicon.ico'])
    const outcome = await cache.ensure('https://blog.example.com/post', [
      'https://blog.example.com/favicon.ico'
    ])

    expect(outcome.kind).toBe('cached')
    expect(h.requests).toHaveLength(1)
    // One file, keyed on the site, not one per host and certainly not one per page.
    expect(h.store.list()).toHaveLength(1)
  })

  it('follows the largest useful candidate the page declared', async () => {
    const h = await harness()
    await h.store
      .cacheFor('normal')
      .ensure(PAGE, [
        'https://www.example.com/favicon-16x16.png',
        'https://www.example.com/favicon.ico',
        'https://www.example.com/apple-touch-icon.png',
        'https://www.example.com/icon-1024.png'
      ])

    // A start-page card draws at around 48 px, so the 180 px touch icon is the useful
    // one; the 1024 px candidate would probably blow the byte cap and there is only one
    // request to spend.
    expect(h.requests).toEqual(['https://www.example.com/apple-touch-icon.png'])
  })

  it('serves one request when two tiles ask at the same moment', async () => {
    const h = await harness()
    let release: (response: Response) => void = () => {}
    h.answer(() => new Promise<Response>((resolve) => (release = resolve)))

    const cache = h.store.cacheFor('normal')
    const first = cache.ensure(PAGE, [ICON])
    const second = cache.ensure('https://www.example.com/other', [ICON])
    release(imageResponse(pngBytes()))

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(h.requests).toHaveLength(1)
  })
})

describe('refusing what came back', () => {
  it('refuses a page pretending to be an icon', async () => {
    const h = await harness()
    h.answer(() =>
      new Response('<!doctype html><title>Not found</title>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      })
    )

    const outcome = await h.store.cacheFor('normal').ensure(PAGE, [ICON])
    expect(outcome).toEqual({ kind: 'rejected', reason: 'unsupported-type' })
    // Counted, not swallowed: "no icon" and "refused eleven times" need different fixes.
    expect(h.store.counts.rejected['unsupported-type']).toBe(1)
    expect(h.store.list()).toEqual([])
    expect(existsSync(iconPath(h.directory, 'example.com'))).toBe(false)
  })

  it('refuses bytes that are not an image whatever the header claimed', async () => {
    const h = await harness()
    // The header says PNG; the body is an error page. This is the case a header check
    // alone would store and then serve inside the browser's own interface.
    h.answer(() =>
      new Response(new TextEncoder().encode('<html>error</html>'), {
        headers: { 'content-type': 'image/png' }
      })
    )

    expect(await h.store.cacheFor('normal').ensure(PAGE, [ICON])).toEqual({
      kind: 'rejected',
      reason: 'unsupported-type'
    })
  })

  it('refuses an SVG, which no signature can match', async () => {
    const h = await harness()
    h.answer(() =>
      new Response(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), {
        headers: { 'content-type': 'image/svg+xml' }
      })
    )

    expect(await h.store.cacheFor('normal').ensure(PAGE, [ICON])).toEqual({
      kind: 'rejected',
      reason: 'unsupported-type'
    })
  })

  it('refuses an image past the size cap', async () => {
    const h = await harness()
    h.answer(() => imageResponse(pngBytes(MAX_FAVICON_BYTES + 1)))

    expect(await h.store.cacheFor('normal').ensure(PAGE, [ICON])).toEqual({
      kind: 'rejected',
      reason: 'too-large'
    })
    expect(h.store.counts.rejected['too-large']).toBe(1)
  })

  it('refuses on a claimed size before reading the body', async () => {
    const h = await harness()
    // The body would pass on its own, so a `too-large` answer proves the claimed length
    // was checked first — which is the point of checking it at all.
    h.answer(() =>
      imageResponse(pngBytes(), { headers: { 'content-type': 'image/png', 'content-length': '9999999' } })
    )

    expect(await h.store.cacheFor('normal').ensure(PAGE, [ICON])).toEqual({
      kind: 'rejected',
      reason: 'too-large'
    })
  })

  it('accepts an honest claimed size and a response that declares no type', async () => {
    const h = await harness()
    // Both are the common shape for a real `.ico`: no content type, a correct length.
    h.answer(() => new Response(pngBytes(), { headers: { 'content-length': '64' } }))

    const outcome = await h.store.cacheFor('normal').ensure(PAGE, [ICON])
    expect(outcome.kind).toBe('stored')
  })

  it('refuses an HTTP error', async () => {
    const h = await harness()
    h.answer(() => new Response('gone', { status: 404 }))

    expect(await h.store.cacheFor('normal').ensure(PAGE, [ICON])).toEqual({
      kind: 'rejected',
      reason: 'http-error'
    })
    expect(h.store.counts.rejected['http-error']).toBe(1)
  })

  it('refuses a request that never arrived', async () => {
    const h = await harness()
    h.answer(() => Promise.reject(new Error('ECONNREFUSED')))

    expect(await h.store.cacheFor('normal').ensure(PAGE, [ICON])).toEqual({
      kind: 'rejected',
      reason: 'network-error'
    })
    expect(h.store.counts.rejected['network-error']).toBe(1)
  })

  it('asks a site with a broken icon only once per run', async () => {
    const h = await harness()
    h.answer(() => new Response('nope', { status: 500 }))
    const cache = h.store.cacheFor('normal')

    await cache.ensure(PAGE, [ICON])
    const second = await cache.ensure('https://www.example.com/other', [ICON])

    expect(second).toEqual({ kind: 'rejected', reason: 'already-tried' })
    // Otherwise every navigation on the site would repeat the failure.
    expect(h.requests).toHaveLength(1)
  })

  it('makes no request for a page that has no site', async () => {
    const h = await harness()
    expect(await h.store.cacheFor('normal').ensure('tessera://start', [ICON])).toEqual({
      kind: 'rejected',
      reason: 'not-a-site'
    })
    expect(h.requests).toEqual([])
    expect(h.store.counts.requests).toBe(0)
  })

  it('makes no request when the page declares nothing it may follow', async () => {
    const h = await harness()
    expect(
      await h.store.cacheFor('normal').ensure(PAGE, ['data:image/png;base64,iVBORw0KGgo='])
    ).toEqual({ kind: 'rejected', reason: 'no-candidate' })
    expect(h.requests).toEqual([])
  })

  it('reports a cache it cannot write to instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-favicons-'))
    // A file where the directory should be: the cache cannot be created at all.
    await writeFile(join(root, 'blocked'), 'not a directory', 'utf8')
    const h = await harness({ directory: join(root, 'blocked', 'favicons') })

    expect(await h.store.cacheFor('normal').ensure(PAGE, [ICON])).toEqual({
      kind: 'rejected',
      reason: 'write-failed'
    })
    // No index entry, because there is no file for it to describe.
    expect(h.store.list()).toEqual([])
  })
})

describe('aging', () => {
  it('retrieves again once the icon is old, and replaces the file', async () => {
    const h = await harness({ maxAgeMs: 1_000 })
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])

    h.tick(1_000)
    h.answer(() => imageResponse(pngBytes(80)))
    const outcome = await cache.ensure(PAGE, [ICON])

    expect(outcome).toMatchObject({ kind: 'stored', entry: { byteLength: 80, fetchedAt: T0 + 1_000 } })
    expect(h.requests).toHaveLength(2)
    expect(new Uint8Array(await readFile(iconPath(h.directory, 'example.com')))).toEqual(pngBytes(80))
    // Still one entry: a refresh replaces, it does not accumulate.
    expect(h.store.list()).toHaveLength(1)
  })

  it('keeps the previous copy when the refresh fails', async () => {
    const h = await harness({ maxAgeMs: 1_000 })
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])

    h.tick(1_000)
    h.answer(() => new Response('down', { status: 503 }))
    const outcome = await cache.ensure(PAGE, [ICON])

    expect(outcome).toEqual({
      kind: 'kept',
      reason: 'http-error',
      entry: {
        domain: 'example.com',
        contentType: 'image/png',
        byteLength: 64,
        fetchedAt: T0,
        sourceUrl: ICON
      }
    })
    // A CDN blinking must not make the icon disappear from a site the user has had for a
    // month, so both the file and the entry stand.
    expect(new Uint8Array(await readFile(iconPath(h.directory, 'example.com')))).toEqual(pngBytes())
    await h.store.flush()
    expect((await storedIcons(h.directory)).at(0)?.fetchedAt).toBe(T0)
    expect(h.store.counts.kept).toBe(1)
  })

  it('keeps the previous copy when a stale page declares no candidate any more', async () => {
    const h = await harness({ maxAgeMs: 1_000 })
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])

    h.tick(1_000)
    const outcome = await cache.ensure(PAGE, [])
    expect(outcome).toMatchObject({ kind: 'kept', reason: 'no-candidate' })
    expect(h.requests).toHaveLength(1)
  })

  it('keeps the previous copy on a later visit in the same run', async () => {
    const h = await harness({ maxAgeMs: 1_000 })
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])

    h.tick(1_000)
    h.answer(() => Promise.reject(new Error('ENOTFOUND')))
    await cache.ensure(PAGE, [ICON])
    const third = await cache.ensure(PAGE, [ICON])

    expect(third).toMatchObject({ kind: 'kept', reason: 'already-tried' })
    expect(h.requests).toHaveLength(2)
  })
})

describe('a private window', () => {
  it('is handed a cache that holds no store at all', async () => {
    // The structural half of the guarantee: not a bound closure with a flag, but an
    // object with no directory, no index and no fetcher.
    const h = await harness()
    expect(h.store.cacheFor('private')).toBe(discardingFaviconCache)
  })

  it('leaves nothing in the index, nothing on disk and makes no request', async () => {
    const h = await harness()
    const cache = h.store.cacheFor('private')

    expect(await cache.ensure('https://secret.example/', ['https://secret.example/favicon.ico'])).toEqual(
      { kind: 'rejected', reason: 'private-mode' }
    )
    await cache.ensure('https://secret.example/page', ['https://secret.example/icon.png'])

    expect(h.requests).toEqual([])
    expect(h.store.list()).toEqual([])
    // Not merely empty: the cache directory was never created, so there is no index file
    // recording which sites were visited either.
    expect(existsSync(h.directory)).toBe(false)
    // And the store counted nothing, because it was never told — which is the invariant.
    expect(h.store.counts.requests).toBe(0)
    expect(h.store.counts.rejected['private-mode']).toBe(0)
  })

  it('does not stop a normal window from caching the same site', async () => {
    const h = await harness()
    await h.store.cacheFor('private').ensure(PAGE, [ICON])
    const outcome = await h.store.cacheFor('normal').ensure(PAGE, [ICON])

    expect(outcome.kind).toBe('stored')
    expect(h.requests).toEqual([ICON])
  })

  it('still shows an icon the cache already has', async () => {
    // Reading leaves no trace, and blank icons in a private window would be a cost with
    // no benefit — which is why `find` is deliberately not behind `cacheFor`.
    const h = await harness()
    await h.store.cacheFor('normal').ensure(PAGE, [ICON])
    expect(h.store.find('https://www.example.com/anything')?.entry.domain).toBe('example.com')
  })
})

describe('what the renderer asks for', () => {
  it('finds a site by address or by domain, and says where the bytes are', async () => {
    const h = await harness()
    await h.store.cacheFor('normal').ensure(PAGE, [ICON])

    const found = h.store.find('example.com')
    expect(found?.entry.contentType).toBe('image/png')
    expect(found?.filePath).toBe(iconPath(h.directory, 'example.com'))
    expect(h.store.find('https://blog.example.com/x')?.filePath).toBe(found?.filePath)
    expect(h.store.find('other.org')).toBeNull()
  })

  it('cannot be steered outside the cache directory', async () => {
    const h = await harness()
    await h.store.cacheFor('normal').ensure(PAGE, [ICON])
    // The key is compared against the index and never joined into a path.
    expect(h.store.find('../../etc/passwd')).toBeNull()
    expect(h.store.find('')).toBeNull()
  })

  it('tells listeners when an icon arrives, until they unsubscribe', async () => {
    const h = await harness()
    const seen: number[] = []
    const unsubscribe = h.store.onChange((icons) => seen.push(icons.length))

    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])
    unsubscribe()
    await cache.ensure('https://other.org/', ['https://other.org/favicon.ico'])

    expect(seen).toEqual([1])
  })

  it('hands out copies, so a caller cannot edit the index', async () => {
    const h = await harness()
    await h.store.cacheFor('normal').ensure(PAGE, [ICON])
    h.store.list().length = 0
    expect(h.store.list()).toHaveLength(1)
    const counts = h.store.counts
    counts.requests = 99
    counts.rejected['http-error'] = 99
    expect(h.store.counts.requests).toBe(1)
    expect(h.store.counts.rejected['http-error']).toBe(0)
  })
})

describe('bounding the cache', () => {
  it('evicts the least recently retrieved site and deletes its file', async () => {
    const h = await harness({ maxEntries: 1 })
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])
    h.tick(1_000)
    await cache.ensure('https://other.org/', ['https://other.org/favicon.ico'])

    expect(h.store.list().map((icon) => icon.domain)).toEqual(['other.org'])
    // The file goes with the entry; an index that forgot it would leave it there forever.
    expect(existsSync(iconPath(h.directory, 'example.com'))).toBe(false)
    expect(existsSync(iconPath(h.directory, 'other.org'))).toBe(true)
  })

  it('drops the entry even when the file cannot be deleted', async () => {
    const h = await harness({ maxEntries: 1 })
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])

    // A directory where the icon was: deletion fails, and the entry must still go —
    // keeping it is what would stop the site ever being asked again.
    const path = iconPath(h.directory, 'example.com')
    await rm(path)
    await mkdir(path)

    h.tick(1_000)
    await cache.ensure('https://other.org/', ['https://other.org/favicon.ico'])
    expect(h.store.list().map((icon) => icon.domain)).toEqual(['other.org'])
  })

  it('clears every icon and the index, which is what clearing the cache on exit does', async () => {
    const h = await harness()
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])
    await cache.ensure('https://other.org/', ['https://other.org/favicon.ico'])

    expect(await h.store.clear()).toBe(2)
    expect(h.store.list()).toEqual([])
    expect(existsSync(iconPath(h.directory, 'example.com'))).toBe(false)
    expect(existsSync(iconPath(h.directory, 'other.org'))).toBe(false)

    // Awaited on purpose: work started at exit but not awaited runs into nothing.
    await h.store.flush()
    expect(await storedIcons(h.directory)).toEqual([])
  })

  it('clears the record of failures, so the next run asks again', async () => {
    const h = await harness()
    h.answer(() => new Response('nope', { status: 500 }))
    const cache = h.store.cacheFor('normal')
    await cache.ensure(PAGE, [ICON])

    expect(await h.store.clear()).toBe(0)
    h.answer(() => imageResponse(pngBytes()))
    expect((await cache.ensure(PAGE, [ICON])).kind).toBe('stored')
    expect(h.requests).toHaveLength(2)
  })
})

describe('on disk', () => {
  it('reads back what a previous run wrote, and asks for nothing', async () => {
    const h = await harness()
    await h.store.cacheFor('normal').ensure(PAGE, [ICON])
    await h.store.flush()

    const requests: string[] = []
    const restarted = await FaviconStore.open({
      directory: h.directory,
      fetch: (url) => {
        requests.push(url)
        return Promise.resolve(imageResponse(pngBytes()))
      },
      now: () => T0,
      debounceMs: 0
    })

    expect(restarted.find('example.com')?.entry.byteLength).toBe(64)
    expect((await restarted.cacheFor('normal').ensure(PAGE, [ICON])).kind).toBe('cached')
    expect(requests).toEqual([])
    expect(restarted.recoveredFromInvalidFile).toBe(false)
  })

  it('works through an injected codec', async () => {
    // The seam encryption at rest uses. The index names visited sites, so it is local
    // data in the sense spec 3 means, discardable directory or not.
    const root = await mkdtemp(join(tmpdir(), 'tessera-favicons-'))
    const directory = join(root, 'favicons')
    const fetcher: FaviconFetcher = () => Promise.resolve(imageResponse(pngBytes()))

    const store = await FaviconStore.open({
      directory,
      fetch: fetcher,
      codec: plainJsonDocumentCodec,
      debounceMs: 0
    })
    await store.cacheFor('normal').ensure(PAGE, [ICON])
    await store.flush()

    const restarted = await FaviconStore.open({
      directory,
      fetch: fetcher,
      codec: plainJsonDocumentCodec,
      debounceMs: 0
    })
    expect(restarted.list()).toHaveLength(1)
  })

  it('uses the real clock and the default debounce when neither is given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-favicons-'))
    const directory = join(root, 'favicons')
    const before = Date.now()
    const store = await FaviconStore.open({
      directory,
      fetch: () => Promise.resolve(imageResponse(pngBytes()))
    })
    await store.cacheFor('normal').ensure(PAGE, [ICON])

    const entry = store.find('example.com')?.entry
    expect(entry?.fetchedAt).toBeGreaterThanOrEqual(before)
    expect(entry?.fetchedAt).toBeLessThanOrEqual(Date.now())

    // `flush` exists so a pending debounced write can be forced and awaited.
    await store.flush()
    expect(await storedIcons(directory)).toHaveLength(1)
  })

  it('merges duplicate entries a hand-edited index left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-favicons-'))
    const directory = join(root, 'favicons')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'index.json'),
      JSON.stringify({
        version: 1,
        icons: [
          { domain: 'example.com', contentType: 'image/png', byteLength: 10, fetchedAt: T0, sourceUrl: ICON },
          { domain: 'example.com', contentType: 'image/gif', byteLength: 20, fetchedAt: T0 + 5, sourceUrl: ICON }
        ]
      }),
      'utf8'
    )

    const store = await FaviconStore.open({
      directory,
      fetch: () => Promise.resolve(imageResponse(pngBytes())),
      debounceMs: 0
    })
    // The newer entry wins: it describes the bytes actually in the file, since both
    // entries name the same one.
    expect(store.list()).toEqual([
      { domain: 'example.com', contentType: 'image/gif', byteLength: 20, fetchedAt: T0 + 5, sourceUrl: ICON }
    ])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('starts from an empty index when the file is not ours', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-favicons-'))
    const directory = join(root, 'favicons')
    await mkdir(directory, { recursive: true })
    // A format this build does not serve. Discarding the index costs one request per
    // site and nothing the user typed, which is why the schema is free to be strict.
    await writeFile(
      join(directory, 'index.json'),
      JSON.stringify({
        version: 1,
        icons: [{ domain: 'example.com', contentType: 'image/svg+xml', byteLength: 10, fetchedAt: T0, sourceUrl: ICON }]
      }),
      'utf8'
    )

    const store = await FaviconStore.open({
      directory,
      fetch: () => Promise.resolve(imageResponse(pngBytes())),
      now: () => T0,
      debounceMs: 0
    })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)

    // And the recovered store is usable, not wedged.
    expect((await store.cacheFor('normal').ensure(PAGE, [ICON])).kind).toBe('stored')
  })
})

describe('the retrieval seam', () => {
  it('has no fallback to a fetcher that would bypass the session', async () => {
    /*
      A fitness function, not a behaviour test. Node's global retrieval function is
      always in scope and ignores the browsing session entirely — no proxy, no DNS
      settings, no request pipeline, no kill switch — so an optional parameter with a
      global default would make the leaking version the one you get by forgetting.
      The type system already refuses a missing fetcher; this refuses a default being
      added later.
    */
    const source = await readFile(
      join(process.cwd(), 'src/main/data/FaviconStore.ts'),
      'utf8'
    )
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

    expect(code, 'the fetcher is optional').not.toMatch(/fetch\?\s*:/)
    expect(code, 'the fetcher falls back to a global').not.toMatch(/\?\?\s*fetch\b/)
    expect(code).not.toMatch(/globalThis\s*\.\s*fetch/)
    // And it is reached through the injected field, never called as a bare global.
    expect(code).not.toMatch(/[^.#\w]fetch\(/)
  })
})

describe('the file a site is stored in', () => {
  /**
   * The file name must not be the secret.
   *
   * The index is encrypted, so reading the list of visited sites needs a key. File names are not —
   * and the name used to be the escaped domain, so `example.com.icon` sat in the directory and a
   * plain listing was a reading list. Encrypting the contents while naming the file after the very
   * thing being protected is the kind of gap that looks like protection and is not.
   */
  it('names the file after a hash, never after the site', async () => {
    const h = await harness()
    await h.store.cacheFor('normal').ensure(PAGE, [ICON])
    await h.store.flush()

    const names = await readdir(h.directory)
    const icons = names.filter((name) => name.endsWith('.icon'))
    expect(icons.length, 'no icon was written, so the check would prove nothing').toBe(1)
    for (const name of icons) {
      expect(name, `${name} names the site`).not.toContain('example')
      expect(name).toMatch(/^[0-9a-f]{32}\.icon$/)
    }
  })

  it('gives two sites two different files', () => {
    // Derived, so no write is needed: two domains sharing a path would mean one site's picture
    // shown under another site's name.
    expect(iconPath('/cache', 'example.com')).not.toBe(iconPath('/cache', 'example.org'))
  })

  it('is unaffected by how the domain is capitalised', () => {
    expect(iconPath('/cache', 'EXAMPLE.com')).toBe(iconPath('/cache', 'example.com'))
  })

  it('never produces a path fragment, whatever the domain looks like', () => {
    // A hash cannot contain a separator, which is the property that replaced the old escaping.
    for (const domain of ['../../etc/passwd', '..\\windows', '::1', 'a/b']) {
      const name = iconPath('/cache', domain).slice('/cache/'.length)
      expect(name, domain).toMatch(/^[0-9a-f]{32}\.icon$/)
    }
  })
})
