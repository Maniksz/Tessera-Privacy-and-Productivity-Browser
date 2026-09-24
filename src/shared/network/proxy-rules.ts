import type { SettingsSnapshot } from '../settings/definitions.js'

/**
 * Settings to a proxy rule, and what the kill switch makes of a rule (U13, R20–R24, KTD8).
 *
 * Pure, with no Electron and no zod: `main/session/proxy.ts` hands the result to `session.setProxy`,
 * the request pipeline's `kill-switch` stage asks `killSwitchVerdict`, and `definitions.ts` refuses a
 * mode change through `proxyModeConflict`. What those three do with Electron is plumbing; every
 * decision about what counts as "a direct way out" is here, where a test can reach it.
 *
 * ## Kill switch means: no direct way
 *
 * With the kill switch on, a manual rule never names `direct://`, so Chromium itself fails closed when
 * the proxy is down — the page gets `-130` and the tile says the proxy is not responding (U9). That is
 * the whole of manual mode. System mode cannot be closed that way: the operating system's rule, or its
 * PAC script, decides per address and very often answers `PROXY a:3128; DIRECT`, which falls back to
 * the open network the moment the proxy fails. So there the request pipeline asks
 * `session.resolveProxy` for every origin and cancels whatever may leave directly.
 *
 * ## What it does not cover
 *
 * An operating-system VPN is not detected: the kill switch knows about the proxy this browser was told
 * to use, and nothing else. In system mode the PAC or WPAD download itself, and any `dnsResolve()` a PAC
 * script calls, happen before a rule exists to check. The settings text says both.
 */

export type ProxyMode = SettingsSnapshot['network.proxyMode']

/** What `session.setProxy` and `app.setProxy` are given. A subset of Electron's `ProxyConfig`. */
export type ProxyRule =
  | { readonly mode: 'direct' }
  | { readonly mode: 'system' }
  | { readonly mode: 'fixed_servers'; readonly proxyRules: string }

/**
 * The rule for "a proxy was asked for and none is usable", with the kill switch on.
 *
 * A proxy that cannot answer, on the discard port of the loopback address. Every request then fails the
 * way a dead proxy fails, which is the truth: the user asked for a proxy and does not have one. Only
 * reachable at startup, from a settings file written before an address was checked (see
 * `proxyModeConflict`); during a run the last valid rule stays instead.
 */
export const CLOSED_RULE: ProxyRule = { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' }

const DIRECT_RULE: ProxyRule = { mode: 'direct' }

export type ProxyUrlProblem = 'empty' | 'unparsable' | 'scheme' | 'credentials'

export type ParsedProxyUrl =
  | { readonly ok: true; readonly rule: string }
  | { readonly ok: false; readonly reason: ProxyUrlProblem }

/**
 * `socks5h` is `socks5` to Chromium, and naming it otherwise is how Electron mishandles it: Chromium
 * resolves names through a SOCKS5 proxy anyway. `socks4` is refused, because a SOCKS4 proxy cannot be
 * handed a name and Chromium would resolve it locally — a DNS query past the proxy.
 */
const SCHEMES: Readonly<Record<string, string>> = {
  'http:': 'http',
  'https:': 'https',
  'socks5:': 'socks5',
  'socks5h:': 'socks5'
}

/** One proxy address, as Chromium's `proxyRules` wants it: `scheme://host[:port]`. */
export function parseProxyUrl(raw: string): ParsedProxyUrl {
  const text = raw.trim()
  if (text === '') return { ok: false, reason: 'empty' }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'unparsable' }
  }
  const scheme = SCHEMES[url.protocol]
  if (scheme === undefined) return { ok: false, reason: 'scheme' }
  // Chromium's rule string has no place for them, and a settings file is no place for a password.
  if (url.username !== '' || url.password !== '') return { ok: false, reason: 'credentials' }
  const bare = (url.pathname === '' || url.pathname === '/') && url.search === '' && url.hash === ''
  if (url.hostname === '' || !bare) return { ok: false, reason: 'unparsable' }
  return { ok: true, rule: `${scheme}://${url.host}` }
}

export type ProxyRuleResult =
  | { readonly ok: true; readonly rule: ProxyRule }
  /** No usable rule. `fallback` is what applies when there is no earlier valid rule to keep. */
  | { readonly ok: false; readonly reason: ProxyUrlProblem; readonly fallback: ProxyRule }

/** The matrix of KTD8: mode and kill switch to a rule. */
export function proxyRuleFor(settings: SettingsSnapshot): ProxyRuleResult {
  const mode = settings['network.proxyMode']
  if (mode === 'direct') return { ok: true, rule: DIRECT_RULE }
  if (mode === 'system') return { ok: true, rule: { mode: 'system' } }
  const killSwitch = settings['network.killSwitch']
  const parsed = parseProxyUrl(settings['network.proxyUrl'])
  if (!parsed.ok) {
    return { ok: false, reason: parsed.reason, fallback: killSwitch ? CLOSED_RULE : DIRECT_RULE }
  }
  return {
    ok: true,
    rule: {
      mode: 'fixed_servers',
      proxyRules: killSwitch ? parsed.rule : `${parsed.rule},direct://`
    }
  }
}

/**
 * Why a settings write must be refused, or `null`.
 *
 * Only the switch to manual is refused, never the address. The settings field saves on every
 * keystroke, so refusing a half-typed address would make the field impossible to type into; instead an
 * address that is not usable is simply not applied, and the last valid rule stays (`proxy.ts`). Switching
 * to manual with nothing usable in the field is refused, which is the one point where "save" and
 * "apply" are the same act.
 */
export function proxyModeConflict(
  key: string,
  value: unknown,
  settings: SettingsSnapshot
): string | null {
  if (key !== 'network.proxyMode' || value !== 'manual') return null
  const parsed = parseProxyUrl(settings['network.proxyUrl'])
  return parsed.ok
    ? null
    : `enter a usable proxy address first (http, https or socks5): ${parsed.reason}`
}

/** True when the kill switch has anything to guard: it is on, and a proxy was asked for (R23). */
export function killSwitchActive(settings: SettingsSnapshot): boolean {
  return settings['network.killSwitch'] && settings['network.proxyMode'] !== 'direct'
}

/** What kind of rule was applied, as far as the kill switch cares. */
export type AppliedRule = 'direct' | 'system' | 'closed' | 'open'

export function ruleKind(rule: ProxyRule): AppliedRule {
  if (rule.mode !== 'fixed_servers') return rule.mode
  return rule.proxyRules.includes('direct://') ? 'open' : 'closed'
}

/**
 * True when a `session.resolveProxy` answer lets the request leave directly, anywhere in its list.
 *
 * An empty answer names no proxy, and nothing but a named proxy is a reason to let a request through.
 */
export function allowsDirect(resolved: string): boolean {
  const entries = resolved
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
  return entries.length === 0 || entries.some((entry) => /^direct$/i.test(entry))
}

const GUARDED: Readonly<Record<string, string>> = {
  'http:': 'http:',
  'https:': 'https:',
  'ws:': 'http:',
  'wss:': 'https:'
}

function guardedUrl(url: string): URL | null {
  try {
    const parsed = new URL(url)
    return parsed.protocol in GUARDED ? parsed : null
  } catch {
    return null
  }
}

/**
 * The cache key of a request: scheme, host and port, or `null` for what the kill switch leaves alone.
 *
 * Per origin rather than per host, because a PAC script decides per address and very often by scheme:
 * `http://example.com` and `https://example.com` may take different ways. `tessera:`, `file:`, `data:`
 * and the like never reach a network and have no key.
 */
export function originKey(url: string): string | null {
  const parsed = guardedUrl(url)
  return parsed === null ? null : `${parsed.protocol}//${parsed.host}`
}

/**
 * The address `resolveProxy` is asked about for a request.
 *
 * The origin rather than the full address, so one answer serves the cache entry. A WebSocket is asked
 * about as the HTTP request it begins as, which is how Chromium chooses its proxy.
 */
export function resolveTarget(url: string): string | null {
  const parsed = guardedUrl(url)
  return parsed === null ? null : `${GUARDED[parsed.protocol]}//${parsed.host}/`
}

export type KillSwitchVerdict = 'pass' | 'block' | 'unknown'

export interface KillSwitchFacts {
  /** A `setProxy` for this session has not resolved yet. */
  readonly pending: boolean
  /** The rule this session runs under; `null` when applying one failed. */
  readonly applied: AppliedRule | null
  /**
   * System mode's answer for this origin: `undefined` not asked yet, `null` for an answer that failed,
   * otherwise `resolveProxy`'s text.
   */
  readonly resolved: string | null | undefined
}

/**
 * The kill switch's answer for one request, asked only while `killSwitchActive` holds.
 *
 * `unknown` means "wait": the request pipeline holds it until an answer exists, and cancels it if none
 * arrives in time. Nothing here ever answers `pass` without a reason to.
 */
export function killSwitchVerdict(facts: KillSwitchFacts): KillSwitchVerdict {
  if (facts.pending) return 'unknown'
  if (facts.applied === 'closed') return 'pass'
  if (facts.applied !== 'system') return 'block'
  if (facts.resolved === undefined) return 'unknown'
  if (facts.resolved === null) return 'block'
  return allowsDirect(facts.resolved) ? 'block' : 'pass'
}

/**
 * The WebRTC policy a view gets (R24).
 *
 * Whenever a proxy is asked for, WebRTC may use nothing that bypasses it — otherwise a page learns the
 * real address through UDP while every HTTP request goes through the proxy. With no proxy the setting
 * applies as chosen, kill switch or not: there is nothing to bypass.
 */
export function webRtcPolicyFor(
  settings: SettingsSnapshot
): SettingsSnapshot['network.webrtcIpPolicy'] {
  return settings['network.proxyMode'] === 'direct'
    ? settings['network.webrtcIpPolicy']
    : 'disable_non_proxied_udp'
}
