import { z } from 'zod'
import { SETTING_CONTROL_KINDS } from './control.js'
import { SETTINGS_APPLIES, SETTINGS_SECTIONS } from './sections.js'

/**
 * The wire schema for `SettingDescriptor`.
 *
 * Here rather than beside the type, and rather than inline in `ipc/contract.ts`, for two different
 * reasons that happen to point the same way.
 *
 * **Not beside the type.** `control.ts` is deliberately zod-free — the settings UI imports
 * `SettingDescriptor`, and a validation library imported from a renderer-facing module lands in the
 * renderer bundle. That is a measured problem here, not a theoretical one: see
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`, and note that
 * renderer JavaScript is currently over its budget. `tabgroups/schema.ts` splits for the same reason.
 *
 * **Not inline in the contract.** `contract.ts` is the largest file in the repository and has no
 * written next step; this is one. A schema that mirrors a type belongs next to neither the caller nor
 * the transport but next to the thing it describes, so the two can be read against each other — which
 * is the check that matters, because a field added to `SettingDescriptor` and forgotten here does not
 * fail to compile, it fails at runtime as a stripped field.
 */
export const settingDescriptorSchema = z.object({
  key: z.string(),
  section: z.enum(SETTINGS_SECTIONS),
  applies: z.enum(SETTINGS_APPLIES),
  kind: z.enum(SETTING_CONTROL_KINDS),
  /** Never derived from the key by the renderer; see `main/settings/settings-text.ts`. */
  label: z.string(),
  description: z.string().optional(),
  choices: z.array(z.string()).optional(),
  /**
   * Readable names for the members in `choices`, keyed by member.
   *
   * Partial by design: a member with no entry renders as its raw value, which is right for the
   * layout ids and is a visible rather than a silent gap for anything else.
   */
  choiceLabels: z.record(z.string(), z.string()).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional()
})
