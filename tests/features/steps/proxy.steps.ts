import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import type { CallbackResponse } from 'electron'
import {
  parseProxyUrl,
  proxyRuleFor,
  webRtcPolicyFor,
  type ProxyRule
} from '@shared/network/proxy-rules.js'
import {
  blockSourceOf,
  classifyFailure,
  failureMessage,
  type BlockSource
} from '@shared/browser/tab-failure.js'
import { translate, type Locale } from '@shared/i18n/catalog.js'
import { describeSetting } from '@main/settings/describe.js'
import { installRequestPipeline } from '@main/privacy/RequestPipeline.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { scope } from './world.js'

/**
 * Steps for `proxy.feature`.
 *
 * The real rule, the real request pipeline, and the real `ProxyGate` over a session that is only its three
 * proxy calls. What Chromium does with the rule — fail closed with `-130`, or connect — is outside any test;
 * what is checked is that the rule leaves it no direct way, and that the tile then says so.
 *
 * `main/session/proxy.ts` imports Electron, so it is loaded when a scenario needs it rather than at the top:
 * this file is a setup file for the whole unit project (see `closing.steps.ts`).
 */

interface ProxyWorld {
  /** The system proxy's answer to every `resolveProxy`, in system mode. */
  systemAnswer: string
  /** The last request's response, once the pipeline has given one. */
  response: CallbackResponse | null
  /** The stage that cancelled the last main frame, if one did. */
  blockedBy: BlockSource | null
  url: string
}

const KEY = 'proxyWorld'

function proxyWorld(state: unknown): ProxyWorld {
  const held = scope(state).scratch[KEY] as ProxyWorld | undefined
  if (held !== undefined) return held
  const fresh: ProxyWorld = { systemAnswer: 'DIRECT', response: null, blockedBy: null, url: '' }
  scope(state).scratch[KEY] = fresh
  return fresh
}

function patch(state: unknown, values: Partial<SettingsSnapshot>): void {
  scope(state).settings = { ...scope(state).settings, ...values }
}

function onOff(word: string): boolean {
  if (word !== 'on' && word !== 'off')
    throw new Error(`the kill switch is "on" or "off", not ${word}`)
  return word === 'on'
}

function ruleOf(state: unknown): ProxyRule {
  const result = proxyRuleFor(scope(state).settings)
  if (!result.ok) throw new Error(`no rule: ${result.reason}`)
  return result.rule
}

Given(
  'a manual proxy {string} with the kill switch {word}',
  (state: unknown, url: string, killSwitch: string) => {
    patch(state, {
      'network.proxyMode': 'manual',
      'network.proxyUrl': url,
      'network.killSwitch': onOff(killSwitch)
    })
  }
)

Given(
  'the system proxy setting answers {string} with the kill switch {word}',
  (state: unknown, answer: string, killSwitch: string) => {
    patch(state, { 'network.proxyMode': 'system', 'network.killSwitch': onOff(killSwitch) })
    proxyWorld(state).systemAnswer = answer
  }
)

Given('no proxy, with the kill switch on', (state: unknown) => {
  patch(state, { 'network.proxyMode': 'direct', 'network.killSwitch': true })
})

Given('the WebRTC setting is {string}', (state: unknown, policy: string) => {
  patch(state, { 'network.webrtcIpPolicy': policy as SettingsSnapshot['network.webrtcIpPolicy'] })
})

When('I open {string}', async (state: unknown, url: string) => {
  const { ProxyGate } = await import('@main/session/proxy.js')
  const world = proxyWorld(state)
  const gate = new ProxyGate({
    setProxy: () => Promise.resolve(),
    closeAllConnections: () => Promise.resolve(),
    resolveProxy: () => Promise.resolve(world.systemAnswer)
  })
  await gate.apply(ruleOf(state))

  type Listener = (details: unknown, callback: (response: CallbackResponse) => void) => void
  const listeners: Listener[] = []
  const session = {
    webRequest: {
      onBeforeRequest(registered: Listener | null) {
        if (registered !== null) listeners.push(registered)
      }
    }
  }
  installRequestPipeline({
    session: session as never,
    getSettings: () => scope(state).settings,
    filterEngine: null,
    killSwitch: gate,
    hooks: {
      onBlockedNavigation: (_id, stage) => {
        world.blockedBy = blockSourceOf(stage)
      }
    }
  })
  world.url = url
  world.response = await new Promise<CallbackResponse>((resolve) => {
    listeners[0]?.({ url, resourceType: 'mainFrame', method: 'GET', webContentsId: 1 }, resolve)
  })
})

Then('the proxy rule is {string}', (state: unknown, rules: string) => {
  expect(ruleOf(state)).toEqual({ mode: 'fixed_servers', proxyRules: rules })
})

Then('the proxy address {string} is refused', (_state: unknown, url: string) => {
  expect(parseProxyUrl(url).ok).toBe(false)
})

Then('the request goes to Chromium under the proxy rule', (state: unknown) => {
  expect(proxyWorld(state).response).toEqual({})
})

Then('the kill switch cancels the request', (state: unknown) => {
  expect(proxyWorld(state).response).toEqual({ cancel: true })
  expect(proxyWorld(state).blockedBy).toBe('killSwitch')
})

When('the page fails with {int}', (state: unknown, code: number) => {
  // What Chromium reports for a closed rule and a proxy that does not answer.
  proxyWorld(state).blockedBy = null
  scope(state).scratch.proxyFailureCode = code
})

Then('the tile says {string}', (state: unknown, sentence: string) => {
  const world = proxyWorld(state)
  const code = (scope(state).scratch.proxyFailureCode as number | undefined) ?? -20
  const failure = classifyFailure({
    event: 'did-fail-load',
    code,
    isMainFrame: true,
    url: world.url,
    blockedBy: world.blockedBy
  })
  if (failure === null) throw new Error('the tile shows no failure')
  const message = failureMessage(failure)
  expect(translate('en', message.key, message.params)).toBe(sentence)
})

Then(
  'the kill switch text in {string} begins with {string}',
  (_state: unknown, locale: string, start: string) => {
    expect(describeSetting('network.killSwitch', locale as Locale).description).toMatch(
      new RegExp(`^${start}`)
    )
  }
)

Then(
  'the kill switch label in {string} speaks of the proxy and of no tunnel or VPN',
  (_state: unknown, locale: string) => {
    const { label } = describeSetting('network.killSwitch', locale as Locale)
    expect(label).toMatch(/proxy/i)
    expect(label).not.toMatch(/tunnel|vpn/i)
  }
)

Then('WebRTC may use nothing that bypasses the proxy', (state: unknown) => {
  expect(webRtcPolicyFor(scope(state).settings)).toBe('disable_non_proxied_udp')
})

Then('WebRTC follows the setting {string}', (state: unknown, policy: string) => {
  expect(webRtcPolicyFor(scope(state).settings)).toBe(policy)
})
