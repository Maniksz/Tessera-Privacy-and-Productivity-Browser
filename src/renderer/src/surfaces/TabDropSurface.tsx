import type { TabDropPresentation } from '@shared/overlay/surface.js'
import type { DropZone } from '@shared/split/dropzones.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * The drop indicator for a tab being dragged into a tile.
 *
 * Shows every place the page could land and fills in the one it *would* land in, which is
 * the requirement: not "a drop is possible here" but "this is where it opens". The filled
 * rectangle is the zone's `preview`, computed by the same function that positions the real
 * views, so it cannot promise a shape the layout will not produce.
 *
 * This surface also reports the pointer. The drag begins in the tab strip, but the chrome UI
 * stops seeing it the moment the pointer crosses into the content area — a native view takes
 * it there, and this layer sits above that view. So each renderer reports the part of the
 * gesture it can see and the core stitches them together.
 */

const ZONE_LABELS: Readonly<Record<DropZone['kind'], MessageKey>> = {
  tile: 'split.dropTile',
  left: 'split.dropLeft',
  right: 'split.dropRight',
  top: 'split.dropTop',
  bottom: 'split.dropBottom'
}

export function TabDropSurface({
  presentation
}: {
  presentation: TabDropPresentation
}): React.ReactNode {
  const { t } = useI18n()
  const active = presentation.zones.find((zone) => zone.id === presentation.activeZoneId) ?? null

  /** Local coordinates back into the window space the core reasons in. */
  const toWindow = (event: React.PointerEvent): { x: number; y: number } => ({
    x: event.clientX + presentation.origin.x,
    y: event.clientY + presentation.origin.y
  })

  const labelFor = (zone: DropZone): string =>
    zone.kind === 'tile'
      ? t('split.dropTile', { index: zone.tileIndex + 1 })
      : t(ZONE_LABELS[zone.kind])

  return (
    <div
      className="surface surface--drop"
      onPointerMove={(event) => {
        void invoke('drag:move', toWindow(event))
      }}
      onPointerUp={(event) => {
        void invoke('drag:end', { ...toWindow(event), commit: true })
      }}
      /* A cancelled drag — Escape, or the pointer taken away — must not move anything. */
      onPointerCancel={(event) => {
        void invoke('drag:end', { ...toWindow(event), commit: false })
      }}
    >
      {presentation.zones.map((zone) => {
        const isActive = zone.id === presentation.activeZoneId
        return (
          <div
            key={zone.id}
            className={`dropzone${isActive ? ' dropzone--active' : ''}`}
            style={{
              left: zone.preview.x,
              top: zone.preview.y,
              width: zone.preview.width,
              height: zone.preview.height
            }}
          />
        )
      })}

      {/*
        One live region for the whole surface rather than a label per zone: a screen reader
        should hear where the tab is going, not have four rectangles announced at it.
      */}
      <p className="dropzone__status" role="status">
        {active === null
          ? t('split.dragging', { title: presentation.title })
          : `${labelFor(active)} — ${presentation.title}`}
      </p>
    </div>
  )
}
