import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  currentVersionOf,
  describeStoreLoad,
  isReadOnlyLoad,
  restoreEntries,
  settleStoreDocument,
  splitEntries,
  type StoreLoadSpec,
  type StoreMigration
} from '@main/data/store-load.js'

/**
 * `store-load.ts`: what a decoded store file is, decided without touching a disk.
 *
 * The four outcomes are the whole point, so each has its own block, and the boundaries between them —
 * version 1 below a current of 2, a version one above it — are where the old code lost data: it read
 * every one of them as "not ours".
 */

const itemSchema = z.looseObject({ name: z.string().min(1) })

/** Version 1 of a small document: a list of items. */
const v1Schema = z.looseObject({ version: z.literal(1), items: z.array(itemSchema) })
type V1 = z.output<typeof v1Schema>

/** Version 2 renamed `items` to `entries`. */
const v2Schema = z.looseObject({ version: z.literal(2), entries: z.array(itemSchema) })
type V2 = z.output<typeof v2Schema>

const toV2: StoreMigration = (document) => {
  const { items, ...rest } = document
  return { ...rest, version: 2, entries: items }
}

function spec(overrides: Partial<StoreLoadSpec<V1>> = {}): StoreLoadSpec<V1> {
  return { schema: v1Schema, migrations: [], criticality: 'degradable', ...overrides }
}

function v2Spec(overrides: Partial<StoreLoadSpec<V2>> = {}): StoreLoadSpec<V2> {
  return { schema: v2Schema, migrations: [toV2], criticality: 'degradable', ...overrides }
}

describe('currentVersionOf', () => {
  it('is one more than the number of migrations', () => {
    // Derived rather than declared, so a chain and a number cannot disagree.
    expect(currentVersionOf([])).toBe(1)
    expect(currentVersionOf([toV2])).toBe(2)
  })
})

describe('a document at the current version', () => {
  it('is current, and parsed', () => {
    expect(settleStoreDocument({ version: 1, items: [{ name: 'a' }] }, spec())).toEqual({
      kind: 'current',
      document: { version: 1, items: [{ name: 'a' }] },
      unreadable: []
    })
  })

  it('keeps fields this build does not know, at every level', () => {
    // What a newer version added without changing the version number, which an older one must not
    // strip on the way to its next write.
    const settled = settleStoreDocument(
      { version: 1, items: [{ name: 'a', colour: 'teal' }], sync: { at: 3 } },
      spec()
    )
    expect(settled).toMatchObject({
      kind: 'current',
      document: { items: [{ name: 'a', colour: 'teal' }], sync: { at: 3 } }
    })
  })

  it('is invalid when it fails the schema, with the reason named', () => {
    expect(settleStoreDocument({ version: 1, items: 'nope' }, spec())).toEqual({
      kind: 'invalid',
      reason: expect.stringContaining('items') as unknown
    })
  })

  it('names the root when the failure is not in any one field', () => {
    const root = z.looseObject({ version: z.literal(1) }).refine(() => false, 'never')
    const settled = settleStoreDocument(
      { version: 1 },
      { schema: root, migrations: [], criticality: 'degradable' }
    )
    expect(settled).toEqual({ kind: 'invalid', reason: '(root): never' })
  })
})

describe('a document that is not one at all', () => {
  it.each([
    ['null', null],
    ['an array', [1, 2]],
    ['a number', 7],
    ['a string', 'text']
  ])('is invalid when it decodes to %s', (_label, decoded) => {
    expect(settleStoreDocument(decoded, spec())).toEqual({
      kind: 'invalid',
      reason: 'the file does not hold a JSON object'
    })
  })

  it.each([
    ['missing', {}],
    ['a string', { version: '1' }],
    ['zero', { version: 0 }],
    ['a fraction', { version: 1.5 }],
    ['unsafe', { version: Number.MAX_SAFE_INTEGER + 1 }]
  ])('is invalid when its version is %s', (_label, decoded) => {
    // A version the chain could never have produced is not "newer", it is not ours. Treating it as
    // newer would leave a broken file read-only for ever instead of copying it aside.
    expect(settleStoreDocument({ ...decoded, items: [] }, spec())).toEqual({
      kind: 'invalid',
      reason: 'the file carries no usable version number'
    })
  })
})

describe('an older document', () => {
  it('is migrated through the chain before the schema is asked', () => {
    // `z.literal(2)` would reject the version-1 file outright; migrating first is what keeps it.
    expect(
      settleStoreDocument({ version: 1, items: [{ name: 'a' }], extra: true }, v2Spec())
    ).toEqual({
      kind: 'migrated',
      fromVersion: 1,
      document: { version: 2, entries: [{ name: 'a' }], extra: true },
      unreadable: []
    })
  })

  it('runs every step from its version up, in order', () => {
    const steps: string[] = []
    const v3Schema = z.looseObject({ version: z.literal(3), trail: z.array(z.string()) })
    const settled = settleStoreDocument(
      { version: 1, trail: [] },
      {
        schema: v3Schema,
        criticality: 'degradable',
        migrations: [
          (document) => {
            steps.push('1→2')
            return { ...document, version: 2, trail: ['1→2'] }
          },
          (document) => {
            steps.push('2→3')
            return { ...document, version: 3, trail: [...(document['trail'] as string[]), '2→3'] }
          }
        ]
      }
    )
    expect(steps).toEqual(['1→2', '2→3'])
    expect(settled).toMatchObject({
      kind: 'migrated',
      fromVersion: 1,
      document: { trail: ['1→2', '2→3'] }
    })
  })

  it('is invalid when a step throws, so the file is copied aside rather than lost', () => {
    const settled = settleStoreDocument(
      { version: 1, items: [] },
      v2Spec({
        migrations: [
          () => {
            throw new Error('boom')
          }
        ]
      })
    )
    expect(settled).toEqual({
      kind: 'invalid',
      reason: 'the migration from version 1 failed: Error: boom'
    })
  })

  it('is invalid when a step produces something other than an object', () => {
    expect(
      settleStoreDocument({ version: 1, items: [] }, v2Spec({ migrations: [() => null] }))
    ).toEqual({
      kind: 'invalid',
      reason: 'the migration from version 1 produced no object'
    })
  })

  it('is invalid when the migrated document fails the current schema', () => {
    expect(
      settleStoreDocument(
        { version: 1, items: [] },
        v2Spec({ migrations: [(d) => ({ ...d, version: 2 })] })
      )
    ).toMatchObject({ kind: 'invalid', reason: expect.stringContaining('entries') as unknown })
  })
})

describe('a newer document', () => {
  it('runs a degradable store on defaults, whatever the file holds', () => {
    expect(settleStoreDocument({ version: 2, items: [{ name: 'a' }] }, spec())).toEqual({
      kind: 'newer',
      version: 2,
      readable: null,
      unreadable: []
    })
  })

  it('shows a critical store what the current schema can read of it', () => {
    // The version is replaced for the parse only; nothing read here is ever written back.
    expect(
      settleStoreDocument(
        { version: 3, items: [{ name: 'a', tag: 'new' }] },
        spec({ criticality: 'critical' })
      )
    ).toEqual({
      kind: 'newer',
      version: 3,
      readable: { version: 1, items: [{ name: 'a', tag: 'new' }] },
      unreadable: []
    })
  })

  it('shows nothing when not even the envelope is readable', () => {
    expect(
      settleStoreDocument({ version: 2, things: [] }, spec({ criticality: 'critical' }))
    ).toEqual({ kind: 'newer', version: 2, readable: null, unreadable: [] })
  })

  it('keeps the entries it can read and sets the rest aside, for a tolerant list', () => {
    const settled = settleStoreDocument(
      { version: 2, items: [{ name: 'a' }, { name: 42 }] },
      spec({ criticality: 'critical', tolerant: { field: 'items', entry: itemSchema } })
    )
    expect(settled).toEqual({
      kind: 'newer',
      version: 2,
      readable: { version: 1, items: [{ name: 'a' }] },
      unreadable: [{ index: 1, value: { name: 42 } }]
    })
  })
})

describe('tolerant entries', () => {
  const tolerant = { field: 'items', entry: itemSchema }

  it('costs a broken entry only itself', () => {
    const settled = settleStoreDocument(
      { version: 1, items: [{ name: 'a' }, { name: '' }, { name: 'c' }] },
      spec({ tolerant })
    )
    expect(settled).toEqual({
      kind: 'current',
      document: { version: 1, items: [{ name: 'a' }, { name: 'c' }] },
      unreadable: [{ index: 1, value: { name: '' } }]
    })
  })

  it('keeps them through a migration too', () => {
    const settled = settleStoreDocument(
      { version: 1, items: [{ name: '' }, { name: 'b' }] },
      v2Spec({ tolerant: { field: 'entries', entry: itemSchema } })
    )
    expect(settled).toMatchObject({
      kind: 'migrated',
      document: { entries: [{ name: 'b' }] },
      unreadable: [{ index: 0, value: { name: '' } }]
    })
  })

  it('does not split a field that is not a list, so the envelope fails whole', () => {
    // The envelope stays strict: a string where the list belongs is a file that is not ours.
    expect(settleStoreDocument({ version: 1, items: 'nope' }, spec({ tolerant }))).toMatchObject({
      kind: 'invalid'
    })
  })

  it('splits by the entry schema and keeps the readable entries as stored', () => {
    const stored = { name: 'a', extra: 1 }
    const split = splitEntries([stored, 3, { name: 'b' }], itemSchema)
    expect(split.readable).toEqual([stored, { name: 'b' }])
    expect(split.readable[0]).toBe(stored)
    expect(split.unreadable).toEqual([{ index: 1, value: 3 }])
  })

  it('puts unreadable entries back exactly where they were', () => {
    const values = [{ name: 'a' }, 1, { name: 'b' }, 2, 3]
    const split = splitEntries(values, itemSchema)
    // Out of order on purpose: the restore sorts, so the caller's order does not matter.
    expect(restoreEntries(split.readable, [...split.unreadable].reverse())).toEqual(values)
  })

  it('appends the ones whose place no longer exists', () => {
    expect(restoreEntries([{ name: 'a' }], [{ index: 5, value: 'raw' }])).toEqual([
      { name: 'a' },
      'raw'
    ])
  })

  it('leaves the list it was given alone', () => {
    const entries = [{ name: 'a' }]
    restoreEntries(entries, [{ index: 0, value: 'raw' }])
    expect(entries).toEqual([{ name: 'a' }])
  })
})

describe('isReadOnlyLoad', () => {
  it.each([
    [{ kind: 'missing' } as const, false],
    [{ kind: 'current' } as const, false],
    [{ kind: 'newer', version: 2 } as const, true],
    [{ kind: 'migrated', fromVersion: 1, backup: '/p/x.v1.bak' } as const, false],
    [{ kind: 'migrated', fromVersion: 1, backup: null } as const, true],
    [{ kind: 'invalid', reason: 'r', copy: '/p/x.unreadable' } as const, false],
    [{ kind: 'invalid', reason: 'r', copy: null } as const, true]
  ])('%o is read-only: %s', (outcome, expected) => {
    // One rule: read-only exactly when the original is not safe yet.
    expect(isReadOnlyLoad(outcome)).toBe(expected)
  })
})

describe('describeStoreLoad', () => {
  it('says nothing about a clean load or a first run', () => {
    expect(
      describeStoreLoad({ outcome: { kind: 'missing' }, criticality: 'degradable' })
    ).toBeNull()
    expect(describeStoreLoad({ outcome: { kind: 'current' }, criticality: 'critical' })).toBeNull()
  })

  it('tells a degradable store that this run’s changes are lost, and a critical one that they are refused', () => {
    const outcome = { kind: 'newer', version: 3 } as const
    expect(describeStoreLoad({ outcome, criticality: 'degradable' })).toBe(
      'the file was written by a newer version (version 3) and is left untouched; changes made in this run are discarded'
    )
    expect(describeStoreLoad({ outcome, criticality: 'critical' })).toBe(
      'the file was written by a newer version (version 3) and is left untouched; it is read-only in this run and changes are refused'
    )
  })

  it('names the backup of a migration, or says there is none', () => {
    expect(
      describeStoreLoad({
        outcome: { kind: 'migrated', fromVersion: 1, backup: '/p/h.json.v1.bak' },
        criticality: 'degradable'
      })
    ).toBe('the file was upgraded from version 1; the original is kept at /p/h.json.v1.bak')
    expect(
      describeStoreLoad({
        outcome: { kind: 'migrated', fromVersion: 1, backup: null },
        criticality: 'degradable'
      })
    ).toBe(
      'the file was upgraded from version 1 in memory, but no backup could be made; changes made in this run are discarded'
    )
  })

  it('names the copy of an unusable file, or says it could not be made', () => {
    expect(
      describeStoreLoad({
        outcome: { kind: 'invalid', reason: 'bad', copy: '/p/h.json.unreadable' },
        criticality: 'degradable'
      })
    ).toBe(
      'the file could not be used (bad); started from defaults, the original is kept at /p/h.json.unreadable'
    )
    expect(
      describeStoreLoad({
        outcome: { kind: 'invalid', reason: 'bad', copy: null },
        criticality: 'critical'
      })
    ).toBe(
      'the file could not be used (bad) and could not be copied aside; started from defaults, and it is read-only in this run and changes are refused'
    )
  })
})
