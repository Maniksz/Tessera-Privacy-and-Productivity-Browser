import { describe, expect, it } from 'vitest'
import { defaultSettings } from '@shared/settings/definitions.js'
import {
  MAX_UNLOAD_MINUTES,
  MIN_UNLOAD_MINUTES,
  UNLOAD_EXEMPTIONS,
  unloadCandidates,
  unloadExemptionOf,
  unloadSettingsOf,
  type UnloadExemption,
  type UnloadFacts
} from '@shared/session/unload-policy.js'

/**
 * Which idle tab may be unloaded (R26, KTD9): the pure half, with no view and no timer.
 *
 * Every exemption is a tab the user would lose something in — a tile going blank, a paused video that
 * starts over, a half-written message — so each one is asked on its own, with everything else about the
 * tab making it a candidate. A rule that stopped holding would show up as exactly one of these turning.
 */

const MINUTE = 60_000
const NOW = 1_000 * MINUTE

/** A tab idle for `idleMinutes`, with no reason to keep it. */
function idle(idleMinutes: number, overrides: Partial<UnloadFacts> = {}): UnloadFacts {
  const facts: UnloadFacts = {
    tabId: 'tab-1',
    lastActiveAt: NOW - idleMinutes * MINUTE,
    tile: false,
    audible: false,
    media: false,
    pinned: false,
    loading: false,
    devtools: false,
    fullscreen: false,
    prompt: false,
    input: false,
    internal: false,
    failure: false,
    objected: false,
    unloaded: false
  }
  return { ...facts, ...overrides }
}

const THIRTY = unloadSettingsOf(defaultSettings())

describe('unloadSettingsOf', () => {
  it('is on by default, after thirty minutes (Key Decision: unloading stays on)', () => {
    expect(THIRTY).toEqual({ enabled: true, afterMs: 30 * MINUTE })
  })

  it('reads both settings', () => {
    expect(
      unloadSettingsOf({ 'advanced.unloadInactiveTabs': false, 'advanced.unloadAfterMinutes': 5 })
    ).toEqual({ enabled: false, afterMs: 5 * MINUTE })
  })

  it('holds the minutes to the range the setting allows', () => {
    const at = (minutes: number): number =>
      unloadSettingsOf({
        'advanced.unloadInactiveTabs': true,
        'advanced.unloadAfterMinutes': minutes
      }).afterMs
    expect([MIN_UNLOAD_MINUTES, MAX_UNLOAD_MINUTES]).toEqual([1, 1440])
    expect(at(0)).toBe(MINUTE)
    expect(at(1)).toBe(MINUTE)
    expect(at(1440)).toBe(1440 * MINUTE)
    expect(at(5000)).toBe(1440 * MINUTE)
  })
})

describe('unloadCandidates', () => {
  it('names a tab idle for 31 minutes with nothing to keep it', () => {
    expect(unloadCandidates([idle(31)], NOW, THIRTY)).toEqual(['tab-1'])
  })

  it('counts from the moment the setting names, not a minute later', () => {
    expect(unloadCandidates([idle(30)], NOW, THIRTY)).toEqual(['tab-1'])
    expect(unloadCandidates([idle(29.99)], NOW, THIRTY)).toEqual([])
  })

  it('names nobody while the setting is off', () => {
    expect(unloadCandidates([idle(600)], NOW, { ...THIRTY, enabled: false })).toEqual([])
  })

  it('holds the limits at 1 and at 1440 minutes', () => {
    const one = unloadSettingsOf({
      'advanced.unloadInactiveTabs': true,
      'advanced.unloadAfterMinutes': 1
    })
    const day = unloadSettingsOf({
      'advanced.unloadInactiveTabs': true,
      'advanced.unloadAfterMinutes': 1440
    })
    expect(unloadCandidates([idle(1)], NOW, one)).toEqual(['tab-1'])
    expect(unloadCandidates([idle(0.99)], NOW, one)).toEqual([])
    expect(unloadCandidates([idle(1440)], NOW, day)).toEqual(['tab-1'])
    expect(unloadCandidates([idle(1439)], NOW, day)).toEqual([])
  })

  it('keeps the strip order and leaves the exempt ones out', () => {
    const tabs = [
      idle(40, { tabId: 'a' }),
      idle(40, { tabId: 'b', pinned: true }),
      idle(10, { tabId: 'c' }),
      idle(90, { tabId: 'd' })
    ]
    expect(unloadCandidates(tabs, NOW, THIRTY)).toEqual(['a', 'd'])
  })

  it('names nobody when the minutes cannot be read', () => {
    expect(unloadCandidates([idle(600)], NOW, { enabled: true, afterMs: Number.NaN })).toEqual([])
  })
})

describe('unloadExemptionOf', () => {
  it('finds nothing to keep an ordinary tab', () => {
    expect(unloadExemptionOf(idle(31))).toBeNull()
  })

  /*
    One row per exemption, each alone. The plan's list, in its words: a tile; audible, playing muted or
    paused media; pinned, loading, devtools open, HTML fullscreen; a pending prompt of any kind; unsaved
    input; an internal page; a failure (KTD22); and a page that objected to the last attempt.
  */
  const cases: ReadonlyArray<[UnloadExemption, string]> = [
    ['tile', 'a tile shows it'],
    ['audible', 'it is playing sound'],
    ['media', 'a video in it is paused, or playing muted (AE7)'],
    ['pinned', 'it is pinned'],
    ['loading', 'it is still loading'],
    ['devtools', 'its devtools are open'],
    ['fullscreen', 'a page in it is fullscreen'],
    ['prompt', 'a picker, a prompt, a save bar, a fill request or a find bar waits on it'],
    ['input', 'a form field in it was typed into, focused or not'],
    ['internal', 'it shows an internal page'],
    ['failure', 'its tile shows a failure'],
    ['objected', 'its page refused the last unload'],
    ['unloaded', 'it is unloaded already']
  ]

  it.each(cases)('keeps a tab when %s: %s', (exemption) => {
    const facts = idle(600, { [exemption]: true })
    expect(unloadExemptionOf(facts)).toBe(exemption)
    expect(unloadCandidates([facts], NOW, THIRTY)).toEqual([])
  })

  it('lists every exemption the facts can carry, once', () => {
    expect([...UNLOAD_EXEMPTIONS].sort()).toEqual(cases.map(([name]) => name).sort())
  })

  it('names the first exemption in the list when several apply', () => {
    expect(unloadExemptionOf(idle(600, { pinned: true, tile: true }))).toBe('tile')
  })
})
