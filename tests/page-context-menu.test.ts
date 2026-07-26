import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SELECTION_LABEL,
  pageContextMenuTemplate,
  type PageContextMenuDeps,
  type PageContextTarget
} from '@main/menu/page-context-items.js'
import { blockerMenuTemplate, type BlockerMenuDeps } from '@main/menu/blocker-menu-items.js'

/**
 * What a right-click offers, and what it must not offer.
 *
 * Every decision in these two templates can be wrong while still producing a menu that looks entirely
 * ordinary — an item missing where it was needed, or present where it does harm. The ones that matter:
 * "block this element" must not appear on a page where a rule cannot be keyed, must not appear inside a text
 * field, and must not appear when the blocker is off, because in all three cases it would arm a mode that
 * then does nothing.
 */

function target(overrides: Partial<PageContextTarget> = {}): PageContextTarget {
  return {
    linkUrl: '',
    srcUrl: '',
    selectionText: '',
    isEditable: false,
    pageUrl: 'https://example.com/page',
    ...overrides
  }
}

function pageMenu(overrides: Partial<PageContextMenuDeps> = {}): PageContextMenuDeps {
  return {
    locale: 'en',
    target: target(),
    canGoBack: true,
    canGoForward: false,
    blockerEnabled: true,
    onBack: vi.fn(),
    onForward: vi.fn(),
    onReload: vi.fn(),
    onOpenLinkInNewTab: vi.fn(),
    onCopy: vi.fn(),
    onSearchFor: vi.fn(),
    onBlockElement: vi.fn(),
    onInspect: vi.fn(),
    ...overrides
  }
}

/**
 * Clicks the item with this label, or fails.
 *
 * Added after a mutation run: every test here asserted *which* items appear and none clicked one, so replacing
 * any handler body with `() => undefined` survived. A menu whose items are all present and all inert is exactly
 * the failure a label assertion cannot see.
 */
function click(
  items: ReturnType<typeof pageContextMenuTemplate>,
  label: string
): void {
  const item = items.find((candidate) => candidate.label === label)
  if (item?.click === undefined) throw new Error(`no clickable item labelled ${label}`)
  // The template's handlers take no arguments; Electron's signature is wider.
  ;(item.click as () => void)()
}

/** The labels, with separators dropped — what a person actually reads. */
function labels(
  // Both templates return `MenuItemConstructorOptions[]`, so one name covers both.
  items: ReturnType<typeof pageContextMenuTemplate>
): string[] {
  return items
    .filter((item) => item.type !== 'separator')
    .map((item) => (typeof item.label === 'string' ? item.label : ''))
}

describe('offering to block an element', () => {
  it('offers it on an ordinary page', () => {
    expect(labels(pageContextMenuTemplate(pageMenu()))).toContain('Block element…')
  })

  it('does not offer it on an internal page', () => {
    /*
      A picked rule is keyed on a registrable domain, and an internal page must never be filtered by one — the
      user could hide the switch that undoes it. Absent rather than greyed out: an item disabled on every
      internal page teaches the user it is broken, where one that is simply not there reads as not applicable.
    */
    const items = pageContextMenuTemplate(
      pageMenu({ target: target({ pageUrl: 'tessera://settings' }) })
    )
    expect(labels(items)).not.toContain('Block element…')
  })

  it('does not offer it on a page with no host at all', () => {
    for (const pageUrl of ['about:blank', 'data:text/html,<p>x', 'file:///tmp/page.html', 'nonsense']) {
      const items = pageContextMenuTemplate(pageMenu({ target: target({ pageUrl }) }))
      expect(labels(items), pageUrl).not.toContain('Block element…')
    }
  })

  it('does not offer it inside a text field', () => {
    // Somebody right-clicking a textarea wants their text. An item that arms a click-to-hide mode over the
    // field they are typing in is a trap, not a feature.
    const items = pageContextMenuTemplate(pageMenu({ target: target({ isEditable: true }) }))
    expect(labels(items)).not.toContain('Block element…')
  })

  it('does not offer it when the blocker is switched off', () => {
    // The rule would be written and nothing would apply it, which is worse than not offering: the user would
    // believe the element was blocked.
    const items = pageContextMenuTemplate(pageMenu({ blockerEnabled: false }))
    expect(labels(items)).not.toContain('Block element…')
  })
})

describe('what each item actually does', () => {
  it('navigates the tab the menu was opened on', () => {
    const onBack = vi.fn()
    const onForward = vi.fn()
    const onReload = vi.fn()
    const items = pageContextMenuTemplate(pageMenu({ onBack, onForward, onReload, canGoForward: true }))

    click(items, 'Back')
    click(items, 'Forward')
    click(items, 'Reload')
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(onForward).toHaveBeenCalledTimes(1)
    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('opens the link that was clicked, not the page', () => {
    // The argument is the point: a handler that passed the page address would compile, look right in the menu,
    // and open the wrong thing.
    const onOpenLinkInNewTab = vi.fn()
    const items = pageContextMenuTemplate(
      pageMenu({ target: target({ linkUrl: 'https://other.example/x' }), onOpenLinkInNewTab })
    )
    click(items, 'Open link in new tab')
    expect(onOpenLinkInNewTab).toHaveBeenCalledWith('https://other.example/x')
  })

  it('copies the link address, and separately the image address', () => {
    const onCopy = vi.fn()
    click(
      pageContextMenuTemplate(
        pageMenu({ target: target({ linkUrl: 'https://a.example/' }), onCopy })
      ),
      'Copy link address'
    )
    expect(onCopy).toHaveBeenLastCalledWith('https://a.example/')

    click(
      pageContextMenuTemplate(
        pageMenu({ target: target({ srcUrl: 'https://cdn.example/i.png' }), onCopy })
      ),
      'Copy image address'
    )
    expect(onCopy).toHaveBeenLastCalledWith('https://cdn.example/i.png')
  })

  it('searches for the whole selection, not the shortened label', () => {
    /*
      The label is truncated for the menu; the *search* must not be. A handler that passed the shortened text
      would look correct in every screenshot and quietly search for half a sentence.
    */
    const long = 'the quick brown fox jumps over the lazy dog and keeps going'
    const onSearchFor = vi.fn()
    const items = pageContextMenuTemplate(
      pageMenu({ target: target({ selectionText: long }), onSearchFor })
    )
    const label = labels(items).find((text) => text.startsWith('Search for'))
    click(items, label ?? '')
    expect(onSearchFor).toHaveBeenCalledWith(long)
  })

  it('copies the selection verbatim, including its whitespace', () => {
    // The label collapses whitespace so a two-line selection fits one row. What is copied must not be collapsed:
    // the user selected that text and expects it back.
    const onCopy = vi.fn()
    const items = pageContextMenuTemplate(
      pageMenu({ target: target({ selectionText: '  two\n  lines  ' }), onCopy })
    )
    click(items, 'Copy')
    expect(onCopy).toHaveBeenCalledWith('  two\n  lines  ')
  })

  it('arms the picker, and opens the inspector', () => {
    const onBlockElement = vi.fn()
    const onInspect = vi.fn()
    const items = pageContextMenuTemplate(pageMenu({ onBlockElement, onInspect }))
    click(items, 'Block element…')
    click(items, 'Inspect')
    expect(onBlockElement).toHaveBeenCalledTimes(1)
    expect(onInspect).toHaveBeenCalledTimes(1)
  })
})

describe('what a right-click was probably for', () => {
  it('puts a link its own actions above navigation', () => {
    /*
      Order as a claim about intent. A menu whose first item is "Back" when the user right-clicked a link has
      misread them, and on a platform where the first item is pre-highlighted that misreading is one Return
      away from losing the page.
    */
    const items = labels(
      pageContextMenuTemplate(pageMenu({ target: target({ linkUrl: 'https://other.example/' }) }))
    )
    expect(items.indexOf('Open link in new tab')).toBeLessThan(items.indexOf('Back'))
  })

  it('offers one copy-address item, not two, for a linked image', () => {
    // Two "copy address" rows one above the other, for two different addresses, is a choice nobody can make
    // correctly at a glance.
    const items = labels(
      pageContextMenuTemplate(
        pageMenu({
          target: target({ linkUrl: 'https://other.example/', srcUrl: 'https://cdn.example/i.png' })
        })
      )
    )
    expect(items).toContain('Copy link address')
    expect(items).not.toContain('Copy image address')
  })

  it('offers the image address when the image is not a link', () => {
    const items = labels(
      pageContextMenuTemplate(pageMenu({ target: target({ srcUrl: 'https://cdn.example/i.png' }) }))
    )
    expect(items).toContain('Copy image address')
  })

  it('shortens a long selection instead of putting a paragraph in a menu', () => {
    const long = 'the quick brown fox jumps over the lazy dog and keeps going for quite a while'
    const items = labels(pageContextMenuTemplate(pageMenu({ target: target({ selectionText: long }) })))
    const search = items.find((label) => label.startsWith('Search for'))
    expect(search).toBeDefined()
    expect(search?.length, search).toBeLessThan(50)
    expect(search).toContain('…')
  })

  it('leaves a short selection intact', () => {
    const items = labels(pageContextMenuTemplate(pageMenu({ target: target({ selectionText: 'fox' }) })))
    expect(items).toContain('Search for “fox”')
  })

  it('shortens at exactly one character past the limit and not before', () => {
    /*
      The boundary, pinned. A mutation run showed `<=` and `- 1` both surviving here, which means the previous
      tests proved *that* a long selection is shortened and said nothing about where — so the label could have
      been one character longer or shorter than intended and nothing would have noticed.
    */
    const exact = 'x'.repeat(MAX_SELECTION_LABEL)
    const oneOver = 'x'.repeat(MAX_SELECTION_LABEL + 1)

    const untouched = labels(
      pageContextMenuTemplate(pageMenu({ target: target({ selectionText: exact }) }))
    ).find((text) => text.startsWith('Search for'))
    expect(untouched).toBe(`Search for “${exact}”`)

    const shortened = labels(
      pageContextMenuTemplate(pageMenu({ target: target({ selectionText: oneOver }) }))
    ).find((text) => text.startsWith('Search for'))
    // One character short of the limit, plus the ellipsis.
    expect(shortened).toBe(`Search for “${'x'.repeat(MAX_SELECTION_LABEL - 1)}…”`)
  })

  it('collapses whitespace in a selection', () => {
    // A selection spanning two lines carries a newline, and a newline in a native menu label is either
    // ignored or breaks the row depending on the platform.
    const items = labels(
      pageContextMenuTemplate(pageMenu({ target: target({ selectionText: '  two\n  lines  ' }) }))
    )
    expect(items).toContain('Search for “two lines”')
  })

  it('disables navigation that cannot happen', () => {
    const items = pageContextMenuTemplate(pageMenu({ canGoBack: false, canGoForward: false }))
    const back = items.find((item) => item.label === 'Back')
    expect(back?.enabled).toBe(false)
  })

  it('always offers inspect', () => {
    // The one item that works everywhere, including on a page where nothing else applies.
    const items = labels(pageContextMenuTemplate(pageMenu({ target: target({ pageUrl: 'about:blank' }) })))
    expect(items).toContain('Inspect')
  })
})

function blocker(overrides: Partial<BlockerMenuDeps> = {}): BlockerMenuDeps {
  return {
    locale: 'en',
    blockedOnPage: 12,
    userRuleCount: 3,
    blockerEnabled: true,
    canPickElement: true,
    onBlockElement: vi.fn(),
    onOpenSettings: vi.fn(),
    onRefreshLists: vi.fn(),
    onSetBlockerEnabled: vi.fn(),
    ...overrides
  }
}

describe('the blocker badge menu', () => {
  it('answers the question that made the user open it', () => {
    // In the menu rather than only in a tooltip, because a tooltip cannot be reached from the keyboard.
    const first = blockerMenuTemplate(blocker())[0]
    expect(first?.label).toBe('12 requests blocked on this page')
    expect(first?.enabled, 'the count is a statement, not a command').toBe(false)
  })

  it('states whether blocking is on rather than only offering to change it', () => {
    /*
      A checkbox, not a command. Somebody who switched the blocker off to fix one page and forgot has a wrong
      idea of why their adverts came back — and "Blocking enabled ✓" answers that without them having to
      remember.
    */
    const on = blockerMenuTemplate(blocker()).find((item) => item.label === 'Blocking enabled')
    expect(on?.type).toBe('checkbox')
    expect(on?.checked).toBe(true)

    const off = blockerMenuTemplate(blocker({ blockerEnabled: false })).find(
      (item) => item.label === 'Blocking enabled'
    )
    expect(off?.checked).toBe(false)
  })

  it('keeps the off switch reachable when the blocker is already off', () => {
    // The one item that must never disappear with the feature: a blocker with no visible way back on is a
    // blocker people uninstall.
    const items = blockerMenuTemplate(blocker({ blockerEnabled: false, canPickElement: false }))
    expect(labels(items)).toContain('Blocking enabled')
  })

  it('hides element picking where it could not work, and keeps everything else', () => {
    const items = labels(blockerMenuTemplate(blocker({ canPickElement: false })))
    expect(items).not.toContain('Block element…')
    expect(items).toContain('Update filter lists now')
    expect(items).toContain('My rules (3)')
  })

  it('says how many rules the user wrote', () => {
    expect(labels(blockerMenuTemplate(blocker({ userRuleCount: 0 })))).toContain('My rules (0)')
  })

  it('does what each of its items says', () => {
    // Same gap the page menu had: every assertion here checked labels and none clicked, so a handler replaced by
    // `() => undefined` survived. The off switch is the one that matters most — a menu that displays the state
    // correctly and cannot change it is worse than no menu.
    const onBlockElement = vi.fn()
    const onOpenSettings = vi.fn()
    const onRefreshLists = vi.fn()
    const onSetBlockerEnabled = vi.fn()
    const items = blockerMenuTemplate(
      blocker({ onBlockElement, onOpenSettings, onRefreshLists, onSetBlockerEnabled })
    )

    click(items, 'Block element…')
    click(items, 'My rules (3)')
    click(items, 'Update filter lists now')
    click(items, 'Blocking enabled')

    expect(onBlockElement).toHaveBeenCalledTimes(1)
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
    expect(onRefreshLists).toHaveBeenCalledTimes(1)
    // Toggled, not set: clicking a checked box must switch it off. `true` here would mean the box could only
    // ever be turned on, which reads as the menu ignoring the click.
    expect(onSetBlockerEnabled).toHaveBeenCalledWith(false)
  })

  it('turns blocking back on from the unchecked state', () => {
    const onSetBlockerEnabled = vi.fn()
    click(
      blockerMenuTemplate(blocker({ blockerEnabled: false, onSetBlockerEnabled })),
      'Blocking enabled'
    )
    expect(onSetBlockerEnabled).toHaveBeenCalledWith(true)
  })
})
