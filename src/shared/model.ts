import { z } from 'zod'
import { LAYOUT_IDS } from './split/layout.js'

/**
 * State objects that cross the UI <-> core boundary.
 *
 * Defined once, with runtime schemas, so the renderer's idea of a tab and the
 * main process's idea of a tab cannot drift apart (spec 6).
 */

export const securityStateSchema = z.enum([
  /** HTTPS, valid certificate */
  'secure',
  /** plain HTTP */
  'insecure',
  /** HTTPS with a certificate the browser rejected */
  'invalid-certificate',
  /** tessera's own pages */
  'internal'
])
export type SecurityState = z.output<typeof securityStateSchema>

export const tabStateSchema = z.object({
  id: z.string(),
  url: z.string(),
  /** What the user typed, kept while a navigation is in flight. */
  pendingInput: z.string().nullable(),
  title: z.string(),
  /**
   * The site's icon as an `tessera://favicon?site=…` address, or `null`.
   *
   * An address into our own scheme rather than a file path, and never a third-party URL: spec 1
   * rules out asking an icon service, and a `file://` path in a renderer would need file access
   * this one deliberately does not have. The core resolves the address against the local cache.
   */
  faviconUrl: z.string().nullable(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  pinned: z.boolean(),
  muted: z.boolean(),
  audible: z.boolean(),
  security: securityStateSchema,
  /** Actual count for this page, not an estimate (spec 1). */
  blockedRequests: z.number().int().nonnegative(),
  /** Zoom is per domain, not per tab (spec 1); mirrored here for display. */
  zoomPercent: z.number().int(),
  /** Which split tile shows this tab, or null when unassigned but still loaded. */
  tileIndex: z.number().int().nullable(),
  /** True while the tab is discarded to save memory. Never true for tiled tabs. */
  unloaded: z.boolean()
})
export type TabState = z.output<typeof tabStateSchema>

export const tileAudioSchema = z.object({
  muted: z.boolean(),
  /** 0..1, per tile, survives restart (spec 2). */
  volume: z.number().min(0).max(1)
})
export type TileAudio = z.output<typeof tileAudioSchema>

/**
 * Where the window sits on the escalation chain
 * tile-fullscreen -> tile-maximized -> window-fullscreen (spec 2).
 * Esc steps back exactly one level.
 */
export const escalationLevelSchema = z.enum([
  'none',
  'tile-fullscreen',
  'tile-maximized',
  'window-fullscreen'
])
export type EscalationLevel = z.output<typeof escalationLevelSchema>

export const splitStateSchema = z.object({
  layout: z.enum(LAYOUT_IDS),
  /** Divider positions, keyed by divider id from `split/layout.ts`. */
  fractions: z.record(z.string(), z.number()),
  activeTile: z.number().int().nonnegative(),
  /** Tab id per tile index; null means the tile is empty. */
  tileTabIds: z.array(z.string().nullable()),
  tileAudio: z.array(tileAudioSchema),
  /** Tile temporarily grown to the full window, layout preserved. */
  maximizedTile: z.number().int().nullable(),
  /** Tile whose page believes it is fullscreen. */
  fullscreenTile: z.number().int().nullable(),
  escalation: escalationLevelSchema
})
export type SplitState = z.output<typeof splitStateSchema>

export const platformSchema = z.enum(['win32', 'darwin', 'linux'])
export type Platform = z.output<typeof platformSchema>

export const windowStateSchema = z.object({
  windowId: z.number().int(),
  platform: platformSchema,
  focused: z.boolean(),
  maximized: z.boolean(),
  fullscreen: z.boolean(),
  /** Private windows get their own colour so they are never mistaken (spec 4). */
  privateMode: z.boolean(),
  /** Inset reserved for the traffic lights / window controls, in px. */
  windowControlsInset: z.object({ left: z.number(), right: z.number() })
})
export type WindowState = z.output<typeof windowStateSchema>

/**
 * How much space the chrome UI occupies. The renderer measures its own layout
 * and reports it; the main process positions native content views below it.
 * Keeping measurement in the renderer means the two can never disagree about
 * where the tab bar ends.
 */
export const chromeInsetsSchema = z.object({
  top: z.number().nonnegative(),
  bottom: z.number().nonnegative(),
  left: z.number().nonnegative(),
  right: z.number().nonnegative()
})
export type ChromeInsets = z.output<typeof chromeInsetsSchema>

export const historyEntrySchema = z.object({
  url: z.string(),
  title: z.string(),
  /** Offset relative to the current entry: negative is back, positive forward. */
  offset: z.number().int()
})
export type HistoryEntry = z.output<typeof historyEntrySchema>

/** A resolved shortcut binding for the current platform. */
export const shortcutBindingSchema = z.object({
  action: z.string(),
  /** Electron accelerator string, e.g. `CommandOrControl+Shift+1`. */
  accelerator: z.string(),
  /** True when the OS is known to swallow this combination (spec 9). */
  knownConflict: z.boolean(),
  /** Localised hint plus alternative when `knownConflict` is true. */
  conflictNote: z.string().nullable()
})
export type ShortcutBinding = z.output<typeof shortcutBindingSchema>
