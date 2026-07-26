/**
 * How the media feature retrieves bytes.
 *
 * A seam with no default, and the missing default is the whole point.
 *
 * Node's global `fetch` is always in scope, so a media downloader that simply
 * called it would compile, work, and be wrong: it goes around Chromium's network
 * stack, and therefore around the proxy configuration, the DNS settings, the
 * request pipeline in `src/main/privacy/` and the kill switch. A user who turned on
 * a tunnel and then downloaded a video would have that one request leave outside
 * it, with nothing on screen to say so. In a privacy browser that is not a rough
 * edge, it is the leak the browser exists to prevent.
 *
 * The wiring passes Electron's session-bound `net.fetch`, which is
 * indistinguishable from the page's own traffic. Having to pass it is what keeps
 * the decision visible; an optional parameter falling back to the global would make
 * the leaking version the one you get by forgetting. Same reasoning, and the same
 * shape, as `FaviconStore`'s fetcher and `FilterListStore.fetchList`.
 */

export interface MediaFetchInit {
  /** Used for `Range`, which is how an `#EXT-X-BYTERANGE` segment is fetched. */
  readonly headers?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

export type MediaFetcher = (url: string, init?: MediaFetchInit) => Promise<Response>

/** Error text fit for a diagnostic line, from something that may not be an `Error`. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type TextFetchOutcome =
  | { readonly ok: true; readonly text: string }
  | {
      readonly ok: false
      /** Separated from other failures because it is the one worth naming to the user. */
      readonly tooLarge: boolean
      readonly detail: string
    }

/**
 * Retrieves a manifest as text, with a ceiling and without throwing.
 *
 * Both the registry (describing a manifest) and the downloader (re-reading the
 * chosen variant's playlist) need exactly this, so it lives here rather than twice.
 *
 * The declared length is checked before the body is read as well as after: a
 * `Content-Length` past the ceiling means the bytes never have to be buffered at
 * all. The second check is the one that counts, because the header is a claim.
 *
 * `text.length` counts UTF-16 code units rather than bytes, which makes the ceiling
 * approximate in the safe direction — a manifest is ASCII in practice, and being
 * out by a factor for a multi-byte one only ever refuses earlier.
 */
export async function fetchText(
  fetcher: MediaFetcher,
  url: string,
  maxBytes: number
): Promise<TextFetchOutcome> {
  try {
    const response = await fetcher(url)
    if (!response.ok) return { ok: false, tooLarge: false, detail: `HTTP ${response.status}` }

    const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, tooLarge: true, detail: `${declared} bytes declared` }
    }

    const text = await response.text()
    if (text.length > maxBytes) return { ok: false, tooLarge: true, detail: `${text.length} bytes` }
    return { ok: true, text }
  } catch (error) {
    // A network failure, a torn-down session, an aborted request: all the same
    // answer to the caller, which is "this manifest is not available".
    return { ok: false, tooLarge: false, detail: messageOf(error) }
  }
}
