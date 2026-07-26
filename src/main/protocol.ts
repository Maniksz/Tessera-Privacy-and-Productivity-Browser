import { app, net, protocol } from 'electron'
import { join, normalize, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PRODUCT_NAME, PRODUCT_SCHEME } from '@shared/product.js'
import { FAVICON_PAGE, faviconSiteOf } from '@shared/favicons/model.js'
import { THUMBNAIL_PAGE, thumbnailPageOf } from '@shared/thumbnails/model.js'

/**
 * The `tessera://` scheme for internal pages (start page, settings, history,
 * error pages).
 *
 * Registered as a privileged, standard scheme so internal pages get a proper
 * origin — otherwise they would be treated as opaque and could not use storage
 * or fetch, and every internal page would need a bespoke workaround.
 */

const SCHEME = PRODUCT_SCHEME

/** Must run before `app.whenReady()`. */
export function registerInternalSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // Internal pages are ours, but they are still web content: no bypassing
        // CSP, no special powers beyond a normal secure origin (spec 6).
        bypassCSP: false,
        allowServiceWorkers: false,
        stream: true
      }
    }
  ])
}

/**
 * Where the bytes for one cached picture are, or `null`.
 *
 * A callback rather than the store itself, so this module stays a router: it decides what an address
 * addresses, and something else decides what is cached. `FaviconStore.find` and
 * `ThumbnailStore.find` both supply one.
 *
 * The path comes from the store — derived from a hash of the key — and never from the address. That
 * is the whole reason the lookup takes a *key* rather than a file name: a handler that built a path
 * out of a query parameter would be a directory-traversal hole reachable from any web page, since an
 * internal address can be linked to.
 */
export type ImageResolver = (key: string) => { filePath: string; contentType: string } | null

/**
 * The two routes that serve bytes from the profile directory rather than from the bundle.
 *
 * Kept as one table because they differ in exactly two ways — which query parameter names the
 * subject, and which store answers — and everything else about them must stay identical: the same
 * miss behaviour, the same `nosniff`, the same immutable caching. Two separate handlers would drift.
 */
interface ImageRoute {
  /** Reads the subject out of the address, already normalised to a store key. */
  keyOf(url: string): string | null
  resolve: ImageResolver
}

/** Page names an internal URL may address. Anything else is a 404. */
const KNOWN_PAGES = new Set([
  'start',
  'settings',
  // Was missing while `INTERNAL_PAGES` in `channels.ts` already listed it, so the privilege table
  // granted `tessera://extensions` four channels and the handler answered its address with a 404. A
  // page cannot be reached by being allowed to do things.
  'extensions',
  'history',
  'bookmarks',
  'downloads',
  'passwords',
  'reader',
  'about',
  'https-only'
])

/**
 * Serves internal pages, and the assets they reference, from the built renderer
 * output.
 *
 * Two routes:
 *   `tessera://start/`             -> internal/start.html
 *   `tessera://start/assets/x.js`  -> assets/x.js
 *
 * The asset route is not optional: the start page is a real application with a
 * bundled script, and without it the page would load as bare markup with no
 * indication of why.
 *
 * Every resolved path is normalised and checked to stay inside the bundle. An
 * internal page is reachable from web content via a link, so its URL has to be
 * treated as untrusted input.
 */
export function registerInternalProtocol(options: {
  favicons: ImageResolver
  thumbnails: ImageResolver
}): void {
  const rootDir = normalize(join(__dirname, '../renderer'))

  const imageRoutes = new Map<string, ImageRoute>([
    [FAVICON_PAGE, { keyOf: faviconSiteOf, resolve: options.favicons }],
    [THUMBNAIL_PAGE, { keyOf: thumbnailPageOf, resolve: options.thumbnails }]
  ])
  // In development the renderer is served by Vite, so requests are proxied there
  // instead of read from disk — otherwise internal pages would be stale while the
  // chrome UI hot-reloads.
  const devServer = process.env.ELECTRON_RENDERER_URL

  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url)
    const page = url.hostname === '' ? 'start' : url.hostname.toLowerCase()

    /*
      Cached pictures are answered before anything else, because they are the routes whose bytes are
      not in the bundle: they live in the profile directory, so the traversal check below — which
      requires the target to sit under `rootDir` — would reject every one of them.
    */
    const imageRoute = imageRoutes.get(page)
    if (imageRoute !== undefined) {
      return serveCachedImage(request.url, imageRoute)
    }

    if (!KNOWN_PAGES.has(page)) {
      return notFound(page)
    }

    // A path other than the root is an asset request; the root is the document.
    const isAsset = url.pathname !== '' && url.pathname !== '/'
    const relativePath = isAsset ? url.pathname : `internal/${page}.html`

    if (devServer !== undefined && devServer !== '') {
      return net.fetch(new URL(relativePath, devServer).toString())
    }

    const target = normalize(join(rootDir, relativePath))
    // `normalize` collapses `..`, so this catches traversal after resolution
    // rather than trying to spot it in the raw string.
    if (target !== rootDir && !target.startsWith(rootDir + sep)) {
      return new Response('Forbidden', { status: 403 })
    }

    try {
      const response = await net.fetch(pathToFileURL(target).toString())
      if (response.status === 404) return notFound(page)
      return response
    } catch {
      return notFound(page)
    }
  })
}

/**
 * Serves one cached picture: a site's icon, or a page's screenshot.
 *
 * A miss is a plain 204 rather than the internal-page 404 below: the caller is an `<img>`, so an HTML
 * error document would be decoded as an image, fail, and put a broken-image glyph in the interface.
 * Empty-with-no-content is the answer that lets the renderer show its own fallback — which is the
 * common case rather than an error, since most pages are seen before anything has been cached for
 * them.
 *
 * The `Content-Type` is the one the store established from the bytes, never one a site declared, and
 * `nosniff` holds Chromium to it. Together they mean a site cannot get a document interpreted as
 * anything but the raster image it was accepted as.
 */
async function serveCachedImage(url: string, route: ImageRoute): Promise<Response> {
  const key = route.keyOf(url)
  if (key === null) return noImage()

  const found = route.resolve(key)
  if (found === null) return noImage()

  try {
    const response = await net.fetch(pathToFileURL(found.filePath).toString())
    if (!response.ok) return noImage()
    return new Response(response.body, {
      headers: {
        'content-type': found.contentType,
        'x-content-type-options': 'nosniff',
        /*
          Cacheable forever, because the address is versioned.

          `faviconUrl` and `thumbnailUrl` both put the capture time in the query string, so a
          refreshed picture *is* a new address. Without that the file name is stable per subject and
          Chromium would go on drawing the copy in its memory cache; with it, this header is safe and
          saves a disk read per card.
        */
        'cache-control': 'public, max-age=31536000, immutable'
      }
    })
  } catch {
    // The index names a file the disk no longer has. Nothing to do but let the fallback show.
    return noImage()
  }
}

/** Nothing cached for this subject, which the caller draws its own fallback for. */
function noImage(): Response {
  return new Response(null, { status: 204 })
}

/**
 * A recognisable page rather than Chromium's generic failure, per spec 7's
 * requirement for meaningful error pages.
 */
function notFound(page: string): Response {
  const safe = page.replace(/[^a-z0-9-]/gi, '')
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>${PRODUCT_NAME}</title>` +
      `<body style="font:15px system-ui;padding:2rem;background:#17171a;color:#d8d8dd">` +
      `<h1 style="font-size:1.2rem">${SCHEME}://${safe}</h1>` +
      `<p style="color:#8b8b96">This internal page does not exist.</p>`,
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' } }
  )
}

/**
 * Registers tessera as a handler for http/https so links from other
 * applications open here (spec 10).
 */
export function registerAsDefaultBrowser(): void {
  // In development the executable is Electron itself, so the registration would
  // point at the wrong binary.
  if (!app.isPackaged) return
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
}
