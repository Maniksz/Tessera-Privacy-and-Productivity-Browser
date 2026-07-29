import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
  `.panel` is styled twice: once as the floating panel it was built as, and once as the whole page it
  is on `tessera://settings` and `tessera://extensions`. The second is written as an override block in
  `panel-page.css`, which means the correctness of the page depends on that block staying complete.

  It was not complete, and the way it failed is the reason this file exists. `.panel` carries
  `overflow: hidden`, because a panel clips its own scrolling body; the override undid the height and
  left the clipping, so the settings page drew every row and then cut off everything past the fold —
  unscrollable, because the document never grew to contain it. Nothing failed: not the type checker,
  not a component test, because happy-dom computes no layout and never sees a clipped box.

  A declaration added to `.panel` from now on is either undone for the page or named below with a
  reason. There is no third option, and this test is what makes that true.
*/

const CSS_DIR = join(process.cwd(), 'src/renderer')

function declaredProperties(css: string, selector: string): string[] {
  // Deliberately simple: these two rules are hand-written, flat and in this repository. A CSS parser
  // would be a dependency to read nine lines whose shape is known.
  const start = css.indexOf(`${selector} {`)
  if (start === -1) throw new Error(`no rule for \`${selector}\` — has it been renamed?`)
  const end = css.indexOf('}', start)
  return css
    .slice(css.indexOf('{', start) + 1, end)
    .split(';')
    .map((line) => line.split(':')[0]?.trim() ?? '')
    .filter((name) => name.length > 0 && !name.startsWith('/*'))
}

/**
 * Properties `.panel` sets that the page deliberately leaves alone, and why.
 *
 * Only ever things that stop meaning anything once the override has done its work — not things that
 * are merely thought to be harmless.
 */
const NOT_UNDONE: Readonly<Record<string, string>> = {
  // The override sets `display: block`, so the panel is no longer a flex container and the direction
  // of an axis it does not have cannot apply. Undoing it as well would be a rule with no effect.
  'flex-direction': 'the override replaces `display: flex`, which is what gave this meaning'
}

describe('the panel, hosted as a page', () => {
  it('undoes every part of the floating geometry, or says why not', () => {
    const chrome = readFileSync(join(CSS_DIR, 'src/styles.css'), 'utf8')
    const page = readFileSync(join(CSS_DIR, 'internal/panel-page.css'), 'utf8')

    const asPanel = declaredProperties(chrome, '.panel')
    const asPage = new Set(declaredProperties(page, '.panelPage .panel'))

    const missing = asPanel.filter((name) => !asPage.has(name) && !(name in NOT_UNDONE))
    expect(
      missing,
      'these are set on the floating panel and left standing on the page, which is how the settings page became unscrollable'
    ).toEqual([])
  })

  it('lets the document scroll rather than clipping inside the panel', () => {
    const page = readFileSync(join(CSS_DIR, 'internal/panel-page.css'), 'utf8')
    const overrides = declaredProperties(page, '.panelPage .panel')

    // The two the page cannot do without, asserted by name: a later edit that drops one would
    // otherwise leave the block "complete" against a `.panel` that no longer sets it.
    expect(overrides, 'without this the panel keeps clipping its own content').toContain('overflow')
    expect(overrides, 'a page is normal flow, not a column sized to a window').toContain('display')
  })

  it('keeps every claim in the exemption list earned', () => {
    // A property that leaves `.panel` must leave this list with it, or the next real omission is
    // waved through by a name that no longer refers to anything.
    const chrome = readFileSync(join(CSS_DIR, 'src/styles.css'), 'utf8')
    const asPanel = new Set(declaredProperties(chrome, '.panel'))

    for (const name of Object.keys(NOT_UNDONE)) {
      expect(asPanel.has(name), `\`${name}\` is exempted but \`.panel\` no longer sets it`).toBe(true)
    }
  })
})
