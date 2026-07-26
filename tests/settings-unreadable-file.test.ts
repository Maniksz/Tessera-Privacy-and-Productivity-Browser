import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SettingsStore, plainJsonCodec, type SettingsCodec } from '@main/settings/SettingsStore.js'
import { defaultSettings } from '@shared/settings/definitions.js'

/**
 * What happens when the settings file cannot be read.
 *
 * This used to warn to a console nobody reads, start with defaults, and destroy the file on the
 * next write — turning "I cannot read this" into "your settings are gone". It matters more once
 * the file is ciphertext, because *unreadable* then usually means the key is missing, not that
 * the data is broken: the settings are intact and one keychain entry away.
 *
 * The distinction these tests pin down is between three different situations that used to be one:
 * no file yet, a file this build cannot interpret, and a readable file holding a value that no
 * longer validates.
 */

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'tessera-settings-'))
  return join(dir, 'settings.json')
}

/** A codec that refuses everything, standing in for ciphertext without the key. */
const undecryptableCodec: SettingsCodec = {
  encode: plainJsonCodec.encode,
  decode: () => {
    throw new Error('no key for this document')
  }
}

describe('no settings file yet', () => {
  it('starts with defaults and quarantines nothing', async () => {
    const filePath = await tempFile()
    const store = await SettingsStore.open(filePath)
    expect(store.quarantinedFileOnLoad).toBeNull()
    expect(store.get('appearance.theme')).toBe(defaultSettings()['appearance.theme'])
  })
})

describe('an unreadable settings file', () => {
  it('keeps the original bytes instead of overwriting them', async () => {
    // The whole point. The file is the user's settings; defaults are this build's guess.
    const filePath = await tempFile()
    await writeFile(filePath, '{ this is not json')

    const store = await SettingsStore.open(filePath)
    const quarantined = store.quarantinedFileOnLoad
    expect(quarantined).not.toBeNull()
    expect(await readFile(quarantined!, 'utf8')).toBe('{ this is not json')

    // And a later write must not resurrect the bad content or fail.
    store.set('appearance.theme', 'dark')
    await store.flush()
    expect(await readFile(quarantined!, 'utf8')).toBe('{ this is not json')
  })

  it('still starts, with defaults', async () => {
    // Refusing to start would lock the user out of the browser that holds their bookmarks.
    const filePath = await tempFile()
    await writeFile(filePath, 'not json at all')
    const store = await SettingsStore.open(filePath)
    expect(store.get('appearance.theme')).toBe(defaultSettings()['appearance.theme'])
  })

  it('treats ciphertext it has no key for the same way', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, 'OBENCsealed bytes')

    const store = await SettingsStore.open(filePath, undecryptableCodec)
    expect(store.quarantinedFileOnLoad).not.toBeNull()
    expect(await readFile(store.quarantinedFileOnLoad!, 'utf8')).toBe('OBENCsealed bytes')
  })

  it('rejects a document that decodes to something other than an object', async () => {
    // An array is not a partly-valid settings file; it is a file this build cannot interpret.
    const filePath = await tempFile()
    await writeFile(filePath, '[1, 2, 3]')
    const store = await SettingsStore.open(filePath)
    expect(store.quarantinedFileOnLoad).not.toBeNull()
  })

  it('rejects a document that decodes to null', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, 'null')
    const store = await SettingsStore.open(filePath)
    expect(store.quarantinedFileOnLoad).not.toBeNull()
  })

  it('does not overwrite an earlier quarantine', async () => {
    // Two bad starts in a row must leave two files, not one. The first is the one with the
    // settings the user actually had.
    const filePath = await tempFile()
    await writeFile(filePath, 'first bad file')
    const first = (await SettingsStore.open(filePath)).quarantinedFileOnLoad

    await writeFile(filePath, 'second bad file')
    const second = (await SettingsStore.open(filePath)).quarantinedFileOnLoad

    expect(second).not.toBe(first)
    expect(await readFile(first!, 'utf8')).toBe('first bad file')
    expect(await readFile(second!, 'utf8')).toBe('second bad file')
  })
})

describe('a readable file with a value that no longer validates', () => {
  it('falls back for that key alone and quarantines nothing', async () => {
    // This is the case the old catch-all conflated with the ones above, and the only one where
    // falling back silently is right: the file is intelligible, one value in it is not.
    const filePath = await tempFile()
    await writeFile(
      filePath,
      JSON.stringify({ 'appearance.theme': 'chartreuse', 'appearance.defaultZoom': 150 })
    )

    const store = await SettingsStore.open(filePath)
    expect(store.quarantinedFileOnLoad).toBeNull()
    expect(store.get('appearance.theme')).toBe(defaultSettings()['appearance.theme'])
    expect(store.get('appearance.defaultZoom')).toBe(150)
  })

  it('keeps a key this build does not know, and reports it', async () => {
    const filePath = await tempFile()
    await writeFile(filePath, JSON.stringify({ 'from.the.future': 42 }))

    const store = await SettingsStore.open(filePath)
    expect(store.quarantinedFileOnLoad).toBeNull()
    expect(store.unknownKeysOnLoad).toEqual(['from.the.future'])
  })
})

describe('the codec seam', () => {
  it('round-trips through a codec that is not plain JSON', async () => {
    // Spec 3 switches encryption on by handing in a codec here. A store that ignored it would
    // keep working and keep writing clear text, so the marker is what makes that visible.
    const marker = 'sealed:'
    const codec: SettingsCodec = {
      encode: (data) => new TextEncoder().encode(`${marker}${JSON.stringify(data)}`),
      decode: (bytes) => {
        const text = new TextDecoder().decode(bytes)
        if (!text.startsWith(marker)) throw new Error('not written by this codec')
        return JSON.parse(text.slice(marker.length)) as unknown
      }
    }

    const filePath = await tempFile()
    const store = await SettingsStore.open(filePath, codec)
    store.set('appearance.theme', 'dark')
    await store.flush()

    expect(await readFile(filePath, 'utf8')).toMatch(/^sealed:\{/)
    const reopened = await SettingsStore.open(filePath, codec)
    expect(reopened.get('appearance.theme')).toBe('dark')
    expect(reopened.quarantinedFileOnLoad).toBeNull()
  })
})
