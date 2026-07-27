import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { FilterSubscription } from '@main/privacy/FilterSubscription.js'
import { defaultSettings } from '@shared/settings/definitions.js'
import { blocker, scope, tempDir } from './world.js'

/**
 * Steps for `content-blocker.feature`.
 *
 * A real `FilterSubscription` over a real directory, with only the network faked. That is the whole
 * point of these scenarios: the engine and the on-disk cache were each tested in isolation and the
 * bugs were all in the joint between them and the setting that says which lists to use. A fake store
 * would test the joint against itself.
 *
 * Three things here are deliberate and would otherwise look like accidents:
 *
 * `maxAgeMs: 0`, so every refresh re-fetches. With the real five-day window a cached copy counts as
 * fresh and the store never calls the fetcher at all — the "can no longer be downloaded" scenarios
 * would pass without a single failed download, which is the opposite of what they claim to check.
 *
 * `defaultSettings()` — not the scenario's settings — is what a request is matched against. The
 * blocker being switched off must show up as *no compiled rules*, so matching has to happen with the
 * flag on. Matched with the flag off, "is allowed" would hold even if every rule were still loaded,
 * and the scenario that exists to catch exactly that would be vacuous.
 *
 * The settings are read through a closure rather than copied in, so "taken out of the settings" and
 * "switched off" change what the live subscription sees — as they do in the running browser, where
 * the store hands the subscription a getter and not a snapshot.
 */

interface DataTable {
  hashes(): Array<Record<string, string>>
}

/** A body that blocks one host, plus a cosmetic rule so "no rules at all" can mean both counts. */
function listBlocking(host: string): string {
  return `||${host}^\n##.ad-slot\n`
}

/**
 * Builds a subscription over the scenario's directory and the scenario's live settings.
 *
 * `fetchList` reads the body table on every call rather than closing over it, which is what lets a
 * later step take a list off the network without rebuilding anything.
 */
function create(state: unknown, fetchList: (url: string) => Promise<string>): FilterSubscription {
  const current = scope(state)
  const directory = current.blockerDirectory
  if (directory === null) throw new Error('no filter lists were given, so there is no cache to use')
  const subject = new FilterSubscription({
    directory,
    fetchList,
    getSettings: () => scope(state).settings,
    maxAgeMs: 0
  })
  current.blocker = subject
  return subject
}

/** The fetcher a scenario's table describes: a body for a list that works, a rejection otherwise. */
function fromTable(state: unknown): (url: string) => Promise<string> {
  return (url) => {
    const current = scope(state)
    current.blockerFetches.push(url)
    const body = current.blockerBodies[url]
    if (body === undefined) return Promise.reject(new Error(`404 ${url}`))
    return Promise.resolve(body)
  }
}

function currentLists(state: unknown): readonly string[] {
  return scope(state).settings['privacy.blockerLists']
}

// --- given -------------------------------------------------------------------

Given('these filter lists:', (state: unknown, table: DataTable) => {
  const current = scope(state)
  const addresses: string[] = []
  for (const row of table.hashes()) {
    const address = (row['address'] ?? '').trim()
    const host = (row['blocks'] ?? '').trim()
    const download = (row['download'] ?? '').trim()
    if (download !== 'works' && download !== 'fails') {
      throw new Error(`a list either "works" or "fails", not "${download}"`)
    }
    addresses.push(address)
    // A list that fails is simply absent from the table the fetcher answers from — the same shape as
    // a server that is down, rather than a separate flag the fetcher would have to understand.
    if (download === 'works') current.blockerBodies[address] = listBlocking(host)
  }
  current.settings = {
    ...current.settings,
    'privacy.blockerEnabled': true,
    'privacy.blockerLists': addresses
  }
  // The directory is made here rather than at construction so a restart can reuse it: the cache
  // surviving a launch is what half of these scenarios are about.
  current.blockerDirectory = tempDir('blocker')
})

// --- when --------------------------------------------------------------------

When('the blocker starts', async (state: unknown) => {
  const subject = create(state, fromTable(state))
  await subject.start()
  // `start` deliberately does not await its own refresh; a scenario that asserts on downloaded rules
  // has to, or it would assert on the cache as it was before the first launch.
  await subject.whenIdle()
})

When('{string} can no longer be downloaded', (state: unknown, address: string) => {
  const current = scope(state)
  if (!(address in current.blockerBodies)) {
    throw new Error(`"${address}" was never downloadable; nothing for this step to take away`)
  }
  current.blockerBodies = Object.fromEntries(
    Object.entries(current.blockerBodies).filter(([url]) => url !== address)
  )
})

When('the blocker refreshes', async (state: unknown) => {
  await blocker(state).refresh()
})

When('two refreshes are asked for at once', async (state: unknown) => {
  const subject = create(state, fromTable(state))
  // Both asked for before either is awaited. Awaiting the first would serialise them at the call
  // site and the scenario would hold even with the serialisation inside `refresh` removed.
  const first = subject.refresh()
  const second = subject.refresh()
  await Promise.all([first, second])
})

When('the blocker is switched off', async (state: unknown) => {
  const current = scope(state)
  current.settings = { ...current.settings, 'privacy.blockerEnabled': false }
  blocker(state).onSettingsChanged({ 'privacy.blockerEnabled': false })
  await blocker(state).whenIdle()
})

When('the list {string} is taken out of the settings', async (state: unknown, address: string) => {
  const current = scope(state)
  const remaining = currentLists(state).filter((url) => url !== address)
  expect(remaining).not.toEqual(currentLists(state))
  current.settings = { ...current.settings, 'privacy.blockerLists': remaining }
  blocker(state).onSettingsChanged({ 'privacy.blockerLists': remaining })
  await blocker(state).whenIdle()
})

When('the browser starts again while the network never answers', async (state: unknown) => {
  // A promise that never settles, not one that rejects. A rejection is a fast answer, and the thing
  // being tested is that the launch does not *wait* — which a rejecting fetcher cannot show.
  const subject = create(state, () => new Promise<string>(() => {}))
  await subject.start()
  /*
    No `whenIdle` here, on purpose: this launch's refresh is still hanging and always will be. That
    `start` resolved at all is the assertion — everything after this step reads the rules the cache
    gave it while the download is still outstanding.
  */
})

// --- then --------------------------------------------------------------------

Then('a request to {string} is blocked', (state: unknown, url: string) => {
  expect(matched(state, url)).toBe(true)
})

Then('a request to {string} is allowed', (state: unknown, url: string) => {
  expect(matched(state, url)).toBe(false)
})

Then('no rules are compiled at all', (state: unknown) => {
  const status = blocker(state).status()
  expect({ network: status.networkRules, cosmetic: status.cosmeticRules }).toEqual({
    network: 0,
    cosmetic: 0
  })
})

Then(
  'the blocker reports {int} list configured and {int} loaded',
  (state: unknown, configured: number, loaded: number) => {
    expectCounts(state, configured, loaded)
  }
)

Then(
  'the blocker reports {int} lists configured and {int} loaded',
  (state: unknown, configured: number, loaded: number) => {
    expectCounts(state, configured, loaded)
  }
)

Then('the blocker says {string} could not be downloaded', (state: unknown, address: string) => {
  const outcomes = blocker(state).status().lastRefresh
  if (outcomes === null) throw new Error('no refresh has finished, so there is nothing to report')
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').map((o) => o.url)
  expect(failed).toEqual([address])
})

/** Whether the compiled rules block a request. See the note above on why the settings are default. */
function matched(state: unknown, url: string): boolean {
  return blocker(state).engine.matches({
    url,
    resourceType: 'script',
    documentUrl: 'https://site.example/page',
    method: 'GET',
    settings: defaultSettings()
  })
}

/**
 * Both counts in one assertion rather than two.
 *
 * Asserted separately, "2 configured and 1 loaded" passing while the loaded count is the one that
 * drifted reads as a single failed expectation with no sight of the other number — and the pair is
 * the whole message the settings page shows.
 */
function expectCounts(state: unknown, configured: number, loaded: number): void {
  const status = blocker(state).status()
  expect({ configured: status.configured, loaded: status.loaded }).toEqual({ configured, loaded })
}
