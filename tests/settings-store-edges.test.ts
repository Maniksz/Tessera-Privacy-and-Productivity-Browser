import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { SettingsStore, plainJsonCodec, type SettingsCodec } from '@main/settings/SettingsStore.js'
import { defaultSettings } from '@shared/settings/definitions.js'

/**
 * `SettingsStore` paths the behavioural tests do not reach: the debounced write,
 * a write that fails, and value comparison for the settings that hold objects and
 * arrays.
 *
 * The comparison matters more than it looks. `changed` drives the live-update
 * broadcast, so a comparison that reports a change where there is none makes every
 * open tab re-apply settings on every write, and one that misses a real change
 * leaves the UI showing something stale.
 */

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-settings-edge-'))
  return join(dir, 'settings.json')
}

describe('debounced writes', () => {
  it('writes once after a burst, without an explicit flush', async () => {
    const filePath = await tempFile()
    const store = await SettingsStore.open(filePath)

    store.set('appearance.theme', 'dark')
    store.set('appearance.theme', 'light')
    store.set('appearance.defaultZoom', 120)

    // The default debounce is 250ms; waiting proves the timer path runs rather
        // than only the flush path.
    await new Promise((resolve) => setTimeout(resolve, 400))

    const reopened = await SettingsStore.open(filePath)
    expect(reopened.get('appearance.theme')).toBe('light')
    expect(reopened.get('appearance.defaultZoom')).toBe(120)
  })

  it('cancels a pending debounce when flushed explicitly', async () => {
    const filePath = await tempFile()
    const store = await SettingsStore.open(filePath)
    store.set('appearance.theme', 'dark')
    await store.flush()

    const reopened = await SettingsStore.open(filePath)
    expect(reopened.get('appearance.theme')).toBe('dark')
  })
})

describe('write failures', () => {
  it('reports a failed write without taking the process down', async () => {
    // Settings are not worth crashing a browser over; the in-memory value stays
    // correct and the next flush can succeed.
    const broken: SettingsCodec = {
      encode: () => {
        throw new Error('disk on fire')
      },
      decode: plainJsonCodec.decode
    }
    const store = await SettingsStore.open(await tempFile(), broken)
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})

    store.set('appearance.theme', 'dark')
    await store.flush()

    expect(spy).toHaveBeenCalled()
    expect(store.get('appearance.theme')).toBe('dark')
    spy.mockRestore()
  })

  it('warns but starts when the file cannot be decoded', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, 'not json at all')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = await SettingsStore.open(filePath)
    expect(store.snapshot()).toEqual(defaultSettings())
    spy.mockRestore()
  })

  it('rejects a file whose top level is not an object', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, '[1, 2, 3]')
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const store = await SettingsStore.open(filePath)
    expect(store.snapshot()).toEqual(defaultSettings())
    spy.mockRestore()
  })
})

describe('value comparison', () => {
  it('treats an identical array as no change', async () => {
    const store = await SettingsStore.open(await tempFile())
    const current = store.get('network.secureDnsServers')
    expect(store.set('network.secureDnsServers', [...current]).changed).toEqual({})
  })

  it('detects a reordered array as a change', async () => {
    const store = await SettingsStore.open(await tempFile())
    const current = [...store.get('network.secureDnsServers')]
    const reordered = [...current].reverse()
    expect(Object.keys(store.set('network.secureDnsServers', reordered).changed)).toEqual([
      'network.secureDnsServers'
    ])
  })

  it('detects a shorter array as a change', async () => {
    const store = await SettingsStore.open(await tempFile())
    expect(
      Object.keys(store.set('network.secureDnsServers', ['https://dns.quad9.net/dns-query']).changed)
    ).toEqual(['network.secureDnsServers'])
  })

  it('treats an identical object as no change', async () => {
    const store = await SettingsStore.open(await tempFile())
    store.set('advanced.customShortcuts', { newTab: 'Control+Alt+T' })
    expect(store.set('advanced.customShortcuts', { newTab: 'Control+Alt+T' }).changed).toEqual({})
  })

  it('detects an added object key as a change', async () => {
    const store = await SettingsStore.open(await tempFile())
    store.set('advanced.customShortcuts', { newTab: 'Control+Alt+T' })
    const change = store.set('advanced.customShortcuts', {
      newTab: 'Control+Alt+T',
      closeTab: 'Control+Alt+W'
    })
    expect(Object.keys(change.changed)).toEqual(['advanced.customShortcuts'])
  })

  it('detects a removed object key as a change', async () => {
    const store = await SettingsStore.open(await tempFile())
    store.set('advanced.customShortcuts', { newTab: 'Control+Alt+T', closeTab: 'Control+Alt+W' })
    const change = store.set('advanced.customShortcuts', { newTab: 'Control+Alt+T' })
    expect(Object.keys(change.changed)).toEqual(['advanced.customShortcuts'])
  })

  it('detects a changed object value as a change', async () => {
    const store = await SettingsStore.open(await tempFile())
    store.set('advanced.customShortcuts', { newTab: 'Control+Alt+T' })
    const change = store.set('advanced.customShortcuts', { newTab: 'F1' })
    expect(Object.keys(change.changed)).toEqual(['advanced.customShortcuts'])
  })

  it('does not confuse an array with an object of the same length', async () => {
    const store = await SettingsStore.open(await tempFile())
    // `clearData.onExitCategories` is an array; a comparison that fell back to
    // object comparison would call these equal.
    store.set('clearData.onExitCategories', ['cookies'])
    expect(Object.keys(store.set('clearData.onExitCategories', ['cache']).changed)).toEqual([
      'clearData.onExitCategories'
    ])
  })
})

describe('reset paths', () => {
  it('refuses to reset an unknown key', async () => {
    const store = await SettingsStore.open(await tempFile())
    expect(() => store.reset('nope.not.a.key')).toThrow(/Unknown setting key/)
  })

  it('reports nothing changed when resetting an untouched key', async () => {
    const store = await SettingsStore.open(await tempFile())
    expect(store.reset('appearance.theme').changed).toEqual({})
  })

  it('reports every changed key when resetting everything', async () => {
    const store = await SettingsStore.open(await tempFile())
    store.set('appearance.theme', 'dark')
    store.set('privacy.blockerEnabled', false)
    const change = store.resetAll()
    expect(Object.keys(change.changed).sort()).toEqual([
      'appearance.theme',
      'privacy.blockerEnabled'
    ])
  })
})

describe('snapshot isolation', () => {
  it('hands out a copy rather than its own state', async () => {
    const store = await SettingsStore.open(await tempFile())
    const snapshot = store.snapshot() as Record<string, unknown>
    snapshot['appearance.theme'] = 'tampered'
    expect(store.get('appearance.theme')).not.toBe('tampered')
  })
})
