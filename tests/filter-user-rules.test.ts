import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { DocumentCodec } from '@main/data/JsonStore.js'
import { UserRuleStore, type UserRuleEditor } from '@main/data/UserRuleStore.js'
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
      isException: false
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

  it('refuses a syntax the engine recognises but does not implement', () => {
    // `#?#` needs a procedural selector engine. Storing it would put a rule in the list
    // that looks active and blocks nothing.
    expect(describeUserRule('example.com#?#.ad:has-text(Anzeige)')).toBeNull()
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

  it('reports a duplicate rather than storing it twice', () => {
    const existing = [ruleOf({ text: 'example.com##.ad' })]
    const result = addUserRule(existing, { text: 'example.com##.ad', origin: 'picker' }, context)
    expect(result.outcome).toBe('duplicate')
    expect(result.rules).toEqual(existing)
  })

  it('treats a disabled rule as a duplicate too', () => {
    // Re-blocking something is a change to the rule already there, not a new one; a
    // second copy would leave the user with two entries and one of them doing nothing.
    const existing = [ruleOf({ text: 'example.com##.ad', enabled: false })]
    expect(
      addUserRule(existing, { text: 'example.com##.ad', origin: 'picker' }, context).outcome
    ).toBe('duplicate')
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

  it('keeps the newest when the list grows past what a person can audit', () => {
    const many = Array.from({ length: MAX_USER_RULES }, (_unused, index) =>
      ruleOf({ id: `r${index}`, text: `example.com##.ad-${index}` })
    )
    const result = addUserRule(many, { text: 'example.com##.newest', origin: 'picker' }, context)
    expect(result.rules).toHaveLength(MAX_USER_RULES)
    expect(result.rules.at(-1)?.text).toBe('example.com##.newest')
    expect(result.rules.at(0)?.text).toBe('example.com##.ad-1')
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
    // A line an older build understood and this one does not would otherwise sit in the
    // list looking active while blocking nothing.
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'b', text: 'example.com#?#.ad:upward(2)' })]
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
    const many = Array.from({ length: MAX_USER_RULES + 5 }, (_unused, index) =>
      ruleOf({ id: `r${index}`, text: `example.com##.ad-${index}` })
    )
    expect(repairUserRules(many)).toHaveLength(MAX_USER_RULES)
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
    editor: UserRuleEditor
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

  it('can switch a stored rule off without the file changing', async () => {
    // The escape hatch has to work in a private window too — a page broken by a rule is
    // broken there as well — and it must not become a write.
    const { path, store, editor } = await privateEditor()
    const stored = store
      .editorFor('normal')
      .add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    await store.flush()

    expect(editor.setEnabled(stored.id, false)).toBe(true)
    expect(editor.enabledText()).toBe('')
    expect(editor.list().map((rule) => rule.enabled)).toEqual([false])
    // And switching it back on inside the session is the same operation, not a write.
    expect(editor.setEnabled(stored.id, true)).toBe(true)
    expect(editor.enabledText()).toBe('example.com##.ad')
    expect(editor.setEnabled(stored.id, false)).toBe(true)
    await store.flush()
    const onDisk = await readRules(path)
    expect(onDisk).toMatchObject({ rules: [{ id: stored.id, enabled: true }] })
    // And the stored set is untouched, so the next normal window still has it.
    expect(store.enabledText()).toBe('example.com##.ad')
  })

  it('can hide a stored rule from the session without deleting it', async () => {
    const { store, editor } = await privateEditor()
    const stored = store
      .editorFor('normal')
      .add({ text: 'example.com##.ad', origin: 'picker' }).rule!
    expect(editor.remove(stored.id)).toBe(true)
    expect(editor.list()).toEqual([])
    expect(store.rules()).toHaveLength(1)
  })

  it('refuses the same lines the stored set refuses', async () => {
    const { editor } = await privateEditor()
    expect(editor.add({ text: 'nonsense', origin: 'manual' }).outcome).toBe('invalid')
    expect(editor.add({ text: '##.ad', origin: 'manual' }).outcome).toBe('added')
    expect(editor.add({ text: '##.ad', origin: 'manual' }).outcome).toBe('duplicate')
  })

  it('reports an unknown id as unchanged', async () => {
    const { editor } = await privateEditor()
    expect(editor.setEnabled('missing', false)).toBe(false)
    expect(editor.remove('missing')).toBe(false)
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
