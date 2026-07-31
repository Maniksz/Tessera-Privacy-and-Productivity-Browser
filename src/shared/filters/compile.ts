import { buildCosmeticIndex, type CosmeticIndex } from './cosmetic.js'
import type { FilterListDiagnostics } from './model.js'
import { buildNetworkIndex, type NetworkIndex } from './network.js'
import { parseFilterLists } from './parse.js'
import { buildScriptletIndex, type ScriptletIndex } from './scriptlets.js'
import { buildProceduralIndex, type ProceduralIndex } from './procedural-index.js'

/**
 * One step from downloaded list bodies to the indexes the engine queries.
 *
 * Kept apart from each half so none has to know about the others: the network matcher never sees a
 * selector, the cosmetic query never sees a token, and the scriptlet index never sees either.
 */

export interface CompiledFilters {
  readonly network: NetworkIndex
  readonly cosmetic: CosmeticIndex
  /** `##+js(…)` rules, keyed by host. A third index rather than a flavour of the cosmetic one. */
  readonly scriptlet: ScriptletIndex
  /** Rules needing the procedural engine, keyed by host — which they are all required to name. */
  readonly procedural: ProceduralIndex
  readonly diagnostics: FilterListDiagnostics
}

export function compileFilterLists(texts: readonly string[]): CompiledFilters {
  const parsed = parseFilterLists(texts)
  return {
    network: buildNetworkIndex(parsed.network),
    cosmetic: buildCosmeticIndex(parsed.cosmetic),
    scriptlet: buildScriptletIndex(parsed.scriptlet),
    procedural: buildProceduralIndex(parsed.procedural),
    diagnostics: parsed.diagnostics
  }
}
