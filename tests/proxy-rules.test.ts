import { describe, expect, it } from 'vitest'
import {
  CLOSED_RULE,
  allowsDirect,
  killSwitchActive,
  killSwitchVerdict,
  originKey,
  parseProxyUrl,
  proxyModeConflict,
  proxyRuleFor,
  resolveTarget,
  ruleKind,
  webRtcPolicyFor,
  type ProxyRule
} from '@shared/network/proxy-rules.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * Settings to a proxy rule, and the kill switch's verdict (U13, R20–R24, KTD8).
 *
 * The first test is the one the whole unit hangs on: with the kill switch on, a rule never names a
 * direct route. Everything else here is either the rest of the matrix in KTD8's table or the pieces the
 * request pipeline's `kill-switch` stage reads.
 */

function settings(patch: Partial<SettingsSnapshot>): SettingsSnapshot {
  return { ...defaultSettings(), ...patch }
}

function manual(url: string, killSwitch: boolean): SettingsSnapshot {
  return settings({
    'network.proxyMode': 'manual',
    'network.proxyUrl': url,
    'network.killSwitch': killSwitch
  })
}

function rulesOf(result: ReturnType<typeof proxyRuleFor>): string {
  return result.ok && result.rule.mode === 'fixed_servers' ? result.rule.proxyRules : ''
}

describe('the kill switch in the rule', () => {
  it('never puts direct:// into a rule while the kill switch is on', () => {
    for (const url of ['http://proxy:8080', 'https://p.example:443', 'socks5://127.0.0.1:9050']) {
      const result = proxyRuleFor(manual(url, true))
      expect(result.ok, url).toBe(true)
      expect(rulesOf(result), url).not.toContain('direct://')
    }
    expect(CLOSED_RULE.mode === 'fixed_servers' && CLOSED_RULE.proxyRules).not.toContain('direct')
  })

  it('is exactly the proxy with the kill switch on', () => {
    expect(proxyRuleFor(manual('http://proxy:8080', true))).toEqual({
      ok: true,
      rule: { mode: 'fixed_servers', proxyRules: 'http://proxy:8080' }
    })
  })

  it('falls back to direct:// with the kill switch off', () => {
    expect(rulesOf(proxyRuleFor(manual('http://proxy:8080', false)))).toBe(
      'http://proxy:8080,direct://'
    )
  })

  it('leaves direct and system to Chromium', () => {
    expect(proxyRuleFor(settings({ 'network.proxyMode': 'direct' }))).toEqual({
      ok: true,
      rule: { mode: 'direct' }
    })
    expect(proxyRuleFor(settings({ 'network.proxyMode': 'system' }))).toEqual({
      ok: true,
      rule: { mode: 'system' }
    })
  })

  it('refuses an empty or unusable manual address, and says what is safe instead', () => {
    for (const url of ['', '   ', 'not a url', 'socks4://h:1080', 'ftp://h:21']) {
      const on = proxyRuleFor(manual(url, true))
      expect(on.ok, url).toBe(false)
      // Nothing to fall back to at startup: closed with the kill switch on, direct with it off.
      expect(on.ok ? null : on.fallback, url).toEqual(CLOSED_RULE)
      const off = proxyRuleFor(manual(url, false))
      expect(off.ok ? null : off.fallback, url).toEqual({ mode: 'direct' })
    }
  })
})

describe('parseProxyUrl', () => {
  it('accepts http, https and socks5', () => {
    expect(parseProxyUrl('http://proxy:8080')).toEqual({ ok: true, rule: 'http://proxy:8080' })
    expect(parseProxyUrl(' https://p.example:3129 ')).toEqual({
      ok: true,
      rule: 'https://p.example:3129'
    })
    expect(parseProxyUrl('SOCKS5://h:1080')).toEqual({ ok: true, rule: 'socks5://h:1080' })
    expect(parseProxyUrl('http://[::1]:3128/')).toEqual({ ok: true, rule: 'http://[::1]:3128' })
  })

  it('keeps a default port elided rather than inventing one', () => {
    expect(parseProxyUrl('http://proxy')).toEqual({ ok: true, rule: 'http://proxy' })
    expect(parseProxyUrl('http://proxy:80')).toEqual({ ok: true, rule: 'http://proxy' })
  })

  it('turns socks5h into socks5 and refuses socks4', () => {
    expect(parseProxyUrl('socks5h://h:1080')).toEqual({ ok: true, rule: 'socks5://h:1080' })
    expect(parseProxyUrl('socks4://h:1080')).toEqual({ ok: false, reason: 'scheme' })
    expect(parseProxyUrl('socks4a://h:1080')).toEqual({ ok: false, reason: 'scheme' })
    expect(parseProxyUrl('socks://h:1080')).toEqual({ ok: false, reason: 'scheme' })
  })

  it('names why an address is refused', () => {
    expect(parseProxyUrl('')).toEqual({ ok: false, reason: 'empty' })
    expect(parseProxyUrl('not a url')).toEqual({ ok: false, reason: 'unparsable' })
    expect(parseProxyUrl('proxy:8080')).toEqual({ ok: false, reason: 'scheme' })
    expect(parseProxyUrl('socks5://')).toEqual({ ok: false, reason: 'unparsable' })
    expect(parseProxyUrl('http://u:p@proxy:8080')).toEqual({ ok: false, reason: 'credentials' })
    expect(parseProxyUrl('http://user@proxy:8080')).toEqual({ ok: false, reason: 'credentials' })
    expect(parseProxyUrl('http://proxy:8080/path')).toEqual({ ok: false, reason: 'unparsable' })
    expect(parseProxyUrl('http://proxy:8080/?q')).toEqual({ ok: false, reason: 'unparsable' })
    expect(parseProxyUrl('http://proxy:8080/#x')).toEqual({ ok: false, reason: 'unparsable' })
  })
})

describe('proxyModeConflict', () => {
  it('refuses switching to manual before a usable address is there', () => {
    const empty = settings({ 'network.proxyUrl': '' })
    expect(proxyModeConflict('network.proxyMode', 'manual', empty)).toMatch(/address/)
    const bad = settings({ 'network.proxyUrl': 'socks4://h:1' })
    expect(proxyModeConflict('network.proxyMode', 'manual', bad)).toMatch(/address/)
  })

  it('lets manual through with a usable address, and every other change', () => {
    const good = settings({ 'network.proxyUrl': 'http://proxy:8080' })
    expect(proxyModeConflict('network.proxyMode', 'manual', good)).toBeNull()
    expect(proxyModeConflict('network.proxyMode', 'system', settings({}))).toBeNull()
    // The address itself is never refused: the field saves on every keystroke (see the module).
    expect(proxyModeConflict('network.proxyUrl', 'h', manual('http://p:1', true))).toBeNull()
  })
})

describe('allowsDirect', () => {
  it('finds DIRECT anywhere in a resolveProxy answer', () => {
    expect(allowsDirect('DIRECT')).toBe(true)
    expect(allowsDirect('PROXY a:3128; DIRECT')).toBe(true)
    expect(allowsDirect('direct')).toBe(true)
    expect(allowsDirect('PROXY a:3128;DIRECT')).toBe(true)
  })

  it('treats an empty answer as direct, since it names no proxy', () => {
    expect(allowsDirect('')).toBe(true)
    expect(allowsDirect('  ;  ')).toBe(true)
  })

  it('passes an answer with proxies only', () => {
    expect(allowsDirect('PROXY a:3128')).toBe(false)
    expect(allowsDirect('SOCKS5 127.0.0.1:9050; HTTPS b:443')).toBe(false)
    // A host called "direct" is not the DIRECT token.
    expect(allowsDirect('PROXY direct.example:80')).toBe(false)
  })
})

describe('originKey and resolveTarget', () => {
  it('keys by scheme, host and port', () => {
    expect(originKey('https://example.com/a?b')).toBe('https://example.com')
    expect(originKey('http://example.com/a')).toBe('http://example.com')
    expect(originKey('http://example.com:8080/')).toBe('http://example.com:8080')
    expect(originKey('wss://chat.example/socket')).toBe('wss://chat.example')
    expect(originKey('HTTP://Example.COM/')).toBe('http://example.com')
  })

  it('keeps http and https of one host apart', () => {
    expect(originKey('http://example.com/')).not.toBe(originKey('https://example.com/'))
  })

  it('has no key for what the kill switch leaves alone', () => {
    for (const url of ['tessera://settings', 'file:///tmp/a.html', 'data:text/plain,x', 'nope']) {
      expect(originKey(url), url).toBeNull()
    }
  })

  it('asks the resolver about a WebSocket as the HTTP it starts as', () => {
    expect(resolveTarget('ws://chat.example:81/s')).toBe('http://chat.example:81/')
    expect(resolveTarget('wss://chat.example/s')).toBe('https://chat.example/')
    expect(resolveTarget('https://example.com/a')).toBe('https://example.com/')
    expect(resolveTarget('tessera://settings')).toBeNull()
  })
})

describe('killSwitchActive', () => {
  it('is on only with the switch on and a proxy asked for', () => {
    expect(killSwitchActive(settings({}))).toBe(false)
    expect(killSwitchActive(settings({ 'network.proxyMode': 'system' }))).toBe(true)
    expect(killSwitchActive(manual('http://p:1', true))).toBe(true)
    expect(killSwitchActive(manual('http://p:1', false))).toBe(false)
  })
})

describe('ruleKind', () => {
  it('tells a closed fixed rule from one with a way out', () => {
    const rule = (proxyRules: string): ProxyRule => ({ mode: 'fixed_servers', proxyRules })
    expect(ruleKind({ mode: 'direct' })).toBe('direct')
    expect(ruleKind({ mode: 'system' })).toBe('system')
    expect(ruleKind(rule('http://p:1'))).toBe('closed')
    expect(ruleKind(rule('http://p:1,direct://'))).toBe('open')
    expect(ruleKind(CLOSED_RULE)).toBe('closed')
  })
})

describe('killSwitchVerdict', () => {
  const base = { pending: false, applied: 'system' as const, resolved: 'PROXY a:3128' }

  it('holds while a rule change is pending', () => {
    expect(killSwitchVerdict({ ...base, pending: true })).toBe('unknown')
  })

  it('blocks when no rule could be applied', () => {
    expect(killSwitchVerdict({ ...base, applied: null })).toBe('block')
  })

  it('leaves a closed fixed rule to Chromium, which fails closed itself', () => {
    expect(killSwitchVerdict({ ...base, applied: 'closed', resolved: undefined })).toBe('pass')
  })

  it('blocks when the applied rule still has a direct way', () => {
    expect(killSwitchVerdict({ ...base, applied: 'open' })).toBe('block')
    expect(killSwitchVerdict({ ...base, applied: 'direct' })).toBe('block')
  })

  it('in system mode, waits for an answer, then blocks any DIRECT', () => {
    expect(killSwitchVerdict({ ...base, resolved: undefined })).toBe('unknown')
    expect(killSwitchVerdict({ ...base, resolved: null })).toBe('block')
    expect(killSwitchVerdict({ ...base, resolved: 'DIRECT' })).toBe('block')
    expect(killSwitchVerdict({ ...base, resolved: 'PROXY a:3128; DIRECT' })).toBe('block')
    expect(killSwitchVerdict(base)).toBe('pass')
  })
})

describe('webRtcPolicyFor', () => {
  it('forces the proxied-only policy whenever a proxy is asked for', () => {
    for (const mode of ['system', 'manual'] as const) {
      for (const killSwitch of [true, false]) {
        expect(
          webRtcPolicyFor(
            settings({
              'network.proxyMode': mode,
              'network.killSwitch': killSwitch,
              'network.webrtcIpPolicy': 'default'
            })
          )
        ).toBe('disable_non_proxied_udp')
      }
    }
  })

  it('keeps the setting in direct mode, kill switch or not', () => {
    for (const killSwitch of [true, false]) {
      expect(
        webRtcPolicyFor(
          settings({ 'network.killSwitch': killSwitch, 'network.webrtcIpPolicy': 'default' })
        )
      ).toBe('default')
    }
  })
})
