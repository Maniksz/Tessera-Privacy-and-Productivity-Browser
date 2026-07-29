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
   * What the setting is called, in the language the core resolved for this request.
   *
   * Required, not optional. The renderer used to derive a name from the key with a
   * `humanise()` helper, which meant a German user read `Block third party cookies` —
   * seventy-six hard-coded English strings that spec 7 forbids, generated at render time so
   * that no catalogue check could ever see them. Making this mandatory is what stops that
   * from being reintroduced by accident: a descriptor without a name does not type.
   *
   * The text comes from `main/settings/settings-text.*`, not from the shared catalogue, and
   * that module's docblock argues why.
   */
  label: string
  /**
   * What the setting *does*, where the name cannot say it.
   *
   * Optional because most settings do not need one: a description repeating the label is
   * noise, and noise is what makes the sentences that matter — the ones naming a cost, a
   * limit, or a switch that is not honoured yet — get skipped.
   */
  description?: string | undefined
  /**
   * Present for `choice`: the allowed values, in declaration order.
   *
   * `| undefined` is spelled out because `exactOptionalPropertyTypes` is on and these
   * descriptors arrive over IPC, where an absent field parses as `undefined` rather
   * than being absent from the object.
   */
  choices?: string[] | undefined
  /**
   * Readable names for the members in `choices`, keyed by member.
   *
   * A map rather than a parallel array, so a member gained or reordered in the schema cannot
   * silently shift every label by one. The renderer falls back to the raw member for anything
   * missing, which is what keeps a select honest rather than blank when the two disagree.
   *
   * Absent where the members are already language-neutral — the split layouts are `1x2`,
   * `2x2` and so on, and translating those would only invent a difference between locales.
   */
  choiceLabels?: Record<string, string> | undefined
  /** Present for `number` when the schema bounds it. */
  min?: number | undefined
  max?: number | undefined
  /** True when the schema requires whole numbers. */
  integer?: boolean | undefined
}
