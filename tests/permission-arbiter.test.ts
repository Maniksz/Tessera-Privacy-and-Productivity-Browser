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
import type { SitePermissionRules } from '@main/permissions/model.js'
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
 * answered. Those matter more than Escape does in practice: the window controller dismisses the
 * overlay layer on every resize and every focus loss, and each of those has to arrive as a refusal
 * rather than as a page left waiting forever.
 */

interface FakeHost extends PermissionHost {
  presented: OverlayPresentation[]
  dismissals: number
}

function fakeHost(options: { privateMode?: boolean } = {}): FakeHost {
  const host: FakeHost = {
    privateMode: options.privateMode ?? false,
    presented: [],
    dismissals: 0,
    presentOverlay: (presentation) => {
      host.presented.push(presentation)
    },
    dismissOverlay: () => {
      host.dismissals += 1
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
    settings?: SettingsSnapshot
    maxQueued?: number
  } = {}
): PermissionArbiter {
  let counter = 0
  const rules = options.rules ?? recordingRules()
  return new PermissionArbiter({
    rulesFor: () => rules,
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
    const answer = core.ask(geolocation(), host)

    const prompt = lastPrompt(host)
    expect(prompt.origin).toBe('https://example.com')
    expect(prompt.subject).toBe('geolocation')
    expect(prompt.waiting, 'a lone request claimed others were waiting').toBe(0)

    core.answer(prompt.requestId, 'allow-once')
    await expect(answer).resolves.toBe(true)
    expect(host.dismissals, 'the dialogue was left on screen').toBe(1)
  })

  it('names the devices a media request would reach', async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(
      { permission: 'media', mediaTypes: ['video', 'audio'], origin: 'https://example.com' },
      host
    )

    const prompt = lastPrompt(host)
    expect(prompt.subject).toBe('camera-and-microphone')
    expect(prompt.devices).toEqual(['camera', 'microphone'])

    core.answer(prompt.requestId, 'block')
    await expect(answer).resolves.toBe(false)
  })

  it('refuses a request that belongs to no window', async () => {
    // Nowhere to show a dialogue means nobody can answer it, so it cannot be granted.
    const core = arbiter()
    await expect(core.ask(geolocation(), null)).resolves.toBe(false)
  })

  it('shows no dialogue at all when the settings already answer', async () => {
    const host = fakeHost()
    const core = arbiter({ settings: defaultSettings() })
    await expect(core.ask(geolocation(), host)).resolves.toBe(false)
    expect(host.presented).toEqual([])
  })

  it('does not ask a second time about a site that chose always', async () => {
    const rules = recordingRules()
    const host = fakeHost()
    const core = arbiter({ rules })

    const first = core.ask(geolocation(), host)
    core.answer(lastPrompt(host).requestId, 'allow-always')
    await expect(first).resolves.toBe(true)
    expect(rules.written).toEqual([
      { origin: 'https://example.com', subject: 'geolocation', decision: 'allow' }
    ])

    const presentedBefore = host.presented.length
    await expect(core.ask(geolocation(), host)).resolves.toBe(true)
    expect(host.presented.length, 'a remembered answer was asked again').toBe(presentedBefore)
  })

  it('ignores an answer for a request that no longer exists', async () => {
    // The surface can answer a prompt that has just been settled another way — the window lost
    // focus a fraction before the click landed. The first settlement is the one that counts.
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host)
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

    const first = core.ask(geolocation('https://first.example'), host)
    const second = core.ask(geolocation('https://second.example'), host)

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
    const first = core.ask(geolocation('https://first.example'), host)
    void core.ask(geolocation('https://second.example'), host)

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

    const first = core.ask(geolocation(), host)
    const second = core.ask(geolocation(), host)

    expect(host.presented, 'the same question was asked twice').toHaveLength(1)
    expect(core.pendingCount(host)).toBe(1)

    core.answer(lastPrompt(host).requestId, 'allow-once')
    await expect(first).resolves.toBe(true)
    await expect(second).resolves.toBe(true)
  })

  it('asks separately about two different subjects from one site', () => {
    const host = fakeHost()
    const core = arbiter()
    void core.ask(geolocation(), host)
    void core.ask({ permission: 'notifications', mediaTypes: [], origin: 'https://example.com' }, host)
    expect(core.pendingCount(host)).toBe(2)
  })

  it('keeps the two windows independent', () => {
    // A prompt is modal to the window it appears in, so a queue per window rather than one queue.
    const left = fakeHost()
    const right = fakeHost()
    const core = arbiter()

    void core.ask(geolocation('https://left.example'), left)
    void core.ask(geolocation('https://right.example'), right)

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
    const core = arbiter({ maxQueued: 2 })

    void core.ask(geolocation('https://a.example'), host)
    void core.ask(geolocation('https://b.example'), host)
    const refused = core.ask(geolocation('https://c.example'), host)

    await expect(refused, 'the cap granted instead of refusing').resolves.toBe(false)
    expect(core.pendingCount(host)).toBe(2)
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
    const answer = core.ask(geolocation(), host)

    core.overlayVacated(lastPrompt(host), 'dismissed')
    await expect(answer).resolves.toBe(false)
  })

  it('shows the next queued request once the layer is free again', async () => {
    const host = fakeHost()
    const core = arbiter()
    const first = core.ask(geolocation('https://first.example'), host)
    const second = core.ask(geolocation('https://second.example'), host)

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
    const first = core.ask(geolocation('https://first.example'), host)
    const second = core.ask(geolocation('https://second.example'), host)

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
    const first = core.ask(geolocation('https://first.example'), host)
    const second = core.ask(geolocation('https://second.example'), host)
    const presentedBefore = host.presented.length

    core.overlayVacated(lastPrompt(host), 'gone')

    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    expect(host.presented.length, 'something was presented into a dead layer').toBe(presentedBefore)
    expect(core.pendingCount(host)).toBe(0)
  })

  it('ignores a surface that nothing was waiting on', async () => {
    const host = fakeHost()
    const core = arbiter()
    const answer = core.ask(geolocation(), host)

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
    const answer = core.ask(geolocation(), host)
    const prompt = lastPrompt(host)

    core.answer(prompt.requestId, 'allow-always')
    core.overlayVacated(prompt, 'dismissed')
    await expect(answer).resolves.toBe(true)
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
