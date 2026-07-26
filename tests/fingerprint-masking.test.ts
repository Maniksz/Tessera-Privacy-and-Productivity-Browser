import { createContext, Script } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  maskAudio,
  maskCanvas,
  maskDeviceApis,
  maskFonts,
  maskLocale,
  maskScreen,
  maskTimeZone,
  maskUserAgent,
  maskWebgl
} from '@shared/fingerprint/apply.js'
import { maskingPlanFor, type MaskingPlan } from '@shared/fingerprint/plan.js'
import { defaultSettings } from '@shared/settings/definitions.js'

/**
 * The masking as the page sees it (spec 4).
 *
 * These tests fabricate a page — a `navigator` with its accessors on a prototype, a
 * canvas that really stores pixels, an audio buffer that really hands out samples —
 * and then measure it the way a fingerprinting script would. That is the only way
 * to test the claim that matters: **the same measurement gives the same answer**,
 * however often it is taken and whichever route it takes.
 *
 * The last block tests something else entirely: that each function survives being
 * turned into source text and compiled somewhere else, which is what
 * `contextBridge.executeInMainWorld` does to it. A reference to anything outside
 * the function would pass every other test here and throw `ReferenceError` in a
 * real page.
 */

const PLAN: MaskingPlan = (() => {
  const plan = maskingPlanFor({
    settings: defaultSettings(),
    profileSecret: 'secret-one',
    host: 'example.com',
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'tessera/0.1.0 Chrome/150.0.7871.129 Electron/43.2.0 Safari/537.36'
  })
  if (plan === null) throw new Error('the default settings must produce a plan')
  return plan
})()

/** Non-null accessors, so each test reads like the page code it stands in for. */
function planPart<K extends keyof MaskingPlan>(key: K): NonNullable<MaskingPlan[K]> {
  const value = PLAN[key]
  if (value === null) throw new Error(`the default plan must contain ${key}`)
  return value
}

/** Properties the masking defines on the global object itself. */
const GLOBAL_KEYS = [
  'screenX',
  'screenY',
  'screenLeft',
  'screenTop',
  'outerWidth',
  'outerHeight',
  'innerWidth',
  'innerHeight'
]

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of GLOBAL_KEYS) Reflect.deleteProperty(globalThis, key)
})

// --- fabricated page --------------------------------------------------------

/**
 * A `navigator` shaped like the real one: every value behind an accessor on the
 * prototype, nothing as an own property of the instance.
 */
function fakeNavigator(): Record<string, unknown> {
  const prototype: Record<string, unknown> = {}
  const accessor = (key: string, value: unknown): void => {
    Object.defineProperty(prototype, key, {
      get: () => value,
      configurable: true,
      enumerable: true
    })
  }

  accessor('userAgent', 'real-agent Chrome/150.0.7871.129 Electron/43.2.0')
  accessor('appVersion', '5.0 (Macintosh)')
  accessor('platform', 'MacIntel')
  accessor('vendor', 'Apple Computer, Inc.')
  accessor('userAgentData', { brands: [], mobile: false, platform: 'macOS' })
  accessor('language', 'de-DE')
  accessor('languages', Object.freeze(['de-DE', 'de', 'en']))
  accessor('hardwareConcurrency', 16)
  accessor('deviceMemory', 32)
  accessor('maxTouchPoints', 5)
  accessor('connection', { effectiveType: '3g', rtt: 300, downlink: 1.4, saveData: true })
  accessor('usb', { requestDevice: () => undefined })
  accessor('serial', {})
  accessor('hid', {})
  accessor('bluetooth', {})
  prototype['getBattery'] = (): Promise<unknown> => Promise.resolve({ level: 0.37 })
  prototype['getGamepads'] = (): unknown[] => [{ id: 'a real gamepad' }]

  const navigator: Record<string, unknown> = Object.create(prototype)
  navigator['mediaDevices'] = {
    enumerateDevices: (): Promise<unknown[]> =>
      Promise.resolve([{ deviceId: 'camera', label: 'FaceTime HD' }])
  }
  navigator['storage'] = {
    estimate: (): Promise<unknown> => Promise.resolve({ quota: 499_963_174_912, usage: 4096 })
  }
  return navigator
}

interface FakeImage {
  readonly width: number
  readonly height: number
  readonly data: Uint8ClampedArray
}

/**
 * A canvas that really stores pixels, so a read after an export can be compared
 * against a direct read. Fresh classes per call: the masking replaces prototype
 * members, and a shared prototype would carry one test's patches into the next.
 */
function fakeCanvasWorld() {
  class Context {
    constructor(readonly canvas: Canvas) {}

    getImageData(left: number, top: number, width: number, height: number): FakeImage {
      // Negative extents are legal and mean the rectangle grows the other way; the
      // real implementation normalises them, so the fake has to as well or the
      // masking would be measured against a rectangle nobody reads.
      if (width < 0) {
        left += width
        width = -width
      }
      if (height < 0) {
        top += height
        height = -height
      }
      const data = new Uint8ClampedArray(width * height * 4)
      for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
          const from = ((top + row) * this.canvas.width + (left + column)) * 4
          const to = (row * width + column) * 4
          for (let channel = 0; channel < 4; channel++) {
            data[to + channel] = this.canvas.pixels[from + channel] ?? 0
          }
        }
      }
      return { width, height, data }
    }

    putImageData(image: FakeImage, left: number, top: number): void {
      for (let row = 0; row < image.height; row++) {
        for (let column = 0; column < image.width; column++) {
          const from = (row * image.width + column) * 4
          const to = ((top + row) * this.canvas.width + (left + column)) * 4
          for (let channel = 0; channel < 4; channel++) {
            this.canvas.pixels[to + channel] = image.data[from + channel] ?? 0
          }
        }
      }
    }

    drawImage(source: Canvas): void {
      this.canvas.pixels.set(source.pixels)
    }
  }

  class Canvas {
    #width = 0
    #height = 0
    pixels = new Uint8ClampedArray(0)
    readonly context = new Context(this)

    get width(): number {
      return this.#width
    }
    set width(value: number) {
      this.#width = value
      this.#allocate()
    }
    get height(): number {
      return this.#height
    }
    set height(value: number) {
      this.#height = value
      this.#allocate()
    }

    #allocate(): void {
      const size = this.#width * this.#height * 4
      if (this.pixels.length !== size) this.pixels = new Uint8ClampedArray(size)
    }

    getContext(kind: string): Context | null {
      return kind === '2d' ? this.context : null
    }

    toDataURL(): string {
      return `data:${[...this.pixels].join(',')}`
    }

    toBlob(callback: (value: string) => void): void {
      callback(`blob:${[...this.pixels].join(',')}`)
    }
  }

  /** A gradient rather than a flat fill, so clamping at 0 and 255 is exercised. */
  const painted = (width: number, height: number): Canvas => {
    const canvas = new Canvas()
    canvas.width = width
    canvas.height = height
    for (let index = 0; index < canvas.pixels.length; index += 4) {
      const pixel = index / 4
      canvas.pixels[index] = pixel % 256
      canvas.pixels[index + 1] = 255
      canvas.pixels[index + 2] = 0
      canvas.pixels[index + 3] = 255
    }
    return canvas
  }

  return { Canvas, Context, painted }
}

function stubCanvasWorld(world: ReturnType<typeof fakeCanvasWorld>): void {
  vi.stubGlobal('HTMLCanvasElement', world.Canvas)
  vi.stubGlobal('CanvasRenderingContext2D', world.Context)
  vi.stubGlobal('document', {
    createElement: (tag: string): unknown => (tag === 'canvas' ? new world.Canvas() : null)
  })
}

// --- identity ---------------------------------------------------------------

describe('maskUserAgent', () => {
  it('replaces the string, the platform and the vendor', () => {
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskUserAgent(planPart('userAgent'))

    expect(navigator['userAgent']).toBe(planPart('userAgent').userAgent)
    expect(navigator['userAgent']).not.toMatch(/Electron/)
    expect(navigator['appVersion']).toBe(planPart('userAgent').userAgent.replace(/^Mozilla\//, ''))
    expect(navigator['platform']).toBe('Win32')
    expect(navigator['vendor']).toBe('Google Inc.')
  })

  it('patches the prototype, leaving no own property to notice', () => {
    // A real `navigator` has none of these as own properties; adding one would be a
    // tell in exchange for nothing.
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskUserAgent(planPart('userAgent'))
    expect(Object.getOwnPropertyNames(navigator)).not.toContain('userAgent')
  })

  it('reports the same machine through userAgentData as through the string', async () => {
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskUserAgent(planPart('userAgent'))

    const data = navigator['userAgentData'] as {
      brands: Array<{ brand: string; version: string }>
      mobile: boolean
      platform: string
      toJSON: () => unknown
      getHighEntropyValues: (hints?: unknown) => Promise<Record<string, unknown>>
    }
    expect(data.platform).toBe('Windows')
    expect(data.mobile).toBe(false)
    expect(data.brands.map((entry) => entry.brand)).toContain('Chromium')
    expect(data.toJSON()).toEqual({ brands: data.brands, mobile: false, platform: 'Windows' })

    const high = await data.getHighEntropyValues(['architecture', 'platformVersion', 'model'])
    expect(high['architecture']).toBe('x86')
    expect(high['platformVersion']).toBe('10.0.0')
    expect(high['model']).toBe('')
    // The low-entropy values come back either way, as they do in Chrome.
    expect(high['platform']).toBe('Windows')

    const unasked = await data.getHighEntropyValues()
    expect(
      unasked['architecture'],
      'a hint nobody asked for must not be volunteered'
    ).toBeUndefined()
    expect(unasked['platform']).toBe('Windows')

    const ignored = await data.getHighEntropyValues(['nonsense'])
    expect(ignored['nonsense']).toBeUndefined()
  })

  it('leaves a page with no navigator alone', () => {
    vi.stubGlobal('navigator', undefined)
    expect(() => maskUserAgent(planPart('userAgent'))).not.toThrow()
  })

  it('leaves a property that refuses to be redefined in place', () => {
    // Better a value unmasked than a page that fails to load.
    const navigator: Record<string, unknown> = {}
    Object.defineProperty(navigator, 'userAgent', { value: 'immutable', configurable: false })
    vi.stubGlobal('navigator', navigator)
    expect(() => maskUserAgent(planPart('userAgent'))).not.toThrow()
    expect(navigator['userAgent']).toBe('immutable')
  })
})

describe('maskLocale', () => {
  it('reports the language the Accept-Language header carries', () => {
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskLocale(planPart('locale'))
    expect(navigator['language']).toBe('en-US')
    expect(navigator['languages']).toEqual(['en-US', 'en'])
  })

  it('hands out a fresh frozen list, so one reader cannot change the next', () => {
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskLocale(planPart('locale'))
    const first = navigator['languages'] as string[]
    expect(Object.isFrozen(first)).toBe(true)
    expect(navigator['languages']).not.toBe(first)
    expect(navigator['languages']).toEqual(first)
  })

  it('leaves a page with no navigator alone', () => {
    vi.stubGlobal('navigator', undefined)
    expect(() => maskLocale(planPart('locale'))).not.toThrow()
  })

  it('defines the values on a navigator that has none', () => {
    // Nothing may depend on the property already existing to be replaced.
    const navigator: Record<string, unknown> = {}
    vi.stubGlobal('navigator', navigator)
    maskLocale(planPart('locale'))
    expect(navigator['language']).toBe('en-US')
    expect(navigator['languages']).toEqual(['en-US', 'en'])
  })
})

// --- canvas -----------------------------------------------------------------

describe('maskCanvas', () => {
  it('gives the same bytes for the same read, every time', () => {
    // The requirement itself. Noise that varied per call would make a site that
    // reads twice better off than one that reads once.
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    const canvas = world.painted(40, 8)
    maskCanvas(planPart('canvas'))

    const first = canvas.context.getImageData(0, 0, 40, 8)
    for (let attempt = 0; attempt < 20; attempt++) {
      expect([...canvas.context.getImageData(0, 0, 40, 8).data]).toEqual([...first.data])
    }
  })

  it('gives overlapping reads the same answer for the same pixels', () => {
    // The perturbation is a function of the absolute position, so a script cannot
    // shift the rectangle and diff the results.
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    const canvas = world.painted(400, 4)
    maskCanvas({ deltas: [3, -2, 1, 0, -3, 2], stride: 3, offset: 1 })

    const whole = canvas.context.getImageData(0, 0, 400, 4)
    const part = canvas.context.getImageData(120, 1, 60, 2)
    for (let row = 0; row < 2; row++) {
      for (let column = 0; column < 60; column++) {
        const fromWhole = ((1 + row) * 400 + (120 + column)) * 4
        const fromPart = (row * 60 + column) * 4
        expect([...whole.data.slice(fromWhole, fromWhole + 4)]).toEqual([
          ...part.data.slice(fromPart, fromPart + 4)
        ])
      }
    }
  })

  it('changes a fingerprinting-sized read, and leaves alpha alone', () => {
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    // The size the canvas fingerprinting scripts in the wild actually use.
    const canvas = world.painted(280, 60)
    const before = [...canvas.context.getImageData(0, 0, 280, 60).data]
    maskCanvas(planPart('canvas'))
    const after = [...canvas.context.getImageData(0, 0, 280, 60).data]

    expect(after, 'the production stride must still perturb a typical probe').not.toEqual(before)
    const changed = after.filter((value, index) => value !== before[index])
    expect(changed.length).toBeGreaterThan(0)
    for (let index = 3; index < after.length; index += 4) {
      // Alpha is visible through any composite; colour noise is not.
      expect(after[index], `alpha at ${index} changed`).toBe(before[index])
    }
  })

  it('exports the same pixels it reads out', () => {
    // A `toDataURL` that disagreed with `getImageData` would be a contradiction a
    // script could measure in two lines.
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    // Wide enough that the production stride perturbs every row, which is what a
    // fingerprinting probe looks like.
    const canvas = world.painted(280, 8)
    const unmasked = canvas.toDataURL()
    maskCanvas(planPart('canvas'))

    const read = canvas.context.getImageData(0, 0, 280, 8)
    const exported = canvas.toDataURL()
    expect(exported).toBe(`data:${[...read.data].join(',')}`)
    expect(exported).not.toBe(unmasked)
    expect(canvas.toDataURL(), 'exporting twice must not drift').toBe(exported)
  })

  it('leaves the canvas it exported untouched', () => {
    // Perturbing the original in place is cheaper and means an application that
    // draws, exports and draws again accumulates the damage.
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    const canvas = world.painted(16, 2)
    const before = [...canvas.pixels]
    maskCanvas(planPart('canvas'))
    canvas.toDataURL()
    expect([...canvas.pixels]).toEqual(before)
  })

  it('masks toBlob the same way', () => {
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    const canvas = world.painted(280, 8)
    let unmasked = ''
    canvas.toBlob((value) => {
      unmasked = value
    })
    maskCanvas(planPart('canvas'))
    let masked = ''
    canvas.toBlob((value) => {
      masked = value
    })
    expect(masked).not.toBe(unmasked)
    expect(masked.startsWith('blob:')).toBe(true)
  })

  it('exports exactly what it would have when the copy cannot be made', () => {
    // A canvas holding cross-origin pixels throws when read; a zero-sized one throws
    // on getImageData; an exotic embedding may have no working `createElement` at
    // all. Every one of those must still export the real result rather than fail.
    const cripple: ReadonlyArray<readonly [string, unknown]> = [
      ['no document', undefined],
      ['no element', { createElement: (): unknown => null }],
      ['no context', { createElement: (): unknown => ({ width: 0, height: 0 }) }],
      [
        'a context that is not a canvas context',
        { createElement: (): unknown => ({ width: 0, height: 0, getContext: () => null }) }
      ],
      [
        'a context with no pixel access',
        { createElement: (): unknown => ({ width: 0, height: 0, getContext: () => ({}) }) }
      ]
    ]

    for (const [what, document] of cripple) {
      const world = fakeCanvasWorld()
      stubCanvasWorld(world)
      vi.stubGlobal('document', document)
      const canvas = world.painted(280, 2)
      const unmasked = canvas.toDataURL()
      maskCanvas(planPart('canvas'))
      expect(canvas.toDataURL(), what).toBe(unmasked)
    }
  })

  it('leaves a canvas element that cannot export anything alone', () => {
    const bare = { prototype: {} }
    vi.stubGlobal('HTMLCanvasElement', bare)
    vi.stubGlobal('CanvasRenderingContext2D', undefined)
    expect(() => maskCanvas(planPart('canvas'))).not.toThrow()
    expect(Object.getOwnPropertyNames(bare.prototype)).not.toContain('toDataURL')
  })

  it('leaves a read it cannot interpret exactly as it found it', () => {
    // Defensive about the shape of what the real API handed back: a read that
    // returns nothing, or claims more pixels than it delivered, must come through
    // unchanged rather than throw inside a page's first statement.
    class Context {
      getImageData(_left: number, _top: number, width: number): unknown {
        return width === 0 ? null : { width: 400, height: 4, data: new Uint8ClampedArray(8) }
      }
    }
    vi.stubGlobal('CanvasRenderingContext2D', Context)
    vi.stubGlobal('HTMLCanvasElement', undefined)
    maskCanvas({ deltas: [7, -7, 4], stride: 2, offset: 0 })

    const context = new Context()
    expect(context.getImageData(0, 0, 0)).toBeNull()
    const truncated = context.getImageData(0, 0, 400) as { data: Uint8ClampedArray }
    expect(truncated.data.length).toBe(8)
  })

  it('survives a page with no canvas at all', () => {
    vi.stubGlobal('HTMLCanvasElement', undefined)
    vi.stubGlobal('CanvasRenderingContext2D', undefined)
    vi.stubGlobal('OffscreenCanvasRenderingContext2D', undefined)
    expect(() => maskCanvas(planPart('canvas'))).not.toThrow()
  })

  it('normalises a rectangle given with negative extents', () => {
    // Legal per the specification, and the position arithmetic has to agree with
    // the equivalent positive rectangle or the two reads would differ.
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    const canvas = world.painted(40, 8)
    maskCanvas({ deltas: [5, -5, 3], stride: 2, offset: 0 })
    const forwards = canvas.context.getImageData(10, 2, 8, 4)
    const backwards = canvas.context.getImageData(18, 6, -8, -4)
    expect([...backwards.data]).toEqual([...forwards.data])
  })

  it('ignores a read whose rectangle is not a number', () => {
    const world = fakeCanvasWorld()
    stubCanvasWorld(world)
    const canvas = world.painted(8, 2)
    maskCanvas(planPart('canvas'))
    const image = canvas.context.getImageData(Number.NaN, 0, 8, 2)
    expect(image.data.length).toBe(64)
  })
})

// --- WebGL ------------------------------------------------------------------

describe('maskWebgl', () => {
  it('answers the GPU questions with the uniform machine and passes the rest through', () => {
    class Gl {
      getParameter(parameter: number): string {
        return `real-${parameter}`
      }
    }
    vi.stubGlobal('WebGLRenderingContext', Gl)
    vi.stubGlobal('WebGL2RenderingContext', undefined)
    maskWebgl(planPart('webgl'))

    const gl = new Gl()
    const plan = planPart('webgl')
    expect(gl.getParameter(0x1f00)).toBe(plan.vendor)
    expect(gl.getParameter(0x1f01)).toBe(plan.renderer)
    // The real device only ever appears through the debug extension.
    expect(gl.getParameter(0x9245)).toBe(plan.unmaskedVendor)
    expect(gl.getParameter(0x9246)).toBe(plan.unmaskedRenderer)
    expect(gl.getParameter(0x0d33)).toBe('real-3379')
  })

  it('survives a page with no WebGL', () => {
    vi.stubGlobal('WebGLRenderingContext', undefined)
    vi.stubGlobal('WebGL2RenderingContext', undefined)
    expect(() => maskWebgl(planPart('webgl'))).not.toThrow()
  })
})

// --- audio ------------------------------------------------------------------

function fakeAudioWorld() {
  class Buffer {
    readonly channels: Float32Array[]
    constructor(samples: readonly number[]) {
      this.channels = [new Float32Array(samples), new Float32Array(samples)]
    }
    getChannelData(channel: number): Float32Array {
      return this.channels[channel] ?? new Float32Array(0)
    }
    copyFromChannel(destination: Float32Array, channel: number): void {
      destination.set(this.channels[channel] ?? new Float32Array(0))
    }
  }

  class Analyser {
    constructor(private readonly base: readonly number[]) {}
    getFloatFrequencyData(target: Float32Array): void {
      target.set(this.base)
    }
    getFloatTimeDomainData(target: Float32Array): void {
      target.set(this.base)
    }
  }

  return { Buffer, Analyser }
}

describe('maskAudio', () => {
  const base = [0.25, -0.5, 0.75, -1, 0.125, 0.5]

  it('perturbs a buffer once, so every later read agrees with the first', () => {
    // The rendered buffer is the fingerprint. Shifting it again on each read would
    // make two reads disagree — the exact tell this is meant to remove.
    const world = fakeAudioWorld()
    vi.stubGlobal('AudioBuffer', world.Buffer)
    vi.stubGlobal('AnalyserNode', undefined)
    const buffer = new world.Buffer(base)
    const plan = planPart('audio')
    maskAudio(plan)

    const first = [...buffer.getChannelData(0)]
    expect([...buffer.getChannelData(0)]).toEqual(first)
    expect([...buffer.getChannelData(0)]).toEqual(first)

    for (let index = 0; index < base.length; index++) {
      const expected = base[index]! + plan.deltas[index % plan.deltas.length]! * plan.scale
      expect(first[index], `sample ${index}`).toBeCloseTo(expected, 7)
    }
  })

  it('actually changes the samples', () => {
    const world = fakeAudioWorld()
    vi.stubGlobal('AudioBuffer', world.Buffer)
    vi.stubGlobal('AnalyserNode', undefined)
    const buffer = new world.Buffer(base)
    maskAudio(planPart('audio'))
    expect([...buffer.getChannelData(0)]).not.toEqual(base)
  })

  it('gives copyFromChannel the same samples as getChannelData', () => {
    const world = fakeAudioWorld()
    vi.stubGlobal('AudioBuffer', world.Buffer)
    vi.stubGlobal('AnalyserNode', undefined)
    const buffer = new world.Buffer(base)
    maskAudio(planPart('audio'))

    // Channel 1 is copied before it has ever been read, so the copy path has to
    // perturb it itself — otherwise the two routes would disagree.
    const copy = new Float32Array(base.length)
    buffer.copyFromChannel(copy, 1)
    expect([...copy]).toEqual([...buffer.getChannelData(1)])
    const again = new Float32Array(base.length)
    buffer.copyFromChannel(again, 1)
    expect([...again]).toEqual([...copy])
  })

  it('perturbs each channel independently of the others', () => {
    const world = fakeAudioWorld()
    vi.stubGlobal('AudioBuffer', world.Buffer)
    vi.stubGlobal('AnalyserNode', undefined)
    const buffer = new world.Buffer(base)
    maskAudio(planPart('audio'))
    expect([...buffer.getChannelData(0)]).toEqual([...buffer.getChannelData(1)])
  })

  it('perturbs the analyser output deterministically', () => {
    const world = fakeAudioWorld()
    vi.stubGlobal('AudioBuffer', undefined)
    vi.stubGlobal('AnalyserNode', world.Analyser)
    const analyser = new world.Analyser(base)
    maskAudio(planPart('audio'))

    const frequency = new Float32Array(base.length)
    analyser.getFloatFrequencyData(frequency)
    const again = new Float32Array(base.length)
    analyser.getFloatFrequencyData(again)
    expect([...again]).toEqual([...frequency])
    expect([...frequency]).not.toEqual(base)

    const timeDomain = new Float32Array(base.length)
    analyser.getFloatTimeDomainData(timeDomain)
    expect([...timeDomain]).toEqual([...frequency])
  })

  it('lets a call with an unexpected shape through untouched', () => {
    // The perturbation is remembered per buffer in a WeakMap, which refuses a
    // primitive key; and a channel that hands back no samples has nothing to shift.
    // Neither may throw inside a page's first statement.
    class OddBuffer {
      getChannelData(channel: number): unknown {
        return channel === 0 ? undefined : new Float32Array([0.5])
      }
    }
    vi.stubGlobal('AudioBuffer', OddBuffer)
    vi.stubGlobal('AnalyserNode', undefined)
    maskAudio(planPart('audio'))

    const buffer = new OddBuffer()
    expect(buffer.getChannelData(0)).toBeUndefined()
    const detached = OddBuffer.prototype.getChannelData
    expect(() => Reflect.apply(detached, null, [0])).not.toThrow()
  })

  it('survives a page with no audio API, and one with only half of it', () => {
    vi.stubGlobal('AudioBuffer', undefined)
    vi.stubGlobal('AnalyserNode', undefined)
    expect(() => maskAudio(planPart('audio'))).not.toThrow()

    const halfBuffer = { prototype: {} }
    class HalfAnalyser {
      getFloatFrequencyData(target: Float32Array): void {
        target.set([1, 2])
      }
    }
    vi.stubGlobal('AudioBuffer', halfBuffer)
    vi.stubGlobal('AnalyserNode', HalfAnalyser)
    expect(() => maskAudio(planPart('audio'))).not.toThrow()
    expect(Object.getOwnPropertyNames(HalfAnalyser.prototype)).not.toContain(
      'getFloatTimeDomainData'
    )
  })
})

// --- fonts ------------------------------------------------------------------

describe('maskFonts', () => {
  function fakeFonts() {
    class FontFaceSet {
      check(_font: string, _text?: string): boolean {
        // The unmasked answer: this machine has every font ever made.
        return true
      }
      forEach(callback: (face: { family: string }) => void): void {
        callback({ family: '"My Web Font"' })
      }
    }
    return new FontFaceSet()
  }

  function checkWith(font: unknown): unknown {
    const fonts = fakeFonts()
    vi.stubGlobal('document', { fonts })
    maskFonts(planPart('fonts'))
    return (fonts as unknown as { check: (value: unknown) => unknown }).check(font)
  }

  it('admits the fonts of the claimed platform', () => {
    expect(checkWith('12px Arial')).toBe(true)
    expect(checkWith('12px "Segoe UI"')).toBe(true)
    expect(checkWith('italic bold 12px/1.5 "Times New Roman", serif')).toBe(true)
  })

  it('denies a font that is installed but should not be detectable', () => {
    // An installed-font list is close to a serial number, so the answer is no even
    // when the honest answer is yes.
    expect(checkWith('12px "Helvetica Neue"')).toBe(false)
    expect(checkWith('16px SomeCorporateFont')).toBe(false)
  })

  it('admits the generic families, which are never a real face', () => {
    expect(checkWith('12px monospace')).toBe(true)
    expect(checkWith('12px system-ui')).toBe(true)
  })

  it('admits a font the page loaded itself', () => {
    // A page has to be able to tell whether its own web font arrived.
    expect(checkWith('12px "My Web Font"')).toBe(true)
  })

  it('leaves a specification it cannot parse to the real implementation', () => {
    // The real one throws on an invalid shorthand, and answering anyway would be a
    // difference a script could test for.
    expect(checkWith('bold')).toBe(true)
    expect(checkWith('12px')).toBe(true)
    expect(checkWith(42)).toBe(true)
  })

  it('patches the prototype rather than the instance', () => {
    const fonts = fakeFonts()
    vi.stubGlobal('document', { fonts })
    maskFonts(planPart('fonts'))
    expect(Object.getOwnPropertyNames(fonts)).not.toContain('check')
  })

  it('copes with a font set that cannot be iterated', () => {
    const fonts = { check: (): boolean => true }
    vi.stubGlobal('document', { fonts })
    maskFonts(planPart('fonts'))
    expect((fonts as { check: (font: string) => boolean }).check('12px Arial')).toBe(true)
    expect((fonts as { check: (font: string) => boolean }).check('12px Nope')).toBe(false)
  })

  it('survives a page with no font set, or one with no check to replace', () => {
    vi.stubGlobal('document', {})
    expect(() => maskFonts(planPart('fonts'))).not.toThrow()
    vi.stubGlobal('document', undefined)
    expect(() => maskFonts(planPart('fonts'))).not.toThrow()
    // Nothing named `check` anywhere in the chain.
    vi.stubGlobal('document', { fonts: {} })
    expect(() => maskFonts(planPart('fonts'))).not.toThrow()
    // Something named `check` that is not a function.
    const odd = { check: 42 }
    vi.stubGlobal('document', { fonts: odd })
    expect(() => maskFonts(planPart('fonts'))).not.toThrow()
    expect(odd.check).toBe(42)
  })
})

// --- screen -----------------------------------------------------------------

describe('maskScreen', () => {
  function fakeScreen(): Record<string, unknown> {
    const prototype: Record<string, unknown> = {}
    for (const [key, value] of Object.entries({
      width: 3840,
      height: 2160,
      availWidth: 3840,
      availHeight: 2135,
      availLeft: 1200,
      availTop: 25,
      colorDepth: 30,
      pixelDepth: 30
    })) {
      Object.defineProperty(prototype, key, {
        get: () => value,
        configurable: true,
        enumerable: true
      })
    }
    return Object.create(prototype) as Record<string, unknown>
  }

  it('reports the viewport as the screen', () => {
    // Consistent by construction: a page can always measure innerWidth, so a fixed
    // resolution larger or smaller than the window would contradict itself.
    const screen = fakeScreen()
    vi.stubGlobal('screen', screen)
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)
    maskScreen(planPart('screen'))

    expect(screen['width']).toBe(1024)
    expect(screen['height']).toBe(768)
    expect(screen['availWidth']).toBe(1024)
    expect(screen['availHeight']).toBe(768)
    expect(screen['availLeft']).toBe(0)
    expect(screen['availTop']).toBe(0)
    expect(screen['colorDepth']).toBe(24)
    expect(screen['pixelDepth']).toBe(24)
  })

  it('follows a resize instead of freezing one measurement', () => {
    const screen = fakeScreen()
    vi.stubGlobal('screen', screen)
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)
    maskScreen(planPart('screen'))
    vi.stubGlobal('innerWidth', 800)
    expect(screen['width']).toBe(800)
  })

  it('hides where the window sits and how large the browser interface is', () => {
    const screen = fakeScreen()
    vi.stubGlobal('screen', screen)
    vi.stubGlobal('innerWidth', 1024)
    vi.stubGlobal('innerHeight', 768)
    maskScreen(planPart('screen'))

    const global = globalThis as unknown as Record<string, unknown>
    expect(global['screenX']).toBe(0)
    expect(global['screenY']).toBe(0)
    expect(global['screenLeft']).toBe(0)
    expect(global['screenTop']).toBe(0)
    // The gap between outer and inner would disclose the chrome height and the
    // split layout around the page.
    expect(global['outerWidth']).toBe(1024)
    expect(global['outerHeight']).toBe(768)
  })

  it('answers zero rather than undefined when there is no viewport to report', () => {
    const screen = fakeScreen()
    vi.stubGlobal('screen', screen)
    maskScreen(planPart('screen'))
    expect(screen['width']).toBe(0)
    expect(screen['height']).toBe(0)
  })

  it('survives a page with no screen', () => {
    vi.stubGlobal('screen', undefined)
    expect(() => maskScreen(planPart('screen'))).not.toThrow()
  })
})

// --- device APIs ------------------------------------------------------------

describe('maskDeviceApis', () => {
  it('normalises the hardware counts', () => {
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskDeviceApis(planPart('devices'))

    expect(navigator['hardwareConcurrency']).toBe(4)
    expect(navigator['deviceMemory']).toBe(8)
    // The claimed machine is a desktop, so it has no touch screen.
    expect(navigator['maxTouchPoints']).toBe(0)
  })

  it('normalises network information rather than removing it', () => {
    // A Chrome without navigator.connection is a stranger sight than one on a
    // typical connection.
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskDeviceApis(planPart('devices'))

    const connection = navigator['connection'] as {
      effectiveType: string
      rtt: number
      downlink: number
      saveData: boolean
      onchange: unknown
      addEventListener: (...args: unknown[]) => unknown
      removeEventListener: (...args: unknown[]) => unknown
      dispatchEvent: (...args: unknown[]) => unknown
    }
    expect(connection.effectiveType).toBe('4g')
    expect(connection.rtt).toBe(50)
    expect(connection.downlink).toBe(10)
    expect(connection.saveData).toBe(false)
    expect(connection.onchange).toBeNull()
    // Nothing ever changes, but the event surface has to exist or feature detection
    // notices.
    expect(connection.addEventListener('change', () => undefined)).toBeUndefined()
    expect(connection.removeEventListener('change', () => undefined)).toBeUndefined()
    expect(connection.dispatchEvent({})).toBe(false)
  })

  it('removes the enumeration APIs outright', () => {
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskDeviceApis(planPart('devices'))

    for (const key of planPart('devices').removed) {
      expect(key in navigator, `${key} is still present`).toBe(false)
    }
    // Absence is what a build without the feature looks like, so a page testing
    // for it takes the path it already takes on Firefox.
    expect(navigator['getBattery']).toBeUndefined()
  })

  it('answers the pickers that stay with nothing', async () => {
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskDeviceApis(planPart('devices'))

    const mediaDevices = navigator['mediaDevices'] as {
      enumerateDevices: () => Promise<unknown[]>
    }
    expect(await mediaDevices.enumerateDevices()).toEqual([])
    expect((navigator['getGamepads'] as () => unknown[])()).toEqual([])
  })

  it('reports a fixed storage quota and the site’s real usage', async () => {
    // The real quota is a fraction of free disk space, so it discloses the size of
    // the disk; usage is this site's own and reveals nothing about the machine.
    const navigator = fakeNavigator()
    vi.stubGlobal('navigator', navigator)
    maskDeviceApis(planPart('devices'))

    const storage = navigator['storage'] as { estimate: () => Promise<Record<string, unknown>> }
    const estimate = await storage.estimate()
    expect(estimate['quota']).toBe(planPart('devices').storageQuota)
    expect(estimate['usage']).toBe(4096)
  })

  it('reports zero usage when the real estimate has none', async () => {
    const navigator = fakeNavigator()
    navigator['storage'] = { estimate: (): Promise<unknown> => Promise.resolve({}) }
    vi.stubGlobal('navigator', navigator)
    maskDeviceApis(planPart('devices'))
    const storage = navigator['storage'] as { estimate: () => Promise<Record<string, unknown>> }
    expect((await storage.estimate())['usage']).toBe(0)
  })

  it('survives a page missing every one of them', () => {
    vi.stubGlobal('navigator', {})
    expect(() => maskDeviceApis(planPart('devices'))).not.toThrow()
    vi.stubGlobal('navigator', { mediaDevices: null, storage: null, getGamepads: 1 })
    expect(() => maskDeviceApis(planPart('devices'))).not.toThrow()
    vi.stubGlobal('navigator', { mediaDevices: {}, storage: {} })
    expect(() => maskDeviceApis(planPart('devices'))).not.toThrow()
    vi.stubGlobal('navigator', undefined)
    expect(() => maskDeviceApis(planPart('devices'))).not.toThrow()
  })
})

// --- time zone --------------------------------------------------------------

describe('maskTimeZone', () => {
  // Captured before anything is stubbed: the fakes below replace `Intl` wholesale,
  // and reading the formatter off the stub would hand the masking an undefined.
  const RealDateTimeFormat = Intl.DateTimeFormat

  /**
   * A `Date` subclass and a copy of `Intl`, so the patches land on objects this
   * test owns. Patching the real `Date.prototype` would change time for the test
   * runner itself.
   */
  function fakeTemporalWorld() {
    class TestDate extends Date {}
    const intl = { DateTimeFormat: RealDateTimeFormat }
    vi.stubGlobal('Date', TestDate)
    vi.stubGlobal('Intl', intl)
    return { TestDate, intl }
  }

  /** 2026-07-25T22:37:05Z — 00:37 the next day in Berlin, on summer time. */
  const summer = Date.UTC(2026, 6, 25, 22, 37, 5)
  /** 2026-01-15T22:37:05Z — 23:37 the same day in Berlin, on winter time. */
  const winter = Date.UTC(2026, 0, 15, 22, 37, 5)

  it('reports the offset of the named zone, following daylight saving', () => {
    // Derived from the zone database per instant rather than from a fixed number:
    // a browser reporting a summer offset in January would be its own signal.
    const { TestDate } = fakeTemporalWorld()
    maskTimeZone('Europe/Berlin')
    expect(new TestDate(summer).getTimezoneOffset()).toBe(-120)
    expect(new TestDate(winter).getTimezoneOffset()).toBe(-60)
  })

  it('gives the same answer however often it is asked', () => {
    const { TestDate } = fakeTemporalWorld()
    maskTimeZone('Europe/Berlin')
    const date = new TestDate(summer)
    const first = date.getTimezoneOffset()
    for (let attempt = 0; attempt < 50; attempt++) {
      expect(date.getTimezoneOffset()).toBe(first)
    }
  })

  it('moves every local field to the spoofed zone, consistently', () => {
    // A page that reads getHours and getTimezoneOffset must find them agreeing;
    // masking one and not the other is worse than masking neither.
    const { TestDate } = fakeTemporalWorld()
    maskTimeZone('Europe/Berlin')
    const date = new TestDate(summer)

    expect(date.getFullYear()).toBe(2026)
    expect(date.getMonth()).toBe(6)
    expect(date.getDate()).toBe(26)
    expect(date.getDay()).toBe(0)
    expect(date.getHours()).toBe(0)
    expect(date.getMinutes()).toBe(37)
    expect(date.getSeconds()).toBe(5)
  })

  it('spells the date strings in the spoofed zone', () => {
    const { TestDate } = fakeTemporalWorld()
    maskTimeZone('Europe/Berlin')
    const date = new TestDate(summer)

    expect(date.toString()).toBe('Sun Jul 26 2026 00:37:05 GMT+0200 (Central European Summer Time)')
    expect(date.toDateString()).toBe('Sun Jul 26 2026')
    expect(date.toTimeString()).toBe('00:37:05 GMT+0200 (Central European Summer Time)')
  })

  it('handles a zone behind UTC and one exactly on it', () => {
    const { TestDate } = fakeTemporalWorld()
    maskTimeZone('America/New_York')
    expect(new TestDate(summer).getTimezoneOffset()).toBe(240)
    expect(new TestDate(summer).toTimeString()).toContain('GMT-0400')

    const utc = fakeTemporalWorld()
    maskTimeZone('UTC')
    expect(new utc.TestDate(summer).getTimezoneOffset()).toBe(0)
    expect(new utc.TestDate(summer).toTimeString()).toContain('GMT+0000')
  })

  it('formats through Intl in the spoofed zone', () => {
    const { TestDate } = fakeTemporalWorld()
    maskTimeZone('Europe/Berlin')
    const date = new TestDate(summer)

    expect(date.toLocaleString('en-US')).toContain('7/26/2026')
    expect(date.toLocaleDateString('en-US')).toBe('7/26/2026')
    expect(date.toLocaleTimeString('en-US')).toContain('37:05')
    // The caller's own options replace the defaults rather than merging with them:
    // dateStyle beside year is an error, so a merge would throw.
    expect(date.toLocaleString('en-US', { dateStyle: 'short' })).toBe('7/26/26')
    // An explicit zone from the caller still wins.
    expect(date.toLocaleTimeString('en-US', { timeZone: 'UTC', hour12: false })).toContain('22:37')
  })

  it('makes a formatter created without a zone report the spoofed one', () => {
    const { TestDate, intl } = fakeTemporalWorld()
    maskTimeZone('Europe/Berlin')

    expect(new intl.DateTimeFormat().resolvedOptions().timeZone).toBe('Europe/Berlin')
    expect(new intl.DateTimeFormat('en-US', { timeZone: 'UTC' }).resolvedOptions().timeZone).toBe(
      'UTC'
    )
    // Called without `new`, which the specification also allows.
    const applied = intl.DateTimeFormat('en-US')
    expect(applied.resolvedOptions().timeZone).toBe('Europe/Berlin')
    expect(applied.format(new TestDate(summer))).toBe('7/26/2026')
  })

  it('leaves an invalid date invalid', () => {
    const { TestDate } = fakeTemporalWorld()
    maskTimeZone('Europe/Berlin')
    const invalid = new TestDate(Number.NaN)

    expect(invalid.getHours()).toBeNaN()
    expect(invalid.getTimezoneOffset()).toBeNaN()
    expect(invalid.toString()).toBe('Invalid Date')
    expect(invalid.toDateString()).toBe('Invalid Date')
    expect(invalid.toTimeString()).toBe('Invalid Date')
  })

  it('does nothing at all when there is no Date or Intl to patch', () => {
    vi.stubGlobal('Intl', undefined)
    expect(() => maskTimeZone('UTC')).not.toThrow()
    vi.stubGlobal('Intl', {})
    expect(() => maskTimeZone('UTC')).not.toThrow()
    vi.stubGlobal('Date', undefined)
    expect(() => maskTimeZone('UTC')).not.toThrow()

    // A `Date` with no `getTime` gives nothing to shift from.
    const bare = { prototype: {} }
    vi.stubGlobal('Date', bare)
    vi.stubGlobal('Intl', { DateTimeFormat: RealDateTimeFormat })
    expect(() => maskTimeZone('UTC')).not.toThrow()
    expect(Object.getOwnPropertyNames(bare.prototype)).not.toContain('getTimezoneOffset')
  })

  it('leaves a local field it has no UTC counterpart for', () => {
    class Partial {
      getTime(): number {
        return summer
      }
    }
    vi.stubGlobal('Date', Partial)
    vi.stubGlobal('Intl', { DateTimeFormat: RealDateTimeFormat })
    expect(() => maskTimeZone('Europe/Berlin')).not.toThrow()
    expect(Object.getOwnPropertyNames(Partial.prototype)).not.toContain('getHours')
    // The offset does not depend on the getters, so that one is still installed.
    expect(Object.getOwnPropertyNames(Partial.prototype)).toContain('getTimezoneOffset')
  })

  it('leaves the clock alone when the runtime cannot report zone parts', () => {
    // Rather than shift by a guessed offset. A wrong offset is a contradiction
    // between `getHours` and `Intl`, which is worse than an unmasked zone.
    class NoParts {
      resolvedOptions(): { timeZone: string } {
        return { timeZone: 'Europe/Berlin' }
      }
    }
    class JunkParts extends NoParts {
      formatToParts(): unknown {
        return 'not a list of parts'
      }
    }

    for (const Formatter of [NoParts, JunkParts]) {
      class TestDate extends Date {}
      vi.stubGlobal('Date', TestDate)
      vi.stubGlobal('Intl', { DateTimeFormat: Formatter })
      maskTimeZone('Europe/Berlin')

      const date = new TestDate(summer)
      expect(date.getTimezoneOffset(), Formatter.name).toBe(0)
      expect(date.getHours(), Formatter.name).toBe(22)
      expect(date.toString(), Formatter.name).toBe(
        'Sat Jul 25 2026 22:37:05 GMT+0000 (Europe/Berlin)'
      )
      // No `format` to call, so the locale methods answer with nothing rather than
      // throwing inside a page.
      expect(date.toLocaleString('en-US'), Formatter.name).toBe('')
    }
  })
})

// --- serialisation ----------------------------------------------------------

describe('crossing into the page world', () => {
  const measures: ReadonlyArray<readonly [string, (value: never) => void, unknown]> = [
    ['maskUserAgent', maskUserAgent, planPart('userAgent')],
    ['maskLocale', maskLocale, planPart('locale')],
    ['maskCanvas', maskCanvas, planPart('canvas')],
    ['maskWebgl', maskWebgl, planPart('webgl')],
    ['maskAudio', maskAudio, planPart('audio')],
    ['maskFonts', maskFonts, planPart('fonts')],
    ['maskScreen', maskScreen, planPart('screen')],
    ['maskDeviceApis', maskDeviceApis, planPart('devices')],
    ['maskTimeZone', maskTimeZone, 'Europe/Berlin']
  ]

  it('compiles every measure from its own source, with no scope to fall back on', () => {
    // This is what `executeInMainWorld` does: the function is serialised and
    // re-compiled in the page's world, where this module does not exist. A call to
    // a shared helper or a module constant passes every other test in this file and
    // throws ReferenceError in a real page.
    for (const [name, measure, argument] of measures) {
      const context = createContext({})
      const compiled: unknown = new Script(`(${measure.toString()})`).runInContext(context)
      expect(typeof compiled, name).toBe('function')
      expect(() => (compiled as (value: unknown) => void)(argument), name).not.toThrow()
    }
  })

  it('still masks a canvas when it is the re-compiled copy doing the work', () => {
    const world = fakeCanvasWorld()
    const canvas = world.painted(280, 60)
    const before = [...canvas.context.getImageData(0, 0, 280, 60).data]

    const context = createContext({
      HTMLCanvasElement: world.Canvas,
      CanvasRenderingContext2D: world.Context,
      document: { createElement: (): unknown => new world.Canvas() }
    })
    const compiled = new Script(`(${maskCanvas.toString()})`).runInContext(context) as (
      value: unknown
    ) => void
    compiled(planPart('canvas'))

    expect([...canvas.context.getImageData(0, 0, 280, 60).data]).not.toEqual(before)
  })
})
