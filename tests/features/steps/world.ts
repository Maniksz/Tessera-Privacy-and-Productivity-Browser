import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStore } from '@main/settings/SettingsStore.js'
import type { QuickLinkStore } from '@main/data/QuickLinkStore.js'
import type { SplitController } from '@main/browser/SplitController.js'
import type { StageOutcome } from '@main/privacy/RequestPipeline.js'
import type { PermissionDecision } from '@main/session/permission-policy.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import type { AnchoredSurface, Rect, Size } from '@shared/ui/anchor.js'
import type { DropZone } from '@shared/split/dropzones.js'

/**
 * One scope object per scenario, shared by every step file.
 *
 * Two reasons it is a single object rather than one per step file:
 *
 *   1. **Step expressions are global.** Gherkin steps are registered by text, so
 *      "the setting X is off" can exist exactly once. It has to write somewhere
 *      both the privacy steps and the settings steps can read.
 *   2. **Scenario isolation.** Keyed off quickpickle's per-scenario `state` rather
 *      than kept at module level, so scenarios cannot leak into one another. A
 *      module-level object would work today and break silently the first time
 *      someone adds a `@concurrent` tag.
 */

export interface Scope {
  // --- settings ---
  settings: SettingsSnapshot
  settingsStore: SettingsStore | null
  settingsFilePath: string | null
  settingsChangeCount: number
  settingsUnsubscribe: (() => void) | null
  lastChangedKeys: string[]

  // --- permissions and ipc ---
  permissionDecision: PermissionDecision | null
  promptAnswer: boolean | null
  accessAllowed: boolean | null

  // --- privacy ---
  documentUrl: string | null
  referrer: string | null
  requestOutcome: StageOutcome | null
  requestHeaders: Readonly<Record<string, string>> | null
  responseHeaders: Readonly<Record<string, string>> | null

  // --- quick links ---
  quickLinkStore: QuickLinkStore | null
  quickLinksFilePath: string | null

  // --- split view ---
  split: SplitController | null
  closedTabs: string[]
  knownTabs: string[]
  windowFullscreenPermitted: boolean
  fullscreenScope: 'tile' | 'window'
  onlyActiveTileAudible: boolean

  // --- window layering ---
  viewport: Size | null
  chromeInset: number
  anchorRect: Rect | null
  anchoredSurface: AnchoredSurface | null
  dropZones: DropZone[] | null
  /** Undefined until a pointer step runs; null means "no target", which is a real answer. */
  dropTarget: DropZone | null | undefined

  // --- shared ---
  /** Set by an "I try to …" step, asserted by a "fails with …" step. */
  lastError: Error | null
  scratch: Record<string, unknown>
}

const scopes = new WeakMap<object, Scope>()

function emptyScope(): Scope {
  return {
    settings: { ...defaultSettings() },
    settingsStore: null,
    settingsFilePath: null,
    settingsChangeCount: 0,
    settingsUnsubscribe: null,
    lastChangedKeys: [],

    permissionDecision: null,
    promptAnswer: null,
    accessAllowed: null,

    documentUrl: null,
    referrer: null,
    requestOutcome: null,
    requestHeaders: null,
    responseHeaders: null,

    quickLinkStore: null,
    quickLinksFilePath: null,

    split: null,
    closedTabs: [],
    knownTabs: [],
    windowFullscreenPermitted: true,
    fullscreenScope: 'tile',
    onlyActiveTileAudible: false,

    viewport: null,
    chromeInset: 0,
    anchorRect: null,
    anchoredSurface: null,
    dropZones: null,
    dropTarget: undefined,

    lastError: null,
    scratch: {}
  }
}

export function scope(state: unknown): Scope {
  const key = state as object
  let existing = scopes.get(key)
  if (existing === undefined) {
    existing = emptyScope()
    scopes.set(key, existing)
  }
  return existing
}

/** Narrowing accessors, so a missing Given produces a clear message. */
export function settingsStore(state: unknown): SettingsStore {
  const store = scope(state).settingsStore
  if (store === null) throw new Error('this scenario has no settings store; add a Given for it')
  return store
}

export function quickLinkStore(state: unknown): QuickLinkStore {
  const store = scope(state).quickLinkStore
  if (store === null) throw new Error('this scenario has no quick link store; add a Given for it')
  return store
}

export function splitController(state: unknown): SplitController {
  const split = scope(state).split
  if (split === null) throw new Error('this scenario has no split controller; add a Given for it')
  return split
}

export function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `tessera-${prefix}-`))
}

export function tempFile(prefix: string, name: string): string {
  return join(tempDir(prefix), name)
}

/**
 * Runs `action` and stores any error instead of failing the step.
 *
 * Used by every "I try to …" step, so a following "fails with …" can assert the
 * specific error. A scenario expecting a refusal has to prove the refusal
 * happened, not merely that nothing changed.
 */
export function capture(state: unknown, action: () => void): void {
  const current = scope(state)
  current.lastError = null
  try {
    action()
  } catch (error) {
    current.lastError = error instanceof Error ? error : new Error(String(error))
  }
}

export async function captureAsync(state: unknown, action: () => Promise<void>): Promise<void> {
  const current = scope(state)
  current.lastError = null
  try {
    await action()
  } catch (error) {
    current.lastError = error instanceof Error ? error : new Error(String(error))
  }
}
