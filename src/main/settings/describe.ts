import type { z } from 'zod'
import {
  SETTINGS_KEYS,
  appliesOf,
  sectionOf,
  settingDefinitions,
  type SettingsKey
} from '@shared/settings/definitions.js'
import type { SettingControlKind, SettingDescriptor } from '@shared/settings/control.js'
import type { Locale } from '@shared/i18n/catalog.js'
import { fallbackLabel, settingTextFor } from './settings-text.js'

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
 *
 * ## Why the text is resolved here rather than in the renderer
 *
 * A descriptor used to carry no words at all: the settings surface built a label out of
 * the key with a `humanise()` helper, so a German user read `Block third party cookies`
 * beside every switch. Spec 7 forbids hard-coded strings, and these were worse than
 * hard-coded — they were *generated*, so no catalogue check could ever see them.
 *
 * The words join the descriptor here because this is where the request's locale is known
 * and because the alternative — shipping them in the shared catalogue — does not fit; see
 * `settings-text.ts` for the budget and for who pays it. Nothing else about the derivation
 * changes: the locale decides only which of two tables is read.
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

/**
 * Names for the members of an enum, kept only where the table actually has them.
 *
 * Filtered against the members the *schema* offers rather than copied wholesale: the two are
 * maintained apart, and a name for a member that no longer exists would be a label the select
 * can never show, sitting in the payload looking correct. Members with no name are simply
 * absent, and the renderer falls back to the raw value for those.
 */
function choiceLabelsFor(
  choices: string[],
  named: Readonly<Record<string, string>> | undefined
): Record<string, string> | undefined {
  if (named === undefined) return undefined
  const labels: Record<string, string> = {}
  for (const choice of choices) {
    const label = Object.hasOwn(named, choice) ? named[choice] : undefined
    if (label !== undefined) labels[choice] = label
  }
  return Object.keys(labels).length > 0 ? labels : undefined
}

/** Describes one setting, in one language. */
export function describeSetting(key: SettingsKey, locale: Locale): SettingDescriptor {
  const schema = settingDefinitions[key].schema
  const kind = kindOf(schema)
  const text = settingTextFor(locale, key)

  const descriptor: SettingDescriptor = {
    key,
    section: sectionOf(key),
    applies: appliesOf(key),
    kind,
    // A key the table has not caught up with still gets a usable name; see `fallbackLabel`.
    label: text?.label ?? fallbackLabel(key)
  }

  // Assigned only when there is one, so the absence of a description stays an absence rather
  // than becoming an explicit `undefined` — which survives structured clone and would show up
  // as a field the descriptor carries.
  if (text?.description !== undefined) descriptor.description = text.description

  if (kind === 'choice') {
    const choices = choicesOf(schema)
    // An enum whose members cannot be read is worse than a read-only field: a select
    // with no options would silently offer nothing.
    if (choices === undefined) return { ...descriptor, kind: 'unsupported' }
    descriptor.choices = choices
    const labels = choiceLabelsFor(choices, text?.choices)
    if (labels !== undefined) descriptor.choiceLabels = labels
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

/**
 * Describes every setting, in declaration order, in one language.
 *
 * The locale is a parameter rather than something this module resolves, because the answer
 * belongs to the request: the core serves several windows and the caller in `handlers.ts`
 * already resolves it the same way `i18n:getCatalog` does. A module-level locale here would be
 * one more thing to keep in step with the setting that decides it.
 */
export function describeSettings(locale: Locale): SettingDescriptor[] {
  return SETTINGS_KEYS.map((key) => describeSetting(key, locale))
}
