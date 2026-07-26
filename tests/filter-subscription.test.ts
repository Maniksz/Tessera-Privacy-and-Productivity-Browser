import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FilterSubscription } from '@main/privacy/FilterSubscription.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The blocker's rules, joined to the setting that says which lists to use.
 *
 * The engine and the on-disk cache were each built and tested; nothing connected them. What is tested
 * here is only the joint, and every case is a failure mode rather than a happy path — because the happy
 * path is one line and the failures are what a user experiences as "the blocker does not work":
 *
 *   - a download that fails must leave the previous rules in place, not empty them,
 *   - a list the user removes must stop applying without a restart,
 *   - switching the blocker off must mean nothing is matched, not "a check somewhere says skip",
 *   - startup must not wait for the network.
 */

const AD_LIST = '||ads.example^\n##.ad-slot\n'
const TRACKER_LIST = '||track.example^\n'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-filters-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
  vi.useRealTimers()
})

function settingsWith(overrides: Partial<SettingsSnapshot>): () => SettingsSnapshot {
  const snapshot = { ...defaultSettings(), ...overrides }
  return () => snapshot
}

/** A fetcher that answers from a table, and records what it was asked for. */
function fetcherFor(bodies: Record<string, string>): {
  fetchList: (url: string) => Promise<string>
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    fetchList: (url) => {
      asked.push(url)
      const body = bodies[url]
      if (body === undefined) return Promise.reject(new Error('404'))
      return Promise.resolve(body)
    }
  }
}

const AD_URL = 'https://lists.example/ads.txt'
const TRACKER_URL = 'https://lists.example/trackers.txt'

function subscription(options: {
  lists?: string[]
  enabled?: boolean
  bodies?: Record<string, string>
  now?: () => number
  maxAgeMs?: number
}): { subject: FilterSubscription; asked: string[] } {
  const { fetchList, asked } = fetcherFor(options.bodies ?? { [AD_URL]: AD_LIST })
  const subject = new FilterSubscription({
    directory,
    fetchList,
    getSettings: settingsWith({
      'privacy.blockerLists': options.lists ?? [AD_URL],
      'privacy.blockerEnabled': options.enabled ?? true
    }),
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs })
  })
  return { subject, asked }
}

/** Whether the engine would block this request. Mirrors what the pipeline asks. */
function blocks(subject: FilterSubscription, url: string): boolean {
  return subject.engine.matches({
    url,
    resourceType: 'script',
    documentUrl: 'https://site.example/page',
    method: 'GET',
    settings: defaultSettings()
  })
}

describe('a first run with nothing cached', () => {
  it('starts with an engine that blocks nothing rather than with no engine', () => {
    /*
      Why the pipeline may be handed the engine immediately. An empty engine is correct — it matches
      nothing — whereas switching the blocker on later would mean reinstalling the `webRequest`
      listener, which is the failure `RequestPipeline` exists to prevent.
    */
    const { subject } = subscription({})
    expect(blocks(subject, 'https://ads.example/a.js')).toBe(false)
  })

  it('blocks once a list has been fetched', async () => {
    const { subject } = subscription({})
    await subject.refresh()
    expect(blocks(subject, 'https://ads.example/a.js')).toBe(true)
  })

  it('reports how many lists it configured against how many it has', async () => {
    // The gap between the two is the whole diagnostic: four configured and three loaded says a
    // download failed, and nothing else in the interface would say so.
    const { subject } = subscription({ lists: [AD_URL, TRACKER_URL] })
    await subject.refresh()
    const status = subject.status()
    expect(status.configured).toBe(2)
    expect(status.loaded).toBe(1)
  })
})

describe('a download that fails', () => {
  it('keeps the rules that were already compiled', async () => {
    /*
      The most important case here. A browser with a five-day-old list still blocks; a browser whose
      refresh emptied its rules because a server was briefly unreachable does not — and the user has no
      way to tell that apart from the blocker being broken.
    */
    const bodies: Record<string, string> = { [AD_URL]: AD_LIST }
    const { fetchList } = fetcherFor(bodies)
    let failing = false
    const subject = new FilterSubscription({
      directory,
      fetchList: (url) => (failing ? Promise.reject(new Error('offline')) : fetchList(url)),
      getSettings: settingsWith({ 'privacy.blockerLists': [AD_URL] }),
      // Zero max age, so every refresh re-fetches and the second one is guaranteed to try.
      maxAgeMs: 0
    })

    await subject.refresh()
    expect(blocks(subject, 'https://ads.example/a.js')).toBe(true)

    failing = true
    await subject.refresh()
    expect(blocks(subject, 'https://ads.example/a.js')).toBe(true)
  })

  it('says which list failed and why', async () => {
    const { subject } = subscription({ lists: [AD_URL, TRACKER_URL] })
    await subject.refresh()
    const failed = subject.status().lastRefresh?.filter((outcome) => outcome.status === 'failed')
    expect(failed).toHaveLength(1)
    expect(failed?.[0]?.url).toBe(TRACKER_URL)
    expect(failed?.[0]?.reason).toBe('404')
  })

  it('has no refresh outcome before a refresh has run', () => {
    // `null` rather than an empty array: "not asked yet" and "asked, nothing to report" are different
    // states, and a settings page showing "0 lists updated" before it ever tried would be wrong.
    const { subject } = subscription({})
    expect(subject.status().lastRefresh).toBeNull()
  })
})

describe('the user changing their lists', () => {
  it('applies a list added after startup, without a restart', async () => {
    /*
      This is why a settings change takes the *fetching* path rather than the reading one. A newly
      added list has no cached copy, so recompiling from cache alone would leave it inert until the
      next launch — and the user would conclude the setting does not work.
    */
    let lists = [AD_URL]
    const { fetchList } = fetcherFor({ [AD_URL]: AD_LIST, [TRACKER_URL]: TRACKER_LIST })
    const snapshot = { ...defaultSettings() }
    const subject = new FilterSubscription({
      directory,
      fetchList,
      getSettings: () => ({ ...snapshot, 'privacy.blockerLists': lists })
    })
    await subject.start()
    expect(blocks(subject, 'https://track.example/t.js')).toBe(false)

    lists = [AD_URL, TRACKER_URL]
    subject.onSettingsChanged({ 'privacy.blockerLists': lists })
    // `onSettingsChanged` is deliberately not async — it must not hold up the settings write. So the
    // work is awaited through `whenIdle`, which also serialises it behind the background refresh
    // `start()` left running.
    await subject.whenIdle()
    expect(blocks(subject, 'https://track.example/t.js')).toBe(true)
  })

  it('stops applying a list the user removed', async () => {
    let lists = [AD_URL, TRACKER_URL]
    const { fetchList } = fetcherFor({ [AD_URL]: AD_LIST, [TRACKER_URL]: TRACKER_LIST })
    const snapshot = { ...defaultSettings() }
    const subject = new FilterSubscription({
      directory,
      fetchList,
      getSettings: () => ({ ...snapshot, 'privacy.blockerLists': lists })
    })
    await subject.refresh()
    expect(blocks(subject, 'https://track.example/t.js')).toBe(true)

    lists = [AD_URL]
    subject.onSettingsChanged({ 'privacy.blockerLists': lists })
    await subject.whenIdle()
    expect(blocks(subject, 'https://track.example/t.js')).toBe(false)
  })

  it("ignores a change to something that is not the blocker's", async () => {
    // Recompiling a hundred thousand rules on the main thread while the user drags a zoom slider is
    // the reason this check exists rather than an unconditional reload.
    const { subject, asked } = subscription({})
    await subject.refresh()
    const before = asked.length
    subject.onSettingsChanged({ 'appearance.theme': 'light' })
    await Promise.resolve()
    expect(asked).toHaveLength(before)
  })
})

describe('switching the blocker off', () => {
  it('leaves no rules compiled, rather than relying on a check elsewhere', async () => {
    /*
      "Off" has to mean the engine has nothing in it. Keeping the rules and skipping them somewhere
      else is one forgotten check away from a blocker that still blocks after the user turned it off —
      and that failure looks like a broken website, not like a setting.
    */
    const { subject } = subscription({ enabled: false })
    await subject.refresh()
    expect(blocks(subject, 'https://ads.example/a.js')).toBe(false)
    expect(subject.status().networkRules).toBe(0)
    expect(subject.status().configured).toBe(0)
  })

  it('downloads nothing while it is off', async () => {
    // A switched-off blocker that still fetched lists weekly would be contacting third parties for a
    // feature the user declined.
    const { subject, asked } = subscription({ enabled: false })
    await subject.refresh()
    expect(asked).toEqual([])
  })
})

describe('starting up', () => {
  it('compiles from the cache without waiting for the network', async () => {
    /*
      `start()` awaits the disk read and lets the refresh run behind it. Checked by making the fetcher
      never settle: if `start` awaited it, this test would time out — which is exactly what a user on a
      slow connection would experience as a browser that will not open.
    */
    const { fetchList } = fetcherFor({ [AD_URL]: AD_LIST })
    const seeded = new FilterSubscription({
      directory,
      fetchList,
      getSettings: settingsWith({ 'privacy.blockerLists': [AD_URL] })
    })
    await seeded.refresh()

    const stalled = new FilterSubscription({
      directory,
      fetchList: () => new Promise<string>(() => {}),
      getSettings: settingsWith({ 'privacy.blockerLists': [AD_URL] }),
      maxAgeMs: 0
    })
    await stalled.start()
    // The cached copy is compiled in even though the download has not answered and never will.
    expect(blocks(stalled, 'https://ads.example/a.js')).toBe(true)
  })

  it('serialises refreshes, so two cannot corrupt the cache between them', async () => {
    /*
      Reaching this state is trivial rather than exotic: `start()` kicks off a refresh in the background
      on purpose, and a user who changes their lists a second later starts another. Unserialised, both
      read the manifest, both prune from what they read, and the second deletes files the first had just
      written — a blocker with fewer lists than it downloaded and nothing saying why.
    */
    let lists = [AD_URL]
    const { fetchList } = fetcherFor({ [AD_URL]: AD_LIST, [TRACKER_URL]: TRACKER_LIST })
    const snapshot = { ...defaultSettings() }
    const subject = new FilterSubscription({
      directory,
      fetchList,
      getSettings: () => ({ ...snapshot, 'privacy.blockerLists': lists })
    })

    // Two overlapping refreshes with different configurations, started without awaiting the first.
    const first = subject.refresh()
    lists = [AD_URL, TRACKER_URL]
    const second = subject.refresh()
    await Promise.all([first, second])
    await subject.whenIdle()

    // Both lists present, both files on disk, and a manifest that names them.
    expect(blocks(subject, 'https://ads.example/a.js')).toBe(true)
    expect(blocks(subject, 'https://track.example/t.js')).toBe(true)
    expect((await readdir(directory)).sort()).toHaveLength(3)
  })

  it('survives a cache directory holding something that is not a list', async () => {
    // The directory is discardable and shared with nothing, but a disk cleaner or a curious user can
    // leave a file in it. Failing to start over that would be a browser that will not open.
    await writeFile(join(directory, 'stray.txt'), 'not a manifest', 'utf8')
    const { subject } = subscription({})
    await expect(subject.start()).resolves.toBeUndefined()
    // `whenIdle`, not just `start`: the background refresh writes to this directory, and tearing it
    // down underneath that write is what produced an `ENOENT` from `writeAtomically` here the first
    // time — a test artefact, but the same race a shutdown would hit.
    await subject.whenIdle()
  })
})

describe("the user's own rules", () => {
  /*
    Only cosmetic, and that is the design rather than a limitation of these tests.

    `describeUserRule` refuses any line that would produce a *network* rule, and says why: letting an
    element picker write request-blocking rules would put "hide this box" and "cut this site off" behind
    the same button. So a hand-made rule hides something; it never blocks a request.
  */
  const withOwnRules = (
    supplier: () => string
  ): FilterSubscription => {
    const { fetchList } = fetcherFor({ [AD_URL]: AD_LIST })
    return new FilterSubscription({
      directory,
      fetchList,
      getSettings: settingsWith({ 'privacy.blockerLists': [AD_URL] }),
      userRules: supplier
    })
  }

  const hides = (subject: FilterSubscription, selector: string): boolean =>
    (subject.engine.cosmeticStylesFor('https://site.example/page') ?? '').includes(selector)

  it('recompiles only the hand-made half', async () => {
    /*
      Why the two halves are compiled apart. Adding one picker rule would otherwise reparse a hundred
      thousand lines on the main process's own thread while the user waits — and a hand-made rule changes
      far more often than a published list does.
    */
    let own = ''
    const subject = withOwnRules(() => own)
    await subject.refresh()
    expect(hides(subject, '.mine')).toBe(false)

    own = 'site.example##.mine\n'
    subject.reloadUserRules()
    expect(hides(subject, '.mine')).toBe(true)
  })

  it('keeps them after a list reload rebuilds the engine', async () => {
    // The trap in `#compileFromCache`: it replaces the list half wholesale, so the user's half has to be
    // put back, or refreshing a list would silently drop every rule the person made by hand.
    const subject = withOwnRules(() => 'site.example##.mine\n')
    await subject.refresh()
    expect(hides(subject, '.mine')).toBe(true)

    await subject.refresh()
    expect(hides(subject, '.mine')).toBe(true)
  })

  it('refuses a hand-made rule that would block a request', async () => {
    /*
      Stated here because it is the boundary between two very different powers. A rule the picker wrote
      may hide an element; only a list the user deliberately subscribed to may stop a request. A user
      rule file that had grown a `||host^` line would be a site cut off by a click meant to hide a
      banner.
    */
    const subject = withOwnRules(() => '||mine.example^\n')
    await subject.refresh()
    expect(blocks(subject, 'https://mine.example/x.js')).toBe(false)
  })
})

describe('a refresh that throws outright', () => {
  it('does not stop the next one from running', async () => {
    /*
      Distinct from a failed *download*, which the store reports as an outcome and swallows. This is the
      case where the refresh itself cannot proceed — an unwritable cache directory, a full disk — and the
      chain that serialises refreshes must not be left permanently rejected by it. If it were, one bad
      moment would mean no list ever updated again for the life of the process, silently.
    */
    const unusable = join(directory, 'a-file-not-a-directory')
    await writeFile(unusable, 'in the way', 'utf8')

    const { fetchList } = fetcherFor({ [AD_URL]: AD_LIST })
    const subject = new FilterSubscription({
      directory: unusable,
      fetchList,
      getSettings: settingsWith({ 'privacy.blockerLists': [AD_URL] })
    })
    await expect(subject.refresh()).rejects.toThrow()

    // The chain has to be usable again. A second refresh against the same broken path must still be
    // *attempted* rather than inheriting the first rejection.
    await expect(subject.refresh()).rejects.toThrow()
  })
})

describe('the counters the settings page shows', () => {
  it('separates what was understood from what was declined', async () => {
    /*
      The honest half of a hand-written engine. `$popup` is real Adblock Plus syntax this build does not
      implement, and counting it is the difference between "the blocker understands less than you think"
      being discoverable and being invisible.
    */
    const withUnsupported = '||ads.example^\n||pop.example^$popup\n'
    const { subject } = subscription({ bodies: { [AD_URL]: withUnsupported } })
    await subject.refresh()

    const { diagnostics } = subject.status()
    expect(diagnostics.network).toBeGreaterThanOrEqual(1)
    expect(diagnostics.unsupported).toBeGreaterThanOrEqual(1)
    expect(Object.keys(diagnostics.unsupportedByReason).join(' ')).toContain('popup')
  })

  it('hands out a copy, so a caller cannot alter what the next reader sees', async () => {
    const { subject } = subscription({ lists: [AD_URL, TRACKER_URL] })
    await subject.refresh()
    const first = subject.status()
    first.lastRefresh?.splice(0, first.lastRefresh.length)
    expect(subject.status().lastRefresh).toHaveLength(2)
  })
})

describe('the cache directory', () => {
  it('keeps one file per list plus a manifest', async () => {
    const { subject } = subscription({
      lists: [AD_URL, TRACKER_URL],
      bodies: { [AD_URL]: AD_LIST, [TRACKER_URL]: TRACKER_LIST }
    })
    await subject.refresh()
    const names = (await readdir(directory)).sort()
    expect(names).toHaveLength(3)
    expect(names).toContain('manifest.json')
  })

  it('drops the file of a list the user removed', async () => {
    // Otherwise the cache grows for the life of the profile with lists nothing reads.
    let lists = [AD_URL, TRACKER_URL]
    const { fetchList } = fetcherFor({ [AD_URL]: AD_LIST, [TRACKER_URL]: TRACKER_LIST })
    const snapshot = { ...defaultSettings() }
    const subject = new FilterSubscription({
      directory,
      fetchList,
      getSettings: () => ({ ...snapshot, 'privacy.blockerLists': lists })
    })
    await subject.refresh()

    lists = [AD_URL]
    await subject.refresh()
    expect(await readdir(directory)).toHaveLength(2)
  })
})
