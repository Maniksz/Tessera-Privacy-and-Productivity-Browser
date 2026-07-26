import { z } from 'zod'
import { PERMISSION_TOPICS, subjectTopics, type PermissionSubject } from '@shared/overlay/permission.js'
import {
  MAX_SITE_PERMISSIONS,
  emptyPermissionDocument,
  forgetOrigin,
  forgetfulSitePermissions,
  putSitePermission,
  recallSiteDecision,
  repairSitePermissions,
  type PermissionDocument,
  type SitePermission,
  type SitePermissionRules
} from '../permissions/model.js'
import type { PermissionDecision } from '../session/permission-policy.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
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
const sitePermissionSchema = z.object({
  origin: z.string().min(1),
  topic: z.enum(PERMISSION_TOPICS),
  decision: z.enum(['allow', 'deny']),
  decidedAt: z.number().int().nonnegative()
})

const permissionDocumentSchema = z.object({
  version: z.literal(1),
  sites: z.array(sitePermissionSchema)
})

/**
 * Keeps the schema and the interface from drifting apart in either direction — two assignments per
 * shape, one each way. A single one would only catch drift one way, and the pure model cannot hold
 * the schema itself: `model.ts` is imported by the arbiter, which is unit-tested, and pulling zod
 * into that path buys nothing the store does not already do.
 */
type SchemaSite = z.output<typeof sitePermissionSchema>
type SchemaDocument = z.output<typeof permissionDocumentSchema>

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

export class PermissionStore {
  readonly #store: JsonStore<PermissionDocument>
  readonly #now: () => number
  readonly #maxEntries: number

  private constructor(
    store: JsonStore<PermissionDocument>,
    now: () => number,
    maxEntries: number
  ) {
    this.#store = store
    this.#now = now
    this.#maxEntries = maxEntries
  }

  static async open(options: PermissionStoreOptions): Promise<PermissionStore> {
    const store = await JsonStore.open<PermissionDocument>({
      filePath: options.filePath,
      schema: permissionDocumentSchema,
      fallback: emptyPermissionDocument,
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

  /** Everything remembered, newest first. For a site-settings page and for tests. */
  list(): SitePermission[] {
    return [...this.#store.get().sites]
  }

  /** Number of answers removed, so a caller can report what happened. */
  forget(origin: string): number {
    return this.#replace((sites) => forgetOrigin(sites, origin))
  }

  /** Everything. What a "clear browsing data" run over permissions does. */
  clear(): number {
    return this.#replace(() => [])
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
    const before = this.#store.get().sites.length
    const after = this.#store.update((document) => ({
      ...document,
      sites: remove(document.sites)
    }))
    return before - after.sites.length
  }
}
