import { describe, expect, it } from 'vitest'
import {
  BACK_URL,
  CONTINUE_TOKEN_LIFETIME_MS,
  ContinueTokens,
  continueUrl,
  httpsVersionOf,
  interstitialActionOf,
  interstitialTargetOf,
  interstitialTokenOf,
  interstitialUrl,
  isInterstitialAction,
  withoutToken,
  type InterstitialNavigation,
  type TokenSource
} from '@shared/privacy/https-token.js'

/**
 * The interstitial's addresses and its token ledger, as pure rules (KTD3).
 *
 * `tests/https-exemptions.test.ts` runs these end to end through the pipeline and the redemption; this file
 * pins each rule on its own, so a mutation that loosens one cannot hide behind another that still holds.
 */

const TOKEN = 'A'.repeat(43)
const INTERSTITIAL = interstitialUrl('http://bank.example/', TOKEN, 'de')

describe('the interstitial address', () => {
  it('carries the target, the token and the language', () => {
    const parsed = new URL(INTERSTITIAL)
    expect(parsed.protocol).toBe('tessera:')
    expect(parsed.hostname).toBe('https-only')
    expect(parsed.searchParams.get('target')).toBe('http://bank.example/')
    expect(parsed.searchParams.get('t')).toBe(TOKEN)
    expect(parsed.searchParams.get('lang')).toBe('de')
  })

  it('carries no token when there is none', () => {
    const url = interstitialUrl('http://bank.example/', null, 'en')
    expect(new URL(url).searchParams.has('t')).toBe(false)
    expect(interstitialTokenOf(url)).toBeNull()
  })

  it('reads back the target it was built with', () => {
    expect(interstitialTargetOf(INTERSTITIAL)).toBe('http://bank.example/')
    // Chromium's form of the same address, with the root path the standard scheme gives it.
    expect(interstitialTargetOf('tessera://https-only/?target=http%3A%2F%2Fa.example%2Fx')).toBe(
      'http://a.example/x'
    )
    expect(interstitialTargetOf('TESSERA://HTTPS-ONLY?target=http://a.example/')).toBe(
      'http://a.example/'
    )
  })

  it('accepts only an http target', () => {
    for (const target of [
      'javascript:alert(1)',
      'https://bank.example/',
      'data:text/html,hi',
      'not a url'
    ]) {
      expect(interstitialTargetOf(interstitialUrl(target, null, 'en')), target).toBeNull()
    }
    expect(interstitialTargetOf('tessera://https-only')).toBeNull()
  })

  it('reads a target off the interstitial document only', () => {
    expect(interstitialTargetOf('tessera://about/?target=http://a.example/')).toBeNull()
    expect(interstitialTargetOf('https://https-only/?target=http://a.example/')).toBeNull()
    expect(
      interstitialTargetOf('tessera://https-only/continue?target=http://a.example/')
    ).toBeNull()
    expect(interstitialTargetOf('not a url')).toBeNull()
  })

  it('reads only a token the core could have minted', () => {
    expect(interstitialTokenOf(INTERSTITIAL)).toBe(TOKEN)
    for (const token of ['short', `${TOKEN}A`, `${'A'.repeat(42)}=`, `${'A'.repeat(42)}/`]) {
      const url = interstitialUrl('http://bank.example/', token, 'en')
      expect(interstitialTokenOf(url), token).toBeNull()
    }
  })

  it('drops the token and keeps everything else', () => {
    const shown = withoutToken(INTERSTITIAL)
    expect(new URL(shown).searchParams.has('t')).toBe(false)
    expect(interstitialTargetOf(shown)).toBe('http://bank.example/')
    expect(new URL(shown).searchParams.get('lang')).toBe('de')
    // Anything that is not the interstitial comes back as it was.
    expect(withoutToken('https://example.com/?t=1')).toBe('https://example.com/?t=1')
  })

  it('swaps only the scheme for "Try HTTPS"', () => {
    expect(httpsVersionOf('http://host.example:8080/a?b=1#c')).toBe(
      'https://host.example:8080/a?b=1#c'
    )
  })
})

describe('the action routes', () => {
  it('are recognised for the protocol handler, which answers them with nothing', () => {
    expect(isInterstitialAction(continueUrl(TOKEN))).toBe(true)
    expect(isInterstitialAction(BACK_URL)).toBe(true)
    expect(isInterstitialAction(INTERSTITIAL)).toBe(false)
    expect(isInterstitialAction('tessera://https-only/assets/page.js')).toBe(false)
    expect(isInterstitialAction('tessera://about/continue')).toBe(false)
  })

  it('carry the token through encoding', () => {
    expect(new URL(continueUrl('a+b/c')).searchParams.get('t')).toBe('a+b/c')
  })
})

describe('what the interstitial asked for', () => {
  function navigation(overrides: Partial<InterstitialNavigation>): InterstitialNavigation {
    return {
      url: continueUrl(TOKEN),
      source: 'frame',
      isMainFrame: true,
      initiatorUrl: withoutToken(INTERSTITIAL),
      ...overrides
    }
  }

  it('reads "Continue" with its token and "Go back"', () => {
    expect(interstitialActionOf(navigation({}))).toEqual({ kind: 'continue', token: TOKEN })
    expect(interstitialActionOf(navigation({ url: BACK_URL }))).toEqual({ kind: 'back' })
  })

  it('reads nothing from a redirect, a subframe, or a navigation somebody else started', () => {
    expect(interstitialActionOf(navigation({ source: 'redirect' }))).toBeNull()
    expect(interstitialActionOf(navigation({ isMainFrame: false }))).toBeNull()
    for (const initiatorUrl of [
      null,
      'https://evil.example/',
      'tessera://settings/',
      // The action routes are no documents: nothing is ever loaded there to start anything.
      continueUrl(TOKEN),
      'not a url'
    ]) {
      expect(interstitialActionOf(navigation({ initiatorUrl })), String(initiatorUrl)).toBeNull()
    }
  })

  it('reads nothing from an address that is no action', () => {
    for (const url of [
      'tessera://https-only/continue',
      'tessera://https-only/',
      'tessera://https-only/other',
      'tessera://settings/continue?t=x',
      'not a url'
    ]) {
      expect(interstitialActionOf(navigation({ url })), url).toBeNull()
    }
  })
})

describe('the token ledger', () => {
  function ledger(): {
    tokens: ContinueTokens<{ target: string }>
    clock: { at: number }
    compared: Array<[string, string]>
  } {
    let minted = 0
    const clock = { at: 0 }
    const compared: Array<[string, string]> = []
    const source: TokenSource = {
      mint: () => `t${(minted += 1)}`,
      same: (a, b) => {
        compared.push([a, b])
        return a === b
      },
      now: () => clock.at
    }
    return { tokens: new ContinueTokens(source), clock, compared }
  }

  it('hands back the grant for the right view and token', () => {
    const { tokens, compared } = ledger()
    const token = tokens.issue(1, { target: 'http://a.example/' })
    expect(tokens.redeem(1, token)).toEqual({ target: 'http://a.example/' })
    // Through the source's comparison, which is the constant-time one in the core.
    expect(compared).toEqual([[token, token]])
  })

  it('knows nothing of a view it issued nothing to', () => {
    const { tokens } = ledger()
    tokens.issue(1, { target: 'http://a.example/' })
    expect(tokens.redeem(2, 't1')).toBeNull()
    // And asking about view 2 did not spend view 1's token.
    expect(tokens.redeem(1, 't1')).not.toBeNull()
  })

  it('holds one token per view, the latest', () => {
    const { tokens } = ledger()
    const first = tokens.issue(1, { target: 'http://a.example/' })
    const second = tokens.issue(1, { target: 'http://b.example/' })
    expect(second).not.toBe(first)
    expect(tokens.redeem(1, second)).toEqual({ target: 'http://b.example/' })
  })

  it('keeps tokens of different views apart', () => {
    const { tokens } = ledger()
    const a = tokens.issue(1, { target: 'http://a.example/' })
    const b = tokens.issue(2, { target: 'http://b.example/' })
    expect(tokens.redeem(1, b)).toBeNull()
    expect(tokens.redeem(2, b)).toEqual({ target: 'http://b.example/' })
    expect(a).not.toBe(b)
  })

  it('is valid for just under ten minutes', () => {
    const { tokens, clock } = ledger()
    const token = tokens.issue(1, { target: 'http://a.example/' })
    clock.at = CONTINUE_TOKEN_LIFETIME_MS - 1
    expect(tokens.redeem(1, token)).not.toBeNull()

    const late = tokens.issue(1, { target: 'http://a.example/' })
    clock.at += CONTINUE_TOKEN_LIFETIME_MS
    expect(tokens.redeem(1, late)).toBeNull()
  })

  it('deletes the record before comparing, so it cannot be tried twice', () => {
    const { tokens } = ledger()
    const token = tokens.issue(1, { target: 'http://a.example/' })
    expect(tokens.redeem(1, 'wrong')).toBeNull()
    expect(tokens.redeem(1, token)).toBeNull()
  })

  it('sweeps expired records of other views when it issues', () => {
    const { tokens, clock, compared } = ledger()
    tokens.issue(1, { target: 'http://a.example/' })
    clock.at = CONTINUE_TOKEN_LIFETIME_MS / 2
    const kept = tokens.issue(2, { target: 'http://b.example/' })
    clock.at = CONTINUE_TOKEN_LIFETIME_MS
    // View 1's record is swept here, view 2's is not yet due …
    const fresh = tokens.issue(3, { target: 'http://c.example/' })
    // … so redeeming view 1's finds nothing to compare against.
    expect(tokens.redeem(1, 't1')).toBeNull()
    expect(compared).toEqual([])
    expect(tokens.redeem(2, kept)).toEqual({ target: 'http://b.example/' })
    expect(tokens.redeem(3, fresh)).toEqual({ target: 'http://c.example/' })
  })
})
