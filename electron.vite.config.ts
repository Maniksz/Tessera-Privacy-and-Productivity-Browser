import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import { build, type BuildEnvironmentOptions, type Plugin } from 'vite'
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

/**
 * How every preload entry is built, and why there is one pass per entry.
 *
 * `inlineDynamicImports` is what keeps an entry self-contained, and it is a hard requirement rather
 * than a preference: a sandboxed preload's `require` is limited to a few built-ins, so a bundle that
 * reaches for `require('./chunks/…')` compiles cleanly and fails the moment it runs. Rollup rejects
 * the option outright for a build with more than one input — and with good reason, since two inputs
 * that share a module (both entries reach `@shared/ipc/channels.ts`) make it emit exactly that shared
 * chunk. Verified, not assumed: two inputs and no `inlineDynamicImports` produced
 * `require("./assets/…")` in both entries, and `experimentalMinChunkSize` does not merge a chunk two
 * entries depend on.
 *
 * So each entry gets its own pass over the same options. Nothing is shared between the outputs, which
 * also means the entries may share *source* freely — `bridge.ts` is inlined into both rather than
 * emitted as something they would have to require.
 *
 * `manualPureFunctions: ['Set']` earns its place by measurement. `channels.ts` builds two lookup sets
 * at module level, and Rollup treats `new Set(…)` as a side effect unless told otherwise — so the
 * content entry, which imports only the internal-page allowlist, carried the entire chrome channel
 * table with it: that module weighed 3 804 B of the content bundle and now weighs 1 564 B, read from
 * the built output's source map. The built-in `Set` constructor has no side effect to lose.
 */
function preloadBuild(name: string, entry: string): BuildEnvironmentOptions {
  return {
    // Node target, not the Chromium one: a preload is loaded through Node's module system even though
    // it runs alongside the page, and electron-vite rejects anything else here.
    target: NODE_TARGET,
    minify: 'esbuild',
    rollupOptions: {
      input: { [name]: resolve(projectRoot, entry) },
      /*
        `electron` stays a `require`, and this line is not decoration.

        electron-vite externalizes it for the entry it builds itself; a bare Vite pass does not, and
        Vite's browser resolution answers a Node package with an *empty module* instead. The first
        build of `chrome.cjs` came out with `const f = {}` where `electron` should have been —
        `contextBridge` undefined, no bridge, and nothing wrong at build time. It is the one module a
        sandboxed preload may require, and `tests/preload-roles.test.ts` now checks each built entry
        requires exactly it.
      */
      external: ['electron'],
      output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true },
      treeshake: { manualPureFunctions: ['Set'] }
    }
  }
}

/**
 * Builds one more preload entry after the main one, with its own Rollup pass.
 *
 * A plugin rather than a second input, for the reason above. It runs after the primary bundle so the
 * `emptyOutDir` of that build cannot remove what this one wrote, and it declares its entry as a
 * watched file: the primary module graph does not contain it, so in `--watch` nothing else would
 * notice the file changing. A module the two entries share is in the primary graph already.
 */
function separatePreloadPass(name: string, entry: string): Plugin {
  const file = resolve(projectRoot, entry)
  return {
    name: `tessera:preload-entry-${name}`,
    apply: 'build',
    buildStart() {
      this.addWatchFile(file)
    },
    async closeBundle() {
      await build({
        // Self-contained: no config file and no plugins, so this pass cannot re-enter itself.
        configFile: false,
        root: projectRoot,
        resolve: { alias: { '@shared': shared } },
        build: {
          ...preloadBuild(name, entry),
          outDir: 'out/preload',
          emptyOutDir: false,
          watch: null
        }
      })
    }
  }
}

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

  /*
    Two preload bundles, one per role, and each one built entirely on its own.

    `index.cjs` is what tab views load and `chrome.cjs` is what the window and the overlay load; which
    file a view is given is the whole of its bridge privilege, so the chrome bridge is simply absent
    from the bundle a web page runs. See `src/main/paths.ts` (`preloadFile`) and either entry.

    Dependencies are bundled in rather than externalized: a sandboxed preload cannot require them.
  */
  preload: {
    build: preloadBuild('index', 'src/preload/index.ts'),
    resolve: { alias: { '@shared': shared } },
    // The second entry, built by its own pass. `preloadBuild` says why it cannot be a second input.
    plugins: [separatePreloadPass('chrome', 'src/preload/chrome.ts')]
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
