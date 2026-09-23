import { describe, expect, it, vi } from 'vitest'
import {
  UNANSWERED,
  answerPermissionCheck,
  grantsPermission,
  isAskableSubject,
  permissionSubject,
  rememberedDecision,
  resolvePermissionRequest,
  topLevelOrigin,
  unaskedPrompting,
  type PermissionCheck,
  type PermissionOutcome,
  type PermissionPrompting,
  type PermissionRequestDetails
} from '@main/session/permission-policy.js'
import { invokeContract } from '@shared/ipc/contract.js'
import {
  PERMISSION_ANSWERS,
  PERMISSION_SUBJECTS,
  PERMISSION_TOPICS,
  subjectDevices,
  subjectTopics,
  type PermissionSubject
} from '@shared/overlay/permission.js'
import {
  OVERLAY_AWAITS_ANSWER,
  OVERLAY_KINDS,
  awaitsAnswer,
  regionOf
} from '@shared/overlay/surface.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The path from "a page asked" to "yes" or "no".
 *
 * The decision tables were already tested; what was not is the part that turns a settings value of
 * `ask` into a dialogue and an answer into a stored rule. Every assertion here is about a way the
 * request can end up refused, because that is the direction a mistake has to fall: an unanswered
 * prompt, an unnameable permission or a site with no origin must all mean no.
 */

function settingsWith(overrides: Partial<SettingsSnapshot>): SettingsSnapshot {
  return { ...defaultSettings(), ...overrides }
}

interface Harness {
  deps: PermissionPrompting
  prompts: Array<{ origin: string; subject: PermissionSubject }>
  written: Array<{ origin: string; subject: PermissionSubject; decision: 'allow' | 'deny' }>
}

function harness(options: {
  settings?: SettingsSnapshot
  answer?: PermissionOutcome
  recall?: (origin: string, subject: PermissionSubject) => 'allow' | 'deny' | 'ask'
}): Harness {
  const prompts: Harness['prompts'] = []
  const written: Harness['written'] = []
  const deps: PermissionPrompting = {
    settings: options.settings ?? defaultSettings(),
    recall: options.recall ?? (() => 'ask'),
    prompt: (request) => {
      prompts.push(request)
      return Promise.resolve(options.answer ?? 'block')
    },
    remember: (origin, subject, decision) => {
      written.push({ origin, subject, decision })
    }
  }
  return { deps, prompts, written }
}

function request(overrides: Partial<PermissionRequestDetails>): PermissionRequestDetails {
  return { permission: 'geolocation', mediaTypes: [], origin: 'https://example.com', ...overrides }
}

describe('permissionSubject', () => {
  it('names every permission that has a setting', () => {
    // The prompt is the only consumer, and a permission with a setting but no name would reach it
    // as an unnameable request — refused, silently, with the settings switch still visible.
    for (const permission of [
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'display-capture',
      'midi',
      'midiSysex',
      'storage-access',
      'top-level-storage-access'
    ]) {
      expect(permissionSubject(permission, []), permission).not.toBeNull()
    }
  })

  it('maps the two clipboard permissions to two different subjects', () => {
    // They share a *setting* and must not share a stored answer: reading the clipboard and being
    // written into are not the same risk.
    expect(permissionSubject('clipboard-read', [])).toBe('clipboard-read')
    expect(permissionSubject('clipboard-sanitized-write', [])).toBe('clipboard-write')
  })

  it('splits a media request by the devices it names', () => {
    expect(permissionSubject('media', ['video'])).toBe('camera')
    expect(permissionSubject('media', ['audio'])).toBe('microphone')
    expect(permissionSubject('media', ['video', 'audio'])).toBe('camera-and-microphone')
  })

  it('refuses to name a media request that names no device', () => {
    expect(permissionSubject('media', [])).toBeNull()
  })

  it('refuses to name a permission it has never heard of', () => {
    expect(permissionSubject('some-future-capability', [])).toBeNull()
    // Not a permission with a name: it is granted without asking, so it needs none.
    expect(permissionSubject('fullscreen', [])).toBeNull()
  })
})

describe('subject vocabulary', () => {
  it('gives every subject except the media pair exactly one stored topic', () => {
    for (const subject of PERMISSION_SUBJECTS) {
      const topics = subjectTopics(subject)
      const expected = subject === 'camera-and-microphone' ? 2 : 1
      expect(topics.length, subject).toBe(expected)
    }
  })

  it('turns a combined media grant into two stored topics', () => {
    // The reason a later camera-only request from the same site is not asked again.
    expect(subjectTopics('camera-and-microphone')).toEqual(['camera', 'microphone'])
  })

  it('names the devices a media request reaches and nothing else', () => {
    expect(subjectDevices('camera-and-microphone')).toEqual(['camera', 'microphone'])
    expect(subjectDevices('microphone')).toEqual(['microphone'])
    expect(subjectDevices('geolocation')).toEqual([])
  })

  it('keeps every topic a subject', () => {
    // Derived rather than written twice, and asserted so a mutation that stops deriving fails.
    for (const topic of PERMISSION_TOPICS) {
      expect(PERMISSION_SUBJECTS as readonly string[], topic).toContain(topic)
    }
    expect(PERMISSION_SUBJECTS.length).toBe(PERMISSION_TOPICS.length + 1)
  })

  it('offers two ways to allow and one to refuse', () => {
    // The asymmetry is deliberate: see `PERMISSION_ANSWERS`. A "block once" would be a nag button.
    expect([...PERMISSION_ANSWERS]).toEqual(['allow-once', 'allow-always', 'block'])
  })
})

describe('rememberedDecision', () => {
  it('remembers an always-allow and a block', () => {
    expect(rememberedDecision('allow-always')).toBe('allow')
    expect(rememberedDecision('block')).toBe('deny')
  })

  it('remembers nothing about a one-off grant', () => {
    expect(rememberedDecision('allow-once')).toBeNull()
  })

  it('remembers nothing about a prompt nobody answered', () => {
    // A closed window is not a person refusing a site.
    expect(rememberedDecision(UNANSWERED)).toBeNull()
  })
})

describe('grantsPermission', () => {
  it('grants on the two ways a person says yes and on nothing else', () => {
    expect(grantsPermission('allow-once')).toBe(true)
    expect(grantsPermission('allow-always')).toBe(true)
    expect(grantsPermission('block')).toBe(false)
    expect(grantsPermission(UNANSWERED)).toBe(false)
  })
})

describe('the unanswered outcome', () => {
  it('is not an answer a surface can send', () => {
    // Only the core can conclude that nobody answered; over IPC it would be a way to refuse a site
    // without the memory noticing — or, worse, a value the arbiter had never planned for.
    expect(PERMISSION_ANSWERS as readonly string[]).not.toContain(UNANSWERED)
    const schema = invokeContract['permissions:answer'].request
    expect(schema.safeParse({ requestId: 'r1', answer: UNANSWERED }).success).toBe(false)
    expect(schema.safeParse({ requestId: 'r1', answer: 'block' }).success).toBe(true)
  })
})

describe('isAskableSubject', () => {
  it('asks about everything except camera, microphone and screen sharing', () => {
    const silent = ['camera', 'microphone', 'camera-and-microphone', 'display-capture']
    for (const subject of PERMISSION_SUBJECTS) {
      expect(isAskableSubject(subject), subject).toBe(!silent.includes(subject))
    }
  })
})

describe('the permission prompt is a modal surface', () => {
  it('owns the whole window, like a menu', () => {
    expect(regionOf('permission-request')).toBe('window')
  })

  it('is one of the three surfaces something is waiting on', () => {
    /*
      It was the only one, then one of two, and is now one of three. The set is asserted whole rather than
      loosened to "at least the prompt", and the reason has held every time it changed: what makes a
      surface belong here is that its departure strands somebody, and each one strands a different thing
      with a different safe answer.

      - `permission-request` — a page holding an unsettled `getUserMedia`. Safe answer: refuse.
      - `master-password` — a caller holding an unsettled `passwords:requestUnlock`. Safe answer:
        `cancelled`, not `wrong-password`; a resize is not the user mistyping.
      - `navigation-request` — the core holding a callback that would perform a navigation or open a tab.
        Safe answer: refuse, which is also what the feature was asked for — the page stays where it is.

      A fourth kind that quietly joined them would be a fourth consequence nobody had decided for.
    */
    const waiting = OVERLAY_KINDS.filter((kind) => OVERLAY_AWAITS_ANSWER[kind])
    expect([...waiting].sort()).toEqual([
      'master-password',
      'navigation-request',
      'permission-request'
    ])
  })

  it('reports a prompt as awaiting an answer and a menu as not', () => {
    // What decides whether the layer announces a departure at all: a menu taken down by a resize
    // costs nothing, a prompt taken down by a resize leaves a page hanging.
    expect(
      awaitsAnswer({
        kind: 'permission-request',
        requestId: 'r1',
        origin: 'https://example.com',
        subject: 'camera',
        devices: ['camera'],
        waiting: 0
      })
    ).toBe(true)
    expect(
      awaitsAnswer({
        kind: 'layout-menu',
        anchor: { x: 0, y: 0, width: 10, height: 10 },
        current: '1x1'
      })
    ).toBe(false)
  })
})

describe('resolvePermissionRequest', () => {
  it('does not ask about a permission the settings already answer', async () => {
    const allowed = harness({ settings: settingsWith({ 'permissions.geolocation': 'allow' }) })
    await expect(resolvePermissionRequest(request({}), allowed.deps)).resolves.toBe(true)

    const denied = harness({ settings: settingsWith({ 'permissions.geolocation': 'deny' }) })
    await expect(resolvePermissionRequest(request({}), denied.deps)).resolves.toBe(false)

    expect(allowed.prompts, 'an allow setting still asked').toEqual([])
    expect(denied.prompts, 'a deny setting still asked').toEqual([])
  })

  it('refuses everything by default without asking', async () => {
    // The defaults are `deny`, so a fresh profile shows no dialogue at all — the prompt exists for
    // the user who chose `ask`.
    const { deps, prompts } = harness({})
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(false)
    expect(prompts).toEqual([])
  })

  it('grants fullscreen, which tile fullscreen depends on, without a dialogue', async () => {
    // It has no subject and needs none. Refusing it here would break the browser's central feature
    // in exchange for a privacy gain that does not exist.
    const { deps, prompts } = harness({})
    await expect(
      resolvePermissionRequest(request({ permission: 'fullscreen' }), deps)
    ).resolves.toBe(true)
    expect(prompts).toEqual([])
  })

  it('refuses an unrecognised permission without a dialogue', async () => {
    const { deps, prompts } = harness({})
    await expect(
      resolvePermissionRequest(request({ permission: 'some-future-capability' }), deps)
    ).resolves.toBe(false)
    expect(prompts, 'a nameless permission reached the user').toEqual([])
  })

  it('refuses a media request that names no device', async () => {
    // `getUserMedia` with neither video nor audio: nothing to show in a dialogue and nothing to
    // grant, so it is refused rather than guessed at.
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.camera': 'ask', 'permissions.microphone': 'ask' })
    })
    await expect(
      resolvePermissionRequest(request({ permission: 'media', mediaTypes: [] }), deps)
    ).resolves.toBe(false)
    expect(prompts).toEqual([])
  })

  it('refuses a request whose origin could not be established', async () => {
    // "Something wants your camera" is not a question anybody can answer, so it is never asked.
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' })
    })
    await expect(resolvePermissionRequest(request({ origin: null }), deps)).resolves.toBe(false)
    expect(prompts, 'a dialogue named no site').toEqual([])
  })

  it('asks when the setting says ask, and names the site and the subject', async () => {
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      answer: 'allow-once'
    })
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(true)
    expect(prompts).toEqual([{ origin: 'https://example.com', subject: 'geolocation' }])
  })

  it('refuses the pair when one half is denied, without asking about the other', async () => {
    // The strictest decision wins: granting the pair because the camera was allowed would hand
    // over a microphone the user never agreed to.
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.camera': 'ask', 'permissions.microphone': 'deny' })
    })
    await expect(
      resolvePermissionRequest(
        request({ permission: 'media', mediaTypes: ['video', 'audio'] }),
        deps
      )
    ).resolves.toBe(false)
    expect(prompts).toEqual([])
  })

  it('remembers a refusal the user gave', async () => {
    // The block button and Escape: the surface sends both as `block` over `permissions:answer`.
    const { deps, written } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      answer: 'block'
    })
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(false)
    expect(written).toEqual([
      { origin: 'https://example.com', subject: 'geolocation', decision: 'deny' }
    ])
  })

  it('refuses a prompt nobody answered and remembers nothing', async () => {
    // A closed window, a full queue, a displaced dialogue. Refused this once; asked again next time.
    const { deps, prompts, written } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      answer: UNANSWERED
    })
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(false)
    expect(prompts).toHaveLength(1)
    expect(written, 'an unanswered prompt blocked the site').toEqual([])
  })

  it('refuses a frame embedded from another site without asking or remembering', async () => {
    const { deps, prompts, written } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      answer: 'allow-always'
    })
    const origin = topLevelOrigin({
      frame: 'https://maps.example.net/',
      topLevel: 'https://a.example/'
    })
    await expect(resolvePermissionRequest(request({ origin }), deps)).resolves.toBe(false)
    expect(prompts).toEqual([])
    expect(written).toEqual([])
  })

  it('asks and remembers a same-origin frame under the page', async () => {
    const { deps, prompts, written } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      answer: 'allow-always'
    })
    const origin = topLevelOrigin({
      frame: 'https://a.example/frame',
      topLevel: 'https://a.example/'
    })
    await expect(resolvePermissionRequest(request({ origin }), deps)).resolves.toBe(true)
    expect(prompts).toEqual([{ origin: 'https://a.example', subject: 'geolocation' }])
    expect(written).toEqual([
      { origin: 'https://a.example', subject: 'geolocation', decision: 'allow' }
    ])
  })

  it('stores nothing for a one-off grant', async () => {
    const { deps, written } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      answer: 'allow-once'
    })
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(true)
    expect(written, 'allow once was remembered anyway').toEqual([])
  })

  it('stores an always-allow', async () => {
    const { deps, written } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      answer: 'allow-always'
    })
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(true)
    expect(written).toEqual([
      { origin: 'https://example.com', subject: 'geolocation', decision: 'allow' }
    ])
  })

  it("does not ask again about a site's remembered allow", async () => {
    const recall = vi.fn(() => 'allow' as const)
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'ask' }),
      recall
    })
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(true)
    expect(prompts, 'a remembered answer was asked again').toEqual([])
    expect(recall).toHaveBeenCalledWith('https://example.com', 'geolocation')
  })

  it("does not ask again about a site's remembered block", async () => {
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.notifications': 'ask' }),
      recall: () => 'deny'
    })
    await expect(
      resolvePermissionRequest(request({ permission: 'notifications' }), deps)
    ).resolves.toBe(false)
    expect(prompts).toEqual([])
  })

  it('asks the settings before it asks what was remembered', async () => {
    // A setting flipped to `deny` has to override a stored allow, or turning the switch off would
    // leave the sites that were already granted still granted — a switch that does nothing.
    const recall = vi.fn(() => 'allow' as const)
    const { deps } = harness({
      settings: settingsWith({ 'permissions.geolocation': 'deny' }),
      recall
    })
    await expect(resolvePermissionRequest(request({}), deps)).resolves.toBe(false)
    expect(recall, 'the store was consulted despite a deny setting').not.toHaveBeenCalled()
  })
})

describe('camera, microphone and screen sharing behave exactly as before "ask" was wired', () => {
  /*
    A deliberate stance, not a gap (R13). "Ask" is a silent refusal for these three: no dialogue
    appears, nothing is remembered, and `allow` and `deny` keep answering alone. Pinned before the
    prompt was connected to anything, so wiring it could not quietly start asking for a camera.
  */
  const media = (mediaTypes: readonly string[]): PermissionRequestDetails =>
    request({ permission: 'media', mediaTypes })

  it('refuses a camera set to ask without a dialogue', async () => {
    const { deps, prompts, written } = harness({
      settings: settingsWith({ 'permissions.camera': 'ask' }),
      answer: 'allow-always'
    })
    await expect(resolvePermissionRequest(media(['video']), deps)).resolves.toBe(false)
    expect(prompts, 'a camera request reached a dialogue').toEqual([])
    expect(written).toEqual([])
  })

  it('refuses a microphone set to ask without a dialogue', async () => {
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.microphone': 'ask' }),
      answer: 'allow-once'
    })
    await expect(resolvePermissionRequest(media(['audio']), deps)).resolves.toBe(false)
    expect(prompts).toEqual([])
  })

  it('refuses the camera and microphone pair set to ask without a dialogue', async () => {
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.camera': 'ask', 'permissions.microphone': 'ask' }),
      answer: 'allow-once'
    })
    await expect(resolvePermissionRequest(media(['video', 'audio']), deps)).resolves.toBe(false)
    expect(prompts).toEqual([])
  })

  it('does not consult a remembered answer for the camera', async () => {
    // Nothing can have been stored for it, and a stored allow must not become a way round the stance.
    const recall = vi.fn(() => 'allow' as const)
    const { deps } = harness({ settings: settingsWith({ 'permissions.camera': 'ask' }), recall })
    await expect(resolvePermissionRequest(media(['video']), deps)).resolves.toBe(false)
    expect(recall).not.toHaveBeenCalled()
  })

  it('grants and refuses the microphone on allow and deny, as before', async () => {
    const allowed = harness({ settings: settingsWith({ 'permissions.microphone': 'allow' }) })
    await expect(resolvePermissionRequest(media(['audio']), allowed.deps)).resolves.toBe(true)
    const denied = harness({ settings: settingsWith({ 'permissions.microphone': 'deny' }) })
    await expect(resolvePermissionRequest(media(['audio']), denied.deps)).resolves.toBe(false)
    expect([...allowed.prompts, ...denied.prompts]).toEqual([])
  })

  it('grants an allowed camera whatever frame or origin asked, as before', async () => {
    // The origin rules below are for the dialogue and its memory; an allow setting never needed a site.
    const { deps } = harness({ settings: settingsWith({ 'permissions.camera': 'allow' }) })
    await expect(
      resolvePermissionRequest({ ...media(['video']), origin: null }, deps)
    ).resolves.toBe(true)
  })

  it('refuses screen sharing set to ask without a dialogue', async () => {
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.displayCapture': 'ask' }),
      answer: 'allow-once'
    })
    await expect(
      resolvePermissionRequest(request({ permission: 'display-capture' }), deps)
    ).resolves.toBe(false)
    expect(prompts).toEqual([])
  })
})

describe('unaskedPrompting', () => {
  it('lets the settings answer and refuses an ask without leaving a trace', async () => {
    const allow = unaskedPrompting(settingsWith({ 'permissions.geolocation': 'allow' }))
    await expect(resolvePermissionRequest(request({}), allow)).resolves.toBe(true)

    const ask = unaskedPrompting(settingsWith({ 'permissions.geolocation': 'ask' }))
    expect(ask.recall('https://example.com', 'geolocation')).toBe('ask')
    await expect(
      ask.prompt({ origin: 'https://example.com', subject: 'geolocation' })
    ).resolves.toBe(UNANSWERED)
    await expect(resolvePermissionRequest(request({}), ask)).resolves.toBe(false)
    expect(() => {
      ask.remember('https://example.com', 'geolocation', 'deny')
    }).not.toThrow()
  })

  it('still grants an allowed camera, as before any prompt existed', async () => {
    const deps = unaskedPrompting(settingsWith({ 'permissions.camera': 'allow' }))
    await expect(
      resolvePermissionRequest(request({ permission: 'media', mediaTypes: ['video'] }), deps)
    ).resolves.toBe(true)
  })
})

describe('answerPermissionCheck', () => {
  function check(overrides: Partial<PermissionCheck>): PermissionCheck {
    return {
      permission: 'geolocation',
      requestingOrigin: 'https://example.com',
      embeddingOrigin: null,
      topLevelUrl: 'https://example.com/page',
      ...overrides
    }
  }

  function answering(
    settings: Partial<SettingsSnapshot>,
    recall: (origin: string, subject: PermissionSubject) => 'allow' | 'deny' | 'ask' = () => 'ask'
  ): Pick<PermissionPrompting, 'settings' | 'recall'> {
    return { settings: settingsWith(settings), recall }
  }

  it('answers from the settings when they allow or deny', () => {
    expect(
      answerPermissionCheck(check({}), answering({ 'permissions.geolocation': 'allow' }))
    ).toBe(true)
    expect(answerPermissionCheck(check({}), answering({ 'permissions.geolocation': 'deny' }))).toBe(
      false
    )
  })

  it("reports a site's remembered allow as granted", () => {
    const recall = vi.fn(() => 'allow' as const)
    expect(
      answerPermissionCheck(check({}), answering({ 'permissions.geolocation': 'ask' }, recall))
    ).toBe(true)
    expect(recall).toHaveBeenCalledWith('https://example.com', 'geolocation')
  })

  it('reports a question still to be asked, and a remembered block, as not granted', () => {
    expect(answerPermissionCheck(check({}), answering({ 'permissions.geolocation': 'ask' }))).toBe(
      false
    )
    expect(
      answerPermissionCheck(
        check({}),
        answering({ 'permissions.geolocation': 'ask' }, () => 'deny')
      )
    ).toBe(false)
  })

  it('uses the checking origin when there is no webContents', () => {
    // A service worker's check. The memory it reads was bound to the session's mode beforehand.
    const remembered = answering({ 'permissions.notifications': 'ask' }, (origin) =>
      origin === 'https://example.com' ? 'allow' : 'ask'
    )
    expect(
      answerPermissionCheck(check({ permission: 'notifications', topLevelUrl: null }), remembered)
    ).toBe(true)
    expect(
      answerPermissionCheck(
        check({
          permission: 'notifications',
          requestingOrigin: 'https://other.example',
          topLevelUrl: null
        }),
        remembered
      )
    ).toBe(false)
  })

  it('refuses a cross-origin subframe even where the page was allowed', () => {
    const recall = vi.fn(() => 'allow' as const)
    const settings = { 'permissions.geolocation': 'ask' } as const
    // With a webContents: the frame's origin is not the page's.
    expect(
      answerPermissionCheck(
        check({
          requestingOrigin: 'https://ads.example.net',
          embeddingOrigin: 'https://example.com'
        }),
        answering(settings, recall)
      )
    ).toBe(false)
    // Without one: the embedding origin still names the page.
    expect(
      answerPermissionCheck(
        check({
          requestingOrigin: 'https://ads.example.net',
          embeddingOrigin: 'https://example.com',
          topLevelUrl: null
        }),
        answering(settings, recall)
      )
    ).toBe(false)
    expect(recall).not.toHaveBeenCalled()
  })

  it('never reports the camera or microphone as granted, as before', () => {
    // Media is checked with no device named, and `media` has no setting of its own.
    for (const value of ['allow', 'ask', 'deny'] as const) {
      expect(
        answerPermissionCheck(
          check({ permission: 'media' }),
          answering({ 'permissions.camera': value, 'permissions.microphone': value }, () => 'allow')
        ),
        value
      ).toBe(false)
    }
  })

  it('grants fullscreen and refuses what it has never heard of, as before', () => {
    expect(answerPermissionCheck(check({ permission: 'fullscreen' }), answering({}))).toBe(true)
    expect(
      answerPermissionCheck(check({ permission: 'some-future-capability' }), answering({}))
    ).toBe(false)
  })
})
