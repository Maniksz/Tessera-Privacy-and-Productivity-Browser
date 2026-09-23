import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OverlayPresentation, PermissionRequestPresentation } from '@shared/overlay/surface.js'
import type { PermissionSubject } from '@shared/overlay/permission.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import {
  MAX_QUEUED_PROMPTS,
  PermissionArbiter,
  type PermissionHost
} from '@main/permissions/PermissionArbiter.js'
import { notifyOverlayVacancy, onOverlayVacancy } from '@main/permissions/vacancy.js'
import {
  endsPrompt,
  forgetfulSitePermissions,
  promptForActiveTab,
  type PermissionTabChange,
  type SitePermissionRules
} from '@main/permissions/model.js'
import type { BrowsingMode } from '@main/data/HistoryStore.js'
import type { PermissionDecision } from '@main/session/permission-policy.js'

/**
 * Two pages, one dialogue: what happens to the second request.
 *
 * There is one overlay layer per window and it shows one thing at a time, so two pages in two
 * tiles asking at the same moment force a decision. These tests pin the answer: the second one
 * *queues*. Refusing it would hand a page a "no" no human gave — indistinguishable from a real
 * refusal, and a way for one tile to deny another tile's request by asking first.
 *
 * The other half of the file is about the ways a dialogue can leave the screen without being
 * answered: a closed window, a displaced dialogue, a full queue. Each has to arrive as a refusal
 * rather than as a page left waiting forever — and as a refusal *this once*, never remembered,
 * because nobody refused the site.
 */

/** The tab every request comes from unless a test names another. It is the active one by default. */
const TAB = 1

interface FakeHost extends PermissionHost {
  presented: OverlayPresentation[]
  dismissals: number
  /** What `activeTabWebContentsId` answers. */
  active: number | null
  readonly listeners: Set<(change: PermissionTabChange) => void>
  /** Delivers a change the way the window controller does: to every subscriber, synchronously. */
  change(change: PermissionTabChange): void
  /** Brings another tab to the front and says so. */
  activate(webContentsId: number | null): void
}

function fakeHost(options: { privateMode?: boolean; active?: number | null } = {}): FakeHost {
  const host: FakeHost = {
    privateMode: options.privateMode ?? false,
    presented: [],
    dismissals: 0,
    active: options.active === undefined ? TAB : options.active,
    listeners: new Set(),
    presentOverlay: (presentation) => {
      host.presented.push(presentation)
    },
    dismissOverlay: () => {
      host.dismissals += 1
    },
    activeTabWebContentsId: () => host.active,
    onPermissionTabChange: (listener) => {
      host.listeners.add(listener)
      return () => {
        host.listeners.delete(listener)
      }
    },
    change: (change) => {
      for (const listener of [...host.listeners]) listener(change)
    },
    activate: (webContentsId) => {
      host.active = webContentsId
      host.change({ kind: 'activated' })
    }
  }
  return host
}

/**
 * Every prompt that reached the layer, narrowed.
 *
 * `presented` holds `OverlayPresentation`, which is a union — the layout menu and the drop indicator go
 * through the same host. Narrowing once here keeps the assertions readable and fails loudly if a test
 * ever provokes the wrong surface, rather than reading a field off the wrong member of the union.
 */
function prompts(host: FakeHost): PermissionRequestPresentation[] {
  return host.presented.filter(
    (presentation): presentation is PermissionRequestPresentation =>
      presentation.kind === 'permission-request'
  )
}

function lastPrompt(host: FakeHost): PermissionRequestPresentation {
  const [presentation] = host.presented.slice(-1)
  if (presentation === undefined) throw new Error('nothing was presented')
  if (presentation.kind !== 'permission-request') throw new Error('the wrong surface was presented')
  return presentation
}

function askSettings(): SettingsSnapshot {
  return {
    ...defaultSettings(),
    'permissions.geolocation': 'ask',
    'permissions.camera': 'ask',
    'permissions.microphone': 'ask',
    'permissions.notifications': 'ask'
  }
}

function recordingRules(): SitePermissionRules & {
  written: Array<{ origin: string; subject: PermissionSubject; decision: 'allow' | 'deny' }>
  remembered: Map<string, PermissionDecision>
} {
  const written: Array<{
    origin: string
    subject: PermissionSubject
    decision: 'allow' | 'deny'
  }> = []
  const remembered = new Map<string, PermissionDecision>()
  return {
    written,
    remembered,
    recall: (origin, subject) => remembered.get(`${origin} ${subject}`) ?? 'ask',
    remember: (origin, subject, decision) => {
      written.push({ origin, subject, decision })
      remembered.set(`${origin} ${subject}`, decision)
    }
  }
}

function arbiter(
  options: {
    rules?: SitePermissionRules
    rulesFor?: (mode: BrowsingMode) => SitePermissionRules
    settings?: SettingsSnapshot
    maxQueued?: number
  } = {}
): PermissionArbiter {
  let counter = 0
  const rules = options.rules ?? recordingRules()
  return new PermissionArbiter({
    rulesFor: options.rulesFor ?? (() => rules),
    getSettings: () => options.settings ?? askSettings(),
    newRequestId: () => {
      counter += 1
      return `req-${String(counter)}`
    },
    ...(options.maxQueued === undefined ? {} : { maxQueued: options.maxQueued })
  })
}

function geolocation(origin = 'https://example.com'): {
  permission: string
  mediaTypes: readonly string[]
  origin: string
} {
  return { permission: 'geolocation', mediaTypes: [], origin }
}

describe('one request', () => {
  it('presents a dialogue naming the site and the subject', async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)

    const prompt = lastPrompt(host)
    expect(prompt.origin).toBe('https://example.com')
    expect(prompt.subject).toBe('geolocation')
    expect(prompt.waiting, 'a lone request claimed others were waiting').toBe(0)

    core.answer(prompt.requestId, 'allow-once')
    await expect(answer).resolves.toBe(true)
    expect(host.dismissals, 'the dialogue was left on screen').toBe(1)
  })

  it('refuses a camera set to ask without presenting anything', async () => {
    // R13: camera and microphone behave exactly as they did before prompting was wired.
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })
    for (const mediaTypes of [['video'], ['audio'], ['video', 'audio']]) {
      await expect(
        core.ask({ permission: 'media', mediaTypes, origin: 'https://example.com' }, host, TAB),
        mediaTypes.join('+')
      ).resolves.toBe(false)
    }
    await expect(
      core.ask(
        { permission: 'display-capture', mediaTypes: [], origin: 'https://example.com' },
        host,
        TAB
      )
    ).resolves.toBe(false)
    expect(host.presented, 'a camera prompt reached the layer').toEqual([])
    expect(rules.written).toEqual([])
  })

  it('refuses a request that belongs to no window', async () => {
    // Nowhere to show a dialogue means nobody can answer it, so it cannot be granted.
    const rules = recordingRules()
    const core = arbiter({ rules })
    await expect(core.ask(geolocation(), null, TAB)).resolves.toBe(false)
    expect(rules.written, 'a refusal nobody gave was remembered').toEqual([])
  })

  it('still lets the settings answer a request that belongs to no window', async () => {
    // The settings needed no window before any of this was wired, and a camera on allow still does.
    const core = arbiter({
      settings: {
        ...defaultSettings(),
        'permissions.geolocation': 'allow',
        'permissions.camera': 'allow'
      }
    })
    await expect(core.ask(geolocation(), null, TAB)).resolves.toBe(true)
    await expect(
      core.ask({ permission: 'media', mediaTypes: ['video'], origin: null }, null, TAB)
    ).resolves.toBe(true)
  })

  it('shows no dialogue at all when the settings already answer', async () => {
    const host = fakeHost()
    const core = arbiter({ settings: defaultSettings() })
    await expect(core.ask(geolocation(), host, TAB)).resolves.toBe(false)
    expect(host.presented).toEqual([])
  })

  it('does not ask a second time about a site that chose always', async () => {
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })

    const first = core.ask(geolocation(), host, TAB)
    core.answer(lastPrompt(host).requestId, 'allow-always')
    await expect(first).resolves.toBe(true)
    expect(rules.written).toEqual([
      { origin: 'https://example.com', subject: 'geolocation', decision: 'allow' }
    ])

    const presentedBefore = host.presented.length
    await expect(core.ask(geolocation(), host, TAB)).resolves.toBe(true)
    expect(host.presented.length, 'a remembered answer was asked again').toBe(presentedBefore)
  })

  it('remembers Escape as a block', async () => {
    // The surface sends Escape over `permissions:answer` as `block`; it is the user's answer.
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })
    const first = core.ask(geolocation(), host, TAB)
    core.answer(lastPrompt(host).requestId, 'block')
    await expect(first).resolves.toBe(false)
    expect(rules.written).toEqual([
      { origin: 'https://example.com', subject: 'geolocation', decision: 'deny' }
    ])

    const presentedBefore = host.presented.length
    await expect(core.ask(geolocation(), host, TAB)).resolves.toBe(false)
    expect(host.presented.length, 'a remembered block was asked again').toBe(presentedBefore)
  })

  it('ignores an answer for a request that no longer exists', async () => {
    // The surface can answer a prompt that has just been settled another way — the window lost
    // focus a fraction before the click landed. The first settlement is the one that counts.
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)
    const { requestId } = lastPrompt(host)

    core.answer(requestId, 'block')
    core.answer(requestId, 'allow-always')
    await expect(answer).resolves.toBe(false)
  })
})

describe('two requests at the same time', () => {
  it('queues the second rather than refusing it', async () => {
    /*
      The decision this file exists to record. A page that is refused without being asked cannot
      tell that from a refusal the user gave — and one tile would be able to deny another tile's
      request simply by asking first.
    */
    const host = fakeHost()
    const core = arbiter()

    const first = core.ask(geolocation('https://first.example'), host, TAB)
    const second = core.ask(geolocation('https://second.example'), host, TAB)

    expect(core.pendingCount(host)).toBe(2)
    /*
      One *dialogue*, which is not the same claim as one `presentOverlay` call.

      The second request updates the count on the prompt already up, so the layer is written to twice and
      shows one thing. Asserting the call count instead is what pinned the earlier defect in place: the
      count froze at zero and the second request was never announced, which reads as the first dialogue
      refusing to close.
    */
    expect(
      new Set(prompts(host).map((prompt) => prompt.requestId)).size,
      'more than one request reached the layer'
    ).toBe(1)

    const shown = lastPrompt(host)
    expect(shown.origin).toBe('https://first.example')
    expect(shown.waiting, 'the user was not told another request was waiting').toBe(1)

    core.answer(shown.requestId, 'allow-once')
    await expect(first).resolves.toBe(true)

    // The second one appears only now, and replaces rather than follows a dismissal.
    const next = lastPrompt(host)
    expect(next.origin).toBe('https://second.example')
    expect(next.waiting).toBe(0)
    expect(host.dismissals, 'the layer was cleared between two prompts').toBe(0)

    core.answer(next.requestId, 'block')
    await expect(second).resolves.toBe(false)
    expect(host.dismissals, 'the last answer did not clear the layer').toBe(1)
  })

  it('does not replace the dialogue with a different one when a second request arrives', async () => {
    /*
      A *different* request reaching the layer would take focus and lose whichever button the user had
      tabbed to. The same request arriving again does not: the surface keys its focus effect on
      `requestId`, so an update changes the text and leaves the keyboard alone — which is what lets the
      waiting count stay current without disturbing anybody.
    */
    const host = fakeHost()
    const core = arbiter()
    const first = core.ask(geolocation('https://first.example'), host, TAB)
    void core.ask(geolocation('https://second.example'), host, TAB)

    const ids = new Set(prompts(host).map((prompt) => prompt.requestId))
    expect(ids.size, 'a second request took the dialogue').toBe(1)
    expect(prompts(host).at(-1)?.origin).toBe('https://first.example')
    // And the update is what carries the news that something is waiting.
    expect(prompts(host).at(-1)?.waiting).toBe(1)

    core.answer(lastPrompt(host).requestId, 'block')
    await expect(first).resolves.toBe(false)
  })

  it('answers two identical requests with one dialogue', async () => {
    // A page calling getUserMedia in a loop, or two frames of one site asking together.
    const host = fakeHost()
    const core = arbiter()

    const first = core.ask(geolocation(), host, TAB)
    const second = core.ask(geolocation(), host, TAB)

    expect(host.presented, 'the same question was asked twice').toHaveLength(1)
    expect(core.pendingCount(host)).toBe(1)

    core.answer(lastPrompt(host).requestId, 'allow-once')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  it('asks separately about two different subjects from one site', () => {
    const host = fakeHost()
    const core = arbiter()
    void core.ask(geolocation(), host, TAB)
    void core.ask(
      { permission: 'notifications', mediaTypes: [], origin: 'https://example.com' },
      host,
      TAB
    )
    expect(core.pendingCount(host)).toBe(2)
  })

  it('keeps the two windows independent', () => {
    // A prompt is modal to the window it appears in, so a queue per window rather than one queue.
    const left = fakeHost()
    const right = fakeHost()
    const core = arbiter()

    void core.ask(geolocation('https://left.example'), left, TAB)
    void core.ask(geolocation('https://right.example'), right, TAB)

    expect(left.presented).toHaveLength(1)
    expect(right.presented).toHaveLength(1)
    expect(core.pendingCount(left)).toBe(1)
    expect(core.pendingCount(right)).toBe(1)
  })

  it('refuses past the queue cap instead of stacking dialogues without limit', async () => {
    // A window with a dozen unanswered prompts behind it is not waiting for a person, and every
    // dismissal revealing another dialogue is a way to make the browser unusable.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = fakeHost()
    const rules = recordingRules()
    const core = arbiter({ rules, maxQueued: 2 })

    void core.ask(geolocation('https://a.example'), host, TAB)
    void core.ask(geolocation('https://b.example'), host, TAB)
    const refused = core.ask(geolocation('https://c.example'), host, TAB)

    await expect(refused, 'the cap granted instead of refusing').resolves.toBe(false)
    expect(core.pendingCount(host)).toBe(2)
    expect(rules.written, 'a full queue blocked a site nobody refused').toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('has a cap that leaves room for more than one prompt', () => {
    expect(MAX_QUEUED_PROMPTS).toBeGreaterThan(1)
  })
})

describe('a dialogue that leaves the screen without an answer', () => {
  it('refuses the request it was asking about', async () => {
    // A resize, a focus change, a layout shortcut: the window controller dismisses the layer for
    // all of them, and none of them is consent.
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)

    core.overlayVacated(lastPrompt(host), 'dismissed')
    await expect(answer).resolves.toBe(false)
  })

  it('shows the next queued request once the layer is free again', async () => {
    const host = fakeHost()
    const core = arbiter()
    const first = core.ask(geolocation('https://first.example'), host, TAB)
    const second = core.ask(geolocation('https://second.example'), host, TAB)

    core.overlayVacated(lastPrompt(host), 'dismissed')
    await expect(first).resolves.toBe(false)

    expect(lastPrompt(host).origin).toBe('https://second.example')
    core.answer(lastPrompt(host).requestId, 'block')
    await expect(second).resolves.toBe(false)
  })

  it('takes the layer back when something else displaced the prompt', async () => {
    // A modal prompt outranks whatever displaced it. The alternative is a queue waiting for a
    // signal that never comes: a dismissed *menu* announces nothing this arbiter can hear.
    const host = fakeHost()
    const core = arbiter()
    const first = core.ask(geolocation('https://first.example'), host, TAB)
    const second = core.ask(geolocation('https://second.example'), host, TAB)

    core.overlayVacated(lastPrompt(host), 'replaced')
    await expect(first).resolves.toBe(false)
    expect(lastPrompt(host).origin).toBe('https://second.example')

    core.answer(lastPrompt(host).requestId, 'block')
    await expect(second).resolves.toBe(false)
  })

  it('refuses everything queued when the layer is gone for good', async () => {
    /*
      A closed window or a crashed surface. Presenting into it would throw, and leaving the queue
      alone would leave every page behind it waiting for a dialogue that can no longer appear.
    */
    const host = fakeHost()
    const core = arbiter()
    const first = core.ask(geolocation('https://first.example'), host, TAB)
    const second = core.ask(geolocation('https://second.example'), host, TAB)
    const presentedBefore = host.presented.length

    core.overlayVacated(lastPrompt(host), 'gone')

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(host.presented.length, 'something was presented into a dead layer').toBe(presentedBefore)
    expect(core.pendingCount(host)).toBe(0)
  })

  it('remembers nothing when a window closes with eight sites waiting', async () => {
    // AE5: eight tabs ask for the location, the window closes unanswered, and no site is blocked.
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })
    const answers = Array.from({ length: 8 }, (_, index) =>
      core.ask(geolocation(`https://site${String(index)}.example`), host, TAB)
    )
    expect(core.pendingCount(host)).toBe(8)

    core.overlayVacated(lastPrompt(host), 'gone')

    for (const answer of answers) await expect(answer).resolves.toBe(false)
    expect(rules.written, 'a closed window blocked sites nobody refused').toEqual([])
    // And each site is asked again next time rather than refused from memory.
    const again = fakeHost()
    void core.ask(geolocation('https://site3.example'), again, TAB)
    expect(prompts(again)).toHaveLength(1)
  })

  it('remembers nothing for a dialogue that was dismissed or displaced', async () => {
    for (const reason of ['dismissed', 'replaced'] as const) {
      const rules = recordingRules()
      const host = fakeHost()
      const core = arbiter({ rules })
      const answer = core.ask(geolocation(), host, TAB)
      core.overlayVacated(lastPrompt(host), reason)
      await expect(answer, reason).resolves.toBe(false)
      expect(rules.written, reason).toEqual([])
    }
  })

  it('leaves alone whatever displaced a prompt with nothing behind it', async () => {
    // Dismissing here would take down the surface that has just taken the layer.
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)
    core.overlayVacated(lastPrompt(host), 'replaced')
    await expect(answer).resolves.toBe(false)
    expect(host.dismissals).toBe(0)
    expect(host.listeners.size).toBe(0)
  })

  it('ignores a surface that nothing was waiting on', async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)

    core.overlayVacated(
      { kind: 'layout-menu', anchor: { x: 0, y: 0, width: 10, height: 10 }, current: '1x1' },
      'dismissed'
    )
    core.answer(lastPrompt(host).requestId, 'allow-once')
    await expect(answer, 'a dismissed menu refused a pending request').resolves.toBe(true)
  })

  it('ignores a prompt it has already settled', async () => {
    // The answer path dismisses the layer, which announces the departure of the very prompt that
    // was just answered. Without idempotence that would refuse a request the user had granted.
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)
    const prompt = lastPrompt(host)

    core.answer(prompt.requestId, 'allow-always')
    core.overlayVacated(prompt, 'dismissed')
    await expect(answer).resolves.toBe(true)
  })
})

/**
 * Whether a promise is still waiting.
 *
 * A request that is put back must stay *pending* — neither granted nor refused — and the only way to
 * say so without a timeout is to race it against something already settled. Listed first, so a promise
 * that has settled wins the race.
 */
async function isPending(promise: Promise<unknown>): Promise<boolean> {
  const marker = Symbol('pending')
  return (await Promise.race([promise, Promise.resolve(marker)])) === marker
}

describe('a dialogue bound to the tab that asked', () => {
  /*
    R12: the dialogue appears for the page in the active tab. A page in a background tab asking for the
    location would otherwise put "example.com wants your location" over whatever the user is looking at
    — and the user would answer for the page in front of them, which is not the one that asked.
  */
  it('waits while the tab that asked is in the background, and appears when it comes to the front', async () => {
    const host = fakeHost({ active: 2 })
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)

    expect(host.presented, 'a background tab put a dialogue over the page in front').toEqual([])
    expect(core.pendingCount(host)).toBe(1)
    expect(await isPending(answer), 'a background request was settled instead of kept').toBe(true)

    host.activate(TAB)
    const shown = lastPrompt(host)
    expect(shown.origin).toBe('https://example.com')

    core.answer(shown.requestId, 'allow-once')
    await expect(answer).resolves.toBe(true)
  })

  it('shows nothing while no tab is in front', () => {
    const host = fakeHost({ active: null })
    const core = arbiter()
    void core.ask(geolocation(), host, TAB)
    expect(host.presented).toEqual([])

    host.activate(TAB)
    expect(prompts(host)).toHaveLength(1)
  })

  it('puts the request back when another tab comes to the front, and remembers nothing', async () => {
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })
    const answer = core.ask(geolocation(), host, TAB)
    const shown = lastPrompt(host)

    host.activate(2)
    expect(host.dismissals, 'the dialogue stayed over a page that did not ask').toBe(1)
    // The layer reports that dismissal like any other. It is the arbiter's own, not an unanswered prompt.
    core.overlayVacated(shown, 'dismissed')
    expect(await isPending(answer), 'switching tabs answered the request').toBe(true)
    expect(core.pendingCount(host)).toBe(1)
    expect(rules.written, 'switching tabs was remembered as an answer').toEqual([])

    host.activate(TAB)
    expect(lastPrompt(host).requestId, 'the request came back as a different one').toBe(
      shown.requestId
    )
    expect(prompts(host)).toHaveLength(2)

    core.answer(shown.requestId, 'block')
    await expect(answer).resolves.toBe(false)
    expect(rules.written).toEqual([
      { origin: 'https://example.com', subject: 'geolocation', decision: 'deny' }
    ])
  })

  it('ignores an answer for a request that has been put back', async () => {
    // A click that lands after the switch was aimed at a dialogue that is no longer there.
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })
    const answer = core.ask(geolocation(), host, TAB)
    const shown = lastPrompt(host)

    host.activate(2)
    core.answer(shown.requestId, 'allow-always')
    expect(await isPending(answer)).toBe(true)
    expect(rules.written).toEqual([])
  })

  it("shows the front tab's own request in place of the one it hides", async () => {
    const host = fakeHost({ active: 1 })
    const core = arbiter()
    const first = core.ask(geolocation('https://a.example'), host, 1)
    const second = core.ask(geolocation('https://b.example'), host, 2)
    const hidden = lastPrompt(host)
    expect(hidden.origin).toBe('https://a.example')

    host.activate(2)
    const shown = lastPrompt(host)
    expect(shown.origin).toBe('https://b.example')
    expect(host.dismissals, 'the layer was cleared between two prompts').toBe(0)
    // Presenting over it makes the layer announce the first as replaced. It was put back, not abandoned.
    core.overlayVacated(hidden, 'replaced')
    expect(await isPending(first)).toBe(true)

    core.answer(shown.requestId, 'allow-once')
    await expect(second).resolves.toBe(true)
    expect(host.dismissals, 'an answered dialogue stayed up with nothing behind it').toBe(1)

    host.activate(1)
    expect(lastPrompt(host).requestId).toBe(hidden.requestId)
  })

  it('does not present again when the tab in front has not changed', () => {
    const host = fakeHost()
    const core = arbiter()
    void core.ask(geolocation(), host, TAB)
    host.activate(TAB)
    host.change({ kind: 'navigated', webContentsId: TAB, url: 'https://example.com/next' })
    expect(host.presented, 'an unchanged dialogue was presented again').toHaveLength(1)
    expect(host.dismissals).toBe(0)
  })

  it('counts only the requests that will follow on the same tab', () => {
    // "1 further request" on a dialogue for one site is read as that site asking again.
    const host = fakeHost()
    const core = arbiter()
    void core.ask(geolocation(), host, TAB)
    void core.ask(geolocation('https://elsewhere.example'), host, 2)
    expect(lastPrompt(host).waiting, 'a request from another tab was counted').toBe(0)

    void core.ask(
      { permission: 'notifications', mediaTypes: [], origin: 'https://example.com' },
      host,
      TAB
    )
    expect(lastPrompt(host).waiting).toBe(1)
  })

  it('asks each tab separately about the same question', () => {
    // Joined, the second tab would wait on a dialogue that can only appear over the first.
    const host = fakeHost()
    const core = arbiter()
    void core.ask(geolocation(), host, TAB)
    void core.ask(geolocation(), host, 2)
    expect(core.pendingCount(host)).toBe(2)
  })

  it('subscribes once per window and lets go when nothing is left', async () => {
    const host = fakeHost()
    const core = arbiter()
    const first = core.ask(geolocation(), host, TAB)
    void core.ask(geolocation('https://elsewhere.example'), host, 2)
    expect(host.listeners.size).toBe(1)

    core.answer(lastPrompt(host).requestId, 'allow-once')
    await expect(first).resolves.toBe(true)
    expect(host.listeners.size, 'a request still waits in tab 2').toBe(1)

    host.change({ kind: 'closed', webContentsId: 2 })
    expect(host.listeners.size, 'the window was still listened to with nothing queued').toBe(0)
  })

  it('does not listen to a window it had nothing to ask in', async () => {
    const host = fakeHost()
    const core = arbiter({ settings: defaultSettings() })
    await expect(core.ask(geolocation(), host, TAB)).resolves.toBe(false)
    expect(host.listeners.size).toBe(0)
  })

  it('ignores a change that arrives after the last request settled', async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)
    const [listener] = [...host.listeners]
    core.answer(lastPrompt(host).requestId, 'allow-once')
    await expect(answer).resolves.toBe(true)

    const presentedBefore = host.presented.length
    listener?.({ kind: 'activated' })
    expect(host.presented.length).toBe(presentedBefore)
    expect(host.dismissals).toBe(1)
  })
})

describe('the tab that asked goes away', () => {
  it('refuses once, remembering nothing, when the tab closes while its request waits', async () => {
    const rules = recordingRules()
    const host = fakeHost({ active: 2 })
    const core = arbiter({ rules })
    const answer = core.ask(geolocation(), host, TAB)

    host.change({ kind: 'closed', webContentsId: TAB })
    await expect(answer).resolves.toBe(false)
    expect(rules.written, 'a closed tab blocked a site nobody refused').toEqual([])
    expect(core.pendingCount(host)).toBe(0)
    expect(host.presented).toEqual([])
    expect(host.dismissals, 'a dialogue that was never up was taken down').toBe(0)
  })

  it('takes the dialogue down when the tab closes with it on screen', async () => {
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })
    const answer = core.ask(geolocation(), host, TAB)
    const shown = lastPrompt(host)

    host.change({ kind: 'closed', webContentsId: TAB })
    await expect(answer).resolves.toBe(false)
    expect(host.dismissals).toBe(1)
    expect(rules.written).toEqual([])
    // The layer's own report of that dismissal changes nothing further.
    core.overlayVacated(shown, 'dismissed')
    expect(core.pendingCount(host)).toBe(0)
  })

  it('refuses once when the tab moves to another site, waiting or on screen', async () => {
    for (const active of [TAB, 2]) {
      const rules = recordingRules()
      const host = fakeHost({ active })
      const core = arbiter({ rules })
      const answer = core.ask(geolocation(), host, TAB)

      host.change({ kind: 'navigated', webContentsId: TAB, url: 'https://elsewhere.example/' })
      await expect(answer, `active ${String(active)}`).resolves.toBe(false)
      expect(rules.written).toEqual([])
      expect(core.pendingCount(host)).toBe(0)
      expect(host.dismissals, 'the dialogue outlived the page it named').toBe(
        active === TAB ? 1 : 0
      )
    }
  })

  it('refuses once when the tab moves to a document with no origin', async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)
    host.change({ kind: 'navigated', webContentsId: TAB, url: 'about:blank' })
    await expect(answer).resolves.toBe(false)
  })

  it('keeps the request through a navigation within the same site', async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)
    host.change({ kind: 'navigated', webContentsId: TAB, url: 'https://example.com/elsewhere' })
    expect(await isPending(answer)).toBe(true)
    expect(core.pendingCount(host)).toBe(1)
  })

  it("leaves other tabs' requests alone", async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host, TAB)
    host.change({ kind: 'closed', webContentsId: 2 })
    host.change({ kind: 'navigated', webContentsId: 2, url: 'https://elsewhere.example/' })
    expect(await isPending(answer)).toBe(true)
    expect(host.dismissals).toBe(0)
  })

  it('refuses everything waiting when the window goes, even with nothing on screen', async () => {
    /*
      The layer announces only what it shows, so a window closed while every request waited in a
      background tab would leave those pages hanging. AE5 applies to them as much as to the one on
      screen: refused this once, nothing remembered.
    */
    const rules = recordingRules()
    const host = fakeHost({ active: 2 })
    const core = arbiter({ rules })
    const answers = [
      core.ask(geolocation('https://a.example'), host, TAB),
      core.ask(geolocation('https://b.example'), host, 3)
    ]

    host.change({ kind: 'gone' })
    for (const answer of answers) await expect(answer).resolves.toBe(false)
    expect(rules.written).toEqual([])
    expect(core.pendingCount(host)).toBe(0)
    expect(host.presented, 'something was presented into a closed window').toEqual([])
    expect(host.dismissals).toBe(0)
    expect(host.listeners.size).toBe(0)
  })

  it('neither presents nor dismisses into a window that has gone with a dialogue up', async () => {
    const host = fakeHost()
    const core = arbiter()
    const shown = core.ask(geolocation('https://a.example'), host, TAB)
    const next = core.ask(geolocation('https://b.example'), host, TAB)
    const presentedBefore = host.presented.length

    host.change({ kind: 'gone' })
    await expect(shown).resolves.toBe(false)
    await expect(next).resolves.toBe(false)
    expect(host.presented.length).toBe(presentedBefore)
    expect(host.dismissals, 'the layer of a closed window was touched').toBe(0)
  })

  it('lets go of the window when its layer is gone', () => {
    const host = fakeHost()
    const core = arbiter()
    void core.ask(geolocation(), host, TAB)
    core.overlayVacated(lastPrompt(host), 'gone')
    expect(host.listeners.size).toBe(0)
  })
})

describe('the tab rules, as pure functions', () => {
  const source = (webContentsId: number, origin = 'https://example.com') => ({
    webContentsId,
    origin
  })

  it('offers the oldest request of the tab in front', () => {
    const queue = [source(2, 'https://b.example'), source(1, 'https://a.example'), source(1)]
    expect(promptForActiveTab(queue, 1)).toBe(queue[1])
    expect(promptForActiveTab(queue, 2)).toBe(queue[0])
    expect(promptForActiveTab(queue, 3)).toBeNull()
    expect(promptForActiveTab(queue, null)).toBeNull()
    expect(promptForActiveTab([], 1)).toBeNull()
  })

  it('ends a request only for its own tab closing, leaving its site, or the window going', () => {
    const asked = source(1)
    const cases: Array<[PermissionTabChange, boolean]> = [
      [{ kind: 'activated' }, false],
      [{ kind: 'gone' }, true],
      [{ kind: 'closed', webContentsId: 1 }, true],
      [{ kind: 'closed', webContentsId: 2 }, false],
      [{ kind: 'navigated', webContentsId: 1, url: 'https://example.com/b?c#d' }, false],
      [{ kind: 'navigated', webContentsId: 1, url: 'https://example.com:8443/' }, true],
      [{ kind: 'navigated', webContentsId: 1, url: 'http://example.com/' }, true],
      [{ kind: 'navigated', webContentsId: 1, url: 'https://sub.example.com/' }, true],
      [{ kind: 'navigated', webContentsId: 1, url: 'not a url' }, true],
      [{ kind: 'navigated', webContentsId: 1, url: '' }, true],
      [{ kind: 'navigated', webContentsId: 2, url: 'https://elsewhere.example/' }, false]
    ]
    for (const [change, ends] of cases) {
      expect(endsPrompt(asked, change), JSON.stringify(change)).toBe(ends)
    }
  })
})

describe('permission checks', () => {
  const check = {
    permission: 'geolocation',
    requestingOrigin: 'https://example.com',
    embeddingOrigin: null,
    topLevelUrl: null
  }

  function modalRules(): (mode: BrowsingMode) => SitePermissionRules {
    const normal = recordingRules()
    normal.remember('https://example.com', 'geolocation', 'allow')
    return (mode) => (mode === 'private' ? forgetfulSitePermissions : normal)
  }

  it("reads the normal profile's remembered allow without a webContents", () => {
    const core = arbiter({ rulesFor: modalRules() })
    expect(core.check(check, 'normal')).toBe(true)
  })

  it("does not show a private session the normal profile's grants", () => {
    const core = arbiter({ rulesFor: modalRules() })
    expect(core.check(check, 'private')).toBe(false)
  })

  it('reads the settings at the moment of the check', () => {
    let settings = askSettings()
    const core = new PermissionArbiter({ rulesFor: modalRules(), getSettings: () => settings })
    expect(core.check(check, 'normal')).toBe(true)
    settings = { ...askSettings(), 'permissions.geolocation': 'deny' }
    expect(core.check(check, 'normal'), 'a deny setting left a stored allow granted').toBe(false)
  })
})

describe('overlay vacancy notifications', () => {
  const stops: Array<() => void> = []

  afterEach(() => {
    for (const stop of stops.splice(0)) stop()
  })

  const prompt: OverlayPresentation = {
    kind: 'permission-request',
    requestId: 'r1',
    origin: 'https://example.com',
    subject: 'camera',
    devices: ['camera'],
    waiting: 0
  }

  it('reaches every listener with the reason', () => {
    const seen: string[] = []
    stops.push(onOverlayVacancy((_presentation, reason) => seen.push(`a:${reason}`)))
    stops.push(onOverlayVacancy((_presentation, reason) => seen.push(`b:${reason}`)))

    notifyOverlayVacancy(prompt, 'gone')
    expect(seen).toEqual(['a:gone', 'b:gone'])
  })

  it('stops calling a listener that unsubscribed', () => {
    const seen: string[] = []
    const stop = onOverlayVacancy(() => seen.push('called'))
    stop()
    notifyOverlayVacancy(prompt, 'dismissed')
    expect(seen).toEqual([])
  })

  it('keeps going when one listener throws', () => {
    /*
      A listener that threw would otherwise stop the layer from changing what it shows — leaving a
      crashed overlay on screen swallowing every click, which is the failure this guard is for.
    */
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const seen: string[] = []
    stops.push(
      onOverlayVacancy(() => {
        throw new Error('listener is broken')
      })
    )
    stops.push(onOverlayVacancy(() => seen.push('still called')))

    notifyOverlayVacancy(prompt, 'dismissed')
    expect(seen).toEqual(['still called'])
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
