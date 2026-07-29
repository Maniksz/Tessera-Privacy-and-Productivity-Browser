import { describe, expect, it, vi } from 'vitest'
import { classifyOmniboxInput } from '@shared/url/omnibox.js'
import {
  configurePublicSuffixes,
  matchHostRule,
  normalizeHost,
  registrableDomain
} from '@shared/url/domain.js'
import { dividersFor, withDefaults } from '@shared/split/layout.js'
import { titleFromUrl } from '@shared/quicklinks/model.js'
import {
  anyInternalInvokeChannels,
  isEventChannel,
  mayInternalPageInvoke,
  mayInternalPageListen
} from '@shared/ipc/channels.js'
import { appliesOf, sectionOf, SETTINGS_KEYS } from '@shared/settings/definitions.js'
import {
  DEFAULT_BINDINGS,
  SHORTCUT_ACTIONS,
  TAB_BY_INDEX_ACCELERATORS,
  acceleratorFor,
  allAcceleratorsFor,
  findBindingConflicts
} from '@shared/shortcuts/bindings.js'
import { DEFAULT_LOCALE, catalogs, isLocale, resolveLocale, translate } from '@shared/i18n/catalog.js'
import { installRequestPipeline, type StageId } from '@main/privacy/RequestPipeline.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import { PRODUCT_NAME } from '@shared/product.js'

/**
 * Paths the behavioural tests do not reach.
 *
 * Written after a coverage run pointed at them, and each one is a real branch
 * rather than a line touched to move a number: IPv6 hosts, malformed URLs that
 * survive a scheme check, the public-suffix injection seam, and the pipeline
 * installer that needs a session-shaped object to exercise at all.
 */

describe('omnibox: hosts the common cases miss', () => {
  it('recognises a bracketed IPv6 address', () => {
    expect(classifyOmniboxInput('[::1]')).toEqual({ kind: 'url', url: 'https://[::1]' })
  })

  it('recognises IPv6 with a port', () => {
    expect(classifyOmniboxInput('[2001:db8::1]:8080')).toEqual({
      kind: 'url',
      url: 'https://[2001:db8::1]:8080'
    })
  })

  it('treats an unterminated bracket as a search rather than guessing', () => {
    expect(classifyOmniboxInput('[::1').kind).toBe('search')
  })

  it('searches for a known scheme whose URL will not parse', () => {
    // `http://` with nothing after it passes the scheme check and then fails to
    // parse; searching is better than navigating nowhere.
    expect(classifyOmniboxInput('http://')).toEqual({ kind: 'search', query: 'http://' })
  })

  it('searches when the host part cannot be parsed at all', () => {
    expect(classifyOmniboxInput('http://[unclosed').kind).toBe('search')
  })

  it('strips userinfo before judging the host', () => {
    expect(classifyOmniboxInput('user:pass@example.com')).toEqual({
      kind: 'url',
      url: 'https://user:pass@example.com'
    })
  })

  it('does not treat a non-numeric port suffix as a port', () => {
    // Keeping the suffix makes the host fail validation, which is the point: it
    // must not quietly resolve.
    expect(classifyOmniboxInput('example.com:notaport').kind).toBe('search')
  })

  it('accepts view-source for a valid target', () => {
    expect(classifyOmniboxInput('view-source:https://example.com/').kind).toBe('url')
  })

  it('passes about: through untouched', () => {
    expect(classifyOmniboxInput('about:blank')).toEqual({ kind: 'url', url: 'about:blank' })
  })

  it('searches for a lone question mark', () => {
    expect(classifyOmniboxInput('?')).toEqual({ kind: 'empty' })
  })

  it('searches for a lone question mark with spaces', () => {
    expect(classifyOmniboxInput('?   ')).toEqual({ kind: 'empty' })
  })
})

describe('domain: the public suffix seam', () => {
  it('accepts a replacement suffix list', () => {
    // The seam the real Public Suffix List drops into; untested it would be a
    // promise rather than a feature.
    const original = registrableDomain('foo.bar.example')
    configurePublicSuffixes(['bar.example'])
    expect(registrableDomain('foo.bar.example')).toBe('foo.bar.example')

    // Restore something close to the bootstrap set so later tests are unaffected.
    configurePublicSuffixes(['co.uk', 'com.au', 'github.io'])
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk')
    expect(original).toBeDefined()
  })

  it('normalises a leading dot in a supplied suffix', () => {
    configurePublicSuffixes(['.co.uk'])
    expect(registrableDomain('www.bbc.co.uk')).toBe('bbc.co.uk')
  })

  it('lower-cases supplied suffixes', () => {
    configurePublicSuffixes(['CO.UK'])
    expect(registrableDomain('WWW.BBC.CO.UK')).toBe('bbc.co.uk')
  })
})

describe('domain: rule matching', () => {
  it('returns the first matching pattern', () => {
    expect(matchHostRule('ad.doubleclick.net', ['example.com', 'doubleclick.net'])).toBe(
      'doubleclick.net'
    )
  })

  it('returns null when nothing matches', () => {
    expect(matchHostRule('example.com', ['doubleclick.net'])).toBeNull()
  })

  it('returns null for an empty pattern list', () => {
    expect(matchHostRule('example.com', [])).toBeNull()
  })

  it('normalises a host with a trailing dot and brackets', () => {
    expect(normalizeHost('[2001:db8::1]')).toBe('2001:db8::1')
    expect(normalizeHost('Example.COM.')).toBe('example.com')
  })

  it('returns an empty host unchanged', () => {
    expect(registrableDomain('')).toBe('')
  })
})

describe('layout: dividers per arrangement', () => {
  it('gives 1x2 one vertical divider', () => {
    const dividers = dividersFor('1x2', { v: 0.5 })
    expect(dividers).toHaveLength(1)
    expect(dividers[0]?.orientation).toBe('vertical')
  })

  it('gives 2x1 one horizontal divider', () => {
    const dividers = dividersFor('2x1', { h: 0.5 })
    expect(dividers).toHaveLength(1)
    expect(dividers[0]?.orientation).toBe('horizontal')
  })

  it('falls back to the layout default when the 1+2 vertical fraction is missing', () => {
    const [, hRight] = dividersFor('1+2', {})
    expect(hRight?.region.x).toBeCloseTo(0.6, 6)
  })

  it('ignores a non-finite supplied fraction', () => {
    expect(withDefaults('1x2', { v: Number.POSITIVE_INFINITY })['v']).toBe(0.5)
  })

  it('ignores a fraction the layout does not have', () => {
    expect(withDefaults('1x2', { nonsense: 0.3 })['nonsense']).toBeUndefined()
  })
})

describe('quick links: title fallbacks', () => {
  it('uses the path when a URL has no host and no leading slash', () => {
    expect(titleFromUrl('tessera://start')).toBe('start')
  })

  it('returns the URL when there is neither host nor path', () => {
    expect(titleFromUrl('about:')).toBe('about:')
  })
})

describe('channel guards', () => {
  it('grants an address that is not a page nothing at all', () => {
    /*
      The most security-relevant line in the module, and it was the one line no test reached:
      every existing caller passed a real page name, so the "not a page" answer was never asked
      for. `tessera://favicon` serves bytes and has no renderer; `tessera://nope` is
      nothing. Neither may become a bridge by having the right scheme.
    */
    for (const host of ['favicon', 'nope', 'https-only', '', 'START']) {
      for (const channel of ['i18n:getCatalog', 'settings:set', 'quicklinks:list']) {
        expect(mayInternalPageInvoke(host, channel), `${host} -> ${channel}`).toBe(false)
      }
    }
  })

  it('offers the union only as a question, never as a grant', () => {
    // `anyInternalInvokeChannels` exists so a test can ask "could *any* page reach this". It must
    // never be mistaken for a permission: no single page holds all of it.
    const union = anyInternalInvokeChannels() as readonly string[]
    expect(union).toContain('settings:set')
    expect(union).toContain('quicklinks:list')
    for (const page of ['start', 'settings', 'extensions', 'history']) {
      const granted = union.filter((channel) => mayInternalPageInvoke(page, channel))
      expect(granted.length, `${page} holds the whole union`).toBeLessThan(union.length)
    }
  })

  it('lets a page hear the events about its own subject', () => {
    expect(mayInternalPageListen('start', 'quicklinks:changed')).toBe(true)
    expect(mayInternalPageListen('settings', 'settings:changed')).toBe(true)
  })

  it("does not let a page hear another page's events", () => {
    // Subscriptions are a permission too: the start page hearing every settings change would
    // learn what the user configures, which is none of its business.
    expect(mayInternalPageListen('start', 'settings:changed')).toBe(false)
    expect(mayInternalPageListen('settings', 'quicklinks:changed')).toBe(false)
  })

  it('refuses a chrome-only event channel to every internal page', () => {
    for (const page of ['start', 'settings', 'extensions', 'history']) {
      expect(mayInternalPageListen(page, 'tabs:changed'), page).toBe(false)
    }
    // Still a real channel — just not one an internal page may hear.
    expect(isEventChannel('tabs:changed')).toBe(true)
  })

  it('refuses an address that is not a page at all', () => {
    expect(mayInternalPageListen('favicon', 'quicklinks:changed')).toBe(false)
    expect(mayInternalPageListen('', 'quicklinks:changed')).toBe(false)
  })
})

describe('settings metadata', () => {
  it('reports a section and an application moment for every key', () => {
    for (const key of SETTINGS_KEYS) {
      expect(sectionOf(key), key).toBeTruthy()
      expect(['live', 'new-tab', 'restart'], key).toContain(appliesOf(key))
    }
  })

  it('marks hardware acceleration as needing a restart', () => {
    // Chromium reads this during initialisation; claiming otherwise in the UI
    // would be the "switch that does nothing" spec 5 forbids.
    expect(appliesOf('advanced.hardwareAcceleration')).toBe('restart')
  })
})

describe('shortcuts: overrides and conflicts', () => {
  it('prefers a user override over the platform default', () => {
    expect(acceleratorFor('win32', 'newTab', { newTab: 'Control+Alt+T' })).toBe('Control+Alt+T')
  })

  it('falls back to the default when the override is empty', () => {
    expect(acceleratorFor('win32', 'newTab', { newTab: '' })).toBe('Control+T')
  })

  it('replaces every alternative when overridden', () => {
    // Keeping the defaults alongside an override would leave the old key working,
    // which is not what "rebind" means.
    expect(allAcceleratorsFor('win32', 'reload', { reload: 'F9' })).toEqual(['F9'])
  })

  it('lists every default alternative when not overridden', () => {
    expect(allAcceleratorsFor('win32', 'reload')).toEqual(['F5', 'Control+R'])
  })

  it('detects a duplicate introduced by an override', () => {
    const conflicts = findBindingConflicts('win32', { findInPage: 'Control+T' })
    const accelerators = conflicts.map((conflict) => conflict.accelerator)
    expect(accelerators).toContain('Control+T')
  })

  it('does not report Escape as a conflict', () => {
    // `stop` and `escape` share it deliberately; which applies depends on whether
    // a load is in flight, and the window resolves that at press time.
    const conflicts = findBindingConflicts('win32')
    expect(conflicts.map((c) => c.accelerator)).not.toContain('Escape')
  })

  it('ignores an empty override when looking for conflicts', () => {
    expect(findBindingConflicts('win32', { newTab: '' })).toEqual([])
  })

  it('offers eight positional tab accelerators per platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(TAB_BY_INDEX_ACCELERATORS[platform], platform).toHaveLength(8)
    }
  })

  it('covers every action on every platform', () => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      for (const action of SHORTCUT_ACTIONS) {
        expect(DEFAULT_BINDINGS[platform][action].length, `${platform}/${action}`).toBeGreaterThan(0)
      }
    }
  })
})

describe('i18n helpers', () => {
  it('recognises supported locales', () => {
    expect(isLocale('de')).toBe(true)
    expect(isLocale('en')).toBe(true)
    expect(isLocale('fr')).toBe(false)
    expect(isLocale(null)).toBe(false)
  })

  it('resolves a regional locale to its base', () => {
    expect(resolveLocale('de-AT')).toBe('de')
    expect(resolveLocale('en-GB')).toBe('en')
  })

  it('matches an exact locale', () => {
    expect(resolveLocale('de')).toBe('de')
  })

  it('falls back for an unsupported locale', () => {
    expect(resolveLocale('fr-FR')).toBe(DEFAULT_LOCALE)
  })

  it('falls back for a missing locale', () => {
    expect(resolveLocale(undefined)).toBe(DEFAULT_LOCALE)
    expect(resolveLocale('')).toBe(DEFAULT_LOCALE)
  })

  it('is case-insensitive', () => {
    expect(resolveLocale('DE-CH')).toBe('de')
  })

  it('returns a message with no placeholders unchanged', () => {
    // `app.name` used to stand in for this and is now the worst possible choice: it *is* a
    // placeholder. A message that never had one is what the assertion was about.
    expect(translate('en', 'toolbar.back')).toBe(catalogs.en['toolbar.back'])
  })

  it('fills the product name without any caller passing it', () => {
    // The product name lives in one place (`shared/product.ts`) and reaches a dozen translated
    // sentences through `{app}`. If a caller had to supply it, every one of those call sites
    // would be a place to forget it — and the rename would be a search through prose again.
    expect(translate('en', 'app.name')).toBe(PRODUCT_NAME)
    expect(translate('de', 'menu.help.about')).toBe(`Über ${PRODUCT_NAME}`)
  })

  it('substitutes several parameters', () => {
    expect(translate('en', 'start.folderLabel', { name: 'Work', count: 3 })).toBe(
      'Folder Work, 3 items'
    )
  })
})

describe('request pipeline installation', () => {
  /**
   * A session-shaped stand-in.
   *
   * `installRequestPipeline` cannot be reached with a real Electron session in a
   * unit test, but everything worth checking about it — that it registers exactly
   * once, that the stage order is asserted at install time, that a block reaches
   * the hook, and that disposal clears the listener — is observable through this.
   */
  function fakeSession() {
    const registrations: Array<((details: unknown, callback: (r: unknown) => void) => void) | null> = []
    return {
      registrations,
      session: {
        webRequest: {
          onBeforeRequest(listener: unknown) {
            registrations.push(
              listener as ((details: unknown, callback: (r: unknown) => void) => void) | null
            )
          }
        }
      }
    }
  }

  function install(overrides: { onBlocked?: (url: string | null, reason: StageId) => void } = {}) {
    const fake = fakeSession()
    const dispose = installRequestPipeline({
      // The fake only needs the surface the installer touches.
      session: fake.session as never,
      getSettings: () => defaultSettings(),
      filterEngine: null,
      hooks: overrides.onBlocked === undefined ? {} : { onBlocked: overrides.onBlocked }
    })
    const listener = fake.registrations[0]
    if (listener === null || listener === undefined) throw new Error('no listener registered')
    return { fake, dispose, listener }
  }

  it('registers exactly one listener', () => {
    const { fake } = install()
    expect(fake.registrations).toHaveLength(1)
  })

  it('cancels a blocked request', () => {
    const { listener } = install()
    const result = vi.fn()
    listener({ url: 'https://safebrowsing.googleapis.com/x', resourceType: 'xhr', method: 'GET' }, result)
    expect(result).toHaveBeenCalledWith({ cancel: true })
  })

  it('reports a block to the hook so the badge count is real', () => {
    const onBlocked = vi.fn()
    const { listener } = install({ onBlocked })
    listener(
      {
        url: 'https://safebrowsing.googleapis.com/x',
        resourceType: 'xhr',
        method: 'GET',
        frame: { url: 'https://example.com/' }
      },
      () => {}
    )
    expect(onBlocked).toHaveBeenCalledWith('https://example.com/', 'telemetry')
  })

  it('redirects when a stage rewrites the URL', () => {
    const { listener } = install()
    const result = vi.fn()
    listener(
      { url: 'https://example.com/a?utm_source=x', resourceType: 'mainFrame', method: 'GET' },
      result
    )
    expect(result).toHaveBeenCalledWith({ redirectURL: 'https://example.com/a' })
  })

  it('passes an ordinary request through untouched', () => {
    const { listener } = install()
    const result = vi.fn()
    listener({ url: 'https://example.com/', resourceType: 'mainFrame', method: 'GET' }, result)
    expect(result).toHaveBeenCalledWith({})
  })

  it('tolerates a request with no owning frame', () => {
    const { listener } = install()
    const result = vi.fn()
    expect(() =>
      listener({ url: 'https://example.com/', resourceType: 'image', method: 'GET' }, result)
    ).not.toThrow()
  })

  it('clears the listener on disposal', () => {
    // A private session's filtering has to be removable with its window.
    const { fake, dispose } = install()
    dispose()
    expect(fake.registrations).toHaveLength(2)
    expect(fake.registrations[1]).toBeNull()
  })

  it('survives having no hooks at all', () => {
    const fake = fakeSession()
    const dispose = installRequestPipeline({
      session: fake.session as never,
      getSettings: () => defaultSettings()
    })
    const listener = fake.registrations[0]
    expect(listener).toBeTypeOf('function')
    expect(() =>
      listener?.({ url: 'https://safebrowsing.googleapis.com/x', resourceType: 'xhr', method: 'GET' }, () => {})
    ).not.toThrow()
    dispose()
  })
})
