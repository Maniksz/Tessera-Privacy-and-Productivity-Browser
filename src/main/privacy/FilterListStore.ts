import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/**
 * Filter lists on disk, with a refresh that runs rarely.
 *
 * Spec 4 forbids contacting a third party per request, and a blocker is the
 * obvious place to break that rule by accident: consult a list, fetch a list.
 * So the lists live in the cache directory and the engine only ever reads them
 * from there. A download happens when a copy is missing or older than
 * `DEFAULT_LIST_MAX_AGE_MS`, and never on the request path.
 *
 * This belongs under `paths.cacheDir()` rather than `userDataDir()`, and the
 * distinction is load-bearing: losing this directory costs one download, so
 * pruning it is safe. Nothing here is user data.
 */

/** Subdirectory of `paths.cacheDir()` the wiring should point `directory` at. */
export const FILTER_LIST_CACHE_DIRNAME = 'filter-lists'

/**
 * Five days.
 *
 * EasyList publishes several times a day, but a list five days old blocks very
 * nearly what today's does, and each fetch is a request to a third party that
 * reveals when the browser was running. Rare beats current here.
 */
export const DEFAULT_LIST_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000

const MANIFEST_FILE = 'manifest.json'

const manifestSchema = z.record(
  z.string(),
  z.object({ file: z.string(), fetchedAt: z.number() })
)

type Manifest = z.output<typeof manifestSchema>

export interface CachedList {
  readonly url: string
  readonly text: string
  readonly fetchedAt: number
}

export interface RefreshOutcome {
  readonly url: string
  /** `fresh` means the cached copy was young enough to keep. */
  readonly status: 'fetched' | 'fresh' | 'failed'
  readonly reason: string | null
}

export interface FilterListStoreOptions {
  /** Absolute path; `join(cacheDir(), FILTER_LIST_CACHE_DIRNAME)` at the call site. */
  readonly directory: string
  /**
   * Downloads one list body.
   *
   * Required rather than defaulted, and that is deliberate. A default would be
   * Node's own `fetch`, which goes around Chromium's network stack and therefore
   * around the proxy settings and the kill switch — a list download leaking past
   * a tunnel the user turned on. The wiring passes Electron's `net.fetch`, and
   * having to pass it is what keeps that decision visible.
   */
  readonly fetchList: (url: string) => Promise<string>
  /** Injected so staleness is decidable in a test without waiting five days. */
  readonly now: () => number
  readonly maxAgeMs?: number
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeHostOf(url: string): string {
  try {
    const cleaned = new URL(url).hostname.replace(/[^a-z0-9.-]/gi, '')
    return cleaned === '' ? 'list' : cleaned
  } catch {
    return 'list'
  }
}

/**
 * Host for legibility, digest for identity.
 *
 * The digest is what makes the name unique and keeps arbitrary URL text off the
 * filesystem; the host prefix is so somebody looking at the cache directory can
 * tell which file is which.
 */
function cacheFileName(url: string): string {
  const digest = createHash('sha256').update(url).digest('hex').slice(0, 16)
  return `${safeHostOf(url)}-${digest}.txt`
}

async function writeAtomically(path: string, contents: string): Promise<void> {
  // Write then rename: a crash mid-write leaves the previous list intact rather
  // than a truncated one that would parse into a blocker with holes in it.
  const temporary = `${path}.tmp`
  await writeFile(temporary, contents, 'utf8')
  await rename(temporary, path)
}

export class FilterListStore {
  readonly #directory: string
  readonly #fetchList: (url: string) => Promise<string>
  readonly #now: () => number
  readonly #maxAgeMs: number

  constructor(options: FilterListStoreOptions) {
    this.#directory = options.directory
    this.#fetchList = options.fetchList
    this.#now = options.now
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_LIST_MAX_AGE_MS
  }

  #manifestPath(): string {
    return join(this.#directory, MANIFEST_FILE)
  }

  async #readManifest(): Promise<Manifest> {
    try {
      const parsed = manifestSchema.safeParse(JSON.parse(await readFile(this.#manifestPath(), 'utf8')))
      // An unusable manifest is the same situation as no manifest: nothing is
      // cached, so the next refresh downloads. Never a throw — a corrupt cache
      // file must not stop the browser from starting.
      return parsed.success ? parsed.data : {}
    } catch {
      return {}
    }
  }

  /**
   * Cached bodies for the configured lists, in the order given.
   *
   * A list with no cached copy is absent from the result rather than an error: the
   * blocker works with what it has, and the diagnostics say how much that is.
   */
  async load(urls: readonly string[]): Promise<readonly CachedList[]> {
    const manifest = await this.#readManifest()
    const lists: CachedList[] = []
    for (const url of urls) {
      const entry = manifest[url]
      if (entry === undefined) continue
      try {
        const text = await readFile(join(this.#directory, entry.file), 'utf8')
        lists.push({ url, text, fetchedAt: entry.fetchedAt })
      } catch {
        // Manifest entry without its file: the cache is discardable by design.
        continue
      }
    }
    return lists
  }

  /** Downloads whatever is missing or stale, and reports what it did with each URL. */
  async refresh(urls: readonly string[]): Promise<readonly RefreshOutcome[]> {
    await mkdir(this.#directory, { recursive: true })
    const manifest = await this.#readManifest()
    const next: Manifest = {}
    const outcomes: RefreshOutcome[] = []

    for (const url of urls) {
      const entry = manifest[url]
      if (entry !== undefined && this.#now() - entry.fetchedAt < this.#maxAgeMs) {
        next[url] = entry
        outcomes.push({ url, status: 'fresh', reason: null })
        continue
      }
      try {
        const text = await this.#fetchList(url)
        const file = cacheFileName(url)
        await writeAtomically(join(this.#directory, file), text)
        next[url] = { file, fetchedAt: this.#now() }
        outcomes.push({ url, status: 'fetched', reason: null })
      } catch (error) {
        // A failed download must never discard the copy already on disk. A
        // browser with a stale list still blocks; a browser with no list does not.
        if (entry !== undefined) next[url] = entry
        outcomes.push({ url, status: 'failed', reason: messageOf(error) })
      }
    }

    await this.#prune(next)
    await writeAtomically(this.#manifestPath(), JSON.stringify(next, null, 2))
    return outcomes
  }

  /** Drops files no manifest entry refers to, e.g. a list the user removed. */
  async #prune(manifest: Manifest): Promise<void> {
    const keep = new Set(Object.values(manifest).map((entry) => entry.file))
    for (const name of await readdir(this.#directory)) {
      if (name === MANIFEST_FILE || keep.has(name)) continue
      try {
        await unlink(join(this.#directory, name))
      } catch {
        // Something in the cache directory that is not a list file of ours.
        // Leaving it is harmless; failing the refresh over it would not be.
        continue
      }
    }
  }
}
