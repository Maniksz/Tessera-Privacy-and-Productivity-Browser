import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import type * as ProxyModule from '@main/session/proxy.js'
import type * as PipelineModule from '@main/privacy/RequestPipeline.js'

/**
 * The proxy on real sessions, as far as a fake Electron lets it be (U13, R20–R24, KTD8).
 *
 * `main/session/proxy.ts` is plumbing over five Electron calls, and its whole promise is about their
 * order: the rule before the first request, `closeAllConnections` after every change, every session
 * including the ones nobody listed, and a kill switch that holds rather than guesses. None of that is a
 * wrong answer from a pure function; all of it is two calls in the wrong order, which is what a fake
 * application object can catch.
 *
 * `network.killSwitch` is tested for its *behaviour* here, not only for having a reader.
 */

type Listener = (details: unknown, callback: (response: unknown) => void) => void

interface Deferred {
  promise: Promise<void>
  resolve(): void
}

function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const electron = vi.hoisted(() => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>()
  const partitions = new Map<string, unknown>()
  const views: unknown[] = []
  /** Replaced per test by `fakeSession('default')`. */
  const current: { defaultSession: unknown } = { defaultSession: null }
  return {
    handlers,
    partitions,
    views,
    current,
    makeSession: null as unknown as (name: string) => unknown,
    fetch: null as unknown as (url: string) => Promise<unknown>,
    appProxy: [] as unknown[],
    dns: [] as unknown[],
    appProxyFails: false,
    emit(event: string, ...args: unknown[]): void {
      for (const handler of handlers.get(event) ?? []) handler(...args)
    }
  }
})

vi.mock('electron', () => ({
  app: {
    on(event: string, handler: (...args: unknown[]) => void): void {
      const list = electron.handlers.get(event) ?? []
      list.push(handler)
      electron.handlers.set(event, list)
    },
    setProxy(rule: unknown): Promise<void> {
      electron.appProxy.push(rule)
      return electron.appProxyFails ? Promise.reject(new Error('refused')) : Promise.resolve()
    },
    configureHostResolver(options: unknown): void {
      electron.dns.push(options)
    }
  },
  session: {
    get defaultSession(): unknown {
      return electron.current.defaultSession
    },
    fromPartition(name: string, options?: unknown): unknown {
      const existing = electron.partitions.get(name)
      if (existing !== undefined) return existing
      const created = electron.makeSession(name) as { options?: unknown }
      created.options = options
      electron.partitions.set(name, created)
      // Electron emits it while the session is being made, before `fromPartition` returns.
      electron.emit('session-created', created)
      return created
    }
  },
  webContents: {
    getAllWebContents: (): unknown[] => electron.views
  },
  net: {
    fetch: (url: string): Promise<unknown> => electron.fetch(url)
  }
}))

interface FakeSession {
  readonly name: string
  options?: unknown
  readonly rules: unknown[]
  readonly calls: string[]
  /** Set to hold the next `setProxy` until its `resolve` is called. */
  hold: Deferred | null
  /** `resolveProxy` answers by URL; an address with none never answers. */
  readonly answers: Record<string, string | Error>
  readonly resolved: string[]
  listener: Listener | null
  setProxy(rule: unknown): Promise<void>
  closeAllConnections(): Promise<void>
  resolveProxy(url: string): Promise<string>
  webRequest: { onBeforeRequest(listener: Listener | null): void }
}

function fakeSession(name: string): FakeSession {
  const session: FakeSession = {
    name,
    rules: [],
    calls: [],
    hold: null,
    answers: {},
    resolved: [],
    listener: null,
    async setProxy(rule) {
      session.calls.push('setProxy')
      session.rules.push(rule)
      const hold = session.hold
      session.hold = null
      if (hold !== null) await hold.promise
    },
    closeAllConnections() {
      session.calls.push('closeAllConnections')
      return Promise.resolve()
    },
    resolveProxy(url) {
      session.resolved.push(url)
      const answer = session.answers[url]
      if (answer === undefined) return new Promise<string>(() => {})
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)
    },
    webRequest: {
      onBeforeRequest(listener) {
        session.listener = listener
      }
    }
  }
  return session
}

/** A settings store with the one method pair `installProxy` uses. */
function store(initial: Partial<SettingsSnapshot> = {}) {
  let snapshot: SettingsSnapshot = { ...defaultSettings(), ...initial }
  const listeners: Array<
    (change: { changed: Record<string, unknown>; snapshot: SettingsSnapshot }) => void
  > = []
  return {
    snapshot: () => snapshot,
    onChange(listener: (typeof listeners)[number]) {
      listeners.push(listener)
      return () => {}
    },
    set(patch: Partial<SettingsSnapshot>) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener({ changed: { ...patch }, snapshot })
    }
  }
}

const MANUAL = { 'network.proxyMode': 'manual', 'network.proxyUrl': 'http://proxy:8080' } as const
const SYSTEM = { 'network.proxyMode': 'system' } as const

let proxy: typeof ProxyModule
let pipeline: typeof PipelineModule
let defaultSession: FakeSession
let fetched: string[]

beforeEach(async () => {
  vi.resetModules()
  electron.handlers.clear()
  electron.partitions.clear()
  electron.views.length = 0
  electron.appProxy.length = 0
  electron.dns.length = 0
  electron.appProxyFails = false
  electron.makeSession = fakeSession
  defaultSession = fakeSession('default')
  electron.current.defaultSession = defaultSession
  fetched = []
  electron.fetch = (url) => {
    fetched.push(url)
    return Promise.resolve({ ok: true })
  }
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  proxy = await import('@main/session/proxy.js')
  pipeline = await import('@main/privacy/RequestPipeline.js')
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function updater(): FakeSession {
  return electron.partitions.get('electron-updater') as FakeSession
}

function privateSession(n: number): FakeSession {
  const created = fakeSession(`private-${String(n)}`)
  electron.partitions.set(created.name, created)
  electron.emit('session-created', created)
  return created
}

/** The full pipeline on a session, with that session's real gate — what `WindowRegistry` wires. */
function pipelineOn(session: FakeSession, settings: ReturnType<typeof store>): Listener {
  pipeline.installRequestPipeline({
    session: session as never,
    getSettings: settings.snapshot,
    filterEngine: null,
    killSwitch: proxy.proxyGateFor(session as never)
  })
  return session.listener!
}

function request(listener: Listener, url: string, resourceType = 'mainFrame') {
  const answer = vi.fn()
  listener({ url, resourceType, method: 'GET' }, answer)
  return answer
}

describe('the rule on every session (R20)', () => {
  it('puts the rule on the default session before startup goes on', async () => {
    const hold = deferred()
    defaultSession.hold = hold
    const settings = store(MANUAL)
    let done = false
    const installing = proxy.installProxy(settings).then(() => {
      done = true
    })
    await Promise.resolve()
    expect(defaultSession.rules).toEqual([
      { mode: 'fixed_servers', proxyRules: 'http://proxy:8080' }
    ])
    expect(done, 'startup went on before the default session had its rule').toBe(false)
    hold.resolve()
    await installing
    expect(done).toBe(true)
  })

  it('closes the connections made under the rule before, after every setProxy', async () => {
    await proxy.installProxy(store(MANUAL))
    expect(defaultSession.calls).toEqual(['setProxy', 'closeAllConnections'])
  })

  it('applies it to session-less requests too', async () => {
    await proxy.installProxy(store(MANUAL))
    expect(electron.appProxy).toEqual([{ mode: 'fixed_servers', proxyRules: 'http://proxy:8080' }])
  })

  it('starts anyway when the session-less rule is refused, and says so', async () => {
    electron.appProxyFails = true
    await proxy.installProxy(store(MANUAL))
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('session-less'),
      expect.any(Error)
    )
  })

  it('gives a session created later the rule, with no list anywhere', async () => {
    await proxy.installProxy(store(MANUAL))
    const created = privateSession(1)
    expect(created.rules).toEqual([{ mode: 'fixed_servers', proxyRules: 'http://proxy:8080' }])
  })

  it('creates the updater partition at startup, as electron-updater would, under the rule', async () => {
    await proxy.installProxy(store(MANUAL))
    expect(updater().options).toEqual({ cache: false })
    expect(updater().rules).toHaveLength(1)
    expect(updater().listener, 'the updater has no kill switch').not.toBeNull()
  })

  it('applies a change live, to every session, once', async () => {
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    const created = privateSession(1)
    settings.set({ 'network.proxyUrl': 'socks5h://tor:9050' })
    await Promise.resolve()
    const rule = { mode: 'fixed_servers', proxyRules: 'socks5://tor:9050' }
    for (const session of [defaultSession, updater(), created]) {
      expect(session.rules.at(-1), session.name).toEqual(rule)
    }
    expect(defaultSession.rules).toHaveLength(2)
    expect(electron.appProxy.at(-1)).toEqual(rule)
  })

  it('does not reapply what did not change', async () => {
    const settings = store(SYSTEM)
    await proxy.installProxy(settings)
    // System mode's rule does not depend on the kill switch; the stage does.
    settings.set({ 'network.killSwitch': false })
    settings.set({ 'appearance.theme': 'dark' })
    expect(defaultSession.rules).toHaveLength(1)
  })

  it('keeps the last valid rule when the address becomes unusable', async () => {
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    for (const url of ['', 'not a url', 'socks4://h:1080']) {
      settings.set({ 'network.proxyUrl': url })
    }
    expect(defaultSession.rules).toEqual([
      { mode: 'fixed_servers', proxyRules: 'http://proxy:8080' }
    ])
  })

  it('starts closed when a stored manual address is unusable and the kill switch is on', async () => {
    await proxy.installProxy(store({ 'network.proxyMode': 'manual', 'network.proxyUrl': '' }))
    expect(defaultSession.rules).toEqual([
      { mode: 'fixed_servers', proxyRules: 'http://127.0.0.1:9' }
    ])
  })

  it('installs once', async () => {
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    await proxy.installProxy(settings)
    expect(defaultSession.rules).toHaveLength(1)
  })

  it('applies secure DNS at startup and again when it changes, from the same listener', async () => {
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    expect(electron.dns).toHaveLength(1)
    settings.set({ 'network.secureDnsMode': 'off' })
    settings.set({ 'network.secureDnsServers': ['https://dns.example/q'] })
    expect(electron.dns).toHaveLength(3)
    expect(electron.dns[1]).toMatchObject({ secureDnsMode: 'off', secureDnsServers: [] })
  })
})

describe('network.killSwitch, by behaviour (R21, AE6)', () => {
  it('leaves no direct way in the rule while on, and one while off', async () => {
    const settings = store({ ...MANUAL, 'network.proxyUrl': 'socks5://127.0.0.1:9050' })
    await proxy.installProxy(settings)
    expect(defaultSession.rules.at(-1)).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:9050'
    })
    settings.set({ 'network.killSwitch': false })
    await Promise.resolve()
    expect(defaultSession.rules.at(-1)).toEqual({
      mode: 'fixed_servers',
      proxyRules: 'socks5://127.0.0.1:9050,direct://'
    })
  })

  it('lets a manual-mode request reach Chromium, which fails it closed with -130 itself', async () => {
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    const listener = pipelineOn(defaultSession, settings)
    expect(request(listener, 'https://example.com/')).toHaveBeenCalledWith({})
    // No `resolveProxy` in manual mode: the rule has no way out to look for.
    expect(defaultSession.resolved).toEqual([])
  })

  it('blocks every request while a rule change is pending', async () => {
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    const listener = pipelineOn(defaultSession, settings)
    const change = deferred()
    defaultSession.hold = change
    settings.set({ 'network.proxyUrl': 'http://other:3128' })
    const main = request(listener, 'https://example.com/')
    const image = request(listener, 'https://cdn.example/a.png', 'image')
    await Promise.resolve()
    expect(main).not.toHaveBeenCalled()
    expect(image).not.toHaveBeenCalled()
    change.resolve()
    await vi.waitFor(() => {
      expect(main).toHaveBeenCalledWith({})
      expect(image).toHaveBeenCalledWith({})
    })
  })

  it('cancels what waited out a rule change that never finished', async () => {
    vi.useFakeTimers()
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    const listener = pipelineOn(defaultSession, settings)
    defaultSession.hold = deferred()
    settings.set({ 'network.proxyUrl': 'http://other:3128' })
    const main = request(listener, 'https://example.com/')
    await vi.advanceTimersByTimeAsync(proxy.RESOLVE_DEADLINE_MS - 1)
    expect(main).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(main).toHaveBeenCalledWith({ cancel: true })
  })

  it('refuses everything once Chromium refused the rule', async () => {
    const settings = store(MANUAL)
    defaultSession.setProxy = () => Promise.reject(new Error('bad rule'))
    await proxy.installProxy(settings)
    const listener = pipelineOn(defaultSession, settings)
    expect(request(listener, 'https://example.com/')).toHaveBeenCalledWith({ cancel: true })
  })
})

describe('the kill switch in system mode (R22)', () => {
  async function system(killSwitch = true) {
    const settings = store({ ...SYSTEM, 'network.killSwitch': killSwitch })
    await proxy.installProxy(settings)
    return { settings, listener: pipelineOn(defaultSession, settings) }
  }

  it('cancels a main frame whose answer is DIRECT', async () => {
    const { listener } = await system()
    defaultSession.answers['https://example.com/'] = 'DIRECT'
    const answer = request(listener, 'https://example.com/path?q')
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith({ cancel: true })
    })
    expect(defaultSession.resolved).toEqual(['https://example.com/'])
  })

  it('cancels one whose answer falls back to DIRECT', async () => {
    const { listener } = await system()
    defaultSession.answers['https://example.com/'] = 'PROXY a:3128; DIRECT'
    const answer = request(listener, 'https://example.com/')
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith({ cancel: true })
    })
  })

  it('lets it through with the kill switch off, without asking', async () => {
    const { listener } = await system(false)
    defaultSession.answers['https://example.com/'] = 'DIRECT'
    expect(request(listener, 'https://example.com/')).toHaveBeenCalledWith({})
    expect(defaultSession.resolved).toEqual([])
  })

  it('lets through what only a proxy may carry', async () => {
    const { listener } = await system()
    defaultSession.answers['https://example.com/'] = 'PROXY a:3128'
    const answer = request(listener, 'https://example.com/')
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith({})
    })
  })

  it('holds a request with no answer until resolveProxy gives one, and never passes it unasked', async () => {
    const { listener } = await system()
    let answer!: (text: string) => void
    defaultSession.resolveProxy = (url) => {
      defaultSession.resolved.push(url)
      return new Promise<string>((resolve) => {
        answer = resolve
      })
    }
    const main = request(listener, 'https://example.com/')
    await Promise.resolve()
    expect(main).not.toHaveBeenCalled()
    answer('PROXY a:3128')
    await vi.waitFor(() => {
      expect(main).toHaveBeenCalledWith({})
    })
  })

  it('holds a foreign subresource with no answer, rather than letting it through', async () => {
    const { listener } = await system()
    defaultSession.answers['https://example.com/'] = 'PROXY a:3128'
    await vi.waitFor(() => {
      expect(request(listener, 'https://example.com/')).toHaveBeenCalledWith({})
    })
    const script = request(listener, 'https://tracker.example/t.js', 'script')
    const socket = request(listener, 'wss://chat.example/s', 'webSocket')
    await Promise.resolve()
    expect(script).not.toHaveBeenCalled()
    expect(socket).not.toHaveBeenCalled()
    // Asked about as the HTTPS request a WebSocket begins as.
    expect(defaultSession.resolved).toContain('https://chat.example/')
  })

  it('asks about a plain WebSocket as the HTTP request it begins as, port and all', async () => {
    const { listener } = await system()
    request(listener, 'ws://chat.example:81/s', 'webSocket')
    request(listener, 'http://chat.example:81/page', 'script')
    // One origin key each — `ws:` and `http:` may take different ways — but the same address asked about.
    await vi.waitFor(() => {
      expect(defaultSession.resolved).toEqual([
        'http://chat.example:81/',
        'http://chat.example:81/'
      ])
    })
  })

  it('cancels a request whose resolveProxy never answers', async () => {
    vi.useFakeTimers()
    const { listener } = await system()
    const main = request(listener, 'https://silent.example/')
    await vi.advanceTimersByTimeAsync(proxy.RESOLVE_DEADLINE_MS - 1)
    expect(main).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(main).toHaveBeenCalledWith({ cancel: true })
  })

  it('cancels a request whose resolveProxy failed', async () => {
    const { listener } = await system()
    defaultSession.answers['https://example.com/'] = new Error('pac failed')
    const answer = request(listener, 'https://example.com/')
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith({ cancel: true })
    })
  })

  it('keeps http and https of one host in two entries', async () => {
    const { listener } = await system()
    defaultSession.answers['http://example.com/'] = 'DIRECT'
    defaultSession.answers['https://example.com/'] = 'PROXY a:3128'
    const plain = request(listener, 'http://example.com/')
    const secure = request(listener, 'https://example.com/')
    await vi.waitFor(() => {
      expect(plain).toHaveBeenCalledWith({ cancel: true })
      expect(secure).toHaveBeenCalledWith({})
    })
    expect(defaultSession.resolved).toEqual(['http://example.com/', 'https://example.com/'])
  })

  it('asks once per origin while an answer is trusted, and again after it expires', async () => {
    vi.useFakeTimers()
    const { listener } = await system()
    defaultSession.answers['https://example.com/'] = 'PROXY a:3128'
    const first = request(listener, 'https://example.com/a')
    const second = request(listener, 'https://example.com/b', 'image')
    await vi.advanceTimersByTimeAsync(0)
    expect(first).toHaveBeenCalledWith({})
    expect(second).toHaveBeenCalledWith({})
    expect(request(listener, 'https://example.com/c', 'image')).toHaveBeenCalledWith({})
    expect(defaultSession.resolved).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(proxy.CACHE_TTL_MS)
    const later = request(listener, 'https://example.com/d')
    await vi.advanceTimersByTimeAsync(0)
    expect(later).toHaveBeenCalledWith({})
    expect(defaultSession.resolved).toHaveLength(2)
  })

  it('empties its answers on setProxy', async () => {
    const { settings, listener } = await system()
    defaultSession.answers['https://example.com/'] = 'PROXY a:3128'
    await vi.waitFor(() => {
      expect(request(listener, 'https://example.com/')).toHaveBeenCalledWith({})
    })
    settings.set({ 'network.proxyMode': 'direct' })
    settings.set(SYSTEM)
    await vi.waitFor(() => {
      expect(defaultSession.rules).toHaveLength(3)
    })
    defaultSession.answers['https://example.com/'] = 'DIRECT'
    const after = request(listener, 'https://example.com/')
    await vi.waitFor(() => {
      expect(after).toHaveBeenCalledWith({ cancel: true })
    })
    expect(defaultSession.resolved).toHaveLength(2)
  })

  it('drops an answer that arrives after the rule changed', async () => {
    const { settings, listener } = await system()
    let late!: (text: string) => void
    defaultSession.resolveProxy = (url) => {
      defaultSession.resolved.push(url)
      return new Promise<string>((resolve) => {
        late = resolve
      })
    }
    request(listener, 'https://example.com/')
    await vi.waitFor(() => {
      expect(defaultSession.resolved).toHaveLength(1)
    })
    settings.set({ 'network.proxyMode': 'direct' })
    settings.set(SYSTEM)
    late('PROXY a:3128')
    await Promise.resolve()
    expect(proxy.proxyGateFor(defaultSession as never).verdict('https://example.com/')).not.toBe(
      'pass'
    )
  })

  it('leaves tessera: and file: alone', async () => {
    const { listener } = await system()
    for (const url of ['tessera://settings', 'file:///tmp/a.html']) {
      expect(request(listener, url), url).toHaveBeenCalledWith({})
    }
    expect(defaultSession.resolved).toEqual([])
  })

  it('cancels an updater fetch whose answer contains DIRECT', async () => {
    await proxy.installProxy(store(SYSTEM))
    updater().answers['https://github.com/'] = 'PROXY a:3128; DIRECT'
    const answer = vi.fn()
    updater().listener!(
      { url: 'https://github.com/o/r/releases.atom', resourceType: 'other', method: 'GET' },
      answer
    )
    await vi.waitFor(() => {
      expect(answer).toHaveBeenCalledWith({ cancel: true })
    })
  })
})

describe('first loads and the main process wait for the rule', () => {
  it('lets a private window load its first page only once setProxy resolved, returning at once', async () => {
    const settings = store(MANUAL)
    await proxy.installProxy(settings)
    const change = deferred()
    const session = fakeSession('private-2')
    session.hold = change
    electron.emit('session-created', session)
    const tab = { loadUrl: vi.fn() }
    // Returns synchronously: `createWindow` stays synchronous.
    expect(proxy.loadAfterProxyRule(session as never, tab, 'https://example.com/')).toBeUndefined()
    await Promise.resolve()
    expect(tab.loadUrl).not.toHaveBeenCalled()
    change.resolve()
    await vi.waitFor(() => {
      expect(tab.loadUrl).toHaveBeenCalledWith('https://example.com/')
    })
  })

  it('loads at once where the rule is already in place', async () => {
    await proxy.installProxy(store(MANUAL))
    const tab = { loadUrl: vi.fn() }
    proxy.loadAfterProxyRule(defaultSession as never, tab, 'https://example.com/')
    expect(tab.loadUrl).toHaveBeenCalledWith('https://example.com/')
  })

  it('swallows a load into a tab closed while its session was still waiting', async () => {
    await proxy.installProxy(store(MANUAL))
    const session = fakeSession('private-3')
    const hold = deferred()
    session.hold = hold
    electron.emit('session-created', session)
    const tab = {
      loadUrl: vi.fn(() => {
        throw new Error('Object has been destroyed')
      })
    }
    proxy.loadAfterProxyRule(session as never, tab, 'https://example.com/')
    hold.resolve()
    // No unhandled rejection is the assertion that matters; vitest fails the run on one.
    await vi.waitFor(() => {
      expect(tab.loadUrl).toHaveBeenCalled()
    })
  })

  it('fetches the Public Suffix List and filter lists only after the first setProxy', async () => {
    const hold = deferred()
    defaultSession.hold = hold
    const settings = store(MANUAL)
    const installing = proxy.installProxy(settings)
    const list = proxy.networkFetch('https://publicsuffix.org/list/public_suffix_list.dat')
    await Promise.resolve()
    expect(fetched).toEqual([])
    hold.resolve()
    await installing
    await list
    expect(fetched).toEqual(['https://publicsuffix.org/list/public_suffix_list.dat'])
  })

  it('refuses a main-process fetch the kill switch would refuse a page', async () => {
    await proxy.installProxy(store(SYSTEM))
    defaultSession.answers['https://easylist.to/'] = 'DIRECT'
    await expect(proxy.networkFetch('https://easylist.to/easylist.txt')).rejects.toThrow(
      /kill switch/
    )
    expect(fetched).toEqual([])
  })

  it('lets a main-process fetch through a confirmed proxy', async () => {
    await proxy.installProxy(store(SYSTEM))
    defaultSession.answers['https://easylist.to/'] = 'PROXY a:3128'
    await proxy.networkFetch('https://easylist.to/easylist.txt')
    expect(fetched).toEqual(['https://easylist.to/easylist.txt'])
  })

  it('lets the updater wait for its own session', async () => {
    await proxy.installProxy(store(MANUAL))
    await expect(proxy.updaterNetworkReady()).resolves.toBeUndefined()
  })
})

describe('WebRTC (R24)', () => {
  function view() {
    return {
      policies: [] as string[],
      setWebRTCIPHandlingPolicy(policy: string) {
        this.policies.push(policy)
      }
    }
  }

  it('gives new and existing views disable_non_proxied_udp once a proxy is in use', async () => {
    const settings = store({ 'network.webrtcIpPolicy': 'default' })
    await proxy.installProxy(settings)
    const existing = view()
    electron.views.push(existing)
    electron.emit('web-contents-created', {}, existing)
    expect(existing.policies).toEqual(['default'])

    settings.set(SYSTEM)
    expect(existing.policies.at(-1)).toBe('disable_non_proxied_udp')
    const fresh = view()
    electron.emit('web-contents-created', {}, fresh)
    expect(fresh.policies).toEqual(['disable_non_proxied_udp'])

    settings.set(MANUAL)
    expect(existing.policies.at(-1)).toBe('disable_non_proxied_udp')
  })

  it('keeps the setting in direct mode, kill switch on, and applies its changes live', async () => {
    const settings = store({ 'network.webrtcIpPolicy': 'default', 'network.killSwitch': true })
    await proxy.installProxy(settings)
    const existing = view()
    electron.views.push(existing)
    electron.emit('web-contents-created', {}, existing)
    settings.set({ 'network.webrtcIpPolicy': 'default_public_interface_only' })
    expect(existing.policies).toEqual(['default', 'default_public_interface_only'])
  })
})

describe('a gate asked for before installProxy', () => {
  it('has no rule, and refuses', () => {
    const gate = proxy.proxyGateFor(defaultSession as never)
    expect(gate.pending).toBeNull()
    expect(gate.verdict('https://example.com/')).toBe('block')
  })
})

describe('the settings page check on the system setting', () => {
  it('reports a direct way for the test address, after the rule is in place', async () => {
    await proxy.installProxy(store(SYSTEM))
    defaultSession.answers[proxy.PROBE_URL] = 'PROXY a:3128; DIRECT'
    await expect(proxy.probeSystemProxy()).resolves.toEqual({ direct: true })
    defaultSession.answers[proxy.PROBE_URL] = 'PROXY a:3128'
    await expect(proxy.probeSystemProxy()).resolves.toEqual({ direct: false })
  })

  it('counts a failed answer as direct, since nothing confirmed a proxy', async () => {
    await proxy.installProxy(store(SYSTEM))
    defaultSession.answers[proxy.PROBE_URL] = new Error('pac failed')
    await expect(proxy.probeSystemProxy()).resolves.toEqual({ direct: true })
  })
})
