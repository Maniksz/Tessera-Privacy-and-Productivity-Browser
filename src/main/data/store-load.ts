import type { z } from 'zod'

/**
 * What loading a store's file decides, once the bytes are decoded: which of four things the file is,
 * and what the store may do about it.
 *
 * ## Why this is a module of its own
 *
 * `JsonStore.open` used to know two outcomes — the document validates, or it does not and defaults
 * are taken — and the second was a trap in both of the ways it could be reached. One entry of the wrong
 * shape threw the whole document away and the next write replaced the file with defaults. And a file
 * a newer Tessera had written with `version: 2` failed `z.literal(1)` like any corrupt file did, so
 * running an older build after a newer one destroyed the data both of them were meant to keep.
 *
 * The four outcomes here keep those apart:
 *
 *   - **current** — the version this build writes. Parsed, and used.
 *   - **migrated** — an older version, brought up to this one by the store's own chain of migrations
 *     before the schema is asked. The store keeps the original as `<file>.v<N>.bak` before it writes.
 *   - **newer** — a version this build does not know. Never written: the store is read-only for the
 *     run. A *critical* store (passwords, bookmarks) shows what the current schema can read of it; a
 *     *degradable* one (everything else) runs on defaults and says that this run's changes are lost.
 *   - **invalid** — not a document this build can interpret at any version. The store copies it
 *     aside as `<file>.unreadable` before anything replaces it.
 *
 * All of it decided here, on `unknown`, with no file system in sight, so every branch is reachable
 * from a test that hands in a value. `JsonStore` does the reading, the copying and the writing; this
 * says which of them to do.
 *
 * ## Tolerant entries
 *
 * The contract a store with one list of entries worth keeping individually — passwords, bookmarks —
 * uses so that one broken entry costs that entry and not the document. The envelope stays strict; the
 * named list is parsed entry by entry, and an entry that fails is kept *raw*, with its original index,
 * to be written back exactly where it was (`splitEntries`, `restoreEntries`). Raw entries are data this
 * build cannot interpret, so they never reach anything a user can act on — no autofill, no export, no
 * search. See `TolerantEntries`.
 */

/**
 * How much of a store's data this build may give up to a file it cannot write back.
 *
 * `critical` for what a user made and cannot get back — saved passwords and bookmarks. Their readable
 * part is shown even from a newer file, and every write is refused rather than kept in memory and lost,
 * because "your new bookmark was accepted and then silently discarded at exit" is worse than "this
 * profile is read-only in this version". `degradable` for everything the browser recorded or can
 * recreate — history, caches, the session, settings-like lists — which run on defaults instead.
 */
export type StoreCriticality = 'degradable' | 'critical'

/**
 * One step up: a document of version `n`, as decoded and with every field it had, to the document
 * version `n + 1` expects.
 *
 * Takes the whole object rather than a parsed one, because the point of migrating first is that the
 * current schema cannot read it yet. May throw; a step that throws makes the file `invalid`, which
 * copies it aside rather than losing it.
 */
export type StoreMigration = (document: Readonly<Record<string, unknown>>) => unknown

/**
 * A store's migrations, oldest first: entry `0` turns version 1 into 2, entry `1` turns 2 into 3.
 *
 * The version this build writes is therefore `migrations.length + 1`, and deliberately not a second
 * number beside the list. A separate `current` could disagree with the chain — a step added, the number
 * forgotten — and the file that disagreement misreads is the user's. Every store is at version 1 today,
 * so every chain is empty; a store moving to 2 appends one function and changes its schema's literal.
 */
export type StoreMigrations = readonly StoreMigration[]

/** The version a store writes, given its chain. See `StoreMigrations`. */
export function currentVersionOf(migrations: StoreMigrations): number {
  return migrations.length + 1
}

/**
 * The list a store parses entry by entry.
 *
 * `field` names the array in the document; `entry` is the schema one element must pass. It should be
 * the same schema the document's own array uses, so an entry this accepts is one the envelope accepts
 * too.
 */
export interface TolerantEntries {
  readonly field: string
  readonly entry: z.ZodType
}

/** An entry that failed its schema, exactly as it was stored, and where it was. */
export interface UnreadableEntry {
  readonly index: number
  readonly value: unknown
}

export interface StoreLoadSpec<T> {
  readonly schema: z.ZodType<T>
  readonly migrations: StoreMigrations
  readonly criticality: StoreCriticality
  readonly tolerant?: TolerantEntries
}

/** What `settleStoreDocument` found. `unreadable` is empty unless the spec names `tolerant` entries. */
export type SettledDocument<T> =
  | {
      readonly kind: 'current'
      readonly document: T
      readonly unreadable: readonly UnreadableEntry[]
    }
  | {
      readonly kind: 'migrated'
      readonly document: T
      readonly fromVersion: number
      readonly unreadable: readonly UnreadableEntry[]
    }
  | {
      readonly kind: 'newer'
      readonly version: number
      /**
       * What this build's schema can read of it, for a critical store; `null` for a degradable one,
       * or when not even the envelope is readable.
       */
      readonly readable: T | null
      readonly unreadable: readonly UnreadableEntry[]
    }
  | { readonly kind: 'invalid'; readonly reason: string }

/**
 * Decides what a decoded document is. Pure: reads nothing, writes nothing, throws nothing.
 *
 * The version is read before the schema is asked, which is the whole difference from what `JsonStore`
 * did before: `z.literal(1)` cannot tell "written by a newer build" from "not ours", and those two need
 * opposite treatment — one must be left alone, the other may be replaced once a copy exists.
 */
export function settleStoreDocument<T>(
  decoded: unknown,
  spec: StoreLoadSpec<T>
): SettledDocument<T> {
  if (!isRecord(decoded)) return { kind: 'invalid', reason: 'the file does not hold a JSON object' }
  const version = decoded['version']
  if (!isVersion(version)) {
    return { kind: 'invalid', reason: 'the file carries no usable version number' }
  }

  const current = currentVersionOf(spec.migrations)
  if (version > current) {
    /*
      Read as far as the current schema reads it, and for a critical store only.

      The version is replaced for the parse and nowhere else: nothing read here is written back, so the
      claim "this is a version-1 document" never reaches the disk. A degradable store runs on defaults
      because a half-understood history or session is not worth the risk of acting on it; a critical
      one shows what it can because a user who opens an older build must not believe their passwords
      are gone.
    */
    if (spec.criticality === 'degradable')
      return { kind: 'newer', version, readable: null, unreadable: [] }
    const parsed = parseDocument({ ...decoded, version: current }, spec)
    return parsed.ok
      ? { kind: 'newer', version, readable: parsed.document, unreadable: parsed.unreadable }
      : { kind: 'newer', version, readable: null, unreadable: [] }
  }

  let document: Record<string, unknown> = decoded
  for (let from = version; from < current; from += 1) {
    // `from - 1` is always in range: `version` is at least 1 and `from` stays below `current`.
    const step = spec.migrations[from - 1]!
    let next: unknown
    try {
      next = step(document)
    } catch (error) {
      return {
        kind: 'invalid',
        reason: `the migration from version ${from} failed: ${String(error)}`
      }
    }
    if (!isRecord(next)) {
      return { kind: 'invalid', reason: `the migration from version ${from} produced no object` }
    }
    document = next
  }

  const parsed = parseDocument(document, spec)
  if (!parsed.ok) return { kind: 'invalid', reason: parsed.reason }
  return version === current
    ? { kind: 'current', document: parsed.document, unreadable: parsed.unreadable }
    : {
        kind: 'migrated',
        document: parsed.document,
        fromVersion: version,
        unreadable: parsed.unreadable
      }
}

type Parsed<T> =
  | { readonly ok: true; readonly document: T; readonly unreadable: readonly UnreadableEntry[] }
  | { readonly ok: false; readonly reason: string }

function parseDocument<T>(document: Record<string, unknown>, spec: StoreLoadSpec<T>): Parsed<T> {
  let candidate = document
  let unreadable: readonly UnreadableEntry[] = []
  const tolerant = spec.tolerant
  const values = tolerant === undefined ? undefined : document[tolerant.field]
  // Only an array is split. Anything else in that field is an envelope the schema must reject whole —
  // there are no entries to keep one by one in a string.
  if (tolerant !== undefined && Array.isArray(values)) {
    const split = splitEntries(values, tolerant.entry)
    candidate = { ...document, [tolerant.field]: split.readable }
    unreadable = split.unreadable
  }
  const parsed = spec.schema.safeParse(candidate)
  if (!parsed.success) return { ok: false, reason: describeIssues(parsed.error.issues) }
  return { ok: true, document: parsed.data, unreadable }
}

/**
 * Separates the entries one schema accepts from the ones it does not.
 *
 * `readable` holds the entries *as stored*, not as parsed: the envelope's own schema parses them next,
 * and parsing twice would apply defaults and transforms twice. `unreadable` holds the rest with their
 * index in the original list, which is what `restoreEntries` puts them back at.
 */
export function splitEntries(
  values: readonly unknown[],
  entry: z.ZodType
): { readonly readable: unknown[]; readonly unreadable: UnreadableEntry[] } {
  const readable: unknown[] = []
  const unreadable: UnreadableEntry[] = []
  values.forEach((value, index) => {
    if (entry.safeParse(value).success) readable.push(value)
    else unreadable.push({ index, value })
  })
  return { readable, unreadable }
}

/**
 * The list to write: the store's current entries with the unreadable ones put back.
 *
 * Each goes back at its original index, or at the end when the list has since become shorter. In
 * ascending order, so that with nothing changed the result is the list that was read — an entry this
 * build could not interpret round-trips byte for byte, which is the promise that makes keeping it worth
 * anything.
 */
export function restoreEntries(
  entries: readonly unknown[],
  unreadable: readonly UnreadableEntry[]
): unknown[] {
  const result = [...entries]
  const ordered = [...unreadable].sort((a, b) => a.index - b.index)
  for (const { index, value } of ordered) result.splice(Math.min(index, result.length), 0, value)
  return result
}

/**
 * What a store reports about its load, for the warning at startup and for the vault's status.
 *
 * `backup` and `copy` are the paths of the preserved original, or `null` when making it failed — which
 * is precisely the case in which the store stays read-only, because writing without the copy would be
 * the loss this whole module exists to prevent.
 */
export type StoreLoadOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'current' }
  | { readonly kind: 'migrated'; readonly fromVersion: number; readonly backup: string | null }
  | { readonly kind: 'newer'; readonly version: number }
  | { readonly kind: 'invalid'; readonly reason: string; readonly copy: string | null }

export interface StoreLoadReport {
  readonly outcome: StoreLoadOutcome
  readonly criticality: StoreCriticality
}

/**
 * Whether the store must not write this run.
 *
 * Three cases, one rule: the original is not safe yet. A newer file is never ours to change; a
 * migration or a replacement whose copy could not be made would overwrite the only one.
 */
export function isReadOnlyLoad(outcome: StoreLoadOutcome): boolean {
  switch (outcome.kind) {
    case 'newer':
      return true
    case 'migrated':
      return outcome.backup === null
    case 'invalid':
      return outcome.copy === null
    default:
      return false
  }
}

/**
 * The one line `index.ts` logs about a store's load, or `null` when there is nothing to say.
 *
 * Here rather than written out beside each store in `index.ts`, so the dozen stores cannot say a dozen
 * slightly different things about the same situation, and so the sentence about what happens to this
 * run's changes is decided by the store's criticality rather than remembered per call site.
 */
export function describeStoreLoad(report: StoreLoadReport): string | null {
  const { outcome } = report
  const refused =
    report.criticality === 'critical'
      ? 'it is read-only in this run and changes are refused'
      : 'changes made in this run are discarded'
  switch (outcome.kind) {
    case 'newer':
      return `the file was written by a newer version (version ${outcome.version}) and is left untouched; ${refused}`
    case 'migrated':
      return outcome.backup === null
        ? `the file was upgraded from version ${outcome.fromVersion} in memory, but no backup could be made; ${refused}`
        : `the file was upgraded from version ${outcome.fromVersion}; the original is kept at ${outcome.backup}`
    case 'invalid':
      return outcome.copy === null
        ? `the file could not be used (${outcome.reason}) and could not be copied aside; started from defaults, and ${refused}`
        : `the file could not be used (${outcome.reason}); started from defaults, the original is kept at ${outcome.copy}`
    default:
      return null
  }
}

/**
 * The one line about a store's load, when there is one: a newer version's file left alone, an older
 * one upgraded, a broken one copied aside — and whether this run's changes will be kept.
 *
 * Next to every store's own `recoveredFromInvalidFile` warning rather than instead of it: that one says
 * what the store lost, this one says where the original is and what the run may write. Moved here from
 * `index.ts` beside the sentence it logs (U23 made room in that file this way).
 */
export function warnAboutStoreLoad(label: string, report: StoreLoadReport): void {
  const message = describeStoreLoad(report)
  if (message !== null) console.warn(`[${label}] ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}

function describeIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
}
