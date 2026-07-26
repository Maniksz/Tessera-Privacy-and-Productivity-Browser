import type { MenuItemConstructorOptions } from 'electron'
import { translate, type Locale } from '@shared/i18n/catalog.js'

/**
 * The menu behind the blocked-request badge in the address bar.
 *
 * Native, and here the choice avoids a real conflict rather than merely being convenient. A DOM menu in the
 * chrome UI would drop down *behind* the page, because page content is a `WebContentsView` layered above the
 * chrome renderer — so it would have to be drawn on the overlay layer, which already carries the layout
 * picker, the drop indicator, the permission prompt and the per-tile bar. Every one of those is a claim on a
 * surface that shows one thing at a time. This menu is plain text items and needs none of it.
 *
 * ## What it is for
 *
 * The badge used to be a button that did nothing. What a person wants when they notice "12 blocked" is one of
 * three things: to know what is going on, to hide something the blocker missed, or to *stop* it because the
 * page is broken. All three are here, and the third is the one most browsers bury — a blocker with no visible
 * off switch for the current site is a blocker people uninstall.
 *
 * The template is separate from the menu for the reason stated in `tab-context-items.ts`:
 * `Menu.buildFromTemplate` needs Electron and holds no decision, while everything here is a decision.
 */

export interface BlockerMenuDeps {
  locale: Locale
  /** Requests blocked on the page this menu was opened from. */
  blockedOnPage: number
  /** How many rules the user wrote themselves, for the label. */
  userRuleCount: number
  /** False when the blocker is off entirely — picking an element would write a rule nothing applies. */
  blockerEnabled: boolean
  /** False for a page with no host to key a rule on: an internal page, a `file:` document. */
  canPickElement: boolean
  onBlockElement(): void
  onOpenSettings(): void
  onRefreshLists(): void
  onSetBlockerEnabled(enabled: boolean): void
}

export function blockerMenuTemplate(deps: BlockerMenuDeps): MenuItemConstructorOptions[] {
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
    translate(deps.locale, key, params)

  const items: MenuItemConstructorOptions[] = [
    /*
      A disabled first item, which is unusual and deliberate.

      It is the answer to the question that made the user open the menu, and putting it in the menu rather
      than only in a tooltip means it is reachable from the keyboard — a tooltip is not.
    */
    { label: t('blocker.blockedOnPage', { count: deps.blockedOnPage }), enabled: false },
    { type: 'separator' }
  ]

  if (deps.blockerEnabled && deps.canPickElement) {
    items.push({ label: t('page.blockElement'), click: () => deps.onBlockElement() })
  }

  items.push(
    {
      label: t('blocker.myRules', { count: deps.userRuleCount }),
      click: () => deps.onOpenSettings()
    },
    { label: t('blocker.updateLists'), click: () => deps.onRefreshLists() },
    { type: 'separator' },
    /*
      The off switch, as a checkbox rather than a command.

      A checkbox states the *current* state as well as offering the change, which matters here more than
      usual: somebody who turned the blocker off to fix a page and then forgot has a broken idea of why their
      adverts came back. "Blocking enabled ✓" answers that at a glance.
    */
    {
      label: t('blocker.enabled'),
      type: 'checkbox',
      checked: deps.blockerEnabled,
      click: () => deps.onSetBlockerEnabled(!deps.blockerEnabled)
    }
  )

  return items
}
