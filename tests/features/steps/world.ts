import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStore } from '@main/settings/SettingsStore.js'
import type { QuickLinkStore } from '@main/data/QuickLinkStore.js'
import type { SplitController } from '@main/browser/SplitController.js'
import type { StageOutcome } from '@main/privacy/RequestPipeline.js'
import type { PermissionDecision } from '@main/session/permission-policy.js'
import type { FilterSubscription } from '@main/privacy/FilterSubscription.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import type { AnchoredSurface, Rect, Size } from '@shared/ui/anchor.js'
import type { DropZone } from '@shared/split/dropzones.js'
import type { SessionDocument } from '@shared/session/model.js'
import type { RestorePlan } from '@shared/session/restore.js'
import type { FindPageAction, FindSession } from '@shared/find/session.js'
import type { Bookmark } from '@shared/bookmarks/model.js'
import type { ImportReport } from '@shared/bookmarks/import.js'
import type { DownloadRecord } from '@shared/downloads/model.js'
import type { ReaderOutcome } from '@shared/reader/outcome.js'

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

  // --- session restore ---
  /** The file as it stands, carried from one modelled launch to the next. */
  session: SessionDocument | null
  restorePlan: RestorePlan | null

  // --- find in page ---
  find: FindSession | null
  /** What the last request told the page to do, in order. */
  findActions: FindPageAction[]
  /** The query a closed bar reopens with. */
  findRemembered: string
  /**
   * The number Electron would have given the search in flight.
   *
   * Data, not a rule: `FindController` keeps exactly this so an answer can be matched to
   * the question that asked for it. Whether an answer counts is `acceptsFindResult`.
   */
  findRequestId: number

  // --- bookmarks ---
  bookmarks: Bookmark[]
  importReport: ImportReport | null

  // --- downloads ---
  downloadName: string | null
  downloads: DownloadRecord[]
  /** Download ids whose file the scenario says is still on disk. */
  filesOnDisk: Set<string>
  /** Set when a scenario asks for a private window; see `discardingDownloadRecorder`. */
  privateWindow: boolean

  // --- reader mode ---
  /** `unknown`, because one scenario is about a page answering something off-shape. */
  readerPage: unknown
  readerOutcome: ReaderOutcome | null

  // --- content blocker ---
  blocker: FilterSubscription | null
  /** Every list address the blocker asked for, in order. */
  blockerFetches: string[]
  /** The list cache, kept across a scenario's restarts — surviving one is what several assert. */
  blockerDirectory: string | null
  /** List body by address. A list missing from here is one the network will not answer for. */
  blockerBodies: Record<string, string>

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

    session: null,
    restorePlan: null,

    find: null,
    findActions: [],
    findRemembered: '',
    findRequestId: 0,

    bookmarks: [],
    importReport: null,

    downloadName: null,
    downloads: [],
    filesOnDisk: new Set<string>(),
    privateWindow: false,

    readerPage: null,
    readerOutcome: null,

    blocker: null,
    blockerFetches: [],
    blockerDirectory: null,
    blockerBodies: {},

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

export function sessionDocument(state: unknown): SessionDocument {
  const document = scope(state).session
  if (document === null) throw new Error('this scenario has no saved session; add a Given for it')
  return document
}

export function restorePlan(state: unknown): RestorePlan {
  const plan = scope(state).restorePlan
  if (plan === null) throw new Error('nothing was restored in this scenario; add a When for it')
  return plan
}

export function findSession(state: unknown): FindSession {
  const session = scope(state).find
  if (session === null) throw new Error('this scenario has no find bar open; add a Given for it')
  return session
}

export function readerOutcome(state: unknown): ReaderOutcome {
  const outcome = scope(state).readerOutcome
  if (outcome === null) throw new Error('no page was read in this scenario; add a When for it')
  return outcome
}

export function blocker(state: unknown): FilterSubscription {
  const subscription = scope(state).blocker
  if (subscription === null) throw new Error('this scenario has no blocker; add a Given for it')
  return subscription
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
