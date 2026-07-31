import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { quickpickle } from 'quickpickle'

const projectRoot = process.cwd()

/**
 * Test configuration.
 *
 * Three kinds of test live side by side, in two Vitest projects:
 *
 *   - `tests/**\/*.test.ts` — unit and architecture tests, plain Vitest.
 *   - `tests/features/**\/*.feature` — Gherkin scenarios run through quickpickle,
 *     with steps in `tests/features/steps`. These describe behaviour in the
 *     language of the specification, so a requirement and its test can be read
 *     against each other without translating between them.
 *   - `tests/components/**\/*.test.tsx` — renderer components, rendered into a DOM.
 *
 * The components are a separate project rather than a glob in one, and the reason is concrete: a
 * single project applies `setupFiles` to every test file, so the quickpickle step registration ran
 * inside the DOM environment too — where it resolved `pngjs/browser`, which does not exist, and
 * reported an error beside a passing suite. Two projects also keep `environment: node` the default,
 * so a main-process module cannot quietly start using `document` and still pass.
 *
 * Coverage thresholds are set per area rather than globally. A single global
 * number lets a well-tested module hide a bare one; the filter logic and the
 * split-view geometry are held to a higher bar than plumbing, because that is
 * where a silent mistake does real damage.
 */

/** Shared by both projects: a project does not inherit `resolve` from the root config. */
const alias = {
  '@shared': resolve(projectRoot, 'src/shared'),
  '@main': resolve(projectRoot, 'src/main'),
  '@renderer': resolve(projectRoot, 'src/renderer/src'),
  '@renderer-internal': resolve(projectRoot, 'src/renderer/internal'),
  '@renderer-shared': resolve(projectRoot, 'src/renderer/shared')
}

// A hanging test is a failing test; without this a bad `await` stalls CI.
const testTimeout = 10_000

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [quickpickle()],
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'tests/features/**/*.feature'],
          /*
            The DOM project's folder, which this one must not also claim.

            Not needed while every test in there was `.tsx` — the glob above simply missed them. It became
            necessary the moment a `.ts` test needed a document: without it the same file runs twice, once in
            node, where `document` does not exist and every assertion fails for a reason that has nothing to
            do with the code under test.
          */
          exclude: ['tests/components/**'],
          // Step definitions must be registered before any feature runs.
          setupFiles: ['tests/features/steps/index.ts'],
          environment: 'node',
          testTimeout
        }
      },
      {
        /*
          The automatic JSX runtime, so a component test needs no `import React`.

          The renderer build gets this from `@vitejs/plugin-react` in `electron.vite.config.ts`;
          this file is a separate configuration and had no JSX handling at all, because until now
          no test rendered anything.
        */
        esbuild: { jsx: 'automatic' },
        resolve: { alias },
        test: {
          name: 'components',
          /*
            `.ts` as well as `.tsx`, because what this project really provides is a **DOM**.

            The name says components and the first tests here were all components, but the procedural filter
            matcher needs a document too — `:has-text()` asks about text, `:upward()` about ancestry,
            `:matches-css()` about computed style, and a test that invented a fake tree would be checking its
            own fake. It cannot go in the unit project: that one loads the Gherkin step definitions as
            setup files, and quickpickle's transitive `pngjs/browser` import does not resolve under
            happy-dom — so a `@vitest-environment` docblock there fails on something unrelated to the test.
          */
          include: ['tests/components/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
          testTimeout
        }
      }
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
      /*
        The renderer stays out, and that is a considered choice rather than an oversight.

        Including it was tried: a per-path threshold does not remove those files from the *global*
        calculation in this Vitest version, so measuring the renderer drags the 90 % bar down for the
        core logic it was written to guard. Renderer coverage is tracked instead by the
        "renderer lines no component test touches" metric in `scripts/metrics.mjs`, which counts what
        it names and shrinks as component tests are added.
      */
      include: ['src/shared/**/*.ts', 'src/main/**/*.ts'],
      exclude: [
        // Electron-bound modules that cannot run outside a browser process. They
        // are covered by the smoke test instead, and counting them here would
        // report a number that means nothing.
        'src/main/index.ts',
        'src/main/browser/BrowserWindowController.ts',
        'src/main/browser/OverlayLayer.ts',
        'src/main/browser/Tab.ts',
        'src/main/browser/WindowRegistry.ts',
        'src/main/menu/appMenu.ts',
        // Four lines around `Menu.buildFromTemplate`. The decisions live in `tab-context-items.ts`,
        // which is measured and tested.
        'src/main/menu/tabContextMenu.ts',
        'src/main/protocol.ts',
        'src/main/runtime-flags.ts',
        'src/main/paths.ts',
        'src/main/session/hardening.ts',
        'src/main/ipc/handlers.ts',
        'src/main/ipc/router.ts',
        'src/main/ipc/media-handlers.ts',
        'src/main/ipc/permission-handlers.ts',
        /*
          Two more Electron-bound modules, for the same reason as the ones above and not as a way round a
          threshold.

          Both subscribe to `app.on('web-contents-created')` and speak to a live `WebContents`; neither can
          run outside a browser process. What they *decide* was extracted so it could be tested — the
          document a filtering request is about is `injectableDocumentUrl`, and which views may propose a
          selector is a set the core fills — and what is left in them is the subscription plumbing the smoke
          test exercises instead.
        */
        'src/main/privacy/CosmeticInjector.ts',
        'src/main/privacy/ElementPicker.ts',
        /*
          Exactly the same shape as those two, and admitted on exactly the same terms: it subscribes to
          `app.on('web-contents-created')` and talks to a live `WebContents`, so it cannot run outside a
          browser process.

          Its decisions were extracted first, which is the condition for being listed here rather than an
          excuse to be: `AutofillService` holds every rule about which page may be filled, what a save bar
          may ask and when a credential is discarded, and it is covered in full. What is left in this file
          is the subscription plumbing.
        */
        'src/main/passwords/install-autofill.ts',
        /*
          The `electron-updater` and `dialog` half of the update check, admitted on the same terms as
          the three above and not as a way past a threshold.

          It speaks to the module-level `autoUpdater` singleton, which resolves a platform-specific
          subclass at first access and reads `app-update.yml` out of a packaged application's
          resources — there is no version of that which runs in a unit test.

          The condition for being listed here was met first: every decision was extracted into
          `UpdateService`, which is covered in full. Whether to check, which channel is asked for,
          who is offered what, which platform gets a download and which gets a web page, what a
          failure says and whether it says anything at all — all of it is there and tested. What is
          left in this file is translation: the library's throws into total results, and a
          presentation into a message box.
        */
        'src/main/updates/install-updates.ts',
        '**/*.d.ts'
      ],
      thresholds: {
        // Baseline for everything measured.
        lines: 90,
        functions: 90,
        branches: 85,
        statements: 90,
        /**
         * Higher bars where a silent error is most costly: a filter that quietly
         * stops matching, geometry that puts a tile in the wrong place, or a
         * permission that resolves the wrong way.
         *
         * Where a figure is short of 100, it is because the remaining branches
         * cannot be reached without editing the source, and each one is named
         * below. A gate that can never pass is not a strict gate — it is a broken
         * one, and it teaches people to ignore failures.
         */
        'src/shared/url/**': {
          lines: 100,
          functions: 100,
          // `rawHostOf`'s `?? ''` after `String.split`, which always yields at
          // least one element, and its unterminated-bracket branch, which
          // `classifyOmniboxInput` rejects earlier via `new URL`.
          branches: 95,
          statements: 98
        },
        'src/shared/split/**': { lines: 100, functions: 100, branches: 95, statements: 100 },
        'src/shared/quicklinks/**': { lines: 100, functions: 100, branches: 97, statements: 100 },

        /*
          The pure logic built alongside this scaffold, held at what it actually reached.

          Added after a subagent pointed out that its own module measured 100 % and *nothing
          enforced it* — the same gap this project already documents for the mutation scope: a
          healthy overall number says nothing about a directory it does not name. An omission here
          is invisible, so the list is meant to grow with every new pure module.

          Where a figure is under 100 it is because the remaining branches cannot be reached
          without editing the source, and the module says which ones.
        */
        'src/shared/ui/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/gestures/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/overlay/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/filters/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/favicons/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/history/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/tabgroups/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/session/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/find/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/shared/thumbnails/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        /*
          Named per file rather than as `shortcuts/**`, because `bindings.ts` is a table this project
          has never had full branch coverage of and pretending otherwise would make the entry a
          formality. `format.ts` is the part where being wrong is visible to the user — a tooltip
          naming a key nobody can press — so it is held to all of it.
        */
        'src/shared/shortcuts/format.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        },
        // `apply.ts` patches nine browser APIs; two of its guards need a page that lacks one.
        'src/shared/fingerprint/**': { lines: 100, functions: 100, branches: 98, statements: 100 },
        'src/main/crypto/**': { lines: 100, functions: 100, branches: 100, statements: 100 },
        'src/main/privacy/**': {
          // The stage-order guard throws only if a future edit reorders the array,
          // and `FilterListEngine.cosmeticStylesFor` has no implementation until
          // the filter-list engine lands.
          lines: 95,
          functions: 100,
          branches: 88,
          statements: 92
        },
        /*
          The update check, held at what it reaches, which for the seam itself is all of it.

          `UpdateService.ts` is at 100 in all four measures and that is the bar it has to keep: every
          number in it is a refusal — a download nobody approved, a dialogue after a check nobody
          asked for, a macOS build offered an update it cannot install — and a refusal that stops
          being taken looks exactly like the feature working.

          The figure is short of 100 only because of `version.ts`, whose remaining branches are the
          unparseable arms of `parseVersion` reached through four different callers; each is covered
          once and the duplicates cannot be reached separately without editing the source.
        */
        'src/main/updates/**': {
          lines: 100,
          functions: 100,
          branches: 92,
          statements: 96
        },
        'src/main/session/permission-policy.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        },
        'src/main/session/headers.ts': {
          lines: 100,
          functions: 100,
          branches: 95,
          statements: 100
        },
        /*
          The security boundary, both halves of it.

          `channels.ts` sat at 75 % branches while holding the per-page privilege table, and the
          uncovered line was `mayInternalPageInvoke` refusing an address that is not a page — the
          single most consequential answer in the file. Every caller happened to pass a real page
          name, so nothing ever asked.
        */
        'src/shared/ipc/channels.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        },
        'src/main/ipc/sender-policy.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        },
        /*
          The escape ladder and the keys that drive it.

          These two answer "what comes off next" and "what did the user just press", and both were
          wrong in a way no test could see until this round: the ladder descended from the outermost
          rung, so shrinking a fullscreen video also dropped the window out of fullscreen. Every
          branch in both is now reachable from a unit test with no window, which is the only reason
          a floor is honest here.

          `TileFullscreenController.ts` is deliberately absent. It sits at 85.7 % branches on one
          unreachable null-guard — `escape()` reads `fullscreenTile` after the verdict that already
          proves it non-null — and pinning it at that number would ratify the guard instead of
          removing it. Removing it means letting `SplitController.escape()` hand back the tile with
          the verdict, which is a change to an API this round has already moved once.
        */
        'src/main/browser/page-keys.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        },
        'src/main/browser/SplitController.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        },
        /*
          The other half of the boundary above: who may *open* an internal page.

          `sender-policy.ts` decides what an internal page may call once it is open, and was held
          here at all of it for that reason. It said nothing about how a page comes to be open at
          all, and for a long time nothing did — a web page could reach `tessera://settings` in its
          own tab and inherit that page's channels. A refusal that is only sometimes exercised is
          the failure mode this whole table exists for.
        */
        'src/main/browser/navigation-policy.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        },
        /*
          Held at all of it because it was carved out of a file that is excluded.

          These nine handlers lived in `BrowserWindowController.ts`, which is on the exclude list
          above as Electron-bound — so they were never measured and never could be. Moving them
          behind an injected seam is what made them measurable at all, and the global 90 % would let
          them drift most of the way back to unmeasured while still reporting green. A floor is the
          only thing that keeps the extraction from being reversible by neglect rather than by a
          decision someone has to write down.
        */
        'src/main/browser/window-events.ts': {
          lines: 100,
          functions: 100,
          branches: 100,
          statements: 100
        }
      }
    }
  }
})
