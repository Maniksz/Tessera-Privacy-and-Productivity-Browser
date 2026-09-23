import type { Locale } from '@shared/i18n/catalog.js'
import type { Platform } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { updateText, type UpdateTextKey } from './update-text.js'
import { isUpgrade, type UpdateChannel } from './version.js'

/**
 * The update check: one request to GitHub, and three consents before anything replaces this program.
 *
 * ## Why a seam rather than `autoUpdater` at the call site
 *
 * Everything Electron-shaped is an injected port — the updater, the message box, the browser that
 * opens a release page — so every rule below is a test rather than a claim. That matters more here
 * than in most places: the interesting cases are *refusals* (a user who said no, an unsigned build
 * that must not be offered a download, a check nobody asked for that failed), and a refusal that
 * quietly stops working looks exactly like nothing happening. `install-updates.ts` is the adapter
 * that supplies the real ports, and it holds no decision of its own.
 *
 * ## What a check sends over the network
 *
 * Two or three GET requests to `github.com`, and this is the complete list of what leaves the
 * machine:
 *
 *   - `GET /<owner>/<repo>/releases.atom` — the public Atom feed of releases.
 *   - `GET /<owner>/<repo>/releases/latest` — only when the channel is `stable`, to resolve which
 *     tag GitHub considers the newest *release*.
 *   - `GET /<owner>/<repo>/releases/download/<tag>/<channel>-<platform>.yml` — the version, the file
 *     names and the checksums.
 *
 * Headers: `User-Agent: electron-builder`, `Cache-Control: no-cache`, an `Accept`, and
 * `x-user-staging-id` — which `electron-updater` fills with a **random UUID it persists in the
 * profile**. That header is the one thing here that would identify a particular installation across
 * checks, so `install-updates.ts` overwrites it with a fixed nil UUID and writes that same nil UUID
 * into the file the library reads. Nothing else is added: no version-of-ours header, no query
 * string, no body.
 *
 * The request carries no cookies from browsing and leaves none behind. `electron-updater` uses
 * `session.fromPartition('electron-updater')`, which has no `persist:` prefix and therefore lives in
 * memory only, with `cache: false`. It is not the default session and not any window's session, so
 * a private window's session is never involved — which is also why the timer below belongs to the
 * application rather than to a window.
 *
 * GitHub sees an IP address, a rough version (from which channel file is asked for) and, in
 * aggregate, how many people run this browser. That cost is written down in `electron-builder.yml`
 * and is not re-argued here.
 *
 * ## What can make a page trigger this, and what still cannot
 *
 * This used to say there was no IPC channel at all, and that the absence was the property. **There is
 * one now** — `updates:checkNow`, added on the user's instruction of 29.07.2026 — so the property is
 * carried by something narrower and has to be named precisely.
 *
 * The channel is granted to `tessera://settings` and to no other page, a fitness function holds it
 * there, `decideAccess` refuses web content outright, and since the same round a `will-frame-navigate`
 * lock stops a web page from *opening* the settings page to borrow its grants. It reaches
 * `checkOnDemand()` and nothing further: `download` and `installAndRestart` still have no channel, so
 * the most a page can cause is a request to GitHub and a dialogue the user answers.
 *
 * What would lose the property is a second grant, not a second caller — which is why the test asserts
 * the grant list rather than counting callers.
 *
 * ## The three consents
 *
 * The user's rule is that nothing is downloaded or installed without their approval, so the flow has
 * three stops and each one is a person answering a question:
 *
 *   1. **Check → tell.** A check only reads the feed. Finding a newer version produces a message box
 *      naming both versions, never a download. `autoDownload: false` is what makes that true at the
 *      library level; `UpdatePolicy` types it as the literal `false` so a future edit cannot pass
 *      `true` without the compiler objecting.
 *   2. **Approve → download.** `download()` is reached only from the `download` answer.
 *   3. **Choose when → restart.** A downloaded update installs on restart and nothing else triggers
 *      it: `autoInstallOnAppQuit: false`, so quitting normally does not install it either. Answering
 *      "later" leaves the file in the cache and installs nothing.
 *
 * A version that has been answered is not raised again by a timer — see `#alreadyOffered`. Consent
 * asked for repeatedly stops being consent; it becomes a box people close without reading, and this
 * one has a Download button where the cursor already is.
 *
 * ## What a failed check does
 *
 * Nothing, unless the user asked. No network, a rate limit, a repository with nothing published yet
 * and a build that cannot update itself are all ordinary, and none of them may interrupt somebody
 * who is browsing — an update checker that produces error boxes teaches people to switch it off,
 * which costs them the security fixes it exists to deliver. So an automatic check that fails writes
 * one line to the console and stops. A check the user asked for answers with one sentence.
 *
 * A **download** that fails always reports, whichever way the check started, because by then the
 * user has explicitly asked for it and is waiting.
 *
 * `UpdaterPort.check` returns a result rather than throwing for the same reason: "quiet" is then a
 * property of the shape, not of somebody remembering a `catch`.
 */

/**
 * Where the release page lives, and the repository the feed is read from.
 *
 * Duplicated from the `publish:` block of `electron-builder.yml`, which is where the running updater
 * gets it from — `electron-updater` bakes those two values into `app-update.yml` at build time and
 * exposes them nowhere at runtime (`getFeedURL()` returns the string "Deprecated. Do not use it.").
 * A fitness test comparing these two against the YAML is the thing that keeps the copy honest; see
 * the report accompanying this change.
 */
export const UPDATE_REPOSITORY = {
  owner: 'Maniksz',
  repo: 'Tessera-Privacy-and-Productivity-Browser'
} as const

/** Per platform, whether an update may replace this program in place. */
export type InPlaceUpdates = Readonly<Record<Platform, boolean>>

/**
 * Which platforms may download and install an update themselves. **None, today.**
 *
 * The rule is that an update nobody can verify does not install itself: the person is sent to the
 * release page and installs it by hand, with their operating system's own warning in front of them.
 * No build of this browser is signed yet, and each platform turns that into a different failure,
 * which is why this is a table rather than one switch — each row is flipped by its own change, and
 * nothing else moves when it is, because `updateDelivery` already routes on it.
 *
 * `architecture.test.ts` ties the macOS and Windows rows to the release pipeline, so neither can be
 * set to `true` while the build it describes is still unsigned.
 */
export const IN_PLACE_UPDATES: InPlaceUpdates = {
  /**
   * Squirrel.Mac — what an in-place update on macOS goes through, underneath `electron-updater` —
   * refuses to replace an application whose code signature it cannot verify. A download offered here
   * would produce a progress bar, a restart, and the same old version.
   *
   * Flipped by an Apple Developer ID: `.github/workflows/release.yml` (and `scripts/release.mjs`)
   * build with `--config.mac.identity=null --config.mac.notarize=false` until one exists. When those
   * overrides come out, this becomes `true` in the same change.
   */
  darwin: false,
  /**
   * `NsisUpdater` would not refuse, which is worse: it checks the installer's Authenticode signature
   * against `publisherName` from `app-update.yml`, and without one it skips the check and installs
   * whatever the release holds.
   *
   * Flipped by two things together: a code-signing certificate in the environment of the publish job
   * (`WIN_CSC_LINK` or `CSC_LINK`), and `win.publisherName` in `electron-builder.yml` naming the
   * subject of that certificate. The first alone signs the installer; only the second makes the
   * updater look.
   */
  win32: false,
  /**
   * The AppImage updater checks no signature at all — only the checksum in `latest-linux.yml`, which
   * comes from the same release as the file it describes, so it proves the download is intact and
   * not who made it.
   *
   * No configuration flips this. It takes a signature check of our own, over something signed with a
   * key the release pipeline does not hold, and until that exists the row stays `false`.
   */
  linux: false
}

/**
 * How long after launch the first automatic check happens.
 *
 * **Three seconds, down from five minutes, on the user's instruction of 29.07.2026: "update scan
 * auch direkt beim starten, nicht erst nach 5 min".** Half of the original argument is overruled
 * and half of it survives, and the difference is why this is not zero.
 *
 * Overruled: that a browser opened briefly and closed again should never check at all. That was a
 * politeness the user does not want — an alpha build that has just been relaunched is exactly when
 * its owner wants to know there is a newer one.
 *
 * Still true: launch is the busiest moment a browser has, and the first window appearing is what
 * the person is waiting for. A network request racing first paint costs something visible, and the
 * check is worth nothing three seconds sooner. Zero is also not available as a value — `start()`
 * reads `first > 0` as "schedule nothing", which is the escape hatch every test in
 * `update-service.test.ts` relies on, so a literal 0 here would silently disable the feature
 * rather than hasten it.
 */
export const FIRST_CHECK_DELAY_MS = 3_000

/** How often after that. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000

/**
 * The address of the release a user is sent to when the download cannot work.
 *
 * The tag of the offered version rather than `/releases/latest`, and both halves of that are
 * deliberate: `latest` on GitHub means the newest *non-prerelease* release, which for this project
 * does not exist yet, and a person who has just been told "version X is available" should land on
 * version X rather than on a list to search.
 *
 * Concatenation is safe because `version` has already been through `parseVersion` by the time this
 * is called — nothing that could contain a slash gets this far. The leading `v` is stripped first so
 * a tag-shaped input cannot produce `vv0.1.0`; `scripts/release.mjs` tags `v` + the version, which
 * is the form this rebuilds.
 */
export function releasePageUrl(version: string): string {
  const { owner, repo } = UPDATE_REPOSITORY
  return `https://github.com/${owner}/${repo}/releases/tag/v${version.replace(/^v/, '')}`
}

/** How an update reaches the user on this platform. */
export type UpdateDelivery = 'in-place' | 'release-page'

/**
 * Which of the two routes this build can offer.
 *
 * The release page unless the platform's row says otherwise; see `IN_PLACE_UPDATES` for what each
 * row waits for.
 */
export function updateDelivery(input: {
  readonly platform: Platform
  readonly inPlaceUpdates: InPlaceUpdates
}): UpdateDelivery {
  return input.inPlaceUpdates[input.platform] ? 'in-place' : 'release-page'
}

/**
 * What the updater is told before every check.
 *
 * The two `false`s are typed as literals rather than as `boolean` on purpose: the user's rule is
 * that nothing is downloaded or installed without their approval, and this is the one place where
 * that rule is a single assignment away from being lost. A `true` here would not fail a test — it
 * would silently make the first consent decorative — so the compiler is asked to hold it instead.
 */
export interface UpdatePolicy {
  /**
   * Follows the channel, and getting it wrong is invisible.
   *
   * GitHub's "latest release" excludes prereleases, so with this `false` an alpha user is told there
   * is no update when in fact every published version is one. The failure looks like success, which
   * is why the channel is threaded all the way here rather than being left to `electron-updater`'s
   * own default (it guesses from the running version, which is a different rule from the user's
   * setting).
   */
  readonly allowPrerelease: boolean
  readonly autoDownload: false
  readonly autoInstallOnAppQuit: false
}

export function updatePolicyFor(channel: UpdateChannel): UpdatePolicy {
  return { allowPrerelease: channel === 'alpha', autoDownload: false, autoInstallOnAppQuit: false }
}

/**
 * What reading the feed produced.
 *
 * A total result rather than a thrown error, because every one of these is an ordinary Tuesday: the
 * machine is offline, GitHub is rate-limiting, the repository has no releases yet, or this copy was
 * built from source and has no feed at all. A `throw` would put the quietness of those cases in a
 * `catch` somebody could forget; here it is the type.
 *
 * `offer` reports the version the feed names **without** claiming it is an upgrade. That judgement
 * is `isUpgrade`'s, deliberately not `electron-updater`'s: its comparison answers "is this
 * different", ours answers "should this person be shown this", and the second is the one a user
 * lives with.
 */
export type UpdateFeedResult =
  | { readonly kind: 'offer'; readonly version: string }
  | { readonly kind: 'nothing-published' }
  | { readonly kind: 'unreachable'; readonly detail: string }
  /** Not installed from a release — run from source, or an unpacked build. */
  | { readonly kind: 'no-feed' }

export type UpdateDownloadResult =
  | { readonly kind: 'downloaded' }
  | { readonly kind: 'failed'; readonly detail: string }

/**
 * The updater, as this service needs it.
 *
 * Four methods, and `electron-updater` is the only implementation that will ever exist — the point
 * of the interface is not substitutability but that the flow above can be driven in a test without
 * a packaged application, a network or a signed binary.
 */
export interface UpdaterPort {
  /** Applied before every check, so a channel change takes effect on the next one. */
  configure(policy: UpdatePolicy): void
  check(): Promise<UpdateFeedResult>
  /** Downloads what the last `check` found. Only ever reached with the user's approval. */
  download(): Promise<UpdateDownloadResult>
  /** Quits and installs. Returns nothing: on success this process is on its way out. */
  installAndRestart(): void
}

/** Which answer a button carries, independent of the label it is drawn with. */
export type UpdateAnswer = 'download' | 'release-page' | 'restart' | 'dismiss'

export interface UpdatePromptButton {
  readonly label: string
  readonly answer: UpdateAnswer
}

/** Every kind of message box this service can raise. */
export type UpdatePromptKind =
  | 'offer'
  | 'ready'
  | 'up-to-date'
  | 'nothing-published'
  | 'check-failed'
  | 'download-failed'
  | 'no-feed'

/**
 * A native message box, described rather than shown.
 *
 * The core builds the presentation and the Electron layer draws it, as with the permission prompt
 * and the tile bar. It costs one interface and buys the wording, the button order and *which button
 * Escape picks* being covered by tests — the last of which is not cosmetic: on the offer, the button
 * that changes nothing has to be the one a stray Return or an Escape lands on, or a dismissed dialog
 * starts a download.
 */
export interface UpdatePrompt {
  readonly kind: UpdatePromptKind
  readonly severity: 'info' | 'warning'
  readonly title: string
  readonly message: string
  readonly detail?: string
  readonly buttons: readonly UpdatePromptButton[]
  /** Index into `buttons` of the answer that changes nothing. */
  readonly cancelIndex: number
}

export type ShowUpdatePrompt = (prompt: UpdatePrompt) => Promise<UpdateAnswer>

/** What one check ended up doing. Returned so a caller — and a test — can say which path ran. */
export type UpdateOutcome =
  | { readonly kind: 'not-checked'; readonly reason: 'setting-off' | 'already-offered' }
  | { readonly kind: 'no-feed' }
  | { readonly kind: 'check-failed' }
  | { readonly kind: 'nothing-published' }
  | { readonly kind: 'up-to-date'; readonly version: string }
  | { readonly kind: 'declined'; readonly version: string }
  | { readonly kind: 'sent-to-release-page'; readonly version: string }
  | { readonly kind: 'download-failed'; readonly version: string }
  | { readonly kind: 'waiting-for-restart'; readonly version: string }
  | { readonly kind: 'restarting'; readonly version: string }

export interface UpdateServiceOptions {
  readonly updater: UpdaterPort
  /** Read per check, so switching the setting off stops the next one rather than the next launch. */
  readonly getSettings: () => SettingsSnapshot
  /** Read per prompt, so a language change reaches the next dialog. */
  readonly locale: () => Locale
  readonly currentVersion: () => string
  readonly platform: Platform
  readonly showPrompt: ShowUpdatePrompt
  readonly openReleasePage: (url: string) => void
  /**
   * Overridden in tests; defaults to `IN_PLACE_UPDATES`. The adapter must not pass it — the fitness
   * functions check that table, and a second one here would be invisible to them.
   */
  readonly inPlaceUpdates?: InPlaceUpdates
  /** `0` installs no timer, and a test then calls `checkAutomatically()` itself. */
  readonly firstCheckDelayMs?: number
  readonly checkIntervalMs?: number
}

/** A timer this service owns, with the one thing it needs to be able to do to it. */
interface ScheduledCheck {
  clear(): void
}

export class UpdateService {
  readonly #options: UpdateServiceOptions
  readonly #scheduled: ScheduledCheck[] = []

  /**
   * The check that is currently running, so two cannot overlap.
   *
   * Overlapping checks would not corrupt anything; they would produce *two dialogs* offering the
   * same version, which is how a user learns to ignore them.
   */
  #inFlight: Promise<UpdateOutcome> | null = null

  /**
   * Whether the result gets said out loud.
   *
   * Raised by an on-demand check and read *after* the network round trip, which is what makes
   * clicking "Check for updates…" while an automatic check is already in flight do the useful thing:
   * the running check adopts the user's request and reports its result, instead of the click being
   * swallowed or a second request going out.
   */
  #announce = false

  /**
   * Versions this person has already been shown and has not taken.
   *
   * Without it, saying "not now" to a version buys twenty-four hours of silence and then the same box
   * again, for as long as the browser stays open and that version stays newest — which is precisely
   * how a dialogue teaches people to dismiss it unread, and this one has a Download button under the
   * cursor. Declining and postponing a restart both count: in either case the user has been asked
   * about that version and answered.
   *
   * Held in memory only, so a restart asks again — which is right, because a restart is also when
   * somebody would want to be reminded. And it is ignored by an on-demand check: somebody who opens
   * the menu and asks has withdrawn the "not now".
   */
  readonly #alreadyOffered = new Set<string>()

  constructor(options: UpdateServiceOptions) {
    this.#options = options
  }

  /**
   * Installs the recurring check.
   *
   * Called once for the application, not once per window: a check belongs to the program, and one
   * per window would multiply the requests by however many windows somebody keeps open and would
   * put a timer inside the lifetime of a private window.
   *
   * The timers fire regardless of the setting and `checkAutomatically` consults it when they do —
   * `updates.checkAutomaticallyOnGithub` is `applies: 'live'`, and a timer that had to be installed
   * and removed as the switch moved is a second piece of state to get wrong.
   */
  start(): void {
    const first = this.#options.firstCheckDelayMs ?? FIRST_CHECK_DELAY_MS
    const every = this.#options.checkIntervalMs ?? CHECK_INTERVAL_MS

    /*
      Briefly delayed rather than immediate, and the brevity is the part that was argued over.

      Launch is the busiest moment a browser has, and the first window appearing is what the user is
      waiting for, so the request waits until that is done. It used to wait five minutes, which also
      meant a browser opened to look something up and closed again never checked at all — that was
      deliberate politeness, and the user overruled it: on an alpha build, a relaunch is precisely
      when its owner wants to hear about a newer one. See `FIRST_CHECK_DELAY_MS`, including why the
      answer is not zero.

      `first > 0` stays a guard rather than a floor: zero means "schedule nothing", which is how
      every test here avoids a clock. Shortening the wait must not be done by passing 0.
    */
    if (first > 0) {
      const timer = setTimeout(() => {
        this.#detach(this.checkAutomatically())
      }, first)
      this.#keep(timer, () => {
        clearTimeout(timer)
      })
    }

    if (every > 0) {
      const timer = setInterval(() => {
        this.#detach(this.checkAutomatically())
      }, every)
      this.#keep(timer, () => {
        clearInterval(timer)
      })
    }
  }

  stop(): void {
    for (const scheduled of this.#scheduled) scheduled.clear()
    this.#scheduled.length = 0
  }

  /**
   * The Help menu's entry point.
   *
   * `void`-returning and never rejecting, because the alternative is a menu item whose handler
   * returns a promise nobody holds: an unhandled rejection ends the process, and this project has
   * already lost a browser that way once (`#submit` in the master-password prompt).
   */
  checkNow(): void {
    this.#detach(this.checkOnDemand())
  }

  /** The timer's body. Refuses when the user has switched automatic checks off. */
  async checkAutomatically(): Promise<UpdateOutcome> {
    if (!this.#options.getSettings()['updates.checkAutomaticallyOnGithub']) {
      return { kind: 'not-checked', reason: 'setting-off' }
    }
    return this.#check(false)
  }

  /** Asked for by a person, so this one reports whatever it finds — including nothing. */
  async checkOnDemand(): Promise<UpdateOutcome> {
    return this.#check(true)
  }

  async #check(announce: boolean): Promise<UpdateOutcome> {
    if (announce) this.#announce = true

    const running = this.#inFlight
    if (running !== null) return running

    const started = this.#run()
    this.#inFlight = started
    try {
      return await started
    } finally {
      this.#inFlight = null
      this.#announce = false
    }
  }

  async #run(): Promise<UpdateOutcome> {
    const { updater, getSettings, currentVersion } = this.#options
    const current = currentVersion()
    const channel: UpdateChannel = getSettings()['updates.channel']

    updater.configure(updatePolicyFor(channel))
    const found = await updater.check()

    if (found.kind === 'unreachable') {
      // One line, and only when nobody asked. The detail is the library's message, which names the
      // URL and the status — useful in a terminal, useless in a dialog.
      console.warn('[updates] the check could not be completed:', found.detail)
      await this.#announceNotice('check-failed', current)
      return { kind: 'check-failed' }
    }
    if (found.kind === 'nothing-published') {
      await this.#announceNotice('nothing-published', current)
      return { kind: 'nothing-published' }
    }
    if (found.kind === 'no-feed') {
      await this.#announceNotice('no-feed', current)
      return { kind: 'no-feed' }
    }

    const version = found.version
    if (!isUpgrade({ current, candidate: version, channel })) {
      await this.#announceNotice('up-to-date', current)
      return { kind: 'up-to-date', version }
    }
    // Asked and answered. A person who wants to be asked again presses the menu item.
    if (!this.#announce && this.#alreadyOffered.has(version)) {
      return { kind: 'not-checked', reason: 'already-offered' }
    }

    return this.#offer({ current, version })
  }

  /** Consent one, and the fork between the two ways an update can reach the user. */
  async #offer(input: { current: string; version: string }): Promise<UpdateOutcome> {
    const { showPrompt, openReleasePage, platform } = this.#options
    const delivery = updateDelivery({
      platform,
      inPlaceUpdates: this.#options.inPlaceUpdates ?? IN_PLACE_UPDATES
    })

    const answer = await showPrompt(
      offerPrompt({
        locale: this.#options.locale(),
        current: input.current,
        version: input.version,
        delivery,
        platform
      })
    )

    if (answer === 'release-page') {
      openReleasePage(releasePageUrl(input.version))
      return { kind: 'sent-to-release-page', version: input.version }
    }
    // The route is checked again rather than trusted to the buttons that were drawn: which buttons a
    // prompt shows is presentation, and "nothing unverified installs itself" is not a rule to leave
    // to presentation. An answer the offer did not carry changes nothing.
    if (answer !== 'download' || delivery !== 'in-place') {
      this.#alreadyOffered.add(input.version)
      return { kind: 'declined', version: input.version }
    }

    return this.#download(input.version)
  }

  /** Consent two has been given; consent three is the restart. */
  async #download(version: string): Promise<UpdateOutcome> {
    const { updater, showPrompt, locale } = this.#options
    const downloaded = await updater.download()

    if (downloaded.kind === 'failed') {
      /*
        Reported whichever way the check started, unlike a failed check.

        The user pressed Download and is waiting for something to happen; silence here would leave
        them believing an update is on its way. This is the one failure in this file that is never
        quiet.
      */
      console.warn('[updates] the download could not be completed:', downloaded.detail)
      await showPrompt(noticePrompt({ locale: locale(), kind: 'download-failed', current: version }))
      return { kind: 'download-failed', version }
    }

    const answer = await showPrompt(restartPrompt({ locale: locale(), version }))
    if (answer !== 'restart') {
      // The file is on disk and nothing will install it. Not re-offered on a timer for the same
      // reason as a decline — and the download is cached, so answering the menu item later is cheap.
      this.#alreadyOffered.add(version)
      return { kind: 'waiting-for-restart', version }
    }

    updater.installAndRestart()
    return { kind: 'restarting', version }
  }

  /** Says nothing unless a person asked. The single place that rule is applied. */
  async #announceNotice(kind: NoticeKind, current: string): Promise<void> {
    if (!this.#announce) return
    await this.#options.showPrompt(noticePrompt({ locale: this.#options.locale(), kind, current }))
  }

  #keep(timer: { unref(): void }, clear: () => void): void {
    // Unreferenced, so an update check is never the reason the process stays alive.
    timer.unref()
    this.#scheduled.push({ clear })
  }

  /**
   * Runs a check nobody is awaiting, and swallows nothing.
   *
   * `showPrompt` reaches Electron's `dialog`, which can reject; without this the rejection would be
   * unhandled and Node would end the process. An update check must not be able to close a browser.
   */
  #detach(work: Promise<UpdateOutcome>): void {
    void work.catch((error: unknown) => {
      console.error('[updates] the check ended unexpectedly:', String(error))
    })
  }
}

/** The results that are reported as a sentence rather than acted on. */
export type NoticeKind = Extract<
  UpdatePromptKind,
  'up-to-date' | 'nothing-published' | 'check-failed' | 'download-failed' | 'no-feed'
>

/**
 * Consent one, as a message box.
 *
 * Names both versions, because "an update is available" without saying from what to what is a
 * request to trust the dialog. The accepting button is first — the platform draws it as the default
 * — and `cancelIndex` points at the one that changes nothing, so Escape and a stray Return both
 * decline.
 *
 * On the release-page route the detail says why, in the terms of the person's own platform — and
 * on Windows it also says what they will meet when they install by hand, because an unsigned
 * installer is what SmartScreen stops, and a warning nobody mentioned reads as the download being
 * malicious.
 */
export function offerPrompt(input: {
  readonly locale: Locale
  readonly current: string
  readonly version: string
  readonly delivery: UpdateDelivery
  readonly platform: Platform
}): UpdatePrompt {
  const t = (key: UpdateTextKey, params?: Readonly<Record<string, string>>): string =>
    updateText(input.locale, key, params)

  const accept: UpdatePromptButton =
    input.delivery === 'in-place'
      ? { label: t('download'), answer: 'download' }
      : { label: t('openReleasePage'), answer: 'release-page' }

  return {
    kind: 'offer',
    severity: 'info',
    title: t('offerTitle'),
    message: t('offerMessage', { version: input.version, current: input.current }),
    detail:
      input.delivery === 'in-place' ? t('offerDetail') : t(RELEASE_PAGE_DETAIL[input.platform]),
    buttons: [accept, { label: t('notNow'), answer: 'dismiss' }],
    cancelIndex: 1
  }
}

/** Why a platform is sent to the release page. A table, so a platform without a reason does not compile. */
const RELEASE_PAGE_DETAIL: Readonly<Record<Platform, UpdateTextKey>> = {
  darwin: 'macNotSignedDetail',
  win32: 'windowsNotSignedDetail',
  linux: 'linuxNotSignedDetail'
}

/** Consent three. "Later" is a real answer: nothing installs until this box is answered again. */
export function restartPrompt(input: {
  readonly locale: Locale
  readonly version: string
}): UpdatePrompt {
  const t = (key: UpdateTextKey, params?: Readonly<Record<string, string>>): string =>
    updateText(input.locale, key, params)

  /*
    One sentence and no `detail`, unlike the offer.

    It was cut for the renderer's catalogue budget, back when these sentences lived in that chunk; they
    are in `update-text.*` now and that constraint is gone. The one sentence stays because it already
    carries the part a person acts on — that the restart is when it installs, and that until then
    nothing changes. A `detail` added now would have to say something the message does not.
  */
  return {
    kind: 'ready',
    severity: 'info',
    title: t('readyTitle'),
    message: t('readyMessage', { version: input.version }),
    buttons: [
      { label: t('restartNow'), answer: 'restart' },
      { label: t('later'), answer: 'dismiss' }
    ],
    cancelIndex: 1
  }
}

/**
 * The one-sentence answers, for a check somebody asked for.
 *
 * A sentence rather than an error code, and each one says what state the user's copy is in — "your
 * copy is unchanged" is the fact they actually want, and an `ERR_UPDATER_*` string does not contain
 * it. A single dismissing button, so none of these can start anything.
 */
export function noticePrompt(input: {
  readonly locale: Locale
  readonly kind: NoticeKind
  readonly current: string
}): UpdatePrompt {
  const t = (key: UpdateTextKey, params?: Readonly<Record<string, string>>): string =>
    updateText(input.locale, key, params)

  const wording = NOTICE_WORDING[input.kind]
  return {
    kind: input.kind,
    severity: wording.severity,
    title: t(wording.title),
    message: t(wording.message, { current: input.current }),
    buttons: [{ label: t('ok'), answer: 'dismiss' }],
    cancelIndex: 0
  }
}

/**
 * Which sentence belongs to which outcome.
 *
 * A table rather than a chain of `if`s so that adding an outcome without wording it is a compile
 * error. "Nothing published" shares the *title* of "up to date" because that is what it means to a
 * user — there is no newer version — while the sentence underneath is honest about the difference.
 */
const NOTICE_WORDING: Readonly<
  Record<
    NoticeKind,
    {
      readonly title: UpdateTextKey
      readonly message: UpdateTextKey
      readonly severity: 'info' | 'warning'
    }
  >
> = {
  'up-to-date': {
    title: 'upToDateTitle',
    message: 'upToDateMessage',
    severity: 'info'
  },
  'nothing-published': {
    title: 'upToDateTitle',
    message: 'nothingPublishedMessage',
    severity: 'info'
  },
  'check-failed': {
    title: 'checkFailedTitle',
    message: 'checkFailedMessage',
    severity: 'warning'
  },
  'download-failed': {
    title: 'downloadFailedTitle',
    message: 'downloadFailedMessage',
    severity: 'warning'
  },
  'no-feed': {
    title: 'noFeedTitle',
    message: 'noFeedMessage',
    severity: 'info'
  }
}
