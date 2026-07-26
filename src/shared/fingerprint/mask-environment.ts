import type { DevicePlan, FontPlan, ScreenPlan } from './plan.js'
import type { Callable, Slots } from './page.js'

/**
 * What the page is told about the machine around it: installed fonts, screen
 * metrics, hardware counts and the device pickers. All uniform values — a crowd to
 * disappear into rather than noise to stand out with.
 *
 * One of four files holding the page-world measures; the rule every function here
 * obeys is explained once, in `apply.ts`.
 */

// --- fonts ------------------------------------------------------------------

/**
 * Font detection through `document.fonts.check`.
 *
 * "Yes" for the fonts of the claimed platform, for CSS's generic families, and for
 * faces the page loaded itself — a page must be able to tell whether its own web
 * font arrived. "No" for everything else, including fonts that really are
 * installed, because an installed-font list is close to a serial number.
 *
 * Not covered, and not coverable from here: measuring a string's width with a
 * candidate family and comparing against the fallback. That is the technique most
 * enumeration actually uses, and defeating it means intervening in layout, below
 * where a preload can reach.
 */
export function maskFonts(plan: FontPlan): void {
  const scope = globalThis as unknown as { document?: { fonts?: Slots } }
  const fonts = scope.document?.fonts
  if (fonts === undefined) return

  // `check` lives on `FontFaceSet.prototype`, so the object that declares it is
  // found and read in one walk — replacing it on the instance would leave an own
  // property where the real object has none, and searching separately from reading
  // would create a case where one succeeds and the other has to be guessed.
  let owner: object | null = fonts
  let real: unknown
  while (owner !== null) {
    const descriptor: PropertyDescriptor | undefined = Object.getOwnPropertyDescriptor(
      owner,
      'check'
    )
    if (descriptor !== undefined) {
      real = descriptor.value
      break
    }
    owner = Object.getPrototypeOf(owner) as object | null
  }
  if (owner === null || typeof real !== 'function') return
  const original = real as Callable

  const allowed = new Set(plan.allowed.map((family) => family.toLowerCase()))
  const generic = new Set(plan.generic.map((family) => family.toLowerCase()))

  const sizePattern =
    /^(?:[\d.]+(?:px|pt|pc|in|cm|mm|q|em|rem|ex|ch|vw|vh|vmin|vmax|%)|xx?-small|small|medium|large|xx?-large|smaller|larger)(?:\/\S+)?$/i

  const familiesOf = (font: string): string[] | null => {
    const tokens = font.trim().split(/\s+/)
    let size = -1
    for (let index = tokens.length - 1; index >= 0; index--) {
      if (sizePattern.test(tokens[index]!)) {
        size = index
        break
      }
    }
    // No size, or nothing after it, means this is not a valid font shorthand. The
    // real implementation throws for those, and answering anyway would be a
    // difference a script could test for.
    if (size < 0 || size === tokens.length - 1) return null
    return tokens
      .slice(size + 1)
      .join(' ')
      .split(',')
      .map((family) =>
        family
          .trim()
          .replace(/^["']|["']$/g, '')
          .toLowerCase()
      )
      .filter((family) => family !== '')
  }

  ;(owner as Slots)['check'] = function (this: unknown, ...args: unknown[]): unknown {
    const families = typeof args[0] === 'string' ? familiesOf(args[0]) : null
    if (families === null) return Reflect.apply(original, this, args)

    const loaded = new Set<string>()
    const forEach = (this as { forEach?: unknown } | null)?.forEach
    if (typeof forEach === 'function') {
      Reflect.apply(forEach as Callable, this, [
        (face: unknown) => {
          const family = (face as { family?: unknown } | null)?.family
          if (typeof family === 'string') {
            loaded.add(family.replace(/^["']|["']$/g, '').toLowerCase())
          }
        }
      ])
    }

    return families.some(
      (family) => allowed.has(family) || generic.has(family) || loaded.has(family)
    )
  }
}

// --- screen -----------------------------------------------------------------

/**
 * Screen metrics.
 *
 * Reported as the viewport rather than as a fixed resolution, which is the one
 * choice that stays self-consistent: a page can always measure
 * `window.innerWidth`, so claiming a 1920-wide screen inside a 2400-wide window
 * would be a contradiction it could spot in a line. Tor Browser makes the same
 * trade for the same reason.
 *
 * `devicePixelRatio` is left alone on purpose. It is a real signal — 2 means
 * high-DPI — but CSS `resolution` media queries report the same thing and cannot
 * be intercepted from JavaScript, so overriding one of the two would create a
 * mismatch easier to detect than the value it hides.
 */
export function maskScreen(plan: ScreenPlan): void {
  const scope = globalThis as unknown as {
    screen?: Slots
    innerWidth?: number
    innerHeight?: number
  }
  const screenObject = scope.screen
  if (screenObject === undefined) return

  const define = (target: object, key: string, get: () => unknown): void => {
    let owner: object = target
    while (!Object.prototype.hasOwnProperty.call(owner, key)) {
      const next: unknown = Object.getPrototypeOf(owner)
      if (next === null || typeof next !== 'object') {
        owner = target
        break
      }
      owner = next
    }
    try {
      Object.defineProperty(owner, key, { get, configurable: true, enumerable: true })
    } catch {
      // See `maskUserAgent`.
    }
  }

  const width = (): unknown => scope.innerWidth ?? 0
  const height = (): unknown => scope.innerHeight ?? 0

  define(screenObject, 'width', width)
  define(screenObject, 'height', height)
  define(screenObject, 'availWidth', width)
  define(screenObject, 'availHeight', height)
  define(screenObject, 'availLeft', () => 0)
  define(screenObject, 'availTop', () => 0)
  define(screenObject, 'colorDepth', () => plan.colorDepth)
  define(screenObject, 'pixelDepth', () => plan.colorDepth)

  // Where the window sits on the desktop tells a page nothing it needs and quite a
  // lot about the setup. The outer size would additionally disclose the height of
  // the browser's own interface and the split layout around the page.
  for (const key of ['screenX', 'screenY', 'screenLeft', 'screenTop']) {
    define(globalThis, key, () => 0)
  }
  define(globalThis, 'outerWidth', width)
  define(globalThis, 'outerHeight', height)
}

// --- device APIs ------------------------------------------------------------

/**
 * Hardware counts, network information and the device pickers.
 *
 * The counts are normalised rather than removed: a Chrome without
 * `hardwareConcurrency` is a stranger sight than one claiming four cores. The
 * pickers are removed, because the permission layer already refuses them and what
 * is left of them is only a way to enumerate attached hardware. `getBattery` goes
 * too — charge level and discharge time are a short-lived cross-site identifier,
 * which is why Firefox dropped the API outright.
 */
export function maskDeviceApis(plan: DevicePlan): void {
  const scope = globalThis as unknown as { navigator?: Slots }
  const target = scope.navigator
  if (target === undefined) return

  const ownerOf = (start: object, key: string): object => {
    let owner: object = start
    while (!Object.prototype.hasOwnProperty.call(owner, key)) {
      const next: unknown = Object.getPrototypeOf(owner)
      if (next === null || typeof next !== 'object') return start
      owner = next
    }
    return owner
  }

  const define = (start: object, key: string, get: () => unknown): void => {
    try {
      Object.defineProperty(ownerOf(start, key), key, {
        get,
        configurable: true,
        enumerable: true
      })
    } catch {
      // See `maskUserAgent`.
    }
  }

  const replace = (start: object, key: string, value: unknown): void => {
    try {
      Object.defineProperty(ownerOf(start, key), key, {
        value,
        writable: true,
        configurable: true,
        enumerable: true
      })
    } catch {
      // See `maskUserAgent`.
    }
  }

  define(target, 'hardwareConcurrency', () => plan.hardwareConcurrency)
  define(target, 'deviceMemory', () => plan.deviceMemory)
  define(target, 'maxTouchPoints', () => plan.maxTouchPoints)
  define(target, 'connection', () => ({
    effectiveType: plan.connection.effectiveType,
    rtt: plan.connection.rtt,
    downlink: plan.connection.downlink,
    saveData: plan.connection.saveData,
    // Nothing ever changes, but the event surface has to exist or feature
    // detection notices the difference.
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  }))

  for (const key of plan.removed) {
    // Removed rather than replaced by a thrower: absence is what a build without
    // the feature looks like, so a page testing `'usb' in navigator` takes the
    // path it already takes on Firefox. `Reflect.deleteProperty` reports failure
    // instead of throwing on a property that refuses to go, which leaves the real
    // API in place — still refused by the permission layer.
    Reflect.deleteProperty(ownerOf(target, key), key)
  }

  const mediaDevices = target['mediaDevices']
  if (mediaDevices !== null && typeof mediaDevices === 'object') {
    if (typeof (mediaDevices as Slots)['enumerateDevices'] === 'function') {
      replace(mediaDevices, 'enumerateDevices', (): Promise<unknown[]> => Promise.resolve([]))
    }
  }

  if (typeof target['getGamepads'] === 'function') {
    replace(target, 'getGamepads', (): unknown[] => [])
  }

  const storage = target['storage']
  if (storage === null || typeof storage !== 'object') return
  const realEstimate = (storage as Slots)['estimate']
  if (typeof realEstimate !== 'function') return
  const original = realEstimate as Callable
  replace(storage, 'estimate', async function (this: unknown, ...args: unknown[]): Promise<Slots> {
    const estimate: unknown = await Promise.resolve(Reflect.apply(original, this, args))
    const usage = (estimate as { usage?: unknown } | null)?.usage
    // The real quota is a fraction of free disk space, so it discloses the size of
    // the disk. Usage is this site's own and reveals nothing about the machine.
    return { quota: plan.storageQuota, usage: typeof usage === 'number' ? usage : 0 }
  })
}
