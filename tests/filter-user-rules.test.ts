import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DocumentCodec } from '@main/data/JsonStore.js'
import { UserRuleStore, type UserRuleTextEditor } from '@main/data/UserRuleStore.js'
import { compileFilterLists } from '@shared/filters/compile.js'
import { cosmeticSelectorsFor } from '@shared/filters/cosmetic.js'
import {
  MAX_USER_RULES,
  addUserRule,
  describeUserRule,
  emptyUserRuleDocument,
  enabledUserRuleText,
  removeUserRule,
  repairUserRules,
  setUserRuleEnabled,
  userRulesForHost,
  type UserRule
} from '@shared/filters/user-rules.js'

/**
 * The user's own rules: the model, and the store that decides who may write.
 *
 * The interesting assertions are not that a rule can be added. They are that it can be
 * **found, switched off and deleted** — a blocker the user can only add to eventually
 * breaks a page for a reason nobody can reconstruct, and the usual outcome is that the
 * whole blocker gets switched off — and that a private window leaves no trace while
 * still applying what the user asked for.
 */

async function storeAt(
  name: string,
  contents?: string
): Promise<{ path: string; store: UserRuleStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-user-rules-'))
  const path = join(directory, name)
  if (contents !== undefined) await writeFile(path, contents, 'utf8')
  let ticks = 0
  const store = await UserRuleStore.open({
    filePath: path,
    debounceMs: 0,
    generateId: () => `rule-${(ticks += 1)}`,
    now: () => 1000 + ticks
  })
  return { path, store }
}

async function readRules(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

/** A list of distinct, storable rules, for the assertions about the limit. */
function fullRuleList(length: number): UserRule[] {
  return Array.from({ length }, (_unused, index) =>
    ruleOf({ id: `r${index}`, text: `example.com##.ad-${index}` })
  )
}

function ruleOf(overrides: Partial<UserRule>): UserRule {
  return {
    id: 'r1',
    text: 'example.com##.ad-slot',
    enabled: true,
    createdAt: 1,
    origin: 'picker',
    ...overrides
  }
}

describe('describeUserRule', () => {
  it('reads a picker rule through the lists’ own parser', () => {
    expect(describeUserRule('example.com##.ad-slot')).toEqual({
      hosts: ['example.com'],
      selector: '.ad-slot',
      isException: false,
      kind: 'declarative'
    })
  })

  it('reads an exception, which is how a user undoes a list’s rule', () => {
    expect(describeUserRule('example.com#@#.cookie-banner')?.isException).toBe(true)
  })

  it('accepts a rule with no host, which the user has to write by hand', () => {
    expect(describeUserRule('##.ad-slot')?.hosts).toEqual([])
  })

  it('refuses a line the parser makes nothing of', () => {
    for (const text of ['', '   ', 'not a filter', '! a comment', 'example.com##']) {
      expect(describeUserRule(text), text).toBeNull()
    }
  })

  it('refuses network syntax', () => {
    // `||ads.example.com^` is a perfectly good filter line, and it belongs to a list
    // the user chose. An element picker that could write request-blocking rules would
    // put "hide this box" and "cut this site off" behind the same button.
    expect(describeUserRule('||ads.example.com^')).toBeNull()
    expect(describeUserRule('/banner.gif')).toBeNull()
  })

  it('refuses a line longer than a rule plausibly is', () => {
    expect(describeUserRule(`example.com##.${'a'.repeat(600)}`)).toBeNull()
  })

  it('accepts a procedural rule, because that is what people write by hand', () => {
    /*
      This used to assert the opposite — `#?#` needed an engine that did not exist, and storing such a line
      would have put a rule in the list that looked active and hid nothing.

      There is an engine now, and accepting these is the point of it: *"hide the box that contains this
      word"* cannot be said as a CSS selector, and it is exactly what somebody reaches for when the element
      picker's selector turns out to be too brittle. `kind` says which path the rule will take, because the
      two are not interchangeable — a procedural rule must name a host and costs work on every page it
      applies to.
    */
    expect(describeUserRule('example.com#?#.ad:has-text(Anzeige)')).toEqual({
      hosts: ['example.com'],
      selector: '.ad',
      isException: false,
      kind: 'procedural'
    })
    // `##` carries them too, which is how uBO and the lists actually write them.
    expect(describeUserRule('example.com##.box:upward(2)')?.kind).toBe('procedural')
  })

  it('still refuses a procedural operator there is no implementation for', () => {
    // `:xpath()` is real uBO syntax and is not implemented — six uses across the three default lists. A
    // stored line that cannot be evaluated is a rule that looks active and hides nothing, which is the
    // defect the old assertion above was guarding and which still has to be guarded.
    expect(describeUserRule('example.com#?#.ad:xpath(//div)')).toBeNull()
  })

  it('refuses a scriptlet, which is a different power from hiding an element', () => {
    /*
      `##+js(…)` names a piece of code to run in the page. A text box the user types rules into that
      accepted one would be a text box that executes things — and the element picker writes through this
      same function, so it would be one click away as well.
    */
    expect(describeUserRule('example.com##+js(set-constant, x, true)')).toBeNull()
  })

  it('refuses a procedural rule that names no host', () => {
    // uBlock Origin refuses one too. It is evaluated by script on every matching document and re-run on
    // every mutation burst, so "everywhere" means that work on every page for the rest of the session.
    expect(describeUserRule('##.ad:has-text(Werbung)')).toBeNull()
  })
})

describe('the rule list', () => {
  const context = { id: 'r1', now: 10 }

  it('adds a rule and says it did', () => {
    const result = addUserRule([], { text: 'example.com##.ad', origin: 'picker' }, context)
    expect(result.outcome).toBe('added')
    expect(result.added).toEqual({
      id: 'r1',
      text: 'example.com##.ad',
      enabled: true,
      createdAt: 10,
      origin: 'picker'
    })
  })

  it('trims the line it stores', () => {
    const result = addUserRule([], { text: '  example.com##.ad  ', origin: 'manual' }, context)
    expect(result.added?.text).toBe('example.com##.ad')
  })

  it('refuses a line the parser cannot read, rather than storing a dead rule', () => {
    const result = addUserRule([], { text: 'nonsense', origin: 'manual' }, context)
    expect(result.outcome).toBe('invalid')
    expect(result.added).toBeNull()
    expect(result.rules).toEqual([])
  })

  it('refuses the lines the parser refuses, through the same door', () => {
    // The three the picker must never be able to write past: request-blocking syntax, a
    // scriptlet, and a paste accident. `describeUserRule` decides; this asserts that the
    // add path asks it rather than having a second opinion.
    for (const text of [
      '||ads.example.com^',
      'example.com##+js(set-constant, x, true)',
      `example.com##.${'a'.repeat(600)}`
    ]) {
      const result = addUserRule([], { text, origin: 'manual' }, context)
      expect(result.outcome, text).toBe('invalid')
      expect(result.existing, text).toBeNull()
    }
  })

  it('reports a duplicate rather than storing it twice, and points at the one already there', () => {
    // The rule the user wants exists, so the answer is where it is — a surface that only
    // heard "duplicate" can say so and cannot show which of five hundred lines it means.
    const existing = [ruleOf({ id: 'kept', text: 'example.com##.ad' })]
    const result = addUserRule(existing, { text: 'example.com##.ad', origin: 'picker' }, context)
    expect(result.outcome).toBe('duplicate-active')
    expect(result.existing).toEqual(existing[0])
    expect(result.added).toBeNull()
    expect(result.rules).toEqual(existing)
  })

  it('tells a disabled duplicate from an active one', () => {
    // Re-blocking something is a change to the rule already there, not a new one; a
    // second copy would leave the user with two entries and one of them doing nothing.
    // But the two are not the same answer: one means "already done", the other means
    // "you have this rule and it is switched off", which has a next step.
    const existing = [ruleOf({ id: 'kept', text: 'example.com##.ad', enabled: false })]
    const result = addUserRule(existing, { text: 'example.com##.ad', origin: 'picker' }, context)
    expect(result.outcome).toBe('duplicate-disabled')
    expect(result.existing?.id).toBe('kept')
    expect(result.added).toBeNull()
  })

  it('switches a rule off without forgetting it', () => {
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'b', text: 'example.com##.promo' })]
    const off = setUserRuleEnabled(rules, 'a', false)
    expect(off.map((rule) => rule.enabled)).toEqual([false, true])
    expect(off).toHaveLength(2)
    expect(setUserRuleEnabled(off, 'a', true)[0]?.enabled).toBe(true)
  })

  it('leaves an unknown id alone', () => {
    const rules = [ruleOf({ id: 'a' })]
    expect(setUserRuleEnabled(rules, 'missing', false)).toEqual(rules)
    expect(removeUserRule(rules, 'missing')).toEqual(rules)
  })

  it('deletes a rule', () => {
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'b', text: 'example.com##.promo' })]
    expect(removeUserRule(rules, 'a').map((rule) => rule.id)).toEqual(['b'])
  })

  it('refuses the rule past the limit rather than dropping the oldest', () => {
    /*
      This used to assert the opposite, and the opposite was silent data loss: the five
      hundred-and-first rule was stored, the oldest was deleted to make room, and the
      call reported plain success. Nobody was told, and the rule that vanished was one
      the user wrote by hand and cannot download again.

      So the limit refuses. Nothing is written and nothing is deleted, and the caller
      gets an answer it can say out loud — which is the only thing that lets a person
      decide which rule to delete.
    */
    const many = fullRuleList(MAX_USER_RULES)
    const result = addUserRule(many, { text: 'example.com##.newest', origin: 'picker' }, context)
    expect(result.rules.at(0)?.text).toBe('example.com##.ad-0')
    expect(result.rules).toEqual(many)
    expect(result.outcome).toBe('limit-reached')
    expect(result.added).toBeNull()
    expect(result.existing).toBeNull()
  })

  it('accepts the rule that fills the list exactly', () => {
    // The boundary belongs to the user: five hundred rules is five hundred rules, not
    // four hundred and ninety-nine plus a refusal nobody can explain.
    const result = addUserRule(
      fullRuleList(MAX_USER_RULES - 1),
      { text: 'example.com##.last', origin: 'picker' },
      context
    )
    expect(result.outcome).toBe('added')
    expect(result.rules).toHaveLength(MAX_USER_RULES)
    expect(result.rules.at(-1)?.text).toBe('example.com##.last')
  })

  it('still answers a full list’s duplicate as a duplicate', () => {
    // Nothing would be written either way, so the honest answer is the one that helps:
    // "you already have this" rather than sending somebody deleting rules to make room
    // for a rule they already have.
    const many = fullRuleList(MAX_USER_RULES)
    const result = addUserRule(many, { text: 'example.com##.ad-0', origin: 'picker' }, context)
    expect(result.outcome).toBe('duplicate-active')
    expect(result.existing?.id).toBe('r0')
  })

  it('hands the enabled rules to the compiler as one list body', () => {
    const rules = [
      ruleOf({ id: 'a', text: 'example.com##.ad' }),
      ruleOf({ id: 'b', text: 'example.com##.promo', enabled: false }),
      ruleOf({ id: 'c', text: 'other.example##.sky' })
    ]
    expect(enabledUserRuleText(rules)).toBe('example.com##.ad\nother.example##.sky')
  })

  it('produces text the same compiler the downloaded lists go through can read', () => {
    // The whole reason for storing ABP lines: one element-hiding implementation, not
    // two, and the least-tested one holding the rules the user cares most about.
    const rules = [ruleOf({ id: 'a', text: 'example.com##.ad-slot' })]
    const compiled = compileFilterLists([enabledUserRuleText(rules)])
    expect(cosmeticSelectorsFor(compiled.cosmetic, 'www.example.com').specific).toEqual([
      '.ad-slot'
    ])
    expect(compiled.diagnostics.unsupported).toBe(0)
  })
})

describe('repairUserRules', () => {
  it('drops a line this build cannot parse', () => {
    /*
      A line an older build understood and this one does not would otherwise sit in the list looking active
      while hiding nothing.

      The example was `:upward(2)`, which this build now evaluates — so it moved to `:xpath()`, which is
      real syntax with no implementation here. Worth noting rather than quietly swapping: the *test* is
      about repair, and it only has something to repair for as long as some syntax is unsupported.
    */
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'b', text: 'example.com#?#.ad:xpath(//div)' })]
    expect(repairUserRules(rules).map((rule) => rule.id)).toEqual(['a'])
  })

  it('folds a duplicated line onto the entry an interface is already showing', () => {
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'b' })]
    expect(repairUserRules(rules).map((rule) => rule.id)).toEqual(['a'])
  })

  it('drops a repeated id, which would make disabling ambiguous', () => {
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'a', text: 'example.com##.promo' })]
    expect(repairUserRules(rules)).toHaveLength(1)
  })

  it('trims a hand-edited line rather than discarding it', () => {
    expect(repairUserRules([ruleOf({ text: ' example.com##.ad ' })])[0]?.text).toBe(
      'example.com##.ad'
    )
  })

  it('caps a file that grew past the limit', () => {
    /*
      Healing still cuts, where adding now refuses. The two are not the same situation: a
      stored document is already over the limit — by a hand edit or by a build that
      evicted silently — and refusing it would mean a file that can no longer be opened
      at all. Cutting the oldest is a loss; not starting is every rule.
    */
    expect(repairUserRules(fullRuleList(MAX_USER_RULES + 5))).toHaveLength(MAX_USER_RULES)
  })

  it('has nothing to repair in an empty document', () => {
    expect(repairUserRules(emptyUserRuleDocument().rules)).toEqual([])
  })
})

describe('userRulesForHost', () => {
  const rules = [
    ruleOf({ id: 'own', text: 'www.example.com##.a', createdAt: 1 }),
    ruleOf({ id: 'parent', text: 'example.com##.b', createdAt: 2 }),
    ruleOf({ id: 'generic', text: '##.c', createdAt: 3 }),
    ruleOf({ id: 'other', text: 'elsewhere.test##.d', createdAt: 4 }),
    ruleOf({ id: 'broken', text: 'not a rule', createdAt: 5 })
  ]

  it('includes the rules written for a parent domain and for no host at all', () => {
    // The two that are easiest to forget when a site looks wrong, so the view that
    // exists to explain it has to show them.
    expect(userRulesForHost(rules, 'www.example.com').map((rule) => rule.id)).toEqual([
      'generic',
      'parent',
      'own'
    ])
  })

  it('puts the newest first, because that is the suspect', () => {
    expect(userRulesForHost(rules, 'www.example.com').at(0)?.id).toBe('generic')
  })

  it('leaves out a rule written for another site', () => {
    expect(userRulesForHost(rules, 'elsewhere.test').map((rule) => rule.id)).toEqual([
      'other',
      'generic'
    ])
  })

  it('does not show a subdomain’s rule on the parent', () => {
    expect(userRulesForHost(rules, 'example.com').map((rule) => rule.id)).toEqual([
      'generic',
      'parent'
    ])
  })
})

describe('UserRuleStore', () => {
  it('stores a rule and hands it back', async () => {
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    expect(editor.add({ text: 'example.com##.ad', origin: 'picker' }).outcome).toBe('added')
    expect(editor.list().map((rule) => rule.text)).toEqual(['example.com##.ad'])
  })

  it('writes what a later start reads back', async () => {
    const { path, store } = await storeAt('user-rules.json')
    store.editorFor('normal').add({ text: 'example.com##.ad', origin: 'picker' })
    await store.flush()

    const reopened = await UserRuleStore.open({ filePath: path, debounceMs: 0 })
    expect(reopened.rules().map((rule) => rule.text)).toEqual(['example.com##.ad'])
    expect(reopened.recoveredFromInvalidFile).toBe(false)
  })

  it('does not write for a line it refused', async () => {
    const { path, store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    expect(editor.add({ text: 'nonsense', origin: 'manual' }).outcome).toBe('invalid')
    await store.flush()
    expect(await readRules(path)).toEqual({ version: 1, rules: [] })
  })

  it('points at the rule already there when the line is one it has', async () => {
    // KTD9: the field was always on the answer and was only ever filled on success, so a
    // surface that wanted to show the user their existing rule had to go and find it.
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    const first = editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule!

    const again = editor.add({ text: 'example.com##.ad', origin: 'picker' })
    expect(again.outcome).toBe('duplicate-active')
    expect(again.rule?.id).toBe(first.id)

    editor.setEnabled(first.id, false)
    const whileOff = editor.add({ text: 'example.com##.ad', origin: 'picker' })
    expect(whileOff.outcome).toBe('duplicate-disabled')
    expect(whileOff.rule?.id).toBe(first.id)
    // And the switch is still off: an add is not a way to re-enable a rule behind the
    // user's back, it is a way to be told that one is there.
    expect(editor.list().map((rule) => rule.enabled)).toEqual([false])
  })

  it('writes nothing and deletes nothing once the list is full', async () => {
    /*
      R18. The file on disk has to be the same file afterwards — this is the assertion
      that the old eviction is gone from the whole path, not just from the model.
    */
    const stored = fullRuleList(MAX_USER_RULES)
    const { path, store } = await storeAt(
      'user-rules.json',
      JSON.stringify({ version: 1, rules: stored })
    )
    const editor = store.editorFor('normal')
    const seen: number[] = []
    const stop = store.onChange((rules) => seen.push(rules.length))

    const result = editor.add({ text: 'example.com##.newest', origin: 'picker' })
    expect(result.outcome).toBe('limit-reached')
    expect(result.rule).toBeNull()
    // Not a change, so not an event: a refusal must not wake the listeners that re-read
    // and recompile the rules.
    expect(seen).toEqual([])
    stop()

    await store.flush()
    expect(await readRules(path)).toEqual({ version: 1, rules: stored })
  })

  it('cuts a stored document that is already over the limit, rather than refusing to open', async () => {
    const { store } = await storeAt(
      'user-rules.json',
      JSON.stringify({ version: 1, rules: fullRuleList(MAX_USER_RULES + 5) })
    )
    expect(store.rules()).toHaveLength(MAX_USER_RULES)
    // The newest survive, because they are the ones being worked on.
    expect(store.rules().at(-1)?.text).toBe(`example.com##.ad-${MAX_USER_RULES + 4}`)
  })

  it('switches a rule off and leaves it in the list', async () => {
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    const added = editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    expect(editor.setEnabled(added.id, false)).toBe(true)
    expect(editor.list().map((rule) => rule.enabled)).toEqual([false])
    expect(editor.enabledText()).toBe('')
    // Switching it back on is the same operation, which is what makes it a switch
    // rather than a deletion the user has to redo from the picker.
    expect(editor.setEnabled(added.id, true)).toBe(true)
    expect(editor.enabledText()).toBe('example.com##.ad')
  })

  it('reports a switch that changes nothing', async () => {
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    const added = editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    expect(editor.setEnabled(added.id, true)).toBe(false)
    expect(editor.setEnabled('missing', false)).toBe(false)
  })

  it('deletes a rule', async () => {
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    const added = editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    expect(editor.remove(added.id)).toBe(true)
    expect(editor.remove(added.id)).toBe(false)
    expect(editor.list()).toEqual([])
  })

  it('tells a listener what changed', async () => {
    const { store } = await storeAt('user-rules.json')
    const seen: number[] = []
    const stop = store.onChange((rules) => seen.push(rules.length))
    const editor = store.editorFor('normal')
    editor.add({ text: 'example.com##.ad', origin: 'picker' })
    editor.add({ text: 'example.com##.promo', origin: 'picker' })
    stop()
    editor.add({ text: 'example.com##.sky', origin: 'picker' })
    expect(seen).toEqual([1, 2])
  })

  it('clears everything, and says how much went', async () => {
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    editor.add({ text: 'example.com##.ad', origin: 'picker' })
    editor.add({ text: 'example.com##.promo', origin: 'picker' })
    expect(store.clear()).toBe(2)
    expect(store.rules()).toEqual([])
    expect(store.enabledText()).toBe('')
  })

  it('shows the rules bearing on a host', async () => {
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('normal')
    editor.add({ text: 'example.com##.ad', origin: 'picker' })
    editor.add({ text: 'other.test##.promo', origin: 'picker' })
    expect(editor.forHost('www.example.com').map((rule) => rule.text)).toEqual(['example.com##.ad'])
  })

  it('generates a readable id and a timestamp of its own when none is injected', async () => {
    // The production path: an id a user can match against a line in the file they are
    // reading to work out which rule broke a page.
    const directory = await mkdtemp(join(tmpdir(), 'tessera-user-rules-'))
    const store = await UserRuleStore.open({
      filePath: join(directory, 'user-rules.json'),
      debounceMs: 0
    })
    const editor = store.editorFor('normal')
    const seen: number[] = []
    const stop = editor.onChange((rules) => seen.push(rules.length))
    const added = editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    stop()
    expect(added.id).toMatch(/^ur-[0-9a-z]+-[0-9a-z]+$/)
    expect(added.createdAt).toBeGreaterThan(0)
    expect(seen).toEqual([1])
  })

  it('writes through whichever codec it was given', async () => {
    // Spec 3 requires every local file encrypted at rest, and the rules the user wrote
    // are as revealing as the history — they say which sites they read closely enough
    // to fix. The codec seam is `JsonStore`'s; what matters here is that this store
    // passes it through rather than reaching for the plain one.
    const directory = await mkdtemp(join(tmpdir(), 'tessera-user-rules-'))
    const path = join(directory, 'user-rules.json')
    const codec: DocumentCodec = {
      encode: (data) => new TextEncoder().encode(`obscured:${JSON.stringify(data)}`),
      decode: (bytes) =>
        JSON.parse(new TextDecoder().decode(bytes).replace('obscured:', '')) as unknown
    }
    // Default debounce, so the flush is what puts it on disk.
    const store = await UserRuleStore.open({ filePath: path, codec })
    store.editorFor('normal').add({ text: 'example.com##.ad', origin: 'picker' })
    await store.flush()
    expect(await readFile(path, 'utf8')).toMatch(/^obscured:/)

    const reopened = await UserRuleStore.open({ filePath: path, codec, debounceMs: 0 })
    expect(reopened.rules().map((rule) => rule.text)).toEqual(['example.com##.ad'])
  })

  it('starts from defaults when the file is not ours, rather than refusing to start', async () => {
    const { store } = await storeAt('user-rules.json', '{"version":2,"rules":"nope"}')
    expect(store.rules()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
  })

  it('repairs a hand-edited file on the way in', async () => {
    const { store } = await storeAt(
      'user-rules.json',
      JSON.stringify({
        version: 1,
        rules: [
          { id: 'a', text: 'example.com##.ad', enabled: true, createdAt: 1, origin: 'manual' },
          { id: 'b', text: 'gibberish', enabled: true, createdAt: 2, origin: 'manual' }
        ]
      })
    )
    expect(store.rules().map((rule) => rule.id)).toEqual(['a'])
  })
})

describe('a private window', () => {
  async function privateEditor(): Promise<{
    path: string
    store: UserRuleStore
    editor: UserRuleTextEditor
  }> {
    const { path, store } = await storeAt('user-rules.json')
    return { path, store, editor: store.editorFor('private') }
  }

  it('writes nothing to disk for a rule created in it', async () => {
    const { path, store, editor } = await privateEditor()
    expect(editor.add({ text: 'example.com##.ad', origin: 'picker' }).outcome).toBe('added')
    await store.flush()
    expect(await readRules(path)).toEqual({ version: 1, rules: [] })
    expect(store.rules()).toEqual([])
  })

  it('still applies the rule for as long as the session lasts', async () => {
    // The structural guarantee is "no path to the file", not "do nothing". An editor
    // that swallowed the rule would make the picker look broken in exactly the window
    // where a user is most likely to be trying it out.
    const { editor } = await privateEditor()
    editor.add({ text: 'example.com##.ad', origin: 'picker' })
    expect(editor.enabledText()).toBe('example.com##.ad')
    expect(editor.forHost('example.com')).toHaveLength(1)
  })

  it('marks its own rules as belonging to the session', async () => {
    const { editor } = await privateEditor()
    expect(editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule?.id).toMatch(/^session-/)
  })

  it('applies the rules the user already stored', async () => {
    const { store, editor } = await privateEditor()
    store.editorFor('normal').add({ text: 'example.com##.stored', origin: 'picker' })
    expect(editor.list().map((rule) => rule.text)).toEqual(['example.com##.stored'])
  })

  it('switches on a stored rule that is off, without the file changing', async () => {
    /*
      A rule the user switched off at home and needs on the page in front of them. The session's switch
      goes into the list, and so into `enabledText`, which is what `sessionStylesFor` serves this window's
      views — the one route a private window has into its pages. The file and the engine's global slot,
      which every normal window reads, keep it off.
    */
    const { path, store, editor } = await privateEditor()
    const normal = store.editorFor('normal')
    const stored = normal.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    normal.setEnabled(stored.id, false)
    await store.flush()
    const onDisk = await readRules(path)

    expect(editor.canSetEnabled(stored.id, true)).toBe(true)
    expect(editor.setEnabled(stored.id, true)).toBe(true)
    expect(editor.list().map((rule) => rule.enabled)).toEqual([true])
    expect(editor.enabledText()).toBe('example.com##.ad')
    await store.flush()
    expect(await readRules(path)).toEqual(onDisk)
    expect(store.enabledText()).toBe('')

    // Its own switch, taken back: honoured, because that is the session's to undo.
    expect(editor.setEnabled(stored.id, false)).toBe(true)
    expect(editor.enabledText()).toBe('')
    editor.setEnabled(stored.id, true)
    store.endPrivateSession()
    expect(editor.list().map((rule) => rule.enabled)).toEqual([false])
    expect(editor.enabledText()).toBe('')
  })

  it('refuses to switch off or delete a stored rule, rather than pretend', async () => {
    /*
      A stored rule that is on reaches every window through the engine's global slot, and a private
      window can only add to what its pages get. Listing it as off — or as gone — while it went on hiding
      its element was the defect; the answer is `false`, and nothing changes or is announced.
    */
    const { store, editor } = await privateEditor()
    const stored = store
      .editorFor('normal')
      .add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    let told = 0
    editor.onChange(() => (told += 1))

    expect(editor.canSetEnabled(stored.id, false)).toBe(false)
    expect(editor.canRemove(stored.id)).toBe(false)
    expect(editor.setEnabled(stored.id, false)).toBe(false)
    expect(editor.remove(stored.id)).toBe(false)
    expect(editor.list()).toEqual([stored])
    expect(editor.enabledText()).toBe('example.com##.ad')
    expect(told).toBe(0)
  })

  it('does not switch on a stored rule it has no way to deliver', async () => {
    // A procedural rule or an exception reaches a page through the engine, not through a view's added
    // stylesheet. Switched on here it would be listed on and do nothing.
    const { store, editor } = await privateEditor()
    const normal = store.editorFor('normal')
    const procedural = normal.add({
      text: 'example.com##.box:has-text(Ad)',
      origin: 'manual'
    }).rule!
    normal.setEnabled(procedural.id, false)
    expect(editor.canSetEnabled(procedural.id, true)).toBe(false)
    expect(editor.setEnabled(procedural.id, true)).toBe(false)
    expect(editor.list().map((rule) => rule.enabled)).toEqual([false])
  })

  it('changes its own rules freely', async () => {
    const { editor } = await privateEditor()
    const own = editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    expect(editor.canSetEnabled(own.id, false)).toBe(true)
    expect(editor.canRemove(own.id)).toBe(true)
    expect(editor.setEnabled(own.id, false)).toBe(true)
    expect(editor.remove(own.id)).toBe(true)
    expect(editor.list()).toEqual([])
  })

  it('refuses a procedural rule and an exception, which it could not deliver', async () => {
    // Nothing on the picker's path writes either; a typed or menu path must not be the way in.
    const { store, editor } = await privateEditor()
    expect(editor.add({ text: 'example.com##.box:has-text(Ad)', origin: 'manual' }).outcome).toBe(
      'invalid'
    )
    expect(editor.add({ text: 'example.com#@#.box', origin: 'manual' }).outcome).toBe('invalid')
    expect(editor.list()).toEqual([])

    // A normal window's editor takes both: the engine applies them there.
    const normal = store.editorFor('normal')
    expect(normal.add({ text: 'example.com##.box:has-text(Ad)', origin: 'manual' }).outcome).toBe(
      'added'
    )
    expect(normal.add({ text: 'example.com#@#.box', origin: 'manual' }).outcome).toBe('added')
    // And a stored one is still recognised in the private window as the rule it is.
    expect(editor.add({ text: 'example.com#@#.box', origin: 'manual' }).outcome).toBe(
      'duplicate-active'
    )
  })

  it('refuses the same lines the stored set refuses', async () => {
    const { editor } = await privateEditor()
    expect(editor.add({ text: 'nonsense', origin: 'manual' }).outcome).toBe('invalid')
    expect(editor.add({ text: '##.ad', origin: 'manual' }).outcome).toBe('added')
    const again = editor.add({ text: '##.ad', origin: 'manual' })
    expect(again.outcome).toBe('duplicate-active')
    expect(again.rule?.id).toMatch(/^session-/)
  })

  it('counts a stored duplicate as one, and says it is switched off', async () => {
    const { store, editor } = await privateEditor()
    const normal = store.editorFor('normal')
    const stored = normal.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    normal.setEnabled(stored.id, false)
    const result = editor.add({ text: 'example.com##.ad', origin: 'picker' })
    expect(result.outcome).toBe('duplicate-disabled')
    expect(result.rule?.id).toBe(stored.id)
  })

  it('counts the stored rules against the limit rather than growing past it', async () => {
    /*
      The session's list is the stored rules plus its own, so the limit has to be read
      against that sum. It was not: the session kept the added rule and threw away the
      trimmed list the model handed back, so a private window was the one place the five
      hundred could be exceeded without limit — noted in `docs/IMPROVEMENT-PLAN.md`.
    */
    const { store } = await storeAt(
      'user-rules.json',
      JSON.stringify({ version: 1, rules: fullRuleList(MAX_USER_RULES - 1) })
    )
    const editor = store.editorFor('private')
    expect(editor.add({ text: 'example.com##.fits', origin: 'picker' }).outcome).toBe('added')

    const result = editor.add({ text: 'example.com##.over', origin: 'picker' })
    expect(result.outcome).toBe('limit-reached')
    expect(result.rule).toBeNull()
    expect(editor.list()).toHaveLength(MAX_USER_RULES)
  })

  it('reports an unknown id as unchanged', async () => {
    const { editor } = await privateEditor()
    expect(editor.setEnabled('missing', false)).toBe(false)
    expect(editor.remove('missing')).toBe(false)
  })

  it('is the same editor on the next call, not a fresh one', async () => {
    /*
      The characterisation of the reported defect, and the reason it is stated as identity rather
      than as behaviour: `editorFor` used to construct a `SessionUserRuleEditor` per call, so a
      private window's rules lived exactly as long as one IPC call and no listener could be wired to
      an object that was gone before the answer came back.
    */
    const { store } = await storeAt('user-rules.json')
    expect(store.editorFor('private')).toBe(store.editorFor('private'))
  })

  it('still has the rule it wrote when the next call asks for the list', async () => {
    // The same defect from the user's side, which is how it was reported: block an element in a
    // private window, open the rule manager, and the rule is not there.
    const { store } = await storeAt('user-rules.json')
    store.editorFor('private').add({ text: 'example.com##.ad', origin: 'picker' })
    expect(
      store
        .editorFor('private')
        .list()
        .map((rule) => rule.text)
    ).toEqual(['example.com##.ad'])
    expect(store.editorFor('private').enabledText()).toBe('example.com##.ad')
  })

  it('keeps that rule out of the normal profile and off the disk', async () => {
    // AE8's second half, and the half a shared editor would break: what the private window wrote
    // must reach neither the stored list nor the text the engine's global slot is fed from.
    const { path, store } = await storeAt('user-rules.json')
    store.editorFor('private').add({ text: 'example.com##.ad', origin: 'picker' })
    await store.flush()
    expect(store.editorFor('normal').list()).toEqual([])
    expect(store.rules()).toEqual([])
    expect(store.enabledText()).toBe('')
    expect(await readRules(path)).toEqual({ version: 1, rules: [] })
  })

  it('is one editor for the mode, so the normal one is stable too', async () => {
    const { store } = await storeAt('user-rules.json')
    expect(store.editorFor('normal')).toBe(store.editorFor('normal'))
    expect(store.editorFor('normal')).not.toBe(store.editorFor('private'))
  })

  it('loses its rules when the private session ends', async () => {
    // R5. The editor is held for the life of the process, so the rules have to be let go at the
    // moment the last private window closes — otherwise a later private window would open onto the
    // rules of an earlier one, which is precisely what a private session promises not to do.
    const { store } = await storeAt('user-rules.json')
    const editor = store.editorFor('private')
    editor.add({ text: 'example.com##.ad', origin: 'picker' })
    store.endPrivateSession()
    expect(editor.list()).toEqual([])
    expect(store.editorFor('private').enabledText()).toBe('')
  })

  it('lets go of what the session did to the stored rules as well', async () => {
    const { store } = await storeAt('user-rules.json')
    const normal = store.editorFor('normal')
    const stored = normal.add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    normal.setEnabled(stored.id, false)
    const editor = store.editorFor('private')
    editor.setEnabled(stored.id, true)
    store.endPrivateSession()
    expect(editor.list()).toEqual([{ ...stored, enabled: false }])
  })

  it('keeps the listeners the wiring attached across the end of a session', async () => {
    /*
      The editor object outlives the session it holds, and this is why: the delivery of these rules
      into a private window's views is one subscription made once at startup. Handing out a fresh
      editor for the next private window would leave that subscription pointing at a dead object —
      the same shape as the defect this unit exists to remove.
    */
    const { store } = await storeAt('user-rules.json')
    const seen: number[] = []
    store.editorFor('private').onChange((rules) => seen.push(rules.length))
    store.editorFor('private').add({ text: 'example.com##.ad', origin: 'picker' })
    store.endPrivateSession()
    store.editorFor('private').add({ text: 'example.com##.promo', origin: 'picker' })
    expect(seen).toEqual([1, 0, 1])
  })

  it('says nothing when a session that wrote nothing ends', async () => {
    // Every window close would otherwise re-serve every view in the browser for no change at all.
    const { store } = await storeAt('user-rules.json')
    const seen: number[] = []
    store.editorFor('private').onChange((rules) => seen.push(rules.length))
    store.endPrivateSession()
    expect(seen).toEqual([])
  })

  it('does not reuse an id after the session ended', async () => {
    // A surface holding a rule id across the end of a session — an open rule manager, a picker
    // result — must not find that id pointing at a different rule afterwards.
    const { store } = await storeAt('user-rules.json')
    const first = store
      .editorFor('private')
      .add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    store.endPrivateSession()
    const second = store
      .editorFor('private')
      .add({ text: 'example.com##.promo', origin: 'picker' }).rule!
    expect(second.id).not.toBe(first.id)
  })

  it('tells its own listeners, and stops when asked', async () => {
    const { editor } = await privateEditor()
    const seen: number[] = []
    const stop = editor.onChange((rules) => seen.push(rules.length))
    editor.add({ text: 'example.com##.ad', origin: 'picker' })
    const added = editor.list().at(0)!
    editor.setEnabled(added.id, false)
    editor.remove(added.id)
    stop()
    editor.add({ text: 'example.com##.promo', origin: 'picker' })
    expect(seen).toEqual([1, 1, 0])
  })
})
