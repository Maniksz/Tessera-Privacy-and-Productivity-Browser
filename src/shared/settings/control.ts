import type { SettingsApplies, SettingsSection } from './sections.js'

/**
 * How a setting is presented, as plain data.
 *
 * Deliberately zod-free so the settings UI can import it: the descriptors themselves
 * are *derived* from the zod schemas in the main process and sent over IPC, which
 * keeps `definitions.ts` the single source of truth without dragging the validation
 * library into the renderer bundle. See
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`.
 *
 * The alternative — a hand-written control hint next to each definition — would be a
 * second place to update whenever a schema changes, which is exactly the drift
 * spec 5 exists to prevent.
 */

export const SETTING_CONTROL_KINDS = [
  'toggle',
  'choice',
  'number',
  'text',
  'text-list',
  /** Key/value pairs, e.g. custom shortcut overrides. Read-only for now. */
  'map',
  /** A shape the deriver did not recognise; rendered read-only as JSON. */
  'unsupported'
] as const

export type SettingControlKind = (typeof SETTING_CONTROL_KINDS)[number]

export interface SettingDescriptor {
  key: string
  section: SettingsSection
  applies: SettingsApplies
  kind: SettingControlKind
  /**
   * Present for `choice`: the allowed values, in declaration order.
   *
   * `| undefined` is spelled out because `exactOptionalPropertyTypes` is on and these
   * descriptors arrive over IPC, where an absent field parses as `undefined` rather
   * than being absent from the object.
   */
  choices?: string[] | undefined
  /** Present for `number` when the schema bounds it. */
  min?: number | undefined
  max?: number | undefined
  /** True when the schema requires whole numbers. */
  integer?: boolean | undefined
}
