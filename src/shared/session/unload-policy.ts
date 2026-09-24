import type { SettingsSnapshot } from '../settings/definitions.js'

/**
 * Which idle tabs may be unloaded (R26, KTD9): tab facts, the time and the settings in, tab ids out.
 *
 * Pure, and the only place the rule lives. `main/browser/tab-unloader.ts` reads the facts off each tab and
 * carries the answer out; Electron has no discard of its own, so "unloaded" there means the view is
 * destroyed and its history held in memory until the tab is activated again.
 *
 * ## What keeps a tab
 *
 * Every exemption is something the user would lose. A tile would go blank in front of them. A paused
 * video would start over, and a muted one would stop (AE7). A pinned tab is one they asked to keep. A tab
 * still loading, with devtools open or a page in fullscreen is being used. A picker, a prompt, a save bar,
 * a fill request or a find bar is waiting on an answer from it. Typing nobody has sent is lost with the
 * page, whether the field still has the focus or not — `beforeunload` is not something most forms set. An
 * internal page costs nothing to keep and has nothing to restore; a failed one shows its reason, which a
 * reload would replace (KTD22). And a page that refused the last attempt is not asked again until it
 * navigates, because asking means running its `beforeunload` once a minute.
 *
 * No Electron and no validation library: this is imported wherever the rule is needed.
 */

/** Minutes the setting may hold, and so the limits this module holds it to. */
export const MIN_UNLOAD_MINUTES = 1
export const MAX_UNLOAD_MINUTES = 1440

/**
 * The preload's report that a form field was typed into (U15), on a channel of its own.
 *
 * Set by the first trusted `input` event in the top document and cleared by a submit; a navigation clears
 * it on the core's side. The password manager's fillable signal is not this: it is about password fields
 * with the focus, and a message typed into a textarea and left there has neither.
 */
export const UNSAVED_INPUT_CHANNEL = 'tessera:unsaved-input'

/** Every reason a tab is kept, in the order they are reported. */
export const UNLOAD_EXEMPTIONS = [
  'tile',
  'audible',
  'media',
  'pinned',
  'loading',
  'devtools',
  'fullscreen',
  'prompt',
  'input',
  'internal',
  'failure',
  'objected',
  'unloaded'
] as const

export type UnloadExemption = (typeof UNLOAD_EXEMPTIONS)[number]

/** One tab, as the rule reads it. Each exemption is a fact of the same name. */
export type UnloadFacts = {
  readonly tabId: string
  /** When the tab was last activated, focused or navigated, in milliseconds since the epoch. */
  readonly lastActiveAt: number
} & Readonly<Record<UnloadExemption, boolean>>

export interface UnloadSettings {
  readonly enabled: boolean
  /** How long a tab must be idle before it is a candidate. */
  readonly afterMs: number
}

type UnloadSettingKeys = 'advanced.unloadInactiveTabs' | 'advanced.unloadAfterMinutes'

export function unloadSettingsOf(
  settings: Pick<SettingsSnapshot, UnloadSettingKeys>
): UnloadSettings {
  const minutes = Math.min(
    MAX_UNLOAD_MINUTES,
    Math.max(MIN_UNLOAD_MINUTES, settings['advanced.unloadAfterMinutes'])
  )
  return { enabled: settings['advanced.unloadInactiveTabs'], afterMs: minutes * 60_000 }
}

/** The first reason to keep this tab, or `null` when there is none. */
export function unloadExemptionOf(facts: UnloadFacts): UnloadExemption | null {
  return UNLOAD_EXEMPTIONS.find((exemption) => facts[exemption]) ?? null
}

/**
 * The tabs to unload now, in the order given.
 *
 * Idle means "at least the setting's minutes", so a tab is a candidate at thirty minutes and not a
 * minute after. Minutes that cannot be read make no candidate: every comparison with `NaN` is false.
 */
export function unloadCandidates(
  tabs: readonly UnloadFacts[],
  now: number,
  settings: UnloadSettings
): string[] {
  if (!settings.enabled) return []
  return tabs
    .filter((tab) => now - tab.lastActiveAt >= settings.afterMs && unloadExemptionOf(tab) === null)
    .map((tab) => tab.tabId)
}
