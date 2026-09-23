import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { domainToASCII } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { FILTER_LIST_CACHE_DIRNAME, FilterListStore } from '@main/privacy/FilterListStore.js'
import {
  PUBLIC_SUFFIX_ATTEMPT_INTERVAL_MS,
  PUBLIC_SUFFIX_CONFIRM_MS,
  PUBLIC_SUFFIX_DIRNAME,
  PUBLIC_SUFFIX_LIST_URL,
  PUBLIC_SUFFIX_MAX_AGE_MS,
  PublicSuffixSubscription,
  readPublicSuffixBody,
  type PublicSuffixResponse
} from '@main/privacy/PublicSuffixSubscription.js'
import { registrableDomain, resetPublicSuffixes } from '@shared/url/domain.js'
import { PUBLIC_SUFFIX_MAX_BYTES } from '@shared/url/public-suffix.js'
import {
  fillerPrivate,
  fixtureRules,
  fixtureText,
  withAdded,
  without
} from './public-suffix-fixture.js'

/**
 * `PublicSuffixSubscription`: when the list is asked for, what is stored, and what is put in force.
 *
 * The run-level property (R7) is checked the only way it can be: by starting a second subscription
 * over the same directory, which is what the next launch does, after resetting the process-wide
 * rules the way a new process has them.
 */

const DAY = 24 * 60 * 60 * 1000
const T0 = 1_700_000_000_000

const GOOD = fixtureText(fixtureRules())
const GOOD_TOO = fixtureText(withAdded(fixtureRules(), 'icann', ['added.zz']))
const WITHOUT_COM_SG = fixtureText(without(fixtureRules(), ['com.sg']))
const WITH_STAR_COM = fixtureText(withAdded(fixtureRules(), 'icann', ['*.com']))
const PRIVATE_LOSS = fixtureText(without(fixtureRules(), fillerPrivate(0, 20)))
const HTML = '<html><body>Service unavailable</body></html>'

interface Harness {
  readonly root: string
  readonly directory: string
  readonly fetchList: Mock<(url: string) => Promise<string>>
  readonly warn: ReturnType<typeof vi.fn>
  serve(body: string | Error): void
  setNow(value: number): void
  /** A new subscription over the same directory: the next launch. */
  launch(): PublicSuffixSubscription
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'tessera-psl-'))
  const directory = join(root, PUBLIC_SUFFIX_DIRNAME)
  let now = T0
  let body: string | Error = new Error('offline')
  const fetchList = vi.fn((url: string): Promise<string> => {
    expect(url).toBe(PUBLIC_SUFFIX_LIST_URL)
    return body instanceof Error ? Promise.reject(body) : Promise.resolve(body)
  })
  const warn = vi.fn()
  return {
    root,
    directory,
    fetchList,
    warn,
    serve: (next) => {
      body = next
    },
    setNow: (value) => {
      now = value
    },
    launch: () =>
      new PublicSuffixSubscription({
        directory,
        fetchList,
        toAscii: domainToASCII,
        now: () => now,
        warn
      })
  }
}

/** A launch that puts in force what is on disk, as `main()` does, with fresh process-wide rules. */
async function restart(h: Harness): Promise<string> {
  resetPublicSuffixes()
  return h.launch().load()
}

async function state(h: Harness): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(h.directory, 'state.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

async function listFiles(h: Harness): Promise<Record<string, string>> {
  const directory = join(h.directory, 'list')
  const files: Record<string, string> = {}
  for (const name of await readdir(directory)) {
    files[name] = await readFile(join(directory, name), 'utf8')
  }
  return files
}

/** Accepts GOOD at T0, which is where most scenarios start. */
async function acceptedAtT0(): Promise<Harness> {
  const h = await harness()
  h.serve(GOOD)
  expect((await h.launch().refresh()).status).toBe('accepted')
  return h
}

beforeEach(() => {
  resetPublicSuffixes()
})
afterEach(() => {
  resetPublicSuffixes()
})

describe('PublicSuffixSubscription: the first start', () => {
  it('runs on the bootstrap offline, without an error, and asks again at the next start', async () => {
    const h = await harness()
    expect(await h.launch().load()).toBe('bootstrap')
    expect(h.warn).not.toHaveBeenCalled()

    const offline = await h.launch().refresh()
    expect(offline).toEqual({ status: 'failed', rejections: [], reason: 'offline' })
    expect(h.fetchList).toHaveBeenCalledTimes(1)

    h.setNow(T0 + PUBLIC_SUFFIX_ATTEMPT_INTERVAL_MS)
    h.serve(GOOD)
    expect((await h.launch().refresh()).status).toBe('accepted')
    expect(h.fetchList).toHaveBeenCalledTimes(2)
  })

  it('does not ask again on a restart the same day, whatever came of the attempt', async () => {
    const h = await harness()
    await h.launch().refresh()
    h.setNow(T0 + PUBLIC_SUFFIX_ATTEMPT_INTERVAL_MS - 1)
    expect(await h.launch().refresh()).toEqual({ status: 'skipped', rejections: [], reason: null })
    expect(h.fetchList).toHaveBeenCalledTimes(1)
  })

  it('records the attempt before the request goes out', async () => {
    const h = await harness()
    let recorded: unknown = null
    h.fetchList.mockImplementationOnce(async () => {
      recorded = (await state(h)).lastAttemptAt
      throw new Error('hung up')
    })
    await h.launch().refresh()
    expect(recorded).toBe(T0)
  })
})

describe('PublicSuffixSubscription: a run keeps its list (R7, AE4)', () => {
  it('does not change registrableDomain when a list is downloaded mid-run', async () => {
    const h = await harness()
    const subscription = h.launch()
    expect(await subscription.load()).toBe('bootstrap')
    const before = registrableDomain('bank.com.sg')

    h.serve(GOOD)
    expect((await subscription.refresh()).status).toBe('accepted')
    expect(registrableDomain('bank.com.sg')).toBe(before)
    expect(before).toBe('com.sg')

    // The next launch has it.
    expect(await restart(h)).toBe('list')
    expect(registrableDomain('bank.com.sg')).toBe('bank.com.sg')
    expect(registrableDomain('evil.com.sg')).toBe('evil.com.sg')
  })
})

describe('PublicSuffixSubscription: an accepted list', () => {
  it('is kept for a week without asking again', async () => {
    const h = await acceptedAtT0()
    h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS - 1)
    expect((await h.launch().refresh()).status).toBe('fresh')
    expect(h.fetchList).toHaveBeenCalledTimes(1)
  })

  it('becomes the baseline when it is the first, and the previous list when replaced', async () => {
    const h = await acceptedAtT0()
    expect((await state(h)).baseline).toEqual({ text: GOOD, acceptedAt: T0 })
    expect((await state(h)).previous).toBeNull()

    h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS)
    h.serve(GOOD_TOO)
    expect((await h.launch().refresh()).status).toBe('accepted')
    expect((await state(h)).previous).toEqual({ text: GOOD, acceptedAt: T0 })
    // Not a month old yet, so the baseline stays where it was.
    expect((await state(h)).baseline).toEqual({ text: GOOD, acceptedAt: T0 })
  })

  it('moves the baseline up to the list in force once it is a month old', async () => {
    const h = await acceptedAtT0()
    h.setNow(T0 + 10 * DAY)
    h.serve(GOOD_TOO)
    await h.launch().refresh()

    // Exactly thirty days after the baseline was accepted.
    h.setNow(T0 + 30 * DAY)
    h.serve(GOOD)
    await h.launch().refresh()
    // Rolled to what was in force when the attempt began — GOOD_TOO, accepted on day ten.
    expect((await state(h)).baseline).toEqual({ text: GOOD_TOO, acceptedAt: T0 + 10 * DAY })
  })

  it('takes the baseline from the list in force when the state file is gone', async () => {
    const h = await acceptedAtT0()
    await writeFile(join(h.directory, 'state.json'), '{ not json')
    h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS)
    h.serve(GOOD_TOO)
    expect((await h.launch().refresh()).status).toBe('accepted')
    expect((await state(h)).baseline).toEqual({ text: GOOD, acceptedAt: T0 })
  })
})

describe('PublicSuffixSubscription: a refused list', () => {
  it('leaves the list and its manifest untouched, and the next start on the old list', async () => {
    const h = await acceptedAtT0()
    const before = await listFiles(h)

    h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS)
    h.serve(WITHOUT_COM_SG)
    const refused = await h.launch().refresh()
    expect(refused).toEqual({
      status: 'rejected',
      rejections: ['icann-removed', 'canary'],
      reason: null
    })
    expect(await listFiles(h)).toEqual(before)
    expect(h.warn).toHaveBeenCalledWith('[public-suffix] refused a downloaded list:', [
      'icann-removed',
      'canary'
    ])

    expect(await restart(h)).toBe('list')
    expect(registrableDomain('bank.com.sg')).toBe('bank.com.sg')
  })

  it('refuses an HTML page', async () => {
    const h = await acceptedAtT0()
    h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS)
    h.serve(HTML)
    expect((await h.launch().refresh()).rejections).toEqual(['structure'])
  })

  it('refuses a list without com.sg, or with *.com, however often it is delivered', async () => {
    for (const candidate of [WITHOUT_COM_SG, WITH_STAR_COM]) {
      const h = await acceptedAtT0()
      h.serve(candidate)
      h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS)
      expect((await h.launch().refresh()).status).toBe('rejected')
      h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS + PUBLIC_SUFFIX_CONFIRM_MS)
      expect((await h.launch().refresh()).status).toBe('rejected')
    }
  })

  it('accepts a list that only lost PRIVATE rules once the same body arrives a week later', async () => {
    const h = await acceptedAtT0()
    const first = T0 + PUBLIC_SUFFIX_MAX_AGE_MS
    h.serve(PRIVATE_LOSS)

    h.setNow(first)
    expect((await h.launch().refresh()).rejections).toEqual(['private-removed'])
    const digest = createHash('sha256').update(PRIVATE_LOSS).digest('hex')
    expect((await state(h)).rejected).toEqual({ sha256: digest, firstRejectedAt: first })

    // A day later is not a week later.
    h.setNow(first + DAY)
    expect((await h.launch().refresh()).status).toBe('rejected')
    expect((await state(h)).rejected).toEqual({ sha256: digest, firstRejectedAt: first })

    h.setNow(first + PUBLIC_SUFFIX_CONFIRM_MS)
    expect(await h.launch().refresh()).toEqual({
      status: 'accepted',
      rejections: ['private-removed'],
      reason: null
    })
    expect((await state(h)).rejected).toBeNull()
    expect(await restart(h)).toBe('list')
  })

  it('starts the week again when a different body is refused in between', async () => {
    const h = await acceptedAtT0()
    const first = T0 + PUBLIC_SUFFIX_MAX_AGE_MS
    h.setNow(first)
    h.serve(PRIVATE_LOSS)
    await h.launch().refresh()

    h.setNow(first + DAY)
    h.serve(fixtureText(without(fixtureRules(), fillerPrivate(0, 21))))
    await h.launch().refresh()
    expect((await state(h)).rejected).toMatchObject({ firstRejectedAt: first + DAY })

    // The first body again, a week after it was first refused — but it is no longer the one on
    // record, so its week starts over.
    h.setNow(first + PUBLIC_SUFFIX_CONFIRM_MS)
    h.serve(PRIVATE_LOSS)
    expect((await h.launch().refresh()).status).toBe('rejected')
  })

  it('reports a failure, and changes nothing, when an accepted list cannot be stored', async () => {
    const h = await harness()
    // A directory where the cache file has to go makes the rename fail.
    const digest = createHash('sha256').update(PUBLIC_SUFFIX_LIST_URL).digest('hex').slice(0, 16)
    await mkdir(join(h.directory, 'list', `publicsuffix.org-${digest}.txt`, 'blocker'), {
      recursive: true
    })
    h.serve(GOOD)
    const outcome = await h.launch().refresh()
    expect(outcome.status).toBe('failed')
    expect(outcome.reason).not.toBeNull()
    expect((await state(h)).baseline).toBeNull()
    expect(await restart(h)).toBe('bootstrap')
  })
})

describe('PublicSuffixSubscription: startup fallbacks', () => {
  async function twoAccepted(): Promise<Harness> {
    const h = await acceptedAtT0()
    h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS)
    h.serve(GOOD_TOO)
    await h.launch().refresh()
    return h
  }

  async function overwriteCache(h: Harness, text: string): Promise<void> {
    const directory = join(h.directory, 'list')
    for (const name of await readdir(directory)) {
      if (name.endsWith('.txt')) await writeFile(join(directory, name), text)
    }
  }

  it('uses the previous good list, with a warning, when the cached one fails its check', async () => {
    const h = await twoAccepted()
    await overwriteCache(h, HTML)
    expect(await restart(h)).toBe('previous')
    expect(registrableDomain('bank.com.sg')).toBe('bank.com.sg')
    expect(h.warn).toHaveBeenCalledWith('[public-suffix] the stored list failed its check:', [
      'structure'
    ])
    expect(h.warn).toHaveBeenCalledWith('[public-suffix] using the previous good list', null)
  })

  it('falls back to the bootstrap, with a warning, when the previous list fails too', async () => {
    const h = await twoAccepted()
    await overwriteCache(h, 'x'.repeat(PUBLIC_SUFFIX_MAX_BYTES + 1))
    const saved = await state(h)
    await writeFile(
      join(h.directory, 'state.json'),
      JSON.stringify({ ...saved, previous: { text: HTML, acceptedAt: T0 } })
    )
    expect(await restart(h)).toBe('bootstrap')
    expect(registrableDomain('bank.com.sg')).toBe('com.sg')
    expect(h.warn).toHaveBeenCalledWith('[public-suffix] the stored list failed its check:', [
      'too-large'
    ])
    expect(h.warn).toHaveBeenCalledWith('[public-suffix] the previous list failed its check:', [
      'structure'
    ])
    expect(h.warn).toHaveBeenCalledWith(
      '[public-suffix] no stored list is usable; using the built-in suffixes',
      null
    )
  })

  it('treats a state file of the wrong shape as no state', async () => {
    const h = await harness()
    await mkdir(h.directory, { recursive: true })
    await writeFile(join(h.directory, 'state.json'), JSON.stringify({ version: 2 }))
    expect(await h.launch().load()).toBe('bootstrap')
    h.serve(GOOD)
    expect((await h.launch().refresh()).status).toBe('accepted')
  })
})

describe('PublicSuffixSubscription: its directory', () => {
  it('keeps the baseline and the previous list through a refresh of its own list', async () => {
    const h = await acceptedAtT0()
    h.setNow(T0 + PUBLIC_SUFFIX_MAX_AGE_MS)
    h.serve(GOOD_TOO)
    await h.launch().refresh()
    // The list's store prunes what its manifest does not name; the state is beside it, not in it.
    expect(await readdir(h.directory)).toEqual(expect.arrayContaining(['list', 'state.json']))
    expect((await state(h)).previous).not.toBeNull()
    expect((await state(h)).baseline).not.toBeNull()
  })

  it('survives a refresh of the filter lists', async () => {
    const h = await acceptedAtT0()
    const filters = new FilterListStore({
      directory: join(h.root, FILTER_LIST_CACHE_DIRNAME),
      fetchList: () => Promise.resolve('||ads.example^'),
      now: () => T0
    })
    await filters.refresh(['https://easylist.to/easylist/easylist.txt'])
    expect((await state(h)).baseline).not.toBeNull()
    expect(await restart(h)).toBe('list')
  })
})

describe('PublicSuffixSubscription: refreshes', () => {
  it('runs one refresh at a time, so the second sees the first attempt', async () => {
    const h = await harness()
    h.serve(GOOD)
    const subscription = h.launch()
    const [first, second] = await Promise.all([subscription.refresh(), subscription.refresh()])
    expect(first.status).toBe('accepted')
    expect(second.status).toBe('skipped')
    await subscription.whenIdle()
    expect(h.fetchList).toHaveBeenCalledTimes(1)
  })

  it('lets a failed refresh reject its caller without stopping the next', async () => {
    const h = await harness()
    // A file where the directory has to be makes the state write fail.
    await writeFile(h.directory, 'in the way')
    const subscription = h.launch()
    await expect(subscription.refresh()).rejects.toThrow()
    await expect(subscription.whenIdle()).resolves.toBeUndefined()
  })

  it('defaults to the clock and to console.warn', async () => {
    const h = await harness()
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const subscription = new PublicSuffixSubscription({
        directory: h.directory,
        fetchList: () => Promise.resolve(HTML),
        toAscii: domainToASCII
      })
      expect((await subscription.refresh()).status).toBe('rejected')
      expect(spy).toHaveBeenCalledWith('[public-suffix] refused a downloaded list:', ['structure'])
      expect((await state(h)).lastAttemptAt).toBeGreaterThan(T0)
    } finally {
      spy.mockRestore()
    }
  })
})

/** A response as `net.fetch` gives one, its body in the pieces a network delivers. */
function response(
  chunks: readonly (string | Uint8Array)[] | null,
  overrides: Partial<PublicSuffixResponse> = {}
): PublicSuffixResponse {
  const encoder = new TextEncoder()
  return {
    ok: true,
    status: 200,
    url: PUBLIC_SUFFIX_LIST_URL,
    body:
      chunks === null
        ? null
        : (async function* () {
            for (const chunk of chunks) {
              // A network hands a body over a piece at a time, never all at once.
              await Promise.resolve()
              yield typeof chunk === 'string' ? encoder.encode(chunk) : chunk
            }
          })(),
    ...overrides
  }
}

describe('readPublicSuffixBody', () => {
  it('joins a body that arrives in pieces', async () => {
    expect(await readPublicSuffixBody(response(['// ===BEGIN', ' ICANN DOMAINS===\n']))).toBe(
      '// ===BEGIN ICANN DOMAINS===\n'
    )
  })

  it('reads the Response a fetch gives', async () => {
    // The type `net.fetch` resolves to, so the wiring needs no adapter.
    const real = new Response('// ===BEGIN ICANN DOMAINS===\n')
    Object.defineProperty(real, 'url', { value: PUBLIC_SUFFIX_LIST_URL })
    expect(await readPublicSuffixBody(real)).toBe('// ===BEGIN ICANN DOMAINS===\n')
  })

  it('reads a missing body as empty, which the check then refuses', async () => {
    expect(await readPublicSuffixBody(response(null))).toBe('')
  })

  it('refuses an error status', async () => {
    await expect(readPublicSuffixBody(response([], { ok: false, status: 503 }))).rejects.toThrow(
      'HTTP 503'
    )
  })

  it('refuses an answer from anywhere but the list address', async () => {
    const redirected = response(['x'], { url: 'https://mirror.example/public_suffix_list.dat' })
    await expect(readPublicSuffixBody(redirected)).rejects.toThrow(/not https:\/\/publicsuffix.org/)
  })

  it('stops reading once the body passes the limit', async () => {
    const pulled: number[] = []
    const endless: PublicSuffixResponse = {
      ...response([]),
      body: (async function* () {
        for (let index = 0; ; index++) {
          await Promise.resolve()
          pulled.push(index)
          yield new Uint8Array(4)
        }
      })()
    }
    await expect(readPublicSuffixBody(endless, 10)).rejects.toThrow('body larger than 10 bytes')
    expect(pulled).toHaveLength(3)
  })

  it('takes a body of exactly the limit', async () => {
    expect(await readPublicSuffixBody(response(['12345', '67890']), 10)).toBe('1234567890')
  })

  it('refuses bytes that are not UTF-8', async () => {
    await expect(readPublicSuffixBody(response([new Uint8Array([0xff, 0xfe])]))).rejects.toThrow()
  })
})
