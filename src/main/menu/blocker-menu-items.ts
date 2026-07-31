import type { MenuItemConstructorOptions } from 'electron'
import { translate, type Locale } from '@shared/i18n/catalog.js'
import { describeUserRule, type UserRule } from '@shared/filters/user-rules.js'
import { hostMatchesRule } from '@shared/url/domain.js'

/**
 * The menu behind the blocker button in the address bar.
 *
 * Native, and here the choice avoids a real conflict rather than merely being convenient. A DOM menu in the
 * chrome UI would drop down *behind* the page, because page content is a `WebContentsView` layered above the
 * chrome renderer — so it would have to be drawn on the overlay layer, which already carries the layout
 * picker, the drop indicator, the permission prompt and the per-tile bar. Every one of those is a claim on a
 * surface that shows one thing at a time. This menu is plain text items and needs none of it.
 *
 * ## What it is for
 *
 * What a person wants when they open this is one of four things: to know what is going on, to hide something
 * the blocker missed, to *stop* it because the page is broken, or to undo something they hid earlier. All
 * four are here, and the last two are the ones most browsers bury.
 *
 * ## The two things this menu gained, and what was wrong before
 *
 * **A per-site switch.** This file already argued that "a blocker with no visible off switch for the current
 * site is a blocker people uninstall" — and then offered only the *global* switch. So the way to read one
 * broken page was to stop blocking everywhere and remember to turn it back on, which nobody does. The
 * per-site switch is what makes the global one safe to have.
 *
 * **The user's own rules.** `user-rules.ts` states the requirement plainly: *"The three operations that
 * matter are not 'add': they are see, disable, delete."* All three had core handlers — `userrules:list`,
 * `userrules:setEnabled`, `userrules:remove` — and **no caller anywhere**. So the element picker could write
 * rules and there was no surface in the browser that could show one, switch one off, or delete one. A rule
 * that hid the wrong thing was permanent and unfindable, which is exactly the state the docblock in
 * `user-rules.ts` says turns into "the whole blocker gets turned off".
 *
 * They are here rather than on the settings page for two reasons. The chrome UI is what holds those channels
 * — the settings page is not granted them, and granting a sandboxed page the power to edit filter rules to
 * save a menu is the wrong trade. And this is where the rules are *made*: the picker is two items up, so
 * undoing a mis-click is in the same menu as the click.
 *
 * The template is separate from the menu for the reason stated in `tab-context-items.ts`:
 * `Menu.buildFromTemplate` needs Electron and holds no decision, while everything here is a decision.
 */

/** Beyond this a rule's own text is no longer readable in a menu, so it is elided in the middle. */
const RULE_LABEL_LENGTH = 64

/**
 * A rule as one line of menu text.
 *
 * Elided in the *middle* rather than at the end, which is not a detail: a rule is
 * `host##selector`, and the two ends are the two things that identify it. Cutting the tail off
 * `www.example.com##div.wrapper > div.container > .ad-slot` leaves every rule on the site looking
 * identical.
 */
export function ruleMenuLabel(text: string): string {
  if (text.length <= RULE_LABEL_LENGTH) return text
  const half = Math.floor((RULE_LABEL_LENGTH - 1) / 2)
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`
}

/**
 * The user's rules that apply to this host, newest first.
 *
 * Newest first because the rule most likely to be the one that just hid the wrong thing is the one
 * written last — the same reason `UserRule` carries `createdAt` at all.
 *
 * Scoped to the host rather than listing everything: the whole list can be hundreds of entries and this
 * is a menu, not a manager. A rule scoped to a parent domain counts as applying here, through
 * `hostMatchesRule`, because it is affecting the page in front of the user and they should be able to
 * switch it off from here. A rule with no host at all — one that applies everywhere — is left out
 * deliberately: switching it off from a menu on one site would change every site, silently.
 */
export function siteRules(rules: readonly UserRule[], host: string | null): UserRule[] {
  if (host === null) return []
  return rules
    .filter((rule) => {
      const detail = describeUserRule(rule.text)
      if (detail === null || detail.hosts.length === 0) return false
      return detail.hosts.some((scope) => hostMatchesRule(host, scope))
    })
    .sort((left, right) => right.createdAt - left.createdAt)
}

export interface BlockerMenuDeps {
  locale: Locale
  /** Requests blocked on the page this menu was opened from. */
  blockedOnPage: number
  /** Every rule the user has, of which only this site's are listed. */
  userRules: readonly UserRule[]
  /** False when the blocker is off entirely — picking an element would write a rule nothing applies. */
  blockerEnabled: boolean
  /**
   * The host this menu was opened over, or `null` for a document with no host.
   *
   * `null` is what makes the per-site switch and the rule list disappear rather than appear inert: on an
   * internal page or a `file:` document there is nothing to key either on, and an unusable checkbox is a
   * worse answer than no checkbox.
   */
  host: string | null
  /** False when the user has switched filtering off for this site. */
  blockerEnabledOnSite: boolean
  onBlockElement(): void
  onOpenSettings(): void
  onRefreshLists(): void
  onSetBlockerEnabled(enabled: boolean): void
  onSetBlockerEnabledOnSite(host: string, enabled: boolean): void
  onSetRuleEnabled(id: string, enabled: boolean): void
  onRemoveRules(ids: readonly string[]): void
}

export function blockerMenuTemplate(deps: BlockerMenuDeps): MenuItemConstructorOptions[] {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
    translate(deps.locale, key, params)

  const items: MenuItemConstructorOptions[] = [
    /*
      A disabled first item, which is unusual and deliberate.

      It is the answer to the question that made the user open the menu, and putting it in the menu rather
      than only in a tooltip means it is reachable from the keyboard — a tooltip is not.

      Two wordings, because the button is now in the address bar on every page rather than only where
      something was blocked. "0 requests blocked on this page" is a sentence that reads like a fault;
      "Nothing blocked on this page" is the same fact and is not alarming, which matters because on a
      well-behaved site it is the correct and expected answer.
    */
    {
      label:
        deps.blockedOnPage === 0
          ? t('blocker.nothingBlockedYet')
          : t('blocker.blockedOnPage', { count: deps.blockedOnPage }),
      enabled: false
    },
    { type: 'separator' }
  ]

  /*
    The picker, and the two conditions on it.

    A host is needed because a picked rule is `host##selector` and there is nothing to key one on without
    it; the blocker being on is needed because a rule written while it is off applies to nothing, and
    offering to write one would be offering to do nothing. The per-site switch is deliberately *not* a
    condition: hiding one more element on a site you have stopped filtering is a coherent thing to want,
    and the rule will apply again the moment filtering comes back.
  */
  if (deps.blockerEnabled && deps.host !== null) {
    items.push({ label: t('page.blockElement'), click: () => deps.onBlockElement() })
  }

  const rules = siteRules(deps.userRules, deps.host)
  items.push({
    label: t('blocker.myRules', { count: rules.length }),
    submenu: myRulesSubmenu(deps, rules, t)
  })

  items.push({ label: t('blocker.updateLists'), click: () => deps.onRefreshLists() }, { type: 'separator' })

  /*
    Two switches, narrow before broad.

    The per-site one first because it is the one that should be reached for: it fixes the page in front of
    the user and leaves every other site filtered. The global one below it, still a checkbox for the
    reason it always was — somebody who turned blocking off and forgot has a broken idea of why their
    adverts came back, and "Blocking enabled ✓" answers that at a glance.

    The per-site switch is absent rather than disabled where there is no host, because a checkbox that
    cannot be clicked invites the reading that blocking is off here.
  */
  if (deps.host !== null) {
    const host = deps.host
    items.push({
      label: t('blocker.enabledOnSite'),
      type: 'checkbox',
      // Off if the blocker is off globally: claiming blocking is on for this site while nothing is being
      // blocked anywhere would be the one statement in this menu that is simply untrue.
      checked: deps.blockerEnabled && deps.blockerEnabledOnSite,
      enabled: deps.blockerEnabled,
      click: () => deps.onSetBlockerEnabledOnSite(host, !deps.blockerEnabledOnSite)
    })
  }

  items.push({
    label: t('blocker.enabled'),
    type: 'checkbox',
    checked: deps.blockerEnabled,
    click: () => deps.onSetBlockerEnabled(!deps.blockerEnabled)
  })

  return items
}

/**
 * See, disable, delete — the three operations `user-rules.ts` says are the ones that matter.
 *
 * Each rule is a checkbox showing whether it is applied, because *disable* rather than *delete* is the
 * operation somebody reaches for when a page is broken: it keeps the rule so the list can still be read,
 * which is the whole reason `enabled` is stored rather than implied by presence.
 *
 * Deleting is one item for the site rather than one per rule. A per-rule delete needs a second level of
 * submenu on every entry — a menu deep enough that nobody finds it — and the case that actually happens
 * is "I have been clicking the picker on this site and want it back the way it was".
 */
function myRulesSubmenu(
  deps: BlockerMenuDeps,
  rules: readonly UserRule[],
  t: (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) => string
): MenuItemConstructorOptions[] {
  if (rules.length === 0) {
    return [
      { label: t('blocker.noRules'), enabled: false },
      { type: 'separator' },
      { label: t('blocker.openSettings'), click: () => deps.onOpenSettings() }
    ]
  }

  const items: MenuItemConstructorOptions[] = rules.map((rule) => ({
    label: ruleMenuLabel(rule.text),
    type: 'checkbox',
    checked: rule.enabled,
    click: () => deps.onSetRuleEnabled(rule.id, !rule.enabled)
  }))

  items.push(
    { type: 'separator' },
    {
      label: t('blocker.forgetSiteRules', { count: rules.length }),
      click: () => deps.onRemoveRules(rules.map((rule) => rule.id))
    },
    { label: t('blocker.openSettings'), click: () => deps.onOpenSettings() }
  )

  return items
}
