/**
 * Settings sections and application timing.
 *
 * Split out of `definitions.ts` because the settings UI needs these *values* at
 * runtime, and `definitions.ts` imports zod. A value-import from there would drag the
 * validation library into the renderer bundle — which is exactly what happened while
 * building the settings panel, and what
 * `docs/solutions/performance-issues/renderer-bundle-bloat-zod-co-location.md`
 * documents. The architecture test caught it; this file is the fix.
 *
 * The rule, again: split by dependency weight, not by domain. Plain data that a
 * renderer needs goes in a module with no heavy imports; the schemas import it, never
 * the reverse.
 */

export const SETTINGS_SECTIONS = [
  'appearance',
  'search',
  'splitView',
  'privacy',
  'permissions',
  'network',
  'downloads',
  'session',
  'clearData',
  'advanced'
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

/**
 * `live`     — takes effect immediately, including in already-open tabs
 * `new-tab`  — takes effect for content loaded after the change
 * `restart`  — needs an application restart; the UI must say so
 */
export type SettingsApplies = 'live' | 'new-tab' | 'restart'

export const SETTINGS_APPLIES = ['live', 'new-tab', 'restart'] as const
