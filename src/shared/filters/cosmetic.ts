import { hostMatchesRule } from '../url/domain.js'
import {
  EMPTY_GENERIC_FEATURE_INDEX,
  GenericFeatureCursor,
  buildGenericFeatureIndex,
  type DocumentFeatures,
  type GenericFeatureIndex
} from './features.js'
import type { CosmeticRule } from './model.js'

/**
 * Cosmetic filtering: which CSS selectors should be hidden on a given host.
 *
 * The query is the deliverable here; the injection into the page is somebody
 * else's. What the split has to get right is the shape of the answer, and the
 * numbers force it. The three default lists carry 47 299 cosmetic rules, and
 * 28 916 of those are **generic** — they name no host and so apply everywhere.
 * Written out as one stylesheet that is 526 kB of selector text on every page
 * load, against 414 kB for every host-specific selector in all three lists
 * combined.
 *
 * So the answer is split. `specific` is what this host's own rules ask for: small,
 * and safe to inject wholesale the moment a document commits. `generic` is the
 * everywhere-set, returned separately and deliberately unmerged, because an
 * injector that hands all of it to every page has made a performance decision
 * nobody asked it to make. What uBlock Origin does instead is survey the classes
 * and ids actually present in the document and inject only the generic selectors
 * keyed to them; `genericFeatures` is that keying, and `openCosmeticFeed` is the
 * incremental query over it.
 */

export interface CosmeticIndex {
  /** Host or parent domain -> rules a `host##selector` line scoped to it. */
  readonly byHost: ReadonlyMap<string, readonly CosmeticRule[]>
  /** Selectors from rules that name no host, with no exclusions to weigh. */
  readonly generic: readonly string[]
  /** Generic rules carrying `~host` exclusions; few, and filtered per query. */
  readonly genericExcluding: readonly CosmeticRule[]
  /**
   * The subset of `genericExcluding` whose selector the unconditional set does not
   * already carry.
   *
   * A rule that repeats a selector already generic everywhere adds nothing — the
   * broader rule applies on the excluded host too — and a feed built from both would
   * hand a page the same selector twice. Computed once here rather than per document,
   * because it needs the whole generic set to answer and that set is 28 914 strings.
   */
  readonly genericExcludingExtra: readonly CosmeticRule[]
  /** `host#@#selector` — selectors cancelled for the hosts they name. */
  readonly exceptionsByHost: ReadonlyMap<string, ReadonlySet<string>>
  /** `#@#selector` with no host: cancelled everywhere. */
  readonly globalExceptions: ReadonlySet<string>
  /** `generic`, keyed by the class, id or tag each selector needs present. */
  readonly genericFeatures: GenericFeatureIndex
  readonly ruleCount: number
}

export interface CosmeticSelectors {
  /** Rules that named this host: few, and safe to inject the moment a page commits. */
  readonly specific: readonly string[]
  /** Rules that name no host, so they apply everywhere. Tens of thousands. */
  readonly generic: readonly string[]
}

/**
 * A host and the parent domains a rule could have been written against.
 *
 * `a.b.example.com` yields itself, `b.example.com` and `example.com`. The bare
 * public suffix is left out: `com##…` is not a rule anybody means, and stopping
 * short of it saves a lookup on every query.
 */
export function hostChain(hostname: string): readonly string[] {
  const host = hostname.toLowerCase()
  if (host === '') return []
  const labels = host.split('.')
  const chain: string[] = [host]
  for (let start = 1; start <= labels.length - 2; start++) {
    chain.push(labels.slice(start).join('.'))
  }
  return chain
}

function pushInto(map: Map<string, CosmeticRule[]>, key: string, rule: CosmeticRule): void {
  const existing = map.get(key)
  if (existing === undefined) map.set(key, [rule])
  else existing.push(rule)
}

export function buildCosmeticIndex(rules: readonly CosmeticRule[]): CosmeticIndex {
  const byHost = new Map<string, CosmeticRule[]>()
  const generic: string[] = []
  const genericExcluding: CosmeticRule[] = []
  const exceptionsByHost = new Map<string, Set<string>>()
  const globalExceptions = new Set<string>()

  for (const rule of rules) {
    if (rule.isException) {
      if (rule.includeHosts.length === 0) {
        globalExceptions.add(rule.selector)
        continue
      }
      for (const host of rule.includeHosts) {
        const existing = exceptionsByHost.get(host)
        if (existing === undefined) exceptionsByHost.set(host, new Set([rule.selector]))
        else existing.add(rule.selector)
      }
      continue
    }
    if (rule.includeHosts.length === 0) {
      // Split by whether exclusions have to be weighed at query time, so the
      // common case can hand back a precomputed array instead of filtering
      // 28 916 rules on every document.
      if (rule.excludeHosts.length === 0) generic.push(rule.selector)
      else genericExcluding.push(rule)
      continue
    }
    for (const host of rule.includeHosts) pushInto(byHost, host, rule)
  }

  const unconditional = new Set(generic)
  return {
    byHost,
    generic,
    genericExcluding,
    genericExcludingExtra: genericExcluding.filter((rule) => !unconditional.has(rule.selector)),
    exceptionsByHost,
    globalExceptions,
    genericFeatures: buildGenericFeatureIndex(generic),
    ruleCount: rules.length
  }
}

function isExcluded(rule: CosmeticRule, hostname: string): boolean {
  return rule.excludeHosts.some((host) => hostMatchesRule(hostname, host))
}

/**
 * Selectors a `#@#` exception cancels on this host, from every rule that names it or
 * one of its parent domains, plus the ones cancelled everywhere.
 *
 * Split out of `cosmeticSelectorsFor` because the incremental feed needs the same
 * answer, and because a second implementation of "which selectors are cancelled here"
 * is the kind of duplicate that drifts apart quietly.
 */
export function cancelledSelectorsFor(index: CosmeticIndex, hostname: string): ReadonlySet<string> {
  let cancelled: ReadonlySet<string> = index.globalExceptions
  for (const host of hostChain(hostname)) {
    const scoped = index.exceptionsByHost.get(host)
    if (scoped === undefined) continue
    const merged = new Set(cancelled)
    for (const selector of scoped) merged.add(selector)
    cancelled = merged
  }
  return cancelled
}

/**
 * The selectors that apply to `hostname`, split into host-specific and generic.
 *
 * A `#@#` exception cancels its selector rather than the rule that produced it,
 * which is what the syntax means: one list adds `##.ad-slot` and another says it
 * breaks a particular site, and neither knows about the other.
 */
export function cosmeticSelectorsFor(index: CosmeticIndex, hostname: string): CosmeticSelectors {
  const chain = hostChain(hostname)
  const cancelled = cancelledSelectorsFor(index, hostname)

  const specific: string[] = []
  for (const host of chain) {
    const rules = index.byHost.get(host)
    if (rules === undefined) continue
    for (const rule of rules) {
      if (cancelled.has(rule.selector) || isExcluded(rule, hostname)) continue
      specific.push(rule.selector)
    }
  }

  const excepted = index.genericExcluding
    .filter((rule) => !cancelled.has(rule.selector) && !isExcluded(rule, hostname))
    .map((rule) => rule.selector)
  const base =
    cancelled.size === 0
      ? index.generic
      : index.generic.filter((selector) => !cancelled.has(selector))
  const generic = excepted.length === 0 ? base : [...base, ...excepted]

  return { specific, generic }
}

/**
 * A stylesheet that hides the given selectors, or null when there is nothing to
 * hide.
 *
 * `!important` because the point is to beat a page's own rule, and `display: none`
 * rather than `visibility` so the element takes no space — a hidden ad slot that
 * still reserves 250 pixels is not much of an improvement.
 */
export function cosmeticCss(selectors: readonly string[]): string | null {
  if (selectors.length === 0) return null
  return `${selectors.join(',\n')} { display: none !important; }`
}

/**
 * One document's incremental view of the generic selectors.
 *
 * Held by whoever injects, for as long as that document lives, and dropped when it
 * navigates. Everything host-dependent — which selectors an exception cancels here,
 * which `~host` generic rules apply — is settled when the feed opens, so a survey
 * arriving mid-page costs two map lookups per feature and nothing else.
 */
export interface CosmeticFeed {
  /** Selectors for features not asked about before; empty means nothing new. */
  take(features: DocumentFeatures): readonly string[]
  readonly servedSelectorCount: number
  readonly servedByteCount: number
}

class HostCosmeticFeed implements CosmeticFeed {
  readonly #cursors: readonly GenericFeatureCursor[]
  readonly #cancelled: ReadonlySet<string>
  #selectorCount = 0
  #byteCount = 0

  constructor(cursors: readonly GenericFeatureCursor[], cancelled: ReadonlySet<string>) {
    this.#cursors = cursors
    this.#cancelled = cancelled
  }

  take(features: DocumentFeatures): readonly string[] {
    const selectors: string[] = []
    for (const cursor of this.#cursors) {
      for (const selector of cursor.take(features)) {
        // Cancelled selectors are filtered here rather than removed from the index,
        // because the index is shared by every document and the cancellation is not.
        if (this.#cancelled.has(selector)) continue
        selectors.push(selector)
        this.#byteCount += selector.length + 2
      }
    }
    this.#selectorCount += selectors.length
    return selectors
  }

  get servedSelectorCount(): number {
    return this.#selectorCount
  }

  get servedByteCount(): number {
    return this.#byteCount
  }
}

export function openCosmeticFeed(index: CosmeticIndex, hostname: string): CosmeticFeed {
  // Generic rules with `~host` exclusions have to be resolved against this host
  // before they can be keyed, so they get an index of their own rather than a place in
  // the one every document shares. EasyList and EasyPrivacy carry none at all, and
  // building this is a per-document cost, so the empty case is worth not paying for.
  const applicable = index.genericExcludingExtra
    .filter((rule) => !isExcluded(rule, hostname))
    .map((rule) => rule.selector)
  const extra: GenericFeatureIndex =
    applicable.length === 0 ? EMPTY_GENERIC_FEATURE_INDEX : buildGenericFeatureIndex(applicable)

  return new HostCosmeticFeed(
    [new GenericFeatureCursor(index.genericFeatures), new GenericFeatureCursor(extra)],
    cancelledSelectorsFor(index, hostname)
  )
}
