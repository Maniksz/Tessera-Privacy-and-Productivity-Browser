import { buildCosmeticIndex, type CosmeticIndex } from './cosmetic.js'
import type { FilterListDiagnostics } from './model.js'
import { buildNetworkIndex, type NetworkIndex } from './network.js'
import { parseFilterLists } from './parse.js'

/**
 * One step from downloaded list bodies to the two indexes the engine queries.
 *
 * Kept apart from both halves so neither has to know about the other: the network
 * matcher never sees a selector and the cosmetic query never sees a token.
 */

export interface CompiledFilters {
  readonly network: NetworkIndex
  readonly cosmetic: CosmeticIndex
  readonly diagnostics: FilterListDiagnostics
}

export function compileFilterLists(texts: readonly string[]): CompiledFilters {
  const parsed = parseFilterLists(texts)
  return {
    network: buildNetworkIndex(parsed.network),
    cosmetic: buildCosmeticIndex(parsed.cosmetic),
    diagnostics: parsed.diagnostics
  }
}
