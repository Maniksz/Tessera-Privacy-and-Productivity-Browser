import { MAX_USER_RULES } from '@shared/filters/user-rules.js'
import type { Locale } from '@shared/i18n/catalog.js'

/**
 * The rule editor's own prose, kept in the core and sent out with the rules.
 *
 * ## Why it is not in `shared/i18n/catalog.*`
 *
 * The same argument `settings-text.ts` makes at length, and this time with a number attached. The
 * catalogue is one chunk holding *both* locales and it is measured: `tests/architecture.test.ts` budgets it,
 * and the budget was raised to 48 kB for the blocker menu and the navigation prompt — with a note saying
 * that whoever hit it next should fix the structure rather than raise it a third time. This is next.
 *
 * So these sentences live here. The main process is not bundled for any renderer, exactly one
 * screen ever asks for them, and they travel on the answer to `userrules:list` — a call that screen was
 * already making. Zero bytes for the start page, the history page and the four other internal pages that
 * will never show a filter rule.
 *
 * ## Why they ride on `userrules:list` rather than a channel of their own
 *
 * `settings:describe` set the precedent: it resolves labels and descriptions for the requested locale and
 * returns them *with* the descriptors, because the locale is known in the core and the screen was fetching
 * anyway. A separate text channel would be a second round trip for the same screen at the same moment.
 *
 * It cost nothing to arrange because `userrules:list` had no caller at all — the channel existed, the
 * blocker menu read the store directly, and no renderer was granted it. Its shape was free to choose.
 *
 * ## Why German is checked against English by the compiler
 *
 * `UserRulesText` is `typeof en`, so the German table cannot miss an entry, invent one, or drift — the same
 * guarantee `settings-text.de.ts` and `catalog.de.ts` get, and for the same reason: a translation that
 * silently loses a sentence is worse than one that is missing, because nothing looks wrong.
 */

const en = {
  heading: 'My filter rules',
  /**
   * The one sentence that has to teach the syntax, because nothing else on screen can.
   *
   * It names the three forms in the order somebody needs them — the plain one, the one that is the reason to
   * write a rule by hand at all, and the escape hatch — and then the one convention the text box adds: `!`,
   * which is how a rule is switched off and how a note is written. Longer than the rest and deliberately so —
   * a text box with no example is a text box nobody uses.
   */
  hint: 'One rule per line, in uBlock Origin syntax. example.com##.banner hides an element; example.com##.box:has-text(Advert) hides the box containing that word; example.com#@#.box cancels a rule a list applied. Put ! in front of a rule to switch it off; any other line starting with ! is a note.',
  placeholder: 'example.com##.banner-ad',
  save: 'Save rules',
  discard: 'Discard changes',
  /** Said after a save that went through, because the box itself looks the same before and after. */
  saved: 'Saved.',
  /** The tag drawn on a refused line, in place. Short, because it sits at the end of the line itself. */
  rejectedMark: 'not applied',
  /**
   * What the mark means, said once for every mark — with the reason the syntax is refused and the two ways
   * out, because a refusal with no next step reads as the browser being stubborn.
   */
  rejected:
    'The marked lines are not applied: this browser cannot apply them. Request-blocking rules and ##+js(…) countermeasures are not accepted here, and a rule using :has-text() or :upward() has to name a site. They are kept so you can correct them — or put ! in front to keep one as a note.',
  /** Read out before the line numbers, for somebody who cannot see the marks. */
  rejectedLines: 'Lines not applied:',
  /**
   * The tag, and the explanation, for a good rule a private window cannot deliver: a procedural rule or an
   * exception. Its own words because the remedy is not "correct the line" — the line is fine, and a normal
   * window takes it. `USER_RULE_LINE_REFUSALS` in `user-rules-lines.ts` gives the reason in full.
   */
  rejectedMarkPrivate: 'not in a private window',
  rejectedPrivate:
    'A private window can only apply plain hiding rules of its own: rules using :has-text(), :upward() or :style(), and #@# exceptions, are not applied here. Write them in a normal window to use them.',
  /**
   * The tag, and the explanation, for a rule from the normal profile that this window was asked to switch
   * off or delete and could not. The line shows the rule as it still is, because that is what the page gets.
   */
  rejectedMarkProfile: 'unchanged: normal profile',
  rejectedProfile:
    "Rules from your normal profile can't be switched off or deleted in a private window, so the marked lines were left as they are and keep applying. Change them in a normal window.",
  /** A refusal of the whole text, with a next step, because there is one and only the user can take it. */
  limitReached: `This text holds more than ${String(MAX_USER_RULES)} rules, which is as many as this browser will keep. Nothing was saved and nothing was deleted — remove some lines and save again.`,
  /**
   * The private window's limit, said where it applies.
   *
   * The second sentence is the one that matters and is not decoration: stored rules reach every window
   * through the engine's one global slot and a private window can only *add* to what its pages get, so a rule
   * from the normal profile can be switched on here and not off. The editor refuses the rest and marks the
   * line (`rejectedProfile`); this says so before anybody tries. See `SessionUserRuleEditor`.
   */
  sessionNote:
    'This is a private window. What you change here lasts until the last private window closes and is not saved. Rules from your normal profile can be switched on here, but not switched off or deleted.',
  /**
   * The same limit in the blocker menu, as a line that cannot be clicked under the rules it applies to.
   *
   * Here rather than in the shared catalogue for the reason the module docblock gives: the menu is built in
   * the core, and a renderer would download the sentence for a surface it cannot draw.
   */
  menuProfileRules:
    "Rules from your normal profile can't be switched off or deleted in a private window.",
  /** How the rule will be applied, shown on its line; the two costs are not the same. */
  kindProcedural: 'matched by script',
  /** Where the rule came from, so a picked rule can be told from a typed one. */
  originPicker: 'from the element picker'
} satisfies Record<string, string>

export type UserRulesText = typeof en

const de: UserRulesText = {
  heading: 'Meine Filterregeln',
  hint: 'Eine Regel pro Zeile, in uBlock-Origin-Syntax. example.com##.banner blendet ein Element aus; example.com##.box:has-text(Anzeige) blendet die Box mit diesem Wort aus; example.com#@#.box hebt eine Regel aus einer Liste wieder auf. Setz ein ! vor eine Regel, um sie auszuschalten; jede andere Zeile, die mit ! beginnt, ist eine Notiz.',
  placeholder: 'example.com##.banner-ad',
  save: 'Regeln speichern',
  discard: 'Änderungen verwerfen',
  saved: 'Gespeichert.',
  rejectedMark: 'nicht angewendet',
  rejected:
    'Die markierten Zeilen werden nicht angewendet: Dieser Browser kann sie nicht umsetzen. Regeln, die Anfragen blockieren, und ##+js(…)-Gegenmaßnahmen werden hier nicht angenommen, und eine Regel mit :has-text() oder :upward() muss eine Seite nennen. Sie bleiben stehen, damit du sie korrigieren kannst – oder setz ein ! davor, um eine als Notiz zu behalten.',
  rejectedLines: 'Nicht angewendete Zeilen:',
  rejectedMarkPrivate: 'nicht im privaten Fenster',
  rejectedPrivate:
    'Ein privates Fenster kann nur eigene einfache Ausblenderegeln anwenden: Regeln mit :has-text(), :upward() oder :style() und #@#-Ausnahmen werden hier nicht angewendet. Schreib sie in einem normalen Fenster, um sie zu nutzen.',
  rejectedMarkProfile: 'unverändert: normales Profil',
  rejectedProfile:
    'Regeln aus deinem normalen Profil kannst du in einem privaten Fenster nicht ausschalten oder löschen. Die markierten Zeilen bleiben deshalb, wie sie sind, und wirken weiter. Ändere sie in einem normalen Fenster.',
  limitReached: `Dieser Text enthält mehr als ${String(MAX_USER_RULES)} Regeln, und mehr behält dieser Browser nicht. Es wurde nichts gespeichert und nichts gelöscht – entferne einige Zeilen und speichere noch einmal.`,
  sessionNote:
    'Das ist ein privates Fenster. Was du hier änderst, gilt, bis das letzte private Fenster geschlossen wird, und wird nicht gespeichert. Regeln aus deinem normalen Profil kannst du hier einschalten, aber nicht ausschalten oder löschen.',
  menuProfileRules:
    'Regeln aus deinem normalen Profil kannst du in einem privaten Fenster nicht ausschalten oder löschen.',
  kindProcedural: 'per Skript gesucht',
  originPicker: 'per Element-Auswahl'
}

export function userRulesText(locale: Locale): UserRulesText {
  return locale === 'de' ? de : en
}
