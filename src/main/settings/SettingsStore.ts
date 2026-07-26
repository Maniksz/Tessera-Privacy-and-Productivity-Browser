import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import type { DocumentCodec } from '../data/JsonStore.js'
import { dirname } from 'node:path'
import {
  defaultSettings,
  isSettingsKey,
  settingDefinitions,
  type SettingValue,
  type SettingsKey,
  type SettingsSnapshot
} from '@shared/settings/definitions.js'

/**
 * The one place settings are read from and written to (spec 5).
 *
 * Two rules are enforced here rather than trusted to callers:
 *
 *   1. Writing an unknown key throws. A silently-dropped write is exactly the
 *      failure mode spec 5 forbids — a switch that flips and does nothing.
 *   2. A value that fails its schema throws, with the schema's own message.
 *
 * Both surface as rejected IPC calls, which the UI turns into a visible error.
 */

export class UnknownSettingKeyError extends Error {
  constructor(readonly key: string) {
    super(`Unknown setting key: ${key}`)
    this.name = 'UnknownSettingKeyError'
  }
}

export class InvalidSettingValueError extends Error {
  constructor(
    readonly key: string,
    readonly detail: string
  ) {
    super(`Invalid value for ${key}: ${detail}`)
    this.name = 'InvalidSettingValueError'
  }
}

export interface SettingsChange {
  /** Only the keys whose values actually differ. */
  changed: Record<string, unknown>
  snapshot: SettingsSnapshot
}

export type SettingsListener = (change: SettingsChange) => void

/**
 * Serialisation seam, shared with every other store.
 *
 * Spec 3 requires all local data encrypted at rest; the plain codec below is what runs until
 * the encrypted one is handed in, and nothing above this line changes when it is.
 *
 * This file used to declare a narrower one, whose `decode` promised a `Record`. The encrypted
 * codec cannot satisfy that: a decrypted document is `unknown` until something inspects it, and
 * the inspection has to happen where "this is not a settings object" can be *decided* rather
 * than thrown into a catch that shrugs. One codec type across the four stores is also what lets
 * encryption be switched on in one place.
 */
export type SettingsCodec = DocumentCodec

export const plainJsonCodec: SettingsCodec = {
  encode: (data) => new TextEncoder().encode(JSON.stringify(data, null, 2)),
  decode: (bytes) => JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

/**
 * Narrows a decoded document, or rejects it as unreadable.
 *
 * An array or a bare number is not a partially-valid settings file; it is a file this build
 * cannot interpret, and it must be treated the same way as unparseable bytes.
 */
function asSettingsObject(decoded: unknown): Record<string, unknown> {
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('settings file does not contain a JSON object')
  }
  return decoded as Record<string, unknown>
}

/**
 * Moves an unreadable settings file aside, and says where it went.
 *
 * The alternative is what this code used to do: warn to a console nobody reads, start with
 * defaults, and destroy the file on the next write. That turns "I cannot read this" into "your
 * settings are gone", which is the worse of the two failures by a wide margin — especially once
 * the file is ciphertext, where unreadable most often means *the key is missing*, not that the
 * data is broken.
 *
 * A failed rename is rethrown rather than ignored: if the file cannot be moved out of the way,
 * the next write would overwrite it, and refusing to start is the only remaining way not to.
 */
async function quarantineUnreadable(filePath: string): Promise<string> {
  for (let attempt = 0; ; attempt += 1) {
    const target = attempt === 0 ? `${filePath}.unreadable` : `${filePath}.unreadable.${attempt}`
    try {
      // `wx` fails if the name is taken, which is how a previous quarantine is preserved instead
      // of being overwritten by this one.
      await writeFile(target, await readFile(filePath), { flag: 'wx', mode: 0o600 })
      return target
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
      // Name taken by an earlier quarantine; try the next one.
    }
  }
}

export class SettingsStore {
  #values: Record<string, unknown>
  readonly #listeners = new Set<SettingsListener>()
  #writeQueue: Promise<void> = Promise.resolve()
  #pendingWrite: NodeJS.Timeout | null = null
  #quarantinedFile: string | null = null

  /**
   * Keys found in the file that this build does not know. Reported so the
   * diagnostics page can show them.
   */
  readonly unknownKeysOnLoad: string[] = []

  /**
   * The values behind those keys, carried through untouched and written back on
   * every flush.
   *
   * Holding the names alone would not be enough: the next write would emit only
   * the keys this build knows, and a newer version's settings would be destroyed
   * by the act of running an older one. They are kept separate from `#values` so
   * they can never be read as if they were settings.
   */
  readonly #unknownValues: Record<string, unknown> = {}

  private constructor(
    private readonly filePath: string,
    private readonly codec: SettingsCodec,
    values: Record<string, unknown>
  ) {
    this.#values = values
  }

  static async open(filePath: string, codec: SettingsCodec = plainJsonCodec): Promise<SettingsStore> {
    const values: Record<string, unknown> = { ...defaultSettings() }
    const unknown: string[] = []
    const unknownValues: Record<string, unknown> = {}

    let quarantined: string | null = null

    try {
      const bytes = await readFile(filePath)
      const stored = asSettingsObject(await codec.decode(bytes))
      for (const [key, value] of Object.entries(stored)) {
        if (!isSettingsKey(key)) {
          unknown.push(key)
          unknownValues[key] = value
          continue
        }
        const parsed = settingDefinitions[key].schema.safeParse(value)
        // A stored value that no longer validates falls back to the default
        // rather than refusing to start: a corrupt file must not lock the user
        // out of their own browser.
        if (parsed.success) values[key] = parsed.data
      }
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'ENOENT') {
        // The file is there and this build cannot read it. Defaults are the right thing to run
        // with; overwriting the file with them is not, and that is exactly what the next write
        // would do. See `quarantineUnreadable`.
        quarantined = await quarantineUnreadable(filePath)
      }
    }

    const store = new SettingsStore(filePath, codec, values)
    store.unknownKeysOnLoad.push(...unknown)
    store.#quarantinedFile = quarantined
    Object.assign(store.#unknownValues, unknownValues)
    return store
  }

  /**
   * Where an unreadable settings file was moved on load, or null.
   *
   * Exposed rather than logged so the diagnostics surface can tell the user their previous
   * settings still exist and where — the difference between a recoverable morning and a lost one.
   */
  get quarantinedFileOnLoad(): string | null {
    return this.#quarantinedFile
  }

  get<K extends SettingsKey>(key: K): SettingValue<K> {
    return this.#values[key] as SettingValue<K>
  }

  snapshot(): SettingsSnapshot {
    return { ...this.#values } as unknown as SettingsSnapshot
  }

  /**
   * Validates and stores one setting.
   *
   * @throws UnknownSettingKeyError  when the key is not in the definition table
   * @throws InvalidSettingValueError when the value fails the key's schema
   */
  set(key: string, value: unknown): SettingsChange {
    if (!isSettingsKey(key)) throw new UnknownSettingKeyError(key)

    const parsed = settingDefinitions[key].schema.safeParse(value)
    if (!parsed.success) {
      const detail = parsed.error.issues.map((issue) => issue.message).join('; ')
      throw new InvalidSettingValueError(key, detail)
    }

    return this.#applyMany({ [key]: parsed.data })
  }

  reset(key: string): SettingsChange {
    if (!isSettingsKey(key)) throw new UnknownSettingKeyError(key)
    return this.#applyMany({ [key]: settingDefinitions[key].default })
  }

  resetAll(): SettingsChange {
    return this.#applyMany({ ...defaultSettings() })
  }

  onChange(listener: SettingsListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #applyMany(updates: Record<string, unknown>): SettingsChange {
    const changed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(updates)) {
      if (deepEqual(this.#values[key], value)) continue
      this.#values[key] = value
      changed[key] = value
    }

    const change: SettingsChange = { changed, snapshot: this.snapshot() }
    if (Object.keys(changed).length > 0) {
      this.#scheduleWrite()
      for (const listener of this.#listeners) {
        try {
          listener(change)
        } catch (error) {
          // One bad listener must not stop the others, or a UI bug becomes a
          // core bug.
          console.error('[settings] listener threw:', error)
        }
      }
    }
    return change
  }

  #scheduleWrite(): void {
    if (this.#pendingWrite) clearTimeout(this.#pendingWrite)
    this.#pendingWrite = setTimeout(() => {
      this.#pendingWrite = null
      void this.flush()
    }, 250)
  }

  /**
   * Writes pending changes and resolves once they are on disk.
   *
   * Awaited during shutdown: settings written after the process exits are
   * settings lost, the same trap spec 4 flags for delete-on-exit.
   */
  flush(): Promise<void> {
    if (this.#pendingWrite) {
      clearTimeout(this.#pendingWrite)
      this.#pendingWrite = null
    }
    // Unknown keys first, so a known key always wins if a newer version ever
    // renamed something into a name this build owns.
    const data = { ...this.#unknownValues, ...this.#values }
    this.#writeQueue = this.#writeQueue.then(async () => {
      try {
        await mkdir(dirname(this.filePath), { recursive: true })
        const bytes = await this.codec.encode(data)
        // Write-then-rename: a crash mid-write leaves the previous file intact
        // instead of a truncated one.
        const temp = `${this.filePath}.tmp`
        await writeFile(temp, bytes, { mode: 0o600 })
        await rename(temp, this.filePath)
      } catch (error) {
        console.error('[settings] write failed:', error)
      }
    })
    return this.#writeQueue
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((item, index) => deepEqual(item, b[index]))
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const left = a as Record<string, unknown>
    const right = b as Record<string, unknown>
    const keys = Object.keys(left)
    if (keys.length !== Object.keys(right).length) return false
    return keys.every((key) => deepEqual(left[key], right[key]))
  }
  return false
}
