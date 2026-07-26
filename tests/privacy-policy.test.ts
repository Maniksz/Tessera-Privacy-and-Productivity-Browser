import { describe, expect, it } from 'vitest'
import {
  ALWAYS_ALLOWED,
  ALWAYS_DENIED,
  PERMISSION_SETTINGS,
  decideMediaPermission,
  decidePermission,
  requestOrigin,
  toDecision
} from '@main/session/permission-policy.js'
import {
  UNIFORM_IDENTITY,
  applyReferrerPolicy,
  filterResponseHeaders,
  findHeader,
  isSameSite,
  normalizeRequestHeaders
} from '@main/session/headers.js'
import { classifySender, decideAccess, internalPageOf, isInternalPageUrl } from '@main/ipc/sender-policy.js'
import {
  INTERNAL_PAGES,
  INTERNAL_PAGE_INVOKE_CHANNELS,
  INVOKE_CHANNELS
} from '@shared/ipc/channels.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * Permission decisions, header transforms and the IPC sender policy.
 *
 * These are the three places where a mistake is a security hole rather than a bug,
 * so they are covered exhaustively rather than representatively.
 */

function withSettings(patch: Partial<SettingsSnapshot>): SettingsSnapshot {
  return { ...defaultSettings(), ...patch }
}

describe('decidePermission', () => {
  it('denies everything a page can ask for, by default', () => {
    const settings = defaultSettings()
    for (const permission of Object.keys(PERMISSION_SETTINGS)) {
      expect(decidePermission(permission, settings), permission).toBe('deny')
    }
  })

  it('denies device buses and sensors regardless of settings', () => {
    // Every settings key set to allow, to prove these do not consult settings.
    const permissive = Object.fromEntries(
      Object.entries(defaultSettings()).map(([key, value]) => [
        key,
        key.startsWith('permissions.') ? 'allow' : value
      ])
    ) as SettingsSnapshot

    for (const permission of ALWAYS_DENIED) {
      expect(decidePermission(permission, permissive), permission).toBe('deny')
    }
  })

  it('allows the UI affordances without prompting', () => {
    for (const permission of ALWAYS_ALLOWED) {
      expect(decidePermission(permission, defaultSettings()), permission).toBe('allow')
    }
  })

  it('allows fullscreen, which tile fullscreen depends on', () => {
    // Denying this would break the browser's central feature for no privacy gain.
    expect(decidePermission('fullscreen', defaultSettings())).toBe('allow')
  })

  it('denies a permission it has never heard of', () => {
    // New Chromium releases add permissions; the default for anything unreasoned
    // about must be no, or a version bump silently widens what pages can do.
    expect(decidePermission('some-future-capability', defaultSettings())).toBe('deny')
  })

  it('honours an allow', () => {
    expect(
      decidePermission('geolocation', withSettings({ 'permissions.geolocation': 'allow' }))
    ).toBe('allow')
  })

  it('honours an ask', () => {
    expect(decidePermission('notifications', withSettings({ 'permissions.notifications': 'ask' }))).toBe(
      'ask'
    )
  })

  it('maps both clipboard permissions to one setting', () => {
    const settings = withSettings({ 'permissions.clipboard': 'allow' })
    expect(decidePermission('clipboard-read', settings)).toBe('allow')
    expect(decidePermission('clipboard-sanitized-write', settings)).toBe('allow')
  })

  it('maps both midi permissions to one setting', () => {
    const settings = withSettings({ 'permissions.midi': 'allow' })
    expect(decidePermission('midi', settings)).toBe('allow')
    expect(decidePermission('midiSysex', settings)).toBe('allow')
  })
})

describe('toDecision', () => {
  it('recognises the three values', () => {
    expect(toDecision('allow')).toBe('allow')
    expect(toDecision('ask')).toBe('ask')
    expect(toDecision('deny')).toBe('deny')
  })

  it('treats anything unexpected as a denial', () => {
    expect(toDecision(undefined)).toBe('deny')
    expect(toDecision(null)).toBe('deny')
    expect(toDecision('maybe')).toBe('deny')
    expect(toDecision(true)).toBe('deny')
  })
})

describe('decideMediaPermission', () => {
  const allowBoth = withSettings({
    'permissions.camera': 'allow',
    'permissions.microphone': 'allow'
  })

  it('allows a camera request when the camera is allowed', () => {
    expect(decideMediaPermission(['video'], allowBoth)).toBe('allow')
  })

  it('allows both when both are allowed', () => {
    expect(decideMediaPermission(['video', 'audio'], allowBoth)).toBe('allow')
  })

  it('denies the pair when either half is denied', () => {
    // Granting a microphone the user never agreed to, because the camera was
    // allowed, is exactly the mistake this guards against.
    const cameraOnly = withSettings({
      'permissions.camera': 'allow',
      'permissions.microphone': 'deny'
    })
    expect(decideMediaPermission(['video', 'audio'], cameraOnly)).toBe('deny')
  })

  it('asks when one half asks and neither denies', () => {
    const mixed = withSettings({
      'permissions.camera': 'allow',
      'permissions.microphone': 'ask'
    })
    expect(decideMediaPermission(['video', 'audio'], mixed)).toBe('ask')
  })

  it('prefers denial over asking', () => {
    const mixed = withSettings({
      'permissions.camera': 'ask',
      'permissions.microphone': 'deny'
    })
    expect(decideMediaPermission(['video', 'audio'], mixed)).toBe('deny')
  })

  it('denies a media request that names neither', () => {
    expect(decideMediaPermission([], allowBoth)).toBe('deny')
  })

  it('ignores a media type it does not know', () => {
    expect(decideMediaPermission(['hologram'], allowBoth)).toBe('deny')
  })
})

describe('requestOrigin', () => {
  it('prefers the requesting URL', () => {
    expect(requestOrigin('https://a.example/page', 'https://b.example/')).toBe('https://a.example')
  })

  it('falls back to the sender URL', () => {
    expect(requestOrigin(null, 'https://b.example/page')).toBe('https://b.example')
  })

  it('skips an empty requesting URL', () => {
    expect(requestOrigin('', 'https://b.example/page')).toBe('https://b.example')
  })

  it('skips an unparseable candidate', () => {
    expect(requestOrigin('not a url', 'https://b.example/')).toBe('https://b.example')
  })

  it('returns null rather than something misleading', () => {
    expect(requestOrigin(null, null)).toBeNull()
    expect(requestOrigin('not a url', 'also not a url')).toBeNull()
  })
})

describe('normalizeRequestHeaders', () => {
  const base = { 'User-Agent': 'x' }

  it('sends DNT and GPC by default', () => {
    const headers = normalizeRequestHeaders(base, 'https://example.com/', defaultSettings())
    expect(findHeader(headers, 'DNT')).toBe('1')
    expect(findHeader(headers, 'Sec-GPC')).toBe('1')
  })

  it('omits DNT when the setting is off', () => {
    const headers = normalizeRequestHeaders(
      base,
      'https://example.com/',
      withSettings({ 'privacy.sendDoNotTrack': false })
    )
    expect(findHeader(headers, 'DNT')).toBeUndefined()
  })

  it('omits GPC when the setting is off', () => {
    const headers = normalizeRequestHeaders(
      base,
      'https://example.com/',
      withSettings({ 'privacy.sendGlobalPrivacyControl': false })
    )
    expect(findHeader(headers, 'Sec-GPC')).toBeUndefined()
  })

  it('normalises the language header so it discloses no region', () => {
    const headers = normalizeRequestHeaders(
      { ...base, 'Accept-Language': 'de-AT,de;q=0.9' },
      'https://example.com/',
      defaultSettings()
    )
    expect(findHeader(headers, 'Accept-Language')).toBe(UNIFORM_IDENTITY.acceptLanguage)
  })

  it('leaves the language header alone when that normalisation is off', () => {
    const headers = normalizeRequestHeaders(
      { ...base, 'Accept-Language': 'de-AT,de;q=0.9' },
      'https://example.com/',
      withSettings({ 'fingerprint.normalizeAcceptLanguage': false })
    )
    expect(findHeader(headers, 'Accept-Language')).toBe('de-AT,de;q=0.9')
  })

  it('reports one consistent system across every client hint', () => {
    // Spec 4: a masked user agent beside hints that leak the real OS is a stronger
    // identifier than no masking, because the contradiction itself is distinctive.
    const headers = normalizeRequestHeaders(base, 'https://example.com/', defaultSettings())
    expect(findHeader(headers, 'Sec-CH-UA-Platform')).toBe(UNIFORM_IDENTITY.platform)
    expect(findHeader(headers, 'Sec-CH-UA-Platform-Version')).toBe(UNIFORM_IDENTITY.platformVersion)
    expect(findHeader(headers, 'Sec-CH-UA-Arch')).toBe(UNIFORM_IDENTITY.arch)
    expect(findHeader(headers, 'Sec-CH-UA-Bitness')).toBe(UNIFORM_IDENTITY.bitness)
    expect(findHeader(headers, 'Sec-CH-UA-Model')).toBe(UNIFORM_IDENTITY.model)
  })

  it('removes the full version hints, which pin an exact build', () => {
    const headers = normalizeRequestHeaders(
      {
        ...base,
        'Sec-CH-UA-Full-Version': '"150.0.7871.129"',
        'Sec-CH-UA-Full-Version-List': '"Chromium";v="150.0.7871.129"'
      },
      'https://example.com/',
      defaultSettings()
    )
    expect(findHeader(headers, 'Sec-CH-UA-Full-Version')).toBeUndefined()
    expect(findHeader(headers, 'Sec-CH-UA-Full-Version-List')).toBeUndefined()
  })

  it('leaves client hints alone when that normalisation is off', () => {
    const headers = normalizeRequestHeaders(
      { ...base, 'Sec-CH-UA-Platform': '"macOS"' },
      'https://example.com/',
      withSettings({ 'fingerprint.normalizeClientHints': false })
    )
    expect(findHeader(headers, 'Sec-CH-UA-Platform')).toBe('"macOS"')
  })

  it('does not mutate the headers it was given', () => {
    const original = { ...base }
    normalizeRequestHeaders(original, 'https://example.com/', defaultSettings())
    expect(original).toEqual(base)
  })
})

describe('applyReferrerPolicy', () => {
  const referrer = 'https://source.example/secret/page?q=1'

  it('trims a cross-site referrer to its origin', () => {
    const headers = applyReferrerPolicy({ Referer: referrer }, 'https://other.example/x', 'origin-only')
    expect(findHeader(headers, 'Referer')).toBe('https://source.example/')
  })

  it('leaves a same-site referrer intact', () => {
    const headers = applyReferrerPolicy(
      { Referer: referrer },
      'https://www.source.example/x',
      'origin-only'
    )
    expect(findHeader(headers, 'Referer')).toBe(referrer)
  })

  it('drops the referrer entirely under the strict policy', () => {
    const headers = applyReferrerPolicy(
      { Referer: referrer },
      'https://www.source.example/x',
      'strict'
    )
    expect(findHeader(headers, 'Referer')).toBeUndefined()
  })

  it('drops the referrer on a downgrade to plain HTTP', () => {
    // Sending it over an unencrypted hop discloses the source page to the path.
    const headers = applyReferrerPolicy({ Referer: referrer }, 'http://other.example/x', 'origin-only')
    expect(findHeader(headers, 'Referer')).toBeUndefined()
  })

  it('leaves everything alone under the default policy', () => {
    const headers = applyReferrerPolicy({ Referer: referrer }, 'https://other.example/x', 'default')
    expect(findHeader(headers, 'Referer')).toBe(referrer)
  })

  it('does nothing when there is no referrer', () => {
    expect(applyReferrerPolicy({ 'User-Agent': 'x' }, 'https://a.example/', 'strict')).toEqual({
      'User-Agent': 'x'
    })
  })

  it('ignores an empty referrer', () => {
    const headers = applyReferrerPolicy({ Referer: '' }, 'https://a.example/', 'origin-only')
    expect(findHeader(headers, 'Referer')).toBe('')
  })

  it('drops an unparseable referrer rather than forwarding it', () => {
    const headers = applyReferrerPolicy({ Referer: 'nonsense' }, 'https://a.example/', 'origin-only')
    expect(findHeader(headers, 'Referer')).toBeUndefined()
  })

  it('matches the header name whatever its casing', () => {
    const headers = applyReferrerPolicy({ referer: referrer }, 'https://other.example/', 'strict')
    expect(findHeader(headers, 'Referer')).toBeUndefined()
  })
})

describe('filterResponseHeaders', () => {
  const settings = defaultSettings()

  it('strips Set-Cookie from a cross-site response', () => {
    const headers = filterResponseHeaders(
      { 'Set-Cookie': 'id=1', 'Content-Type': 'text/html' },
      { documentUrl: 'https://example.com/', requestUrl: 'https://tracker.example/pixel' },
      settings
    )
    expect(findHeader(headers, 'set-cookie')).toBeUndefined()
    expect(findHeader(headers, 'Content-Type')).toBe('text/html')
  })

  it('keeps first-party cookies across subdomains', () => {
    const headers = filterResponseHeaders(
      { 'Set-Cookie': 'id=1' },
      { documentUrl: 'https://www.example.com/', requestUrl: 'https://api.example.com/x' },
      settings
    )
    expect(findHeader(headers, 'set-cookie')).toBe('id=1')
  })

  it('keeps cookies when third-party blocking is off', () => {
    const headers = filterResponseHeaders(
      { 'Set-Cookie': 'id=1' },
      { documentUrl: 'https://example.com/', requestUrl: 'https://tracker.example/x' },
      withSettings({ 'privacy.blockThirdPartyCookies': false })
    )
    expect(findHeader(headers, 'set-cookie')).toBe('id=1')
  })

  it('leaves a response with no known document alone', () => {
    const headers = filterResponseHeaders(
      { 'Set-Cookie': 'id=1' },
      { documentUrl: null, requestUrl: 'https://tracker.example/x' },
      settings
    )
    expect(findHeader(headers, 'set-cookie')).toBe('id=1')
  })

  it('matches Set-Cookie whatever its casing', () => {
    const headers = filterResponseHeaders(
      { 'set-cookie': 'id=1' },
      { documentUrl: 'https://example.com/', requestUrl: 'https://tracker.example/x' },
      settings
    )
    expect(findHeader(headers, 'set-cookie')).toBeUndefined()
  })
})

describe('isSameSite', () => {
  it('matches across subdomains', () => {
    expect(isSameSite('https://a.example.com/', 'https://b.example.com/')).toBe(true)
  })

  it('separates different registrable domains', () => {
    expect(isSameSite('https://example.com/', 'https://example.org/')).toBe(false)
  })

  it('separates two different .co.uk registrations', () => {
    expect(isSameSite('https://bbc.co.uk/', 'https://evil.co.uk/')).toBe(false)
  })

  it('treats unparseable provenance as cross-site', () => {
    // The stricter reading is the one that cannot leak.
    expect(isSameSite('not a url', 'https://example.com/')).toBe(false)
  })
})

describe('findHeader', () => {
  it('is case-insensitive', () => {
    expect(findHeader({ 'CoNtEnT-tYpE': 'text/html' }, 'content-type')).toBe('text/html')
  })

  it('returns undefined for a missing header', () => {
    expect(findHeader({}, 'x')).toBeUndefined()
  })
})

describe('isInternalPageUrl', () => {
  it('accepts an internal page', () => {
    expect(isInternalPageUrl('tessera://start')).toBe(true)
    expect(isInternalPageUrl('tessera://start/assets/x.js')).toBe(true)
  })

  it('rejects a web page', () => {
    expect(isInternalPageUrl('https://example.com/')).toBe(false)
  })

  it('is not fooled by a crafted address', () => {
    // A prefix check would pass some of these; parsing does not.
    expect(isInternalPageUrl('https://evil.example/#tessera://start')).toBe(false)
    expect(isInternalPageUrl('https://tessera.example/')).toBe(false)
    expect(isInternalPageUrl('tessera.example://start')).toBe(false)
  })

  it('tolerates surrounding whitespace, as the URL parser does', () => {
    // The WHATWG parser strips leading and trailing spaces, so this is genuinely
    // the same URL. It is not a hole either: the value comes from Electron's
    // `senderFrame.url`, which is already normalised — never from user input.
    expect(isInternalPageUrl('  tessera://start  ')).toBe(true)
  })

  it('rejects unparseable input', () => {
    expect(isInternalPageUrl('')).toBe(false)
    expect(isInternalPageUrl('nonsense')).toBe(false)
  })
})

describe('classifySender', () => {
  it('recognises the chrome UI by identity, not by URL', () => {
    // In development the chrome UI is served over http; a URL rule loose enough to
    // accept that would accept a web page too.
    expect(
      classifySender({ frameUrl: 'http://localhost:5173/index.html', isChromeRenderer: true })
    ).toBe('chrome')
  })

  it('recognises an internal page', () => {
    expect(classifySender({ frameUrl: 'tessera://start', isChromeRenderer: false })).toBe(
      'internal-page'
    )
  })

  it('treats everything else as web content', () => {
    expect(classifySender({ frameUrl: 'https://example.com/', isChromeRenderer: false })).toBe(
      'web-content'
    )
    expect(classifySender({ frameUrl: null, isChromeRenderer: false })).toBe('web-content')
  })
})

describe('internalPageOf', () => {
  /*
    Exercised directly, not only through `decideAccess`.

    It is exported because the protocol handler and the privilege check both need to answer "which
    page is this address", and its contract includes answers `decideAccess` can never ask for — a
    null URL, an unparseable one. Reaching them through the caller is impossible, so a reader would
    conclude those lines are dead. They are not; they are simply this function's own edges.
  */
  it('names a page from its address', () => {
    expect(internalPageOf('tessera://settings')).toBe('settings')
    expect(internalPageOf('tessera://history/')).toBe('history')
  })

  it('reads the bare address as the start page', () => {
    // What the protocol handler serves for it; the two have to agree.
    expect(internalPageOf('tessera://')).toBe('start')
  })

  it('is case-insensitive about the host', () => {
    expect(internalPageOf('tessera://SETTINGS')).toBe('settings')
  })

  it('refuses an address that is not a page', () => {
    expect(internalPageOf('tessera://favicon')).toBeNull()
    expect(internalPageOf('tessera://nope')).toBeNull()
  })

  it('refuses another scheme, however it is dressed up', () => {
    expect(internalPageOf('https://evil.example/#tessera://settings')).toBeNull()
    expect(internalPageOf('tessera-evil://settings')).toBeNull()
  })

  it('refuses an absent address', () => {
    // The frame URL is unknown for a renderer that has not committed a navigation yet.
    expect(internalPageOf(null)).toBeNull()
  })

  it('refuses an address that cannot be parsed at all', () => {
    // `new URL` throws here rather than returning something odd, and a thrown error inside a
    // privilege check must resolve to "no privileges", never to a crash that skips the check.
    expect(internalPageOf('tessera://[')).toBeNull()
    expect(internalPageOf('not a url')).toBeNull()
    expect(internalPageOf('')).toBeNull()
  })
})

describe('decideAccess', () => {
  const chrome = { frameUrl: 'file:///app/index.html', isChromeRenderer: true }
  const web = { frameUrl: 'https://evil.example/', isChromeRenderer: false }
  const asPage = (page: string) => ({ frameUrl: `tessera://${page}`, isChromeRenderer: false })

  it('lets the chrome UI use every channel', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(decideAccess(channel, chrome).allowed, channel).toBe(true)
    }
  })

  it('lets each internal page use exactly its own channels and nothing else', () => {
    /*
      The whole contract of the per-page model, in one sweep: for every page, every channel in the
      contract is either granted to *that* page or refused to it. A channel another page has is,
      from here, indistinguishable from one nobody has — which is the property that makes the
      model worth having.
    */
    for (const page of INTERNAL_PAGES) {
      const granted = INTERNAL_PAGE_INVOKE_CHANNELS[page] as readonly string[]
      const sender = asPage(page)
      for (const channel of INVOKE_CHANNELS) {
        expect(decideAccess(channel, sender).allowed, `${page}: ${channel}`).toBe(
          granted.includes(channel)
        )
      }
    }
  })

  it('refuses everything to an internal address that is not a page', () => {
    // `tessera://favicon` serves bytes and `tessera://nope` is nothing at all. Neither may
    // become a bridge just by having the right scheme.
    for (const host of ['favicon', 'nope', 'https-only']) {
      for (const channel of INVOKE_CHANNELS) {
        expect(decideAccess(channel, asPage(host)).allowed, `${host}: ${channel}`).toBe(false)
      }
    }
  })

  it('serves the bare internal address as the start page, not as nothing', () => {
    // `tessera://` is what the protocol handler resolves to the start page. If the privilege
    // check disagreed, that address would load a start page with no bridge and fail silently.
    const bare = { frameUrl: 'tessera://', isChromeRenderer: false }
    expect(decideAccess('quicklinks:list', bare).allowed).toBe(true)
    expect(decideAccess('settings:set', bare).allowed).toBe(false)
  })

  it('is not fooled by a web address that mentions an internal page', () => {
    // `startsWith` would hand a visited site the settings channels.
    for (const url of [
      'https://evil.example/#tessera://settings',
      'https://evil.example/?u=tessera://settings',
      'tessera://x@evil.example'
    ]) {
      expect(
        decideAccess('settings:set', { frameUrl: url, isChromeRenderer: false }).allowed,
        url
      ).toBe(false)
    }
  })

  it('refuses web content every channel there is', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(decideAccess(channel, web).allowed, channel).toBe(false)
    }
  })

  it('refuses a channel name that does not exist', () => {
    expect(decideAccess('made:up', asPage('start')).allowed).toBe(false)
    expect(decideAccess('made:up', web).allowed).toBe(false)
  })

  it('names both the page and the channel in a refusal', () => {
    // The reason reaches the caller as a thrown error, so it is the only clue anyone gets when a
    // page is missing a permission it ought to have. "internal page may not call X" left out the
    // one detail that now matters.
    expect(decideAccess('settings:set', web).reason).toContain('web content')
    const refusal = decideAccess('settings:set', asPage('start')).reason ?? ''
    expect(refusal).toContain('start')
    expect(refusal).toContain('settings:set')
  })

  it('gives no reason when the call is allowed', () => {
    expect(decideAccess('settings:set', chrome).reason).toBeNull()
  })
})
