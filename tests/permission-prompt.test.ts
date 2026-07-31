import { describe, expect, it, vi } from 'vitest'
import {
  permissionSubject,
  rememberedDecision,
  resolvePermissionRequest,
  type PermissionPrompting,
  type PermissionRequestDetails
} from '@main/session/permission-policy.js'
import {
  PERMISSION_ANSWERS,
  PERMISSION_SUBJECTS,
  PERMISSION_TOPICS,
  subjectDevices,
  subjectTopics,
  type PermissionAnswer,
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
  answer?: PermissionAnswer
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

  it('asks about a camera and microphone pair once, as one subject', async () => {
    const { deps, prompts } = harness({
      settings: settingsWith({ 'permissions.camera': 'ask', 'permissions.microphone': 'ask' }),
      answer: 'allow-once'
    })
    await expect(
      resolvePermissionRequest(
        request({ permission: 'media', mediaTypes: ['video', 'audio'] }),
        deps
      )
    ).resolves.toBe(true)
    expect(prompts).toEqual([
      { origin: 'https://example.com', subject: 'camera-and-microphone' }
    ])
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

  it('refuses a dismissed dialogue and remembers the refusal', async () => {
    // Escape, an outside click, a resized window: all arrive here as `block`.
    const { deps, written } = harness({
      settings: settingsWith({ 'permissions.camera': 'ask' }),
      answer: 'block'
    })
    await expect(
      resolvePermissionRequest(request({ permission: 'media', mediaTypes: ['video'] }), deps)
    ).resolves.toBe(false)
    expect(written).toEqual([
      { origin: 'https://example.com', subject: 'camera', decision: 'deny' }
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
