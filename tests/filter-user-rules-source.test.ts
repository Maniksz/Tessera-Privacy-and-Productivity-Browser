import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UserRuleStore } from '@main/data/UserRuleStore.js'
import { MAX_USER_RULES, type UserRule } from '@shared/filters/user-rules.js'
import {
  MAX_USER_RULE_SOURCE_LENGTH,
  applyUserRuleSource,
  projectUserRuleSource,
  readUserRuleLine,
  repairUserRuleSource
} from '@shared/filters/user-rules-source.js'
import {
  annotateSourceLines,
  commentBody,
  disabledRuleLine,
  sourceLines
} from '@shared/filters/user-rules-lines.js'

/**
 * The user's own rules as one text, and back (U8, R17, KTD7).
 *
 * ## What is asserted, and why these
 *
 * The text is a *projection* over the stored rules, not the stored thing itself. So the assertions that
 * matter are about what survives the trip: a rule the user did not touch keeps its id, its age and where
 * it came from — which is the whole difference between a rule manager and a text box that rewrites the
 * file — and a line the browser refuses is refused *there*, without costing the lines around it.
 *
 * The other half is what a comment is allowed to become. `!` is how the text says "off", so a commented
 * line is a switched-off rule — but only once its body has been through the same check as any other line.
 * Otherwise `! ||ads.example^` would be stored as a disabled rule and a later "switch on" (which does not
 * re-validate) would put a request-blocking rule behind the element picker's button.
 */

function ruleOf(overrides: Partial<UserRule>): UserRule {
  return {
    id: 'r1',
    text: 'example.com##.ad',
    enabled: true,
    createdAt: 1,
    origin: 'picker',
    ...overrides
  }
}

/** Ids in the order they are asked for, so a test can say which rule is the new one. */
function context(now = 500): { nextId: () => string; now: number } {
  let count = 0
  return { nextId: () => `new-${(count += 1)}`, now }
}

describe('reading one line', () => {
  it('reads a rule as a switched-on rule', () => {
    expect(readUserRuleLine('  example.com##.ad  ')).toEqual({
      kind: 'rule',
      text: 'example.com##.ad',
      enabled: true
    })
  })

  it('reads a commented rule as a switched-off one, with or without the space', () => {
    expect(readUserRuleLine('! example.com##.ad')).toEqual({
      kind: 'rule',
      text: 'example.com##.ad',
      enabled: false
    })
    expect(readUserRuleLine('!example.com##.ad')).toEqual({
      kind: 'rule',
      text: 'example.com##.ad',
      enabled: false
    })
  })

  it('keeps a commented network rule a note, not a rule that is off', () => {
    /*
      The security half of the comment convention. `setEnabled` does not re-validate, so anything stored
      disabled can later be switched on as it stands. A commented line therefore goes through the same
      check as an uncommented one, *without* its `!`, before it is allowed to become a rule.
    */
    expect(readUserRuleLine('! ||ads.example^')).toEqual({ kind: 'note' })
    expect(readUserRuleLine('! example.com##+js(abort-on-property-read, ads)')).toEqual({
      kind: 'note'
    })
  })

  it('takes one comment mark off and no more, so a doubled one stays a note', () => {
    expect(readUserRuleLine('!! example.com##.ad')).toEqual({ kind: 'note' })
  })

  it('reads prose after the mark as a note', () => {
    expect(readUserRuleLine('! Things that broke the shop')).toEqual({ kind: 'note' })
    expect(readUserRuleLine('!')).toEqual({ kind: 'note' })
  })

  it('refuses an uncommented line that is not a rule', () => {
    expect(readUserRuleLine('||ads.example^')).toEqual({ kind: 'rejected' })
    expect(readUserRuleLine('nonsense')).toEqual({ kind: 'rejected' })
  })

  it('reads a line of nothing but space as blank', () => {
    expect(readUserRuleLine('')).toEqual({ kind: 'blank' })
    expect(readUserRuleLine('   \t')).toEqual({ kind: 'blank' })
  })
})

describe('the rules as a text', () => {
  it('writes one line per rule and a switched-off one as a comment', () => {
    const view = projectUserRuleSource(
      [ruleOf({ id: 'a' }), ruleOf({ id: 'b', text: 'shop.example##.promo', enabled: false })],
      undefined
    )
    expect(view.source).toBe('example.com##.ad\n! shop.example##.promo')
    expect(view.rejected).toEqual([])
  })

  it('is empty for no rules at all', () => {
    expect(projectUserRuleSource([], undefined)).toEqual({ source: '', rejected: [] })
    expect(projectUserRuleSource([], '')).toEqual({ source: '', rejected: [] })
  })

  it('keeps the notes, the blank lines and the order the text was saved in', () => {
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'b', text: 'shop.example##.promo' })]
    const source = '! the shop\nshop.example##.promo\n\n! the news site\nexample.com##.ad'
    expect(projectUserRuleSource(rules, source).source).toBe(source)
  })

  it('shows a rule in the state it is in now, not the state it was saved in', () => {
    // Switched off from the blocker menu after the text was saved: the text says so.
    const rules = [ruleOf({ id: 'a', enabled: false })]
    expect(projectUserRuleSource(rules, 'example.com##.ad').source).toBe('! example.com##.ad')
  })

  it('drops the line of a rule that has since been deleted', () => {
    // Undone from the picker's bar after the text was saved.
    expect(projectUserRuleSource([], '! note\nexample.com##.ad').source).toBe('! note')
  })

  it('adds a rule written since at the end', () => {
    // Picked while the text was saved without it.
    const rules = [ruleOf({ id: 'a' }), ruleOf({ id: 'b', text: 'picked.example##.x' })]
    expect(projectUserRuleSource(rules, 'example.com##.ad\n! end').source).toBe(
      'example.com##.ad\n! end\npicked.example##.x'
    )
  })

  it('shows a rule once however often its line was saved', () => {
    expect(projectUserRuleSource([ruleOf({})], 'example.com##.ad\n! example.com##.ad').source).toBe(
      'example.com##.ad'
    )
  })

  it('keeps a refused line where it was, and names it', () => {
    const view = projectUserRuleSource([ruleOf({})], 'example.com##.ad\n  ||ads.example^\n')
    expect(view.source).toBe('example.com##.ad\n  ||ads.example^\n')
    expect(view.rejected).toEqual(['||ads.example^'])
  })
})

describe('taking the text back', () => {
  const stored = [
    ruleOf({ id: 'a', text: 'example.com##.ad', createdAt: 10, origin: 'picker' }),
    ruleOf({ id: 'b', text: 'shop.example##.promo', createdAt: 20, origin: 'manual' })
  ]
  const unchanged = 'example.com##.ad\nshop.example##.promo'

  it('keeps every id, age and origin when nothing changed', () => {
    const result = applyUserRuleSource({ rules: stored }, unchanged, context())
    expect(result.outcome).toBe('applied')
    expect(result.rules).toEqual(stored)
  })

  it('reports that nothing changed, so there is nothing to write', () => {
    const once = applyUserRuleSource({ rules: stored }, unchanged, context())
    expect(once.changed).toBe(true) // the first time, the text itself is new
    const twice = applyUserRuleSource(
      { rules: once.rules, source: once.source },
      unchanged,
      context()
    )
    expect(twice.changed).toBe(false)
  })

  it('switches a rule off by commenting it out, and keeps it', () => {
    const result = applyUserRuleSource(
      { rules: stored },
      '! example.com##.ad\nshop.example##.promo',
      context()
    )
    expect(result.rules).toEqual([{ ...stored[0], enabled: false }, stored[1]])
  })

  it('switches it back on when the comment mark goes', () => {
    const off = [{ ...stored[0]!, enabled: false }, stored[1]!]
    const result = applyUserRuleSource({ rules: off }, unchanged, context())
    expect(result.rules).toEqual(stored)
    expect(result.changed).toBe(true)
  })

  it('does not store a commented network rule or scriptlet as a rule that is off', () => {
    const result = applyUserRuleSource(
      { rules: [] },
      '! ||ads.example^\n! example.com##+js(abort-on-property-read, ads)',
      context()
    )
    expect(result.rules).toEqual([])
    // Still there as the notes they now are.
    expect(result.source).toBe('! ||ads.example^\n! example.com##+js(abort-on-property-read, ads)')
  })

  it('deletes the rule whose line was deleted', () => {
    const result = applyUserRuleSource({ rules: stored }, 'shop.example##.promo', context())
    expect(result.rules).toEqual([stored[1]])
  })

  it('makes a new line a new rule typed by hand', () => {
    const result = applyUserRuleSource(
      { rules: stored },
      `${unchanged}\nnew.example##.banner`,
      context(777)
    )
    expect(result.rules).toEqual([
      ...stored,
      { id: 'new-1', text: 'new.example##.banner', enabled: true, createdAt: 777, origin: 'manual' }
    ])
  })

  it('makes a new commented rule a new rule that is off', () => {
    const result = applyUserRuleSource({ rules: [] }, '! new.example##.banner', context())
    expect(result.rules).toEqual([
      {
        id: 'new-1',
        text: 'new.example##.banner',
        enabled: false,
        createdAt: 500,
        origin: 'manual'
      }
    ])
  })

  it('treats an edited line as the old rule gone and a new one typed', () => {
    // Matched by text, which is the only identity a line in a text box has.
    const result = applyUserRuleSource(
      { rules: stored },
      'example.com##.advert\nshop.example##.promo',
      context()
    )
    expect(result.rules.map((rule) => rule.id)).toEqual(['b', 'new-1'])
  })

  it('refuses a bad line in place and takes the rest', () => {
    const result = applyUserRuleSource(
      { rules: stored },
      'example.com##.ad\n||ads.example^\nshop.example##.promo\nnew.example##.x',
      context()
    )
    expect(result.outcome).toBe('applied')
    expect(result.rules.map((rule) => rule.text)).toEqual([
      'example.com##.ad',
      'shop.example##.promo',
      'new.example##.x'
    ])
    // Kept in the text where it was, so the projection can mark it there.
    expect(result.source).toBe(
      'example.com##.ad\n||ads.example^\nshop.example##.promo\nnew.example##.x'
    )
    expect(projectUserRuleSource(result.rules, result.source).rejected).toEqual(['||ads.example^'])
  })

  it('makes two identical lines one rule, and one line', () => {
    const result = applyUserRuleSource(
      { rules: [] },
      'new.example##.x\n! new.example##.x\n  new.example##.x',
      context()
    )
    expect(result.rules).toHaveLength(1)
    // The first occurrence decides, as `repairUserRules` folds onto the first one it meets.
    expect(result.rules[0]?.enabled).toBe(true)
    expect(result.source).toBe('new.example##.x')
  })

  it('keeps notes and blank lines, and writes rules in their plain form', () => {
    const result = applyUserRuleSource(
      { rules: stored },
      '! the news site   \n   example.com##.ad\n\n   \n!shop.example##.promo\n\n\n',
      context()
    )
    expect(result.source).toBe('! the news site\nexample.com##.ad\n\n\n! shop.example##.promo')
  })

  it('reads a text pasted from Windows the same as one typed here', () => {
    const result = applyUserRuleSource(
      { rules: stored },
      'example.com##.ad\r\nshop.example##.promo\r\n',
      context()
    )
    expect(result.rules).toEqual(stored)
    expect(result.source).toBe(unchanged)
  })

  it('refuses a text over the limit and deletes nothing', () => {
    /*
      R18 applied to the whole text. The text below drops both stored rules and adds five hundred and one
      new ones; taking "as many as fit" would have to choose which of the user's lines to lose, and the
      choice made for the element picker (KTD6) is that the browser does not make it for them.
    */
    const lines = Array.from(
      { length: MAX_USER_RULES + 1 },
      (_unused, index) => `x.example##.n${index}`
    )
    const result = applyUserRuleSource(
      { rules: stored, source: unchanged },
      lines.join('\n'),
      context()
    )
    expect(result).toEqual({
      outcome: 'limit-reached',
      rules: stored,
      source: unchanged,
      changed: false
    })
  })

  it('takes a text that fills the list exactly', () => {
    const lines = Array.from(
      { length: MAX_USER_RULES },
      (_unused, index) => `x.example##.n${index}`
    )
    const result = applyUserRuleSource({ rules: [] }, lines.join('\n'), context())
    expect(result.outcome).toBe('applied')
    expect(result.rules).toHaveLength(MAX_USER_RULES)
  })

  it('counts a commented rule against the limit, because it is kept', () => {
    const lines = Array.from(
      { length: MAX_USER_RULES + 1 },
      (_unused, index) => `! x.example##.n${index}`
    )
    expect(applyUserRuleSource({ rules: [] }, lines.join('\n'), context()).outcome).toBe(
      'limit-reached'
    )
  })

  it('does not count notes and refused lines against the limit', () => {
    const notes = Array.from({ length: MAX_USER_RULES + 1 }, (_unused, index) => `! note ${index}`)
    const refused = Array.from({ length: MAX_USER_RULES + 1 }, () => '||ads.example^')
    const result = applyUserRuleSource(
      { rules: [] },
      [...notes, ...refused, 'x.example##.one'].join('\n'),
      context()
    )
    expect(result.outcome).toBe('applied')
    expect(result.rules).toHaveLength(1)
  })

  it('makes an empty text an empty list', () => {
    const result = applyUserRuleSource({ rules: stored }, '', context())
    expect(result.rules).toEqual([])
    expect(result.source).toBe('')
  })
})

describe('a saved text that grew too long', () => {
  it('is let go, and the rules are shown without it', () => {
    // The rules are the user's work and are healed elsewhere; the text is only their arrangement, and
    // losing the arrangement is the cheaper of the two ways a bad file can go.
    expect(repairUserRuleSource('x'.repeat(MAX_USER_RULE_SOURCE_LENGTH + 1))).toBeUndefined()
  })

  it('is kept when it fits', () => {
    expect(repairUserRuleSource('! note')).toBe('! note')
    expect(repairUserRuleSource(undefined)).toBeUndefined()
  })

  it('has room for every rule the list can hold, each commented out', () => {
    expect(MAX_USER_RULE_SOURCE_LENGTH).toBeGreaterThanOrEqual(MAX_USER_RULES * (512 + 3))
  })
})

describe('the lines, for the editor', () => {
  it('splits on every kind of line end, and a text of nothing has no lines', () => {
    expect(sourceLines('a\r\nb\nc\rd')).toEqual(['a', 'b', 'c', 'd'])
    expect(sourceLines('a\n')).toEqual(['a', ''])
    expect(sourceLines('')).toEqual([])
  })

  it('knows a comment by its mark and hands back what follows it', () => {
    expect(commentBody('  ! example.com##.ad ')).toBe('example.com##.ad')
    expect(commentBody('example.com##.ad')).toBeNull()
    expect(disabledRuleLine('example.com##.ad')).toBe('! example.com##.ad')
  })

  it('marks a refused line where it is, and nothing else', () => {
    const lines = annotateSourceLines('example.com##.ad\n ||ads.example^ \n! note', {
      rules: [],
      rejected: ['||ads.example^'],
      term: ''
    })
    expect(lines.map((line) => line.rejected)).toEqual([false, true, false])
  })

  it('stops marking a refused line the moment it is corrected', () => {
    // The verdict was about that text. Edited, the line is one nobody has judged yet.
    const lines = annotateSourceLines('||ads.example^$third-party', {
      rules: [],
      rejected: ['||ads.example^'],
      term: ''
    })
    expect(lines[0]?.rejected).toBe(false)
  })

  it('says which lines are matched by script and which the picker wrote, commented or not', () => {
    const lines = annotateSourceLines(
      'a.example##.box:has-text(Ad)\n! b.example##.x\nc.example##.y\nunsaved.example##.z',
      {
        rules: [
          { text: 'a.example##.box:has-text(Ad)', kind: 'procedural', origin: 'manual' },
          { text: 'b.example##.x', kind: 'declarative', origin: 'picker' },
          { text: 'c.example##.y', kind: 'declarative', origin: 'manual' }
        ],
        rejected: [],
        term: ''
      }
    )
    expect(lines.map((line) => [line.procedural, line.picked])).toEqual([
      [true, false],
      [false, true],
      [false, false],
      [false, false]
    ])
  })

  it('marks the lines a search names, and none when nothing is searched for', () => {
    const draft = 'Shop.example##.promo\nnews.example##.ad'
    const searched = annotateSourceLines(draft, { rules: [], rejected: [], term: 'shop' })
    expect(searched.map((line) => line.match)).toEqual([true, false])
    const idle = annotateSourceLines(draft, { rules: [], rejected: [], term: '' })
    expect(idle.map((line) => line.match)).toEqual([false, false])
  })

  it('keeps the line text as typed, for drawing under the box', () => {
    const lines = annotateSourceLines('  a\n', { rules: [], rejected: [], term: '' })
    expect(lines.map((line) => line.text)).toEqual(['  a', ''])
  })
})

async function storeAt(contents?: string): Promise<{ path: string; store: UserRuleStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'tessera-user-rules-source-'))
  const path = join(directory, 'user-rules.json')
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

async function readFileJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

describe('the text, through the store', () => {
  it('survives a round trip with every id, age and origin untouched', async () => {
    const { store } = await storeAt()
    const editor = store.editorFor('normal')
    editor.add({ text: 'example.com##.ad', origin: 'picker' })
    editor.add({ text: 'shop.example##.promo', origin: 'manual' })
    const before = editor.list()

    expect(editor.applySource(editor.source().source).outcome).toBe('applied')
    expect(editor.list()).toEqual(before)
  })

  it('writes the notes to disk, and a later start shows them', async () => {
    const { path, store } = await storeAt()
    store.editorFor('normal').applySource('! the shop\nshop.example##.promo')
    await store.flush()

    const reopened = await UserRuleStore.open({ filePath: path, debounceMs: 0 })
    expect(reopened.editorFor('normal').source().source).toBe('! the shop\nshop.example##.promo')
  })

  it('does not write, or wake anybody, for a text that changes nothing', async () => {
    const { store } = await storeAt()
    const editor = store.editorFor('normal')
    editor.applySource('example.com##.ad')
    let told = 0
    editor.onChange(() => (told += 1))
    editor.applySource('example.com##.ad\n')
    expect(told).toBe(0)
  })

  it('writes nothing and deletes nothing when the text is over the limit', async () => {
    const { path, store } = await storeAt()
    const editor = store.editorFor('normal')
    editor.add({ text: 'example.com##.keep', origin: 'picker' })
    await store.flush()
    const onDisk = await readFileJson(path)

    const lines = Array.from(
      { length: MAX_USER_RULES + 1 },
      (_unused, index) => `x.example##.n${index}`
    )
    expect(editor.applySource(lines.join('\n')).outcome).toBe('limit-reached')
    await store.flush()
    expect(await readFileJson(path)).toEqual(onDisk)
    expect(editor.list().map((rule) => rule.text)).toEqual(['example.com##.keep'])
  })

  it('lets go of the notes with the rules when everything is cleared', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').applySource('! note\nexample.com##.ad')
    store.clear()
    expect(store.editorFor('normal').source().source).toBe('')
  })

  it('opens a file whose text is too long, with the rules and without the text', async () => {
    const rule = ruleOf({ id: 'kept', text: 'example.com##.ad' })
    const { store } = await storeAt(
      JSON.stringify({
        version: 1,
        rules: [rule],
        source: 'x'.repeat(MAX_USER_RULE_SOURCE_LENGTH + 1)
      })
    )
    expect(store.rules()).toEqual([rule])
    expect(store.editorFor('normal').source().source).toBe('example.com##.ad')
  })
})

describe('the text, in a private window', () => {
  it('changes nothing on disk and nothing in the normal profile', async () => {
    const { path, store } = await storeAt()
    store.editorFor('normal').applySource('! mine\nexample.com##.stored')
    await store.flush()
    const onDisk = await readFileJson(path)
    const normalBefore = store.editorFor('normal').list()

    const session = store.editorFor('private')
    expect(
      session.applySource('! session note\n! example.com##.stored\nprivate.example##.x').outcome
    ).toBe('applied')
    await store.flush()

    expect(await readFileJson(path)).toEqual(onDisk)
    expect(store.editorFor('normal').list()).toEqual(normalBefore)
    expect(store.editorFor('normal').source().source).toBe('! mine\nexample.com##.stored')
  })

  it('shows the session what the session wrote', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').applySource('example.com##.stored')
    const session = store.editorFor('private')
    session.applySource('! session note\n! example.com##.stored\nprivate.example##.x')

    expect(session.source().source).toBe(
      '! session note\n! example.com##.stored\nprivate.example##.x'
    )
    expect(session.list().map((rule) => [rule.text, rule.enabled])).toEqual([
      ['example.com##.stored', false],
      ['private.example##.x', true]
    ])
    expect(session.list()[1]?.id).toMatch(/^session-/)
  })

  it('reads the stored text until it writes its own', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').applySource('! mine\nexample.com##.stored')
    expect(store.editorFor('private').source().source).toBe('! mine\nexample.com##.stored')
  })

  it('can take a stored rule out of the session and put a session rule back on', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').applySource('example.com##.stored')
    const session = store.editorFor('private')
    session.applySource('! private.example##.x')
    session.applySource('private.example##.x')

    expect(session.list().map((rule) => [rule.text, rule.enabled])).toEqual([
      ['private.example##.x', true]
    ])
    expect(store.rules().map((rule) => rule.text)).toEqual(['example.com##.stored'])
  })

  it('switches a stored rule off and back on inside the session', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').applySource('example.com##.stored')
    const session = store.editorFor('private')
    session.applySource('! example.com##.stored')
    expect(session.list().map((rule) => rule.enabled)).toEqual([false])
    session.applySource('example.com##.stored')
    expect(session.list().map((rule) => rule.enabled)).toEqual([true])
    expect(store.rules().map((rule) => rule.enabled)).toEqual([true])
  })

  it('refuses a session text over the limit, counting the stored rules', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').add({ text: 'example.com##.stored', origin: 'picker' })
    const session = store.editorFor('private')
    const lines = Array.from(
      { length: MAX_USER_RULES },
      (_unused, index) => `x.example##.n${index}`
    )
    expect(session.applySource(['example.com##.stored', ...lines].join('\n')).outcome).toBe(
      'limit-reached'
    )
    expect(session.list().map((rule) => rule.text)).toEqual(['example.com##.stored'])
  })

  it('tells its listeners once, and not at all for a text that changes nothing', async () => {
    const { store } = await storeAt()
    const session = store.editorFor('private')
    let told = 0
    session.onChange(() => (told += 1))
    session.applySource('private.example##.x')
    session.applySource('private.example##.x')
    expect(told).toBe(1)
  })

  it('forgets its text when the private session ends', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').applySource('example.com##.stored')
    const session = store.editorFor('private')
    session.applySource('! session only')
    store.endPrivateSession()
    expect(session.source().source).toBe('example.com##.stored')
  })
})
