import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { describeSetting, describeSettings } from '@main/settings/describe.js'
import {
  SETTINGS_KEYS,
  settingDefinitions,
  type SettingDefinition,
  type SettingsKey
} from '@shared/settings/definitions.js'
import {
  SETTING_CONTROL_KINDS,
  type SettingControlKind,
  type SettingDescriptor
} from '@shared/settings/control.js'

/**
 * Deriving the settings UI from the settings schemas.
 *
 * This is the mechanism that keeps `definitions.ts` the single source of truth (spec 5):
 * without it the UI would need a second, hand-written table of field types, and the two
 * would drift the first time a schema changed.
 *
 * It reads zod's `def`, which is public but not a stability promise, so the important
 * property is not just "it produces the right control" — it is that an unrecognised
 * shape degrades to a read-only field instead of breaking the settings page. Both are
 * asserted here.
 *
 * The real table cannot exercise the second property: every schema in it is a shape the
 * deriver already knows. The last block therefore registers schemas of its own — real
 * zod schemas the table has no use for, and hand-built shapes standing in for what a zod
 * upgrade could hand over.
 */

/** A key of its own, so nothing that reads the real table sees these fixtures. */
const PROBE_KEY = 'probe.foreignShape' as SettingsKey

/**
 * Describes a schema that is not in the definition table.
 *
 * `describeSetting` takes a key, so a schema can only reach it through the table. The
 * entry is removed again, which keeps `describeSettings()` and every assertion about the
 * real settings unaffected by these fixtures.
 */
function describeSchema(schema: z.ZodType): SettingDescriptor {
  const table = settingDefinitions as unknown as Record<string, SettingDefinition>
  table[PROBE_KEY] = { schema, default: undefined, section: 'appearance', applies: 'live' }
  try {
    return describeSetting(PROBE_KEY)
  } finally {
    Reflect.deleteProperty(table, PROBE_KEY)
  }
}

/** What a probe descriptor looks like when the deriver adds nothing beyond the kind. */
function probeDescriptor(kind: SettingControlKind): SettingDescriptor {
  return { key: PROBE_KEY, section: 'appearance', applies: 'live', kind }
}

/**
 * The keys a descriptor actually carries.
 *
 * Presence is asserted separately from value because `min: undefined` is not the same
 * message as no `min` at all: descriptors cross IPC by structured clone, which keeps the
 * key, so a consumer listing or forwarding the fields would report a bound the schema
 * never stated.
 */
function keysOf(descriptor: SettingDescriptor): string[] {
  return Object.keys(descriptor).sort()
}

interface ForeignCheck {
  check?: string
  format?: string
  value?: unknown
  inclusive?: boolean
}

interface ForeignDef {
  type?: string
  entries?: Record<string, string>
  checks?: unknown[]
  element?: unknown
}

/** The two places this file has seen zod keep a definition. */
interface ForeignSchema {
  def?: ForeignDef
  _zod?: { def?: ForeignDef }
}

/** Nests a check the way zod does, so `checksOf` finds it where it looks. */
function foreignCheck(check: ForeignCheck): unknown {
  return { _zod: { def: check } }
}

/**
 * Widens a hand-built shape to `z.ZodType`.
 *
 * Takes a parameter rather than asserting on an object literal, which keeps the
 * "annotate, do not assert" lint rule satisfied without pretending the stand-in is a
 * real schema.
 */
function asSchema(fake: ForeignSchema): z.ZodType {
  return fake as unknown as z.ZodType
}

describe('describeSettings', () => {
  it('describes every declared setting, in declaration order', () => {
    const described = describeSettings()
    expect(described.map((descriptor) => descriptor.key)).toEqual([...SETTINGS_KEYS])
  })

  it('produces only known control kinds', () => {
    for (const descriptor of describeSettings()) {
      expect(SETTING_CONTROL_KINDS as readonly string[], descriptor.key).toContain(descriptor.kind)
    }
  })

  it('leaves nothing unsupported that the UI could have rendered', () => {
    // A drifting zod internal would show up here as a page full of read-only JSON. Every
    // shape in the table has a control today — including `advanced.customShortcuts`,
    // which is a `map` and read-only but still recognised — so the expected set is empty.
    const unsupported = describeSettings().filter((descriptor) => descriptor.kind === 'unsupported')
    expect(unsupported.map((descriptor) => descriptor.key)).toEqual([])
  })

  it('agrees with the definition table about section and timing', () => {
    for (const descriptor of describeSettings()) {
      const definition = settingDefinitions[descriptor.key as keyof typeof settingDefinitions]
      expect(descriptor.section, descriptor.key).toBe(definition.section)
      expect(descriptor.applies, descriptor.key).toBe(definition.applies)
    }
  })
})

describe('describeSetting', () => {
  it('reads a boolean as a toggle and adds nothing else', () => {
    const descriptor = describeSetting('privacy.blockThirdPartyCookies')
    expect(descriptor.kind).toBe('toggle')
    // A checkbox has no members and no bounds; anything extra here would be a field the
    // renderer ignores and a reader has to explain.
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'section'])
  })

  it('reads an enum as a choice and lists its members in declaration order', () => {
    const descriptor = describeSetting('appearance.theme')
    expect(descriptor.kind).toBe('choice')
    // The `<select>` renders these in the order given, so the order is part of the
    // contract, not an accident of how zod stores the members.
    expect(descriptor.choices).toEqual(['system', 'light', 'dark'])
  })

  it('reads a number and carries both bounds and integer-ness through', () => {
    const descriptor = describeSetting('appearance.defaultZoom')
    expect(descriptor.kind).toBe('number')
    // The store refuses 20 and 400 for this key, so the UI must know both ends rather
    // than letting the user type a value that will be rejected on save.
    expect(descriptor.min).toBe(30)
    expect(descriptor.max).toBe(300)
    // The control's `step=1` comes from this flag alone; without it the input accepts
    // 100.5, which the schema then rejects.
    expect(descriptor.integer).toBe(true)
  })

  it('reads a string as text', () => {
    expect(describeSetting('search.customEngineUrl').kind).toBe('text')
  })

  it('reads a string array as an editable list with no fixed members', () => {
    const descriptor = describeSetting('advanced.spellcheckLanguages')
    expect(descriptor.kind).toBe('text-list')
    // Any language tag is allowed here, so there is no member list to send. An empty or
    // `undefined` `choices` key would be a claim about the allowed values that this
    // schema does not make.
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'section'])
  })

  it('reads an array of enum members as a list and offers every member', () => {
    const descriptor = describeSetting('clearData.onExitCategories')
    expect(descriptor.kind).toBe('text-list')
    // The full list, not a sample: the UI shows it as the hint for what may be typed, so
    // a member lost on the way here is a category the user cannot discover.
    expect(descriptor.choices).toEqual([
      'cookies',
      'cache',
      'storage',
      'history',
      'downloads',
      'formData'
    ])
  })

  it('reads a record as a map, which the UI renders read-only', () => {
    expect(describeSetting('advanced.customShortcuts').kind).toBe('map')
  })

  it('never returns a choice without options', () => {
    // A select with no options silently offers nothing, which is worse than a visibly
    // read-only field — so `describeSetting` downgrades it instead.
    for (const descriptor of describeSettings()) {
      if (descriptor.kind !== 'choice') continue
      expect(descriptor.choices?.length ?? 0, descriptor.key).toBeGreaterThan(0)
    }
  })

  it('omits bounds it cannot read rather than inventing them', () => {
    for (const descriptor of describeSettings()) {
      if (descriptor.kind !== 'number') continue
      if (descriptor.min !== undefined) expect(Number.isFinite(descriptor.min)).toBe(true)
      if (descriptor.max !== undefined) expect(Number.isFinite(descriptor.max)).toBe(true)
      if (descriptor.min !== undefined && descriptor.max !== undefined) {
        expect(descriptor.min, descriptor.key).toBeLessThanOrEqual(descriptor.max)
      }
    }
  })

  it('marks integer-only numbers so the control steps by one', () => {
    const integers = describeSettings().filter((descriptor) => descriptor.integer === true)
    expect(integers.length).toBeGreaterThan(0)
    for (const descriptor of integers) {
      expect(descriptor.kind, descriptor.key).toBe('number')
    }
  })

  it('keeps bounds and members off the kinds that have none', () => {
    // `min` on a toggle or `choices` on a text field would describe a control that does
    // not exist. Each kind is allowed exactly the extra fields the renderer reads for it.
    const allowed: Record<SettingControlKind, string[]> = {
      toggle: [],
      choice: ['choices'],
      number: ['min', 'max', 'integer'],
      text: [],
      'text-list': ['choices'],
      map: [],
      unsupported: []
    }
    for (const descriptor of describeSettings()) {
      const extra = keysOf(descriptor).filter(
        (name) => !['key', 'section', 'applies', 'kind'].includes(name)
      )
      for (const name of extra) {
        expect(allowed[descriptor.kind], `${descriptor.key} carries ${name}`).toContain(name)
      }
    }
  })
})

describe('describeSetting reading a schema shape it was not written for', () => {
  it('downgrades a type it does not recognise to a read-only field', () => {
    // The headline promise of the module: a shape it has never seen costs one field its
    // editor, it does not take the settings page down with it.
    expect(describeSchema(z.date())).toStrictEqual(probeDescriptor('unsupported'))
    expect(describeSchema(asSchema({}))).toStrictEqual(probeDescriptor('unsupported'))
  })

  it('treats an array whose element it cannot read as read-only, without throwing', () => {
    // The element is checked before it is dereferenced. Reading a definition off
    // `undefined` or `null` throws, and this function runs for every setting on the
    // page — one such array would blank the whole page rather than one field.
    expect(describeSchema(asSchema({ def: { type: 'array' } }))).toStrictEqual(
      probeDescriptor('unsupported')
    )
    expect(describeSchema(asSchema({ def: { type: 'array', element: null } }))).toStrictEqual(
      probeDescriptor('unsupported')
    )
  })

  it('keeps an array of anything but strings or enum members read-only', () => {
    // The list editor writes back an array of trimmed strings. Offering it for an array
    // of numbers or objects would let the user save a document the schema then rejects.
    expect(describeSchema(z.array(z.number())).kind).toBe('unsupported')
    expect(describeSchema(z.array(z.object({ url: z.string() }))).kind).toBe('unsupported')
  })

  it('finds enum members in either place zod keeps them', () => {
    // The two reads are a fallback pair, not a duplicate: each shape has occurred on its
    // own, and either one alone must still be enough to fill the select.
    const nested = describeSchema(
      asSchema({ def: { type: 'enum' }, _zod: { def: { entries: { de: 'de', en: 'en' } } } })
    )
    expect(nested.kind).toBe('choice')
    expect(nested.choices).toEqual(['de', 'en'])

    const flat = describeSchema(
      asSchema({ def: { type: 'enum', entries: { de: 'de', en: 'en' } } })
    )
    expect(flat.kind).toBe('choice')
    expect(flat.choices).toEqual(['de', 'en'])
  })

  it('downgrades an enum whose members it cannot read instead of offering an empty select', () => {
    // An empty `<select>` offers nothing and looks like a broken browser; a read-only
    // field at least shows the value it refuses to change. Missing members and an empty
    // member list are the same situation and must end the same way.
    expect(describeSchema(asSchema({ def: { type: 'enum' } }))).toStrictEqual(
      probeDescriptor('unsupported')
    )
    expect(describeSchema(asSchema({ def: { type: 'enum', entries: {} } }))).toStrictEqual(
      probeDescriptor('unsupported')
    )
  })

  it('skips a check entry it cannot read and keeps the ones it can', () => {
    const schema = asSchema({
      def: {
        type: 'number',
        checks: [{}, foreignCheck({ check: 'greater_than', value: 30, inclusive: true })]
      }
    })
    const descriptor = describeSchema(schema)
    // One entry that is not shaped like a check must not throw and must not cost the
    // readable entries their bounds — that is the whole purpose of filtering the list.
    expect(descriptor.kind).toBe('number')
    expect(descriptor.min).toBe(30)
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'min', 'section'])
  })

  it('takes nothing from a check it cannot name', () => {
    const schema = asSchema({
      def: { type: 'number', checks: [foreignCheck({ format: 'safeint' })] }
    })
    // An unnamed check is not evidence about the control. Reading integer-ness out of it
    // would set `step=1` on a field whose schema never asked for whole numbers.
    expect(describeSchema(schema)).toStrictEqual(probeDescriptor('number'))
  })

  it('states no bound for a number the schema leaves unbounded', () => {
    // `min`, `max` and `integer` are claims about the control, and this schema makes
    // none of them — not even as an explicit `undefined`, which survives the trip to the
    // renderer.
    const descriptor = describeSchema(z.number())
    expect(descriptor).toStrictEqual(probeDescriptor('number'))
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'section'])
  })

  it('does not mark a fractional number as integer-only', () => {
    // Every number in the real table happens to be an integer, so this is the case the
    // table cannot cover: having a bound must not imply whole numbers, or a setting like
    // a 1.25 zoom factor becomes untypable.
    const descriptor = describeSchema(z.number().min(1))
    expect(descriptor.min).toBe(1)
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'min', 'section'])
  })

  it('marks integer-only from the number format, and only when that format is an int', () => {
    // `float64` is a number format that is not an integer one — zod records it as the
    // same kind of check as `int`, differing only in the format string. A looser test of
    // that string would put `step=1` on a field meant to take 1.5.
    const float = describeSchema(z.number().check(z.float64()))
    expect(keysOf(float)).toEqual(['applies', 'key', 'kind', 'section'])

    const integer = describeSchema(z.number().int())
    expect(integer.integer).toBe(true)
  })

  it('turns an exclusive bound into the first value the control may offer', () => {
    // `gt(30)` and `min(30)` differ by exactly one. A control that offered 30 for
    // `gt(30)` would have its value rejected on save, which reads as the browser losing
    // the change rather than as a bound the user overstepped.
    const descriptor = describeSchema(z.number().gt(30).lt(300))
    expect(descriptor.min).toBe(31)
    expect(descriptor.max).toBe(299)
  })

  it('keeps each bound at its own end whatever order the schema declares them', () => {
    // Every bounded number in the table is written `min().max()`. A reader that took the
    // last numeric check for both ends would pass on all of them and quietly report
    // min = max here.
    const descriptor = describeSchema(z.number().max(300).min(30))
    expect(descriptor.min).toBe(30)
    expect(descriptor.max).toBe(300)
  })

  it('keeps numeric bounds off a control that is not a number', () => {
    const schema = asSchema({
      def: {
        type: 'string',
        checks: [foreignCheck({ check: 'greater_than', value: 3, inclusive: true })]
      }
    })
    // Bounds are read for numbers only. A text field is not bounded by a number, so a
    // `min` on it describes a control that does not exist — and the day zod spells string
    // length with the numeric check names, that is what would arrive.
    expect(describeSchema(schema)).toStrictEqual(probeDescriptor('text'))
  })
})
