import { createHash } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import {
  MAX_THUMBNAIL_BYTES,
  MAX_THUMBNAIL_TITLE_LENGTH,
  MAX_THUMBNAIL_URL_LENGTH,
  THUMBNAIL_CONTENT_TYPE,
  THUMBNAIL_FALLBACK_QUALITY,
  THUMBNAIL_QUALITY,
  THUMBNAIL_SETTLE_DELAY_MS,
  THUMBNAIL_TARGET,
  discardingThumbnailCapturer,
  emptyThumbnailCounts,
  emptyThumbnailIndex,
  findThumbnailEntry,
  planThumbnail,
  putThumbnailEntry,
  repairThumbnailIndex,
  thumbnailIsStale,
  thumbnailKeyOf,
  thumbnailTitleOf,
  type ThumbnailCapturer,
  type ThumbnailCounts,
  type ThumbnailEntry,
  type ThumbnailIndex,
  type ThumbnailOutcome,
  type ThumbnailRect,
  type ThumbnailRejection,
  type ThumbnailRequest,
  type ThumbnailSize
} from '@shared/thumbnails/model.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { BrowsingMode } from './HistoryStore.js'

/**
 * Storage for page thumbnails — the picture on a start-page card.
 *
 * The rules live in `@shared/thumbnails/model.ts` as pure functions. This class
 * supplies the three things they cannot have and stay testable — the clock, the
 * camera and the disk — and decides who is allowed to write, the same division
 * `HistoryStore` and `FaviconStore` use.
 *
 * Two kinds of file make up the store, both inside the directory the caller names:
 * one JPEG per page, and an index describing them. The index is what makes "this page
 * already has a current picture, so take none" answerable without touching the disk.
 *
 * ## What the index reveals, and why it belongs behind the codec
 *
 * The index lists addresses and titles of pages the user visited, which is the same
 * material the history file holds — so the `codec` option exists for the caller to
 * hand it the same encrypted codec the other stores get. The pictures themselves are
 * written as plain JPEG, because the protocol handler serves them straight to an
 * `<img>`; that is a deliberate limit of this iteration, and the byte budget is set
 * low partly so wrapping them later stays affordable.
 *
 * ## Why the pictures live in the cache directory
 *
 * Losing them costs one local capture per page and nothing the user typed, and putting
 * them there is what makes them go with the `cache` category of "clear data" — see
 * `clear`. For this particular kind of file, being discardable is a feature.
 */

/**
 * A captured image, as much of one as this store needs.
 *
 * Structural on purpose: Electron's `NativeImage` satisfies it exactly, so wiring
 * passes `webContents.capturePage()` straight through, while a test hands over four
 * plain functions and Electron is never loaded at all. Nothing here is imported from
 * `electron` — not even a type — so the module stays runnable under plain Node.
 *
 * `getSize` reports device-independent pixels; on a HiDPI display the encoded bitmap
 * behind them can be larger, which is why the byte cap is the backstop rather than the
 * dimensions.
 */
export interface CapturedImage {
  isEmpty(): boolean
  getSize(): ThumbnailSize
  crop(rect: ThumbnailRect): CapturedImage
  resize(options: {
    width: number
    height: number
    quality: 'good' | 'better' | 'best'
  }): CapturedImage
  toJPEG(quality: number): Uint8Array
}

/** Which view to photograph. `viewId` is Electron's web-contents id in production. */
export interface CaptureTarget {
  /**
   * The address the store believes the view is showing, unnormalised.
   *
   * Passed back out so a provider can check that the view still shows it and refuse
   * otherwise: the capture happens after a delay, and a picture taken after the user
   * navigated on would be filed under the previous page's address.
   */
  url: string
  viewId: number
}

/**
 * How a page becomes pixels.
 *
 * Required, with no default, and that is the whole point of the seam. The only other
 * way to get a screenshot is to reach for `webContents` from in here, which would tie
 * this module to Electron, make every test load a browser process, and — the part that
 * matters — put the decision of *which* view is photographed inside the store, where
 * nothing knows whether that view still shows the page it was asked about. Wiring is
 * expected to pass `webContents.fromId(viewId)?.capturePage()`. An optional parameter
 * with a fallback would make the version that photographs the wrong window the one you
 * get by forgetting, so there is no fallback to forget into.
 *
 * Returning `null` is how a provider says "not now" — the view has gone, or it is not
 * the page we asked about — and costs the previous picture nothing.
 */
export type PageCapturer = (target: CaptureTarget) => Promise<CapturedImage | null>

/**
 * What the index file must look like to be usable.
 *
 * Strict about kinds *and* amounts, unlike history: every entry describes a picture
 * that can simply be taken again, so discarding the document costs one local capture
 * per page and nothing the user typed. The bounds are assertions that the write path
 * holds, and the write path is what keeps them — `thumbnailKeyOf` caps the address,
 * `thumbnailTitleOf` caps the title, `planThumbnail` never exceeds the target size,
 * and the encoder refuses anything past the byte cap.
 */
const thumbnailEntrySchema = z.object({
  url: z.string().min(1).max(MAX_THUMBNAIL_URL_LENGTH),
  title: z.string().max(MAX_THUMBNAIL_TITLE_LENGTH),
  width: z.number().int().positive().max(THUMBNAIL_TARGET.width),
  height: z.number().int().positive().max(THUMBNAIL_TARGET.height),
  byteLength: z.number().int().positive().max(MAX_THUMBNAIL_BYTES),
  capturedAt: z.number().int().nonnegative()
})

const thumbnailIndexSchema = z.object({
  version: z.literal(1),
  shots: z.array(thumbnailEntrySchema)
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — one
 * assignment each way per shape. The schema cannot live next to the interface, because
 * the start page imports the interface and zod must not reach a renderer bundle.
 */
type SchemaEntry = z.output<typeof thumbnailEntrySchema>
type SchemaIndex = z.output<typeof thumbnailIndexSchema>

const _entryMatchesModel: SchemaEntry = null as unknown as ThumbnailEntry
const _modelMatchesEntry: ThumbnailEntry = null as unknown as SchemaEntry
const _indexMatchesModel: SchemaIndex = null as unknown as ThumbnailIndex
const _modelMatchesIndex: ThumbnailIndex = null as unknown as SchemaIndex
void _entryMatchesModel
void _modelMatchesEntry
void _indexMatchesModel
void _modelMatchesIndex

/** The index file's name inside the thumbnail directory. */
const INDEX_FILE_NAME = 'index.json'

/**
 * The file one page's picture is stored in.
 *
 * Two decisions worth stating. It is *derived* from the key on every use and never
 * read from the index, which is what stops a hand-edited or corrupted index pointing
 * the protocol handler at a file elsewhere on the disk: the only influence the index
 * has is the key, and the key goes through a hash.
 *
 * And it is a hash rather than an escaped address. An address is long, full of
 * characters no file system likes, and would push past name-length limits. It would
 * also turn a directory listing into a list of pages the user has read — the favicon
 * cache accepts that trade for domains, because a domain has to become a file name
 * somehow, but a page address is a great deal more telling and a hash costs nothing to
 * avoid it. SHA-256 rather than something cheap because a non-cryptographic hash is
 * trivial to collide deliberately, and a page that could choose an address colliding
 * with another page's would replace that card's picture with its own. 128 bits of the
 * digest, so the path stays short enough for Windows.
 *
 * The extension is neutral: the format lives in `THUMBNAIL_CONTENT_TYPE`, and a name
 * that promised one would invite trusting it.
 */
export function thumbnailFileName(key: string): string {
  return `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.shot`
}

export interface ThumbnailStoreOptions {
  /** Where the pictures and the index go. Created on the first write. */
  directory: string
  /** See `PageCapturer`. Deliberately not optional. */
  capture: PageCapturer
  /** Injected in tests so expiry does not depend on when the test ran. */
  now?: () => number
  /** Overridden in tests; defaults to `THUMBNAIL_MAX_AGE_MS`. */
  maxAgeMs?: number
  /** Overridden in tests; defaults to `MAX_THUMBNAIL_ENTRIES`. */
  maxEntries?: number
  /** Overrides `THUMBNAIL_SETTLE_DELAY_MS` for the wiring that reads it back. */
  settleDelayMs?: number
  codec?: DocumentCodec
  debounceMs?: number
}

/** A picture and where its bytes are, which is what the protocol handler needs. */
export interface ThumbnailLookup {
  entry: ThumbnailEntry
  /** Absolute path, derived from the key — never taken from the index. */
  filePath: string
  contentType: typeof THUMBNAIL_CONTENT_TYPE
}

type Rendered =
  | { ok: true; bytes: Uint8Array; size: ThumbnailSize }
  | { ok: false; reason: ThumbnailRejection }

export class ThumbnailStore {
  readonly #store: JsonStore<ThumbnailIndex>
  readonly #directory: string
  readonly #photograph: PageCapturer
  readonly #now: () => number
  readonly #maxAgeMs: number | undefined
  readonly #maxEntries: number | undefined
  readonly #settleDelayMs: number
  readonly #counts: ThumbnailCounts = emptyThumbnailCounts()

  /**
   * Captures in progress, keyed by page.
   *
   * A page that reports itself finished twice — a subframe settling, a client-side
   * route change — would otherwise start two captures of the same view, each writing
   * the same file. They get the same promise instead.
   */
  readonly #inFlight = new Map<string, Promise<ThumbnailOutcome>>()

  /**
   * Bumped by `clear`, so a capture that was already in flight can tell that its
   * subject was deleted while it worked.
   *
   * Without it, "clear data" has a hole exactly the width of one capture: the picture
   * is written before the index entry, so a capture that started before the clear and
   * finished after it would leave a file the clear had already walked past, plus an
   * index entry recreating what the user asked to be gone. A counter rather than a
   * flag because clearing can happen more than once per run.
   */
  #generation = 0

  private constructor(store: JsonStore<ThumbnailIndex>, options: ThumbnailStoreOptions) {
    this.#store = store
    this.#directory = options.directory
    this.#photograph = options.capture
    this.#now = options.now ?? (() => Date.now())
    this.#maxAgeMs = options.maxAgeMs
    this.#maxEntries = options.maxEntries
    this.#settleDelayMs = options.settleDelayMs ?? THUMBNAIL_SETTLE_DELAY_MS
  }

  static async open(options: ThumbnailStoreOptions): Promise<ThumbnailStore> {
    const store = await JsonStore.open<ThumbnailIndex>({
      filePath: join(options.directory, INDEX_FILE_NAME),
      schema: thumbnailIndexSchema,
      fallback: emptyThumbnailIndex,
      // A file cut short by a crash, or written by an older build, must not leave two
      // entries for one page: the write path assumes one, and the extra would claim
      // dimensions and a byte length for a file the other one has overwritten.
      repair: (document) => ({ ...document, shots: repairThumbnailIndex(document.shots) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new ThumbnailStore(store, options)
  }

  /**
   * How long the wiring should wait after a page settles before asking for a capture.
   *
   * The store holds the number and the wiring owns the timer, because only the wiring
   * can cancel one when the user navigates away. See `THUMBNAIL_SETTLE_DELAY_MS` for
   * why there is a delay at all.
   */
  get settleDelayMs(): number {
    return this.#settleDelayMs
  }

  /**
   * The only way to obtain a writer, and it cannot be obtained without saying which
   * kind of session it is for.
   *
   * A private window gets `discardingThumbnailCapturer`: an object holding no store,
   * no directory and no camera. So "a private window leaves no picture behind" is a
   * property of what the window physically has rather than a check every call site
   * must remember, and a `capture` call added anywhere in that window's code later
   * inherits the guarantee. It also means a private window photographs nothing —
   * there is nothing there to photograph with.
   *
   * Reading is deliberately *not* behind this, exactly as in the favicon cache: `find`
   * leaves no trace, and the protocol handler has no session to check. Whether a
   * private window's start page should *ask* for pictures of normal-mode pages is a
   * question about that page, and it belongs there.
   */
  capturerFor(mode: BrowsingMode): ThumbnailCapturer {
    if (mode === 'private') return discardingThumbnailCapturer
    return {
      shouldCapture: (url: string) => this.#shouldCapture(url),
      capture: (request: ThumbnailRequest) => this.#capture(request)
    }
  }

  /**
   * The picture for a page, or `null`. Takes a raw or a normalised address.
   *
   * A stale entry is still returned: expiry is a reason to take a new picture on the
   * next visit, not a reason to stop showing the one we have.
   */
  find(pageUrl: string): ThumbnailLookup | null {
    const entry = findThumbnailEntry(this.#store.get().shots, pageUrl)
    if (entry === null) return null
    return {
      entry,
      filePath: this.#pathFor(entry.url),
      contentType: THUMBNAIL_CONTENT_TYPE
    }
  }

  list(): ThumbnailEntry[] {
    return [...this.#store.get().shots]
  }

  /** A snapshot, so a caller cannot reach in and reset the counters. */
  get counts(): ThumbnailCounts {
    return { ...this.#counts, rejected: { ...this.#counts.rejected } }
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  onChange(listener: (shots: ThumbnailEntry[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.shots]))
  }

  /**
   * Removes every picture and empties the index. This is what `clearData` running the
   * `cache` category on exit calls, and it is the promise the whole feature rests on.
   *
   * Files first, index second: the reverse order would leave pictures on disk that
   * nothing remembers, and therefore nothing can ever delete.
   */
  async clear(): Promise<number> {
    // Before the deletions, not after: see `#generation`.
    this.#generation += 1
    const shots = this.#store.get().shots
    for (const shot of shots) await this.#removeFile(shot.url)
    this.#store.update((document) => ({ ...document, shots: [] }))
    return shots.length
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  #shouldCapture(url: string): boolean {
    const key = thumbnailKeyOf(url)
    if (key === null) return false
    if (this.#inFlight.has(key)) return false
    const existing = findThumbnailEntry(this.#store.get().shots, key)
    return existing === null || thumbnailIsStale(existing, this.#now(), this.#maxAgeMs)
  }

  async #capture(request: ThumbnailRequest): Promise<ThumbnailOutcome> {
    const key = thumbnailKeyOf(request.url)
    if (key === null) return this.#refuse(null, 'not-a-page')

    const existing = findThumbnailEntry(this.#store.get().shots, key)
    if (existing !== null && !thumbnailIsStale(existing, this.#now(), this.#maxAgeMs)) {
      // The decision about *when*, in one line: a page with a current picture costs
      // nothing on every later visit, however often it is opened.
      this.#counts.fresh += 1
      return { kind: 'fresh', entry: existing }
    }

    const pending = this.#inFlight.get(key)
    if (pending !== undefined) return pending

    const work = this.#take(key, request, existing)
    this.#inFlight.set(key, work)
    try {
      return await work
    } finally {
      this.#inFlight.delete(key)
    }
  }

  /**
   * One capture, and every way it can come to nothing.
   *
   * Deliberately *without* the favicon cache's "one attempt per site per run". That
   * rule exists there to spare a remote server hundreds of requests; there is no
   * server here, a capture costs a few milliseconds of local work, and the common
   * failure is a page that had not painted yet — refusing to try again would leave the
   * card blank for the rest of the session for the one reason that fixes itself.
   */
  async #take(
    key: string,
    request: ThumbnailRequest,
    existing: ThumbnailEntry | null
  ): Promise<ThumbnailOutcome> {
    this.#counts.captures += 1
    const generation = this.#generation

    const image = await this.#takePicture(request)
    if (image === null) return this.#refuse(existing, 'capture-failed')

    const rendered = this.#render(image)
    if (!rendered.ok) return this.#refuse(existing, rendered.reason)

    // The file before the index. A file nothing points at wastes a few kilobytes; an
    // index entry with no file behind it is a broken picture on the start page.
    const written = await this.#writeImage(key, rendered.bytes)
    if (!written) return this.#refuse(existing, 'write-failed')

    if (generation !== this.#generation) {
      // "Clear data" ran while this capture was in flight. Remove what we just wrote
      // and record nothing — and report `rejected` rather than `kept`, because the
      // previous entry this call started with has been deleted too.
      await this.#removeFile(key)
      return this.#refuse(null, 'discarded')
    }

    const entry: ThumbnailEntry = {
      url: key,
      title: thumbnailTitleOf(request.title),
      width: rendered.size.width,
      height: rendered.size.height,
      byteLength: rendered.bytes.byteLength,
      capturedAt: this.#now()
    }
    const { shots, evicted } = putThumbnailEntry(
      this.#store.get().shots,
      entry,
      this.#maxEntries
    )
    this.#store.update((document) => ({ ...document, shots }))
    for (const gone of evicted) await this.#removeFile(gone.url)

    this.#counts.stored += 1
    return { kind: 'stored', entry }
  }

  /**
   * Asks the provider for pixels, reporting failure rather than throwing.
   *
   * A view that closed between the settle and the delay is the ordinary case, not an
   * error, and a thumbnail is never worth failing a navigation over.
   */
  async #takePicture(request: ThumbnailRequest): Promise<CapturedImage | null> {
    try {
      return await this.#photograph({ url: request.url, viewId: request.viewId })
    } catch (error) {
      console.warn(`[thumbnails] could not photograph ${request.url}:`, error)
      return null
    }
  }

  /**
   * Crop, scale, encode — the whole pixel path, and the reason a 4K capture does not
   * become a 4K file.
   *
   * One try/catch around all three: they are platform image operations that fail as a
   * unit, and splitting the failure into three reasons would suggest a caller could do
   * something different about each.
   */
  #render(image: CapturedImage): Rendered {
    try {
      // A view that has never painted answers with an empty image rather than an
      // error, and an empty image encodes to a plausible-looking grey rectangle.
      if (image.isEmpty()) return { ok: false, reason: 'blank' }

      const plan = planThumbnail(image.getSize(), THUMBNAIL_TARGET)
      if (plan === null) return { ok: false, reason: 'blank' }

      const cropped = plan.crop === null ? image : image.crop(plan.crop)
      // `best` rather than the faster filters: this runs once per page, not per frame,
      // and a cheap filter's failure mode on a downscaled screenshot is aliased text —
      // exactly the detail that makes a card recognisable.
      const scaled =
        plan.resize === null ? cropped : cropped.resize({ ...plan.resize, quality: 'best' })

      const bytes = this.#encode(scaled)
      if (bytes === null) return { ok: false, reason: 'too-large' }
      // A zero-length encode would be written as a file the handler serves as a broken
      // image, and the schema would refuse the entry describing it anyway.
      if (bytes.byteLength === 0) return { ok: false, reason: 'encode-failed' }

      return { ok: true, bytes, size: plan.size }
    } catch (error) {
      console.warn('[thumbnails] could not scale or encode a capture:', error)
      return { ok: false, reason: 'encode-failed' }
    }
  }

  /**
   * JPEG bytes within the cap, or `null` when even the second attempt is too big.
   *
   * Two attempts and no more. A loop searching for the quality that just fits would
   * re-encode the same image four or five times, on a path that runs for every page
   * the user reads, to save kilobytes in a discardable directory.
   */
  #encode(image: CapturedImage): Uint8Array | null {
    const primary = image.toJPEG(THUMBNAIL_QUALITY)
    if (primary.byteLength <= MAX_THUMBNAIL_BYTES) return primary
    const smaller = image.toJPEG(THUMBNAIL_FALLBACK_QUALITY)
    return smaller.byteLength <= MAX_THUMBNAIL_BYTES ? smaller : null
  }

  /**
   * Writes one picture, reporting failure rather than throwing.
   *
   * Write-then-rename for the usual reason: a crash mid-write would otherwise leave a
   * truncated JPEG that the protocol handler serves as a broken image, with an index
   * entry claiming a length the file does not have. `0o600` because this is a picture
   * of the user's screen, and on a shared machine the default umask is not the answer.
   */
  async #writeImage(key: string, bytes: Uint8Array): Promise<boolean> {
    const target = this.#pathFor(key)
    try {
      await mkdir(this.#directory, { recursive: true })
      const temp = `${target}.tmp`
      await writeFile(temp, bytes, { mode: 0o600 })
      await rename(temp, target)
      return true
    } catch (error) {
      console.warn(`[thumbnails] could not store the picture for ${key}:`, error)
      return false
    }
  }

  async #removeFile(key: string): Promise<void> {
    try {
      // `force` makes a missing file a success, which is the common case: eviction and
      // clearing both run against entries whose file may already be gone.
      await rm(this.#pathFor(key), { force: true })
    } catch (error) {
      // Worth reporting, not worth retrying, and not worth keeping the index entry
      // for: an entry whose file is unreadable is a broken picture, and dropping it
      // gets the card back to its favicon.
      console.warn(`[thumbnails] could not remove the picture for ${key}:`, error)
    }
  }

  /**
   * Counts a rejection and decides what the caller is left holding.
   *
   * The previous picture stands whenever there is one. Every rejection here means "we
   * could not take a newer picture", none of them means "the picture we have is
   * wrong", so dropping it would turn a failed refresh into a visible regression — the
   * card losing its picture because the user closed the tab a moment too early.
   */
  #refuse(existing: ThumbnailEntry | null, reason: ThumbnailRejection): ThumbnailOutcome {
    this.#counts.rejected[reason] += 1
    if (existing === null) return { kind: 'rejected', reason }
    this.#counts.kept += 1
    return { kind: 'kept', entry: existing, reason }
  }

  #pathFor(key: string): string {
    return join(this.#directory, thumbnailFileName(key))
  }
}
