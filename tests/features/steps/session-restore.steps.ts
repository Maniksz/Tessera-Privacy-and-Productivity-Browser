import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { restoreSettingsFrom } from '@main/session-restore/settings.js'
import {
  captureWindow,
  emptySessionDocument,
  finishedRestore,
  recordWindow,
  repairSession,
  startedRun,
  type SessionTab,
  type SessionWindow
} from '@shared/session/model.js'
import { planRestore, type PlannedTab, type PlannedWindow } from '@shared/session/restore.js'
import { sequenceOfTabId, tabIdForSequence } from '@shared/session/tab-ids.js'
import { DEFAULT_FRACTIONS, isLayoutId, type LayoutId } from '@shared/split/layout.js'
import { isSettingsKey } from '@shared/settings/definitions.js'
import { restorePlan, scope, sessionDocument } from './world.js'

/**
 * Steps for `session-restore.feature`.
 *
 * A launch is modelled rather than performed, and the model is three real functions in the
 * order the store calls them: `planRestore` decides, `startedRun` hands the previous run's
 * slots over and counts the attempt, and each restored window records itself back into the
 * fresh document. That last part is what makes the crash-loop scenarios mean anything — a
 * step that only planned would find an empty file on the second launch and report
 * "nothing to restore", which is not the failure those scenarios are about.
 *
 * What is deliberately absent: any tab, any window, any request. Whether a restored tab
 * *fetches* is `PlannedTab.load`, decided before anything is created, which is the reason
 * "a restore makes four requests, not twenty" is a scenario here instead of a note in a
 * review.
 */

interface DataTable {
  hashes(): Array<Record<string, string>>
}

function asLayout(value: string): LayoutId {
  if (!isLayoutId(value)) throw new Error(`not a layout id: ${value}`)
  return value
}

/** `''` and `-` both mean "this tab was loaded but not on screen". */
function tileOf(raw: string | undefined): number | null {
  const value = (raw ?? '').trim()
  if (value === '' || value === '-') return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed)) throw new Error(`not a tile index: ${value}`)
  return parsed
}

function savedTab(row: Record<string, string>, index: number): SessionTab {
  const pending = (row['pending'] ?? '').trim()
  return {
    id: (row['id'] ?? '').trim() === '' ? tabIdForSequence(index + 1) : (row['id'] ?? '').trim(),
    url: (row['address'] ?? '').trim(),
    pendingUrl: pending === '' ? null : pending,
    title: (row['title'] ?? '').trim(),
    pinned: (row['pinned'] ?? '').trim() === 'yes',
    tileIndex: tileOf(row['tile'])
  }
}

/** Appends a slot, opening the document on first use so a Given needs no ordering rule. */
function addWindow(state: unknown, describe: (slot: number) => SessionWindow): void {
  const current = scope(state)
  const document = current.session ?? emptySessionDocument()
  current.session = {
    ...document,
    windows: [...document.windows, describe(document.windows.length + 1)]
  }
}

function lastSavedWindow(state: unknown): SessionWindow {
  const [window] = sessionDocument(state).windows.slice(-1)
  if (window === undefined) throw new Error('this scenario has saved no window yet')
  return window
}

function replaceLastWindow(state: unknown, window: SessionWindow): void {
  const document = sessionDocument(state)
  scope(state).session = {
    ...document,
    windows: [...document.windows.slice(0, -1), window]
  }
}

/**
 * One launch, in the order `SessionStore` performs it.
 *
 * `reportsUp` is the browser staying alive long enough to say so, which is what clears the
 * crash-loop counter. A launch that never reports leaves the counter standing, and that is
 * precisely a crash.
 */
function launch(state: unknown, reportsUp: boolean): void {
  const current = scope(state)
  const document = sessionDocument(state)
  const plan = planRestore(document, restoreSettingsFrom(current.settings))
  current.restorePlan = plan

  // Counted *before* the first restored page may load: a counter incremented afterwards was
  // never a counter. `restoring: false` on a refusal is what makes the guard self-clearing.
  let next = startedRun(document, plan.kind === 'restore')

  if (plan.kind === 'restore') {
    const run = Number(current.scratch['launches'] ?? 0) + 1
    current.scratch['launches'] = run
    for (const [index, window] of plan.windows.entries()) {
      // The window a restore opens gets a new slot and writes its own state over it within a
      // second of appearing, so this is what the next launch actually reads.
      next = recordWindow(
        next,
        captureWindow(`run-${run}-window-${index}`, {
          layout: window.layout,
          fractions: window.fractions,
          activeTile: window.activeTile,
          tabs: window.tabs.map((tab) => ({
            id: tab.id,
            url: tab.url,
            pendingInput: null,
            title: tab.title,
            pinned: tab.pinned,
            tileIndex: tab.tileIndex
          }))
        })
      )
    }
    if (reportsUp) next = finishedRestore(next)
  }

  current.session = next
}

function restoredWindow(state: unknown): PlannedWindow {
  const plan = restorePlan(state)
  if (plan.kind !== 'restore') {
    throw new Error(`the session was not restored: ${plan.reason}`)
  }
  const [window] = plan.windows
  if (window === undefined) throw new Error('the restore plan holds no window')
  return window
}

function restoredTabs(state: unknown): PlannedTab[] {
  return [...restoredWindow(state).tabs]
}

function restoredTabFor(state: unknown, url: string): PlannedTab {
  const tabs = restoredTabs(state)
  const found = tabs.find((tab) => tab.url === url)
  if (found === undefined) {
    throw new Error(`no restored tab points at ${url}; have: ${tabs.map((tab) => tab.url).join(', ')}`)
  }
  return found
}

function savedTabFor(state: unknown, url: string): SessionTab {
  const window = lastSavedWindow(state)
  const found = window.tabs.find((tab) => tab.url === url)
  if (found === undefined) {
    throw new Error(`the saved window holds no tab for ${url}`)
  }
  return found
}

// --- given -------------------------------------------------------------------

Given(
  'a saved window with the {string} layout and these tabs:',
  (state: unknown, layout: string, table: DataTable) => {
    const id = asLayout(layout)
    addWindow(state, (slot) => ({
      id: `saved-${slot}`,
      open: false,
      layout: id,
      fractions: { ...DEFAULT_FRACTIONS[id] },
      activeTile: 0,
      tabs: table.hashes().map((row, index) => savedTab(row, index))
    }))
  }
)

Given(
  'a saved window with the {string} layout and {int} tabs, {int} of them in tiles',
  (state: unknown, layout: string, count: number, inTiles: number) => {
    const id = asLayout(layout)
    addWindow(state, (slot) => ({
      id: `saved-${slot}`,
      open: false,
      layout: id,
      fractions: { ...DEFAULT_FRACTIONS[id] },
      activeTile: 0,
      tabs: Array.from({ length: count }, (_unused, index) => ({
        id: tabIdForSequence(index + 1),
        url: `https://example.test/page-${index}`,
        pendingUrl: null,
        title: `Page ${index}`,
        pinned: false,
        tileIndex: index < inTiles ? index : null
      }))
    }))
  }
)

Given('the saved window was focused on tile {int}', (state: unknown, tile: number) => {
  replaceLastWindow(state, { ...lastSavedWindow(state), activeTile: tile })
})

Given('the saved dividers sit at {string}', (state: unknown, list: string) => {
  const fractions: Record<string, number> = {}
  for (const entry of list.split(',')) {
    const [id, value] = entry.split(':').map((part) => part.trim())
    if (id === undefined || value === undefined) throw new Error(`not a divider position: ${entry}`)
    fractions[id] = Number(value)
  }
  // Replacing rather than merging, so the scenario says exactly what the file held.
  replaceLastWindow(state, { ...lastSavedWindow(state), fractions })
})

/**
 * The counterpart of the existing "the setting … is off".
 *
 * Written to the scope's settings copy, which is what `restoreSettingsFrom` reads — the
 * scenarios are about the effect of a value, not about how it reached the disk.
 */
Given('the setting {string} is on', (state: unknown, key: string) => {
  if (!isSettingsKey(key)) throw new Error(`unknown setting in scenario: ${key}`)
  ;(scope(state).settings as Record<string, unknown>)[key] = true
})

// --- when --------------------------------------------------------------------

When('the browser restarts', (state: unknown) => {
  launch(state, true)
})

When('the browser restarts and never reports itself running', (state: unknown) => {
  launch(state, false)
})

When('the browser restarts and reports itself running', (state: unknown) => {
  launch(state, true)
})

When('the session file is read back', (state: unknown) => {
  const document = sessionDocument(state)
  scope(state).session = repairSession(document)
})

// --- then --------------------------------------------------------------------

Then('the session is restored', (state: unknown) => {
  const plan = restorePlan(state)
  expect(plan.kind, plan.kind === 'skip' ? `refused: ${plan.reason}` : 'restored').toBe('restore')
})

Then('the session is not restored, because {string}', (state: unknown, reason: string) => {
  const plan = restorePlan(state)
  expect(plan.kind, 'the session was restored, and this scenario expects a refusal').toBe('skip')
  if (plan.kind !== 'skip') return
  expect(plan.reason).toBe(reason)
})

Then('the restored window uses the {string} layout', (state: unknown, layout: string) => {
  expect(restoredWindow(state).layout).toBe(layout)
})

Then('the restored strip has {int} tab', (state: unknown, count: number) => {
  expect(restoredTabs(state)).toHaveLength(count)
})

Then('the restored strip has {int} tabs', (state: unknown, count: number) => {
  expect(restoredTabs(state)).toHaveLength(count)
})

Then('tile {int} shows the tab for {string}', (state: unknown, tile: number, url: string) => {
  const holder = restoredTabs(state).find((tab) => tab.tileIndex === tile)
  expect(holder?.url, `nothing was restored into tile ${tile}`).toBe(url)
})

Then('{int} restored tabs load at once', (state: unknown, count: number) => {
  // The whole point of the feature's privacy and startup story: what loads is what a tile is
  // about to show, and nothing else.
  expect(restoredTabs(state).filter((tab) => tab.load === 'now')).toHaveLength(count)
})

Then('{int} restored tabs wait until they are asked for', (state: unknown, count: number) => {
  expect(restoredTabs(state).filter((tab) => tab.load === 'on-activation')).toHaveLength(count)
})

Then('{int} restored tab holds a tile', (state: unknown, count: number) => {
  expect(restoredTabs(state).filter((tab) => tab.tileIndex !== null)).toHaveLength(count)
})

Then('{int} restored tabs hold no tile', (state: unknown, count: number) => {
  expect(restoredTabs(state).filter((tab) => tab.tileIndex === null)).toHaveLength(count)
})

Then('no two restored tabs claim the same tile', (state: unknown) => {
  const claimed = restoredTabs(state)
    .map((tab) => tab.tileIndex)
    .filter((tile): tile is number => tile !== null)
  expect(claimed, 'two tabs in one tile means one of them is loaded and unreachable').toHaveLength(
    new Set(claimed).size
  )
})

Then('no restored tab points at {string}', (state: unknown, url: string) => {
  expect(restoredTabs(state).map((tab) => tab.url)).not.toContain(url)
})

Then('the tab for {string} is restored', (state: unknown, url: string) => {
  expect(restoredTabs(state).map((tab) => tab.url)).toContain(url)
})

Then('the restored window is focused on tile {int}', (state: unknown, tile: number) => {
  expect(restoredWindow(state).activeTile).toBe(tile)
})

Then('the restored divider {string} sits at {float}', (state: unknown, id: string, value: number) => {
  expect(restoredWindow(state).fractions[id]).toBeCloseTo(value, 6)
})

Then('the restored window has no divider {string}', (state: unknown, id: string) => {
  expect(Object.keys(restoredWindow(state).fractions)).not.toContain(id)
})

Then(
  'the restored tab for {string} keeps the id {string}',
  (state: unknown, url: string, id: string) => {
    expect(restoredTabFor(state, url).id).toBe(id)
  }
)

Then('no tab created this launch can be given a restored id', (state: unknown) => {
  const ids = restoredTabs(state).map((tab) => tab.id)
  // What `adoptTabId` does: the counter is raised past every id that came back, so the next
  // fresh id cannot be one of them. Without it two pages answer to one id and every id-keyed
  // thing in the browser disagrees quietly.
  const highest = ids.reduce((high, id) => Math.max(high, sequenceOfTabId(id)), 0)
  expect(ids, 'a restored id would be handed out again').not.toContain(tabIdForSequence(highest + 1))
  expect(highest, 'no restored id was recognised as coming from the counter').toBeGreaterThan(0)
})

Then('the crash-loop counter is back to zero', (state: unknown) => {
  // Self-clearing on purpose: a guard that held would lock a user out of restore for good.
  expect(sessionDocument(state).pendingRestores).toBe(0)
})

Then('the saved window holds {int} tab', (state: unknown, count: number) => {
  expect(lastSavedWindow(state).tabs).toHaveLength(count)
})

Then('the saved window holds {int} tabs', (state: unknown, count: number) => {
  expect(lastSavedWindow(state).tabs).toHaveLength(count)
})

Then('the saved tab for {string} holds no tile', (state: unknown, url: string) => {
  // Detached, never dropped — the same rule the split view obeys when a layout shrinks.
  expect(savedTabFor(state, url).tileIndex).toBeNull()
})
