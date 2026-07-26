import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INTERNAL_PAGES,
  INTERNAL_PAGE_INVOKE_CHANNELS,
  INVOKE_CHANNELS,
  anyInternalInvokeChannels,
  mayInternalPageInvoke
} from '@shared/ipc/channels.js'

/**
 * Architecture tests — fitness functions.
 *
 * These read the source rather than call it. Their job is to protect the
 * decisions that a reviewer would have to remember, and that a type checker
 * cannot see:
 *
 *   - layer boundaries (a renderer must not import the core)
 *   - dependency weight in bundles the user waits for
 *   - the sandbox rules that keep visited pages out of the core
 *   - bundle-size budgets, so a performance regression is a red test rather than
 *     a discovery months later
 *
 * A failure here is usually not a bug yet. It is the moment a rule stopped
 * holding, which is the cheapest moment to deal with it.
 */

const ROOT = process.cwd()

interface SourceFile {
  path: string
  relative: string
  text: string
}

async function collect(dir: string, extensions = ['.ts', '.tsx']): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  const absolute = join(ROOT, dir)
  if (!existsSync(absolute)) return out

  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!extensions.some((extension) => entry.name.endsWith(extension))) continue
      out.push({
        path: full,
        relative: relative(ROOT, full),
        text: readFileSync(full, 'utf8')
      })
    }
  }

  await walk(absolute)
  return out
}

/**
 * Removes comments and string literals before scanning for code patterns.
 *
 * Without this, these tests are fooled by their own subject matter: the comment in
 * `main/index.ts` explaining that `crashReporter.start()` is deliberately absent
 * made the "never starts the crash reporter" test fail. A fitness function that
 * prose can trip is worse than none, because it trains people to weaken it.
 */
function codeOnly(text: string): string {
  return (
    text
      // Block comments, including the doc comments this codebase is full of.
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      // Line comments.
      .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
      // String and template contents, so a URL in a message is not read as code.
      .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
      .replace(/`(?:[^`\\]|\\.)*`/g, '``')
  )
}

/**
 * Removes comments but keeps string literals.
 *
 * For the few checks whose subject *is* a literal — a colour, a channel name — where
 * `codeOnly` would erase the very thing being asserted and the test would then pass or fail
 * for the wrong reason.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

/** Import specifiers, value and type alike. */
function importsOf(text: string): string[] {
  const specifiers: string[] = []
  const pattern = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) specifiers.push(match[1]!)
  return specifiers
}

/** Value imports only; `import type` is erased and costs nothing at runtime. */
function valueImportsOf(text: string): string[] {
  const specifiers: string[] = []
  const pattern = /(?:^|\n)\s*import\s+(?!type\s)([^;]*?)from\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const clause = match[1] ?? ''
    // `import { type A, type B } from` is also fully erased.
    const named = (/\{([^}]*)\}/.exec(clause))?.[1]
    if (named !== undefined && named.trim() !== '') {
      const allTypes = named
        .split(',')
        .map((part) => part.trim())
        .filter((part) => part !== '')
        .every((part) => part.startsWith('type '))
      if (allTypes) continue
    }
    specifiers.push(match[2]!)
  }
  return specifiers
}

describe('layer boundaries', () => {
  it('keeps shared code free of Electron', async () => {
    // `shared` is imported by the renderer, which has no Electron API. An import
    // here would either fail to bundle or silently pull the main-process surface
    // into a sandboxed page.
    for (const file of await collect('src/shared')) {
      expect(importsOf(file.text), file.relative).not.toContain('electron')
    }
  })

  it('keeps shared code free of Node built-ins', async () => {
    for (const file of await collect('src/shared')) {
      const nodeImports = importsOf(file.text).filter((spec) => spec.startsWith('node:'))
      expect(nodeImports, file.relative).toEqual([])
    }
  })

  it('does not let the renderer import the main process', async () => {
    // The renderer is sandboxed web content. Reaching into the core would either
    // fail at runtime or, worse, work.
    for (const file of await collect('src/renderer')) {
      for (const specifier of importsOf(file.text)) {
        expect(specifier, `${file.relative} imports ${specifier}`).not.toMatch(/^@main\//)
        expect(specifier, `${file.relative} imports ${specifier}`).not.toMatch(/\/main\//)
        expect(specifier, `${file.relative} imports ${specifier}`).not.toBe('electron')
      }
    }
  })

  it('does not let the main process import renderer code', async () => {
    for (const file of await collect('src/main')) {
      for (const specifier of importsOf(file.text)) {
        expect(specifier, `${file.relative} imports ${specifier}`).not.toMatch(/@renderer\//)
      }
    }
  })

  it('keeps the preload free of Node built-ins beyond what a sandbox allows', async () => {
    // A sandboxed preload can require only a small set of modules; anything else
    // builds cleanly and fails at runtime.
    const allowed = new Set(['electron'])
    for (const file of await collect('src/preload')) {
      for (const specifier of valueImportsOf(file.text)) {
        if (specifier.startsWith('.') || specifier.startsWith('@shared/')) continue
        expect(allowed.has(specifier), `${file.relative} imports ${specifier}`).toBe(true)
      }
    }
  })
})

describe('bundle weight', () => {
  it('keeps zod out of every module the renderer imports at runtime', async () => {
    // Importing a pure helper from a module that also holds schemas dragged the
    // whole validation library into the UI bundle once already — about half a
    // megabyte of startup parse work, felt most on the machines that can least
    // afford it. This is the test that keeps it out.
    const rendererFiles = await collect('src/renderer')
    const reachable = new Set<string>()

    const resolveShared = (specifier: string): string | null => {
      if (!specifier.startsWith('@shared/')) return null
      const withoutAlias = specifier.replace('@shared/', 'src/shared/').replace(/\.js$/, '.ts')
      return existsSync(join(ROOT, withoutAlias)) ? withoutAlias : null
    }

    const visit = (file: SourceFile): void => {
      for (const specifier of valueImportsOf(file.text)) {
        const resolved = resolveShared(specifier)
        if (resolved === null || reachable.has(resolved)) continue
        reachable.add(resolved)
        visit({
          path: join(ROOT, resolved),
          relative: resolved,
          text: readFileSync(join(ROOT, resolved), 'utf8')
        })
      }
    }

    for (const file of rendererFiles) visit(file)
    expect(reachable.size, 'expected the renderer to import something from shared').toBeGreaterThan(0)

    for (const module of reachable) {
      const text = readFileSync(join(ROOT, module), 'utf8')
      expect(valueImportsOf(text), `${module} is reachable from the renderer`).not.toContain('zod')
    }
  })

  it('holds the built renderer bundles to a size budget', () => {
    // Skipped rather than failed when there is no build: a unit-test run should not
    // require one, but a run after a build must hold the line.
    const assets = join(ROOT, 'out/renderer/assets')
    if (!existsSync(assets)) {
      expect(true, 'no build present; run pnpm build to check the budget').toBe(true)
      return
    }

    /**
     * First match wins, and the last entry is a catch-all.
     *
     * The catch-all is the point. An earlier version listed only the entries it knew about,
     * so every code-split chunk Rollup decided to emit — `omnibox`, `layout`, `catalog`,
     * and later `overlay` — was covered by nothing but the 320 kB aggregate. A chunk can
     * triple in size without crossing an aggregate that large, which is precisely the
     * regression a budget is supposed to catch.
     */
    const budgets: Array<{ match: RegExp; maxKb: number; note: string }> = [
      { match: /^index-.*\.js$/, maxKb: 60, note: 'chrome UI' },
      { match: /^overlay-.*\.js$/, maxKb: 20, note: 'overlay surface, one per window' },
      { match: /^vendor-react-.*\.js$/, maxKb: 240, note: 'React, shared between entries' },
      { match: /\.css$/, maxKb: 24, note: 'stylesheet' },
      { match: /\.js$/, maxKb: 40, note: 'shared chunk' }
    ]

    const files: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) walk(full)
        else files.push(full)
      }
    }
    walk(assets)
    expect(files.length, 'a build with no assets is a broken build').toBeGreaterThan(0)

    for (const file of files) {
      const name = file.split('/').pop() ?? ''
      const budget = budgets.find((candidate) => candidate.match.test(name))
      // No asset gets to be unbudgeted: a new kind of output should force a decision about
      // how big it is allowed to be, not slip through as "not covered by any pattern".
      expect(budget, `${name} matches no size budget`).toBeDefined()
      if (budget === undefined) continue

      // Decimal kB, same unit as the Vite build log and scripts/metrics.mjs.
      const kb = statSync(file).size / 1000
      expect(kb, `${budget.note}: ${name} is ${kb.toFixed(0)} kB`).toBeLessThan(budget.maxKb)
    }
  })

  it('keeps the preload bundle self-contained', () => {
    const preload = join(ROOT, 'out/preload/index.cjs')
    if (!existsSync(preload)) {
      expect(true, 'no build present').toBe(true)
      return
    }
    const text = readFileSync(preload, 'utf8')
    const requires = [...text.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1])
    // A sandboxed preload cannot require a relative chunk; a shared chunk here
    // would build fine and fail at runtime.
    expect(requires.filter((spec) => spec?.startsWith('.'))).toEqual([])
  })
})

describe('sandbox rules', () => {
  it('creates every web view sandboxed, with context isolation and no Node', () => {
    const tab = readFileSync(join(ROOT, 'src/main/browser/Tab.ts'), 'utf8')
    expect(tab).toMatch(/sandbox:\s*true/)
    expect(tab).toMatch(/contextIsolation:\s*true/)
    expect(tab).toMatch(/nodeIntegration:\s*false/)
    expect(tab).toMatch(/nodeIntegrationInSubFrames:\s*false/)
    expect(tab).toMatch(/webSecurity:\s*true/)
  })

  it('creates the chrome window sandboxed too', () => {
    /*
      In `window-options.ts` now, not in the controller — and the behaviour is asserted by an ordinary
      unit test in `tests/window-options.test.ts`, which is the point of the move: for the whole life of
      the project these three lines could only be checked by reading the source for a pattern.

      This one stays as the *structural* half. Grepping still catches the case a unit test cannot: a
      second `new BrowserWindow` added somewhere with its own inline options, bypassing the function
      those tests cover. That is what the second half below checks.
    */
    const options = readFileSync(join(ROOT, 'src/main/browser/window-options.ts'), 'utf8')
    expect(options).toMatch(/sandbox:\s*true/)
    expect(options).toMatch(/contextIsolation:\s*true/)
    expect(options).toMatch(/nodeIntegration:\s*false/)
  })

  it('builds every browser window through the one options function', async () => {
    // A second `new BrowserWindow({ … })` with its own `webPreferences` would be a window nothing
    // above covers, and it would look perfectly ordinary in review.
    for (const file of await collect('src/main')) {
      const code = codeOnly(file.text)
      const constructions = code.match(/new BrowserWindow\(/g) ?? []
      if (constructions.length === 0) continue
      expect(file.relative).toBe('src/main/browser/BrowserWindowController.ts')
      expect(code, 'must use chromeWindowOptions rather than an inline literal').toMatch(
        /new BrowserWindow\(\s*chromeWindowOptions\(/
      )
    }
  })

  it('keeps the public-suffix table out of the preload', () => {
    /*
      The preload runs in every renderer, so every byte of it is parse work on every page load.

      It carried the whole eTLD list once, and by a route nobody would guess: it imported
      `fingerprint/plan.ts` for a channel name and a type guard, that reaches `seed.ts` — which needs
      `registrableDomain` to derive a per-site seed — and that carries the table. Four kilobytes of
      suffixes the preload never consults, and the size metric had already reached its ceiling because
      of it. The two wire pieces now live in `fingerprint/wire.ts`.

      Checked against the built bundle rather than against imports, because the failure is about what
      ends up in the file: a future import three modules deep would reintroduce it just as invisibly.
    */
    const bundle = join(ROOT, 'out/preload/index.cjs')
    if (!existsSync(bundle)) return // Nothing built; `pnpm build` covers this in CI.
    const text = readFileSync(bundle, 'utf8')
    expect(text, 'the preload must not carry the eTLD list').not.toContain('co.uk')
    // And the thing it *does* need is still there, so this cannot pass by the preload shrinking to
    // nothing.
    expect(text).toContain('tessera:fingerprint-plan')
  })

  it('never enables remote module or insecure content', async () => {
    for (const file of await collect('src/main')) {
      const code = codeOnly(file.text)
      expect(code, file.relative).not.toMatch(/enableRemoteModule:\s*true/)
      expect(code, file.relative).not.toMatch(/allowRunningInsecureContent:\s*true/)
      expect(code, file.relative).not.toMatch(/webSecurity:\s*false/)
      expect(code, file.relative).not.toMatch(/nodeIntegration:\s*true/)
    }
  })

  it('exposes nothing to a renderer without deciding its role first', () => {
    const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
    // Every exposure has to sit behind the role check; an unconditional one would
    // hand the full bridge to a visited page.
    const exposures = [...preload.matchAll(/exposeInMainWorld/g)].length
    expect(exposures).toBeGreaterThan(0)
    expect(preload).toMatch(/if \(role === 'chrome'\)/)
    // The second gate is now which page it is, not merely that it is internal — a bridge built
    // from a page name rather than from a class of page. An unconditional `else` here would hand
    // a visited site whichever allowlist happened to be first.
    expect(preload).toMatch(/else if \(internalPage !== null\)/)
    expect(preload).toMatch(/mayInternalPageInvoke\(internalPage, channel\)/)
  })

  it('defaults an unknown preload role to the restrictive one', () => {
    const preload = readFileSync(join(ROOT, 'src/preload/index.ts'), 'utf8')
    expect(preload).toMatch(/role === 'chrome' \? 'chrome' : 'content'/)
  })

  it('never turns background throttling on for a tab view', () => {
    // Spec 2: unfocused tiles must keep playing. The value is read from settings,
    // so the literal `true` would be a regression.
    const tab = readFileSync(join(ROOT, 'src/main/browser/Tab.ts'), 'utf8')
    expect(tab).not.toMatch(/backgroundThrottling:\s*true/)
    expect(tab).toMatch(/backgroundThrottling:\s*settings\[/)
  })
})

describe('IPC discipline', () => {
  it('gives every shortcut action a menu item that carries its accelerator', () => {
    /*
      An accelerator only fires if a menu item declares it.

      So a `ShortcutAction` with a binding and no item is a shortcut that compiles, shows up in the settings
      list as if it worked, and does nothing at all — which is exactly what happened to `blockElement` until
      this test was written. Nothing else would catch it: the binding table is complete, the action is
      dispatched in the renderer, and the only missing piece is a line in a menu three files away.

      Some actions are deliberately not menu items and are listed here with the reason. Anything else must
      appear in `appMenu.ts`.
    */
    const menu = readFileSync(join(ROOT, 'src/main/menu/appMenu.ts'), 'utf8')
    const bindings = readFileSync(join(ROOT, 'src/shared/shortcuts/bindings.ts'), 'utf8')
    const block = /export const SHORTCUT_ACTIONS = \[([\s\S]*?)\] as const/.exec(bindings)?.[1]
    expect(block, 'could not find SHORTCUT_ACTIONS').toBeDefined()

    /** Actions with no menu item, each for a stated reason. */
    const withoutMenuItem = new Set([
      // Handled in the renderer where the caret is, because spec 9 requires them to leave text editing alone.
      'escape',
      'stop',
      // Tab cycling is positional; a menu item for "next tab" would be a menu item that means something
      // different every time it is read.
      'nextTab',
      'previousTab',
      'lastTab',
      // Split-view layouts and tile moves live in the layout picker, which draws each arrangement.
      'splitLayout1',
      'splitLayout2',
      'splitLayout3',
      'splitLayout4',
      'tileLeft',
      'tileRight',
      'tileUp',
      'tileDown',
      'toggleTileMaximized'
    ])

    const actions = (block?.match(/'([a-zA-Z0-9]+)'/g) ?? []).map((quoted) => quoted.slice(1, -1))
    expect(actions.length).toBeGreaterThan(20)
    for (const action of actions) {
      if (withoutMenuItem.has(action)) continue
      expect(menu, `${action} has a shortcut but no menu item to fire it`).toContain(
        `accel('${action}')`
      )
    }
  })

  it('registers each contract channel exactly once', async () => {
    /*
      Read across the whole `ipc` directory, not just `handlers.ts`.

      Registration used to live in one file, and this test read that one file. It now spreads across
      per-area modules — `permission-handlers.ts`, `media-handlers.ts` — because two of the areas are
      wiring whose shape is the interesting part and needed a seam to be testable against a fake `handle`.
      The moment that happened, a test scanning one file reported a channel as unregistered when it was
      registered perfectly well next door. Concatenating the directory keeps the invariant — exactly one
      handler per channel — without caring where it is written.
    */
    const sources = (await collect('src/main/ipc')).map((file) => file.text).join('\n')
    for (const channel of INVOKE_CHANNELS) {
      const occurrences = [...sources.matchAll(new RegExp(`handle\\('${channel}'`, 'g'))].length
      expect(occurrences, `handler for ${channel}`).toBe(1)
    }
  })

  it('gives every internal page a strict subset of the contract', () => {
    for (const page of INTERNAL_PAGES) {
      const granted = INTERNAL_PAGE_INVOKE_CHANNELS[page] as readonly string[]
      for (const channel of granted) {
        expect(INVOKE_CHANNELS as readonly string[], `${page}: ${channel}`).toContain(channel)
      }
      expect(granted.length, `${page} may call nothing`).toBeGreaterThan(0)
      expect(granted.length, `${page} may call everything`).toBeLessThan(INVOKE_CHANNELS.length)
      // Nothing can render its own text without this one.
      expect(granted, page).toContain('i18n:getCatalog')
    }
  })

  it('keeps the operations that steer the browser away from every internal page', () => {
    /*
      These are the ones a page reached from a link must never have, whatever page it is: closing
      tabs or windows, rearranging the split, drawing on the overlay layer, opening devtools.

      Asked of the union rather than page by page, because the answer has to be "no" for all of
      them — and the union is the only thing that cannot be satisfied by one page happening to
      lack a channel that another has.
    */
    const chromeOnly = [
      'tabs:close',
      'tabs:create',
      'tabs:activate',
      'window:close',
      'window:setOverlay',
      'split:setLayout',
      'split:assignTab',
      'overlay:present',
      'drag:start',
      'devtools:toggle',
      'nav:navigate'
    ]
    const reachable = anyInternalInvokeChannels() as readonly string[]
    for (const channel of chromeOnly) {
      expect(reachable, channel).not.toContain(channel)
    }
  })

  it("does not let one internal page reach another one's operations", () => {
    /*
      The point of doing this per page rather than per class of page. A shared allowlist that had
      to contain `settings:set` for the settings page would have handed it to the start page too —
      and the start page is the one a website can link to most plausibly.
    */
    const forbidden: ReadonlyArray<[string, string]> = [
      ['start', 'settings:set'],
      ['start', 'settings:getAll'],
      ['start', 'history:query'],
      ['start', 'extensions:load'],
      ['settings', 'quicklinks:create'],
      ['settings', 'history:clear'],
      ['settings', 'extensions:load'],
      ['history', 'settings:set'],
      ['history', 'quicklinks:remove'],
      ['extensions', 'settings:set'],
      ['extensions', 'history:query']
    ]
    for (const [page, channel] of forbidden) {
      expect(mayInternalPageInvoke(page, channel), `${page} reaches ${channel}`).toBe(false)
    }
  })

  it('calls ipcMain.handle only through the validating router', async () => {
    for (const file of await collect('src/main')) {
      if (file.relative.endsWith('ipc/router.ts')) continue
      const code = codeOnly(file.text)
      expect(code, `${file.relative} bypasses the router`).not.toMatch(/ipcMain\.handle\(/)
      expect(code, `${file.relative} uses an unvalidated channel`).not.toMatch(/ipcMain\.on\(/)
    }
  })

  it('checks the sender before dispatching', () => {
    const router = readFileSync(join(ROOT, 'src/main/ipc/router.ts'), 'utf8')
    const accessIndex = router.indexOf('decideAccess')
    const parseIndex = router.indexOf('definition.request.safeParse')
    expect(accessIndex).toBeGreaterThan(-1)
    // Who is calling, before what they are asking for.
    expect(accessIndex).toBeLessThan(parseIndex)
  })

  it('registers one webRequest listener per event', async () => {
    // Electron keeps a single listener per webRequest event: a second registration
    // silently replaces the first, which is how a filter stops working with no
    // error at all.
    const files = await collect('src/main')
    const events = ['onBeforeRequest', 'onBeforeSendHeaders', 'onHeadersReceived']
    for (const event of events) {
      const registrations = files.flatMap((file) =>
        [...file.text.matchAll(new RegExp(`webRequest\\.${event}\\(`, 'g'))].map(() => file.relative)
      )
      // `RequestPipeline` registers `onBeforeRequest` twice: once to install and
      // once with null to remove it.
      const expected = event === 'onBeforeRequest' ? 2 : 1
      expect(registrations.length, `${event} registered in ${registrations.join(', ')}`).toBe(expected)
    }
  })
})

describe('internationalisation', () => {
  it('has no user-visible string literal in a component', async () => {
    // Spec 7 forbids hard-coded text. JSX text nodes are the usual leak.
    const components = (await collect('src/renderer')).filter((file) => file.path.endsWith('.tsx'))
    expect(components.length).toBeGreaterThan(0)

    for (const file of components) {
      // Text between tags, ignoring entities, single glyphs and interpolations.
      const textNodes = [...file.text.matchAll(/>\s*([A-Za-z][A-Za-z ,.'-]{4,})\s*</g)]
      const suspicious = textNodes
        .map((match) => match[1]!.trim())
        .filter((text) => !text.startsWith('t(') && text.split(' ').length > 1)
      expect(suspicious, `${file.relative} has untranslated text`).toEqual([])
    }
  })

  it('routes every visible label through the translator', async () => {
    const components = (await collect('src/renderer')).filter(
      (file) => file.path.endsWith('.tsx') && !file.path.endsWith('main.tsx')
    )
    for (const file of components) {
      const labels = [...file.text.matchAll(/aria-label=\{?"([^"]+)"/g)].map((m) => m[1])
      expect(labels, `${file.relative} has a literal aria-label`).toEqual([])
    }
  })
})

describe('window layering', () => {
  /**
   * The rule this protects: browser UI that has to appear *over* page content belongs to
   * the overlay surface, never to the chrome components.
   *
   * The chrome renderer is the window's bottom layer — tab content is drawn by native
   * views stacked on top of it, and those are opaque to hit testing as well as to the
   * eye. A dropdown rendered in a chrome component is therefore painted behind the page
   * and receives no clicks, while looking perfectly correct to every DOM query. That is
   * exactly how one shipped. See
   * `docs/solutions/ui-issues/chrome-popups-behind-content-views.md`.
   */
  const OVER_CONTENT_MARKERS = [
    { pattern: /role="menu"/, what: 'a menu container' },
    { pattern: /role="menuitem/, what: 'a menu item' },
    { pattern: /className="menu\b/, what: 'menu styling' }
  ]

  it('keeps over-content UI out of the chrome components', async () => {
    const components = (await collect('src/renderer/src/components')).filter((file) =>
      file.path.endsWith('.tsx')
    )
    expect(components.length, 'expected chrome components to scan').toBeGreaterThan(0)

    for (const file of components) {
      for (const { pattern, what } of OVER_CONTENT_MARKERS) {
        expect(
          pattern.test(file.text),
          `${file.relative} renders ${what}; it would be drawn behind the tab views. ` +
            'Present it on the overlay surface instead (src/renderer/src/surfaces).'
        ).toBe(false)
      }
    }
  })

  it('has an overlay surface that renders the menus instead', async () => {
    const surfaces = (await collect('src/renderer/src/surfaces')).filter((file) =>
      file.path.endsWith('.tsx')
    )
    expect(surfaces.length, 'expected an overlay surface to exist').toBeGreaterThan(0)
    const combined = surfaces.map((file) => file.text).join('\n')
    expect(combined, 'no surface renders a menu').toMatch(/role="menu"/)
  })

  it('adds tab views beneath the overlay layer', () => {
    // Appending a tab view would stack it *above* the overlay, and the newest tab would
    // then swallow every click meant for a menu.
    const controller = readFileSync(
      join(ROOT, 'src/main/browser/BrowserWindowController.ts'),
      'utf8'
    )
    expect(codeOnly(controller), 'a tab view is added without an explicit index').toMatch(
      /addChildView\(tab\.view,\s*0\)/
    )
  })

  it('keeps the overlay layer transparent so pages stay visible behind a menu', () => {
    const layer = readFileSync(join(ROOT, 'src/main/browser/OverlayLayer.ts'), 'utf8')
    // Electron parses hex alpha as AARRGGBB, alpha first. Getting that backwards yields
    // opaque black, which would paint over every page. The literal is the subject of this
    // check, so comments are stripped but strings are kept.
    expect(withoutComments(layer), 'the overlay layer has no transparent background').toMatch(
      /setBackgroundColor\('#00000000'\)/
    )
  })
})

describe('content security', () => {
  it('gives every HTML entry a policy', async () => {
    const pages = await collect('src/renderer', ['.html'])
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages) {
      expect(page.text, `${page.relative} has no CSP`).toMatch(/Content-Security-Policy/)
      // Bounded to the directive: `[^"]*` ran past the semicolon and matched the
      // 'unsafe-inline' belonging to style-src.
      expect(page.text, `${page.relative} allows inline script`).not.toMatch(
        /script-src[^;"]*'unsafe-inline'/
      )
      // style-src does allow inline, and that is a deliberate, narrow exception:
      // React writes element styles as attributes. It is called out here so the
      // exception stays visible rather than becoming folklore.
      expect(page.text, `${page.relative} should scope inline to styles only`).toMatch(
        /style-src[^;"]*'unsafe-inline'/
      )
      expect(page.text, `${page.relative} allows eval`).not.toMatch(/'unsafe-eval'/)
      expect(page.text, `${page.relative} allows any object`).toMatch(/object-src 'none'/)
    }
  })

  it('serves every page the privilege table names', () => {
    /*
      Two lists, in two files, that have to agree.

      `INTERNAL_PAGES` in `channels.ts` says which pages exist for the purpose of *privileges*;
      `KNOWN_PAGES` in `protocol.ts` says which addresses are *served*. `extensions` was in the first and
      not the second, so it had four channels granted to it and a 404 at its address — a page that was
      allowed to do things and could not be opened. Neither file's own tests could see that.
    */
    const channels = readFileSync(join(ROOT, 'src/shared/ipc/channels.ts'), 'utf8')
    const protocol = readFileSync(join(ROOT, 'src/main/protocol.ts'), 'utf8')
    const declared = /export const INTERNAL_PAGES = \[([\s\S]*?)\] as const/.exec(channels)?.[1]
    expect(declared, 'could not find INTERNAL_PAGES').toBeDefined()

    const pages = (declared?.match(/'([a-z-]+)'/g) ?? []).map((quoted) => quoted.slice(1, -1))
    expect(pages.length).toBeGreaterThan(2)
    const served = /const KNOWN_PAGES = new Set\(\[([\s\S]*?)\]\)/.exec(protocol)?.[1] ?? ''
    for (const page of pages) {
      expect(served, `${page} is privileged but not served`).toContain(`'${page}'`)
    }
  })

  it('lets the start page reach no remote origin at all', () => {
    // Spec 1: favicons come from the local cache, never from a service on every
    // visit. A policy that permits no external origin makes that structural.
    const start = readFileSync(join(ROOT, 'src/renderer/internal/start.html'), 'utf8')
    expect(start).toMatch(/default-src 'none'/)
    expect(start).toMatch(/connect-src 'none'/)
    expect(start).not.toMatch(/https:/)
  })
})

describe('privacy invariants', () => {
  it('flushes every store that can buffer a write before the process exits', async () => {
    /*
      This test exists because the shutdown path was already wrong in four places at once.

      History, favicons, thumbnails and tab groups each arrived with a `flush()` and none was added to
      `before-quit`, so anything they had buffered when the user chose Quit was lost to a debounce timer
      that never fired — a visit from thirty seconds ago simply was not in the file. Nothing made that
      visible: the omission was in a different part of a different file from the store being added.

      Matched on the class name appearing in a `flushOnExit.push` line rather than on a count, so a
      fifth store cannot pass by coincidence.
    */
    const entry = readFileSync(join(ROOT, 'src/main/index.ts'), 'utf8')
    // The arrow's own `()` is why this matches the whole `push(() => name.` shape rather than
    // "anything up to a bracket": the first `)` is inside the arrow, not at the end of the call.
    const registered = [
      ...entry.matchAll(/flushOnExit\.push\(\(\)\s*=>\s*(\w+)\??\.(?:flush|whenIdle)\(/g)
    ].map((match) => match[1])
    expect(registered.length, 'expected stores to register for shutdown').toBeGreaterThan(3)

    let checked = 0
    for (const file of await collect('src/main/data')) {
      // Only classes that buffer, and only ones the entry point opens. A file's *first* exported class
      // is not necessarily the store — `JsonStore.ts` leads with an error type — so the names are taken
      // from every `export class …Store` in the file, and `JsonStore` itself is the mechanism the others
      // are built on rather than something `index.ts` holds.
      const stores = [...file.text.matchAll(/export class (\w+Store)\b/g)]
        .map((match) => match[1])
        .filter((name) => name !== 'JsonStore')
      if (stores.length === 0) continue
      if (!/^\s{2}(?:async )?flush\(/m.test(file.text)) continue

      for (const store of stores) {
        // The variable in `index.ts` is the store's name with a lower-case first letter, or a plural of
        // it; matching case-insensitively on the stem catches a store nobody registered.
        const stem = (store ?? '').replace(/Store$/, '').toLowerCase()
        const found = registered.some((name) => (name ?? '').toLowerCase().startsWith(stem))
        expect(found, `${store ?? ''} has a flush() but nothing registers it in index.ts`).toBe(true)
        checked += 1
      }
    }
    expect(checked, 'expected to have checked several stores').toBeGreaterThan(3)
  })

  it('never starts the crash reporter', async () => {
    // Spec 4 and 8: no crash reports. Scanned on code only — the comment in
    // `main/index.ts` that documents the deliberate absence would otherwise fail
    // this test, which is how a fitness function gets weakened into uselessness.
    for (const file of await collect('src/main')) {
      expect(codeOnly(file.text), file.relative).not.toMatch(/crashReporter\s*\.\s*start/)
    }
  })

  it('keeps the search default on a privacy-friendly engine', () => {
    const definitions = readFileSync(join(ROOT, 'src/shared/settings/definitions.ts'), 'utf8')
    expect(definitions).toMatch(/'search\.defaultEngine':\s*def\([^)]*'duckduckgo'/s)
  })

  it('declares a colour token for every tab-group slot', () => {
    /*
      A slot with no token paints `var(--tab-group-teal)` — which resolves to nothing, so the chip
      draws with no colour at all and looks like a bug in the group rather than a missing line in a
      stylesheet. Nothing else would catch it: the palette compiles, the CSS parses, and the group
      works in every respect except being visible.
    */
    const palette = readFileSync(join(ROOT, 'src/shared/tabgroups/palette.ts'), 'utf8')
    const tokens = readFileSync(join(ROOT, 'src/renderer/src/tokens.css'), 'utf8')
    const block = /export const TAB_GROUP_COLORS = \[([\s\S]*?)\] as const/.exec(palette)?.[1]
    expect(block, 'could not find TAB_GROUP_COLORS').toBeDefined()
    const slots = (block?.match(/'([a-z]+)'/g) ?? []).map((quoted) => quoted.slice(1, -1))
    expect(slots.length).toBeGreaterThan(1)
    for (const slot of slots) {
      expect(tokens, slot).toContain(`--tab-group-${slot}:`)
    }
  })

  it('fetches no favicon from a remote host', async () => {
    // The URLs are recorded; nothing may retrieve them until the local cache
    // exists, or the feature would leak the favourites it is meant to protect.
    for (const file of await collect('src/main')) {
      expect(codeOnly(file.text), file.relative).not.toMatch(/fetch\(\s*favicon/i)
    }
  })
})

describe('resource discipline', () => {
  it('pairs every event subscription with a way off', async () => {
    // Spec 6: nothing may stay attached when a view closes.
    const files = (await collect('src/main')).filter((file) =>
      /window\.on\(|emitter\.on\(/.test(file.text)
    )
    for (const file of files) {
      expect(file.text, `${file.relative} subscribes without removing`).toMatch(/removeListener/)
    }
  })

  it('cleans up every renderer subscription', async () => {
    // Only callers, not the module that defines the helper: `bridge.ts` exports
    // `subscribe` and returns the preload's own unsubscribe, so requiring the word
    // there measured nothing.
    const callers = (await collect('src/renderer')).filter((file) => {
      const code = codeOnly(file.text)
      const calls = /(?:^|[^.\w])subscribe(?:QuickLinks)?\(/.test(code)
      const defines = code.includes('export function subscribe')
      return calls && !defines
    })

    expect(callers.length, 'expected at least one subscribing component').toBeGreaterThan(0)
    for (const file of callers) {
      // Two valid shapes: name the unsubscribe and call it in the cleanup, or
      // return the subscription straight out of the effect so React calls it. The
      // second is idiomatic and just as correct, so requiring the word
      // "unsubscribe" would have pushed App.tsx towards a worse spelling.
      const cleansUp =
        /unsubscribe|unsubscribers/.test(file.text) ||
        /return\s+subscribe(?:QuickLinks)?\(/.test(codeOnly(file.text))
      expect(cleansUp, `${file.relative} subscribes without cleaning up`).toBe(true)
    }
  })
})

describe('product identity', () => {
  /**
   * `tessera` is a working title, so the rename has to be cheap and provable.
   *
   * The scheme is the expensive half: it is not only a string but the address of every internal
   * page, so once a bookmark or a history entry points at `tessera://history`, changing it
   * breaks saved user data. These checks keep it in one place while that is still true.
   */
  const IDENTITY = 'src/shared/product.ts'

  it('defines the name, the scheme and the application id in one place', () => {
    const source = readFileSync(join(ROOT, IDENTITY), 'utf8')
    for (const name of ['PRODUCT_NAME', 'PRODUCT_SCHEME', 'APP_ID', 'INTERNAL_SCHEME']) {
      expect(source, `${IDENTITY} does not export ${name}`).toMatch(
        new RegExp(`export (const|function) ${name}\\b`)
      )
    }
  })

  /**
   * Files that still spell the scheme out, each with its reason.
   *
   * Named individually so the list can only shrink: adding an entry means writing down why. An
   * exception nobody has to justify becomes the rule.
   *
   * `RequestPipeline.ts` builds the HTTPS-only interstitial address by hand and should use
   * `internalUrl('https-only', { target })`. It is being edited by other work in flight.
   */
  const SCHEME_DEBT = new Set(['src/main/privacy/RequestPipeline.ts'])

  it('spells the internal URL scheme nowhere else', async () => {
    // Comments are stripped but string literals are kept: the literal *is* the subject here.
    for (const file of [...(await collect('src/shared')), ...(await collect('src/main'))]) {
      if (file.relative === IDENTITY) continue
      if (SCHEME_DEBT.has(file.relative)) continue
      /*
        Two precise forms rather than one loose prefix: the scheme as a URL, and the bare scheme
        as `URL.protocol` reports it. A looser pattern also flagged an operating-system keychain
        label that happens to start with the product name — a false positive teaches people to
        weaken the check, which is worse than not having it.
      */
      const code = withoutComments(file.text)
      const complaint =
        `${file.relative} hard-codes the internal URL scheme; build it with internalUrl() or ` +
        'compare against INTERNAL_SCHEME from shared/product.ts'
      expect(code, complaint).not.toMatch(/['"`]tessera:\/\//)
      expect(code, complaint).not.toMatch(/['"`]tessera:['"`]/)
    }
  })

  it('keeps the list of files that still spell out the scheme from growing', () => {
    // The point of the list is that it shrinks. This asserts its current size so an addition is
    // a deliberate, visible act rather than a quiet one.
    expect([...SCHEME_DEBT]).toEqual(['src/main/privacy/RequestPipeline.ts'])
  })

  it('keeps the product name out of translated sentences', () => {
    // A literal in prose means the rename has to edit two languages of copy, where a
    // search-and-replace also hits the word in sentences that were never about the product.
    // `{app}` is filled by `interpolate`, which always has the name available.
    const catalog = readFileSync(join(ROOT, 'src/shared/i18n/catalog.ts'), 'utf8')
    const inMessages = [...catalog.matchAll(/'[^']*tessera[^']*'/g)].map((match) => match[0])
    expect(inMessages, 'the catalogue still names the product directly').toEqual([])
  })
})
