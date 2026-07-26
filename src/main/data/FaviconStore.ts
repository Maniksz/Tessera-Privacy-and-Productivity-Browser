import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  FAVICON_CONTENT_TYPES,
  MAX_FAVICON_BYTES,
  MAX_FAVICON_DOMAIN_LENGTH,
  MAX_FAVICON_SOURCE_URL_LENGTH,
  chooseFaviconCandidate,
  declaredLengthOf,
  discardingFaviconCache,
  emptyFaviconCounts,
  emptyFaviconIndex,
  faviconDomainOf,
  faviconIsStale,
  findFaviconEntry,
  looksLikeImageType,
  putFaviconEntry,
  repairFaviconIndex,
  sniffFaviconType,
  type FaviconCache,
  type FaviconContentType,
  type FaviconCounts,
  type FaviconEntry,
  type FaviconIndex,
  type FaviconOutcome,
  type FaviconRejection
} from '@shared/favicons/model.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { BrowsingMode } from './HistoryStore.js'
import { createHash } from 'node:crypto'

/**
 * The local favicon cache (spec 1): one icon per site, taken from the site itself,
 * exactly once.
 *
 * The rules live in `@shared/favicons/model.ts` as pure functions. This class supplies
 * the three things they cannot have and stay testable — the clock, the network and the
 * disk — and decides who is allowed to write, the same division `HistoryStore` uses.
 *
 * Two files make up the cache, both inside `faviconCacheDir()`: one image per site, and
 * an index describing them. The index is what makes "already cached, so no request"
 * answerable without touching the disk, and it is the only place the content type is
 * recorded — the file names deliberately do not say.
 *
 * ## What the index reveals, and why it belongs behind the codec
 *
 * The index lists the sites a user has visited. It is therefore local data in the sense
 * spec 3 means, and the `codec` option exists so the caller can hand it the same
 * encrypted codec the other stores get. The directory being discardable says something
 * about what happens if it is lost, not about who may read it.
 */

/**
 * How bytes are retrieved.
 *
 * Required, with no default, and that is the whole point of the seam. Node's own
 * retrieval function is a global that is always in scope, ignores the browsing session
 * entirely and therefore bypasses the proxy, the DNS settings, the request pipeline and
 * the kill switch — in a privacy browser that is not a rough edge, it is a leak with no
 * indication that it happened. Wiring is expected to pass Electron's session-bound
 * `net.fetch`. An optional parameter with a global fallback would make the leaking
 * version the one you get by forgetting, so there is no fallback to forget into.
 */
export type FaviconFetcher = (url: string) => Promise<Response>

/**
 * What the index file must look like to be usable.
 *
 * Where history heals wrong *amounts* rather than rejecting them, this schema is free to
 * be strict about both: every entry describes bytes that can be retrieved again, so
 * discarding the document costs one request per site and nothing the user typed. That is
 * also why the bounds are here at all — they are assertions that the write path holds,
 * and the write path is what keeps them (`faviconDomainOf` caps the key,
 * `chooseFaviconCandidate` caps the source address, the size check caps the length).
 */
const faviconEntrySchema = z.object({
  domain: z.string().min(1).max(MAX_FAVICON_DOMAIN_LENGTH),
  contentType: z.enum(FAVICON_CONTENT_TYPES),
  byteLength: z.number().int().positive().max(MAX_FAVICON_BYTES),
  fetchedAt: z.number().int().nonnegative(),
  sourceUrl: z.string().min(1).max(MAX_FAVICON_SOURCE_URL_LENGTH)
})

const faviconIndexSchema = z.object({
  version: z.literal(1),
  icons: z.array(faviconEntrySchema)
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — one
 * assignment each way per shape. The schema cannot live next to the interface, because
 * the start page imports the interface and zod must not reach a renderer bundle.
 */
type SchemaEntry = z.output<typeof faviconEntrySchema>
type SchemaIndex = z.output<typeof faviconIndexSchema>

const _entryMatchesModel: SchemaEntry = null as unknown as FaviconEntry
const _modelMatchesEntry: FaviconEntry = null as unknown as SchemaEntry
const _indexMatchesModel: SchemaIndex = null as unknown as FaviconIndex
const _modelMatchesIndex: FaviconIndex = null as unknown as SchemaIndex
void _entryMatchesModel
void _modelMatchesEntry
void _indexMatchesModel
void _modelMatchesIndex

/** The index file's name inside the cache directory. */
const INDEX_FILE_NAME = 'index.json'

export interface FaviconStoreOptions {
  /** The cache directory; `faviconCacheDir()`. Created on the first write. */
  directory: string
  /** See `FaviconFetcher`. Deliberately not optional. */
  fetch: FaviconFetcher
  /** Injected in tests so expiry does not depend on when the test ran. */
  now?: () => number
  /** Overridden in tests; defaults to `FAVICON_MAX_AGE_MS`. */
  maxAgeMs?: number
  /** Overridden in tests; defaults to `MAX_FAVICON_ENTRIES`. */
  maxEntries?: number
  codec?: DocumentCodec
  debounceMs?: number
}

/** An icon and where its bytes are, which is what the protocol handler needs. */
export interface FaviconLookup {
  entry: FaviconEntry
  /** Absolute path, derived from the domain — never taken from the index. */
  filePath: string
}

type Retrieval =
  | { ok: true; bytes: Uint8Array; contentType: FaviconContentType }
  | { ok: false; reason: FaviconRejection }

export class FaviconStore {
  readonly #store: JsonStore<FaviconIndex>
  readonly #directory: string
  readonly #fetch: FaviconFetcher
  readonly #now: () => number
  readonly #maxAgeMs: number | undefined
  readonly #maxEntries: number | undefined
  readonly #counts: FaviconCounts = emptyFaviconCounts()

  /**
   * Sites whose retrieval failed during this run.
   *
   * In memory and not on disk, which is the deliberate part. A site with a broken icon
   * would otherwise be asked again on every single navigation — hundreds of pointless
   * requests to one host — and writing the failure down instead would mean a server
   * that was down for an hour keeps its icon missing for a month. One attempt per run
   * splits the difference, and restarting the browser is the retry.
   */
  readonly #failed = new Set<string>()

  /**
   * Retrievals in progress, keyed by site.
   *
   * Two tiles showing the same site, or a page that reports its icons twice while
   * loading, would otherwise each start a request. They get the same promise instead.
   */
  readonly #inFlight = new Map<string, Promise<FaviconOutcome>>()

  private constructor(store: JsonStore<FaviconIndex>, options: FaviconStoreOptions) {
    this.#store = store
    this.#directory = options.directory
    this.#fetch = options.fetch
    this.#now = options.now ?? (() => Date.now())
    this.#maxAgeMs = options.maxAgeMs
    this.#maxEntries = options.maxEntries
  }

  static async open(options: FaviconStoreOptions): Promise<FaviconStore> {
    const store = await JsonStore.open<FaviconIndex>({
      filePath: join(options.directory, INDEX_FILE_NAME),
      schema: faviconIndexSchema,
      fallback: emptyFaviconIndex,
      // A file cut short by a crash, or written by an older build, must not leave two
      // entries for one site: the write path assumes one, and the extra would decide
      // arbitrarily which content type gets served for a file only one of them wrote.
      repair: (document) => ({ ...document, icons: repairFaviconIndex(document.icons) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new FaviconStore(store, options)
  }

  /**
   * The only way to obtain a writer, and it cannot be obtained without saying which kind
   * of session it is for.
   *
   * A private window gets `discardingFaviconCache`: an object holding no store, no
   * directory and no fetcher. So "a private window leaves no icon behind" is a property
   * of what the window physically has rather than a check every call site must remember,
   * and a future `ensure` call added anywhere in that window's code inherits the
   * guarantee. It also means a private window makes no request — there is nothing there
   * to make one with.
   *
   * Reading is deliberately *not* behind this. `find` leaves no trace, and a private
   * window that showed blank icons for sites the cache already knows would be worse for
   * no gain.
   */
  cacheFor(mode: BrowsingMode): FaviconCache {
    if (mode === 'private') return discardingFaviconCache
    return {
      ensure: (pageUrl: string, candidateUrls: readonly string[]) =>
        this.#ensure(pageUrl, candidateUrls)
    }
  }

  /**
   * The icon for a site, or `null`. Takes an address or a bare domain.
   *
   * A stale entry is still returned: a month-old icon is worth more than none, and
   * expiry is a reason to refresh on the next visit rather than to stop showing what we
   * have.
   */
  find(domainOrUrl: string): FaviconLookup | null {
    const entry = findFaviconEntry(this.#store.get().icons, domainOrUrl)
    if (entry === null) return null
    return { entry, filePath: this.#pathFor(entry.domain) }
  }

  list(): FaviconEntry[] {
    return [...this.#store.get().icons]
  }

  /** A snapshot, so a caller cannot reach in and reset the counters. */
  get counts(): FaviconCounts {
    return { ...this.#counts, rejected: { ...this.#counts.rejected } }
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  onChange(listener: (icons: FaviconEntry[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.icons]))
  }

  /**
   * Removes every icon and empties the index. This is what `clearData.onExitCategories`
   * containing `cache` runs.
   *
   * Files first, index second: the reverse order would leave images on disk that nothing
   * remembers, and therefore nothing can ever delete.
   */
  async clear(): Promise<number> {
    const icons = this.#store.get().icons
    for (const icon of icons) await this.#removeFile(icon.domain)
    this.#store.update((document) => ({ ...document, icons: [] }))
    this.#failed.clear()
    return icons.length
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  async #ensure(pageUrl: string, candidateUrls: readonly string[]): Promise<FaviconOutcome> {
    const domain = faviconDomainOf(pageUrl)
    if (domain === null) return this.#refuse(null, 'not-a-site')

    const existing = findFaviconEntry(this.#store.get().icons, domain)
    if (existing !== null && !faviconIsStale(existing, this.#now(), this.#maxAgeMs)) {
      // The requirement, in one line: a site already in the cache costs no request.
      this.#counts.reused += 1
      return { kind: 'cached', entry: existing }
    }

    const pending = this.#inFlight.get(domain)
    if (pending !== undefined) return pending

    if (this.#failed.has(domain)) return this.#refuse(existing, 'already-tried')

    const candidate = chooseFaviconCandidate(candidateUrls)
    if (candidate === null) return this.#refuse(existing, 'no-candidate')

    const work = this.#retrieve(domain, candidate, existing)
    this.#inFlight.set(domain, work)
    try {
      return await work
    } finally {
      this.#inFlight.delete(domain)
    }
  }

  async #retrieve(
    domain: string,
    candidateUrl: string,
    existing: FaviconEntry | null
  ): Promise<FaviconOutcome> {
    this.#counts.requests += 1
    const image = await this.#download(candidateUrl)
    if (!image.ok) {
      this.#failed.add(domain)
      return this.#refuse(existing, image.reason)
    }

    // The file before the index. A file nothing points at wastes a few kilobytes; an
    // index entry with no file behind it is a broken picture in the tab strip.
    const written = await this.#writeIcon(domain, image.bytes)
    if (!written) {
      this.#failed.add(domain)
      return this.#refuse(existing, 'write-failed')
    }

    const entry: FaviconEntry = {
      domain,
      contentType: image.contentType,
      byteLength: image.bytes.byteLength,
      fetchedAt: this.#now(),
      sourceUrl: candidateUrl
    }
    const { icons, evicted } = putFaviconEntry(this.#store.get().icons, entry, this.#maxEntries)
    this.#store.update((document) => ({ ...document, icons }))
    for (const gone of evicted) await this.#removeFile(gone.domain)

    this.#counts.stored += 1
    return { kind: 'stored', entry }
  }

  /**
   * One request, and every way its answer can be unacceptable.
   *
   * The checks are ordered by what they cost: the status and the declared type are
   * headers, so a soft 404 or an HTML error page is refused before its body is read. The
   * declared length is a claim and treated as one — the measured length is checked too,
   * because a server that lies about it, or omits it while streaming, must not get past.
   */
  async #download(url: string): Promise<Retrieval> {
    try {
      const response = await this.#fetch(url)
      if (!response.ok) return { ok: false, reason: 'http-error' }
      if (!looksLikeImageType(response.headers.get('content-type'))) {
        return { ok: false, reason: 'unsupported-type' }
      }

      const declared = declaredLengthOf(response.headers.get('content-length'))
      if (declared !== null && declared > MAX_FAVICON_BYTES) {
        return { ok: false, reason: 'too-large' }
      }

      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > MAX_FAVICON_BYTES) return { ok: false, reason: 'too-large' }

      const contentType = sniffFaviconType(bytes)
      if (contentType === null) return { ok: false, reason: 'unsupported-type' }
      return { ok: true, bytes, contentType }
    } catch {
      // A refused connection, a DNS failure, a body cut short mid-stream: one answer
      // covers them, because the response for all of them is the same — keep whatever
      // is already stored and try again next run.
      return { ok: false, reason: 'network-error' }
    }
  }

  /**
   * Writes one icon, reporting failure rather than throwing.
   *
   * A cache that cannot be written is not a reason to fail a navigation, so the caller
   * gets a `write-failed` rejection it can count. Write-then-rename for the usual
   * reason: a crash mid-write would otherwise leave a truncated image that the protocol
   * handler happily serves as a broken picture, with an index entry claiming a length
   * the file no longer has.
   */
  async #writeIcon(domain: string, bytes: Uint8Array): Promise<boolean> {
    const target = this.#pathFor(domain)
    try {
      await mkdir(this.#directory, { recursive: true })
      const temp = `${target}.tmp`
      await writeFile(temp, bytes, { mode: 0o600 })
      await rename(temp, target)
      return true
    } catch (error) {
      console.warn(`[favicons] could not store the icon for ${domain}:`, error)
      return false
    }
  }

  async #removeFile(domain: string): Promise<void> {
    try {
      // `force` makes a missing file a success, which is the common case: eviction and
      // clearing both run against entries whose file may already be gone.
      await rm(this.#pathFor(domain), { force: true })
    } catch (error) {
      // A few kilobytes left in a directory the platform treats as discardable. Worth
      // reporting, not worth retrying, and certainly not worth keeping the index entry
      // for — the entry is what makes the site ask again.
      console.warn(`[favicons] could not remove the icon for ${domain}:`, error)
    }
  }

  /**
   * Counts a rejection and decides what the caller is left holding.
   *
   * The previous copy stands whenever there is one. Every rejection here means "we could
   * not get a newer icon", and none of them means "the icon we have is wrong", so
   * dropping it would turn a failed refresh into a visible regression — the icon
   * disappearing from a site the user has had for a month because a CDN blinked.
   */
  #refuse(existing: FaviconEntry | null, reason: FaviconRejection): FaviconOutcome {
    this.#counts.rejected[reason] += 1
    if (existing === null) return { kind: 'rejected', reason }
    this.#counts.kept += 1
    return { kind: 'kept', entry: existing, reason }
  }

  /**
   * The file one site's icon lives in.
   *
   * Derived from the domain every time, never read from the index. That is what makes a
   * hand-edited or corrupted index unable to point the handler at a file outside this directory:
   * its only influence is the key, and the key becomes a fixed-length hash.
   *
   * ## Why a hash rather than the domain
   *
   * The name used to be the escaped domain, so `example.com.icon` sat in the directory. The index
   * is encrypted; file names are not — which made a directory listing a reading list, legible
   * without any key at all. Encrypting the contents and naming the file after the secret is the
   * kind of gap that looks like protection and is not.
   *
   * SHA-256 rather than a fast non-cryptographic hash: two domains that collide would share an
   * icon, and a collision that can be *constructed* means a site could put its own picture beside
   * another's name. Truncated to 32 hex characters, which is far beyond what 1000 entries need.
   *
   * The extension stays deliberately neutral rather than `.png`/`.ico`: the format is recorded in
   * the index and *that* is what gets served, because a file extension is the classic thing to
   * trust and be wrong about.
   */
  #pathFor(domain: string): string {
    const digest = createHash('sha256').update(domain.toLowerCase(), 'utf8').digest('hex')
    return join(this.#directory, `${digest.slice(0, 32)}.icon`)
  }
}
