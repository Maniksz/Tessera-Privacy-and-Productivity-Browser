/**
 * Where the development server keeps what an internal page asked for.
 *
 * An internal page is a document at `tessera://<page>/`, but its file is `internal/<page>.html` under the
 * renderer root. Its entry script is written relative to that file — `<script src="./start.tsx">` — and
 * the page itself is at the root of its own origin, so the browser resolves that reference to
 * `tessera://start/start.tsx`. On disk that does not matter: the build rewrites the reference to an
 * emitted asset. In development it does: the request is proxied to the Vite server as `/start.tsx`,
 * which does not exist there, and Vite answers a missing path with its HTML fallback. Chromium then
 * refuses to run HTML as a module and the page stays blank — every internal page, in every dev session.
 *
 * So a one-segment path is taken to be relative to the page's own file and looked up under `internal/`.
 * Nothing Vite generates is one segment and relative: its own paths start with `/@` (`/@vite/client`,
 * `/@fs/…`, `/@id/…`), and the imports it rewrites are absolute from the renderer root
 * (`/internal/StartPage.tsx`, `/node_modules/.vite/deps/react.js`). Those pass through unchanged.
 */
export function devServerPathFor(pathname: string): string {
  if (pathname.startsWith('/@')) return pathname
  return /^\/[^/]+$/.test(pathname) ? `/internal${pathname}` : pathname
}
