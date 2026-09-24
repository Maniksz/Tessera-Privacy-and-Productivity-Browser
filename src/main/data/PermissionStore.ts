import { z } from 'zod'
import {
  PERMISSION_TOPICS,
  subjectTopics,
  type PermissionSubject,
  type PermissionTopic
} from '@shared/overlay/permission.js'
import {
  MAX_SITE_PERMISSIONS,
  emptyPermissionDocument,
  forgetOrigin,
  forgetfulSiteAnswers,
  forgetfulSitePermissions,
  putSitePermission,
  recallSiteDecision,
  repairSitePermissions,
  type PermissionDocument,
  type SiteAnswers,
  type SitePermission,
  type SitePermissionRules
} from '../permissions/model.js'
import type { PermissionDecision } from '../session/permission-policy.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { KnownFields } from '@shared/known-fields.js'
import type { StoreLoadReport, StoreMigrations } from './store-load.js'
import type { BrowsingMode } from './HistoryStore.js'

/**
 * Per-site permission answers (spec 4): what each site was told about its camera, its microphone,
 * its location and everything else it had to ask for.
 *
 * All the rules live in `../permissions/model.ts` as pure functions; this class supplies the clock,
 * decides who may read and write, and puts the result on disk — the division `HistoryStore` and
 * `FaviconStore` use.
 *
 * The file belongs in the user-data directory, never the cache one. An answer is something a person
 * gave, and a disk cleaner emptying it would mean every site asking again — see `permissionsFile()`
 * in `paths.ts`, which keeps that decision.
 *
 * ## Why the whole document goes behind the codec
 *
 * The list of sites that asked for a camera is a list of sites the user visited, in the same sense
 * the history file is. Spec 3 wants every local file encrypted at rest, and the `codec` option is
 * how the caller hands it the same encrypted codec the other stores get.
 */

/**
 * What the file must look like to be usable.
 *
 * Strict about kinds, forgiving about amounts, the line `HistoryStore` draws and for the same
 * reason: a validation failure throws the *whole document* away, so a `.max()` on the array would
 * turn "grew larger than expected" into "every permission answer lost". Duplicates and excess go to
 * `repairSitePermissions` instead.
 *
 * `topic` is an enum rather than a string, and that one *is* worth rejecting the file over: an
 * unrecognised topic is either a file this build cannot understand or an edited one, and neither
 * should be able to leave an entry in the list that nothing will ever match and nothing will ever
 * remove.
 */
const sitePermissionSchema = z.looseObject({
  origin: z.string().min(1),
  topic: z.enum(PERMISSION_TOPICS),
  decision: z.enum(['allow', 'deny']),
  decidedAt: z.number().int().nonnegative()
})

const permissionDocumentSchema = z.looseObject({
  version: z.literal(1),
  sites: z.array(sitePermissionSchema)
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — two assignments per
 * shape, one each way. A single one would only catch drift one way, and the pure model cannot hold
 * the schema itself: `model.ts` is imported by the arbiter, which is unit-tested, and pulling zod
 * into that path buys nothing the store does not already do.
 */
type SchemaSite = KnownFields<z.output<typeof sitePermissionSchema>>
type SchemaDocument = KnownFields<z.output<typeof permissionDocumentSchema>>

const _siteMatchesModel: SchemaSite = null as unknown as SitePermission
const _modelMatchesSite: SitePermission = null as unknown as SchemaSite
const _documentMatchesModel: SchemaDocument = null as unknown as PermissionDocument
const _modelMatchesDocument: PermissionDocument = null as unknown as SchemaDocument
void _siteMatchesModel
void _modelMatchesSite
void _documentMatchesModel
void _modelMatchesDocument

export interface PermissionStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so a stored timestamp does not depend on when the test ran. */
  now?: () => number
  debounceMs?: number
  /** Overridden in tests; defaults to `MAX_SITE_PERMISSIONS`. */
  maxEntries?: number
}

/**
 * The steps up to the version this store writes. Version 1 is the only one there has been; see
 * `StoreMigrations`. Exported for the backup, which refuses a document newer than this (U23, AE8).
 */
export const PERMISSION_MIGRATIONS: StoreMigrations = []

export class PermissionStore {
  readonly #store: JsonStore<PermissionDocument>
  readonly #now: () => number
  readonly #maxEntries: number

  private constructor(store: JsonStore<PermissionDocument>, now: () => number, maxEntries: number) {
    this.#store = store
    this.#now = now
    this.#maxEntries = maxEntries
  }

  static async open(options: PermissionStoreOptions): Promise<PermissionStore> {
    const store = await JsonStore.open<PermissionDocument>({
      filePath: options.filePath,
      schema: permissionDocumentSchema,
      fallback: emptyPermissionDocument,
      migrations: PERMISSION_MIGRATIONS,
      criticality: 'degradable',
      // A file written by an older build, edited by hand or cut short by a crash must not leave
      // two answers for one question: the read path takes the first match, so the duplicate would
      // decide silently — and it is the *stale* one that tends to come first.
      repair: (document) => ({
        ...document,
        sites: repairSitePermissions(document.sites, options.maxEntries)
      }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new PermissionStore(
      store,
      options.now ?? (() => Date.now()),
      options.maxEntries ?? MAX_SITE_PERMISSIONS
    )
  }

  /**
   * The only way to reach a site's answers, and it cannot be reached without saying which kind of
   * session it is for.
   *
   * A private window gets `forgetfulSitePermissions`: an object with no reference to this store, so
   * a private window physically holds no path to the file rather than holding one it is expected to
   * leave alone. That is the difference between an invariant and a convention — no call site can
   * forget a check it does not have to make, and a `remember` call added anywhere in that window's
   * code inherits the guarantee for free.
   *
   * Reading is behind this seam too, unlike `HistoryStore.query` and `FaviconStore.find`. A stored
   * "allow the camera" honoured in a private window would hand a site the camera with no prompt, on
   * the strength of a decision taken in the mode whose whole point is not being the same visitor.
   * So a private window is asked every time.
   */
  rulesFor(mode: BrowsingMode): SitePermissionRules {
    if (mode === 'private') return forgetfulSitePermissions
    return {
      recall: (origin: string, subject: PermissionSubject) => this.#recall(origin, subject),
      remember: (origin: string, subject: PermissionSubject, decision: 'allow' | 'deny') => {
        this.#remember(origin, subject, decision)
      }
    }
  }

  /**
   * The stored answers for the site menu behind the lock (U19), bound to a browsing mode.
   *
   * A private window gets `forgetfulSiteAnswers`, which lists nothing and forgets nothing, for the
   * reason `rulesFor` gives: the window holds no path to this file, so it can neither show the normal
   * profile's answers nor remove one of them.
   */
  answersFor(mode: BrowsingMode): SiteAnswers {
    if (mode === 'private') return forgetfulSiteAnswers
    return {
      list: () => this.list(),
      forget: (origin, topics) => this.forget(origin, topics)
    }
  }

  /** Everything remembered, newest first. The site menu reads it through `answersFor`. */
  list(): SitePermission[] {
    return [...this.#store.get().sites]
  }

  /**
   * Number of answers removed, so a caller can report what happened.
   *
   * Every topic for the origin, or only the named ones — the site menu names them, because it leaves
   * camera, microphone and screen answers alone. See `forgetOrigin`.
   */
  forget(origin: string, topics?: readonly PermissionTopic[]): number {
    return this.#replace((sites) => forgetOrigin(sites, origin, topics))
  }

  /** Everything. What a "clear browsing data" run over permissions does. */
  clear(): number {
    return this.#replace(() => [])
  }

  /** The file given up for good, for panic; see `JsonStore.abandon`. */
  abandon(): Promise<void> {
    return this.#store.abandon()
  }

  onChange(listener: (sites: SitePermission[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.sites]))
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  /** What opening the file found, for the warning `index.ts` logs. See `describeStoreLoad`. */
  get loadReport(): StoreLoadReport {
    return this.#store.loadReport
  }

  #recall(origin: string, subject: PermissionSubject): PermissionDecision {
    return recallSiteDecision(this.#store.get().sites, origin, subject)
  }

  /**
   * Writes one answer, one entry per atomic permission.
   *
   * A combined camera-and-microphone grant becomes *two* entries, which is what makes a later
   * camera-only request from the same site find its answer instead of prompting again.
   */
  #remember(origin: string, subject: PermissionSubject, decision: 'allow' | 'deny'): void {
    const decidedAt = this.#now()
    this.#store.update((document) => {
      let sites = document.sites
      for (const topic of subjectTopics(subject)) {
        sites = putSitePermission(sites, { origin, topic, decision, decidedAt }, this.#maxEntries)
      }
      return { ...document, sites }
    })
  }

  /**
   * Applies a removal and reports how many entries went.
   *
   * Counted by difference rather than by the pure functions reporting it, for the reason
   * `HistoryStore` gives: every one of them would have to carry a count through, and the store
   * already holds both lists.
   */
  #replace(remove: (sites: readonly SitePermission[]) => SitePermission[]): number {
    const current = this.#store.get().sites
    const kept = remove(current)
    // The same array back means nothing matched: no write, no change event.
    if (kept === current) return 0
    const after = this.#store.update((document) => ({ ...document, sites: kept }))
    return current.length - after.sites.length
  }
}
