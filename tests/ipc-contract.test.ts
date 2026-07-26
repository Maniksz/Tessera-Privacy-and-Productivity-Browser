import { describe, expect, it } from 'vitest'
import {
  EVENT_CHANNELS,
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
