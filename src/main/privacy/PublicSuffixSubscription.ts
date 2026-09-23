import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { configurePublicSuffixes } from '@shared/url/domain.js'
import {
  NO_PUBLIC_SUFFIX_HISTORY,
  PUBLIC_SUFFIX_MAX_BYTES,
  checkPublicSuffixList,
  isOnlyPrivateLoss,
  parsePublicSuffixList,
  rulesOf,
  type PublicSuffixRejection,
  type ToAscii
} from '@shared/url/public-suffix.js'
import { writeFileAtomically } from '../data/atomic-write.js'
import { FilterListStore, type FilterListStoreOptions } from './FilterListStore.js'

/**
 * The Public Suffix List: downloaded at runtime, put in force only at startup.
 *
 * `FilterSubscription` is the model, and the differences are the point:
 *
 *   - **Loaded before anything keys on a site.** `load()` is awaited at startup, before the favicon
 *     cache and the user's rules open, because both key their entries by `registrableDomain`. It
 *     reads the disk only.
 *   - **A download never changes the run it happens in.** `refresh()` only writes the cache; the
 *     list in memory stays what `load()` installed until the process ends (R7). A permission, a
 *     partition or a saved password keyed on a site halfway through a run must not find that site
 *     redrawn under it — so the new list waits for the next start, and `configurePublicSuffixes`
 *     refuses a second call to make that structural.
 *   - **A candidate is judged before it is stored.** The checks are `checkPublicSuffixList`, run
 *     through `FilterListStore`'s `verify` hook, so a refused body never reaches the disk.
 *   - **Rarely.** At most one attempt a day, recorded before the request goes out, and none at all
 *     while the accepted copy is younger than a week.
 *
 * ## Where things live
 *
 * `directory` is under `userData`, not under the discardable cache: losing it would put a profile
 * back on the bootstrap until the next successful download, which silently changes which hosts are
 * one site. The list itself sits in `list/`, owned by a `FilterListStore` that prunes whatever its
 * manifest does not name; the state file sits beside that directory, never inside it, so the prune
 * cannot take the baseline with it. And it is not the filter lists' directory either, whose prune
 * would take the list.
 */

export const PUBLIC_SUFFIX_LIST_URL = 'https://publicsuffix.org/list/public_suffix_list.dat'

/** Subdirectory of `paths.userDataDir()` the wiring points `directory` at. */
export const PUBLIC_SUFFIX_DIRNAME = 'public-suffix'

const DAY_MS = 24 * 60 * 60 * 1000

/** One attempt a day, whatever came of the last one. */
export const PUBLIC_SUFFIX_ATTEMPT_INTERVAL_MS = DAY_MS

/** How long an accepted list is used before another is asked for. */
export const PUBLIC_SUFFIX_MAX_AGE_MS = 7 * DAY_MS

/** How long a baseline stands before it is moved up to the list in force. */
export const PUBLIC_SUFFIX_BASELINE_MS = 30 * DAY_MS

/** How long a candidate that only lost PRIVATE rules has to keep arriving before it is accepted. */
export const PUBLIC_SUFFIX_CONFIRM_MS = 7 * DAY_MS

const STATE_FILE = 'state.json'
const LIST_DIRECTORY = 'list'

const storedListSchema = z.object({ text: z.string(), acceptedAt: z.number() })

const stateSchema = z.object({
  version: z.literal(1),
  /** When a download was last attempted. Every attempt counts, successful or not. */
  lastAttemptAt: z.number().nullable(),
  /** What removals are measured against; see `PUBLIC_SUFFIX_MAX_REMOVED_FRACTION`. */
  baseline: storedListSchema.nullable(),
  /** The good list before the one in the cache: what startup falls back to. */
  previous: storedListSchema.nullable(),
  /** The last candidate refused, and when it was first refused. */
  rejected: z.object({ sha256: z.string(), firstRejectedAt: z.number() }).nullable()
})

type State = z.output<typeof stateSchema>
type StoredList = z.output<typeof storedListSchema>

const EMPTY_STATE: State = {
  version: 1,
  lastAttemptAt: null,
  baseline: null,
  previous: null,
  rejected: null
}

/** Which list `load()` put in force. */
export type PublicSuffixSource = 'list' | 'previous' | 'bootstrap'

export interface PublicSuffixRefresh {
  readonly status: 'skipped' | 'fresh' | 'accepted' | 'rejected' | 'failed'
  /** Why a candidate was refused; empty otherwise. */
  readonly rejections: readonly PublicSuffixRejection[]
  /** The download's own failure, for `failed`. */
  readonly reason: string | null
}

export interface PublicSuffixSubscriptionOptions {
  /** `join(userDataDir(), PUBLIC_SUFFIX_DIRNAME)` at the call site. */
  readonly directory: string
  /**
   * Downloads the list body; `readPublicSuffixBody(await net.fetch(url))` at the call site.
   *
   * Electron's `net.fetch` for the reason `FilterSubscription` gives: the same proxy, secure DNS and
   * certificate store as the pages the list decides about.
   */
  readonly fetchList: (url: string) => Promise<string>
  /** `domainToASCII` from `node:url` at the call site. */
  readonly toAscii: ToAscii
  readonly now?: () => number
  readonly warn?: (message: string, detail: unknown) => void
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * The shape of a fetch response this reads: Electron's `net.fetch` result satisfies it.
 *
 * Structural so a test can hand in a body that arrives in pieces, which is how an oversized one is
 * noticed before it is all in memory.
 */
export interface PublicSuffixResponse {
  readonly ok: boolean
  readonly status: number
  readonly url: string
  readonly body: AsyncIterable<Uint8Array> | null
}

const LIST_ORIGIN = new URL(PUBLIC_SUFFIX_LIST_URL).origin

/**
 * A response body as text, refused past `PUBLIC_SUFFIX_MAX_BYTES` or from anywhere but the list's
 * own address.
 *
 * Counted while it arrives, so a body that never ends costs one megabyte rather than the memory of
 * the process. The final address is checked because a redirect is followed silently: the list is
 * trusted for where it comes from, and a redirect to somewhere else is somewhere else. Decoded
 * strictly, so bytes that are not UTF-8 are refused rather than turned into rules.
 */
export async function readPublicSuffixBody(
  response: PublicSuffixResponse,
  maxBytes: number = PUBLIC_SUFFIX_MAX_BYTES
): Promise<string> {
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  if (new URL(response.url).origin !== LIST_ORIGIN) {
    throw new Error(`answered from ${response.url}, not ${LIST_ORIGIN}`)
  }
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength
    if (size > maxBytes) throw new Error(`body larger than ${String(maxBytes)} bytes`)
    chunks.push(chunk)
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
}

/** What the `verify` hook decided about the body it saw, for `#refreshNow` to act on. */
interface Judgement {
  readonly text: string
  readonly sha256: string
  readonly rejections: readonly PublicSuffixRejection[]
  readonly accepted: boolean
}

export class PublicSuffixSubscription {
  readonly #directory: string
  readonly #storeOptions: FilterListStoreOptions
  readonly #toAscii: ToAscii
  readonly #now: () => number
  readonly #warn: (message: string, detail: unknown) => void
  /** Chained for the reason `FilterSubscription.#inFlight` gives. */
  #inFlight: Promise<unknown> = Promise.resolve()

  constructor(options: PublicSuffixSubscriptionOptions) {
    this.#directory = options.directory
    this.#toAscii = options.toAscii
    this.#now = options.now ?? ((): number => Date.now())
    this.#warn = options.warn ?? ((message, detail): void => console.warn(message, detail))
    this.#storeOptions = {
      directory: join(options.directory, LIST_DIRECTORY),
      fetchList: options.fetchList,
      now: this.#now,
      maxAgeMs: PUBLIC_SUFFIX_MAX_AGE_MS
    }
  }

  /**
   * Puts the best list on disk in force, and says which one that was.
   *
   * The cached list first, then the previous good one, then the bootstrap — each checked again,
   * because a file can change on disk between the run that stored it and this one, and a build can
   * be stricter than the one that accepted it. Checked without history: what it was compared
   * against when it arrived is not what is in force now.
   *
   * No list at all is not a warning. It is every first start without a network, and the bootstrap
   * is what the browser has always run on.
   */
  async load(): Promise<PublicSuffixSource> {
    const state = await this.#readState()
    const [cached] = await new FilterListStore(this.#storeOptions).load([PUBLIC_SUFFIX_LIST_URL])
    const candidates: Array<[PublicSuffixSource, string]> = []
    if (cached !== undefined) candidates.push(['list', cached.text])
    if (state.previous !== null) candidates.push(['previous', state.previous.text])

    for (const [source, text] of candidates) {
      const verdict = checkPublicSuffixList(text, this.#toAscii, NO_PUBLIC_SUFFIX_HISTORY)
      if (verdict.list !== null && verdict.rejections.length === 0) {
        if (source === 'previous') {
          this.#warn('[public-suffix] using the previous good list', null)
        }
        configurePublicSuffixes(rulesOf(verdict.list))
        return source
      }
      const which = source === 'list' ? 'stored' : 'previous'
      this.#warn(`[public-suffix] the ${which} list failed its check:`, verdict.rejections)
    }
    if (candidates.length > 0) {
      this.#warn('[public-suffix] no stored list is usable; using the built-in suffixes', null)
    }
    return 'bootstrap'
  }

  /**
   * Downloads a newer list if one is due, and stores it if it passes. Never changes the list in
   * force — see the class comment.
   */
  refresh(): Promise<PublicSuffixRefresh> {
    const next = this.#inFlight.then(() => this.#refreshNow())
    this.#inFlight = next.catch(() => undefined)
    return next
  }

  /** Resolves once no refresh is running; for shutdown, like `FilterSubscription.whenIdle`. */
  async whenIdle(): Promise<void> {
    await this.#inFlight
  }

  async #refreshNow(): Promise<PublicSuffixRefresh> {
    const state = await this.#readState()
    const now = this.#now()
    if (
      state.lastAttemptAt !== null &&
      now - state.lastAttemptAt < PUBLIC_SUFFIX_ATTEMPT_INTERVAL_MS
    ) {
      return { status: 'skipped', rejections: [], reason: null }
    }

    const [cached] = await new FilterListStore(this.#storeOptions).load([PUBLIC_SUFFIX_LIST_URL])
    const inForce: StoredList | null =
      cached === undefined ? null : { text: cached.text, acceptedAt: cached.fetchedAt }
    // Moved up to the list in force once it is a month old — so a slow drift is bounded per month,
    // not per delivery.
    const baseline =
      inForce !== null &&
      (state.baseline === null || now - state.baseline.acceptedAt >= PUBLIC_SUFFIX_BASELINE_MS)
        ? inForce
        : state.baseline
    // Recorded before the request goes out, so an attempt that never returns still counts.
    const attempted: State = { ...state, lastAttemptAt: now, baseline }
    await this.#writeState(attempted)

    const history = {
      current: inForce === null ? null : this.#parse(inForce.text),
      baseline: baseline === null ? null : this.#parse(baseline.text)
    }
    const seen: { judgement: Judgement | null } = { judgement: null }
    const store = new FilterListStore({
      ...this.#storeOptions,
      verify: (text) => {
        const { rejections } = checkPublicSuffixList(text, this.#toAscii, history)
        const digest = sha256(text)
        // The one way past a refusal: only PRIVATE rules lost, and the very same body still being
        // served a week after it was first refused.
        const confirmed =
          isOnlyPrivateLoss(rejections) &&
          state.rejected?.sha256 === digest &&
          now - state.rejected.firstRejectedAt >= PUBLIC_SUFFIX_CONFIRM_MS
        const accepted = rejections.length === 0 || confirmed
        seen.judgement = { text, sha256: digest, rejections, accepted }
        return accepted ? null : `refused: ${rejections.join(', ')}`
      }
    })

    const outcome = (await store.refresh([PUBLIC_SUFFIX_LIST_URL]))[0]!
    const judgement = seen.judgement
    // Nothing reached the check: the copy on disk was young enough, or the download failed.
    if (judgement === null) {
      return {
        status: outcome.status === 'fresh' ? 'fresh' : 'failed',
        rejections: [],
        reason: outcome.reason
      }
    }
    if (!judgement.accepted) {
      const first =
        state.rejected?.sha256 === judgement.sha256 ? state.rejected.firstRejectedAt : now
      await this.#writeState({
        ...attempted,
        rejected: { sha256: judgement.sha256, firstRejectedAt: first }
      })
      this.#warn('[public-suffix] refused a downloaded list:', judgement.rejections)
      return { status: 'rejected', rejections: judgement.rejections, reason: null }
    }
    // Accepted, but the cache could not be written: nothing changed, so the state does not either.
    if (outcome.status !== 'fetched') {
      return { status: 'failed', rejections: [], reason: outcome.reason }
    }
    await this.#writeState({
      ...attempted,
      previous: inForce ?? state.previous,
      baseline: baseline ?? { text: judgement.text, acceptedAt: now },
      rejected: null
    })
    return { status: 'accepted', rejections: judgement.rejections, reason: null }
  }

  #parse(text: string): ReturnType<typeof parsePublicSuffixList> {
    return parsePublicSuffixList(text, this.#toAscii)
  }

  async #readState(): Promise<State> {
    try {
      const parsed = stateSchema.safeParse(
        JSON.parse(await readFile(join(this.#directory, STATE_FILE), 'utf8'))
      )
      // Unusable state is no state: the worst that follows is one download sooner than planned
      // and a baseline taken from the list in force.
      return parsed.success ? parsed.data : EMPTY_STATE
    } catch {
      return EMPTY_STATE
    }
  }

  async #writeState(state: State): Promise<void> {
    await mkdir(this.#directory, { recursive: true })
    await writeFileAtomically(join(this.#directory, STATE_FILE), JSON.stringify(state))
  }
}
