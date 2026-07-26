import type { z } from 'zod'
import {
  SETTINGS_KEYS,
  appliesOf,
  sectionOf,
  settingDefinitions,
  type SettingsKey
} from '@shared/settings/definitions.js'
import type { SettingControlKind, SettingDescriptor } from '@shared/settings/control.js'

/**
 * Derives how each setting should be presented, from the schema that already defines
 * it.
 *
 * This exists so the settings UI needs no second table. `definitions.ts` stays the
 * single source of truth (spec 5); the renderer receives plain descriptors over IPC
 * and never imports zod (which is what put half a megabyte in the UI bundle once —
 * see `docs/solutions/performance-issues/`).
 *
 * Reading a schema's shape means touching zod's `def`, which is public but not a
 * stability promise. Every read is therefore defensive: an unrecognised shape becomes
 * `unsupported` and is rendered read-only rather than crashing the settings page. A
 * zod upgrade that changes these names degrades the UI; it does not break the browser.
 */

/** Minimal structural view of the parts of a zod definition this file reads. */
interface ZodDefView {
  type?: string
  entries?: Record<string, unknown>
  checks?: Array<{ _zod?: { def?: ZodCheckView } }>
  element?: unknown
}

interface ZodCheckView {
  check?: string
  format?: string
  value?: unknown
  inclusive?: boolean
}

function defOf(schema: z.ZodType): ZodDefView {
  // `def` is zod's public accessor; `_def` is the older spelling. Either may be
  // absent on a future version, which is what the empty fallback is for.
  const candidate = schema as unknown as { def?: ZodDefView; _def?: ZodDefView }
  return candidate.def ?? candidate._def ?? {}
}

function checksOf(schema: z.ZodType): ZodCheckView[] {
  const inner = (schema as unknown as { _zod?: { def?: ZodDefView } })._zod?.def
  const checks = inner?.checks ?? defOf(schema).checks ?? []
  return checks
    .map((entry) => entry._zod?.def)
    .filter((entry): entry is ZodCheckView => entry !== undefined)
}

function elementTypeOf(schema: z.ZodType): string | undefined {
  const element = defOf(schema).element
  if (element === undefined || element === null) return undefined
  return defOf(element as z.ZodType).type
}

function kindOf(schema: z.ZodType): SettingControlKind {
  switch (defOf(schema).type) {
    case 'boolean':
      return 'toggle'
    case 'enum':
      return 'choice'
    case 'number':
      return 'number'
    case 'string':
      return 'text'
    case 'array':
      // Only arrays of plain strings get an editable list; anything else would need
      // a bespoke editor and is safer read-only.
      return elementTypeOf(schema) === 'string' || elementTypeOf(schema) === 'enum'
        ? 'text-list'
        : 'unsupported'
    case 'record':
      return 'map'
    default:
      return 'unsupported'
  }
}

function choicesOf(schema: z.ZodType): string[] | undefined {
  const inner = (schema as unknown as { _zod?: { def?: ZodDefView } })._zod?.def
  const entries = inner?.entries ?? defOf(schema).entries
  if (entries === undefined) return undefined
  // Zod stores enum members as a value->value map; the keys are the members.
  const values = Object.keys(entries)
  return values.length > 0 ? values : undefined
}

interface NumberBounds {
  min?: number
  max?: number
  integer?: boolean
}

function boundsOf(schema: z.ZodType): NumberBounds {
  const bounds: NumberBounds = {}
  for (const check of checksOf(schema)) {
    if (check.check === 'greater_than' && typeof check.value === 'number') {
      // `inclusive` distinguishes `min(30)` from `gt(30)`.
      bounds.min = check.inclusive === false ? check.value + 1 : check.value
    }
    if (check.check === 'less_than' && typeof check.value === 'number') {
      bounds.max = check.inclusive === false ? check.value - 1 : check.value
    }
    if (check.check === 'number_format' && check.format?.includes('int') === true) {
      bounds.integer = true
    }
  }
  return bounds
}

/** Describes one setting. */
export function describeSetting(key: SettingsKey): SettingDescriptor {
  const schema = settingDefinitions[key].schema
  const kind = kindOf(schema)

  const descriptor: SettingDescriptor = {
    key,
    section: sectionOf(key),
    applies: appliesOf(key),
    kind
  }

  if (kind === 'choice') {
    const choices = choicesOf(schema)
    // An enum whose members cannot be read is worse than a read-only field: a select
    // with no options would silently offer nothing.
    if (choices === undefined) return { ...descriptor, kind: 'unsupported' }
    descriptor.choices = choices
  }

  if (kind === 'number') {
    const bounds = boundsOf(schema)
    if (bounds.min !== undefined) descriptor.min = bounds.min
    if (bounds.max !== undefined) descriptor.max = bounds.max
    if (bounds.integer !== undefined) descriptor.integer = bounds.integer
  }

  if (kind === 'text-list') {
    const choices = choicesOf(defOf(schema).element as z.ZodType)
    if (choices !== undefined) descriptor.choices = choices
  }

  return descriptor
}

/** Describes every setting, in declaration order. */
export function describeSettings(): SettingDescriptor[] {
  return SETTINGS_KEYS.map((key) => describeSetting(key))
}
