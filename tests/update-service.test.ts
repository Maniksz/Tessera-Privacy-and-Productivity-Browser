import { describe, expect, it, vi } from 'vitest'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  MAC_BUILD_IS_SIGNED,
  UpdateService,
  offerPrompt,
  noticePrompt,
  releasePageUrl,
  restartPrompt,
  updateDelivery,
  updatePolicyFor,
  type UpdateAnswer,
  type UpdateDownloadResult,
  type UpdateFeedResult,
  type UpdatePolicy,
  type UpdatePrompt,
  type UpdateServiceOptions
} from '@main/updates/UpdateService.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The update check, and the three refusals it exists to make.
 *
 * What breaks in the product if these rules are wrong, case by case:
 *
 *   - **A download nobody agreed to.** The user's rule is that nothing is fetched or installed
 *     without approval. Every one of those approvals is a branch, and a branch that stops being
 *     taken is invisible: the update simply arrives, which looks like the feature working.
 *   - **A dialogue after a failed check.** Offline, rate-limited, nothing published yet: all
 *     ordinary, all reached by a timer nobody set off. A message box for each one is how a user
 *     learns to switch update checks off, which costs them the security fixes the check exists to
 *     deliver.
 *   - **A macOS download that cannot work.** Squirrel.Mac will not replace an unsigned application.
 *     Offering the download anyway produces a progress bar, a restart, and the same old version.
 *   - **An alpha user told there is nothing new.** GitHub's "latest release" excludes prereleases, so
 *     a lost `allowPrerelease` does not fail — it reports "no update" for ever.
 *
 * The ports are fakes, so the assertions are about what the service *asked them to do* and in which
 * order — never about the fakes themselves.
 */

interface Harness {
  readonly service: UpdateService
  readonly prompts: UpdatePrompt[]
  readonly policies: UpdatePolicy[]
  readonly opened: string[]
  checks: number
  downloads: number
  installs: number
}

function harness(
  overrides: {
    readonly settings?: Partial<SettingsSnapshot>
    readonly current?: string
    readonly feed?: UpdateFeedResult | (() => UpdateFeedResult | Promise<UpdateFeedResult>)
    readonly download?: UpdateDownloadResult
    readonly answer?: (prompt: UpdatePrompt) => UpdateAnswer
    readonly platform?: UpdateServiceOptions['platform']
    readonly macBuildIsSigned?: boolean
    /**
     * `0`, which installs no timer at all, unless a test says otherwise.
     *
     * `shippedTimers` leaves both out entirely, so the service falls back to the constants a real
     * launch uses — which is the only way those two defaults are exercised.
     */
    readonly firstCheckDelayMs?: number
    readonly checkIntervalMs?: number
    readonly shippedTimers?: boolean
    readonly showPrompt?: UpdateServiceOptions['showPrompt']
  } = {}
): Harness {
  const prompts: UpdatePrompt[] = []
  const policies: UpdatePolicy[] = []
  const opened: string[] = []
  const state = { checks: 0, downloads: 0, installs: 0 }
  const feed: UpdateFeedResult | (() => UpdateFeedResult | Promise<UpdateFeedResult>) =
    overrides.feed ?? { kind: 'nothing-published' }

  const service = new UpdateService({
    updater: {
      configure: (policy) => policies.push(policy),
      check: async () => {
        state.checks += 1
        return typeof feed === 'function' ? feed() : feed
      },
      download: () => {
        state.downloads += 1
        return Promise.resolve(overrides.download ?? { kind: 'downloaded' })
      },
      installAndRestart: () => {
        state.installs += 1
      }
    },
    getSettings: () => ({ ...defaultSettings(), ...overrides.settings }),
    locale: () => 'en',
    currentVersion: () => overrides.current ?? '1.0.0',
    platform: overrides.platform ?? 'win32',
    // Absent rather than `undefined`, so a test that does not name it exercises the constant this
    // application actually ships with.
    ...(overrides.macBuildIsSigned === undefined
      ? {}
      : { macBuildIsSigned: overrides.macBuildIsSigned }),
    showPrompt:
      overrides.showPrompt ??
      ((prompt) => {
        prompts.push(prompt)
        return Promise.resolve(overrides.answer?.(prompt) ?? 'dismiss')
      }),
    openReleasePage: (url) => opened.push(url),
    // No timers by default: every test drives a check itself, so nothing here depends on a clock.
    ...(overrides.shippedTimers === true
      ? {}
      : {
          firstCheckDelayMs: overrides.firstCheckDelayMs ?? 0,
          checkIntervalMs: overrides.checkIntervalMs ?? 0
        })
  })

  return {
    service,
    prompts,
    policies,
    opened,
    get checks() {
      return state.checks
    },
    get downloads() {
      return state.downloads
    },
    get installs() {
      return state.installs
    }
  }
}

/**
 * Lets every pending promise settle.
 *
 * `setImmediate` runs after the microtask queue has drained, so this waits for a whole chain of
 * `await`s rather than for a fixed number of turns — a count is a guess that passes until somebody
 * adds an `await`.
 */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve))
}

/** Silences the one line an ordinary failure is allowed to leave, and lets a test read it. */
function quietWarnings(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => {})
}

describe('which platform is offered a download', () => {
  it('sends an unsigned macOS build to the release page instead', () => {
    /*
      Squirrel.Mac refuses to replace an application whose code signature it cannot verify, and this
      project has no Developer ID: `release.yml` builds macOS with `--config.mac.identity=null`. A
      download offered here would download, restart, and leave the user on the same version — with
      the failure reported by a framework rather than by us.
    */
    expect(updateDelivery({ platform: 'darwin', macBuildIsSigned: false })).toBe('release-page')
  })

  it('offers the download on macOS the moment the build is signed', () => {
    // The seamless path has to be one condition away, not a rewrite. This is that condition.
    expect(updateDelivery({ platform: 'darwin', macBuildIsSigned: true })).toBe('in-place')
  })

  it('offers the download on Windows and Linux', () => {
    expect(updateDelivery({ platform: 'win32', macBuildIsSigned: false })).toBe('in-place')
    expect(updateDelivery({ platform: 'linux', macBuildIsSigned: false })).toBe('in-place')
  })

  it('ships with macOS signing off, because it is', () => {
    /*
      Not a tautology about a constant: it is the assertion that nobody has flipped the flag while
      the workflow still passes `--config.mac.identity=null`. Flipping one without the other is the
      one mistake here that produces a broken update for real users rather than a failing test.
    */
    expect(MAC_BUILD_IS_SIGNED).toBe(false)
  })
})

describe('what the updater is told before a check', () => {
  it('allows prereleases on the alpha channel and refuses them on stable', () => {
    /*
      The invisible failure. GitHub's "latest release" excludes prereleases, so an alpha user checking
      with `allowPrerelease: false` is told there is no update while every published version is one —
      and "there is no update" is indistinguishable from the feature working.
    */
    expect(updatePolicyFor('alpha').allowPrerelease).toBe(true)
    expect(updatePolicyFor('stable').allowPrerelease).toBe(false)
  })

  it('never lets the library download or install on its own', () => {
    // The user's rule, at the one place a single assignment could quietly undo it: with autoDownload
    // on, the first consent below becomes a dialogue shown after the fact.
    for (const channel of ['stable', 'alpha'] as const) {
      expect(updatePolicyFor(channel).autoDownload).toBe(false)
      expect(updatePolicyFor(channel).autoInstallOnAppQuit).toBe(false)
    }
  })

  it('reads the channel again on every check', async () => {
    /*
      Read per check rather than captured at startup. Captured, a user who switches to the alpha
      channel would keep being told there is nothing new until they restarted the browser — and the
      setting is declared `applies: 'live'`, which is a promise.
    */
    // Mutable on purpose: the same object the service reads, changed between the two checks.
    const settings: { 'updates.channel': 'stable' | 'alpha' } = { 'updates.channel': 'stable' }
    const h = harness({ settings, feed: { kind: 'nothing-published' } })
    await h.service.checkAutomatically()
    settings['updates.channel'] = 'alpha'
    await h.service.checkAutomatically()

    expect(h.policies.map((policy) => policy.allowPrerelease)).toEqual([false, true])
  })
})

describe('the release page a mac user is sent to', () => {
  it('names the tag of the version that was offered', () => {
    // The version they were just told about, not `/releases/latest` — which on GitHub means the
    // newest *non-prerelease* release and does not exist for this project.
    expect(releasePageUrl('0.2.0-alpha.1')).toBe(
      'https://github.com/Maniksz/Tessera-Privacy-and-Productivity-Browser/releases/tag/v0.2.0-alpha.1'
    )
  })

  it('does not double the v when the version already carries one', () => {
    // Release names and tags are written both ways, and `parseVersion` accepts both.
    expect(releasePageUrl('v1.2.3')).toMatch(/\/releases\/tag\/v1\.2\.3$/)
  })
})

describe('the setting that switches automatic checks off', () => {
  it('makes an automatic check ask GitHub nothing at all', async () => {
    /*
      Off has to mean no request, not a request whose result is discarded. The whole cost of this
      feature is that a check contacts a third party; a switch that only hides the dialogue would
      leave that cost in place while telling the user it is gone.
    */
    const h = harness({ settings: { 'updates.checkAutomaticallyOnGithub': false } })
    const outcome = await h.service.checkAutomatically()

    expect(outcome).toEqual({ kind: 'not-checked', reason: 'setting-off' })
    expect(h.checks, 'the feed was read despite the switch being off').toBe(0)
    expect(h.policies).toEqual([])
  })

  it('still lets a person ask on demand', async () => {
    // Switching off the automatic check is not a refusal to ever look. Somebody who wants to stay in
    // control of when their browser talks to GitHub still needs the menu item to work.
    const h = harness({
      settings: { 'updates.checkAutomaticallyOnGithub': false },
      feed: { kind: 'offer', version: '1.0.0' }
    })
    await h.service.checkOnDemand()

    expect(h.checks).toBe(1)
  })
})

describe('who is offered what', () => {
  it('refuses to offer a version older than the one running', async () => {
    /*
      The library was asked "what does the feed say"; whether that is an upgrade *for this person* is
      our decision, and it has to be made even when the feed's newest entry is behind. Compared as
      text, `alpha.2` beats `alpha.10` — so the failure mode is a downgrade presented as an update,
      accepted, and installed.
    */
    const h = harness({ current: '2.0.0', feed: { kind: 'offer', version: '1.9.9' } })
    const outcome = await h.service.checkOnDemand()

    expect(outcome).toEqual({ kind: 'up-to-date', version: '1.9.9' })
    expect(h.downloads).toBe(0)
    expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['up-to-date'])
  })

  it('refuses to offer a prerelease to somebody on the stable channel', async () => {
    /*
      They did not ask to test anything, and an alpha of a browser can lose their session. This is
      the case the library's own comparison would allow — it answers "is this different", not "should
      this person see it".
    */
    const h = harness({
      settings: { 'updates.channel': 'stable' },
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0-alpha.1' }
    })
    const outcome = await h.service.checkOnDemand()

    expect(outcome.kind).toBe('up-to-date')
    expect(h.downloads).toBe(0)
  })

  it('offers a newer prerelease on the alpha channel', async () => {
    const h = harness({
      settings: { 'updates.channel': 'alpha' },
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0-alpha.1' }
    })
    await h.service.checkAutomatically()

    expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['offer'])
  })
})

describe('the first consent: told, not downloaded', () => {
  it('asks before fetching anything, and fetches nothing when the answer is no', async () => {
    /*
      The consent the user asked for in as many words. If this stops holding, an update downloads on
      a metered connection while somebody is reading a page — and because the download succeeds, the
      only visible symptom is the *second* dialogue appearing sooner than expected.
    */
    const h = harness({
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: () => 'dismiss'
    })
    const outcome = await h.service.checkAutomatically()

    expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['offer'])
    expect(h.downloads, 'a download started without an answer').toBe(0)
    expect(h.installs).toBe(0)
    expect(outcome).toEqual({ kind: 'declined', version: '1.1.0' })
  })

  it('does not put the same offer back on a timer once it has been answered', async () => {
    /*
      "Not now" has to buy more than twenty-four hours of quiet. Otherwise the same box returns every
      day for as long as that version is the newest one — which is exactly how a dialogue trains
      somebody to dismiss it unread, and this one has a Download button where the cursor already is.
    */
    const h = harness({
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: () => 'dismiss'
    })
    await h.service.checkAutomatically()
    const second = await h.service.checkAutomatically()

    expect(h.prompts).toHaveLength(1)
    expect(second).toEqual({ kind: 'not-checked', reason: 'already-offered' })
  })

  it('asks again about a declined version when the person asks', async () => {
    // Opening the menu and choosing "Check for updates…" withdraws the "not now". Refusing to answer
    // would be a menu item that does nothing, which is the failure this whole file guards against.
    const h = harness({
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: () => 'dismiss'
    })
    await h.service.checkAutomatically()
    await h.service.checkOnDemand()

    expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['offer', 'offer'])
  })

  it('does not re-offer a version that was downloaded and left for later', async () => {
    /*
      The file is on disk and nothing will install it until somebody says so. Nagging about it is the
      same mistake as nagging about a decline — and worse, because the *next* dialogue would be the
      offer to download something already downloaded.
    */
    const h = harness({
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: (prompt) => (prompt.kind === 'offer' ? 'download' : 'dismiss')
    })
    await h.service.checkAutomatically()
    await h.service.checkAutomatically()

    expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['offer', 'ready'])
    expect(h.downloads).toBe(1)
  })

  it('puts the answer that changes nothing on the button Escape presses', () => {
    /*
      Not cosmetic. `cancelId` is what a dismissed message box returns, so if it pointed at the
      accepting button, closing the dialogue with Escape would start a download — the exact opposite
      of the consent this box exists to collect.
    */
    const prompt = offerPrompt({
      locale: 'en',
      current: '1.0.0',
      version: '1.1.0',
      delivery: 'in-place'
    })
    const [accepting] = prompt.buttons.slice(0, 1)
    const [cancelling] = prompt.buttons.slice(prompt.cancelIndex, prompt.cancelIndex + 1)

    expect(accepting?.answer).toBe('download')
    expect(cancelling?.answer).toBe('dismiss')
  })

  it('names both versions, so the dialogue is not asking to be trusted', () => {
    // "An update is available" without saying from what to what is a request for blind consent.
    const prompt = offerPrompt({
      locale: 'en',
      current: '1.0.0',
      version: '1.1.0',
      delivery: 'in-place'
    })
    expect(prompt.message).toContain('1.1.0')
    expect(prompt.message).toContain('1.0.0')
  })

  it('offers the release page rather than a download when the platform cannot install one', () => {
    /*
      Same dialogue, different button: a mac user is told the version exists and is given the one
      route that works. Offering a Download button here would be the browser promising something the
      operating system refuses.
    */
    const prompt = offerPrompt({
      locale: 'en',
      current: '1.0.0',
      version: '1.1.0',
      delivery: 'release-page'
    })
    expect(prompt.buttons.map((button) => button.answer)).toEqual(['release-page', 'dismiss'])
    expect(prompt.detail, 'the reason is not stated').toContain('macOS')
  })

  it('opens the release page and downloads nothing when that is the answer', async () => {
    /*
      No `macBuildIsSigned` given, so this is the state the application ships in: a mac user is
      offered the page, never the download. That is the assertion — if the shipped default ever
      flipped without the workflow being changed, this is where it shows.
    */
    const h = harness({
      platform: 'darwin',
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: () => 'release-page'
    })
    const outcome = await h.service.checkOnDemand()

    expect(h.opened).toEqual([releasePageUrl('1.1.0')])
    expect(h.downloads, 'macOS was sent down the in-place path').toBe(0)
    expect(outcome).toEqual({ kind: 'sent-to-release-page', version: '1.1.0' })
  })

  it('offers a signed macOS build the download, with nothing else changing', async () => {
    // The whole of "one condition away", end to end: the same flow, the other button.
    const h = harness({
      platform: 'darwin',
      macBuildIsSigned: true,
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: (prompt) => (prompt.kind === 'offer' ? 'download' : 'dismiss')
    })
    await h.service.checkOnDemand()

    const [offer] = h.prompts.slice(0, 1)
    expect(offer?.buttons.map((button) => button.answer)).toEqual(['download', 'dismiss'])
    expect(h.downloads).toBe(1)
    expect(h.opened).toEqual([])
  })
})

describe('the second and third consents: downloaded, then restarted', () => {
  it('downloads on approval and then asks when to restart', async () => {
    const h = harness({
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: (prompt) => (prompt.kind === 'offer' ? 'download' : 'dismiss')
    })
    const outcome = await h.service.checkOnDemand()

    expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['offer', 'ready'])
    expect(h.downloads).toBe(1)
    /*
      "Later" is a real answer, and this is the assertion that makes it one: the file is downloaded
      and nothing is installed. With `autoInstallOnAppQuit` left at its default, quitting the browser
      afterwards would install it — which is an install nobody agreed to, arriving at the moment the
      user is least expecting their browser to change.
    */
    expect(h.installs, 'the update installed without a restart being chosen').toBe(0)
    expect(outcome).toEqual({ kind: 'waiting-for-restart', version: '1.1.0' })
  })

  it('installs only when the restart is chosen', async () => {
    const h = harness({
      current: '1.0.0',
      feed: { kind: 'offer', version: '1.1.0' },
      answer: (prompt) => (prompt.kind === 'offer' ? 'download' : 'restart')
    })
    const outcome = await h.service.checkOnDemand()

    expect(h.installs).toBe(1)
    expect(outcome).toEqual({ kind: 'restarting', version: '1.1.0' })
  })

  it('lets Escape mean later on the restart dialogue too', () => {
    // A person interrupted mid-sentence by "the update is ready" must be able to dismiss it without
    // losing the tabs they have open.
    const prompt = restartPrompt({ locale: 'en', version: '1.1.0' })
    const [cancelling] = prompt.buttons.slice(prompt.cancelIndex, prompt.cancelIndex + 1)

    expect(cancelling?.answer).toBe('dismiss')
    expect(prompt.buttons.map((button) => button.answer)).toEqual(['restart', 'dismiss'])
  })

  it('reports a failed download even when nobody asked for the check', async () => {
    /*
      The one failure here that is never quiet, and the distinction is the point: a failed *check* is
      the browser's business, a failed *download* is the user's — they pressed a button and are
      waiting for something to happen. Silence would leave them believing an update is on its way.
    */
    const warn = quietWarnings()
    try {
      const h = harness({
        current: '1.0.0',
        feed: { kind: 'offer', version: '1.1.0' },
        download: { kind: 'failed', detail: 'ENOSPC' },
        answer: () => 'download'
      })
      const outcome = await h.service.checkAutomatically()

      expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['offer', 'download-failed'])
      expect(h.installs).toBe(0)
      expect(outcome).toEqual({ kind: 'download-failed', version: '1.1.0' })
    } finally {
      warn.mockRestore()
    }
  })
})

describe('a check that finds nothing, or fails', () => {
  const uneventful: ReadonlyArray<readonly [string, UpdateFeedResult]> = [
    ['the network is unreachable', { kind: 'unreachable', detail: 'ENOTFOUND github.com' }],
    ['the repository has nothing published', { kind: 'nothing-published' }],
    ['this copy has no feed at all', { kind: 'no-feed' }],
    ['there is nothing newer', { kind: 'offer', version: '1.0.0' }]
  ]

  for (const [situation, feed] of uneventful) {
    it(`interrupts nobody when ${situation}`, async () => {
      /*
        Every one of these is an ordinary Tuesday, and every one of them arrives on a timer the user
        did not set off. A message box for each is how somebody learns to switch the update check
        off — and switching it off is the outcome that actually costs them, because the fixes it
        would have delivered are security fixes.
      */
      const warn = quietWarnings()
      try {
        const h = harness({ current: '1.0.0', feed })
        await h.service.checkAutomatically()

        expect(h.prompts, `${situation} produced a dialogue`).toEqual([])
      } finally {
        warn.mockRestore()
      }
    })

    it(`answers with one sentence when a person asked and ${situation}`, async () => {
      // A check somebody asked for has to answer. An on-demand check that shows nothing is
      // indistinguishable from a menu item that does nothing.
      const warn = quietWarnings()
      try {
        const h = harness({ current: '1.0.0', feed })
        await h.service.checkOnDemand()

        expect(h.prompts).toHaveLength(1)
        const [only] = h.prompts.slice(0, 1)
        expect(only?.buttons.map((button) => button.answer)).toEqual(['dismiss'])
      } finally {
        warn.mockRestore()
      }
    })
  }

  it('leaves one line behind for whoever has to diagnose it', async () => {
    /*
      Quiet towards the user, not silent towards the developer. Without this a browser that has
      stopped being able to check for updates gives no evidence of it anywhere.
    */
    const warn = quietWarnings()
    try {
      const h = harness({
        current: '1.0.0',
        feed: { kind: 'unreachable', detail: 'ENOTFOUND github.com' }
      })
      await h.service.checkAutomatically()

      expect(warn).toHaveBeenCalledWith(
        '[updates] the check could not be completed:',
        'ENOTFOUND github.com'
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('says what state the copy is in rather than an error code', () => {
    /*
      "as a sentence rather than an error code": `ERR_UPDATER_LATEST_VERSION_NOT_FOUND` does not
      contain the fact the user wants, which is whether anything happened to their browser.
    */
    const failed = noticePrompt({ locale: 'en', kind: 'check-failed', current: '1.0.0' })
    expect(failed.message).toContain('unchanged')
    expect(failed.message).not.toMatch(/ERR_|[A-Z]{3,}_/)

    const upToDate = noticePrompt({ locale: 'en', kind: 'up-to-date', current: '1.0.0' })
    expect(upToDate.message, 'the version they are on is not named').toContain('1.0.0')
  })

  it('does not dress an empty repository up as a failure', () => {
    // Reached, and nothing there. Titling that "could not be completed" would send somebody looking
    // for a network problem they do not have.
    const nothing = noticePrompt({ locale: 'en', kind: 'nothing-published', current: '1.0.0' })
    const failed = noticePrompt({ locale: 'en', kind: 'check-failed', current: '1.0.0' })

    expect(nothing.severity).toBe('info')
    expect(failed.severity).toBe('warning')
    expect(nothing.title).not.toBe(failed.title)
  })
})

describe('two checks at once', () => {
  it('makes one request and shows one dialogue', async () => {
    /*
      A timer firing while a check is already in flight, or an impatient second click. Two overlapping
      checks would not corrupt anything — they would show the same offer twice, which is how a
      dialogue trains people to dismiss it without reading.
    */
    const h = harness({ current: '1.0.0', feed: { kind: 'offer', version: '1.1.0' } })
    const [first, second] = await Promise.all([
      h.service.checkAutomatically(),
      h.service.checkAutomatically()
    ])

    expect(h.checks).toBe(1)
    expect(h.prompts).toHaveLength(1)
    expect(second).toEqual(first)
  })

  it('lets a person asking mid-check be answered by the check already running', async () => {
    /*
      The alternative shapes are both bad: refuse the click, and the menu item does nothing when
      pressed at the wrong second; start a second check, and there are two requests and two
      dialogues. So the running check adopts the request and reports its result — which only works
      because whether to announce is read *after* the round trip.
    */
    // A gate rather than a delay: the second caller arrives while the first request is genuinely
    // outstanding, with no dependence on how fast anything runs.
    let release = (): void => {}
    const outstanding = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({
      current: '1.0.0',
      feed: async () => {
        await outstanding
        return { kind: 'nothing-published' }
      }
    })

    const automatic = h.service.checkAutomatically()
    const asked = h.service.checkOnDemand()
    release()
    await Promise.all([automatic, asked])

    expect(h.checks).toBe(1)
    expect(h.prompts.map((prompt) => prompt.kind)).toEqual(['nothing-published'])
  })

  it('answers an impatient second press from the check already running', async () => {
    /*
      The property the settings button rests on, asserted for the case the button creates.

      The two tests above cover a timer racing a timer and a person arriving mid-timer. Neither covers
      two *on-demand* checks, which is what a button in a page invites — a control that looks
      unresponsive for a second is a control people press again. The view disables it, but that is a
      courtesy in a renderer; this is the guarantee in the core, and it is the one that decides how
      many requests reach GitHub.

      A gate rather than a delay, so the second press lands while the first request is genuinely
      outstanding without depending on how fast anything runs.
    */
    let release = (): void => {}
    const outstanding = new Promise<void>((resolve) => {
      release = resolve
    })
    const h = harness({
      current: '1.0.0',
      feed: async () => {
        await outstanding
        return { kind: 'offer', version: '1.1.0' }
      }
    })

    const first = h.service.checkOnDemand()
    const second = h.service.checkOnDemand()
    release()
    const [a, b] = await Promise.all([first, second])

    expect(h.checks, 'a second press sent a second request to GitHub').toBe(1)
    expect(h.prompts).toHaveLength(1)
    expect(b).toEqual(a)
  })

  it('forgets that somebody asked once the check is over', async () => {
    /*
      Otherwise the first on-demand check would make every later automatic one talkative, and a
      browser that says "no new version" once an hour is worse than one that says nothing.
    */
    const h = harness({ current: '1.0.0', feed: { kind: 'nothing-published' } })
    await h.service.checkOnDemand()
    await h.service.checkAutomatically()

    expect(h.prompts).toHaveLength(1)
  })
})

describe('the timer the check runs on', () => {
  it('schedules nothing when the intervals are zero', () => {
    // The escape hatch every other test here relies on. Without it each of them would depend on a
    // clock, and the two flaky-test lessons in this repository were both wall-clock budgets in
    // disguise.
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const repeating = vi.spyOn(globalThis, 'setInterval')
    try {
      harness().service.start()
      expect(scheduled).not.toHaveBeenCalled()
      expect(repeating).not.toHaveBeenCalled()
    } finally {
      scheduled.mockRestore()
      repeating.mockRestore()
    }
  })

  it('waits before the first check, repeats after it, and holds the process open for neither', () => {
    /*
      Three properties, all about a request nobody asked for.

      The delay keeps the check out of the launch, which is the moment the user is waiting for a
      window. The interval is what makes a browser left open for a week notice anything at all. And
      `unref` is what keeps a browser that has finished from staying alive for a pending timer — a
      process that will not exit gets reported as the browser hanging, and an update timer is not
      where anybody would look.
    */
    const h = harness({ shippedTimers: true })
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const repeating = vi.spyOn(globalThis, 'setInterval')
    try {
      h.service.start()

      expect(scheduled).toHaveBeenCalledWith(expect.any(Function), FIRST_CHECK_DELAY_MS)
      expect(repeating).toHaveBeenCalledWith(expect.any(Function), CHECK_INTERVAL_MS)
      for (const created of [...scheduled.mock.results, ...repeating.mock.results]) {
        const timer = created.value as { hasRef(): boolean }
        expect(timer.hasRef(), 'the timer keeps the process alive').toBe(false)
      }
    } finally {
      h.service.stop()
      scheduled.mockRestore()
      repeating.mockRestore()
    }
  })

  it('puts the first check within a few seconds of launch, and not at zero', () => {
    /*
      The test above cannot see this, and that is why this one exists.

      It asserts `toHaveBeenCalledWith(..., FIRST_CHECK_DELAY_MS)` — the imported constant — so it
      stays green for any value at all, including the five minutes the user asked to be rid of
      ("update scan auch direkt beim starten, nicht erst nach 5 min"). A test that cannot fail is
      not what makes a decision durable; the number is.

      Both bounds are load-bearing and neither is a style choice. The upper one is the decision.
      The lower one is a trap: `start()` reads `first > 0` as "schedule nothing", which is the
      escape hatch every other test in this file uses to avoid a clock — so shortening the wait to
      zero would not hasten the check, it would silently remove it, and every test here would still
      pass.
    */
    expect(FIRST_CHECK_DELAY_MS).toBeGreaterThan(0)
    expect(FIRST_CHECK_DELAY_MS).toBeLessThanOrEqual(10_000)
  })

  it('runs a real check when it fires, and still says nothing', async () => {
    /*
      The callbacks the timers carry, invoked the way the clock would invoke them. Without this, the
      two lines joining the schedule to the check are the only untested thing between "a browser that
      looks for updates" and "a browser with a timer that does nothing" — and the second passes every
      other test in this file.
    */
    const h = harness({
      current: '1.0.0',
      feed: { kind: 'offer', version: '0.9.0' },
      shippedTimers: true
    })
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const repeating = vi.spyOn(globalThis, 'setInterval')
    try {
      h.service.start()
      const first = scheduled.mock.calls.at(0)?.[0]
      const later = repeating.mock.calls.at(0)?.[0]
      if (typeof first !== 'function' || typeof later !== 'function') {
        throw new Error('the timers were installed without a callback')
      }

      first()
      // Sequential, not concurrent: the second must be a second check rather than joining the first.
      await settle()
      later()
      await settle()

      expect(h.checks).toBe(2)
      expect(h.prompts, 'a timer produced a dialogue nobody asked for').toEqual([])
    } finally {
      h.service.stop()
      scheduled.mockRestore()
      repeating.mockRestore()
    }
  })

  it('clears what it scheduled, once', () => {
    const h = harness({ shippedTimers: true })
    h.service.start()
    const cleared = vi.spyOn(globalThis, 'clearInterval')
    try {
      h.service.stop()
      expect(cleared).toHaveBeenCalledTimes(1)
      // Stopping twice must not clear a handle a second time: by then the number could belong to
      // somebody else's timer.
      h.service.stop()
      expect(cleared).toHaveBeenCalledTimes(1)
    } finally {
      cleared.mockRestore()
    }
  })
})

describe('nothing here may end the browser', () => {
  it('reports a dialogue that could not be shown instead of dying of it', async () => {
    /*
      `showPrompt` reaches Electron's `dialog`, which can reject — no display, a window destroyed
      between the check and the answer. Both entry points discard the promise they create, so an
      unhandled rejection would end the process, and Node ending this browser because a message box
      failed is not hypothetical: it happened in the master-password prompt, where `#submit` had a
      `try/finally` without a `catch`.
    */
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const h = harness({
        current: '1.0.0',
        feed: { kind: 'offer', version: '9.9.9' },
        showPrompt: () => Promise.reject(new Error('no display'))
      })
      h.service.checkNow()
      await settle()

      expect(reported).toHaveBeenCalledWith(
        '[updates] the check ended unexpectedly:',
        'Error: no display'
      )
    } finally {
      reported.mockRestore()
    }
  })
})
