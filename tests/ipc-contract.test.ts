import { describe, expect, it } from 'vitest'
import {
  EVENT_CHANNELS,
  INTERNAL_PAGE_INVOKE_CHANNELS,
  INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel
} from '@shared/ipc/channels.js'
import { eventContract, invokeContract } from '@shared/ipc/contract.js'
import { catalogs, LOCALES, translate } from '@shared/i18n/catalog.js'
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  findBindingConflicts,
  KNOWN_CONFLICTS
} from '@shared/shortcuts/bindings.js'
import type { Platform } from '@shared/model.js'
import {
  MAX_LOADED_USER_RULE_IDS,
  MAX_USER_RULE_SOURCE_LENGTH
} from '@shared/filters/user-rules-source.js'

/**
 * Spec 6 requires the UI/core boundary to be defined once and checked
 * statically. TypeScript does most of that; these tests cover the parts a type
 * system cannot see — that the two halves stay the same size, and that nothing
 * is declared without being reachable.
 */

describe('IPC contract', () => {
  it('covers every invoke channel exactly once', () => {
    expect(Object.keys(invokeContract).sort()).toEqual([...INVOKE_CHANNELS].sort())
  })

  it('covers every event channel exactly once', () => {
    expect(Object.keys(eventContract).sort()).toEqual([...EVENT_CHANNELS].sort())
  })

  it('declares no duplicate channel names', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length)
  })

  it('keeps invoke and event namespaces separate', () => {
    const overlap = INVOKE_CHANNELS.filter((channel) =>
      (EVENT_CHANNELS as readonly string[]).includes(channel)
    )
    expect(overlap).toEqual([])
  })

  it('gives every invoke channel a request and a response schema', () => {
    for (const channel of INVOKE_CHANNELS) {
      const definition = invokeContract[channel]
      expect(definition.request, channel).toBeDefined()
      expect(definition.response, channel).toBeDefined()
    }
  })

  it('rejects channel names outside the allowlist', () => {
    // This is the preload's runtime guard: unknown names must not pass.
    expect(isInvokeChannel('settings:getAll')).toBe(true)
    expect(isInvokeChannel('settings:definitelyNotAChannel')).toBe(false)
    expect(isEventChannel('tabs:changed')).toBe(true)
    expect(isEventChannel('__proto__')).toBe(false)
  })

  it('validates a well-formed request', () => {
    const parsed = invokeContract['split:setLayout'].request.safeParse({ layout: '2x2' })
    expect(parsed.success).toBe(true)
  })

  it('rejects a malformed request', () => {
    // The main process must not trust the renderer, even our own.
    expect(invokeContract['split:setLayout'].request.safeParse({ layout: '9x9' }).success).toBe(false)
    expect(invokeContract['tabs:close'].request.safeParse({}).success).toBe(false)
  })
})

/**
 * The rule manager's two channels (U8, KTD13, OQ5).
 *
 * The save is the one new channel this work gives `tessera://settings`, and it *replaced* three rather than
 * joining them — see the grant's comment in `channels.ts`. What is pinned here is the shape that argument
 * rests on: the text is bounded, the answer is one of two words, and the one-rule write channels are gone
 * from the contract, not merely from the page's grant.
 */
describe('the rule manager', () => {
  const apply = invokeContract['userrules:apply']

  it('takes a whole text, an empty one included, and nothing past the bound', () => {
    expect(
      apply.request.safeParse({ text: '! note\nexample.com##.ad', loadedIds: ['r1'] }).success
    ).toBe(true)
    // An emptied box, saved, is a list with no rules — not a malformed request.
    expect(apply.request.safeParse({ text: '', loadedIds: [] }).success).toBe(true)
    expect(
      apply.request.safeParse({
        text: 'x'.repeat(MAX_USER_RULE_SOURCE_LENGTH + 1),
        loadedIds: []
      }).success
    ).toBe(false)
    expect(apply.request.safeParse({}).success).toBe(false)
  })

  it('says which rules the text was written against, and cannot leave that out', () => {
    /*
      Required: without the ids the only reading left is "the page showed every rule", which deletes a rule
      the picker wrote while the page was open. Bounded, because the list arrives from a page.
    */
    expect(apply.request.safeParse({ text: '' }).success).toBe(false)
    expect(apply.request.safeParse({ text: '', loadedIds: [''] }).success).toBe(false)
    const ids = (count: number): string[] => Array.from({ length: count }, (_unused, i) => `r${i}`)
    expect(
      apply.request.safeParse({ text: '', loadedIds: ids(MAX_LOADED_USER_RULE_IDS) }).success
    ).toBe(true)
    expect(
      apply.request.safeParse({ text: '', loadedIds: ids(MAX_LOADED_USER_RULE_IDS + 1) }).success
    ).toBe(false)
  })

  it('answers with one of the two outcomes and nothing else', () => {
    expect(apply.response.safeParse({ outcome: 'applied' }).success).toBe(true)
    expect(apply.response.safeParse({ outcome: 'limit-reached' }).success).toBe(true)
    expect(apply.response.safeParse({ outcome: 'added' }).success).toBe(false)
  })

  it('carries the text, the refused lines and the mode on the read', () => {
    const answer = {
      rules: [],
      text: {},
      source: '! note',
      rejected: [
        { line: '||ads.example^', reason: 'unsupported' },
        { line: 'example.com##.box:has-text(Ad)', reason: 'private-window' },
        { line: 'example.com##.stored', reason: 'normal-profile' }
      ],
      session: true
    }
    expect(invokeContract['userrules:list'].response.safeParse(answer).success).toBe(true)
    expect(
      invokeContract['userrules:list'].response.safeParse({
        ...answer,
        rejected: [{ line: 'x', reason: 'because' }]
      }).success
    ).toBe(false)
    const { session: _session, ...withoutMode } = answer
    expect(invokeContract['userrules:list'].response.safeParse(withoutMode).success).toBe(false)
  })

  it('has replaced the one-rule write channels rather than joined them', () => {
    const channels: readonly string[] = INVOKE_CHANNELS
    for (const gone of ['userrules:add', 'userrules:setEnabled', 'userrules:remove']) {
      expect(channels, gone).not.toContain(gone)
    }
    const settings: readonly string[] = INTERNAL_PAGE_INVOKE_CHANNELS.settings
    expect(settings.filter((channel) => channel.startsWith('userrules:')).sort()).toEqual([
      'userrules:apply',
      'userrules:list'
    ])
  })

  it('gives the save to no internal page but settings', () => {
    for (const [page, granted] of Object.entries(INTERNAL_PAGE_INVOKE_CHANNELS)) {
      if (page === 'settings') continue
      expect(granted as readonly string[], page).not.toContain('userrules:apply')
    }
  })
})

describe('i18n catalogue', () => {
  it('has the same keys in every locale', () => {
    const reference = Object.keys(catalogs.en).sort()
    for (const locale of LOCALES) {
      expect(Object.keys(catalogs[locale]).sort(), locale).toEqual(reference)
    }
  })

  it('has no empty translations', () => {
    for (const locale of LOCALES) {
      for (const [key, value] of Object.entries(catalogs[locale])) {
        expect(value.trim(), `${locale}/${key}`).not.toBe('')
      }
    }
  })

  it('substitutes placeholders', () => {
    expect(translate('en', 'omnibox.blockedCount', { count: 12 })).toBe('12 requests blocked')
    expect(translate('de', 'omnibox.blockedCount', { count: 12 })).toBe('12 Anfragen blockiert')
  })

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(translate('en', 'omnibox.blockedCount', {})).toContain('{count}')
  })

  it('keeps placeholders consistent across locales', () => {
    // A translation that drops a placeholder silently loses information.
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()

    for (const key of Object.keys(catalogs.en) as Array<keyof typeof catalogs.en>) {
      const reference = placeholders(catalogs.en[key])
      for (const locale of LOCALES) {
        expect(placeholders(catalogs[locale][key]), `${locale}/${key}`).toEqual(reference)
      }
    }
  })
})

describe('keyboard bindings', () => {
  const platforms: Platform[] = ['win32', 'linux', 'darwin']

  it('binds every action on every platform', () => {
    // Spec 10: no feature may be reachable on one platform only.
    for (const platform of platforms) {
      for (const action of SHORTCUT_ACTIONS) {
        const accelerators = DEFAULT_BINDINGS[platform][action]
        expect(accelerators.length, `${platform}/${action}`).toBeGreaterThan(0)
        expect(accelerators[0], `${platform}/${action}`).not.toBe('')
      }
    }
  })

  it('has no accelerator bound to two actions', () => {
    for (const platform of platforms) {
      expect(findBindingConflicts(platform), platform).toEqual([])
    }
  })

  it('does not put tile switching on the macOS tab-switching combination', () => {
    // The exact collision spec 9 warns about: a mechanical Ctrl -> Command swap
    // would land tile switching on Cmd+Alt+Arrow, which is tab switching.
    const mac = DEFAULT_BINDINGS.darwin
    expect(mac.tileLeft).not.toContain('Command+Alt+Left')
    expect(mac.tileRight).not.toContain('Command+Alt+Right')
    expect(mac.tileLeft[0]).toBe('Control+Alt+Left')
    expect(mac.previousTab).toContain('Command+Alt+Left')
  })

  it('does not use bare Ctrl+Arrow on macOS', () => {
    // Reserved by macOS window management.
    const mac = DEFAULT_BINDINGS.darwin
    for (const action of SHORTCUT_ACTIONS) {
      for (const accelerator of mac[action]) {
        expect(/^Control\+(Left|Right|Up|Down)$/.test(accelerator), accelerator).toBe(false)
      }
    }
  })

  it('flags the Linux workspace collision instead of failing silently', () => {
    const flagged = KNOWN_CONFLICTS.linux.map((conflict) => conflict.accelerator)
    expect(flagged).toContain(DEFAULT_BINDINGS.linux.tileLeft[0])
  })

  it('offers an alternative for every known conflict', () => {
    for (const platform of platforms) {
      for (const conflict of KNOWN_CONFLICTS[platform]) {
        expect(conflict.alternative, `${platform}/${conflict.accelerator}`).not.toBe('')
        expect(conflict.alternative).not.toBe(conflict.accelerator)
      }
    }
  })

  it('uses Command on macOS and Control elsewhere for new tab', () => {
    expect(DEFAULT_BINDINGS.darwin.newTab[0]).toBe('Command+T')
    expect(DEFAULT_BINDINGS.win32.newTab[0]).toBe('Control+T')
    expect(DEFAULT_BINDINGS.linux.newTab[0]).toBe('Control+T')
  })
})
