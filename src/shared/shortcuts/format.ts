import type { Platform } from '../model.js'
import { acceleratorFor, type ShortcutAction } from './bindings.js'

/**
 * Accelerators written the way the platform writes them, and the one place a label is joined to a key.
 *
 * `bindings.ts` speaks Electron: `Control+numadd`, `Command+Plus`, `Control+Shift+Return`. Those are
 * arguments for a `MenuItem`, not text a person recognises — nobody has ever pressed a key called
 * `numadd`. A tooltip showing one would be worse than a tooltip with no key at all, because it would
 * look like an answer.
 *
 * The two conventions differ in more than spelling:
 *
 *   - macOS prints modifiers as symbols with no separator, in one fixed order — `⌃⌥⇧⌘` — and prints
 *     many keys as symbols too (`⌫`, `↩`, `⇥`, `←`). Apple's order is *not* the order the binding
 *     tables happen to list: `Command+Alt+I` is written `⌥⌘I`, which is what every Mac user has seen
 *     in a menu for the developer tools. `⌘⌥I` is what a Windows program would print.
 *   - Windows and Linux print words joined by `+`, ordered `Win`, `Ctrl`, `Alt`, `Shift` — the order
 *     `Ctrl+Alt+Delete` and `Ctrl+Shift+Esc` are already written in. Every entry in the two PC tables
 *     is already in that order, so normalising costs nothing and fixes an override typed by hand.
 *
 * A token this module has not been taught is passed through unchanged rather than dropped or guessed
 * at: reading a little raw is recoverable, a silently empty tooltip is not. `tests/shortcut-format.test.ts`
 * holds the set of tokens the tables actually use against the maps below, so a new binding that needs
 * an entry here cannot land without one.
 */

/** Modifier symbols, in the order macOS prints them (Apple HIG). */
const MAC_MODIFIER_ORDER: readonly string[] = ['⌃', '⌥', '⇧', '⌘']

const MAC_MODIFIERS: Readonly<Record<string, string>> = {
  Control: '⌃',
  Ctrl: '⌃',
  Alt: '⌥',
  Option: '⌥',
  Shift: '⇧',
  Command: '⌘',
  Cmd: '⌘',
  // Electron resolves all four of these to Command on macOS, so printing anything else would name a
  // key the binding does not use.
  CommandOrControl: '⌘',
  CmdOrCtrl: '⌘',
  Super: '⌘',
  Meta: '⌘'
}

/** Modifier words, in the order Windows and Linux print them. */
const PC_MODIFIER_ORDER: readonly string[] = ['Win', 'Cmd', 'Ctrl', 'Alt', 'Shift']

const PC_MODIFIERS: Readonly<Record<string, string>> = {
  Control: 'Ctrl',
  Ctrl: 'Ctrl',
  CommandOrControl: 'Ctrl',
  CmdOrCtrl: 'Ctrl',
  Alt: 'Alt',
  Option: 'Alt',
  Shift: 'Shift',
  Super: 'Win',
  Meta: 'Win',
  /*
    `Command` is macOS-only in Electron and fires nothing here, so it can only arrive from an override
    typed by hand. Printed as itself rather than folded into `Ctrl`: the honest reading of a binding
    that will not work is its own name, not the name of one that would.
  */
  Command: 'Cmd',
  Cmd: 'Cmd'
}

/**
 * Keys macOS prints as a symbol — Apple's own set, which is the point: a Mac user reads `⇧⌘⌫`
 * without translating, and would have to stop and think about `Shift+Command+Backspace`.
 */
const MAC_KEYS: Readonly<Record<string, string>> = {
  Escape: '⎋',
  Esc: '⎋',
  Return: '↩',
  Enter: '↩',
  Tab: '⇥',
  /*
    Two different keys with two different glyphs, and both spellings are in the tables: `clearData` is
    `Command+Shift+Backspace` on macOS and `Control+Shift+Delete` on Windows. ⌫ deletes backwards, ⌦
    forwards, so neither may borrow the other's symbol.
  */
  Backspace: '⌫',
  Delete: '⌦',
  Left: '←',
  Right: '→',
  Up: '↑',
  Down: '↓',
  PageUp: '⇞',
  PageDown: '⇟',
  Home: '↖',
  End: '↘',
  Plus: '+',
  /*
    The keypad keys print as their bare sign. Apple's symbol set has no keypad marker, and inventing a
    word to put among the symbols would read as a key name. The cost is that `numadd` and `Plus` print
    alike; macOS binds neither of the keypad keys, and the sign is what the user has to press either way.
  */
  numadd: '+',
  numsub: '-'
}

/**
 * Keys Windows and Linux print as something other than their Electron name.
 *
 * The name on the keycap, because that is what someone hunting for the key is looking at: the key is
 * labelled `Esc`, not `Escape`, and `Enter`, not `Return`.
 */
const PC_KEYS: Readonly<Record<string, string>> = {
  Escape: 'Esc',
  Return: 'Enter',
  Enter: 'Enter',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  Plus: '+',
  // Marked as the keypad, because `zoomIn` binds both `Control+Plus` and `Control+numadd` and they are
  // two different keys. Unmarked, the second would print as the first and name the wrong one.
  numadd: 'Num +',
  numsub: 'Num -'
}

/** A key with no printed convention of its own: a letter, a digit, `F5`, `[`, `,`. */
function plainKey(token: string): string {
  // Electron accepts `Control+r`, and an override may well be written that way. The tables all write
  // `Control+R`, and a tooltip disagreeing with the menu about the case of a letter reads as a
  // different shortcut.
  return /^[a-z]$/.test(token) ? token.toUpperCase() : token
}

/**
 * One Electron accelerator, printed for a human on `platform`.
 *
 * Pure and total. An empty string in gives an empty string out, which is what `acceleratorFor`
 * returns for an action with no binding — `shortcutTitles` reads that as "say nothing".
 */
export function formatAccelerator(platform: Platform, accelerator: string): string {
  const mac = platform === 'darwin'
  const modifiersOf = mac ? MAC_MODIFIERS : PC_MODIFIERS
  const keysOf = mac ? MAC_KEYS : PC_KEYS

  const modifiers = new Set<string>()
  const keys: string[] = []
  for (const token of accelerator.split('+')) {
    const modifier = modifiersOf[token]
    if (modifier === undefined) keys.push(keysOf[token] ?? plainKey(token))
    else modifiers.add(modifier)
  }

  // Filtering the order rather than sorting what was found: the order is the specification, and it
  // also removes a modifier written twice without a branch to notice it.
  const order = mac ? MAC_MODIFIER_ORDER : PC_MODIFIER_ORDER
  const parts = [...order.filter((modifier) => modifiers.has(modifier)), ...keys]
  return parts.join(mac ? '' : '+')
}

/** Writes one button's `title`: its label, and the key that does the same thing. */
export type ShortcutTitle = (label: string, action: ShortcutAction) => string

/**
 * An action's key as a person reads it, or `''` when there is none to show.
 *
 * Separate from `shortcutTitles` because two places need the key and only one of them is joining it to a
 * label: a *menu* shows its accelerator in its own column, which is where the eye already looks for one,
 * and a tooltip would be the wrong instrument there — the entry is a menu item, not an unlabelled icon.
 *
 * `null` for the platform and an action with no binding collapse to the same empty string, on purpose.
 * The window state arrives asynchronously, so "not known yet" and "not bound" are one case for every
 * caller: render the thing without a key and render it again when there is one.
 */
export function shortcutKey(
  platform: Platform | null,
  action: ShortcutAction,
  overrides: Readonly<Record<string, string>> = {}
): string {
  if (platform === null) return ''
  return formatAccelerator(platform, acceleratorFor(platform, action, overrides))
}

/**
 * The single join between a label and its shortcut.
 *
 * **A newline, so the key is the tooltip's second line.** Three separators were on the table and the
 * reasons are worth keeping:
 *
 *   - Two spaces is the menu convention, but a `title` is not a menu. Whether a run of spaces survives
 *     into the tooltip is the tooltip renderer's business, and if it collapses, `Reload Ctrl+R` reads
 *     as one run-on phrase. The failure is silent, which is the worst kind here.
 *   - An en dash needs a convention per locale (German sets it with spaces, English often without) and,
 *     worse, `Back – ⌘[` reads as if the dash were part of the label.
 *   - A newline cannot collapse, needs no punctuation to translate, and `TabBar.tsx` already writes a
 *     second line into a `title` for the tile a tab sits in. So this follows a precedent in the same
 *     file rather than adding a second idea about what a two-part tooltip looks like.
 *
 * Label first: the tooltip is up because the user did not recognise the icon, so the name is the answer
 * and the key is the extra. And no key at all returns the label *unchanged* — not the label with an
 * empty line after it. That is most of the reason this is one function: an unknown platform (the window
 * state has not arrived yet) and an action with no binding are the same answer, written once, and
 * thirteen call sites would not have agreed on it.
 *
 * The shortcut deliberately does not go into `aria-label`. The accessible name is the action, and a
 * screen reader repeating `Alt+Left` on every focus is noise; because `aria-label` wins over `title`
 * for the accessible name, adding it here changes nothing a screen reader says.
 */
export function shortcutTitles(
  platform: Platform | null,
  overrides: Readonly<Record<string, string>> = {}
): ShortcutTitle {
  return (label, action) => {
    const key = shortcutKey(platform, action, overrides)
    return key === '' ? label : `${label}\n${key}`
  }
}
