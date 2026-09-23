import { describe, expect, it } from 'vitest'
import type { SafeStorage } from 'electron'
import { classifyKeystore } from '@main/crypto/keystore-strength.js'
import type { SafeStorageLike } from '@main/crypto/local-data-key.js'

/**
 * How much `safeStorage` actually protects (R14).
 *
 * The product failure this guards is a Linux desktop without a keyring being reported as protected.
 * Chromium falls back to `basic_text` there, whose key is built into the browser, and
 * `isEncryptionAvailable()` still answers `true` — so every answer derived from availability alone
 * said "encrypted" about a key anyone with the folder can unwrap.
 *
 * The backend is counted as well as classified: on macOS and Windows it must not be asked at all,
 * because the method is Linux-only and there is nothing to choose between.
 */

interface ProbedKeystore extends SafeStorageLike {
  readonly asked: () => number
}

function keystore(options: { available?: boolean; backend?: string } = {}): ProbedKeystore {
  let asked = 0
  const available = options.available ?? true
  const base = {
    asked: () => asked,
    isEncryptionAvailable: () => available,
    encryptString: (plainText: string) => Buffer.from(plainText, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8')
  }
  const backend = options.backend
  if (backend === undefined) return base
  return {
    ...base,
    getSelectedStorageBackend: () => {
      asked += 1
      return backend
    }
  }
}

describe('the strength of the key store', () => {
  it('trusts a Linux keyring', () => {
    for (const backend of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) {
      expect(classifyKeystore(keystore({ backend }), 'linux'), backend).toBe('os')
    }
  })

  it('calls basic text weak, although it reports that encryption is available', () => {
    const basic = keystore({ backend: 'basic_text' })
    expect(basic.isEncryptionAvailable()).toBe(true)
    expect(classifyKeystore(basic, 'linux')).toBe('weak')
    expect(basic.asked()).toBe(1)
  })

  it('calls an unknown backend weak rather than rounding it up', () => {
    // `unknown` is what Electron answers before `ready`; after it, it names nothing this build can vouch
    // for. The same holds for a backend name a later Chromium adds.
    expect(classifyKeystore(keystore({ backend: 'unknown' }), 'linux')).toBe('weak')
    expect(classifyKeystore(keystore({ backend: 'some_future_store' }), 'linux')).toBe('weak')
  })

  it('calls a Linux key store that cannot name its backend weak', () => {
    expect(classifyKeystore(keystore(), 'linux')).toBe('weak')
  })

  it('does not ask for the backend on macOS or Windows', () => {
    for (const platform of ['darwin', 'win32'] as const) {
      // A backend that would be weak on Linux, to show the answer comes from the platform alone.
      const store = keystore({ backend: 'basic_text' })
      expect(classifyKeystore(store, platform), platform).toBe('os')
      expect(store.asked(), platform).toBe(0)
    }
  })

  it('reports no key store at all as none, without asking for a backend', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const store = keystore({ available: false, backend: 'gnome_libsecret' })
      expect(classifyKeystore(store, platform), platform).toBe('none')
      expect(store.asked(), platform).toBe(0)
    }
  })

  it('takes Electron own safeStorage, backend included', () => {
    // Checked by `pnpm typecheck`: if Electron renames the method or widens its answer, this stops
    // compiling rather than the classification silently reading `undefined` on Linux.
    const asKeyStore: (storage: SafeStorage) => SafeStorageLike = (storage) => storage
    const backendOf: (storage: SafeStorage) => string = (storage) =>
      storage.getSelectedStorageBackend()
    expect(asKeyStore).toBeTypeOf('function')
    expect(backendOf).toBeTypeOf('function')
  })
})
