import type { Callable, Slots } from './page.js'

/**
 * The time zone, which touches more of `Date` than any other measure and therefore
 * lives on its own.
 *
 * One of four files holding the page-world measures; the rule every function here
 * obeys is explained once, in `apply.ts`.
 */

/**
 * The time zone, for everything that reads it.
 *
 * Only the reading side. `setHours` and friends still interpret their arguments in
 * the real zone, and `new Date('2026-01-01T12:00')` still parses as real local
 * time. Rewriting those means re-implementing the round trip in both directions
 * across daylight-saving boundaries, and getting it subtly wrong breaks date
 * pickers everywhere. The clean fix is process-wide — Chromium takes its zone from
 * the environment at startup — which is one value for the whole application and
 * not something a per-page patch should pretend to do better.
 *
 * The offset comes from `Intl` per instant, so daylight saving is handled by the
 * zone database rather than by an assumption, and it is cached per hour because
 * `getTimezoneOffset` gets called in loops.
 *
 * If the process already runs in the requested zone, every computed shift is zero
 * and all of this becomes a no-op — which is what makes it safe to combine with a
 * process-level setting later.
 */
export function maskTimeZone(timeZone: string): void {
  const scope = globalThis as unknown as {
    Date?: { prototype: Slots }
    Intl?: Slots
  }
  const dateConstructor = scope.Date
  const intl = scope.Intl
  if (dateConstructor === undefined || intl === undefined) return

  const realDateTimeFormat = intl['DateTimeFormat']
  if (typeof realDateTimeFormat !== 'function') return
  const formatterFor = (options: Slots): Slots => {
    const construct = realDateTimeFormat as unknown as new (
      locales: string,
      options: Slots
    ) => Slots
    return new construct('en-US', options)
  }

  const prototype = dateConstructor.prototype
  const realGetTime = prototype['getTime']
  if (typeof realGetTime !== 'function') return
  const getTime = realGetTime as Callable

  const partsFormatter = formatterFor({
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  const zoneNameFormatter = formatterFor({ timeZone, timeZoneName: 'long' })

  const partsOf = (formatter: Slots, time: number): Record<string, string> => {
    const values: Record<string, string> = {}
    const formatToParts = formatter['formatToParts']
    if (typeof formatToParts !== 'function') return values
    const parts = Reflect.apply(formatToParts as Callable, formatter, [time])
    if (!Array.isArray(parts)) return values
    for (const part of parts) {
      const entry = part as { type?: unknown; value?: unknown }
      if (typeof entry.type === 'string' && typeof entry.value === 'string') {
        values[entry.type] = entry.value
      }
    }
    return values
  }

  const offsets = new Map<number, number>()

  /** Minutes behind UTC, in `getTimezoneOffset`'s inverted convention. */
  const offsetAt = (time: number): number => {
    const bucket = Math.floor(time / 3_600_000)
    const cached = offsets.get(bucket)
    if (cached !== undefined) return cached

    const values = partsOf(partsFormatter, time)
    const wallClock = Date.UTC(
      Number(values['year']),
      Number(values['month']) - 1,
      Number(values['day']),
      Number(values['hour']),
      Number(values['minute']),
      Number(values['second'])
    )
    // Truncated to whole seconds on both sides, or the sub-second remainder would
    // turn up as a fractional minute.
    const offset = Number.isFinite(wallClock)
      ? (Math.floor(time / 1000) * 1000 - wallClock) / 60_000
      : 0
    offsets.set(bucket, offset)
    return offset
  }

  const zoneName = (time: number): string =>
    partsOf(zoneNameFormatter, time)['timeZoneName'] ?? timeZone

  const timeOf = (date: unknown): number => Number(Reflect.apply(getTime, date, []))

  /** The instant whose UTC fields are the target zone's wall-clock fields. */
  const wallClockOf = (time: number): number => time - offsetAt(time) * 60_000

  const localGetters: ReadonlyArray<readonly [string, string]> = [
    ['getFullYear', 'getUTCFullYear'],
    ['getMonth', 'getUTCMonth'],
    ['getDate', 'getUTCDate'],
    ['getDay', 'getUTCDay'],
    ['getHours', 'getUTCHours'],
    ['getMinutes', 'getUTCMinutes'],
    ['getSeconds', 'getUTCSeconds']
  ]

  for (const [local, utc] of localGetters) {
    const real = prototype[utc]
    if (typeof real !== 'function') continue
    const original = real as Callable
    prototype[local] = function (this: unknown): unknown {
      const time = timeOf(this)
      if (!Number.isFinite(time)) return NaN
      return Reflect.apply(original, new Date(wallClockOf(time)), [])
    }
  }

  prototype['getTimezoneOffset'] = function (this: unknown): unknown {
    const time = timeOf(this)
    if (!Number.isFinite(time)) return NaN
    return offsetAt(time)
  }

  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec'
  ]
  const pad = (value: number): string => String(value).padStart(2, '0')

  const dateText = (time: number): string => {
    const wall = new Date(wallClockOf(time))
    return `${days[wall.getUTCDay()]!} ${months[wall.getUTCMonth()]!} ${pad(wall.getUTCDate())} ${wall.getUTCFullYear()}`
  }

  const timeText = (time: number): string => {
    const wall = new Date(wallClockOf(time))
    const offset = offsetAt(time)
    // `getTimezoneOffset` counts minutes *behind* UTC, so the sign is inverted
    // relative to the GMT suffix a date string carries.
    const sign = offset <= 0 ? '+' : '-'
    const absolute = Math.abs(offset)
    const clock = `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`
    return `${clock} GMT${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)} (${zoneName(time)})`
  }

  prototype.toString = function (this: unknown): string {
    const time = timeOf(this)
    if (!Number.isFinite(time)) return 'Invalid Date'
    return `${dateText(time)} ${timeText(time)}`
  }

  prototype['toDateString'] = function (this: unknown): string {
    const time = timeOf(this)
    if (!Number.isFinite(time)) return 'Invalid Date'
    return dateText(time)
  }

  prototype['toTimeString'] = function (this: unknown): string {
    const time = timeOf(this)
    if (!Number.isFinite(time)) return 'Invalid Date'
    return timeText(time)
  }

  /**
   * The `toLocale…` family reaches ICU directly rather than through the `Intl`
   * object, so each one needs its own default zone.
   */
  const localeMethods: ReadonlyArray<readonly [string, Slots]> = [
    [
      'toLocaleString',
      {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric'
      }
    ],
    ['toLocaleDateString', { year: 'numeric', month: 'numeric', day: 'numeric' }],
    ['toLocaleTimeString', { hour: 'numeric', minute: 'numeric', second: 'numeric' }]
  ]

  /**
   * Which option keys select what is shown. The defaults apply only when the
   * caller named none of them, which is how the specification's own
   * `ToDateTimeOptions` behaves: `{ hour12: false }` still wants the default time
   * fields, while `{ dateStyle: 'short' }` replaces them — and mixing `dateStyle`
   * with `year` throws, so a blind merge would break callers.
   */
  const componentKeys = [
    'weekday',
    'era',
    'year',
    'month',
    'day',
    'dayPeriod',
    'hour',
    'minute',
    'second',
    'fractionalSecondDigits',
    'dateStyle',
    'timeStyle'
  ]

  for (const [method, defaults] of localeMethods) {
    prototype[method] = function (this: unknown, ...args: unknown[]): unknown {
      const requested = args[1] !== null && typeof args[1] === 'object' ? (args[1] as Slots) : null
      const chosen = requested !== null && componentKeys.some((key) => requested[key] !== undefined)
      const options: Slots = chosen ? { ...requested } : { ...defaults, ...requested }
      options['timeZone'] = requested?.['timeZone'] ?? timeZone
      const construct = realDateTimeFormat as unknown as new (
        locales: unknown,
        options: Slots
      ) => Slots
      const formatter = new construct(args[0], options)
      const format = formatter['format']
      if (typeof format !== 'function') return ''
      return Reflect.apply(format as Callable, formatter, [this])
    }
  }

  const withZone = (args: unknown[]): unknown[] => {
    const options = args[1] !== null && typeof args[1] === 'object' ? (args[1] as Slots) : {}
    if (options['timeZone'] !== undefined) return args
    return [args[0], { ...options, timeZone }]
  }

  /**
   * A proxy rather than a subclass, so `instanceof`, the statics and the prototype
   * chain stay the originals — the only change is the default `timeZone`, and an
   * explicit one from the caller still wins.
   */
  intl['DateTimeFormat'] = new Proxy(realDateTimeFormat as Callable, {
    construct(target: Callable, args: unknown[], newTarget: unknown): object {
      return Reflect.construct(target, withZone(args), newTarget as Callable) as object
    },
    apply(target: Callable, thisArgument: unknown, args: unknown[]): unknown {
      return Reflect.apply(target, thisArgument, withZone(args))
    }
  })
}
