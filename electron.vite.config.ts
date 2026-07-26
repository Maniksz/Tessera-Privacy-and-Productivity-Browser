import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// `process.cwd()` rather than `import.meta.dirname`: the config is bundled to
// either CJS or ESM depending on how Vite loads it, and only one of the two has
// `import.meta`. The config always runs from the project root.
const projectRoot = process.cwd()
const shared = resolve(projectRoot, 'src/shared')

/**
 * Build targets are pinned to what ships in the box.
 *
 * Electron 43 carries Chromium 150 and Node 24, so there is no older engine to
 * support and no reason to down-level. Transpiling to an older target would add
 * polyfills and helper functions that cost parse time on every window open — and
 * the machines where that is measurable are exactly the older laptops this has to
 * stay usable on. Verified against the shipped framework rather than assumed:
 * `strings … Electron\ Framework | grep Chrome/`.
 */
const CHROMIUM_TARGET = 'chrome150'
const NODE_TARGET = 'node24'

export default defineConfig({
  main: {
    resolve: {
      alias: { '@shared': shared, '@main': resolve(projectRoot, 'src/main') }
    },
    build: {
      target: NODE_TARGET,
      minify: 'esbuild',
      // Dependencies stay external in the main process: it loads from disk anyway,
      // and bundling them would slow the first parse for no benefit. Replaces the
      // deprecated `externalizeDepsPlugin`.
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(projectRoot, 'src/main/index.ts') }
      }
    }
  },

  // A single preload entry, and that is a hard requirement rather than a
  // simplification: two entries that share a module make Rollup emit a shared
  // chunk which the entries then `require('./chunks/…')`. A sandboxed preload
  // cannot do that — `require` there is limited to a few built-ins — so a split
  // build would compile cleanly and fail at runtime. One self-contained file
  // removes the failure mode; the renderer's role is decided from
  // `additionalArguments` instead (see src/preload/index.ts).
  //
  // Dependencies are bundled in, not externalized, for the same reason.
  preload: {
    build: {
      // Node target, not the Chromium one: a preload is loaded through Node's
      // module system even though it runs alongside the page, and electron-vite
      // rejects anything else here.
      target: NODE_TARGET,
      minify: 'esbuild',
      rollupOptions: {
        input: { index: resolve(projectRoot, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true }
      }
    },
    resolve: { alias: { '@shared': shared } }
  },

  renderer: {
    root: resolve(projectRoot, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': resolve(projectRoot, 'src/renderer/src'),
        // Components rendered by *both* the chrome UI and an internal page. Its own alias rather than
        // a relative path, because the two hosts sit at different depths and one of them would be
        // wrong.
        '@renderer-shared': resolve(projectRoot, 'src/renderer/shared')
      }
    },
    build: {
      target: CHROMIUM_TARGET,
      minify: 'esbuild',
      // Off by default in library-ish builds; the number is what makes a size
      // regression visible in the build log rather than only in a test.
      reportCompressedSize: true,
      rollupOptions: {
        input: {
          index: resolve(projectRoot, 'src/renderer/index.html'),
          /**
           * The window's topmost layer, loaded into a view stacked above the tab
           * views. Its own entry rather than a route of the chrome UI because it is
           * loaded into a different web contents — see `src/main/browser/OverlayLayer.ts`.
           */
          overlay: resolve(projectRoot, 'src/renderer/overlay.html'),
          // Internal pages served over ownbrowser://, one entry each so the
          // protocol handler can resolve them by name.
          'internal/start': resolve(projectRoot, 'src/renderer/internal/start.html'),
          'internal/history': resolve(projectRoot, 'src/renderer/internal/history.html'),
          'internal/reader': resolve(projectRoot, 'src/renderer/internal/reader.html'),
          'internal/settings': resolve(projectRoot, 'src/renderer/internal/settings.html'),
          'internal/extensions': resolve(projectRoot, 'src/renderer/internal/extensions.html'),
          'internal/bookmarks': resolve(projectRoot, 'src/renderer/internal/bookmarks.html'),
          'internal/downloads': resolve(projectRoot, 'src/renderer/internal/downloads.html'),
          'internal/passwords': resolve(projectRoot, 'src/renderer/internal/passwords.html')
        },
        output: {
          /**
           * React goes into its own chunk shared by the chrome UI and the start
           * page.
           *
           * Without this, both entries inline their own copy: the same ~140 kB is
           * parsed and compiled twice per window, once for the toolbar and again
           * for the start page. A shared chunk is compiled once and reused from
           * V8's code cache — the kind of saving that is invisible on a fast
           * desktop and clearly felt on an older laptop.
           */
          manualChunks: (id: string) => {
            if (id.includes('node_modules/react') || id.includes('node_modules/scheduler')) {
              return 'vendor-react'
            }
            return undefined
          }
        }
      }
    },
    esbuild: {
      // License blocks from dependencies are not useful at runtime; they are
      // reproduced in the distributed package instead.
      legalComments: 'none'
    }
  }
})
