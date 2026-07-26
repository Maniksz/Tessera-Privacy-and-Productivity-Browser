import type { MaskingPlan } from './plan.js'

/**
 * The masking plan on the wire: the channel it travels on, and how to recognise one.
 *
 * Split out of `plan.ts` to keep a table of public suffixes out of the preload bundle. The preload
 * needs exactly these two things — it asks the core for a plan and checks the reply — but importing
 * them from `plan.ts` pulled in `seed.ts`, which needs `registrableDomain` to derive a per-site seed,
 * which carries the whole eTLD list. Around four kilobytes of parse work in every renderer, for a
 * table the preload never consults.
 *
 * `MaskingPlan` is imported as a *type*, so nothing follows it at runtime. Computing a plan and
 * describing one are different concerns anyway, and only the core does the former.
 */

/** The channel a renderer asks for its plan on. Not in `channels.ts`: it is `sendSync`, not invoke. */
export const FINGERPRINT_PLAN_CHANNEL = 'tessera:fingerprint-plan'

/**
 * Whether an IPC reply is a plan this build understands.
 *
 * The reply comes from our own core over a channel no page can reach, so this is
 * not a trust boundary — it is a totality boundary. `sendSync` answers
 * `undefined` when nothing is listening, and that has to lead to "no masking"
 * rather than to a thrown error inside a preload, which would take the whole page
 * with it.
 */
export function isMaskingPlan(value: unknown): value is MaskingPlan {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (candidate['version'] !== 1) return false
  return (
    isObjectOrNull(candidate['userAgent']) &&
    isObjectOrNull(candidate['locale']) &&
    isStringOrNull(candidate['timeZone']) &&
    isObjectOrNull(candidate['canvas']) &&
    isObjectOrNull(candidate['webgl']) &&
    isObjectOrNull(candidate['audio']) &&
    isObjectOrNull(candidate['fonts']) &&
    isObjectOrNull(candidate['screen']) &&
    isObjectOrNull(candidate['devices'])
  )
}

function isObjectOrNull(value: unknown): boolean {
  return value === null || typeof value === 'object'
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string'
}
