import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { LAYOUT_IDS, TILE_COUNT, type LayoutId } from '@shared/split/layout.js'
import type { LayoutMenuPresentation } from '@shared/overlay/surface.js'
import { anchorSurface, type Rect } from '@shared/ui/anchor.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'
import { LAYOUT_LABELS, LayoutIcon } from '../components/LayoutIcon.js'
import { LAYOUT_SHORTCUTS } from '@shared/split/labels.js'
import { shortcutKey } from '@shared/shortcuts/format.js'
import type { Platform } from '@shared/model.js'

/*
  The saved workspaces and "Save as…" (U21), in a chunk of their own for the reason `OverlaySurface`
  gives its rarer surfaces: this layer's main chunk has a 20 kB budget it sits just under. The seven
  layouts are drawn at once; the list follows a frame later, and the menu measures itself again then.
*/
const WorkspacesMenu = lazy(() =>
  import('./WorkspacesMenu.js').then((module) => ({ default: module.WorkspacesMenu }))
)

/**
 * The split-layout menu, drawn on the overlay surface.
 *
 * It lives here rather than next to its button because the button's renderer sits *beneath*
 * the native tab views: a menu rendered there is painted behind the page and receives no
 * clicks. The button therefore describes where it is, and this draws the menu there.
 */

export function LayoutMenuSurface({
  presentation,
  platform,
  overrides
}: {
  presentation: LayoutMenuPresentation
  /** `null` until the window state arrives; the entries then render without their keys. */
  platform: Platform | null
  overrides: Readonly<Record<string, string>>
}): React.ReactNode {
  const { t } = useI18n()
  const menuRef = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState<Rect | null>(null)
  // Bumped when the workspaces below the layouts change height; a new measuring pass follows.
  const [contentVersion, setContentVersion] = useState(0)
  const focused = useRef(false)
  const remeasure = useCallback(() => setContentVersion((version) => version + 1), [])

  /**
   * Measure, then place.
   *
   * The list's height depends on the translated labels and the platform's font, so a
   * hard-coded number would put the menu in the wrong place in some locales and on some
   * machines. `useLayoutEffect` runs before paint, so the unpositioned first pass is never
   * shown. A later pass (the workspaces arrived or changed) runs under the height the last one
   * set, so the content's own height is read as well: `scrollHeight` plus the borders.
   */
  useLayoutEffect(() => {
    const element = menuRef.current
    if (element === null) return
    const natural = element.getBoundingClientRect()
    const content = element.scrollHeight + element.offsetHeight - element.clientHeight
    const placed = anchorSurface(
      presentation.anchor,
      { width: natural.width, height: Math.max(natural.height, content) },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setRect(placed.rect)
  }, [presentation, contentVersion])

  useEffect(() => {
    focused.current = false
  }, [presentation])

  // Opens with the active arrangement focused, so the keyboard user starts from where they
  // are rather than from the top of the list — once: a later measuring pass must not take the
  // focus off a workspace's name field.
  useEffect(() => {
    if (rect === null || focused.current) return
    focused.current = true
    menuRef.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
  }, [rect])

  const choose = (layout: LayoutId): void => {
    // The core dismisses the surface as part of applying the layout, so the menu never
    // lingers showing a radio state the window no longer matches.
    void invoke('split:setLayout', { layout })
  }

  /**
   * The key that applies this arrangement, or `''` for one that has none.
   *
   * Four of the seven have a key (`LAYOUT_SHORTCUTS`), and they are the *only* place those four are
   * visible: they are registered in the application menu through a loop, so no menu the user opens spells
   * them out, and the button that opens this menu deliberately shows none — it opens a menu rather than
   * applying a layout, so the key of the arrangement the window is already in would answer a question
   * nobody asked.
   */
  const keyFor = (layout: LayoutId): string => {
    const action = LAYOUT_SHORTCUTS[layout]
    return action === undefined ? '' : shortcutKey(platform, action, overrides)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      void invoke('overlay:dismiss')
      return
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()

    const items = [
      ...(menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitemradio"], [role="menuitem"]:not(:disabled)'
      ) ?? [])
    ]
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    const delta = event.key === 'ArrowDown' ? 1 : -1
    items[(index + delta + items.length) % items.length]?.focus()
  }

  const label = t('toolbar.layout', { current: t(LAYOUT_LABELS[presentation.current]) })

  return (
    <div
      ref={menuRef}
      className="menu"
      role="menu"
      aria-label={label}
      onKeyDown={onKeyDown}
      style={
        rect === null
          ? // Hidden for the measuring pass only; `useLayoutEffect` replaces this before paint.
            { visibility: 'hidden' }
          : { left: rect.x, top: rect.y, maxHeight: rect.height }
      }
    >
      {LAYOUT_IDS.map((layout) => {
        const isCurrent = layout === presentation.current
        return (
          <button
            key={layout}
            type="button"
            role="menuitemradio"
            aria-checked={isCurrent}
            className={`menu__item${isCurrent ? ' menu__item--current' : ''}`}
            onClick={() => choose(layout)}
          >
            <span className="menu__icon">
              <LayoutIcon layout={layout} size={16} />
            </span>
            <span className="menu__label">{t(LAYOUT_LABELS[layout])}</span>
            <span className="menu__hint">
              {t('toolbar.layoutTileCount', { count: TILE_COUNT[layout] })}
            </span>
            {/*
              The key in its own column, which is where a menu is read for one — not in a tooltip. Three
              of the seven arrangements have no key and get an empty cell rather than a shifted row.
            */}
            <span className="menu__key">{keyFor(layout)}</span>
          </button>
        )
      })}
      <Suspense fallback={null}>
        <WorkspacesMenu onResize={remeasure} />
      </Suspense>
    </div>
  )
}
