import type { MediaContainer } from './model.js'

/**
 * Address arithmetic for media: extensions, relative references, output names.
 *
 * Separate from the detector and the parsers because all three need it and none
 * of them owns it. Everything here is total — a malformed address returns a
 * neutral answer rather than throwing, because the input is whatever a page asked
 * the network for, and one unparseable URL must not take the feature down.
 */

/**
 * Lowercased extension of the *path*, without the dot, or `''`.
 *
 * The query string is where this goes wrong. Signed media URLs routinely carry
 * `?token=…&file=x.mp4`, so a naive `endsWith('.mp4')` on the whole address reads
 * an extension out of a parameter, and a `.m3u8?…` playlist reads as no extension
 * at all. Both are the common case rather than the edge case, which is why this
 * function exists instead of a string check at the three call sites.
 */
export function pathExtensionOf(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return ''
  }
  const lastSlash = pathname.lastIndexOf('/')
  const segment = pathname.slice(lastSlash + 1)
  const dot = segment.lastIndexOf('.')
  if (dot <= 0) return ''
  return segment.slice(dot + 1).toLowerCase()
}

/** True for the two schemes a session can re-request. */
export function isRetrievableUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * A playlist reference resolved against the playlist's own address.
 *
 * Returns null rather than throwing: a playlist is text from the network and may
 * contain anything, and one bad URI line should cost that one segment, not the
 * parse. `new URL(reference, base)` already implements RFC 3986 resolution
 * correctly, including the `//host/path` and `?query-only` forms that a
 * hand-rolled join gets wrong.
 */
export function resolveMediaUrl(base: string, reference: string): string | null {
  try {
    return new URL(reference, base).toString()
  } catch {
    return null
  }
}

const EXTENSION_BY_CONTAINER: Readonly<Record<MediaContainer, string>> = {
  mp4: 'mp4',
  webm: 'webm',
  m4a: 'm4a',
  mp3: 'mp3',
  aac: 'aac',
  ogg: 'ogg',
  mov: 'mov',
  ts: 'ts',
  // Not `.media` or an empty extension: the platform decides what opens a file by
  // its extension, and `.bin` is honest about the browser not knowing.
  unknown: 'bin'
}

/** Extension a file of this container should be written with, without the dot. */
export function extensionForContainer(container: MediaContainer): string {
  return EXTENSION_BY_CONTAINER[container]
}

/** Longest name written to disk. Comfortably under every filesystem's limit. */
const MAX_FILE_NAME_LENGTH = 80

/** Used when the address carries no usable name at all. */
const FALLBACK_STEM = 'media'

/**
 * The stem of a name a person would recognise, taken from the address.
 *
 * Percent-decoded, because `Big%20Buck%20Bunny.mp4` is a name and
 * `Big%20Buck%20Bunny` is not. Then reduced to a conservative character set: this
 * string reaches a filesystem, and a path separator or a control character
 * arriving from a URL is how a download writes somewhere it was not asked to.
 */
function stemOf(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return FALLBACK_STEM
  }

  let segment = pathname.slice(pathname.lastIndexOf('/') + 1)
  try {
    segment = decodeURIComponent(segment)
  } catch {
    // A stray `%` is not worth losing the name over; keep the encoded form.
  }

  const dot = segment.lastIndexOf('.')
  const withoutExtension = dot > 0 ? segment.slice(0, dot) : segment
  const safe = withoutExtension
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[._ ]+/, '')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH)

  return safe === '' ? FALLBACK_STEM : safe
}

/**
 * The name a download is written to.
 *
 * The container decides the extension, never the address, and that is the point
 * of taking both: an HLS download comes from `master.m3u8` and is a `.ts` file
 * when it lands, and naming it after the playlist would produce a file no player
 * opens.
 */
export function mediaFileNameFor(url: string, container: MediaContainer): string {
  return `${stemOf(url)}.${extensionForContainer(container)}`
}

/**
 * `clip.mp4` at attempt 3 is `clip-3.mp4`.
 *
 * Two downloads from the same page produce the same name, and overwriting the
 * first is not an option — so the download names itself around what is already
 * there. Pure and here rather than in the downloader, because the string work is
 * the part worth testing directly and the disk lookup around it is not.
 */
export function numberedFileName(fileName: string, attempt: number): string {
  if (attempt <= 1) return fileName
  const dot = fileName.lastIndexOf('.')
  // A name with no extension, or one that *is* an extension (`.hidden`): the
  // number goes on the end, where it cannot corrupt the part that decides which
  // application opens the file.
  if (dot <= 0) return `${fileName}-${attempt}`
  return `${fileName.slice(0, dot)}-${attempt}${fileName.slice(dot)}`
}

/**
 * A label for the finding list — the name as the site spells it, extension and
 * all.
 *
 * Distinct from `mediaFileNameFor` on purpose: this one is what the user is
 * looking at on the page and has to match a finding to, so it keeps the
 * playlist's own extension rather than the container's.
 */
export function mediaLabelFor(url: string): string {
  const extension = pathExtensionOf(url)
  const stem = stemOf(url)
  return extension === '' ? stem : `${stem}.${extension}`
}
