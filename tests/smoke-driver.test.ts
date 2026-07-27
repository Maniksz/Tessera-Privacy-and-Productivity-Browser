import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error the check harness is plain ESM, deliberately outside both TypeScript programs so
// that none of it can be bundled into the main process; there is no declaration file to import.
import { mouse } from '../scripts/smoke-driver.mjs'

/**
 * The mouse events the check harness sends have to be ones Electron actually accepts.
 *
 * What breaks if this is wrong is not a feature but the only evidence this project has that its
 * features work in a real window. `sendInputEvent` does not validate: a modifier it does not recognise
 * is ignored, a type it does not recognise produces no event at all, and both fail *silently*. A drag
 * whose move event lost its held button is a hover, so the drop indicator never highlights and two
 * dozen checks report that the split view is broken when the harness simply stopped driving it.
 *
 * The encoding differs from the `Input.dispatchMouseEvent` this replaced in exactly the ways that are
 * easy to get wrong from memory — `mouseDown` not `mousePressed`, a modifier instead of a `buttons`
 * bitmask, and lower case where the prose spells it `leftButtonDown` — so the allowed values are read
 * out of the installed `electron.d.ts` rather than written down here. That file is generated from the
 * same documentation the native converter is written against, and it is the copy this build ships.
 */

const TYPINGS = readFileSync(join(process.cwd(), 'node_modules/electron/electron.d.ts'), 'utf8')

/** The union of one optional or required field of one interface, as the typings declare it. */
function declaredUnion(interfaceName: string, field: string): string[] {
  const block = new RegExp(`interface ${interfaceName}[^{]*\\{([\\s\\S]*?)\\n  \\}`).exec(TYPINGS)
  expect(block, `${interfaceName} is not in electron.d.ts`).not.toBeNull()
  const declaration = new RegExp(`\\n    ${field}\\??:([^;]*);`).exec(block?.[1] ?? '')
  expect(declaration, `${interfaceName}.${field} is not in electron.d.ts`).not.toBeNull()
  return [...(declaration?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '')
}

const EVENT_TYPES = declaredUnion('MouseInputEvent', 'type')
const MODIFIERS = declaredUnion('InputEvent', 'modifiers')

describe('the shapes read out of the shipped typings', () => {
  it('found both unions, so the assertions below are not vacuous', () => {
    // Without this, a change to the format of `electron.d.ts` would leave both lists empty and every
    // check below would pass by having nothing to compare against.
    expect(EVENT_TYPES).toContain('mouseDown')
    expect(MODIFIERS).toContain('shift')
  })
})

describe('the mouse events the harness sends', () => {
  const gesture = [
    ['down', mouse('down', 10, 20)],
    ['move', mouse('move', 10, 20)],
    ['up', mouse('up', 10, 20)]
  ] as const

  for (const [name, event] of gesture) {
    it(`gives ${name} a type Electron recognises`, () => {
      // A type outside the union produces no event: the press never happens and the drag checks fail
      // as if the tab strip had no pointer handlers.
      expect(EVENT_TYPES).toContain(event.type)
    })

    it(`gives ${name} only modifiers Electron recognises`, () => {
      // The trap this catches: the documentation prose says `leftButtonDown`, the converter compares
      // against `leftbuttondown`, and the wrong casing is discarded without a word.
      for (const modifier of event.modifiers ?? []) expect(MODIFIERS).toContain(modifier)
    })

    it(`gives ${name} integer coordinates`, () => {
      // The typings say Integer, and the drag sweep aims at the centre of a hit rectangle — an odd
      // width makes that a fraction, which is the one place this arises in practice.
      expect(Number.isInteger(event.x) && Number.isInteger(event.y)).toBe(true)
    })
  }

  it('holds the left button down while moving', () => {
    /*
      What makes a move part of a drag rather than a hover. `event.buttons` in the page is computed
      from this modifier, and the protocol call this replaced said the same thing with `buttons: 1` —
      a bitmask, which is why translating it by copying the field name would have produced a hover.
    */
    expect(mouse('move', 1, 2).modifiers).toContain('leftbuttondown')
  })

  it('counts the click on the press and the release', () => {
    // Blink derives a click from the count; at zero the press and release are delivered and no click
    // follows, so every check that opens a menu by clicking reports a dead button.
    expect(mouse('down', 1, 2).clickCount).toBe(1)
    expect(mouse('up', 1, 2).clickCount).toBe(1)
  })

  it('names the button, so a left-handed default cannot decide it', () => {
    // The tab strip starts a drag for `button === 0` only; an unnamed button arrives as none.
    for (const [, event] of gesture) expect(event.button).toBe('left')
  })

  it('refuses a gesture it has no encoding for', () => {
    /*
      Rather than returning an event with `type: undefined`, which `sendInputEvent` would accept and
      quietly do nothing with — the failure would surface as a zone that never highlighted, several
      hundred lines away from the typo that caused it.
    */
    expect(() => {
      mouse('mousePressed', 1, 2)
    }).toThrow(/unknown mouse event/)
  })
})
