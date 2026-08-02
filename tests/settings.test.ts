import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  InvalidSettingValueError,
  SettingsStore,
  UnknownSettingKeyError
} from '@main/settings/SettingsStore.js'
import {
  SETTINGS_KEYS,
  defaultSettings,
  keysBySection,
  settingDefinitions,
  settingsSnapshotSchema
} from '@shared/settings/definitions.js'
import { VAULT_IDLE_TIMEOUT_MS } from '@shared/passwords/vault.js'

async function tempStore(seed?: Record<string, unknown>): Promise<SettingsStore> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-settings-'))
  const file = join(dir, 'settings.json')
  if (seed !== undefined) await writeFile(file, JSON.stringify(seed))
  return SettingsStore.open(file)
}

/**
 * Spec 5 makes two promises that are easy to break silently, so both are pinned
 * here: one source of truth for every setting, and a failed write that is
 * *visible* rather than dropped.
 */

describe('settings definitions', () => {
  it('has a schema-valid default for every key', () => {
    // Guards against a default drifting out of range as a schema tightens.
    for (const key of SETTINGS_KEYS) {
      const definition = settingDefinitions[key]
      const result = definition.schema.safeParse(definition.default)
      expect(result.success, `${key}: ${result.success ? '' : result.error.message}`).toBe(true)
    }
  })

  it('accepts the full default snapshot', () => {
    expect(settingsSnapshotSchema.safeParse(defaultSettings()).success).toBe(true)
  })

  it('rejects an unknown key in a snapshot', () => {
    // Strict on purpose: a typo has to fail rather than be ignored.
    const withExtra = { ...defaultSettings(), 'appearance.nonsense': true }
    expect(settingsSnapshotSchema.safeParse(withExtra).success).toBe(false)
  })

  it('assigns every key to a section so none is unreachable in the UI', () => {
    const grouped = keysBySection()
    const total = Object.values(grouped).reduce((sum, keys) => sum + keys.length, 0)
    expect(total).toBe(SETTINGS_KEYS.length)
  })

  it('denies every prompted permission by default', () => {
    // Chromium's default is to approve; spec 4 requires the opposite.
    const defaults = defaultSettings()
    for (const key of SETTINGS_KEYS) {
      if (!key.startsWith('permissions.')) continue
      expect(defaults[key], key).toBe('deny')
    }
  })

  it('does not throttle inactive tiles by default', () => {
    // Spec 2: unfocused tiles must keep playing at full frame rate.
    expect(defaultSettings()['splitView.throttleInactiveTiles']).toBe(false)
  })

  it('scopes website fullscreen to the tile by default', () => {
    expect(defaultSettings()['splitView.fullscreenScope']).toBe('tile')
  })
})

describe('SettingsStore', () => {
  it('starts from defaults when no file exists', async () => {
    const store = await tempStore()
    expect(store.snapshot()).toEqual(defaultSettings())
  })

  it('stores and reads a valid value', async () => {
    const store = await tempStore()
    store.set('appearance.theme', 'dark')
    expect(store.get('appearance.theme')).toBe('dark')
  })

  it('throws on an unknown key instead of dropping the write', async () => {
    const store = await tempStore()
    expect(() => store.set('appearance.nonexistent', true)).toThrow(UnknownSettingKeyError)
  })

  it('throws on a value that fails its schema', async () => {
    const store = await tempStore()
    // Zoom is bounded at 300%.
    expect(() => store.set('appearance.defaultZoom', 5000)).toThrow(InvalidSettingValueError)
    expect(() => store.set('appearance.theme', 'chartreuse')).toThrow(InvalidSettingValueError)
  })

  it('leaves the value unchanged after a rejected write', async () => {
    const store = await tempStore()
    const before = store.get('appearance.defaultZoom')
    expect(() => store.set('appearance.defaultZoom', -1)).toThrow()
    expect(store.get('appearance.defaultZoom')).toBe(before)
  })

  it('reports only the keys that actually changed', async () => {
    const store = await tempStore()
    const first = store.set('appearance.theme', 'dark')
    expect(Object.keys(first.changed)).toEqual(['appearance.theme'])

    // Writing the same value again is not a change, so no listener should fire.
    const second = store.set('appearance.theme', 'dark')
    expect(second.changed).toEqual({})
  })

  it('compares arrays and objects by value, not by reference', async () => {
    const store = await tempStore()
    const same = store.set('advanced.spellcheckLanguages', ['de-DE', 'en-US'])
    expect(same.changed).toEqual({})

    const different = store.set('advanced.spellcheckLanguages', ['de-DE'])
    expect(Object.keys(different.changed)).toEqual(['advanced.spellcheckLanguages'])
  })

  it('notifies listeners and can unsubscribe', async () => {
    const store = await tempStore()
    const seen: string[] = []
    const unsubscribe = store.onChange(({ changed }) => seen.push(...Object.keys(changed)))

    store.set('appearance.theme', 'light')
    unsubscribe()
    store.set('appearance.theme', 'dark')

    expect(seen).toEqual(['appearance.theme'])
  })

  it('keeps working when one listener throws', async () => {
    const store = await tempStore()
    const seen: string[] = []
    store.onChange(() => {
      throw new Error('bad listener')
    })
    store.onChange(({ changed }) => seen.push(...Object.keys(changed)))

    expect(() => store.set('appearance.theme', 'light')).not.toThrow()
    expect(seen).toEqual(['appearance.theme'])
  })

  it('resets one key', async () => {
    const store = await tempStore()
    store.set('appearance.theme', 'dark')
    store.reset('appearance.theme')
    expect(store.get('appearance.theme')).toBe(defaultSettings()['appearance.theme'])
  })

  it('resets everything', async () => {
    const store = await tempStore()
    store.set('appearance.theme', 'dark')
    store.set('privacy.blockerEnabled', false)
    store.resetAll()
    expect(store.snapshot()).toEqual(defaultSettings())
  })

  it('reads stored values back from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-settings-'))
    const file = join(dir, 'settings.json')

    const first = await SettingsStore.open(file)
    first.set('appearance.theme', 'light')
    await first.flush()

    const second = await SettingsStore.open(file)
    expect(second.get('appearance.theme')).toBe('light')
  })

  it('writes the file atomically and leaves no temp file behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-settings-'))
    const file = join(dir, 'settings.json')
    const store = await SettingsStore.open(file)
    store.set('appearance.theme', 'dark')
    await store.flush()

    const contents: unknown = JSON.parse(await readFile(file, 'utf8'))
    expect((contents as Record<string, unknown>)['appearance.theme']).toBe('dark')
    await expect(readFile(`${file}.tmp`, 'utf8')).rejects.toThrow()
  })

  it('keeps unknown keys from the file and reports them', async () => {
    // A downgrade must not destroy a newer version's settings.
    const store = await tempStore({ 'from.the.future': 1, 'appearance.theme': 'dark' })
    expect(store.unknownKeysOnLoad).toEqual(['from.the.future'])
    expect(store.get('appearance.theme')).toBe('dark')
  })

  it('falls back to the default for a stored value that no longer validates', async () => {
    // A corrupt file must not lock the user out of their own browser.
    const store = await tempStore({ 'appearance.defaultZoom': 99999 })
    expect(store.get('appearance.defaultZoom')).toBe(defaultSettings()['appearance.defaultZoom'])
  })

  it('survives a file that is not valid JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-settings-'))
    const file = join(dir, 'settings.json')
    await writeFile(file, '{ this is not json')

    const store = await SettingsStore.open(file)
    expect(store.snapshot()).toEqual(defaultSettings())
  })
})

/**
 * The two password settings, and the one number that exists in two places.
 *
 * Neither existed until the section did: autofill ran with no way out and the vault's idle timeout was
 * a constant. Both are now keys, which means both can be wrong in a way the constants could not —
 * a default that disagrees with the fallback, or a bound that lets somebody park the vault open.
 */
describe('the password settings', () => {
  it('defaults the lock to what the vault falls back to, so the two never disagree', () => {
    /*
      Held by a test rather than by an import, and the direction matters: `VAULT_IDLE_TIMEOUT_MS` is
      the vault's fallback for a build with no settings behind it, so making the *setting's* default
      read from it would define the normal case in terms of the exceptional one. They have to agree;
      neither owns the other.
    */
    expect(defaultSettings()['passwords.lockAfterMinutes'] * 60_000).toBe(VAULT_IDLE_TIMEOUT_MS)
  })

  it('refuses a lock timeout that would keep the key in memory indefinitely', async () => {
    /*
      There is deliberately no "never". Somebody who wants no locking has it already — a vault with no
      master password is never idle-locked, because there is no key to drop — so the only thing a zero
      here could buy is keeping a key the user chose to protect in memory for the life of the process.
    */
    const store = await tempStore()
    expect(() => store.set('passwords.lockAfterMinutes', 0)).toThrow(InvalidSettingValueError)
    expect(() => store.set('passwords.lockAfterMinutes', 10_000)).toThrow(InvalidSettingValueError)
    store.set('passwords.lockAfterMinutes', 1)
    expect(store.get('passwords.lockAfterMinutes')).toBe(1)
  })

  it('has autofill on, because a browser that fills nothing by default is one nobody notices', () => {
    // The switch exists so it can be turned *off*; arriving off would make the feature look absent.
    expect(defaultSettings()['passwords.autofill']).toBe(true)
  })
})
