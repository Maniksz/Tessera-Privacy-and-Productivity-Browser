import type { ObservedRequest } from '../privacy/RequestPipeline.js'
import type { ObservedResponse } from '../session/hardening.js'
import type { MediaRequestObservation, MediaResponseObservation } from './MediaRegistry.js'

/**
 * Turning what the two interception points saw into what the registry reads.
 *
 * The request side needs no conversion at all, and that is asserted rather than
 * assumed: the two assignments at the bottom of this file fail to compile if
 * `ObservedRequest` and `MediaRequestObservation` drift apart in either direction, so
 * the pipeline can keep handing its observation straight over. Neither the pipeline nor
 * the session hardening imports anything from this feature — an interception point that
 * depended on its observers would be a worse arrangement than one line of type checking
 * here.
 *
 * The response side does need work, and it is here rather than in `hardening.ts` for one
 * reason: `hardening.ts` cannot be unit-tested at all — it calls into a live Electron
 * session — while header casing is exactly the kind of thing that is wrong until a test
 * says otherwise.
 */

/**
 * One header, whatever case the server wrote it in.
 *
 * HTTP field names are case-insensitive and servers use every variation of
 * `Content-Type`, `content-type` and `CONTENT-TYPE`. A direct lookup on the record
 * would work against most servers and quietly fail against the rest, which is the worst
 * kind of nearly-working: a feature that recognises media on some sites and not others,
 * with nothing to point at.
 */
function headerValue(
  headers: Readonly<Record<string, string>>,
  lowercaseName: string
): string | null {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== lowercaseName) continue
    /*
      A repeated header arrives newline-joined (see `flattenResponseHeaders`), and only
      the first value can describe the body. Cut at the newline rather than splitting:
      `split('\n')[0]` is never absent, so the `?? fallback` it would need is a branch no
      test can enter — and an unreachable branch in a covered module is a gap in the
      gate, not a safety net.
    */
    const newline = value.indexOf('\n')
    return newline === -1 ? value : value.slice(0, newline)
  }
  return null
}

function integerOf(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * How many bytes the whole resource is — not how many this response carried.
 *
 * The distinction is the ordinary case rather than an edge one, and getting it wrong was
 * the first thing this wiring did. A `<video>` element does not fetch a file, it fetches
 * *ranges* of one: the first response is a `206 Partial Content` whose `Content-Length` is
 * the length of that range, often a megabyte or two of a two-hour film. Reporting it as the
 * size put an obviously wrong number in front of the user, and it changed every time the
 * player seeked, because each new range overwrote the last.
 *
 * `Content-Range: bytes 0-1023/12345678` carries the real total, and RFC 9110 §14.4 makes
 * it mandatory on a `206`. When the total is `*` — a server that will not say — the answer
 * is null rather than the range length: "unknown" is a state the interface can render, and
 * a confidently wrong size is not.
 */
function contentLengthOf(observed: ObservedResponse): number | null {
  if (observed.statusCode !== 206) return integerOf(headerValue(observed.headers, 'content-length'))

  const range = headerValue(observed.headers, 'content-range')
  if (range === null) return null
  const slash = range.lastIndexOf('/')
  if (slash === -1) return null
  return integerOf(range.slice(slash + 1))
}

/** What the registry needs, from what `onHeadersReceived` saw. */
export function mediaResponseObservation(observed: ObservedResponse): MediaResponseObservation {
  return {
    url: observed.url,
    resourceType: observed.resourceType,
    documentUrl: observed.documentUrl,
    webContentsId: observed.webContentsId,
    statusCode: observed.statusCode,
    // Raw, parameters and all: `MediaRegistry` normalises it, so there is one place
    // that decides what `video/mp4; codecs="avc1"` means.
    contentType: headerValue(observed.headers, 'content-type'),
    contentLength: contentLengthOf(observed)
  }
}

// The pipeline's observation *is* the registry's, in both directions.
const _observedRequestIsAnObservation: MediaRequestObservation = null as unknown as ObservedRequest
const _observationIsAnObservedRequest: ObservedRequest = null as unknown as MediaRequestObservation
void _observedRequestIsAnObservation
void _observationIsAnObservedRequest
