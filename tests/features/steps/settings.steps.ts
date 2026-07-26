import { readFileSync, writeFileSync } from 'node:fs'
import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import {
  decideMediaPermission,
  decidePermission
} from '@main/session/permission-policy.js'
import { decideAccess } from '@main/ipc/sender-policy.js'
import { SettingsStore } from '@main/settings/SettingsStore.js'
import { defaultSettings, isSettingsKey, type SettingsKey } from '@shared/settings/definitions.js'
import { capture, captureAsync, scope, settingsStore, tempFile } from './world.js'

/**
 * Steps for `permissions-and-settings.feature`.
 *
 * Permissions go through the pure policy; settings go through the real store
 * against a temporary file, because two scenarios are specifically about what
 * survives a restart and what happens to a key written by a newer version.
 *
 * `the setting … is …` lives here rather than in the privacy steps because step
 * expressions are global and both features use it. It writes to the shared scope
 * that both step files read.
 */

/**
 * Narrows a scenario's key string to a real settings key.
 *
 * The earlier spelling derived the target type from `isSettingsKey`'s parameter,
 * which is `unknown` — so `unknown & string` collapsed to `string` and the
 * assertion narrowed nothing. It compiled, and every `get(key)` below silently
 * lost its type. Naming `SettingsKey` directly is the whole point.
 */
function assertKey(key: string): asserts key is SettingsKey {
  if (!isSettingsKey(key)) throw new Error(`unknown setting in scenario: ${key}`)
}

// --- given -------------------------------------------------------------------

Given('default settings', async (state: unknown) => {
  const current = scope(state)
  current.settings = { ...defaultSettings() }
  current.settingsFilePath = tempFile('settings', 'settings.json')
  current.settingsStore = await SettingsStore.open(current.settingsFilePath)
})

Given('the setting {string} is {string}', (state: unknown, key: string, value: string) => {
  assertKey(key)
  // Written to the scope copy rather than the store: these scenarios are about
  // the effect of a value, not about how it got persisted.
  ;(scope(state).settings as Record<string, unknown>)[key] = value
})

Given('the setting {string} is off', (state: unknown, key: string) => {
  assertKey(key)
  ;(scope(state).settings as Record<string, unknown>)[key] = false
})

Given('the user does not answer the prompt', (state: unknown) => {
  // Unanswered must mean denied; the scenario exists to prove exactly that.
  scope(state).promptAnswer = false
})

Given('the settings file contains an unknown key {string}', (state: unknown, key: string) => {
  const filePath = tempFile('settings', 'settings.json')
  writeFileSync(filePath, JSON.stringify({ [key]: 'value', 'appearance.theme': 'dark' }))
  const current = scope(state)
  current.settingsFilePath = filePath
  current.scratch['unknownKey'] = key
})

// --- when: permissions -------------------------------------------------------

When('a page requests the {string} permission', (state: unknown, permission: string) => {
  const current = scope(state)
  current.permissionDecision = decidePermission(permission, current.settings)
})

When('a page requests camera access', (state: unknown) => {
  const current = scope(state)
  current.permissionDecision = decideMediaPermission(['video'], current.settings)
})

When('a page requests camera and microphone access', (state: unknown) => {
  const current = scope(state)
  current.permissionDecision = decideMediaPermission(['video', 'audio'], current.settings)
})

When(
  'a page requests the {string} permission through the browser',
  (state: unknown, permission: string) => {
    const current = scope(state)
    const decision = decidePermission(permission, current.settings)
    // Mirrors what `hardening.ts` does with an `ask`: consult the prompt, and
    // treat no answer as a refusal.
    current.permissionDecision =
      decision === 'ask' ? (current.promptAnswer === true ? 'allow' : 'deny') : decision
  }
)

// --- when: settings ----------------------------------------------------------

function applySet(state: unknown, key: string, value: unknown): void {
  const change = settingsStore(state).set(key, value)
  scope(state).lastChangedKeys = Object.keys(change.changed)
}

When('I set {string} to {string}', (state: unknown, key: string, value: string) => {
  applySet(state, key, value)
})

When('I set {string} to {int}', (state: unknown, key: string, value: number) => {
  applySet(state, key, value)
})

When('I set {string} to false', (state: unknown, key: string) => {
  applySet(state, key, false)
})

When('I set {string} to true', (state: unknown, key: string) => {
  applySet(state, key, true)
})

When('I try to set {string} to {string}', (state: unknown, key: string, value: string) => {
  capture(state, () => applySet(state, key, value))
})

When('I try to set {string} to {int}', (state: unknown, key: string, value: number) => {
  capture(state, () => applySet(state, key, value))
})

When('I start listening for setting changes', (state: unknown) => {
  const current = scope(state)
  current.settingsChangeCount = 0
  current.settingsUnsubscribe = settingsStore(state).onChange(() => {
    current.settingsChangeCount += 1
  })
})

When('I stop listening for setting changes', (state: unknown) => {
  const current = scope(state)
  current.settingsUnsubscribe?.()
  current.settingsUnsubscribe = null
})

When('the settings are written and read back', async (state: unknown) => {
  const current = scope(state)
  if (current.settingsFilePath === null) throw new Error('no settings file in this scenario')
  await settingsStore(state).flush()
  current.settingsStore = await SettingsStore.open(current.settingsFilePath)
})

When('the settings are read', async (state: unknown) => {
  const current = scope(state)
  await captureAsync(state, async () => {
    if (current.settingsFilePath === null) throw new Error('no settings file in this scenario')
    current.settingsStore = await SettingsStore.open(current.settingsFilePath)
  })
})

// --- when: ipc access --------------------------------------------------------

When('a sender on {string} calls {string}', (state: unknown, origin: string, channel: string) => {
  scope(state).accessAllowed = decideAccess(channel, {
    frameUrl: origin,
    isChromeRenderer: false
  }).allowed
})

When('the chrome UI calls {string}', (state: unknown, channel: string) => {
  scope(state).accessAllowed = decideAccess(channel, {
    // In development the chrome UI is served over http, which is why identity and
    // not the URL decides.
    frameUrl: 'http://localhost:5173/index.html',
    isChromeRenderer: true
  }).allowed
})

// --- then --------------------------------------------------------------------

Then('the permission is denied', (state: unknown) => {
  expect(scope(state).permissionDecision).toBe('deny')
})

Then('the permission is allowed', (state: unknown) => {
  expect(scope(state).permissionDecision).toBe('allow')
})

Then('the permission decision is {string}', (state: unknown, expected: string) => {
  expect(scope(state).permissionDecision).toBe(expected)
})

Then('reading {string} gives {string}', (state: unknown, key: string, expected: string) => {
  assertKey(key)
  expect(settingsStore(state).get(key)).toBe(expected)
})

Then('reading {string} gives {int}', (state: unknown, key: string, expected: number) => {
  assertKey(key)
  expect(settingsStore(state).get(key)).toBe(expected)
})

Then('reading {string} gives false', (state: unknown, key: string) => {
  assertKey(key)
  expect(settingsStore(state).get(key)).toBe(false)
})

Then('reading {string} gives true', (state: unknown, key: string) => {
  assertKey(key)
  expect(settingsStore(state).get(key)).toBe(true)
})

Then('the write fails with {string}', (state: unknown, errorName: string) => {
  const error = scope(state).lastError
  expect(error, 'expected the write to be refused, but it succeeded').not.toBeNull()
  expect(error?.name).toBe(errorName)
})

Then('the second write reports no change', (state: unknown) => {
  expect(scope(state).lastChangedKeys).toEqual([])
})

Then('the listener saw {int} change', (state: unknown, count: number) => {
  expect(scope(state).settingsChangeCount).toBe(count)
})

Then('the unknown key is reported', (state: unknown) => {
  const key = scope(state).scratch['unknownKey'] as string
  expect(settingsStore(state).unknownKeysOnLoad).toContain(key)
})

Then(
  'the settings file still contains {string} after a write',
  async (state: unknown, key: string) => {
    // Reporting the key is not enough — it has to survive being written back, or
    // simply running an older build would destroy a newer one's settings.
    settingsStore(state).set('appearance.theme', 'light')
    await settingsStore(state).flush()

    const filePath = scope(state).settingsFilePath
    if (filePath === null) throw new Error('no settings file in this scenario')
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(raw)).toContain(key)
  }
)

Then('the call is refused', (state: unknown) => {
  expect(scope(state).accessAllowed).toBe(false)
})

Then('the call is allowed', (state: unknown) => {
  expect(scope(state).accessAllowed).toBe(true)
})

Then('the call is {string}', (state: unknown, outcome: string) => {
  expect(scope(state).accessAllowed).toBe(outcome === 'allowed')
})
