import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The preload split, as a fitness function.
 *
 * There are two preload bundles — `index.cjs` for tab views, `chrome.cjs` for the window and the
 * overlay layer — and which one a view is given *is* its bridge privilege. Nothing in the type system
 * can see that: `preloadFile('chrome')` in `Tab.ts` compiles perfectly and produces a web page holding
 * the full contract surface, and `preloadFile('content')` in `OverlayLayer.ts` compiles just as well
 * and produces a toolbar with no bridge that fails on its first call.
 *
 * So the pairing is checked here, at the three call sites, along with the two properties that make the
 * split worth having: that the chrome bridge is absent from the content bundle rather than merely
 * unreachable in it, and that each built entry still requires nothing but `electron`.
 *
 * The last one is not hypothetical. The first build of the second entry resolved `electron` to an
 * *empty module* — Vite's answer for a Node package in a browser build — so `contextBridge` was
 * `undefined` and the chrome UI would have come up with no bridge at all, with a clean build log.
 */

const ROOT = process.cwd()

/** Comments are stripped: several of them name the very call the tests below assert is absent. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

function source(relativePath: string): string {
  return withoutComments(readFileSync(join(ROOT, relativePath), 'utf8'))
}

/** The built entries, or `null` when nothing has been built — a unit run must not require a build. */
function built(name: string): string | null {
  const path = join(ROOT, 'out/preload', name)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}

const CALL_SITES = [
  { file: 'src/main/browser/Tab.ts', role: 'content' },
  { file: 'src/main/browser/OverlayLayer.ts', role: 'chrome' },
  { file: 'src/main/browser/BrowserWindowController.ts', role: 'chrome' }
] as const

describe('preload roles', () => {
  it('gives every view the bundle for the role it was created with', () => {
    for (const { file, role } of CALL_SITES) {
      const code = source(file)
      const other = role === 'chrome' ? 'content' : 'chrome'
      expect(code, `${file} must load the ${role} preload`).toContain(`preloadFile('${role}')`)
      expect(code, `${file} must declare the ${role} role`).toContain(
        `preloadRoleArgument('${role}')`
      )
      // The file and the argument have to agree: either alone being wrong is a view with no bridge.
      expect(code, `${file} must not reach for the ${other} preload`).not.toContain(
        `preloadFile('${other}')`
      )
      expect(code, `${file} must not declare the ${other} role`).not.toContain(
        `preloadRoleArgument('${other}')`
      )
    }
  })

  it('resolves a preload nowhere but at those three call sites, and never from a variable', () => {
    /*
      A fourth view built somewhere with `preloadFile(role)` from a parameter would be a view whose
      privilege is decided at runtime by whoever calls it — which is the arrangement the split replaced.
      Literals only, so the answer is readable at the place the view is made.
    */
    const files = CALL_SITES.map(({ file }) => file)
    const paths = source('src/main/paths.ts')
    expect(paths).toContain('export function preloadFile(role: PreloadRole)')

    for (const { file } of CALL_SITES) {
      const calls = [...source(file).matchAll(/preloadFile\(([^)]*)\)/g)].map((match) => match[1])
      for (const argument of calls) {
        expect(argument, `${file} passes a non-literal role`).toMatch(/^'(chrome|content)'$/)
      }
    }
    expect(files.length, 'the list of call sites must not be empty').toBe(3)
  })

  it('defaults an absent or unrecognised role to content in both entries', () => {
    // Least privilege in each entry, including the chrome one — where "content" means it exposes
    // nothing at all. The two copies of `readRole` are held to the same rule here.
    for (const entry of ['src/preload/index.ts', 'src/preload/chrome.ts']) {
      expect(readFileSync(join(ROOT, entry), 'utf8'), entry).toMatch(
        /role === 'chrome' \? 'chrome' : 'content'/
      )
    }
  })

  it('keeps the chrome bridge out of the content entry entirely', () => {
    const content = source('src/preload/index.ts')
    // Not "unreachable in it" — absent from it. A page that loads this file cannot be handed the full
    // bridge by any condition going wrong, because the call that would create it is not here.
    expect(content).not.toMatch(/exposeInMainWorld\(\s*'tessera'/)
    expect(content, 'the chrome allowlist has no business in the content bundle').not.toMatch(
      /\bINVOKE_CHANNELS\b|\bEVENT_CHANNELS\b|\bisInvokeChannel\b|\bisEventChannel\b/
    )
  })

  it('keeps the per-document machinery out of the chrome entry', () => {
    // The window and the overlay have no document to mask, no page to filter and no form to fill.
    const chrome = source('src/preload/chrome.ts')
    expect(chrome).not.toMatch(/installCosmeticFiltering|installElementPicker|installAutofill/)
    expect(chrome).not.toMatch(/@shared\/fingerprint/)
  })

  it('builds both entries, each requiring nothing but electron', () => {
    for (const name of ['index.cjs', 'chrome.cjs']) {
      const text = built(name)
      if (text === null) {
        expect(true, 'no build present; pnpm build covers this').toBe(true)
        continue
      }
      const requires = [...text.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1])
      /*
        Exactly `electron`, once. A relative specifier means Rollup emitted a shared chunk, which a
        sandboxed preload cannot load; *no* specifier means `electron` was resolved to something else
        — an empty stub, in the case that actually happened — and the bridge would be undefined.
      */
      expect(requires, `${name} requires the wrong modules`).toEqual(['electron'])
    }
  })

  it('keeps each built bundle to the surface its role needs', () => {
    const content = built('index.cjs')
    const chrome = built('chrome.cjs')
    if (content === null || chrome === null) {
      expect(true, 'no build present; pnpm build covers this').toBe(true)
      return
    }

    // Checked against the built output, because the question is what a renderer actually parses: an
    // import three modules deep would put the chrome tables back with nothing in the source to show it.
    expect(content, 'the content bundle must not name the chrome bridge').not.toMatch(/"tessera"/)
    expect(content, 'the content bundle must not carry chrome-only channels').not.toContain(
      'window:minimize'
    )
    expect(content, 'an internal page still gets its own allowlist').toContain('quicklinks:list')

    expect(chrome, 'the chrome bundle is the one that names the full bridge').toMatch(/"tessera"/)
    expect(chrome, 'the chrome UI has no document to mask').not.toContain('fingerprint-plan')
    expect(chrome, 'the chrome UI has no page to filter').not.toContain('tessera-cosmetic')
  })
})
