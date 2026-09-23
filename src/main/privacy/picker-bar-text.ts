import type { PickerOutcome } from '@shared/filters/picker-session.js'
import type { Locale } from '@shared/i18n/catalog.js'

/**
 * The element picker's confirmation bar, in words: its controls, its waiting lines, and the eight
 * named answers of R1.
 *
 * ## Why it is not in `shared/i18n/catalog.*`
 *
 * Because the catalogue is measured, and this bar pushed it over. `tests/architecture.test.ts` holds
 * the renderer's catalogue chunk — one chunk, *both* locales — to 48 kB, and the note on that budget
 * says the raise to 48 was the last one: whoever hits it next moves prose out rather than raising it
 * a third time. The picker's twenty-three sentences, in two languages, took the chunk to just over
 * 50 kB. Every renderer parses that chunk on every window open — the start page, the history page,
 * the settings — and exactly one surface, raised by one gesture, ever shows these words.
 *
 * So they live here, the arrangement `main/settings/user-rules-text.ts` set up for the rule editor:
 * prose in the core, resolved for the language in force, travelling on a message the surface was
 * receiving anyway. The main process is not bundled for any renderer, so these cost the chunk nothing.
 *
 * ## Why they ride on the presentation rather than a channel of their own
 *
 * The bar holds no opinion of its own; every visible thing on it is a field of the presentation the
 * core sends (see `PickerBarPresentation`). The words are one more such field. A separate text
 * channel would be a second round trip at the moment the bar first appears, and a bar that could be
 * drawn before its words arrived would be drawn with no sentence on it — the silence this whole
 * feature is being rebuilt to end, reproduced for the length of an IPC hop.
 *
 * The whole table goes every time rather than the one sentence the current mode needs. It is a couple
 * of kilobytes on a message that is re-sent as the selection is refined, which is nothing, and it
 * keeps the bar's rendering exactly as it was: the surface still decides which sentence a mode says,
 * still resolves an outcome by its own key, and still renders a key it does not recognise as itself
 * rather than as nothing.
 *
 * ## Why the outcomes are keyed by the outcome itself
 *
 * `outcome.${outcome}`, with the raw `PickerOutcome` string and no camel-cased alias, so the bar
 * resolves an outcome with no table in between — a table would be a second list of the same eight
 * names, and a ninth would render as an empty bar. The type below spells the keys from
 * `PickerOutcome`, so the compiler holds this table to the session's list: an outcome added there is
 * a compile error here until it has words in both languages.
 *
 * ## Why German is checked against English by the compiler
 *
 * `PickerBarText` is `typeof en`, so the German table cannot miss an entry, invent one, or drift — the
 * guarantee `user-rules-text.ts` and `catalog.de.ts` get, for the same reason: a translation that
 * silently loses a sentence is worse than one that is missing, because nothing looks wrong. What the
 * compiler cannot see — a blank string, a lost `{index}` — `tests/picker-presentation.test.ts` does.
 *
 * `{index}` and `{count}` are left as placeholders for the bar to fill with the shared `interpolate`,
 * so a placeholder means the same thing here as in every catalogue sentence.
 */

const en = {
  /*
    The bar's own chrome.

    Every one of these is a *state said out loud*, and that is the point rather than politeness: the
    defect being repaired here is a picker that closed without saying anything, so a bar that showed
    controls and no sentence would reproduce it with better furniture. The three waiting lines below
    exist because the two states between a press and an answer are the ones that look like a hang.

    Wider and narrower are named for what happens to the *selection*, not for the direction of the key
    that does it: "up" and "down" describe a tree the user cannot see.
  */
  label: 'Block an element in tile {index}',
  choosing: 'Move over the element you want to hide, then click it.',
  /* Not counted *yet* — distinct from a count of zero, which is a finding and worded below. */
  counting: 'Counting what this would hide…',
  matchesNone: 'This matches nothing on this page.',
  matchesOne: 'This would hide 1 element on this page.',
  matches: 'This would hide {count} elements on this page.',
  writing: 'Saving the rule…',
  measuring: 'Checking whether the rule works here…',
  widen: 'Select more',
  narrow: 'Select less',
  confirm: 'Block it',
  cancel: 'Cancel',
  /*
    The same action as Cancel, worded for a bar that has an answer on it. "Cancel" beside a rule that
    was just saved reads as an offer to take it back — which is the button next to it.
  */
  close: 'Close',
  undo: 'Undo',
  openRules: 'My rules',

  /*
    The eight named answers of R1.

    Two rules run through all eight. Each says what *happened*, not what the machinery did: "saved, and
    nothing on this page changed" is something a person can act on, "the injection reported zero matches"
    is not. And each that has a next step names it, because a refusal a person can do nothing about is
    only half an answer — which of the eight has one is the difference between a list that is full and a
    list the user chose to leave as it is.
  */
  'outcome.saved-effective': 'Blocked. The rule is saved and this element is gone.',
  /*
    Two facts, kept apart on purpose: the saving worked and the hiding did not. Collapsed into one
    sentence they read as a failure of the browser, and the commonest cause is neither — an element that
    loads a moment later can still be caught by the very same rule.
  */
  'outcome.saved-ineffective':
    'Saved, but nothing on this page changed. The element may load again later, or the site may build it another way.',
  'outcome.invalid': 'This is not a rule this browser can apply.',
  'outcome.duplicate-active': 'You already have this rule, and it is switched on.',
  'outcome.duplicate-disabled':
    'You already have this rule, and it is switched off. Turn it back on in your rules.',
  'outcome.limit-reached':
    'You have as many rules as this browser will keep. Delete one you no longer need, then block this again.',
  'outcome.no-host': 'This document belongs to no site, so there is nothing to write a rule for.',
  'outcome.not-filterable':
    'Nothing can be blocked on this page. Either it is not a website, or filtering is switched off here.'
} satisfies Record<string, string> & Record<`outcome.${PickerOutcome}`, string>

export type PickerBarText = typeof en

const de: PickerBarText = {
  label: 'Element in Kachel {index} blocken',
  choosing: 'Fahre über das Element, das verschwinden soll, und klicke es an.',
  counting: 'Zählt, was ausgeblendet würde …',
  matchesNone: 'Das trifft auf dieser Seite nichts.',
  matchesOne: 'Das würde 1 Element auf dieser Seite ausblenden.',
  matches: 'Das würde {count} Elemente auf dieser Seite ausblenden.',
  writing: 'Regel wird gespeichert …',
  measuring: 'Prüft, ob die Regel hier wirkt …',
  widen: 'Mehr auswählen',
  narrow: 'Weniger auswählen',
  confirm: 'Blocken',
  cancel: 'Abbrechen',
  close: 'Schließen',
  undo: 'Rückgängig',
  openRules: 'Meine Regeln',

  'outcome.saved-effective': 'Geblockt. Die Regel ist gespeichert und das Element ist weg.',
  'outcome.saved-ineffective':
    'Gespeichert, aber auf dieser Seite hat sich nichts geändert. Das Element kann später noch nachladen, oder die Seite baut es anders auf.',
  'outcome.invalid': 'Das ist keine Regel, die dieser Browser anwenden kann.',
  'outcome.duplicate-active': 'Diese Regel hast du bereits, und sie ist eingeschaltet.',
  'outcome.duplicate-disabled':
    'Diese Regel hast du bereits, und sie ist ausgeschaltet. Schalte sie in deinen Regeln wieder ein.',
  'outcome.limit-reached':
    'Du hast so viele Regeln, wie dieser Browser behält. Lösche eine, die du nicht mehr brauchst, und blocke das hier erneut.',
  'outcome.no-host':
    'Dieses Dokument gehört zu keiner Website, es gibt also nichts, wofür sich eine Regel schreiben ließe.',
  'outcome.not-filterable':
    'Auf dieser Seite lässt sich nichts blocken. Entweder ist es keine Website, oder das Filtern ist hier abgeschaltet.'
}

export function pickerBarText(locale: Locale): PickerBarText {
  return locale === 'de' ? de : en
}
