/**
 * A host as a person should read it: in its own script where that cannot deceive, in Punycode where it can.
 *
 * The WHATWG parser hands every host over in its ASCII form — `xn--mnchen-3ya.de`, never `münchen.de` — so
 * something has to turn it back before a page puts it in a sentence. Doing that unconditionally is the
 * homograph attack: `pаypal.com` with a Cyrillic `а` reads as PayPal and is somebody else. So a host is shown
 * in Unicode only when every letter in it belongs to one script, or to one of the combinations a language
 * really writes together (Japanese, Korean, Chinese with Bopomofo — each beside Latin, because their TLDs are).
 * Anything else, including a letter of a script this does not know and any symbol but a digit or a hyphen,
 * keeps the Punycode: unreadable is recoverable, misread is not. The rule is per host rather than per label,
 * so a Greek name under `.gr` stays Punycode too — the price of a rule that has no confusables table to keep.
 *
 * Written out rather than imported: the browser has no Punycode decoder for a page to call (`domainToUnicode`
 * is Node's), and the renderer bundle takes no dependency for forty lines of RFC 3492.
 */

const BASE = 36
const T_MIN = 1
const T_MAX = 26
const SKEW = 38
const DAMP = 700
const INITIAL_BIAS = 72
const INITIAL_N = 128
const MAX_CODE_POINT = 0x10ffff
/** A delta past this is a malformed label, not a long one; it also keeps the arithmetic exact. */
const MAX_DELTA = 0x7fffffff

/** RFC 3492, 6.1. */
function adapt(delta: number, points: number, first: boolean): number {
  let scaled = Math.floor(delta / (first ? DAMP : 2))
  scaled += Math.floor(scaled / points)
  let k = 0
  while (scaled > ((BASE - T_MIN) * T_MAX) / 2) {
    scaled = Math.floor(scaled / (BASE - T_MIN))
    k += BASE
  }
  return k + Math.floor(((BASE - T_MIN + 1) * scaled) / (scaled + SKEW))
}

/** A lower-case base-36 digit: `a`–`z` are 0–25, `0`–`9` are 26–35. */
function digitOf(code: number): number {
  if (code >= 0x61 && code <= 0x7a) return code - 0x61
  if (code >= 0x30 && code <= 0x39) return code - 0x30 + 26
  return -1
}

/** RFC 3492, 6.2: one label without its `xn--`, or `null` when it is not valid Punycode. */
export function decodePunycode(input: string): string | null {
  const delimiter = input.lastIndexOf('-')
  const output: number[] = []
  for (let j = 0; j < delimiter; j += 1) output.push(input.charCodeAt(j))

  let n = INITIAL_N
  let bias = INITIAL_BIAS
  let i = 0
  let index = delimiter > 0 ? delimiter + 1 : 0
  while (index < input.length) {
    const before = i
    let weight = 1
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null
      const digit = digitOf(input.charCodeAt(index))
      index += 1
      if (digit < 0) return null
      i += digit * weight
      if (i > MAX_DELTA) return null
      const threshold = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias
      if (digit < threshold) break
      weight *= BASE - threshold
    }
    const points = output.length + 1
    bias = adapt(i - before, points, before === 0)
    n += Math.floor(i / points)
    i %= points
    if (n > MAX_CODE_POINT) return null
    output.splice(i, 0, n)
    i += 1
  }
  return String.fromCodePoint(...output)
}

/** The scripts a host may be shown in, by the name `\p{Script=…}` knows them by. */
const SCRIPTS = [
  'Latin',
  'Greek',
  'Cyrillic',
  'Armenian',
  'Hebrew',
  'Arabic',
  'Devanagari',
  'Bengali',
  'Thai',
  'Georgian',
  'Hangul',
  'Hiragana',
  'Katakana',
  'Han',
  'Bopomofo'
].map((name) => ({ name, pattern: new RegExp(`^\\p{Script=${name}}$`, 'u') }))

/** Scripts a language writes together. A host in any subset of one of these is not "mixed". */
const WRITTEN_TOGETHER = [
  ['Latin', 'Han', 'Hiragana', 'Katakana'],
  ['Latin', 'Han', 'Hangul'],
  ['Latin', 'Han', 'Bopomofo']
]

/** Digits, hyphens and the dots between labels belong to every script. Nothing else does here. */
const NEUTRAL = /^[0-9.-]$/

function readsSafely(host: string): boolean {
  const seen = new Set<string>()
  for (const char of host) {
    if (NEUTRAL.test(char)) continue
    const script = SCRIPTS.find(({ pattern }) => pattern.test(char))
    if (script === undefined) return false
    seen.add(script.name)
  }
  if (seen.size <= 1) return true
  return WRITTEN_TOGETHER.some((together) => [...seen].every((name) => together.includes(name)))
}

/** `hostname` for display: see the module comment for when that is Unicode and when it stays Punycode. */
export function displayHost(hostname: string): string {
  const ascii = hostname.toLowerCase()
  const labels: string[] = []
  for (const label of ascii.split('.')) {
    if (!label.startsWith('xn--')) {
      labels.push(label)
      continue
    }
    const decoded = decodePunycode(label.slice('xn--'.length))
    if (decoded === null) return ascii
    labels.push(decoded)
  }
  const unicode = labels.join('.')
  return readsSafely(unicode) ? unicode : ascii
}
