import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { NativeImage } from 'electron'
import { plainJsonDocumentCodec, type DocumentCodec } from '@main/data/JsonStore.js'
import {
  ThumbnailStore,
  thumbnailFileName,
  type CaptureTarget,
  type CapturedImage,
  type PageCapturer
} from '@main/data/ThumbnailStore.js'
import {
  MAX_THUMBNAIL_BYTES,
  THUMBNAIL_SETTLE_DELAY_MS,
  THUMBNAIL_TARGET,
  discardingThumbnailCapturer,
  type ThumbnailEntry,
  type ThumbnailIndex,
  type ThumbnailRect,
  type ThumbnailRequest,
  type ThumbnailSize
} from '@shared/thumbnails/model.js'

/**
 * The thumbnail store: when a picture is taken, what it is scaled to, who may take
 * one, and what "clear data" leaves behind.
 *
 * Nothing here loads Electron or reads the real clock. The camera is injected, which
 * is the same seam that in production keeps the decision of *which* view is
 * photographed with the wiring — the only party that knows whether that view still
 * shows the page it was asked about. A test that reached for `webContents` would be
 * testing a browser process instead of the feature.
 *
 * Assertions about "nothing was stored" read the directory rather than trusting the
 * in-memory answer, because the trace a private window must not leave is on disk.
 */

const T0 = 1_700_000_000_000
const PAGE = 'https://www.example.com/some/article'
const PAGE_KEY = 'https://www.example.com/some/article'
const OTHER = 'https://other.org/index'
const TITLE = 'Example — An Article'

/** A recognisable body whose first bytes say which quality produced it. */
function jpegBytes(marker: number, length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  bytes.set([0xff, 0xd8, 0xff, marker], 0)
  return bytes
}

interface CameraLog {
  crops: ThumbnailRect[]
  resizes: Array<{ width: number; height: number; quality: string }>
  /** The qualities `toJPEG` was asked for, in order. */
  qualities: number[]
}

interface FakeImageOptions {
  size?: ThumbnailSize
  empty?: boolean
  jpeg?: (quality: number) => Uint8Array
  fail?: 'crop' | 'resize' | 'toJPEG'
}

/**
 * A captured image made of four plain functions.
 *
 * This is the whole cost of the seam being structural: no Electron, no mocking
 * framework, and the crop and resize steps are observable, which is how the scaling
 * assertions can check what the store asked for rather than only what came back.
 */
function fakeImage(log: CameraLog, options: FakeImageOptions = {}): CapturedImage {
  const size = options.size ?? { width: 1600, height: 1000 }
  const jpeg = options.jpeg ?? ((quality: number) => jpegBytes(quality, quality * 100))
  return {
    isEmpty: () => options.empty ?? false,
    getSize: () => size,
    crop: (rect) => {
      if (options.fail === 'crop') throw new Error('crop failed')
      log.crops.push(rect)
      return fakeImage(log, { ...options, size: { width: rect.width, height: rect.height } })
    },
    resize: (asked) => {
      if (options.fail === 'resize') throw new Error('resize failed')
      log.resizes.push(asked)
      return fakeImage(log, { ...options, size: { width: asked.width, height: asked.height } })
    },
    toJPEG: (quality) => {
      if (options.fail === 'toJPEG') throw new Error('encode failed')
      log.qualities.push(quality)
      return jpeg(quality)
    }
  }
}

interface Harness {
  store: ThumbnailStore
  directory: string
  /** Every view the store asked to photograph, in order. */
  targets: CaptureTarget[]
  log: CameraLog
  answer(camera: PageCapturer): void
  tick(ms: number): void
}

async function harness(
  options: {
    maxAgeMs?: number
    maxEntries?: number
    directory?: string
    settleDelayMs?: number
  } = {}
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'tessera-thumbnails-'))
  const directory = options.directory ?? join(root, 'thumbnails')
  const targets: CaptureTarget[] = []
  const log: CameraLog = { crops: [], resizes: [], qualities: [] }
  let camera: PageCapturer = () => Promise.resolve(fakeImage(log))
  let clock = T0

  const store = await ThumbnailStore.open({
    directory,
    capture: (target) => {
      targets.push(target)
      return camera(target)
    },
    now: () => clock,
    // No debounce: the assertions read the index straight after a write.
    debounceMs: 0,
    ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
    ...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
    ...(options.settleDelayMs === undefined ? {} : { settleDelayMs: options.settleDelayMs })
  })

  return {
    store,
    directory,
    targets,
    log,
    answer: (next) => {
      camera = next
    },
    tick: (ms) => {
      clock += ms
    }
  }
}

function request(overrides: Partial<ThumbnailRequest> = {}): ThumbnailRequest {
  return { url: PAGE, title: TITLE, viewId: 7, ...overrides }
}

/**
 * A codec that leaves nothing readable in the file.
 *
 * Not encryption — base64 hides nothing from anyone trying — but it stands in for the real
 * codec in the one respect that matters to a store: the bytes on disk are not the document.
 * A test using the *plain* codec cannot tell a store that forwards its codec from one that
 * ignores it, which is how the forwarding stayed unasserted.
 */
function sealingCodec(): DocumentCodec {
  const marker = 'sealed:'
  return {
    encode: (data) =>
      new TextEncoder().encode(
        `${marker}${Buffer.from(JSON.stringify(data), 'utf8').toString('base64')}`
      ),
    decode: (bytes) => {
      const text = new TextDecoder().decode(bytes)
      if (!text.startsWith(marker)) throw new Error('not written by this codec')
      return JSON.parse(Buffer.from(text.slice(marker.length), 'base64').toString('utf8')) as unknown
    }
  }
}

async function storedShots(directory: string): Promise<ThumbnailEntry[]> {
  const text = await readFile(join(directory, 'index.json'), 'utf8')
  return (JSON.parse(text) as ThumbnailIndex).shots
}

function shotPath(directory: string, key: string): string {
  return join(directory, thumbnailFileName(key))
}

describe('taking a picture', () => {
  it('photographs a settled page once and puts it on disk', async () => {
    const h = await harness()
    const outcome = await h.store.capturerFor('normal').capture(request())

    expect(outcome).toEqual({
      kind: 'stored',
      entry: {
        url: PAGE_KEY,
        title: TITLE,
        width: 480,
        height: 300,
        byteLength: 7_000,
        capturedAt: T0
      }
    })
    // The store hands the view straight back to the provider and interprets nothing
    // about it — including the unnormalised address, so the provider can check that the
    // view still shows the page before spending a frame on it.
    expect(h.targets).toEqual([{ url: PAGE, viewId: 7 }])

    const file = shotPath(h.directory, PAGE_KEY)
    const bytes = new Uint8Array(await readFile(file))
    expect(bytes).toHaveLength(7_000)
    expect(bytes[3], 'stored at the primary quality').toBe(70)

    await h.store.flush()
    expect((await storedShots(h.directory)).map((shot) => shot.url)).toEqual([PAGE_KEY])
    expect(h.store.counts).toMatchObject({ captures: 1, stored: 1, fresh: 0, kept: 0 })
  })

  it('stays well inside the byte budget for one card', async () => {
    const h = await harness()
    const outcome = await h.store.capturerFor('normal').capture(request())

    expect(outcome.kind).toBe('stored')
    const entry = h.store.list().at(0)
    expect(entry?.byteLength).toBeLessThanOrEqual(MAX_THUMBNAIL_BYTES)
    // The size recorded is the size on disk, which is what the handler will serve.
    const bytes = new Uint8Array(await readFile(shotPath(h.directory, PAGE_KEY)))
    expect(entry?.byteLength).toBe(bytes.byteLength)
  })

  it('takes no second picture within the freshness window', async () => {
    const h = await harness()
    const capturer = h.store.capturerFor('normal')
    const first = await capturer.capture(request())
    // The same document, arrived at differently: a fragment and a campaign parameter
    // are not a different page, so they must not cost a second picture.
    const second = await capturer.capture(request({ url: `${PAGE}?utm_source=x#top` }))

    expect(first.kind).toBe('stored')
    expect(second).toEqual({ kind: 'fresh', entry: h.store.list().at(0) })
    expect(h.log.qualities, 'a second capture was encoded').toHaveLength(1)
    expect(h.targets, 'a second view was photographed').toHaveLength(1)
    expect(h.store.counts).toMatchObject({ captures: 1, fresh: 1 })
  })

  it('lets the wiring ask before it schedules anything', async () => {
    const h = await harness({ maxAgeMs: 1_000 })
    const capturer = h.store.capturerFor('normal')

    expect(capturer.shouldCapture(PAGE)).toBe(true)
    // No timer, no delayed work, no photograph for a page that has a current picture.
    await capturer.capture(request())
    expect(capturer.shouldCapture(PAGE)).toBe(false)
    expect(capturer.shouldCapture('tessera://start')).toBe(false)

    h.tick(1_000)
    expect(capturer.shouldCapture(PAGE)).toBe(true)
  })

  it('takes a new picture once the old one has aged, and replaces the file', async () => {
    const h = await harness({ maxAgeMs: 1_000 })
    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())

    h.tick(1_000)
    h.answer(() => Promise.resolve(fakeImage(h.log, { jpeg: () => jpegBytes(7, 4_321) })))
    const outcome = await capturer.capture(request({ title: 'Example — A newer article' }))

    expect(outcome).toMatchObject({
      kind: 'stored',
      entry: { byteLength: 4_321, capturedAt: T0 + 1_000, title: 'Example — A newer article' }
    })
    const bytes = new Uint8Array(await readFile(shotPath(h.directory, PAGE_KEY)))
    expect(bytes).toHaveLength(4_321)
    // Still one entry: a refresh replaces, it does not accumulate.
    expect(h.store.list()).toHaveLength(1)
  })

  it('photographs one view when two triggers arrive at the same moment', async () => {
    const h = await harness()
    let release: (image: CapturedImage) => void = () => {}
    h.answer(() => new Promise<CapturedImage>((resolve) => (release = resolve)))

    const capturer = h.store.capturerFor('normal')
    const first = capturer.capture(request())
    const second = capturer.capture(request({ url: `${PAGE}#footnote` }))
    // A subframe settling, or a client-side route change, reports the same page twice.
    expect(capturer.shouldCapture(PAGE), 'a capture is already in flight').toBe(false)
    release(fakeImage(h.log))

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe(b)
    expect(h.targets).toHaveLength(1)
  })

  it('collapses a title the page delivered with newlines in it', async () => {
    const h = await harness()
    await h.store.capturerFor('normal').capture(request({ title: '  Example\n\tArticle ' }))
    expect(h.store.list().at(0)?.title).toBe('Example Article')
  })
})

describe('scaling what came back', () => {
  it('crops the top off a tall page and scales that to the card', async () => {
    const h = await harness()
    h.answer(() => Promise.resolve(fakeImage(h.log, { size: { width: 1440, height: 2400 } })))
    await h.store.capturerFor('normal').capture(request())

    // The header and the headline, not the footer: 1440×900 is the 16:10 region at the
    // top of the page.
    expect(h.log.crops).toEqual([{ x: 0, y: 0, width: 1440, height: 900 }])
    expect(h.log.resizes).toEqual([{ width: 480, height: 300, quality: 'best' }])
    expect(h.store.list().at(0)).toMatchObject({ width: 480, height: 300 })
  })

  it('scales a 4K window down by a factor of eight', async () => {
    const h = await harness()
    h.answer(() => Promise.resolve(fakeImage(h.log, { size: { width: 3840, height: 2160 } })))
    await h.store.capturerFor('normal').capture(request())

    expect(h.log.resizes.at(0)).toMatchObject({ width: 480, height: 300 })
    // The whole point of the exercise: a card is a few hundred pixels wide, so a 4K
    // capture is a hundred times the area it will ever be drawn at.
    const stored = h.store.list().at(0)
    expect(stored?.width).toBe(THUMBNAIL_TARGET.width)
    expect(stored?.height).toBe(THUMBNAIL_TARGET.height)
  })

  it('asks for neither step when the window is already card-shaped', async () => {
    const h = await harness()
    h.answer(() => Promise.resolve(fakeImage(h.log, { size: { width: 480, height: 300 } })))
    await h.store.capturerFor('normal').capture(request())

    // Asking the platform to crop an image to its own bounds, or resize it to the size
    // it already is, is work for nothing.
    expect(h.log.crops).toEqual([])
    expect(h.log.resizes).toEqual([])
    expect(h.store.list().at(0)).toMatchObject({ width: 480, height: 300 })
  })

  it('never upscales a small window', async () => {
    const h = await harness()
    h.answer(() => Promise.resolve(fakeImage(h.log, { size: { width: 320, height: 240 } })))
    await h.store.capturerFor('normal').capture(request())

    expect(h.log.crops).toEqual([{ x: 0, y: 0, width: 320, height: 200 }])
    expect(h.log.resizes).toEqual([])
    expect(h.store.list().at(0)).toMatchObject({ width: 320, height: 200 })
  })

  it('drops to a lower quality rather than giving up on a heavy page', async () => {
    const h = await harness()
    h.answer(() =>
      Promise.resolve(
        fakeImage(h.log, {
          jpeg: (quality) =>
            quality === 70 ? jpegBytes(70, MAX_THUMBNAIL_BYTES + 1) : jpegBytes(40, 30_000)
        })
      )
    )

    const outcome = await h.store.capturerFor('normal').capture(request())
    expect(outcome).toMatchObject({ kind: 'stored', entry: { byteLength: 30_000 } })
    expect(h.log.qualities).toEqual([70, 40])
  })

  it('keeps a picture that lands exactly on the cap, at either quality', async () => {
    /*
      The cap, at the value itself, on both attempts. Every other case here is a byte over
      or comfortably under, so `<=` could have been `<` in either line and only a capture
      of exactly 98 304 bytes would have noticed — and what it would produce is a
      `too-large` refusal for a picture the index schema accepts, so the card would lose
      its thumbnail with the counters saying the encoder was at fault.
    */
    const first = await harness()
    first.answer(() =>
      Promise.resolve(fakeImage(first.log, { jpeg: () => jpegBytes(70, MAX_THUMBNAIL_BYTES) }))
    )
    expect(await first.store.capturerFor('normal').capture(request())).toMatchObject({
      kind: 'stored',
      entry: { byteLength: MAX_THUMBNAIL_BYTES }
    })
    // And it stopped at the first attempt: a picture that fits is not re-encoded.
    expect(first.log.qualities).toEqual([70])

    const second = await harness()
    second.answer(() =>
      Promise.resolve(
        fakeImage(second.log, {
          jpeg: (quality) =>
            quality === 70
              ? jpegBytes(70, MAX_THUMBNAIL_BYTES + 1)
              : jpegBytes(40, MAX_THUMBNAIL_BYTES)
        })
      )
    )
    expect(await second.store.capturerFor('normal').capture(request())).toMatchObject({
      kind: 'stored',
      entry: { byteLength: MAX_THUMBNAIL_BYTES }
    })
    expect(second.log.qualities).toEqual([70, 40])
  })

  it('refuses a picture that is too big even at the lower quality', async () => {
    const h = await harness()
    h.answer(() =>
      Promise.resolve(
        fakeImage(h.log, { jpeg: () => jpegBytes(0, MAX_THUMBNAIL_BYTES + 1) })
      )
    )

    expect(await h.store.capturerFor('normal').capture(request())).toEqual({
      kind: 'rejected',
      reason: 'too-large'
    })
    // Two attempts and no more: a search for the quality that just fits would re-encode
    // the same image on a path that runs for every page the user reads.
    expect(h.log.qualities).toEqual([70, 40])
    expect(h.store.list()).toEqual([])
  })
})

describe('refusing what cannot be stored', () => {
  it('refuses a view that had not painted yet', async () => {
    const h = await harness()
    h.answer(() => Promise.resolve(fakeImage(h.log, { empty: true })))

    expect(await h.store.capturerFor('normal').capture(request())).toEqual({
      kind: 'rejected',
      reason: 'blank'
    })
    // An empty image encodes to a plausible-looking grey rectangle, which is worse than
    // no picture: the card would look as though the page really is blank.
    expect(h.log.qualities).toEqual([])
    expect(existsSync(shotPath(h.directory, PAGE_KEY))).toBe(false)
  })

  it('refuses a view that reports no usable size', async () => {
    const h = await harness()
    h.answer(() => Promise.resolve(fakeImage(h.log, { size: { width: 0, height: 0 } })))

    expect(await h.store.capturerFor('normal').capture(request())).toEqual({
      kind: 'rejected',
      reason: 'blank'
    })
    expect(h.store.counts.rejected.blank).toBe(1)
  })

  it('refuses a view the provider could not photograph', async () => {
    const h = await harness()
    // `null` is how a provider says "not now" — the view has gone, or it has already
    // navigated on to a different page.
    h.answer(() => Promise.resolve(null))

    expect(await h.store.capturerFor('normal').capture(request())).toEqual({
      kind: 'rejected',
      reason: 'capture-failed'
    })
    expect(h.store.counts.rejected['capture-failed']).toBe(1)
  })

  it('refuses a provider that threw instead of answering', async () => {
    const h = await harness()
    h.answer(() => Promise.reject(new Error('view destroyed')))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await h.store.capturerFor('normal').capture(request())).toEqual({
      kind: 'rejected',
      reason: 'capture-failed'
    })
    // Named, and named with the page in it. `capture-failed` is also what a view that had
    // simply gone reports, so without the address in the log a provider that throws for
    // every page — a broken platform call — is indistinguishable from ordinary tab churn.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`[thumbnails] could not photograph ${PAGE}`),
      expect.anything()
    )
    warn.mockRestore()
  })

  it('refuses pixels it could not crop, scale or encode', async () => {
    for (const fail of ['crop', 'resize', 'toJPEG'] as const) {
      const h = await harness()
      h.answer(() =>
        Promise.resolve(fakeImage(h.log, { size: { width: 1440, height: 2400 }, fail }))
      )
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(await h.store.capturerFor('normal').capture(request()), fail).toEqual({
        kind: 'rejected',
        reason: 'encode-failed'
      })
      // One reason covers all three steps on purpose, so the log line is the only place
      // that says the pixel path was where it broke — as opposed to the page, the file or
      // the index, which produce the same shape of refusal.
      expect(warn, fail).toHaveBeenCalledWith(
        '[thumbnails] could not scale or encode a capture:',
        expect.any(Error)
      )
      warn.mockRestore()
    }
  })

  it('refuses an encoder that produced nothing', async () => {
    const h = await harness()
    // A zero-length file would be served as a broken image, and the schema would refuse
    // the entry describing it anyway.
    h.answer(() => Promise.resolve(fakeImage(h.log, { jpeg: () => new Uint8Array(0) })))

    expect(await h.store.capturerFor('normal').capture(request())).toEqual({
      kind: 'rejected',
      reason: 'encode-failed'
    })
    expect(existsSync(shotPath(h.directory, PAGE_KEY))).toBe(false)
  })

  it('photographs nothing for a page that is not one', async () => {
    const h = await harness()
    for (const url of ['tessera://start', 'file:///Users/someone/notes.html', 'about:blank']) {
      expect(await h.store.capturerFor('normal').capture(request({ url })), url).toEqual({
        kind: 'rejected',
        reason: 'not-a-page'
      })
    }
    // Not merely unstored: no picture was ever taken, which is the part that matters for
    // a local document.
    expect(h.targets).toEqual([])
    expect(h.store.counts.captures).toBe(0)
  })

  it('reports a directory it cannot write to instead of throwing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-thumbnails-'))
    // A file where the directory should be: nothing can be created inside it.
    await writeFile(join(root, 'blocked'), 'not a directory', 'utf8')
    const h = await harness({ directory: join(root, 'blocked', 'thumbnails') })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(await h.store.capturerFor('normal').capture(request())).toEqual({
      kind: 'rejected',
      reason: 'write-failed'
    })
    // No index entry, because there is no file for it to describe.
    expect(h.store.list()).toEqual([])
    // And the reason is in the log with the page it was for. A directory that cannot be
    // written to fails for *every* page, and this line is what distinguishes that from one
    // capture going wrong — the counters cannot, they only say `write-failed` more often.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`[thumbnails] could not store the picture for ${PAGE_KEY}`),
      expect.anything()
    )
    warn.mockRestore()
  })

  it('keeps the previous picture when a later capture fails', async () => {
    const h = await harness({ maxAgeMs: 1_000 })
    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())

    h.tick(1_000)
    h.answer(() => Promise.resolve(null))
    const outcome = await capturer.capture(request())

    expect(outcome).toEqual({
      kind: 'kept',
      reason: 'capture-failed',
      entry: {
        url: PAGE_KEY,
        title: TITLE,
        width: 480,
        height: 300,
        byteLength: 7_000,
        capturedAt: T0
      }
    })
    // A tab closed a moment too early must not cost the card its picture, so both the
    // file and the entry stand.
    const bytes = new Uint8Array(await readFile(shotPath(h.directory, PAGE_KEY)))
    expect(bytes).toHaveLength(7_000)
    await h.store.flush()
    expect((await storedShots(h.directory)).at(0)?.capturedAt).toBe(T0)
    expect(h.store.counts.kept).toBe(1)
  })

  it('tries again on the next visit rather than once per run', async () => {
    // Deliberately unlike the favicon cache. That one gives a site a single chance per
    // run to spare a remote server; there is no server here, and the usual failure is a
    // page that had not painted — which the next attempt fixes.
    const h = await harness()
    h.answer(() => Promise.resolve(fakeImage(h.log, { empty: true })))
    await h.store.capturerFor('normal').capture(request())

    h.answer(() => Promise.resolve(fakeImage(h.log)))
    expect((await h.store.capturerFor('normal').capture(request())).kind).toBe('stored')
    expect(h.targets).toHaveLength(2)
  })
})

describe('bounding what is kept', () => {
  it('evicts the least recently captured page and deletes its picture', async () => {
    const h = await harness({ maxEntries: 1 })
    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())
    h.tick(1_000)
    await capturer.capture(request({ url: OTHER }))

    expect(h.store.list().map((shot) => shot.url)).toEqual([OTHER])
    // The file goes with the entry. For this kind of file, an index that forgot it —
    // and therefore could never delete it — is not a housekeeping detail.
    expect(existsSync(shotPath(h.directory, PAGE_KEY))).toBe(false)
    expect(existsSync(shotPath(h.directory, OTHER))).toBe(true)
  })

  it('drops the entry even when the file cannot be deleted', async () => {
    const h = await harness({ maxEntries: 1 })
    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())

    // A directory where the picture was: deletion fails, and the entry must still go.
    const path = shotPath(h.directory, PAGE_KEY)
    await rm(path)
    await mkdir(path)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    h.tick(1_000)
    await capturer.capture(request({ url: OTHER }))
    expect(h.store.list().map((shot) => shot.url)).toEqual([OTHER])
    // Reported, with the page it belonged to. Silence would leave a picture of the user's
    // screen on disk that nothing remembers — and therefore nothing, including "clear
    // data", can ever delete.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`[thumbnails] could not remove the picture for ${PAGE_KEY}`),
      expect.anything()
    )
    warn.mockRestore()
  })

  it('clears a picture whose file has already gone, without complaining', async () => {
    /*
      The ordinary case rather than an edge one: this directory is the kind the platform
      treats as discardable, so a user, a cleaner or the OS can remove a file the index
      still names. `rm` is asked with `force`, and without it every such deletion would log
      a warning about a file already in the state we wanted.

      A warning that fires in the common case is worse than none: it is the reason nobody
      reads the log on the day something real happens.
    */
    const h = await harness()
    await h.store.capturerFor('normal').capture(request())
    await rm(shotPath(h.directory, PAGE_KEY))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await h.store.clear()).toBe(1)
    expect(warn, warn.mock.calls.map(String).join(' | ')).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(h.store.list()).toEqual([])
  })

  it('clears every picture and the index, which is what clearing the cache does', async () => {
    const h = await harness()
    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())
    await capturer.capture(request({ url: OTHER }))

    expect(await h.store.clear()).toBe(2)
    expect(h.store.list()).toEqual([])
    expect(existsSync(shotPath(h.directory, PAGE_KEY))).toBe(false)
    expect(existsSync(shotPath(h.directory, OTHER))).toBe(false)

    // Awaited on purpose: work started at exit but not awaited runs into nothing.
    await h.store.flush()
    expect(await storedShots(h.directory)).toEqual([])
  })

  it('throws away a capture that finished after the data was cleared', async () => {
    const h = await harness()
    let release: (image: CapturedImage) => void = () => {}
    h.answer(() => new Promise<CapturedImage>((resolve) => (release = resolve)))

    const pending = h.store.capturerFor('normal').capture(request())
    expect(await h.store.clear()).toBe(0)
    release(fakeImage(h.log))

    // Without this, "clear data" has a hole exactly the width of one capture: the file
    // is written before the index entry, so a capture in flight would leave a picture
    // the clear had already walked past and an entry recreating it.
    expect(await pending).toEqual({ kind: 'rejected', reason: 'discarded' })
    expect(existsSync(shotPath(h.directory, PAGE_KEY))).toBe(false)
    expect(h.store.list()).toEqual([])
  })

  it('takes pictures again after a clear', async () => {
    const h = await harness()
    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())
    await h.store.clear()

    expect((await capturer.capture(request())).kind).toBe('stored')
    expect(existsSync(shotPath(h.directory, PAGE_KEY))).toBe(true)
  })
})

describe('a private window', () => {
  it('is handed a capturer that holds no store at all', async () => {
    const h = await harness()
    expect(h.store.capturerFor('private')).toBe(discardingThumbnailCapturer)
  })

  it('leaves nothing in the index, nothing on disk, and photographs nothing', async () => {
    const h = await harness()
    const capturer = h.store.capturerFor('private')

    expect(
      await capturer.capture({ url: 'https://secret.example/inbox', title: 'Inbox', viewId: 1 })
    ).toEqual({ kind: 'rejected', reason: 'private-mode' })
    expect(capturer.shouldCapture('https://secret.example/inbox')).toBe(false)

    expect(h.targets).toEqual([])
    expect(h.store.list()).toEqual([])
    // Not merely empty: the directory was never created, so there is no index file
    // recording which pages were open either.
    expect(existsSync(h.directory)).toBe(false)
    // And the store counted nothing, because it was never told — which is the invariant.
    expect(h.store.counts.captures).toBe(0)
    expect(h.store.counts.rejected['private-mode']).toBe(0)
  })

  it('does not stop a normal window photographing the same page', async () => {
    const h = await harness()
    await h.store.capturerFor('private').capture(request())
    expect((await h.store.capturerFor('normal').capture(request())).kind).toBe('stored')
    expect(h.targets).toHaveLength(1)
  })

  it('can still find a picture the store already has', async () => {
    // Reading leaves no trace and the protocol handler has no session to check, so
    // `find` is deliberately not behind `capturerFor` — the same division the favicon
    // cache makes. Whether a private start page should ask is a question about that page.
    const h = await harness()
    await h.store.capturerFor('normal').capture(request())
    expect(h.store.find(PAGE)?.entry.url).toBe(PAGE_KEY)
  })
})

describe('what the renderer and the handler ask for', () => {
  it('finds a page by any spelling of its address, and says where the bytes are', async () => {
    const h = await harness()
    await h.store.capturerFor('normal').capture(request())

    const found = h.store.find(`${PAGE}#section`)
    expect(found?.entry.title).toBe(TITLE)
    expect(found?.filePath).toBe(shotPath(h.directory, PAGE_KEY))
    expect(found?.contentType).toBe('image/jpeg')
    expect(h.store.find(OTHER)).toBeNull()
  })

  it('cannot be steered outside its own directory', async () => {
    const h = await harness()
    await h.store.capturerFor('normal').capture(request())
    // The key is compared against the index and only ever hashed into a file name, so a
    // crafted address finds nothing rather than finding a file elsewhere.
    expect(h.store.find('../../etc/passwd')).toBeNull()
    expect(h.store.find('')).toBeNull()
    expect(thumbnailFileName(PAGE_KEY)).toMatch(/^[0-9a-f]{32}\.shot$/)
    // Nothing of the address survives into the name: a directory listing is not a
    // reading list.
    expect(thumbnailFileName(PAGE_KEY)).not.toContain('example')
  })

  it('tells listeners when a picture arrives, until they unsubscribe', async () => {
    const h = await harness()
    const seen: number[] = []
    const unsubscribe = h.store.onChange((shots) => seen.push(shots.length))

    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())
    unsubscribe()
    await capturer.capture(request({ url: OTHER }))

    expect(seen).toEqual([1])
  })

  it('hands out copies, so a caller cannot edit the index', async () => {
    const h = await harness()
    await h.store.capturerFor('normal').capture(request())
    h.store.list().length = 0
    expect(h.store.list()).toHaveLength(1)

    const counts = h.store.counts
    counts.captures = 99
    counts.rejected.blank = 99
    expect(h.store.counts.captures).toBe(1)
    expect(h.store.counts.rejected.blank).toBe(0)
  })

  it('holds the settle delay the wiring waits out', async () => {
    const h = await harness()
    expect(h.store.settleDelayMs).toBe(THUMBNAIL_SETTLE_DELAY_MS)
    // Overridable, because the number is the whole "when" decision and there should be
    // one place to change it.
    const tuned = await harness({ settleDelayMs: 3_000 })
    expect(tuned.store.settleDelayMs).toBe(3_000)
  })
})

describe('on disk', () => {
  it('reads back what a previous run wrote, and photographs nothing', async () => {
    const h = await harness()
    await h.store.capturerFor('normal').capture(request())
    await h.store.flush()

    const targets: CaptureTarget[] = []
    const log: CameraLog = { crops: [], resizes: [], qualities: [] }
    const restarted = await ThumbnailStore.open({
      directory: h.directory,
      capture: (target) => {
        targets.push(target)
        return Promise.resolve(fakeImage(log))
      },
      now: () => T0,
      debounceMs: 0
    })

    expect(restarted.find(PAGE)?.entry.byteLength).toBe(7_000)
    expect((await restarted.capturerFor('normal').capture(request())).kind).toBe('fresh')
    expect(targets).toEqual([])
    expect(restarted.recoveredFromInvalidFile).toBe(false)
  })

  it('works through an injected codec', async () => {
    // The seam encryption at rest uses. The index names pages and their titles — the
    // same material the history file holds — so it belongs behind the same codec.
    const root = await mkdtemp(join(tmpdir(), 'tessera-thumbnails-'))
    const directory = join(root, 'thumbnails')
    const log: CameraLog = { crops: [], resizes: [], qualities: [] }
    const camera: PageCapturer = () => Promise.resolve(fakeImage(log))

    const store = await ThumbnailStore.open({
      directory,
      capture: camera,
      codec: plainJsonDocumentCodec,
      debounceMs: 0
    })
    await store.capturerFor('normal').capture(request())
    await store.flush()

    const restarted = await ThumbnailStore.open({
      directory,
      capture: camera,
      codec: plainJsonDocumentCodec,
      debounceMs: 0
    })
    expect(restarted.list()).toHaveLength(1)
  })

  it('puts the codec between the pages it names and the disk, not beside it', async () => {
    /*
      The test above passes the *plain* codec, so the file is byte-identical whether the
      store forwards the codec or drops it on the way to `JsonStore`. This one uses a codec
      whose output cannot be mistaken for JSON.

      The index holds page addresses and their titles — the same material as the history
      file — beside picture files deliberately named after hashes so that a directory
      listing is not a reading list. Dropped, the addresses would be the one plainly
      readable thing in a directory built to avoid exactly that.
    */
    const root = await mkdtemp(join(tmpdir(), 'tessera-thumbnails-'))
    const directory = join(root, 'thumbnails')
    const log: CameraLog = { crops: [], resizes: [], qualities: [] }
    const camera: PageCapturer = () => Promise.resolve(fakeImage(log))

    const store = await ThumbnailStore.open({
      directory,
      capture: camera,
      codec: sealingCodec(),
      debounceMs: 0
    })
    await store.capturerFor('normal').capture(request())
    await store.flush()

    const raw = await readFile(join(directory, 'index.json'), 'utf8')
    expect(raw.startsWith('sealed:'), raw.slice(0, 40)).toBe(true)
    expect(raw).not.toContain('example.com')

    const restarted = await ThumbnailStore.open({
      directory,
      capture: camera,
      codec: sealingCodec(),
      debounceMs: 0
    })
    expect(restarted.list().map((shot) => shot.url)).toEqual([PAGE_KEY])
  })

  it('uses the coalescing window it was given, not the default one', async () => {
    /*
      `debounceMs: 0` means "write on every change", and `JsonStore` honours it without a
      timer at all. A store that dropped the option would fall back to 250 ms and still pass
      every other test here, because they all call `flush` first — so nothing would notice
      that a caller asking for an immediate write got a coalesced one, which at exit is the
      difference between the newest entries being in the index and being lost.

      The observable is that no timer was scheduled, not how soon the file appears. An
      earlier version installed fake timers and spun the event loop a hundred times waiting
      for the file — a wall-clock budget in disguise, which passed on its own and failed in a
      full run, where a queued write does not get its turn that soon.
    */
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    try {
      const h = await harness()
      // `open` is not what this is about; only the write the capture triggers.
      scheduled.mockClear()
      await h.store.capturerFor('normal').capture(request())
      expect(scheduled, 'the write was put behind a timer').not.toHaveBeenCalled()

      // Awaited on the store's own queue: the write is already on it, so this resolves once
      // *that* write is on disk rather than starting a second one.
      await h.store.flush()
      expect(await readFile(join(h.directory, 'index.json'), 'utf8')).toContain(PAGE)
    } finally {
      scheduled.mockRestore()
    }
  })

  it('writes the picture readable by nobody else', async () => {
    /*
      Skipped on Windows, which has no POSIX mode: `fs.stat` there reports `0o666` whatever was passed to
      `writeFile`, so this assertion could only ever fail — and it did, in a release workflow, which is how
      a build with no `.exe` came to exist. The requirement is not skipped, only this way of checking it:
      on Windows the file inherits the ACL of the user's profile directory, which is what the mode achieves
      here. What must not happen is deleting the assertion because one platform cannot see it.
    */
    if (process.platform === 'win32') return
    /*
      `0o600` is passed explicitly and this is what asks for it. A thumbnail is a
      photograph of the user's screen — an inbox, a bank statement, whatever was open — and
      the default mode would be `0644`, so on a shared machine every other account could
      look through them. The file names are hashes for the same reason; mode and name are
      two halves of one decision and only one of them was asserted.
    */
    const h = await harness()
    await h.store.capturerFor('normal').capture(request())

    const mode = (await stat(shotPath(h.directory, PAGE_KEY))).mode & 0o777
    expect(mode.toString(8)).toBe('600')
  })

  it('uses the real clock and the default debounce when neither is given', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-thumbnails-'))
    const directory = join(root, 'thumbnails')
    const log: CameraLog = { crops: [], resizes: [], qualities: [] }
    const before = Date.now()

    const store = await ThumbnailStore.open({
      directory,
      capture: () => Promise.resolve(fakeImage(log))
    })
    await store.capturerFor('normal').capture(request())

    const entry = store.list().at(0)
    expect(entry?.capturedAt).toBeGreaterThanOrEqual(before)
    expect(entry?.capturedAt).toBeLessThanOrEqual(Date.now())

    // `flush` exists so a pending debounced write can be forced and awaited.
    await store.flush()
    expect(await storedShots(directory)).toHaveLength(1)
  })

  it('merges duplicate entries a hand-edited index left behind', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-thumbnails-'))
    const directory = join(root, 'thumbnails')
    await mkdir(directory, { recursive: true })
    await writeFile(
      join(directory, 'index.json'),
      JSON.stringify({
        version: 1,
        shots: [
          { url: PAGE_KEY, title: 'Older', width: 480, height: 300, byteLength: 10, capturedAt: T0 },
          { url: PAGE_KEY, title: 'Newer', width: 480, height: 300, byteLength: 20, capturedAt: T0 + 5 }
        ]
      }),
      'utf8'
    )

    const log: CameraLog = { crops: [], resizes: [], qualities: [] }
    const store = await ThumbnailStore.open({
      directory,
      capture: () => Promise.resolve(fakeImage(log)),
      debounceMs: 0
    })
    // The newer entry wins: both name the same file, and the newer picture has already
    // overwritten it.
    expect(store.list().map((shot) => shot.title)).toEqual(['Newer'])
    expect(store.recoveredFromInvalidFile).toBe(false)
  })

  it('starts from an empty index when the file is not ours', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tessera-thumbnails-'))
    const directory = join(root, 'thumbnails')
    await mkdir(directory, { recursive: true })
    // Dimensions no write path here could have produced. Discarding the index costs one
    // local capture per page and nothing the user typed, which is why the schema is
    // free to be strict about amounts as well as kinds.
    await writeFile(
      join(directory, 'index.json'),
      JSON.stringify({
        version: 1,
        shots: [
          { url: PAGE_KEY, title: 'Huge', width: 3840, height: 2160, byteLength: 20, capturedAt: T0 }
        ]
      }),
      'utf8'
    )

    const log: CameraLog = { crops: [], resizes: [], qualities: [] }
    const store = await ThumbnailStore.open({
      directory,
      capture: () => Promise.resolve(fakeImage(log)),
      now: () => T0,
      debounceMs: 0
    })
    expect(store.list()).toEqual([])
    expect(store.recoveredFromInvalidFile).toBe(true)
    // And the recovered store is usable, not wedged.
    expect((await store.capturerFor('normal').capture(request())).kind).toBe('stored')
  })

  it('gives two pages two files', async () => {
    const h = await harness()
    const capturer = h.store.capturerFor('normal')
    await capturer.capture(request())
    await capturer.capture(request({ url: OTHER }))

    expect(thumbnailFileName(PAGE_KEY)).not.toBe(thumbnailFileName(OTHER))
    expect(existsSync(shotPath(h.directory, PAGE_KEY))).toBe(true)
    expect(existsSync(shotPath(h.directory, OTHER))).toBe(true)
    expect(h.store.list()).toHaveLength(2)
  })
})

describe('the camera seam', () => {
  it('is satisfied by an Electron NativeImage, with no mock in sight', () => {
    /*
      A type-level check, and the only place `electron` is named in this file — as a
      type, so nothing loads a browser process. `webContents.capturePage()` resolves to
      a `NativeImage`, and if its shape ever stops fitting the seam this stops
      compiling, which is exactly when we want to hear about it rather than at runtime
      in a packaged build.
    */
    const seam: CapturedImage = null as unknown as NativeImage
    expect(seam).toBeNull()
  })

  it('has no fallback to a camera that would photograph the wrong window', async () => {
    /*
      A fitness function, not a behaviour test. The alternative to the injected provider
      is reaching for `webContents` from inside the store — which would tie a data
      module to Electron, make every test start a browser process, and put the choice of
      *which* view is photographed somewhere that cannot know whether that view still
      shows the page it was asked about. An optional parameter with a fallback would
      make the wrong version the one you get by forgetting. The type system already
      refuses a missing provider; this refuses a default being added later.
    */
    const source = await readFile(join(process.cwd(), 'src/main/data/ThumbnailStore.ts'), 'utf8')
    const code = source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

    expect(code, 'the camera is optional').not.toMatch(/capture\?\s*:/)
    expect(code, 'the camera has a default').not.toMatch(/\?\?\s*[\w.]*[Cc]apture/)
    expect(code, 'the store reaches for Electron').not.toMatch(/from\s+'electron'/)
    expect(code, 'the store knows about web contents').not.toMatch(/webContents/)
    expect(code, 'the store calls capturePage itself').not.toMatch(/capturePage/)
  })
})
