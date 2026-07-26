import type { MenuItemConstructorOptions } from 'electron'
import { translate, type Locale } from '@shared/i18n/catalog.js'

/**
 * The menu a right-click on a page opens.
 *
 * Native, for the same reasons as the tab menu: it is plain text items, so a native menu costs nothing in
 * design and gains three things a DOM menu cannot have here. It is genuinely above every native view — page
 * content is a `WebContentsView` layered over the chrome UI's own DOM, so a DOM menu would be *behind* the
 * page it was opened on. It is what the platform's assistive technology already reads. And it dismisses the
 * way the user's other applications do.
 *
 * ## Why the template is separate from the menu
 *
 * `Menu.buildFromTemplate` is the one line that needs Electron and the one line with no decision in it.
 * Everything here *is* decisions — which items a link gets that plain text does not, when "block this
 * element" may be offered at all, what a selection longer than a headline is truncated to — and each can be
 * wrong while still producing a perfectly ordinary-looking menu. Kept here they are unit tests; kept beside
 * the `Menu` import they would be unreachable from a test. `pageContextMenu.ts` is the wrapper.
 */

/** What Chromium reports about the spot that was clicked, narrowed to what a decision here needs. */
export interface PageContextTarget {
  /** The address of a link under the pointer, or `''`. */
  linkUrl: string
  /** The address of an image, video or audio element under the pointer, or `''`. */
  srcUrl: string
  /** Text the user has selected, or `''`. */
  selectionText: string
  /** True inside a text field, a textarea or a `contenteditable`. */
  isEditable: boolean
  /** The page's own address, so an internal page can be recognised. */
  pageUrl: string
}

export interface PageContextMenuDeps {
  locale: Locale
  target: PageContextTarget
  canGoBack: boolean
  canGoForward: boolean
  /** False when the blocker is switched off entirely; the picker would write a rule nothing applies. */
  blockerEnabled: boolean
  onBack(): void
  onForward(): void
  onReload(): void
  onOpenLinkInNewTab(url: string): void
  onCopy(text: string): void
  onSearchFor(text: string): void
  /** Enters picker mode: the next click on the page writes a hiding rule for what it lands on. */
  onBlockElement(): void
  onInspect(): void
}

/**
 * How much selected text goes into the menu label.
 *
 * A paragraph in a menu item is a menu item nobody can read, and the platforms differ in where they cut it
 * off — so it is cut here, at a length that still identifies what was selected.
 */
export const MAX_SELECTION_LABEL = 24

/**
 * True for a page where "block this element" makes no sense.
 *
 * A picked rule is keyed on a registrable domain, so a document with no host has nothing to key on — and
 * an internal page must never be filtered by a rule, or the user could hide the button that undoes it.
 */
function isFilterable(pageUrl: string): boolean {
  try {
    const { protocol } = new URL(pageUrl)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function truncate(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= MAX_SELECTION_LABEL) return collapsed
  // A trailing ellipsis rather than a hard cut, so it reads as shortened rather than as a bug.
  return `${collapsed.slice(0, MAX_SELECTION_LABEL - 1)}…`
}

export function pageContextMenuTemplate(
  deps: PageContextMenuDeps
): MenuItemConstructorOptions[] {
  const { target, locale } = deps
  const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>): string =>
    translate(locale, key, params)

  const items: MenuItemConstructorOptions[] = []

  /*
    A link's own actions come first when there is a link.

    Ordered by what the user is most likely to have right-clicked *for*: on a link, opening it elsewhere; on
    a selection, doing something with the text. Navigation is what is left when the pointer is over nothing
    in particular, so it goes below rather than always at the top — a menu whose first item is "Back" when
    the user right-clicked a link is a menu that has misread them.
  */
  if (target.linkUrl !== '') {
    items.push(
      {
        label: t('page.openLinkInNewTab'),
        click: () => deps.onOpenLinkInNewTab(target.linkUrl)
      },
      {
        label: t('page.copyLinkAddress'),
        click: () => deps.onCopy(target.linkUrl)
      },
      { type: 'separator' }
    )
  }

  if (target.srcUrl !== '' && target.linkUrl === '') {
    // Only when it is not also a link: two "copy address" items one above the other, for two different
    // addresses, is a choice nobody can make correctly at a glance.
    items.push({ label: t('page.copyImageAddress'), click: () => deps.onCopy(target.srcUrl) }, { type: 'separator' })
  }

  if (target.selectionText !== '') {
    items.push(
      { label: t('page.copy'), click: () => deps.onCopy(target.selectionText) },
      {
        label: t('page.searchFor', { text: truncate(target.selectionText) }),
        click: () => deps.onSearchFor(target.selectionText)
      },
      { type: 'separator' }
    )
  }

  items.push(
    // The application menu's own labels, not a third spelling of "Back": one word, one translation.
    { label: t('menu.history.back'), enabled: deps.canGoBack, click: () => deps.onBack() },
    { label: t('menu.history.forward'), enabled: deps.canGoForward, click: () => deps.onForward() },
    { label: t('menu.view.reload'), click: () => deps.onReload() }
  )

  /*
    "Block this element", and the two conditions on it.

    Absent rather than disabled where it cannot work: an item greyed out on every internal page teaches the
    user it is broken, whereas one that simply is not there on `tessera://settings` reads as "not applicable
    here" — which it is.

    Inside a text field it is also absent. The user right-clicking a textarea wants their text, and an item
    that arms a click-to-hide mode above the field they are typing in is a trap.
  */
  if (deps.blockerEnabled && !target.isEditable && isFilterable(target.pageUrl)) {
    items.push({ type: 'separator' }, { label: t('page.blockElement'), click: () => deps.onBlockElement() })
  }

  items.push({ type: 'separator' }, { label: t('page.inspect'), click: () => deps.onInspect() })
  return items
}
