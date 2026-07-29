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
import { LOCALES, type Locale } from '@shared/i18n/catalog.js'
import { settingTextFor, settingTextKeys } from '@main/settings/settings-text.js'

/**
 * Deriving the settings UI from the settings schemas, and the words that go with it.
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
 * deriver already knows. The third block therefore registers schemas of its own — real
 * zod schemas the table has no use for, and hand-built shapes standing in for what a zod
 * upgrade could hand over.
 *
 * ## Why the text tables are guarded here and not in `ipc-contract.test.ts`
 *
 * The message catalogue gets three checks there: both locales carry the same keys, no
 * translation is empty, and no translation loses a placeholder. `main/settings/settings-text.*`
 * is a catalogue in every respect except that it is not *the* catalogue — it deliberately sits
 * in the core so that six internal pages do not download settings prose before first paint —
 * and it therefore had none of those checks. The last block writes them out again, plus the
 * one the catalogue cannot have: every setting in `settingDefinitions` has a label. That last
 * assertion is the fitness function. Its job is to stop a setting from shipping nameless, the
 * way all seventy-six of them did while the renderer was inventing labels out of the key.
 */

/** The reference locale, used wherever a test needs one and does not care which. */
const EN: Locale = 'en'

/** A key of its own, so nothing that reads the real table sees these fixtures. */
const PROBE_KEY = 'probe.foreignShape' as SettingsKey

/**
 * Describes a schema that is not in the definition table.
 *
 * `describeSetting` takes a key, so a schema can only reach it through the table. The
 * entry is removed again, which keeps `describeSettings(EN)` and every assertion about the
 * real settings unaffected by these fixtures.
 */
function describeSchema(schema: z.ZodType): SettingDescriptor {
  const table = settingDefinitions as unknown as Record<string, SettingDefinition>
  table[PROBE_KEY] = { schema, default: undefined, section: 'appearance', applies: 'live' }
  try {
    return describeSetting(PROBE_KEY, EN)
  } finally {
    Reflect.deleteProperty(table, PROBE_KEY)
  }
}

/**
 * What a probe descriptor looks like when the deriver adds nothing beyond the kind.
 *
 * The label is the derived-from-the-key fallback, which is the correct answer for a key the
 * text table has never heard of — and the probe key is exactly that. It is also the only place
 * that fallback is exercised, because the assertion further down makes sure no *real* setting
 * ever reaches it.
 */
function probeDescriptor(kind: SettingControlKind): SettingDescriptor {
  return { key: PROBE_KEY, section: 'appearance', applies: 'live', kind, label: 'Foreign Shape' }
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
    const described = describeSettings(EN)
    expect(described.map((descriptor) => descriptor.key)).toEqual([...SETTINGS_KEYS])
  })

  it('produces only known control kinds', () => {
    for (const descriptor of describeSettings(EN)) {
      expect(SETTING_CONTROL_KINDS as readonly string[], descriptor.key).toContain(descriptor.kind)
    }
  })

  it('leaves nothing unsupported that the UI could have rendered', () => {
    // A drifting zod internal would show up here as a page full of read-only JSON. Every
    // shape in the table has a control today — including `advanced.customShortcuts`,
    // which is a `map` and read-only but still recognised — so the expected set is empty.
    const unsupported = describeSettings(EN).filter(
      (descriptor) => descriptor.kind === 'unsupported'
    )
    expect(unsupported.map((descriptor) => descriptor.key)).toEqual([])
  })

  it('agrees with the definition table about section and timing', () => {
    for (const descriptor of describeSettings(EN)) {
      const definition = settingDefinitions[descriptor.key as keyof typeof settingDefinitions]
      expect(descriptor.section, descriptor.key).toBe(definition.section)
      expect(descriptor.applies, descriptor.key).toBe(definition.applies)
    }
  })
})

describe('describeSetting', () => {
  it('reads a boolean as a toggle and adds nothing else', () => {
    const descriptor = describeSetting('privacy.blockThirdPartyCookies', EN)
    expect(descriptor.kind).toBe('toggle')
    // A checkbox has no members and no bounds; anything extra here would be a field the
    // renderer ignores and a reader has to explain. `label` is not extra — it is required, and
    // this setting is deliberately one of the ones whose name says everything, so it has no
    // description either.
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'label', 'section'])
    expect(descriptor.label).toBe('Block third-party cookies')
  })

  it('reads an enum as a choice and lists its members in declaration order', () => {
    const descriptor = describeSetting('appearance.theme', EN)
    expect(descriptor.kind).toBe('choice')
    // The `<select>` renders these in the order given, so the order is part of the
    // contract, not an accident of how zod stores the members.
    expect(descriptor.choices).toEqual(['system', 'light', 'dark'])
    // And the names beside them, keyed by member rather than positional: a member inserted in
    // the schema must not shift every label by one.
    expect(descriptor.choiceLabels).toEqual({
      system: 'Follow the system',
      light: 'Light',
      dark: 'Dark'
    })
  })

  it('answers in the language it was asked in', () => {
    /*
      The whole point of the locale parameter, and the thing that was broken before it existed: a
      German user read `Block third party cookies`, because the renderer built every label out of
      the key. The label, the description and the member names all have to move together — a screen
      that translated two of the three would be worse than one that translated none, because the
      untranslated part would look like an oversight rather than a policy.
    */
    const english = describeSetting('appearance.theme', 'en')
    const german = describeSetting('appearance.theme', 'de')

    expect(english.label).toBe('Theme')
    expect(german.label).toBe('Erscheinungsbild')
    expect(german.description).not.toBe(english.description)
    expect(german.choiceLabels?.['dark']).toBe('Dunkel')
    // Everything that is not text is the same answer in both, because it comes from the schema.
    expect(german.choices).toEqual(english.choices)
    expect(german.kind).toBe(english.kind)
  })

  it('sends a description only where there is one to send', () => {
    /*
      An absent description has to be absent, not `undefined`.

      Descriptors cross IPC by structured clone, which keeps a key whose value is `undefined` — so
      the renderer would see a `description` field on every setting and could not tell "no sentence"
      from "an empty sentence" without inspecting the value. The same reasoning the bounds already
      follow.
    */
    expect(keysOf(describeSetting('privacy.blockThirdPartyCookies', EN))).not.toContain(
      'description'
    )
    expect(describeSetting('network.killSwitch', EN).description).toContain('Not implemented')
  })

  it('leaves the layout ids unlabelled, because they read the same in every language', () => {
    // The one choice deliberately without member names. Translating `1x2` would invent a difference
    // between the locales and give the German table something to get wrong.
    const descriptor = describeSetting('splitView.defaultLayout', EN)
    expect(descriptor.choices).toContain('2x2')
    expect(descriptor.choiceLabels).toBeUndefined()
  })

  it('reads a number and carries both bounds and integer-ness through', () => {
    const descriptor = describeSetting('appearance.defaultZoom', EN)
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
    expect(describeSetting('search.customEngineUrl', EN).kind).toBe('text')
  })

  it('reads a string array as an editable list with no fixed members', () => {
    const descriptor = describeSetting('advanced.spellcheckLanguages', EN)
    expect(descriptor.kind).toBe('text-list')
    // Any language tag is allowed here, so there is no member list to send. An empty or
    // `undefined` `choices` key would be a claim about the allowed values that this
    // schema does not make. `description` is present because this is one of the settings the
    // browser does not honour yet, which is precisely the case the sentence exists for.
    expect(keysOf(descriptor)).toEqual([
      'applies',
      'description',
      'key',
      'kind',
      'label',
      'section'
    ])
  })

  it('reads an array of enum members as a list and offers every member', () => {
    const descriptor = describeSetting('clearData.onExitCategories', EN)
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
    expect(describeSetting('advanced.customShortcuts', EN).kind).toBe('map')
  })

  it('never returns a choice without options', () => {
    // A select with no options silently offers nothing, which is worse than a visibly
    // read-only field — so `describeSetting` downgrades it instead.
    for (const descriptor of describeSettings(EN)) {
      if (descriptor.kind !== 'choice') continue
      expect(descriptor.choices?.length ?? 0, descriptor.key).toBeGreaterThan(0)
    }
  })

  it('omits bounds it cannot read rather than inventing them', () => {
    for (const descriptor of describeSettings(EN)) {
      if (descriptor.kind !== 'number') continue
      if (descriptor.min !== undefined) expect(Number.isFinite(descriptor.min)).toBe(true)
      if (descriptor.max !== undefined) expect(Number.isFinite(descriptor.max)).toBe(true)
      if (descriptor.min !== undefined && descriptor.max !== undefined) {
        expect(descriptor.min, descriptor.key).toBeLessThanOrEqual(descriptor.max)
      }
    }
  })

  it('marks integer-only numbers so the control steps by one', () => {
    const integers = describeSettings(EN).filter((descriptor) => descriptor.integer === true)
    expect(integers.length).toBeGreaterThan(0)
    for (const descriptor of integers) {
      expect(descriptor.kind, descriptor.key).toBe('number')
    }
  })

  it('keeps bounds and members off the kinds that have none', () => {
    // `min` on a toggle or `choices` on a text field would describe a control that does
    // not exist. Each kind is allowed exactly the extra fields the renderer reads for it.
    //
    // `choiceLabels` is allowed only beside `choices`, and for the same reason the bounds are
    // restricted: it is a claim about members, so a kind with no members must not carry it.
    const allowed: Record<SettingControlKind, string[]> = {
      toggle: [],
      choice: ['choices', 'choiceLabels'],
      number: ['min', 'max', 'integer'],
      text: [],
      'text-list': ['choices'],
      map: [],
      unsupported: []
    }
    // `label` and `description` are not per-kind extras: every kind carries the first and any
    // kind may carry the second, so they are excluded alongside the four structural fields.
    const universal = ['key', 'section', 'applies', 'kind', 'label', 'description']
    for (const descriptor of describeSettings(EN)) {
      const extra = keysOf(descriptor).filter((name) => !universal.includes(name))
      for (const name of extra) {
        expect(allowed[descriptor.kind], `${descriptor.key} carries ${name}`).toContain(name)
      }
    }
  })

  it('names no member that the schema does not offer', () => {
    /*
      The text table and the schemas are maintained apart, so they can disagree — a member renamed
      in `definitions.ts` leaves its old name sitting in the table, correct-looking and unreachable.
      Filtering against the schema's members is what makes that disagreement invisible to the user
      and visible here.
    */
    for (const locale of LOCALES) {
      for (const descriptor of describeSettings(locale)) {
        const offered = descriptor.choices ?? []
        for (const named of Object.keys(descriptor.choiceLabels ?? {})) {
          expect(offered, `${locale}/${descriptor.key} labels ${named}`).toContain(named)
        }
      }
    }
  })
})

/**
 * The text tables, held to what the message catalogue is held to.
 *
 * Every assertion here has a counterpart in `tests/ipc-contract.test.ts` for `catalogs`, except the
 * last two, which are the ones this table needs and that one does not: a setting must have a label,
 * and a choice must have a name for every member. Both exist because the failure they catch is
 * silent — an unlabelled setting falls back to a name derived from its key, in English, and looks
 * deliberate.
 */
describe('the settings text tables', () => {
  it('describes exactly the settings that exist, in every locale', () => {
    /*
      Both directions, and both matter.

      A missing entry is a setting that renders with an English name derived from its key, which is
      the defect this whole change exists to remove. A stray entry is prose nobody will ever read,
      usually left behind by a key that was renamed — and the renamed key then has no text, so one
      mistake produces both halves.
    */
    const expected = [...SETTINGS_KEYS].sort()
    for (const locale of LOCALES) {
      expect(settingTextKeys(locale).sort(), locale).toEqual(expected)
    }
  })

  it('gives every setting a label, which is the fitness function', () => {
    // The one that stops a new setting from shipping nameless. It asks the table directly rather
    // than asking a descriptor, because `describeSetting` falls back to a derived name — which is
    // right for the running browser and would make this assertion pass on nothing.
    for (const locale of LOCALES) {
      for (const key of SETTINGS_KEYS) {
        const text = settingTextFor(locale, key)
        expect(text, `${locale}/${key} has no text at all`).toBeDefined()
        expect(text?.label.trim(), `${locale}/${key} has no label`).not.toBe('')
      }
    }
  })

  it('has no empty string anywhere in it', () => {
    // An empty label renders as a blank row with a control in it; an empty description renders as
    // a gap. Both look like a rendering bug rather than a missing translation.
    for (const locale of LOCALES) {
      for (const key of settingTextKeys(locale)) {
        const text = settingTextFor(locale, key)
        expect(text?.label.trim(), `${locale}/${key} label`).not.toBe('')
        if (text?.description !== undefined) {
          expect(text.description.trim(), `${locale}/${key} description`).not.toBe('')
        }
        for (const [member, name] of Object.entries(text?.choices ?? {})) {
          expect(name.trim(), `${locale}/${key} member ${member}`).not.toBe('')
        }
      }
    }
  })

  it('keeps placeholders consistent across locales', () => {
    /*
      The same check the catalogue gets, and it is not decorative here either: the description of the
      custom search address names `{query}` because that is the literal the user has to type into the
      field. A translation that dropped it would be the only instruction on the screen, missing, in
      one language.

      These strings are never run through `interpolate` — they are shown as written — so the braces
      are content rather than a substitution. That makes losing one silent in a way it is not in the
      catalogue, where a stray `{name}` at least appears on screen.
    */
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort()

    for (const key of settingTextKeys(EN)) {
      const reference = settingTextFor(EN, key)
      for (const locale of LOCALES) {
        const text = settingTextFor(locale, key)
        expect(placeholders(text?.label ?? ''), `${locale}/${key} label`).toEqual(
          placeholders(reference?.label ?? '')
        )
        expect(placeholders(text?.description ?? ''), `${locale}/${key} description`).toEqual(
          placeholders(reference?.description ?? '')
        )
      }
    }
  })

  it('keeps a description in every locale or in none', () => {
    // The compiler already refuses a German entry that drops one, because the German table is typed
    // as `typeof en`. Asserted anyway: that guarantee lives in a type alias two files away, and the
    // day somebody widens it to `SettingTextTable` for convenience it disappears without a sound.
    for (const key of settingTextKeys(EN)) {
      const described = LOCALES.map(
        (locale) => settingTextFor(locale, key)?.description !== undefined
      )
      expect(new Set(described).size, `${key} has a description in some locales only`).toBe(1)
    }
  })

  it('names every member of every choice it names any member of', () => {
    /*
      All-or-nothing per setting, rather than per member.

      The rule that was actually applied is stated in `settings-text.en.ts`: name the members
      wherever the raw value is not readable — and once German is considered that is every choice
      but one, because the raw members are English identifiers. `ask`, `deny`, `light` and
      `disable_non_proxied_udp` are all equally unreadable to a German reader. The exception is
      `splitView.defaultLayout`, whose members are grid ids.

      So a partially named choice is a mistake rather than a decision, and this is where it surfaces.
    */
    for (const locale of LOCALES) {
      for (const descriptor of describeSettings(locale)) {
        if (descriptor.kind !== 'choice') continue
        const named = Object.keys(descriptor.choiceLabels ?? {})
        if (named.length === 0) {
          expect(descriptor.key, 'an unnamed choice that is not the layout ids').toBe(
            'splitView.defaultLayout'
          )
          continue
        }
        expect(named.sort(), `${locale}/${descriptor.key}`).toEqual(
          [...(descriptor.choices ?? [])].sort()
        )
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
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'label', 'min', 'section'])
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
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'label', 'section'])
  })

  it('does not mark a fractional number as integer-only', () => {
    // Every number in the real table happens to be an integer, so this is the case the
    // table cannot cover: having a bound must not imply whole numbers, or a setting like
    // a 1.25 zoom factor becomes untypable.
    const descriptor = describeSchema(z.number().min(1))
    expect(descriptor.min).toBe(1)
    expect(keysOf(descriptor)).toEqual(['applies', 'key', 'kind', 'label', 'min', 'section'])
  })

  it('marks integer-only from the number format, and only when that format is an int', () => {
    // `float64` is a number format that is not an integer one — zod records it as the
    // same kind of check as `int`, differing only in the format string. A looser test of
    // that string would put `step=1` on a field meant to take 1.5.
    const float = describeSchema(z.number().check(z.float64()))
    expect(keysOf(float)).toEqual(['applies', 'key', 'kind', 'label', 'section'])

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
