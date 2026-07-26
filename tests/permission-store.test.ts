import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PermissionStore } from '@main/data/PermissionStore.js'
import type { DocumentCodec } from '@main/data/JsonStore.js'
import {
  MAX_SITE_PERMISSIONS,
  findSitePermission,
  forgetOrigin,
  forgetfulSitePermissions,
  putSitePermission,
  recallSiteDecision,
  repairSitePermissions,
  type SitePermission
} from '@main/permissions/model.js'

/**
 * What a site was answered, and who is allowed to remember it.
 *
 * The load-bearing assertion in here is the private-window one. A private window is handed an
 * object with no reference to the store at all, so "nothing is written" is a property of what the
 * window physically holds rather than a check somebody has to remember at every call site — and the
 * test that proves it looks at the file, not at a flag.
 */

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'tessera-permissions-'))
})

afterEach(async () => {
  // `maxRetries` because a store left with a write in flight can be renaming its temporary file
  // while the directory is being removed, which surfaces as ENOTEMPTY on the rmdir.
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
})

/** Lets a scheduled write reach the disk, so "nothing was written" is a real observation. */
async function settleWrites(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10))
}

function filePath(): string {
  return join(directory, 'permissions.json')
}

async function open(options: { now?: () => number; maxEntries?: number } = {}): Promise<PermissionStore> {
  return PermissionStore.open({
    filePath: filePath(),
    debounceMs: 0,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries })
  })
}

function entry(overrides: Partial<SitePermission> = {}): SitePermission {
  return {
    origin: 'https://example.com',
    topic: 'camera',
    decision: 'allow',
    decidedAt: 1000,
    ...overrides
  }
}

describe('recallSiteDecision', () => {
  it('says ask when nothing is remembered', () => {
    // Three-valued on purpose: `null` would be one more thing to confuse with a remembered no.
    expect(recallSiteDecision([], 'https://example.com', 'camera')).toBe('ask')
  })

  it('returns what a site was told', () => {
    const sites = [entry({ topic: 'geolocation', decision: 'deny' })]
    expect(recallSiteDecision(sites, 'https://example.com', 'geolocation')).toBe('deny')
  })

  it('does not answer for a different site', () => {
    // The whole point of storing an origin: one site's grant is not another's.
    const sites = [entry()]
    expect(recallSiteDecision(sites, 'https://other.example', 'camera')).toBe('ask')
  })

  it('treats http and https as different sites', () => {
    const sites = [entry({ origin: 'https://example.com' })]
    expect(recallSiteDecision(sites, 'http://example.com', 'camera')).toBe('ask')
  })

  it('answers a combined media request only when both halves are remembered', () => {
    const cameraOnly = [entry({ topic: 'camera' })]
    expect(recallSiteDecision(cameraOnly, 'https://example.com', 'camera-and-microphone')).toBe(
      'ask'
    )

    const both = [entry({ topic: 'camera' }), entry({ topic: 'microphone' })]
    expect(recallSiteDecision(both, 'https://example.com', 'camera-and-microphone')).toBe('allow')
  })

  it('lets a remembered refusal of one half refuse the pair', () => {
    // The strictest answer wins, exactly as it does across the two settings.
    const sites = [entry({ topic: 'camera' }), entry({ topic: 'microphone', decision: 'deny' })]
    expect(recallSiteDecision(sites, 'https://example.com', 'camera-and-microphone')).toBe('deny')
  })
})

describe('putSitePermission', () => {
  it('replaces the previous answer for the same site and topic', () => {
    // Two decisions for one question is a state nothing can resolve; the read path would silently
    // take whichever came first in the file.
    const sites = putSitePermission([entry()], entry({ decision: 'deny', decidedAt: 2000 }))
    expect(sites).toHaveLength(1)
    expect(sites[0]?.decision).toBe('deny')
  })

  it('keeps answers for other topics of the same site', () => {
    const sites = putSitePermission([entry()], entry({ topic: 'microphone' }))
    expect(sites).toHaveLength(2)
    expect(findSitePermission(sites, 'https://example.com', 'camera')).not.toBeNull()
  })

  it('drops the oldest once the cap is reached', () => {
    const sites = putSitePermission([entry({ origin: 'https://old.example' })], entry(), 1)
    expect(sites).toEqual([entry()])
  })

  it('keeps at least the answer just given, whatever the cap says', () => {
    // A cap of zero would otherwise store the decision and immediately discard it — a dialogue the
    // user answered "always" to that asks again next time.
    expect(putSitePermission([], entry(), 0)).toEqual([entry()])
  })

  it('has a cap at all', () => {
    expect(MAX_SITE_PERMISSIONS).toBeGreaterThan(0)
  })
})

describe('forgetOrigin', () => {
  it('removes every answer for one site and leaves the others', () => {
    const sites = [entry(), entry({ topic: 'microphone' }), entry({ origin: 'https://other.example' })]
    expect(forgetOrigin(sites, 'https://example.com')).toEqual([
      entry({ origin: 'https://other.example' })
    ])
  })
})

describe('repairSitePermissions', () => {
  it('keeps the newest of two answers for the same question', () => {
    // What an older build, a hand edit or a crash mid-write leaves behind. Rejecting the document
    // instead would lose every answer the user ever gave because one was written twice.
    const repaired = repairSitePermissions([
      entry({ decision: 'allow', decidedAt: 1000 }),
      entry({ decision: 'deny', decidedAt: 2000 })
    ])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.decision).toBe('deny')
  })

  it('drops an entry with no site', () => {
    expect(repairSitePermissions([entry({ origin: '' })])).toEqual([])
  })

  it('trims to the cap, oldest first', () => {
    const repaired = repairSitePermissions(
      [
        entry({ origin: 'https://a.example', decidedAt: 1 }),
        entry({ origin: 'https://b.example', decidedAt: 2 })
      ],
      1
    )
    expect(repaired.map((site) => site.origin)).toEqual(['https://b.example'])
  })

  it('keeps at least one entry however small the cap', () => {
    expect(repairSitePermissions([entry()], 0)).toHaveLength(1)
  })
})

describe('forgetfulSitePermissions', () => {
  it('remembers nothing and answers nothing', () => {
    forgetfulSitePermissions.remember('https://example.com', 'camera', 'allow')
    expect(forgetfulSitePermissions.recall('https://example.com', 'camera')).toBe('ask')
  })
})

describe('PermissionStore', () => {
  it('remembers an answer for a site and does not ask again', async () => {
    const store = await open({ now: () => 1234 })
    const rules = store.rulesFor('normal')
    expect(rules.recall('https://example.com', 'geolocation')).toBe('ask')

    rules.remember('https://example.com', 'geolocation', 'allow')
    expect(rules.recall('https://example.com', 'geolocation')).toBe('allow')
    expect(store.list()).toEqual([
      { origin: 'https://example.com', topic: 'geolocation', decision: 'allow', decidedAt: 1234 }
    ])
  })

  it('stores a combined media grant as both devices', async () => {
    // So a later camera-only request from the same site finds its answer instead of prompting.
    const store = await open()
    const rules = store.rulesFor('normal')
    rules.remember('https://example.com', 'camera-and-microphone', 'allow')

    expect(store.list().map((site) => site.topic).sort()).toEqual(['camera', 'microphone'])
    expect(rules.recall('https://example.com', 'camera')).toBe('allow')
    expect(rules.recall('https://example.com', 'microphone')).toBe('allow')
  })

  it('survives being written and read back', async () => {
    const first = await open()
    first.rulesFor('normal').remember('https://example.com', 'notifications', 'deny')
    await first.flush()

    const second = await open()
    expect(second.rulesFor('normal').recall('https://example.com', 'notifications')).toBe('deny')
  })

  it('writes nothing at all for a private window', async () => {
    /*
      The requirement, checked against the file rather than against a flag: a private window is
      handed an object holding no store, so there is no path from it to the disk to forget to guard.
    */
    const store = await open()
    const rules = store.rulesFor('private')
    rules.remember('https://example.com', 'camera', 'allow')
    // No flush: with a zero debounce a real write would already be on its way, so the absence of
    // the file is evidence rather than a timing accident.
    await settleWrites()

    expect(store.list(), 'a private window reached the store').toEqual([])
    await expect(readFile(filePath(), 'utf8'), 'a private window created the file').rejects.toThrow()
  })

  it('does not honour a stored grant in a private window', async () => {
    /*
      A persistent "allow the camera" carried into a private window would hand a site the camera
      with no prompt at all, on the strength of a decision made in the mode whose entire purpose is
      that it is not the same visitor.
    */
    const store = await open()
    store.rulesFor('normal').remember('https://example.com', 'camera', 'allow')
    expect(store.rulesFor('private').recall('https://example.com', 'camera')).toBe('ask')
  })

  it('forgets one site on request', async () => {
    const store = await open()
    const rules = store.rulesFor('normal')
    rules.remember('https://example.com', 'camera', 'allow')
    rules.remember('https://other.example', 'camera', 'allow')

    expect(store.forget('https://example.com')).toBe(1)
    expect(rules.recall('https://example.com', 'camera')).toBe('ask')
    expect(rules.recall('https://other.example', 'camera')).toBe('allow')
  })

  it('clears everything and reports how much went', async () => {
    const store = await open()
    store.rulesFor('normal').remember('https://example.com', 'camera-and-microphone', 'allow')
    expect(store.clear()).toBe(2)
    expect(store.list()).toEqual([])
    await store.flush()
  })

  it('tells listeners about a change', async () => {
    const store = await open()
    const seen: number[] = []
    const stop = store.onChange((sites) => seen.push(sites.length))
    store.rulesFor('normal').remember('https://example.com', 'camera', 'allow')
    stop()
    store.rulesFor('normal').remember('https://example.com', 'microphone', 'allow')
    expect(seen).toEqual([1])
  })

  it('honours the entry cap', async () => {
    const store = await open({ maxEntries: 2 })
    const rules = store.rulesFor('normal')
    rules.remember('https://a.example', 'camera', 'allow')
    rules.remember('https://b.example', 'camera', 'allow')
    rules.remember('https://c.example', 'camera', 'allow')
    expect(store.list().map((site) => site.origin)).toEqual([
      'https://c.example',
      'https://b.example'
    ])
  })

  it('heals a file with two answers to one question rather than rejecting it', async () => {
    await writeFile(
      filePath(),
      JSON.stringify({
        version: 1,
        sites: [
          { origin: 'https://example.com', topic: 'camera', decision: 'allow', decidedAt: 1 },
          { origin: 'https://example.com', topic: 'camera', decision: 'deny', decidedAt: 2 }
        ]
      })
    )

    const store = await open()
    expect(store.recoveredFromInvalidFile, 'a repairable file was thrown away').toBe(false)
    expect(store.list()).toHaveLength(1)
    expect(store.rulesFor('normal').recall('https://example.com', 'camera')).toBe('deny')
  })

  it('starts from nothing when the file is not ours', async () => {
    // A wrong *kind* of value means the file is not ours, and defaults are the only safe answer —
    // unlike a wrong amount, which is healed.
    await writeFile(filePath(), JSON.stringify({ version: 1, sites: [{ origin: 42 }] }))
    const store = await open()
    expect(store.recoveredFromInvalidFile).toBe(true)
    expect(store.list()).toEqual([])
  })

  it('starts from nothing when the file names a topic this build does not know', async () => {
    // Deliberately strict: an unrecognised topic would leave an entry nothing can ever match and
    // nothing can ever remove.
    await writeFile(
      filePath(),
      JSON.stringify({
        version: 1,
        sites: [{ origin: 'https://example.com', topic: 'telepathy', decision: 'allow', decidedAt: 1 }]
      })
    )
    const store = await open()
    expect(store.recoveredFromInvalidFile).toBe(true)
    expect(store.list()).toEqual([])
  })
})

describe('the options the store is opened with', () => {
  /*
    Added after a mutation run: the two conditional spreads in `open` — for `codec` and `debounceMs` — survived
    every mutation, because no test opened the store *without* them and checked what followed.

    The codec one is the consequential half. If that spread were ever wrong, a store would be created with no
    codec and would write remembered permission answers to disk in plain text — a list of which sites the user
    granted a camera to. It would work perfectly, pass every other test here, and be silently unencrypted.
  */
  it('puts the answers through the codec it was given', async () => {
    const file = join(await mkdtemp(join(tmpdir(), 'tessera-perm-')), 'permissions.json')
    // A codec that is obviously not JSON, so "was it used" is visible in the bytes rather than inferred.
    const codec: DocumentCodec = {
      encode: (value) => Buffer.from(`MARKED${JSON.stringify(value)}`, 'utf8'),
      decode: (bytes) => {
        const text = Buffer.from(bytes).toString('utf8')
        return JSON.parse(text.startsWith('MARKED') ? text.slice('MARKED'.length) : text) as unknown
      }
    }

    const store = await PermissionStore.open({ filePath: file, codec, debounceMs: 0 })
    store.rulesFor('normal').remember('https://example.com', 'geolocation', 'allow')
    await store.flush()

    const raw = await readFile(file, 'utf8')
    // The prefix is the evidence. A "does not contain the origin" assertion here would only test that *this*
    // fake codec obscures it, which says nothing about the store.
    expect(raw.startsWith('MARKED'), 'the codec was not used').toBe(true)

    // And it reads back through the same codec, which is the half a write-only check would miss.
    const reopened = await PermissionStore.open({ filePath: file, codec, debounceMs: 0 })
    expect(reopened.rulesFor('normal').recall('https://example.com', 'geolocation')).toBe('allow')
  })

  it('writes plain JSON when no codec is given, and reads it back', async () => {
    /*
      The other side of the same spread, and the reason it is a *conditional* one: with
      `exactOptionalPropertyTypes`, passing `codec: undefined` is not the same as omitting it, and a store handed
      an explicit `undefined` would fail differently from one handed nothing. This asserts the omitted case works
      end to end rather than merely compiling.
    */
    const file = join(await mkdtemp(join(tmpdir(), 'tessera-perm-')), 'permissions.json')
    const store = await PermissionStore.open({ filePath: file, debounceMs: 0 })
    store.rulesFor('normal').remember('https://example.com', 'geolocation', 'allow')
    await store.flush()

    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1 })

    const reopened = await PermissionStore.open({ filePath: file, debounceMs: 0 })
    expect(reopened.rulesFor('normal').recall('https://example.com', 'geolocation')).toBe('allow')
  })
})
