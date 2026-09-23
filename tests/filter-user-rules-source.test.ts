import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { UserRuleStore, type UserRuleTextEditor } from '@main/data/UserRuleStore.js'
import { MAX_USER_RULES, type UserRule } from '@shared/filters/user-rules.js'
import {
  MAX_USER_RULE_SOURCE_LENGTH,
  applyUserRuleSource,
  projectUserRuleSource,
  readUserRuleLine,
  repairUserRuleSource,
  type ApplyUserRuleSourceResult,
  type UserRuleSourceState
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

/**
 * A text written against exactly the rules it is applied to: the page loaded them, and nothing changed
 * before it saved. What every test here means unless it says otherwise; the ones about a list that moved
 * on while the page was open pass their own `loaded`.
 */
function current(state: UserRuleSourceState, text: string, now = 500): ApplyUserRuleSourceResult {
  return applyUserRuleSource(state, text, {
    ...context(now),
    loaded: new Set(state.rules.map((rule) => rule.id))
  })
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
    expect(readUserRuleLine('||ads.example^')).toEqual({ kind: 'rejected', reason: 'unsupported' })
    expect(readUserRuleLine('nonsense')).toEqual({ kind: 'rejected', reason: 'unsupported' })
  })

  it('refuses a rule the editor cannot hold, and keeps a commented one a note', () => {
    // A private window's editor: a rule it has no way to deliver is refused as it stands, and — the
    // security ordering again — its commented form is no switched-off rule either, only a note.
    const declarativeOnly = (text: string): boolean => !text.includes(':has-text(')
    expect(readUserRuleLine('example.com##.box:has-text(Ad)', declarativeOnly)).toEqual({
      kind: 'rejected',
      reason: 'private-window'
    })
    expect(readUserRuleLine('! example.com##.box:has-text(Ad)', declarativeOnly)).toEqual({
      kind: 'note'
    })
    expect(readUserRuleLine('example.com##.ad', declarativeOnly)).toEqual({
      kind: 'rule',
      text: 'example.com##.ad',
      enabled: true
    })
    // What the parser refuses is refused for that reason first, whatever the editor could hold.
    expect(readUserRuleLine('||ads.example^', () => false)).toEqual({
      kind: 'rejected',
      reason: 'unsupported'
    })
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
    expect(view.rejected).toEqual([{ line: '||ads.example^', reason: 'unsupported' }])
  })
})

describe('taking the text back', () => {
  const stored = [
    ruleOf({ id: 'a', text: 'example.com##.ad', createdAt: 10, origin: 'picker' }),
    ruleOf({ id: 'b', text: 'shop.example##.promo', createdAt: 20, origin: 'manual' })
  ]
  const unchanged = 'example.com##.ad\nshop.example##.promo'

  it('keeps every id, age and origin when nothing changed', () => {
    const result = current({ rules: stored }, unchanged)
    expect(result.outcome).toBe('applied')
    expect(result.rules).toEqual(stored)
  })

  it('reports that nothing changed, so there is nothing to write', () => {
    const once = current({ rules: stored }, unchanged)
    expect(once.changed).toBe(true) // the first time, the text itself is new
    const twice = current({ rules: once.rules, source: once.source }, unchanged)
    expect(twice.changed).toBe(false)
  })

  it('switches a rule off by commenting it out, and keeps it', () => {
    const result = current({ rules: stored }, '! example.com##.ad\nshop.example##.promo')
    expect(result.rules).toEqual([{ ...stored[0], enabled: false }, stored[1]])
  })

  it('switches it back on when the comment mark goes', () => {
    const off = [{ ...stored[0]!, enabled: false }, stored[1]!]
    const result = current({ rules: off }, unchanged)
    expect(result.rules).toEqual(stored)
    expect(result.changed).toBe(true)
  })

  it('does not store a commented network rule or scriptlet as a rule that is off', () => {
    const result = current(
      { rules: [] },
      '! ||ads.example^\n! example.com##+js(abort-on-property-read, ads)'
    )
    expect(result.rules).toEqual([])
    // Still there as the notes they now are.
    expect(result.source).toBe('! ||ads.example^\n! example.com##+js(abort-on-property-read, ads)')
  })

  it('deletes the rule whose line was deleted', () => {
    const result = current({ rules: stored }, 'shop.example##.promo')
    expect(result.rules).toEqual([stored[1]])
  })

  it('makes a new line a new rule typed by hand', () => {
    const result = current({ rules: stored }, `${unchanged}\nnew.example##.banner`, 777)
    expect(result.rules).toEqual([
      ...stored,
      { id: 'new-1', text: 'new.example##.banner', enabled: true, createdAt: 777, origin: 'manual' }
    ])
  })

  it('makes a new commented rule a new rule that is off', () => {
    const result = current({ rules: [] }, '! new.example##.banner')
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
    const result = current({ rules: stored }, 'example.com##.advert\nshop.example##.promo')
    expect(result.rules.map((rule) => rule.id)).toEqual(['b', 'new-1'])
  })

  it('refuses a bad line in place and takes the rest', () => {
    const result = current(
      { rules: stored },
      'example.com##.ad\n||ads.example^\nshop.example##.promo\nnew.example##.x'
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
    expect(projectUserRuleSource(result.rules, result.source).rejected).toEqual([
      { line: '||ads.example^', reason: 'unsupported' }
    ])
  })

  it('makes two identical lines one rule, and one line', () => {
    const result = current({ rules: [] }, 'new.example##.x\n! new.example##.x\n  new.example##.x')
    expect(result.rules).toHaveLength(1)
    // The first occurrence decides, as `repairUserRules` folds onto the first one it meets.
    expect(result.rules[0]?.enabled).toBe(true)
    expect(result.source).toBe('new.example##.x')
  })

  it('keeps notes and blank lines, and writes rules in their plain form', () => {
    const result = current(
      { rules: stored },
      '! the news site   \n   example.com##.ad\n\n   \n!shop.example##.promo\n\n\n'
    )
    expect(result.source).toBe('! the news site\nexample.com##.ad\n\n\n! shop.example##.promo')
  })

  it('reads a text pasted from Windows the same as one typed here', () => {
    const result = current({ rules: stored }, 'example.com##.ad\r\nshop.example##.promo\r\n')
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
    const result = current({ rules: stored, source: unchanged }, lines.join('\n'))
    expect(result).toEqual({
      outcome: 'limit-reached',
      rules: stored,
      source: unchanged,
      changed: false,
      refused: []
    })
  })

  it('takes a deletion from a list that is already over the limit', () => {
    /*
      A private window's list is the stored rules plus the session's, and a normal window can grow the
      stored half after the session wrote — so the list the page shows can be past the limit through no
      save of its own. Refusing every save of such a list would refuse the one thing that brings it back
      under: taking lines out. Only a save that *grows* the list past the limit is refused.
    */
    const over = Array.from({ length: MAX_USER_RULES + 5 }, (_unused, index) =>
      ruleOf({ id: `o${index}`, text: `x.example##.n${index}` })
    )
    const text = over.map((rule) => rule.text)
    const deleted = current({ rules: over }, text.slice(1).join('\n'))
    expect(deleted.outcome).toBe('applied')
    expect(deleted.rules).toHaveLength(MAX_USER_RULES + 4)

    const toggled = current({ rules: over }, [`! ${text[0]!}`, ...text.slice(1)].join('\n'))
    expect(toggled.outcome).toBe('applied')
    expect(toggled.rules[0]?.enabled).toBe(false)

    const added = current({ rules: over }, [...text, 'more.example##.x'].join('\n'))
    expect(added.outcome).toBe('limit-reached')
    expect(added.changed).toBe(false)
  })

  it('takes a text that fills the list exactly', () => {
    const lines = Array.from(
      { length: MAX_USER_RULES },
      (_unused, index) => `x.example##.n${index}`
    )
    const result = current({ rules: [] }, lines.join('\n'))
    expect(result.outcome).toBe('applied')
    expect(result.rules).toHaveLength(MAX_USER_RULES)
  })

  it('counts a commented rule against the limit, because it is kept', () => {
    const lines = Array.from(
      { length: MAX_USER_RULES + 1 },
      (_unused, index) => `! x.example##.n${index}`
    )
    expect(current({ rules: [] }, lines.join('\n')).outcome).toBe('limit-reached')
  })

  it('does not count notes and refused lines against the limit', () => {
    const notes = Array.from({ length: MAX_USER_RULES + 1 }, (_unused, index) => `! note ${index}`)
    const refused = Array.from({ length: MAX_USER_RULES + 1 }, () => '||ads.example^')
    const result = current({ rules: [] }, [...notes, ...refused, 'x.example##.one'].join('\n'))
    expect(result.outcome).toBe('applied')
    expect(result.rules).toHaveLength(1)
  })

  it('makes an empty text an empty list', () => {
    const result = current({ rules: stored }, '')
    expect(result.rules).toEqual([])
    expect(result.source).toBe('')
  })
})

/**
 * An editor that cannot hold every rule, or cannot change every rule it lists.
 *
 * A private window's editor is the one that exists: its own rules reach a page as an additive stylesheet
 * per view, so it can carry neither a procedural rule nor a `#@#` exception, and it can switch a stored rule
 * on but cannot switch one off or take one away. The text has to say so on the line concerned rather than
 * accept the line and let it do nothing.
 */
describe('a text taken back by an editor with limits', () => {
  const stored = [
    ruleOf({ id: 'on', text: 'example.com##.on', enabled: true }),
    ruleOf({ id: 'off', text: 'example.com##.off', enabled: false })
  ]
  const unchanged = 'example.com##.on\n! example.com##.off'
  const limits = {
    admits: (text: string): boolean => !text.includes(':has-text(') && !text.includes('#@#'),
    canSetEnabled: (rule: UserRule, enabled: boolean): boolean => enabled || rule.id !== 'on',
    canRemove: (): boolean => false
  }

  function limited(text: string): ApplyUserRuleSourceResult {
    return applyUserRuleSource({ rules: stored, source: unchanged }, text, {
      ...context(),
      loaded: new Set(stored.map((rule) => rule.id)),
      ...limits
    })
  }

  it('refuses a rule it cannot hold, keeps the line, and stores nothing for it', () => {
    const text = `${unchanged}\nexample.com##.box:has-text(Ad)\nexample.com#@#.box\n! example.com##.x:has-text(y)`
    const result = limited(text)
    expect(result.rules.map((rule) => rule.text)).toEqual(['example.com##.on', 'example.com##.off'])
    expect(result.source).toBe(text)

    const view = projectUserRuleSource(result.rules, result.source, limits)
    expect(view.rejected).toEqual([
      { line: 'example.com##.box:has-text(Ad)', reason: 'private-window' },
      { line: 'example.com#@#.box', reason: 'private-window' }
    ])
  })

  it('still reads a rule it already has, whatever that rule is', () => {
    // A stored procedural rule applies through the engine in every window; the limit is on new ones.
    const procedural = [ruleOf({ id: 'p', text: 'example.com##.box:has-text(Ad)' })]
    const view = projectUserRuleSource(procedural, 'example.com##.box:has-text(Ad)', limits)
    expect(view).toEqual({ source: 'example.com##.box:has-text(Ad)', rejected: [] })
  })

  it('switches a rule on that it may switch on', () => {
    const result = limited('example.com##.on\nexample.com##.off')
    expect(result.rules.map((rule) => rule.enabled)).toEqual([true, true])
    expect(result.refused).toEqual([])
  })

  it('keeps a rule it may not switch off as it is, and says which', () => {
    const result = limited('! example.com##.on\n! example.com##.off')
    expect(result.outcome).toBe('applied')
    expect(result.rules).toEqual(stored)
    expect(result.refused).toEqual(['on'])
  })

  it('keeps a rule it may not delete, and says which', () => {
    const result = limited('! example.com##.off')
    expect(result.rules).toEqual(stored)
    expect(result.refused).toEqual(['on'])
    // `off` is gone from the text too, and is kept the same way — it is not this editor's to delete.
    const both = limited('')
    expect(both.rules).toEqual(stored)
    expect(both.refused).toEqual(['on', 'off'])
  })

  it('marks the line of a refused change where the rule is shown', () => {
    // Commented out: the line stays where it was and shows the rule as it still is.
    const commented = projectUserRuleSource(
      stored,
      '! note\n! example.com##.on\n! example.com##.off',
      {
        ...limits,
        refused: new Set(['on'])
      }
    )
    expect(commented.source).toBe('! note\nexample.com##.on\n! example.com##.off')
    expect(commented.rejected).toEqual([{ line: 'example.com##.on', reason: 'normal-profile' }])

    // Deleted: the rule comes back at the end, where every rule the text does not name is shown.
    const deleted = projectUserRuleSource(stored, '! example.com##.off', {
      ...limits,
      refused: new Set(['on'])
    })
    expect(deleted.source).toBe('! example.com##.off\nexample.com##.on')
    expect(deleted.rejected).toEqual([{ line: 'example.com##.on', reason: 'normal-profile' }])
  })

  it('counts a rule it refused to delete against the limit', () => {
    // The text makes room by deleting a rule the editor keeps, and fills the room with a new one.
    const full = Array.from({ length: MAX_USER_RULES }, (_unused, index) =>
      ruleOf({ id: index === 0 ? 'on' : `f${index}`, text: `x.example##.n${index}` })
    )
    const text = [...full.slice(1).map((rule) => rule.text), 'new.example##.x'].join('\n')
    const result = applyUserRuleSource({ rules: full }, text, {
      ...context(),
      loaded: new Set(full.map((rule) => rule.id)),
      ...limits
    })
    expect(result.outcome).toBe('limit-reached')
    expect(result.changed).toBe(false)
  })
})

/**
 * A text saved from a page that loaded an older list.
 *
 * The rule manager is a page, the element picker writes from a window, and nothing stops the second from
 * happening while the first is open. The page's text then has no line for the new rule — not because the
 * user deleted one, but because there was none to show. Read as "a stored rule no line names is gone", the
 * save deleted a rule the user had just made and never saw: silently, which is the one failure this part of
 * the browser exists to prevent. So a missing line only deletes a rule the page was showing.
 */
describe('a text written against an older list', () => {
  const stored = [
    ruleOf({ id: 'a', text: 'example.com##.ad', createdAt: 10, origin: 'picker' }),
    ruleOf({ id: 'b', text: 'shop.example##.promo', createdAt: 20, origin: 'manual' })
  ]
  const picked = ruleOf({ id: 'late', text: 'late.example##.x', createdAt: 30, origin: 'picker' })
  const loaded = new Set(['a', 'b'])

  it('keeps a rule written after the page loaded, though the text has no line for it', () => {
    const result = applyUserRuleSource(
      { rules: [...stored, picked], source: 'example.com##.ad\nshop.example##.promo' },
      'example.com##.ad\nshop.example##.promo',
      { ...context(), loaded }
    )
    expect(result.outcome).toBe('applied')
    expect(result.rules).toEqual([...stored, picked])
    // And the next time the page opens, the rule is there to be seen.
    expect(projectUserRuleSource(result.rules, result.source).source).toBe(
      'example.com##.ad\nshop.example##.promo\nlate.example##.x'
    )
  })

  it('still deletes a rule the page was showing when its line is gone', () => {
    const result = applyUserRuleSource({ rules: [...stored, picked] }, 'example.com##.ad', {
      ...context(),
      loaded
    })
    expect(result.rules).toEqual([stored[0], picked])
  })

  it('leaves the switch of a rule the page never showed as it was', () => {
    const off = { ...picked, enabled: false }
    const result = applyUserRuleSource({ rules: [...stored, off] }, 'example.com##.ad', {
      ...context(),
      loaded
    })
    expect(result.rules).toEqual([stored[0], off])
  })

  it('takes a rule deleted elsewhere in the meantime as already deleted', () => {
    // `a` was on the page and has since gone from the blocker menu; the text drops it as well.
    const result = applyUserRuleSource({ rules: [stored[1]!] }, 'shop.example##.promo', {
      ...context(),
      loaded
    })
    expect(result.outcome).toBe('applied')
    expect(result.rules).toEqual([stored[1]])
  })

  it('writes a rule deleted elsewhere again when the text still has its line', () => {
    /*
      Last write wins for a line the text does name: the page cannot know the rule was deleted, and the
      text says it should exist. It comes back as a rule typed here, because the old record is gone.
    */
    const result = applyUserRuleSource(
      { rules: [stored[1]!] },
      'example.com##.ad\nshop.example##.promo',
      { ...context(777), loaded }
    )
    expect(result.rules).toEqual([
      stored[1],
      { id: 'new-1', text: 'example.com##.ad', enabled: true, createdAt: 777, origin: 'manual' }
    ])
  })

  it('counts a rule the page never showed against the limit', () => {
    const lines = Array.from(
      { length: MAX_USER_RULES },
      (_unused, index) => `x.example##.n${index}`
    )
    const result = applyUserRuleSource({ rules: [picked] }, lines.join('\n'), {
      ...context(),
      loaded: new Set()
    })
    expect(result.outcome).toBe('limit-reached')
    expect(result.rules).toEqual([picked])
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
      rejected: [{ line: '||ads.example^', reason: 'unsupported' }],
      term: ''
    })
    expect(lines.map((line) => line.rejected)).toEqual([false, true, false])
  })

  it('carries the reason a line was refused to the line', () => {
    const lines = annotateSourceLines('a.example##.x:has-text(y)\nb.example##.on\nnonsense', {
      rules: [],
      rejected: [
        { line: 'a.example##.x:has-text(y)', reason: 'private-window' },
        { line: 'b.example##.on', reason: 'normal-profile' },
        { line: 'nonsense', reason: 'unsupported' }
      ],
      term: ''
    })
    expect(lines.map((line) => line.refusal)).toEqual([
      'private-window',
      'normal-profile',
      'unsupported'
    ])
  })

  it('stops marking a refused line the moment it is corrected', () => {
    // The verdict was about that text. Edited, the line is one nobody has judged yet.
    const lines = annotateSourceLines('||ads.example^$third-party', {
      rules: [],
      rejected: [{ line: '||ads.example^', reason: 'unsupported' }],
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

/** A save from a page that loaded just now: it was showing every rule the editor lists. */
function saveFresh(editor: UserRuleTextEditor, text: string): { readonly outcome: string } {
  return editor.applySource(
    text,
    editor.list().map((rule) => rule.id)
  )
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

    expect(saveFresh(editor, editor.source().source).outcome).toBe('applied')
    expect(editor.list()).toEqual(before)
  })

  it('writes the notes to disk, and a later start shows them', async () => {
    const { path, store } = await storeAt()
    saveFresh(store.editorFor('normal'), '! the shop\nshop.example##.promo')
    await store.flush()

    const reopened = await UserRuleStore.open({ filePath: path, debounceMs: 0 })
    expect(reopened.editorFor('normal').source().source).toBe('! the shop\nshop.example##.promo')
  })

  it('does not write, or wake anybody, for a text that changes nothing', async () => {
    const { store } = await storeAt()
    const editor = store.editorFor('normal')
    saveFresh(editor, 'example.com##.ad')
    let told = 0
    editor.onChange(() => (told += 1))
    saveFresh(editor, 'example.com##.ad\n')
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
    expect(saveFresh(editor, lines.join('\n')).outcome).toBe('limit-reached')
    await store.flush()
    expect(await readFileJson(path)).toEqual(onDisk)
    expect(editor.list().map((rule) => rule.text)).toEqual(['example.com##.keep'])
  })

  it('lets go of the notes with the rules when everything is cleared', async () => {
    const { store } = await storeAt()
    saveFresh(store.editorFor('normal'), '! note\nexample.com##.ad')
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

describe('a save from a page opened before the picker wrote', () => {
  it('keeps the rule the picker wrote, and deletes the one whose line went', async () => {
    const { store } = await storeAt()
    const editor = store.editorFor('normal')
    editor.add({ text: 'example.com##.ad', origin: 'manual' })
    editor.add({ text: 'shop.example##.promo', origin: 'manual' })
    // The page opens: this is what it shows, and what it will send back with its text.
    const loadedIds = editor.list().map((rule) => rule.id)
    const shown = editor.source().source

    // Meanwhile, in another window, the picker writes a rule.
    const picked = editor.add({ text: 'late.example##.x', origin: 'picker' }).rule

    // The page saves its text with one line deleted — and none for the rule it never saw.
    expect(editor.applySource(shown.replace('\nshop.example##.promo', ''), loadedIds).outcome).toBe(
      'applied'
    )
    expect(editor.list().map((rule) => rule.text)).toEqual(['example.com##.ad', 'late.example##.x'])
    expect(editor.list()[1]).toEqual(picked)
    expect(editor.source().source).toBe('example.com##.ad\nlate.example##.x')
  })

  it('takes a rule deleted elsewhere in the meantime as already deleted', async () => {
    const { store } = await storeAt()
    const editor = store.editorFor('normal')
    const gone = editor.add({ text: 'example.com##.ad', origin: 'picker' }).rule
    editor.add({ text: 'shop.example##.promo', origin: 'manual' })
    const loadedIds = editor.list().map((rule) => rule.id)
    editor.remove(gone!.id)

    expect(editor.applySource('shop.example##.promo', loadedIds).outcome).toBe('applied')
    expect(editor.list().map((rule) => rule.text)).toEqual(['shop.example##.promo'])
  })

  it("keeps both kinds of late rule in a private window: the session's and the stored", async () => {
    const { store } = await storeAt()
    store.editorFor('normal').add({ text: 'example.com##.stored', origin: 'manual' })
    const session = store.editorFor('private')
    session.add({ text: 'private.example##.old', origin: 'picker' })
    const loadedIds = session.list().map((rule) => rule.id)
    const shown = session.source().source

    // The picker writes in the private window, and a normal window writes to the file.
    session.add({ text: 'private.example##.late', origin: 'picker' })
    store.editorFor('normal').add({ text: 'stored.example##.late', origin: 'picker' })

    expect(session.applySource(shown.replace('private.example##.old', ''), loadedIds).outcome).toBe(
      'applied'
    )
    expect(session.list().map((rule) => rule.text)).toEqual([
      'example.com##.stored',
      'stored.example##.late',
      'private.example##.late'
    ])
    expect(store.rules().map((rule) => rule.text)).toEqual([
      'example.com##.stored',
      'stored.example##.late'
    ])
  })
})

describe('the text, in a private window', () => {
  it('changes nothing on disk and nothing in the normal profile', async () => {
    const { path, store } = await storeAt()
    saveFresh(store.editorFor('normal'), '! mine\nexample.com##.stored')
    await store.flush()
    const onDisk = await readFileJson(path)
    const normalBefore = store.editorFor('normal').list()

    const session = store.editorFor('private')
    expect(
      saveFresh(session, '! session note\n! example.com##.stored\nprivate.example##.x').outcome
    ).toBe('applied')
    await store.flush()

    expect(await readFileJson(path)).toEqual(onDisk)
    expect(store.editorFor('normal').list()).toEqual(normalBefore)
    expect(store.editorFor('normal').source().source).toBe('! mine\nexample.com##.stored')
  })

  it('shows the session what the session wrote', async () => {
    const { store } = await storeAt()
    saveFresh(store.editorFor('normal'), 'example.com##.stored')
    const session = store.editorFor('private')
    saveFresh(
      session,
      '! session note\nexample.com##.stored\n! private.example##.y\nprivate.example##.x'
    )

    expect(session.source().source).toBe(
      '! session note\nexample.com##.stored\n! private.example##.y\nprivate.example##.x'
    )
    expect(session.list().map((rule) => [rule.text, rule.enabled])).toEqual([
      ['example.com##.stored', true],
      ['private.example##.y', false],
      ['private.example##.x', true]
    ])
    expect(session.list()[1]?.id).toMatch(/^session-/)
  })

  it('reads the stored text until it writes its own', async () => {
    const { store } = await storeAt()
    saveFresh(store.editorFor('normal'), '! mine\nexample.com##.stored')
    expect(store.editorFor('private').source().source).toBe('! mine\nexample.com##.stored')
  })

  it('switches its own rule off and on, and deletes it', async () => {
    const { store } = await storeAt()
    const session = store.editorFor('private')
    saveFresh(session, 'private.example##.x\nprivate.example##.y')
    saveFresh(session, '! private.example##.x')

    expect(session.list().map((rule) => [rule.text, rule.enabled])).toEqual([
      ['private.example##.x', false]
    ])
    saveFresh(session, 'private.example##.x')
    expect(session.list().map((rule) => rule.enabled)).toEqual([true])
    expect(session.source().rejected).toEqual([])
  })

  it('switches on a stored rule that is off, for the session and not in the file', async () => {
    const { path, store } = await storeAt()
    saveFresh(store.editorFor('normal'), '! example.com##.stored')
    await store.flush()
    const onDisk = await readFileJson(path)
    const session = store.editorFor('private')

    expect(saveFresh(session, 'example.com##.stored').outcome).toBe('applied')
    expect(session.list().map((rule) => [rule.text, rule.enabled])).toEqual([
      ['example.com##.stored', true]
    ])
    // What a private window's views are served, through `sessionStylesFor`.
    expect(session.enabledText()).toBe('example.com##.stored')
    expect(session.source()).toEqual({ source: 'example.com##.stored', rejected: [] })
    await store.flush()
    expect(await readFileJson(path)).toEqual(onDisk)
    // The engine's global slot is fed from the file, and the file still has it off.
    expect(store.enabledText()).toBe('')

    // And back off: it is the session's own switch it takes back, so that is honoured too.
    saveFresh(session, '! example.com##.stored')
    expect(session.enabledText()).toBe('')

    saveFresh(session, 'example.com##.stored')
    store.endPrivateSession()
    expect(session.list().map((rule) => rule.enabled)).toEqual([false])
    expect(session.enabledText()).toBe('')
  })

  it('refuses to switch off a stored rule that is on, and marks its line', async () => {
    /*
      A stored rule reaches every window through the engine's one global slot, and a private window can only
      add to what its pages get. Switched off here, it would be listed as off and go on hiding its element —
      so the text is not taken for that line, and the line says why where it stands.
    */
    const { path, store } = await storeAt()
    saveFresh(store.editorFor('normal'), 'example.com##.stored')
    await store.flush()
    const onDisk = await readFileJson(path)
    const session = store.editorFor('private')

    expect(saveFresh(session, '! note\n! example.com##.stored').outcome).toBe('applied')
    expect(session.list().map((rule) => [rule.text, rule.enabled])).toEqual([
      ['example.com##.stored', true]
    ])
    expect(session.source()).toEqual({
      source: '! note\nexample.com##.stored',
      rejected: [{ line: 'example.com##.stored', reason: 'normal-profile' }]
    })
    await store.flush()
    expect(await readFileJson(path)).toEqual(onDisk)
  })

  it('refuses to delete a stored rule, and marks the line it comes back on', async () => {
    const { store } = await storeAt()
    saveFresh(store.editorFor('normal'), 'example.com##.stored')
    const session = store.editorFor('private')

    saveFresh(session, 'private.example##.x')
    expect(session.list().map((rule) => rule.text)).toEqual([
      'example.com##.stored',
      'private.example##.x'
    ])
    expect(session.source()).toEqual({
      source: 'private.example##.x\nexample.com##.stored',
      rejected: [{ line: 'example.com##.stored', reason: 'normal-profile' }]
    })

    // The next save that leaves it alone takes the mark away; the end of the session does as well.
    saveFresh(session, session.source().source)
    expect(session.source().rejected).toEqual([])
    saveFresh(session, 'private.example##.x')
    store.endPrivateSession()
    expect(session.source().rejected).toEqual([])
  })

  it('refuses a procedural rule and an exception it cannot deliver, and marks them', async () => {
    const { store } = await storeAt()
    const session = store.editorFor('private')
    const text = 'example.com##.box:has-text(Ad)\nexample.com#@#.box\nexample.com##.plain'

    expect(saveFresh(session, text).outcome).toBe('applied')
    expect(session.list().map((rule) => rule.text)).toEqual(['example.com##.plain'])
    expect(session.source()).toEqual({
      source: text,
      rejected: [
        { line: 'example.com##.box:has-text(Ad)', reason: 'private-window' },
        { line: 'example.com#@#.box', reason: 'private-window' }
      ]
    })
    expect(store.rules()).toEqual([])
  })

  it('takes the same lines in a normal window, where the engine applies them', async () => {
    const { store } = await storeAt()
    const editor = store.editorFor('normal')
    const text = 'example.com##.box:has-text(Ad)\nexample.com#@#.box'

    saveFresh(editor, text)
    expect(editor.list().map((rule) => rule.text)).toEqual([
      'example.com##.box:has-text(Ad)',
      'example.com#@#.box'
    ])
    expect(editor.source()).toEqual({ source: text, rejected: [] })
  })

  it('takes a deletion when the stored rules grew past the limit behind it', async () => {
    const { store } = await storeAt()
    const session = store.editorFor('private')
    for (let index = 0; index < 10; index += 1) {
      session.add({ text: `private.example##.n${index}`, origin: 'picker' })
    }
    const normal = store.editorFor('normal')
    for (let index = 0; index < MAX_USER_RULES - 5; index += 1) {
      normal.add({ text: `stored.example##.n${index}`, origin: 'picker' })
    }
    expect(session.list()).toHaveLength(MAX_USER_RULES + 5)
    const shown = session.source().source

    expect(saveFresh(session, shown.replace('private.example##.n0\n', '')).outcome).toBe('applied')
    expect(session.list()).toHaveLength(MAX_USER_RULES + 4)
    expect(
      saveFresh(
        session,
        session.source().source.replace('private.example##.n1', '! private.example##.n1')
      ).outcome
    ).toBe('applied')
    expect(saveFresh(session, `${session.source().source}\nprivate.example##.more`).outcome).toBe(
      'limit-reached'
    )
  })

  it('refuses a session text over the limit, counting the stored rules', async () => {
    const { store } = await storeAt()
    store.editorFor('normal').add({ text: 'example.com##.stored', origin: 'picker' })
    const session = store.editorFor('private')
    const lines = Array.from(
      { length: MAX_USER_RULES },
      (_unused, index) => `x.example##.n${index}`
    )
    expect(saveFresh(session, ['example.com##.stored', ...lines].join('\n')).outcome).toBe(
      'limit-reached'
    )
    expect(session.list().map((rule) => rule.text)).toEqual(['example.com##.stored'])
  })

  it('tells its listeners once, and not at all for a text that changes nothing', async () => {
    const { store } = await storeAt()
    const session = store.editorFor('private')
    let told = 0
    session.onChange(() => (told += 1))
    saveFresh(session, 'private.example##.x')
    saveFresh(session, 'private.example##.x')
    expect(told).toBe(1)
  })

  it('forgets its text when the private session ends', async () => {
    const { store } = await storeAt()
    saveFresh(store.editorFor('normal'), 'example.com##.stored')
    const session = store.editorFor('private')
    saveFresh(session, '! session only')
    store.endPrivateSession()
    expect(session.source().source).toBe('example.com##.stored')
  })
})
