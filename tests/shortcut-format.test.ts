import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BINDINGS,
  KNOWN_CONFLICTS,
  SHORTCUT_ACTIONS,
  TAB_BY_INDEX_ACCELERATORS,
  allAcceleratorsFor,
  acceleratorFor
} from '@shared/shortcuts/bindings.js'
import { formatAccelerator, shortcutTitles } from '@shared/shortcuts/format.js'
import type { Platform } from '@shared/model.js'

/**
 * Accelerators printed for a person.
 *
 * What breaks if this is wrong: a tooltip that names a key nobody can find. `bindings.ts` writes
 * Electron's argument strings — `Control+numadd`, `Command+Shift+Return`, `Command+[` — and a button
 * that offered those verbatim would be worse than one offering nothing, because it looks like an
 * answer. A shortcut nobody recognises is the failure mode, so the expectations below are named one by
 * one against the conventions of each platform rather than derived from the implementation.
 *
 * Two of these tests are fitness functions rather than examples, and they are the ones that will
 * actually fail one day: `knows every key the binding tables write down` breaks when a new binding
 * uses a key the formatter has not been taught, and `prints every macOS key as a single glyph` breaks
 * when a key that has no Apple symbol is printed as a word — which, with no separator between
 * modifiers on macOS, comes out as `SuperT` rather than as a shortcut.
 */

const PLATFORMS: readonly Platform[] = ['win32', 'linux', 'darwin']

/** Every accelerator string this project writes down, as its individual `+`-separated tokens. */
function everyToken(): Set<string> {
  const tokens = new Set<string>()
  const add = (accelerator: string): void => {
    for (const token of accelerator.split('+')) tokens.add(token)
  }
  for (const platform of PLATFORMS) {
    for (const action of SHORTCUT_ACTIONS)
      for (const a of allAcceleratorsFor(platform, action)) add(a)
    for (const a of TAB_BY_INDEX_ACCELERATORS[platform]) add(a)
    // The alternatives offered when the OS eats a binding are shown to the user too.
    for (const conflict of KNOWN_CONFLICTS[platform]) add(conflict.alternative)
  }
  return tokens
}

describe('printing one accelerator on Windows and Linux', () => {
  /*
    Words joined by `+`, ordered Ctrl, Alt, Shift — the order `Ctrl+Alt+Delete` and `Ctrl+Shift+Esc`
    are already written in, and the order every entry in the two PC tables already uses.
  */
  const cases: ReadonlyArray<[string, string]> = [
    ['Control+T', 'Ctrl+T'],
    ['Control+Shift+T', 'Ctrl+Shift+T'],
    ['Control+Shift+E', 'Ctrl+Shift+E'],
    ['Alt+Left', 'Alt+Left'],
    ['Alt+Right', 'Alt+Right'],
    ['Alt+Home', 'Alt+Home'],
    ['Alt+F4', 'Alt+F4'],
    ['F5', 'F5'],
    ['F12', 'F12'],
    ['Control+Alt+Left', 'Ctrl+Alt+Left'],
    ['Control+9', 'Ctrl+9'],
    ['Control+0', 'Ctrl+0'],
    ['Control+,', 'Ctrl+,'],
    ['Control+Tab', 'Ctrl+Tab'],
    ['Control+Shift+Delete', 'Ctrl+Shift+Delete'],
    // The keycap says Esc and Enter, not Escape and Return.
    ['Escape', 'Esc'],
    ['Control+Shift+Return', 'Ctrl+Shift+Enter'],
    ['Control+PageDown', 'Ctrl+Page Down'],
    ['Control+PageUp', 'Ctrl+Page Up'],
    // `Plus` is Electron's way of writing the character that would otherwise split the string.
    ['Control+Plus', 'Ctrl++'],
    ['Control+-', 'Ctrl+-'],
    // The keypad, marked: `zoomIn` binds `Control+Plus` *and* `Control+numadd`, and they are two
    // different keys. Unmarked, the second would print as the first and name the wrong one.
    ['Control+numadd', 'Ctrl+Num +'],
    ['Control+numsub', 'Ctrl+Num -']
  ]

  for (const [accelerator, expected] of cases) {
    it(`writes ${accelerator} as ${expected}`, () => {
      expect(formatAccelerator('win32', accelerator)).toBe(expected)
      // Linux prints the same way; only the bindings differ.
      expect(formatAccelerator('linux', accelerator)).toBe(expected)
    })
  }

  it('normalises the order of modifiers, so a hand-typed override still reads right', () => {
    // Overrides are a free-form record in the settings file; nothing makes the user write Ctrl first.
    expect(formatAccelerator('win32', 'Shift+Control+R')).toBe('Ctrl+Shift+R')
    expect(formatAccelerator('win32', 'Shift+Alt+Control+R')).toBe('Ctrl+Alt+Shift+R')
  })

  it('resolves CommandOrControl to the key this platform actually uses', () => {
    // `advanced.customShortcuts` is a free-form `Record<string, string>`, so Electron's portable
    // spelling can reach here even though the binding tables never use it.
    expect(formatAccelerator('win32', 'CommandOrControl+Shift+1')).toBe('Ctrl+Shift+1')
    expect(formatAccelerator('win32', 'CmdOrCtrl+P')).toBe('Ctrl+P')
  })

  it('prints the Windows key by the name on it', () => {
    expect(formatAccelerator('win32', 'Super+Left')).toBe('Win+Left')
    expect(formatAccelerator('win32', 'Meta+Left')).toBe('Win+Left')
  })

  it('does not pretend a macOS-only modifier is Ctrl', () => {
    /*
      `Command` fires nothing on Windows. Folding it into Ctrl would print a working shortcut for a
      binding that cannot work, which is the one thing a tooltip must never do — so it keeps its own
      name and the user can see why nothing happens.
    */
    expect(formatAccelerator('win32', 'Command+T')).toBe('Cmd+T')
  })

  it('upper-cases a letter, so the tooltip and the menu agree', () => {
    // Electron accepts `Control+r`; every table writes `Control+R`.
    expect(formatAccelerator('win32', 'Control+r')).toBe('Ctrl+R')
  })

  it('passes a key it has not been taught through unchanged', () => {
    /*
      A binding this module does not know reads a little raw — recoverable. Dropping the key, or
      guessing at it, is not: the user would be told to press something that is not the key.
    */
    expect(formatAccelerator('win32', 'Control+num5')).toBe('Ctrl+num5')
  })
})

describe('printing one accelerator on macOS', () => {
  /*
    Symbols, no separator, and one fixed order: ⌃⌥⇧⌘ (Apple HIG). The order is deliberately *not* the
    order the binding table lists — `Command+Alt+I` is written `⌥⌘I`, which is what every Mac user has
    seen in a menu for the developer tools, while `⌘⌥I` is what a Windows program would print.
  */
  const cases: ReadonlyArray<[string, string]> = [
    ['Command+T', '⌘T'],
    ['Command+Shift+T', '⇧⌘T'],
    ['Command+Shift+E', '⇧⌘E'],
    ['Control+Shift+E', '⌃⇧E'],
    ['Command+Alt+I', '⌥⌘I'],
    ['Control+Command+F', '⌃⌘F'],
    ['Command+Alt+Right', '⌥⌘→'],
    ['Control+Alt+Left', '⌃⌥←'],
    ['Control+Alt+Up', '⌃⌥↑'],
    ['Control+Alt+Down', '⌃⌥↓'],
    // Safari's own back and forward, character for character.
    ['Command+[', '⌘['],
    ['Command+]', '⌘]'],
    ['Command+,', '⌘,'],
    ['Command+.', '⌘.'],
    ['Command+9', '⌘9'],
    ['Command+Plus', '⌘+'],
    ['Command+-', '⌘-'],
    // ⌫ deletes backwards and ⌦ forwards; both spellings are in the tables and neither may borrow the
    // other's symbol.
    ['Command+Shift+Backspace', '⇧⌘⌫'],
    ['Command+Shift+Delete', '⇧⌘⌦'],
    ['Command+Shift+Return', '⇧⌘↩'],
    ['Control+Shift+Tab', '⌃⇧⇥'],
    ['Control+PageDown', '⌃⇟'],
    ['Control+PageUp', '⌃⇞'],
    ['Command+Shift+H', '⇧⌘H'],
    ['Escape', '⎋'],
    // A function key has no symbol and keeps its name; `windowFullscreen` offers F11 on macOS too.
    ['F11', 'F11']
  ]

  for (const [accelerator, expected] of cases) {
    it(`writes ${accelerator} as ${expected}`, () => {
      expect(formatAccelerator('darwin', accelerator)).toBe(expected)
    })
  }

  it('puts the modifiers in Apple order whatever order they arrive in', () => {
    expect(formatAccelerator('darwin', 'Shift+Command+E')).toBe('⇧⌘E')
    expect(formatAccelerator('darwin', 'Command+Control+Shift+Alt+E')).toBe('⌃⌥⇧⌘E')
  })

  it('resolves every spelling Electron maps to Command', () => {
    // Cmd, CommandOrControl, Super and Meta are all the ⌘ key on macOS. Printing any of them as a
    // word would produce `SuperT`, because macOS joins with nothing.
    for (const spelling of ['Command', 'Cmd', 'CommandOrControl', 'CmdOrCtrl', 'Super', 'Meta']) {
      expect(formatAccelerator('darwin', `${spelling}+T`)).toBe('⌘T')
    }
  })

  it('prints Option under either of its names', () => {
    expect(formatAccelerator('darwin', 'Option+I')).toBe('⌥I')
    expect(formatAccelerator('darwin', 'Alt+I')).toBe('⌥I')
  })
})

describe('what the formatter is held to across the whole binding table', () => {
  it('knows every key the binding tables write down', () => {
    /*
      A fitness function, and the one that earns its place.

      The formatter's maps were written against the tables as they are. A new binding using a key that
      is not in them prints Electron's spelling into a tooltip — `Control+numdec` becomes `Ctrl+numdec`,
      which is not a key anybody can find. Nothing else would notice: the binding works, the menu shows
      it, and only the tooltip is nonsense.

      If this fails, decide in `format.ts` how the new key is written on each platform, then add it
      here. The list is the record of what has been decided.
    */
    const expected = [
      ',',
      '-',
      '.',
      '0',
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
      '7',
      '8',
      '9',
      'Alt',
      'B',
      'Backspace',
      'Command',
      'Control',
      'D',
      'Delete',
      'Down',
      'E',
      'Escape',
      'F',
      'F11',
      'F12',
      'F3',
      'F4',
      'F5',
      'F6',
      'G',
      'H',
      'Home',
      'I',
      'J',
      'K',
      'L',
      'Left',
      'N',
      'P',
      'PageDown',
      'PageUp',
      'Plus',
      'R',
      'Return',
      'Right',
      'Shift',
      'T',
      'Tab',
      'Up',
      'W',
      'Y',
      '[',
      ']',
      // The unshifted zoom-in key. `Plus` is the same physical key with Shift held, which is why
      // both are bound and why only one of them is what anybody actually presses.
      '=',
      'numadd',
      'numsub'
    ]
    expect([...everyToken()].sort()).toEqual([...expected].sort())
  })

  it('prints every macOS key as a single glyph or a function key', () => {
    /*
      The invariant that makes "no separator" safe.

      macOS runs the modifiers and the key together — `⇧⌘T` — so any part printed as a *word* comes out
      welded to its neighbours. `Super+T` printed as `SuperT` is not a shortcut, it is a typo, and it
      would happen silently for any key this module answers with prose.
    */
    for (const token of everyToken()) {
      const printed = formatAccelerator('darwin', token)
      expect(
        /^.$/u.test(printed) || /^F\d{1,2}$/.test(printed),
        `macOS prints ${token} as "${printed}", which will weld to the modifier before it`
      ).toBe(true)
    }
  })

  it('leaves no Electron-only spelling in a shortcut a user will read', () => {
    /*
      The whole point, asserted over the real tables rather than over examples. Every one of these
      words is either a key with a printed convention (`Escape` is `Esc`, `Return` is `Enter`) or a
      token that is not a key at all (`Plus`, `numadd`).
    */
    const electronOnly =
      /Control|Command|Plus|Return|Escape|PageUp|PageDown|numadd|numsub|Super|Meta/
    for (const platform of PLATFORMS) {
      for (const action of SHORTCUT_ACTIONS) {
        for (const accelerator of allAcceleratorsFor(platform, action)) {
          const printed = formatAccelerator(platform, accelerator)
          expect(printed, `${platform} ${action}`).not.toMatch(electronOnly)
        }
      }
    }
  })

  it('prints something for every action on every platform', () => {
    // A blank would leave a tooltip ending in a bare newline, which looks like a rendering fault.
    for (const platform of PLATFORMS) {
      for (const action of SHORTCUT_ACTIONS) {
        const printed = formatAccelerator(platform, acceleratorFor(platform, action))
        expect(printed, `${platform} ${action}`).not.toBe('')
      }
    }
  })

  it('has a binding table for every platform this test claims to cover', () => {
    // Guards the sweeps above against a fourth platform arriving unmeasured.
    expect(Object.keys(DEFAULT_BINDINGS).sort()).toEqual([...PLATFORMS].sort())
  })
})

describe('joining a label to its key', () => {
  it('puts the key on a second line, after the label', () => {
    /*
      The label first, because the tooltip is up precisely because the icon was not self-explanatory;
      the key is the extra. A newline rather than two spaces: whether a run of spaces survives into the
      tooltip is the tooltip renderer's business, and if it collapses then `Reload Ctrl+R` reads as one
      run-on phrase — a silent failure. `TabBar` already writes a second line into a `title`.
    */
    expect(shortcutTitles('win32')('Reload', 'reload')).toBe('Reload\nF5')
    expect(shortcutTitles('darwin')('Reload', 'reload')).toBe('Reload\n⌘R')
  })

  it('honours the key the user rebound rather than the default', () => {
    // A tooltip naming the default while the user has rebound it is worse than no tooltip: it is a
    // confident wrong answer, and the user has no reason to doubt it.
    expect(shortcutTitles('win32', { reload: 'F9' })('Reload', 'reload')).toBe('Reload\nF9')
  })

  it('returns the label untouched when the platform is not known yet', () => {
    /*
      The window state arrives over IPC a tick after the first paint, so the first render has no
      platform. Guessing one would print Mac symbols on Windows for that frame; the label alone is the
      only honest answer, and it must be the label *exactly* — no trailing newline.
    */
    expect(shortcutTitles(null)('Reload', 'reload')).toBe('Reload')
  })

  it('returns the label untouched when an override blanks the binding', () => {
    // `advanced.customShortcuts` is a free-form record: `{ reload: '' }` is storable. `acceleratorFor`
    // treats an empty override as absent, so this must read as the default and not as an empty key.
    expect(shortcutTitles('win32', { reload: '' })('Reload', 'reload')).toBe('Reload\nF5')
  })

  it('never leaves a title ending in the separator', () => {
    // The one thing every call site would get wrong differently if the join were written thirteen
    // times: a label followed by nothing.
    for (const platform of PLATFORMS) {
      const title = shortcutTitles(platform)
      for (const action of SHORTCUT_ACTIONS) {
        expect(title('Label', action), `${platform} ${action}`).not.toMatch(/\n$/)
      }
    }
  })
})
