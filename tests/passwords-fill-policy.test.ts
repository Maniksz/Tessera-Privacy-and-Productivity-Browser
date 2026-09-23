import { describe, expect, it } from 'vitest'
import { FILL_GESTURE_WINDOW_MS, type FillConsent } from '@shared/passwords/consent.js'
import {
  decideFill,
  decideOffer,
  decidePageFill,
  fillableSubjects,
  offerableSubjects,
  originMayReceiveCredentials,
  type FillContext,
  type FillRefusal
} from '@shared/passwords/fill-policy.js'

/**
 * When a saved password may be put into a page.
 *
 * Every test here is named after the attack it prevents, because that is the only way to read this
 * file and tell whether a rule is still doing its job. A test called "refuses a cross-origin action"
 * says what the code does; one called "a form whose action was rewritten to another origin does not
 * receive the credential" says why anybody should care if it stops passing.
 *
 * The rules under test, and the shape of each attack:
 *
 *   1. `no-user-gesture`        — a hidden form harvesting a credential on page load, and a consent
 *                                 from browser chrome replayed after it was spent.
 *   2. `no-password-field`      — a username dropped into a search box, and an existing password
 *                                 pre-filled into a "choose a new password" field.
 *   3. `unsupported-scheme`     — a `file:` or `data:` document asking for a site's credential.
 *   4. `insecure-page`          — a plain-http page, where the value leaves in clear text.
 *   5. `scheme-downgrade`       — an https credential put into an http page on the same host.
 *   6. `different-site`         — `example.com.evil.com`, and `evil.co.uk` against `bbc.co.uk`.
 *   7. `cross-origin-frame`     — the genuine login page framed by somebody else's document.
 *   8. `cross-origin-form-action` — a real login page whose form was made to post elsewhere.
 *
 * And two properties that are not rules but hold the rules together: the offer list cannot be wider
 * than what a fill would authorise, and a decision is made again at fill time rather than banked.
 */

const NOW = 1_700_000_000_000

/**
 * The context of a fill that *would* be allowed.
 *
 * Every test below spoils exactly one thing about it. That is deliberate: a fixture that already
 * failed for a second reason would pass this suite while the rule under test did nothing.
 */
function goodContext(overrides: Partial<FillContext> = {}): FillContext {
  return {
    frameUrl: 'https://accounts.example.com/login',
    topLevelUrl: 'https://accounts.example.com/login',
    isTopLevelFrame: true,
    formAction: '/session',
    consent: pressedAt(NOW - 100),
    openRequestId: null,
    now: NOW,
    hasFillablePasswordField: true,
    ...overrides
  }
}

/** Consent as the core mints it after seeing a real input event in the page view. */
function pressedAt(at: number): FillConsent {
  return { source: 'page-input', at }
}

/** Consent as the core mints it for a fill the user asked for from browser chrome. */
function askedFromChrome(requestId: string): FillConsent {
  return { source: 'chrome-action', requestId }
}

const SUBJECT = { origin: 'https://example.com' }

function refusalFor(overrides: Partial<FillContext>, subject = SUBJECT): FillRefusal | 'allowed' {
  const decision = decideFill(goodContext(overrides), subject)
  return decision.allowed ? 'allowed' : decision.reason
}

describe('the baseline', () => {
  it('fills a saved credential into its own site over https after a click', () => {
    expect(decideFill(goodContext(), SUBJECT)).toEqual({ allowed: true })
  })

  it('fills a subdomain from a credential saved on the registrable domain', () => {
    // What users mean by "the same site", and what makes the manager usable: a login that lives on
    // `accounts.` must get the credential saved for `example.com`.
    expect(
      refusalFor({
        frameUrl: 'https://login.example.com/x',
        topLevelUrl: 'https://login.example.com/x'
      })
    ).toBe('allowed')
  })
})

describe('a hidden form must not be able to harvest a credential', () => {
  it('refuses a fill with no consent of any kind', () => {
    // The attack: a page appends an off-screen login form on load and submits it. With fill-on-load
    // the password is on the attacker's server before the user has done anything but visit.
    expect(refusalFor({ consent: null })).toBe('no-user-gesture')
  })

  it('refuses a fill with no consent even where a chrome request could have supplied one', () => {
    /*
      Deliberately asserted with an open request in the context. The two are separate fields — the
      consent, and what the core still holds open — and an implementation that read the second as
      consent in its own right would turn `no-user-gesture` off for the whole tab. AE3: a page that
      focuses a field and clicks our own badge programmatically gets nothing.
    */
    expect(refusalFor({ consent: null, openRequestId: 'fill-1' })).toBe('no-user-gesture')
  })

  it('refuses a gesture the page banked and spent later', () => {
    // A click a minute ago is not consent to a form the user has not touched since.
    expect(refusalFor({ consent: pressedAt(NOW - FILL_GESTURE_WINDOW_MS - 1) })).toBe(
      'no-user-gesture'
    )
  })

  it('accepts a gesture at the very edge of the window', () => {
    expect(refusalFor({ consent: pressedAt(NOW - FILL_GESTURE_WINDOW_MS) })).toBe('allowed')
  })

  it('refuses a gesture timestamp in the future, so a moved clock cannot open the window for ever', () => {
    // An NTP correction or a resumed laptop is enough to produce this, and treating it as a gesture
    // would make the window unbounded rather than five seconds wide.
    expect(refusalFor({ consent: pressedAt(NOW + 1) })).toBe('no-user-gesture')
  })
})

describe('a fill the user asked for from browser chrome', () => {
  it('is allowed with no page-view input behind it at all', () => {
    /*
      AE5. A toolbar press, a shortcut or a context-menu item happens in a view the page cannot reach
      and never touches the page's input pipeline, so it can produce no `input-event` in the tab.
      Its proof is where it came from, and the core says so by opening a request for it.
    */
    expect(refusalFor({ consent: askedFromChrome('fill-1'), openRequestId: 'fill-1' })).toBe(
      'allowed'
    )
  })

  it('refuses a consent for a request the core no longer holds open', () => {
    /*
      AE8, and the whole reason the request id travels with the consent. The request is closed by the
      first fill it authorises, by the surface leaving the layer, by a navigation, by a lock and by
      the view going away — and after any of those the same value must buy nothing. Without this the
      consent would be permanent for the tab, and a hidden form could be filled minutes later by a
      page that simply waited.
    */
    expect(refusalFor({ consent: askedFromChrome('fill-1'), openRequestId: null })).toBe(
      'no-user-gesture'
    )
  })

  it('refuses a consent whose request id is not the one that is open', () => {
    // The shape a replay takes when a second request has since been opened: the value is well formed
    // and names a request that existed. It is not the one the user is being asked about now.
    expect(refusalFor({ consent: askedFromChrome('fill-1'), openRequestId: 'fill-2' })).toBe(
      'no-user-gesture'
    )
  })

  it('is refused by every other rule exactly as a page gesture is', () => {
    /*
      The property the whole change rests on: one consent input, and not a second path. A fill from
      the toolbar carries no permission to ignore the frame, the site, the scheme or the form's
      action — R11 says so in words, and here it is in the only place it can be checked once.
    */
    const fromChrome: Partial<FillContext> = {
      consent: askedFromChrome('fill-1'),
      openRequestId: 'fill-1'
    }
    expect(refusalFor({ ...fromChrome, isTopLevelFrame: false })).toBe('cross-origin-frame')
    expect(refusalFor({ ...fromChrome, formAction: 'https://evil.example/collect' })).toBe(
      'cross-origin-form-action'
    )
    expect(
      refusalFor({
        ...fromChrome,
        frameUrl: 'http://example.com/login',
        topLevelUrl: 'http://example.com/login'
      })
    ).toBe('insecure-page')
    expect(
      refusalFor({
        ...fromChrome,
        frameUrl: 'https://evil.example/login',
        topLevelUrl: 'https://evil.example/login'
      })
    ).toBe('different-site')
    expect(refusalFor({ ...fromChrome, hasFillablePasswordField: false })).toBe('no-password-field')
  })
})

describe('a form that is not a sign-in form gets nothing', () => {
  it('refuses a form with no fillable password field', () => {
    // Without this, any page with a text input is a page the manager offers credentials on — and a
    // username silently dropped into a search box is submitted to the site with the query.
    expect(refusalFor({ hasFillablePasswordField: false })).toBe('no-password-field')
  })
})

describe('a document with no site cannot be handed a site credential', () => {
  it('refuses a file: document', () => {
    // A local file has no origin that means "example.com", so a credential put there is a credential
    // handed to whoever wrote the file.
    expect(
      refusalFor({ frameUrl: 'file:///tmp/login.html', topLevelUrl: 'file:///tmp/login.html' })
    ).toBe('unsupported-scheme')
  })

  it('refuses a data: document', () => {
    expect(
      refusalFor({ frameUrl: 'data:text/html,<form>', topLevelUrl: 'data:text/html,<form>' })
    ).toBe('unsupported-scheme')
  })

  it("refuses the browser's own internal pages", () => {
    expect(refusalFor({ frameUrl: 'tessera://start', topLevelUrl: 'tessera://start' })).toBe(
      'unsupported-scheme'
    )
  })

  it('refuses an address it cannot parse', () => {
    expect(refusalFor({ frameUrl: 'not a url', topLevelUrl: 'not a url' })).toBe(
      'unsupported-scheme'
    )
  })

  it('refuses a credential whose stored origin is not usable', () => {
    // A hand-edited or migrated document could hold one. It stays visible on the passwords page —
    // `repairPasswords` deliberately does not delete it — so the refusal has to happen here.
    expect(refusalFor({}, { origin: 'file:///home/user' })).toBe('unsupported-scheme')
  })
})

describe('a network attacker on an unencrypted connection gets nothing', () => {
  it('refuses a plain-http page even when the host is exactly right', () => {
    /*
      The attack, and it has shipped: on a café network the attacker answers
      `http://example.com/login` with their own page. The host matches — that is the *point*, the
      attacker chose it — so a rule that only compared hosts would fill, and the password would leave
      in clear text.
    */
    expect(
      refusalFor({ frameUrl: 'http://example.com/login', topLevelUrl: 'http://example.com/login' })
    ).toBe('insecure-page')
  })

  it('allows http on loopback, where there is no wire to listen on', () => {
    const decision = decideFill(
      goodContext({
        frameUrl: 'http://localhost:3000/login',
        topLevelUrl: 'http://localhost:3000/login'
      }),
      { origin: 'http://localhost:3000' }
    )
    expect(decision).toEqual({ allowed: true })
  })

  it('allows http on the whole 127.0.0.0/8 range, not only 127.0.0.1', () => {
    const decision = decideFill(
      goodContext({
        frameUrl: 'http://127.0.0.2:8080/login',
        topLevelUrl: 'http://127.0.0.2:8080/login'
      }),
      { origin: 'http://127.0.0.2:8080' }
    )
    expect(decision).toEqual({ allowed: true })
  })

  it('allows http on a *.localhost name, which cannot be registered by anybody', () => {
    const decision = decideFill(
      goodContext({
        frameUrl: 'http://api.localhost/login',
        topLevelUrl: 'http://api.localhost/login'
      }),
      { origin: 'http://api.localhost' }
    )
    expect(decision).toEqual({ allowed: true })
  })

  it('does not mistake a registrable host ending in localhost-like text for loopback', () => {
    expect(
      refusalFor({
        frameUrl: 'http://notlocalhost.example/login',
        topLevelUrl: 'http://notlocalhost.example/login'
      })
    ).toBe('insecure-page')
  })
})

describe('a credential saved over https is never downgraded to http', () => {
  it('refuses an https credential on an http loopback page', () => {
    /*
      Reached only on loopback, because plain http elsewhere is already refused — and it still has to
      exist. `https://localhost:8443` and `http://localhost:8080` are two different applications on
      one machine as far as the browser is concerned, and the first one's password must not be handed
      to the second.
    */
    const decision = decideFill(
      goodContext({
        frameUrl: 'http://localhost:8080/login',
        topLevelUrl: 'http://localhost:8080/login'
      }),
      { origin: 'https://localhost:8443' }
    )
    expect(decision).toEqual({ allowed: false, reason: 'scheme-downgrade' })
  })

  it('allows an http credential to be filled on the https version of the same site — an upgrade', () => {
    // Refusing this would punish the user for the site having improved.
    const decision = decideFill(goodContext(), { origin: 'http://example.com' })
    expect(decision).toEqual({ allowed: true })
  })
})

describe('a look-alike domain gets nothing', () => {
  it('refuses example.com.evil.com, which a suffix match would accept', () => {
    // The oldest trick in the list. `registrableDomain` matches on whole labels, so the site here is
    // `evil.com` and not `example.com`.
    expect(
      refusalFor({
        frameUrl: 'https://example.com.evil.com/login',
        topLevelUrl: 'https://example.com.evil.com/login'
      })
    ).toBe('different-site')
  })

  it('refuses evil.co.uk against a credential saved for bbc.co.uk', () => {
    // Naive "last two labels" logic makes both of these `co.uk` and therefore the same party. This
    // is the case the public-suffix table exists for.
    const decision = decideFill(
      goodContext({
        frameUrl: 'https://evil.co.uk/login',
        topLevelUrl: 'https://evil.co.uk/login'
      }),
      { origin: 'https://bbc.co.uk' }
    )
    expect(decision).toEqual({ allowed: false, reason: 'different-site' })
  })

  it('refuses one github.io user page a credential saved on another', () => {
    // Hosting suffixes where each subdomain is a separate party. A rule that stopped at "two labels"
    // would treat every project page on the service as one site.
    const decision = decideFill(
      goodContext({
        frameUrl: 'https://attacker.github.io/login',
        topLevelUrl: 'https://attacker.github.io/login'
      }),
      { origin: 'https://victim.github.io' }
    )
    expect(decision).toEqual({ allowed: false, reason: 'different-site' })
  })

  it('refuses an unrelated site outright', () => {
    expect(
      refusalFor({
        frameUrl: 'https://evil.example/login',
        topLevelUrl: 'https://evil.example/login'
      })
    ).toBe('different-site')
  })
})

describe('a login page framed by somebody else gets nothing', () => {
  it("refuses a fill in a subframe, even when the subframe is the credential's own site", () => {
    /*
      The attack: `evil.example` embeds the genuine `https://accounts.example.com/login` in an
      iframe, sizes it to a pixel or lays something clickable over it, and waits. The framed document
      *is* the real site, so every origin check passes — and the user is looking at the attacker's
      page. Firefox filled cross-origin frames for years and this is what came of it.
    */
    expect(refusalFor({ isTopLevelFrame: false, topLevelUrl: 'https://evil.example/' })).toBe(
      'cross-origin-frame'
    )
  })

  it('refuses a subframe even when the embedding document is the same site', () => {
    // The stricter rule, on purpose: an exception for same-site frames is an exception somebody will
    // later widen, and a user can always open the sign-in page directly.
    expect(refusalFor({ isTopLevelFrame: false })).toBe('cross-origin-frame')
  })

  it('refuses a top-level claim that disagrees with the frame tree', () => {
    /*
      The second, independent reading. `isTopLevelFrame` is what the frame tree says and
      `topLevelUrl` is read from it separately; a frame claiming to be top-level while the top of the
      tree is another site is exactly the shape a confused or compromised renderer produces.
    */
    expect(refusalFor({ isTopLevelFrame: true, topLevelUrl: 'https://evil.example/' })).toBe(
      'cross-origin-frame'
    )
  })

  it('refuses when the top-level address cannot be read at all', () => {
    // A frame torn down mid-message. "Unknown" has to mean no, not "probably the same".
    expect(refusalFor({ topLevelUrl: null })).toBe('cross-origin-frame')
  })

  it('refuses when the top-level address is not parseable', () => {
    expect(refusalFor({ topLevelUrl: 'about:blank' })).toBe('cross-origin-frame')
  })
})

describe('a form made to post somewhere else gets nothing', () => {
  it('refuses an absolute action on another origin', () => {
    /*
      The attack: the page really is `https://accounts.example.com/login`, and a stored cross-site
      scripting flaw — or a third-party script on the page — has replaced the form's action with
      `https://evil.example/collect`. Site, scheme and frame all check out, and the fill hands the
      credential over on submit. Browsers added this rule after exactly that.
    */
    expect(refusalFor({ formAction: 'https://evil.example/collect' })).toBe(
      'cross-origin-form-action'
    )
  })

  it('refuses a protocol-relative action, which looks relative and is not', () => {
    // `//evil.example/collect` keeps the page's scheme and changes the host. Every hand-written
    // check that looked for a leading `http` has missed this one.
    expect(refusalFor({ formAction: '//evil.example/collect' })).toBe('cross-origin-form-action')
  })

  it('allows a relative action, which posts to the page itself', () => {
    expect(refusalFor({ formAction: 'session' })).toBe('allowed')
  })

  it('allows an absent action, which posts to the current document', () => {
    expect(refusalFor({ formAction: null })).toBe('allowed')
  })

  it('allows an empty action, which the HTML specification also reads as the current document', () => {
    expect(refusalFor({ formAction: '   ' })).toBe('allowed')
  })

  it('allows a fragment action', () => {
    expect(refusalFor({ formAction: '#step2' })).toBe('allowed')
  })

  it('allows an action on a subdomain of the same site', () => {
    // `example.com` and `api.example.com` are one party, and a login that posts to an API host is
    // ordinary. A per-host rule here would break real sites for no gain.
    expect(refusalFor({ formAction: 'https://api.example.com/session' })).toBe('allowed')
  })

  it('allows a javascript: action, which posts nowhere by itself', () => {
    // A script decides where such a form goes, and a script can reach any origin whatever the
    // attribute says — so refusing here would break `action="javascript:void(0)"` sites while
    // preventing nothing.
    expect(refusalFor({ formAction: 'javascript:void(0)' })).toBe('allowed')
  })

  it('allows an action this browser cannot parse, which the form cannot submit to either', () => {
    expect(refusalFor({ formAction: 'http://[not-a-host' })).toBe('allowed')
  })
})

describe('the offer list and the fill decision cannot disagree', () => {
  it('offers only what a fill would authorise', () => {
    /*
      The property that makes an offer list safe. Two predicates would eventually drift, and the
      direction they drift in is "the list showed something the rules would have refused" — which is
      how an offer list becomes the leak.
    */
    const subjects = [
      { origin: 'https://example.com' },
      { origin: 'https://evil.example' },
      { origin: 'http://example.com' },
      { origin: 'https://example.com.evil.com' }
    ]
    const offered = fillableSubjects(goodContext(), subjects)
    expect(offered.map((subject) => subject.origin)).toEqual([
      'https://example.com',
      // The http credential is an *upgrade* onto an https page, which is allowed.
      'http://example.com'
    ])
    for (const subject of offered) {
      expect(decideFill(goodContext(), subject).allowed, subject.origin).toBe(true)
    }
  })

  it('fills nothing at all when the situation itself is refused', () => {
    expect(fillableSubjects(goodContext({ consent: null }), [SUBJECT])).toEqual([])
  })

  it('offers without a consent, and nothing a fill would refuse for any other reason', () => {
    // The offer is `decideFill` without its first rule. With no press, the same subjects are offered
    // and none of them is fillable; every other rule still narrows the list exactly as before.
    const subjects = [
      { origin: 'https://example.com' },
      { origin: 'https://evil.example' },
      { origin: 'https://example.com.evil.com' }
    ]
    const unconsented = goodContext({ consent: null })

    expect(offerableSubjects(unconsented, subjects)).toEqual([{ origin: 'https://example.com' }])
    expect(fillableSubjects(unconsented, subjects)).toEqual([])
    expect(
      offerableSubjects(goodContext({ consent: null, isTopLevelFrame: false }), subjects)
    ).toEqual([])
    expect(
      decideOffer(goodContext({ consent: null, formAction: 'https://evil.example/x' }), SUBJECT)
    ).toEqual({
      allowed: false,
      reason: 'cross-origin-form-action'
    })
  })
})

describe('what the toolbar may know before there is a form or a consent', () => {
  /*
    The indicator has to answer "would there be anything to do here" on every navigation, long before
    a click, a form or a field rectangle exists. Calling `decideFill` with an invented consent to get
    that answer would be the second predicate this file's header warns about — two opinions about
    filling, drifting in the direction where the indicator promises what the rules refuse. So the
    part that is knowable then is exposed, and `decideFill` calls the same function rather than
    repeating it.
  */
  it('says yes to an https page and no to plain http off loopback', () => {
    expect(decidePageFill('https://example.com/login')).toEqual({ allowed: true })
    expect(decidePageFill('http://intranet.example/login')).toEqual({
      allowed: false,
      reason: 'insecure-page'
    })
  })

  it('says yes on loopback http, where there is no wire to listen on', () => {
    expect(decidePageFill('http://localhost:3000/login')).toEqual({ allowed: true })
  })

  it('names the scheme rather than the encryption for a document that has no site', () => {
    // The two are different conversations with the user — "this browser never fills here" against
    // "this page is not encrypted" — and the indicator is only worth having if it can tell them apart.
    expect(decidePageFill('file:///tmp/login.html')).toEqual({
      allowed: false,
      reason: 'unsupported-scheme'
    })
    expect(decidePageFill('tessera://start')).toEqual({
      allowed: false,
      reason: 'unsupported-scheme'
    })
    expect(decidePageFill('not a url')).toEqual({ allowed: false, reason: 'unsupported-scheme' })
  })

  it('agrees with the fill path on every page the fill path refuses for the page alone', () => {
    // The property that makes it safe to be optimistic: it may say yes where a fill is later refused
    // for the frame, the site or the form — it must never say yes where the *page* is the reason.
    for (const url of [
      'https://accounts.example.com/login',
      'http://example.com/login',
      'file:///tmp/login.html',
      'tessera://start',
      'http://127.0.0.2:8080/login'
    ]) {
      const page = decidePageFill(url)
      if (page.allowed) continue
      expect(refusalFor({ frameUrl: url, topLevelUrl: url }), url).toBe(page.reason)
    }
  })
})

describe('which origins could ever be filled', () => {
  it('agrees with the fill path about https, loopback http and everything else', () => {
    // The same predicate the fill path uses, so the note the passwords page shows on a row cannot
    // disagree with whether autofill actually appears there.
    expect(originMayReceiveCredentials('https://example.com')).toBe(true)
    expect(originMayReceiveCredentials('http://localhost:3000')).toBe(true)
    expect(originMayReceiveCredentials('http://intranet.example')).toBe(false)
    expect(originMayReceiveCredentials('file:///tmp')).toBe(false)
    expect(originMayReceiveCredentials('nonsense')).toBe(false)
  })
})
