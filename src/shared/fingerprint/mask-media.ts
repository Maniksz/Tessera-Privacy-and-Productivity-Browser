import type { AudioNoise, CanvasNoise, GpuPlan } from './plan.js'
import type { Callable, Slots } from './page.js'

/**
 * The three measurements a page takes by *rendering* something: canvas, WebGL and
 * audio. These are the only values that cannot be made uniform without breaking
 * them, so these are the only ones carrying noise — derived from the per-site seed,
 * never from a random number.
 *
 * One of four files holding the page-world measures; the rule every function here
 * obeys is explained once, in `apply.ts`.
 */

// --- canvas -----------------------------------------------------------------

/**
 * Canvas readback (spec 4).
 *
 * The perturbation is a pure function of the *absolute* pixel position, and that
 * is what makes it consistent: the same drawing read twice, read as two
 * overlapping rectangles, or read once directly and once through `toDataURL`,
 * gives the same bytes every time. Noise generated per call would be worse than
 * none, because a site only has to read twice to learn that it is being lied to.
 *
 * One pixel in `stride` is touched along each row rather than every pixel. A full
 * pass costs tens of milliseconds on a window-sized canvas, in a loop an image
 * editor may run every frame; a sparse pass still changes every hash a
 * fingerprinting script can take, because its canvases are hundreds of pixels
 * wide and several pixels per row are hit.
 *
 * `toDataURL` and `toBlob` export a *copy* carrying the same noise. Perturbing the
 * original in place is cheaper and is what several extensions do — and it means an
 * application that draws, exports, draws and exports again accumulates the damage.
 */
export function maskCanvas(noise: CanvasNoise): void {
  const scope = globalThis as unknown as {
    HTMLCanvasElement?: { prototype: Slots }
    CanvasRenderingContext2D?: { prototype: Slots }
    OffscreenCanvasRenderingContext2D?: { prototype: Slots }
    document?: Slots
  }

  const deltas = [...noise.deltas]
  const stride = noise.stride
  const offset = noise.offset

  interface Pixels {
    readonly length: number
    [index: number]: number
  }
  interface ImageDataLike {
    readonly width: number
    readonly height: number
    readonly data: Pixels
  }

  const perturb = (image: ImageDataLike, left: number, top: number): void => {
    const data = image.data
    for (let row = 0; row < image.height; row++) {
      const y = top + row
      // The first absolute column at or after `left` that this site perturbs,
      // solved from the same congruence for every rectangle so that overlapping
      // reads of one canvas agree with each other.
      const phase = ((-(y * 7 + offset) % stride) + stride) % stride
      const start = left + ((((phase - left) % stride) + stride) % stride)
      for (let x = start; x < left + image.width; x += stride) {
        const pixel = ((y - top) * image.width + (x - left)) * 4
        if (pixel + 2 >= data.length) break
        const index = (x * 3 + y * 5) % deltas.length
        for (let channel = 0; channel < 3; channel++) {
          // Both indices are in range by construction — the modulus for one, the
          // length check above for the other — so an assertion is honest here where a
          // `?? 0` would invent a case the code cannot produce.
          const delta = deltas[(index + channel) % deltas.length]!
          const value = data[pixel + channel]! + delta
          // Clamped by hand: a real `Uint8ClampedArray` would do it, but the
          // function must not depend on which kind of array it was handed. Alpha
          // is left alone — a canvas composited over a background shows an alpha
          // change far more readily than a colour one.
          data[pixel + channel] = value < 0 ? 0 : value > 255 ? 255 : value
        }
      }
    }
  }

  const patchRead = (prototype: Slots): void => {
    const real = prototype['getImageData']
    if (typeof real !== 'function') return
    const original = real as Callable
    prototype['getImageData'] = function (this: unknown, ...args: unknown[]): unknown {
      const image = Reflect.apply(original, this, args)
      if (image === null || typeof image !== 'object') return image
      let left = Math.trunc(Number(args[0]))
      let top = Math.trunc(Number(args[1]))
      const width = Math.trunc(Number(args[2]))
      const height = Math.trunc(Number(args[3]))
      // Negative extents are legal and mean the rectangle grows the other way.
      if (width < 0) left += width
      if (height < 0) top += height
      if (!Number.isFinite(left) || !Number.isFinite(top)) return image
      perturb(image as ImageDataLike, left, top)
      return image
    }
  }

  patchRead(scope.CanvasRenderingContext2D?.prototype ?? {})
  patchRead(scope.OffscreenCanvasRenderingContext2D?.prototype ?? {})

  const canvasPrototype = scope.HTMLCanvasElement?.prototype
  if (canvasPrototype === undefined) return

  /**
   * A copy of the canvas carrying exactly the noise a direct read would produce,
   * obtained by routing the copy through the patched `getImageData` above.
   */
  const noisyCopy = (canvas: unknown): unknown => {
    const document = scope.document
    const create = document?.['createElement']
    if (typeof create !== 'function' || document === undefined) return null
    const copy = Reflect.apply(create as Callable, document, ['canvas'])
    if (copy === null || typeof copy !== 'object') return null
    const source = canvas as { width: number; height: number }
    const target = copy as Slots
    target['width'] = source.width
    target['height'] = source.height
    const getContext = target['getContext']
    if (typeof getContext !== 'function') return null
    const context = Reflect.apply(getContext as Callable, copy, ['2d'])
    if (context === null || typeof context !== 'object') return null
    const slots = context as Slots
    const draw = slots['drawImage']
    const read = slots['getImageData']
    const write = slots['putImageData']
    if (typeof draw !== 'function' || typeof read !== 'function' || typeof write !== 'function') {
      return null
    }
    Reflect.apply(draw as Callable, context, [canvas, 0, 0])
    const image = Reflect.apply(read as Callable, context, [0, 0, source.width, source.height])
    Reflect.apply(write as Callable, context, [image, 0, 0])
    return copy
  }

  const patchExport = (key: string): void => {
    const real = canvasPrototype[key]
    if (typeof real !== 'function') return
    const original = real as Callable
    canvasPrototype[key] = function (this: unknown, ...args: unknown[]): unknown {
      try {
        const copy = noisyCopy(this)
        if (copy !== null) return Reflect.apply(original, copy, args)
      } catch {
        // A canvas holding cross-origin pixels throws when read, a zero-sized one
        // throws on `getImageData`. Both must still export what they would have
        // exported unmasked, so fall through to the original receiver.
      }
      return Reflect.apply(original, this, args)
    }
  }

  patchExport('toDataURL')
  patchExport('toBlob')
}

// --- WebGL ------------------------------------------------------------------

/**
 * The GPU strings.
 *
 * `VENDOR` and `RENDERER` are already uniform in Chrome; the real device only
 * appears through `WEBGL_debug_renderer_info`, so that is where the substitution
 * has to land. Rendered output is left untouched: it is dominated by driver
 * differences no amount of JavaScript can normalise, and perturbing `readPixels`
 * would break applications that legitimately read their own frames.
 */
export function maskWebgl(plan: GpuPlan): void {
  const scope = globalThis as unknown as {
    WebGLRenderingContext?: { prototype: Slots }
    WebGL2RenderingContext?: { prototype: Slots }
  }

  const patch = (prototype: Slots): void => {
    const real = prototype['getParameter']
    if (typeof real !== 'function') return
    const original = real as Callable
    prototype['getParameter'] = function (this: unknown, ...args: unknown[]): unknown {
      switch (args[0]) {
        // GL_VENDOR and GL_RENDERER, then the two the debug extension adds.
        case 0x1f00:
          return plan.vendor
        case 0x1f01:
          return plan.renderer
        case 0x9245:
          return plan.unmaskedVendor
        case 0x9246:
          return plan.unmaskedRenderer
        default:
          return Reflect.apply(original, this, args)
      }
    }
  }

  patch(scope.WebGLRenderingContext?.prototype ?? {})
  patch(scope.WebGL2RenderingContext?.prototype ?? {})
}

// --- audio ------------------------------------------------------------------

/**
 * Audio readback.
 *
 * A buffer's channel is perturbed **once**, in place, and remembered — so every
 * later read of it, through `getChannelData` or `copyFromChannel`, returns
 * identical samples. Perturbing per call would make the two disagree with each
 * other and with themselves, which is precisely the tell to avoid.
 *
 * The magnitude is around -100 dB: inaudible, and still far above the resolution a
 * fingerprinting script sums over thousands of samples.
 */
export function maskAudio(noise: AudioNoise): void {
  const scope = globalThis as unknown as {
    AudioBuffer?: { prototype: Slots }
    AnalyserNode?: { prototype: Slots }
  }

  const deltas = [...noise.deltas]
  const scale = noise.scale

  interface Samples {
    readonly length: number
    [index: number]: number
  }

  const shift = (samples: Samples): void => {
    for (let index = 0; index < samples.length; index++) {
      const delta = deltas[index % deltas.length]!
      samples[index] = samples[index]! + delta * scale
    }
  }

  const bufferPrototype = scope.AudioBuffer?.prototype
  const realGetChannelData = bufferPrototype?.['getChannelData']
  if (bufferPrototype !== undefined && typeof realGetChannelData === 'function') {
    const original = realGetChannelData as Callable
    const done = new WeakMap<object, Set<number>>()

    const ensure = (buffer: unknown, channel: number): void => {
      if (buffer === null || typeof buffer !== 'object') return
      const channels = done.get(buffer) ?? new Set<number>()
      if (channels.has(channel)) return
      channels.add(channel)
      done.set(buffer, channels)
      const samples = Reflect.apply(original, buffer, [channel])
      if (samples === null || typeof samples !== 'object') return
      shift(samples as Samples)
    }

    bufferPrototype['getChannelData'] = function (this: unknown, ...args: unknown[]): unknown {
      ensure(this, Number(args[0]))
      return Reflect.apply(original, this, args)
    }

    const realCopy = bufferPrototype['copyFromChannel']
    if (typeof realCopy === 'function') {
      const originalCopy = realCopy as Callable
      bufferPrototype['copyFromChannel'] = function (this: unknown, ...args: unknown[]): unknown {
        ensure(this, Number(args[1]))
        return Reflect.apply(originalCopy, this, args)
      }
    }
  }

  const analyserPrototype = scope.AnalyserNode?.prototype
  if (analyserPrototype === undefined) return

  // The byte variants are deliberately left alone: quantised to 256 steps, they
  // carry no precision worth masking, and a delta large enough to survive the
  // quantisation would be visible in every audio visualiser on the web.
  for (const key of ['getFloatFrequencyData', 'getFloatTimeDomainData']) {
    const real = analyserPrototype[key]
    if (typeof real !== 'function') continue
    const original = real as Callable
    analyserPrototype[key] = function (this: unknown, ...args: unknown[]): unknown {
      const result = Reflect.apply(original, this, args)
      const target = args[0]
      if (target !== null && typeof target === 'object') shift(target as Samples)
      return result
    }
  }
}
