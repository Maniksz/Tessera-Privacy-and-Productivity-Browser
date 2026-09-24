import { app, net, session as electronSession, webContents, type Session } from 'electron'
import {
  allowsDirect,
  killSwitchActive,
  killSwitchVerdict,
  originKey,
  proxyRuleFor,
  resolveTarget,
  ruleKind,
  type AppliedRule,
  type KillSwitchVerdict,
  type ProxyRule
} from '@shared/network/proxy-rules.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { SettingsStore } from '../settings/SettingsStore.js'
import { installKillSwitchOnly, type KillSwitchGate } from '../privacy/RequestPipeline.js'
import { applySecureDns, applyWebRtcPolicy, installWebRtcPolicy } from './hardening.js'

/**
 * The proxy rule on every session, live, and the kill switch's answers (U13, R20–R24, KTD8).
 *
 * The decisions are `@shared/network/proxy-rules.ts`'s. This file puts them where Electron reads them:
 *
 *   - **Every session, with no list to keep.** The default session exists before this runs and gets the
 *     rule at once; every later one — `private-N`, the updater's — gets it from `app.on('session-created')`
 *     the moment it exists, so a session nobody remembered to register still cannot escape it.
 *     `app.setProxy` covers what runs without a session.
 *   - **Live.** A change of mode, address or kill switch reapplies to all of them and closes open
 *     connections, so a keep-alive socket made under the old rule does not carry on under it.
 *   - **The kill switch's answers.** `ProxyGate` is what the request pipeline's `kill-switch` stage reads:
 *     per origin, from `session.resolveProxy`, blocking everything while a rule change is pending.
 *
 * Secure DNS is applied from here as well, because it is the same section and the same moment: once at
 * startup, again when it changes.
 */

/** How long a request waits for `resolveProxy` or a pending `setProxy` before it is cancelled. */
export const RESOLVE_DEADLINE_MS = 5_000

/**
 * How long a `resolveProxy` answer is trusted.
 *
 * Electron reports no network change, and a PAC script's answer may change with the network — a laptop
 * leaving the office network that had a proxy for the one that has none. A minute is the stand-in for
 * the event that does not exist: cheap, because asking is cheap, and short enough that a changed answer
 * is found before a whole browsing session has gone by on the old one.
 */
export const CACHE_TTL_MS = 60_000

/** `electron-updater`'s own partition name (`NET_SESSION_NAME` in its `electronHttpExecutor`). */
export const UPDATER_PARTITION = 'electron-updater'

/** The three calls a gate makes on its session. A `Session` satisfies it. */
export interface ProxyTarget {
  setProxy(rule: ProxyRule): Promise<void>
  closeAllConnections(): Promise<void>
  resolveProxy(url: string): Promise<string>
}

interface Answer {
  /** `resolveProxy`'s text, or `null` for a call that failed. */
  readonly text: string | null
  readonly at: number
}

/** Resolves when `work` does or when `ms` have passed, whichever is first. Never rejects. */
function withDeadline(work: Promise<void>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const deadline = setTimeout(resolve, ms)
    void work.then(() => {
      clearTimeout(deadline)
      resolve()
    })
  })
}

/**
 * One session's rule and the kill switch's cache of `resolveProxy` answers.
 *
 * Every answer belongs to the rule it was asked under: a `setProxy` empties the cache and raises the
 * generation, and an answer that comes back afterwards is dropped rather than stored under the new rule.
 */
export class ProxyGate implements KillSwitchGate {
  readonly #target: ProxyTarget
  readonly #now: () => number
  readonly #answers = new Map<string, Answer>()
  readonly #asking = new Map<string, Promise<void>>()
  #applied: AppliedRule | null = null
  #pending: Promise<void> | null = null
  #generation = 0

  constructor(target: ProxyTarget, now: () => number = Date.now) {
    this.#target = target
    this.#now = now
  }

  /** The `setProxy` still under way, or `null` once the session runs under its rule. */
  get pending(): Promise<void> | null {
    return this.#pending
  }

  /**
   * Applies a rule, then closes the connections made under the one before.
   *
   * Never rejects. A rule Chromium refused leaves the session with no known rule, which the kill switch
   * answers with a refusal until a later rule is applied.
   */
  apply(rule: ProxyRule): Promise<void> {
    this.#generation += 1
    const generation = this.#generation
    this.#forget()
    const current = (): boolean => generation === this.#generation
    const done = this.#target
      .setProxy(rule)
      .then(() => this.#target.closeAllConnections())
      .then(
        () => {
          if (current()) this.#applied = ruleKind(rule)
        },
        (error: unknown) => {
          if (current()) this.#applied = null
          console.warn('[proxy] the rule could not be applied:', error)
        }
      )
      .finally(() => {
        if (!current()) return
        this.#pending = null
        this.#forget()
      })
    this.#pending = done
    return done
  }

  /** Empties the answers, as a network change would. */
  #forget(): void {
    this.#answers.clear()
    this.#asking.clear()
  }

  verdict(url: string): KillSwitchVerdict {
    const key = originKey(url)
    const answer = key === null ? undefined : this.#answerFor(key)
    return killSwitchVerdict({
      pending: this.#pending !== null,
      applied: this.#applied,
      resolved: answer === undefined ? undefined : answer.text
    })
  }

  settle(url: string): Promise<void> {
    return withDeadline(this.#settle(url), RESOLVE_DEADLINE_MS)
  }

  /** Waits for any pending rule, never rejecting. What the main process's own fetches wait on. */
  async ready(): Promise<void> {
    // A loop, because the rule can change again while the previous one is being applied.
    while (this.#pending !== null) await this.#pending
  }

  async #settle(url: string): Promise<void> {
    await this.ready()
    const key = originKey(url)
    const target = resolveTarget(url)
    if (this.#applied !== 'system' || key === null || target === null) return
    if (this.#answerFor(key) !== undefined) return
    const asking = this.#asking.get(key) ?? this.#ask(key, target)
    await asking
  }

  #ask(key: string, target: string): Promise<void> {
    const generation = this.#generation
    const store = (text: string | null): void => {
      if (generation !== this.#generation) return
      this.#answers.set(key, { text, at: this.#now() })
      this.#asking.delete(key)
    }
    const asking = this.#target.resolveProxy(target).then(store, () => {
      store(null)
    })
    this.#asking.set(key, asking)
    return asking
  }

  #answerFor(key: string): Answer | undefined {
    const answer = this.#answers.get(key)
    if (answer === undefined || this.#now() - answer.at < CACHE_TTL_MS) return answer
    this.#answers.delete(key)
    return undefined
  }
}

/** The settings this file follows. `SettingsStore` satisfies it. */
export type NetworkSettings = Pick<SettingsStore, 'snapshot' | 'onChange'>

interface Installed {
  readonly getSettings: () => SettingsSnapshot
  /** The last valid rule, which stays when a change produces none. */
  rule: ProxyRule
}

let installed: Installed | null = null
const gates = new WeakMap<Session, ProxyGate>()
/** Every session with a gate, weakly: a private window's session is not kept alive for this. */
let known: WeakRef<Session>[] = []

/**
 * The gate of a session, created — and given the current rule — the first time it is asked for.
 *
 * `session-created` is what normally asks first, so a session is under the rule before anything can
 * load in it. Asked before `installProxy` has run, a gate has no rule and refuses (see `ProxyGate`).
 */
export function proxyGateFor(session: Session): ProxyGate {
  const existing = gates.get(session)
  if (existing !== undefined) return existing
  const gate = new ProxyGate(session)
  gates.set(session, gate)
  known.push(new WeakRef(session))
  if (installed !== null) void gate.apply(installed.rule)
  return gate
}

function liveGates(): ProxyGate[] {
  const live: ProxyGate[] = []
  known = known.filter((ref) => {
    const session = ref.deref()
    if (session !== undefined) live.push(proxyGateFor(session))
    return session !== undefined
  })
  return live
}

function updaterSession(): Session {
  // The same options `electron-updater` passes; whichever call comes first creates the partition.
  return electronSession.fromPartition(UPDATER_PARTITION, { cache: false })
}

function applyEverywhere(rule: ProxyRule): Promise<unknown> {
  return Promise.all([
    ...liveGates().map((gate) => gate.apply(rule)),
    app.setProxy(rule).catch((error: unknown) => {
      console.warn('[proxy] the rule for session-less requests could not be applied:', error)
    })
  ])
}

function onChange(changed: Record<string, unknown>, snapshot: SettingsSnapshot): void {
  if ('network.secureDnsMode' in changed || 'network.secureDnsServers' in changed) {
    applySecureDns(snapshot)
  }
  if (
    installed !== null &&
    ('network.proxyMode' in changed ||
      'network.proxyUrl' in changed ||
      'network.killSwitch' in changed)
  ) {
    const next = proxyRuleFor(snapshot)
    if (!next.ok) {
      // Not applied, and the rule before stays. The kill switch refuses what that rule would let out.
      console.warn(`[proxy] the manual address is not usable (${next.reason}); the last rule stays`)
    } else if (JSON.stringify(next.rule) !== JSON.stringify(installed.rule)) {
      installed.rule = next.rule
      void applyEverywhere(next.rule)
    }
  }
  if ('network.proxyMode' in changed || 'network.webrtcIpPolicy' in changed) {
    // New views get it from `web-contents-created`; these are the ones that already exist.
    for (const contents of webContents.getAllWebContents()) applyWebRtcPolicy(contents, snapshot)
  }
}

/**
 * Puts the rule on every session and keeps it there. Resolves once the default session, the updater's
 * and session-less requests all run under it — startup waits for that before it restores a window or
 * fetches anything.
 */
export async function installProxy(settings: NetworkSettings): Promise<void> {
  if (installed !== null) return
  const getSettings = (): SettingsSnapshot => settings.snapshot()
  applySecureDns(getSettings())
  installWebRtcPolicy(getSettings)

  app.on('session-created', (session) => {
    proxyGateFor(session)
  })
  // Created now rather than at the first update check, so it exists under the rule from the start.
  const updater = updaterSession()
  installKillSwitchOnly({ session: updater, getSettings, killSwitch: proxyGateFor(updater) })
  proxyGateFor(electronSession.defaultSession)

  // Set only now, so the gates above get the rule once, below, rather than once each and again.
  const first = proxyRuleFor(getSettings())
  if (!first.ok) {
    console.warn(`[proxy] the manual address is not usable (${first.reason}); starting closed`)
  }
  installed = { getSettings, rule: first.ok ? first.rule : first.fallback }
  settings.onChange(({ changed, snapshot }) => {
    onChange(changed, snapshot)
  })
  // Bounded, so a `setProxy` that never answers cannot keep the browser from starting. A request made
  // before it answers is still held by the kill switch, and a first load still waits for it.
  await withDeadline(
    applyEverywhere(installed.rule).then(() => {}),
    RESOLVE_DEADLINE_MS
  )
}

/**
 * Starts a tab's first load once its session runs under the rule; at once when it already does.
 *
 * What keeps `createWindow` synchronous while a private window's first page still waits for the
 * `setProxy` its brand-new session was given.
 */
export function loadAfterProxyRule(
  session: Session,
  tab: { loadUrl(url: string): void },
  url: string
): void {
  const pending = proxyGateFor(session).pending
  if (pending === null) {
    tab.loadUrl(url)
    return
  }
  void pending
    .then(() => {
      tab.loadUrl(url)
    })
    // A tab closed before its session was ready has nothing to load into.
    .catch(() => {})
}

/**
 * The main process's own requests — the Public Suffix List, filter lists, favicons.
 *
 * `net.fetch` on the default session, after its rule is applied, and refused outright where the kill
 * switch would refuse a page's request to the same origin: a list download is a request to a third
 * party like any other, and exactly the one a user set a proxy up for.
 */
export async function networkFetch(url: string): Promise<Response> {
  const gate = proxyGateFor(electronSession.defaultSession)
  await gate.ready()
  const settings = installed?.getSettings()
  if (settings !== undefined && killSwitchActive(settings) && originKey(url) !== null) {
    if (gate.verdict(url) === 'unknown') await gate.settle(url)
    if (gate.verdict(url) !== 'pass') {
      throw new Error(`the kill switch refused ${originKey(url) ?? url}: no proxy confirmed`)
    }
  }
  return net.fetch(url)
}

/** What an update check or download waits for before it asks the network. */
export function updaterNetworkReady(): Promise<void> {
  return proxyGateFor(updaterSession()).ready()
}

/** The address the settings page's check asks about. Only `resolveProxy` sees it; nothing is sent. */
export const PROBE_URL = 'https://www.example.com/'

/**
 * Whether the rule now in force would send a test address directly (U13).
 *
 * What the settings page asks right after somebody chose the system setting with the kill switch on, so
 * a PAC script that answers `DIRECT` is found out at once rather than as a page that will not load.
 */
export async function probeSystemProxy(): Promise<{ direct: boolean }> {
  const session = electronSession.defaultSession
  await proxyGateFor(session).ready()
  const answer = await session.resolveProxy(PROBE_URL).catch(() => '')
  return { direct: allowsDirect(answer) }
}
