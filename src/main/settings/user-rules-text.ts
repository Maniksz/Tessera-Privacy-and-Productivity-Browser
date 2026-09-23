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
 * So these sixteen sentences live here. The main process is not bundled for any renderer, exactly one
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
   * It names the three forms in the order somebody needs them: the plain one, the one that is the reason to
   * write a rule by hand at all, and the escape hatch. Longer than the rest and deliberately so — a text
   * box with no example is a text box nobody uses.
   */
  hint: 'One rule per line, in uBlock Origin syntax. example.com##.banner hides an element; example.com##.box:has-text(Advert) hides the box containing that word; example.com#@#.box cancels a rule a list applied.',
  placeholder: 'example.com##.banner-ad',
  add: 'Add rule',
  empty: 'No rules of your own yet.',
  /** Said when the line cannot be honoured, with the reason the syntax is refused. */
  invalid:
    'This is not a rule this browser can apply. Request-blocking rules and ##+js(…) countermeasures cannot be added here, and a rule using :has-text() or :upward() has to name a site.',
  /**
   * The same refusal in a private window, which can apply fewer rules: its own reach the page as a
   * stylesheet for that window only, so they can hide an element and nothing else.
   */
  invalidPrivate:
    'A private window can only add rules that hide an element, such as example.com##.banner. Exceptions (#@#) and rules using :has-text() or :upward() can be added in a normal window.',
  duplicate: 'You already have that rule.',
  /**
   * The same rule, switched off — which looks from the outside exactly like the browser ignoring the
   * button, so it says where the rule is and what to do about it.
   */
  duplicateDisabled:
    'You already have that rule, and it is switched off. Turn it back on in the list below.',
  /** A refusal with a next step, because there is one and only the user can take it. */
  limitReached:
    'You have as many rules as this browser will keep. Delete one you no longer need, and this line can be added.',
  /** The per-rule controls. Both name the rule, so a screen reader says which one is being acted on. */
  toggle: 'Apply this rule',
  remove: 'Delete this rule',
  /** How the rule will be applied, shown per rule; the two costs are not the same. */
  kindDeclarative: 'CSS',
  kindProcedural: 'matched by script',
  /** Where the rule came from, so a picked rule can be told from a typed one. */
  originPicker: 'from the element picker',
  originManual: 'typed',
  disabled: 'not applied',
  /** A stored rule seen from a private window, which may read it but not change it. */
  locked: 'saved in your profile, change it in a normal window'
} satisfies Record<string, string>

export type UserRulesText = typeof en

const de: UserRulesText = {
  heading: 'Meine Filterregeln',
  hint: 'Eine Regel pro Zeile, in uBlock-Origin-Syntax. example.com##.banner blendet ein Element aus; example.com##.box:has-text(Anzeige) blendet die Box mit diesem Wort aus; example.com#@#.box hebt eine Regel aus einer Liste wieder auf.',
  placeholder: 'example.com##.banner-ad',
  add: 'Regel hinzufügen',
  empty: 'Noch keine eigenen Regeln.',
  invalid:
    'Das ist keine Regel, die dieser Browser anwenden kann. Regeln, die Anfragen blockieren, und ##+js(…)-Gegenmaßnahmen lassen sich hier nicht hinzufügen, und eine Regel mit :has-text() oder :upward() muss eine Seite nennen.',
  invalidPrivate:
    'Ein privates Fenster kann nur Regeln hinzufügen, die ein Element ausblenden, etwa example.com##.banner. Ausnahmen (#@#) und Regeln mit :has-text() oder :upward() lassen sich in einem normalen Fenster hinzufügen.',
  duplicate: 'Diese Regel hast du schon.',
  duplicateDisabled:
    'Diese Regel hast du schon, sie ist aber ausgeschaltet. Schalte sie in der Liste unten wieder ein.',
  limitReached:
    'Mehr Regeln behält dieser Browser nicht. Lösche eine, die du nicht mehr brauchst, dann lässt sich diese Zeile hinzufügen.',
  toggle: 'Diese Regel anwenden',
  remove: 'Diese Regel löschen',
  kindDeclarative: 'CSS',
  kindProcedural: 'per Skript gesucht',
  originPicker: 'per Element-Auswahl',
  originManual: 'getippt',
  disabled: 'nicht angewendet',
  locked: 'im Profil gespeichert, in einem normalen Fenster änderbar'
}

export function userRulesText(locale: Locale): UserRulesText {
  return locale === 'de' ? de : en
}
