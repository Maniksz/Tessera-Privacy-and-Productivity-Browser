import { describe, expect, it } from 'vitest'
import { findService } from '@main/find/service.js'
import { notifyOverlayVacancy } from '@main/permissions/vacancy.js'
import type { FindHost } from '@main/find/FindController.js'
import type { FindTarget } from '@main/find/page-search.js'
import type { OverlayPresentation, OverlayState } from '@shared/overlay/surface.js'
import type { FindStopAction } from '@shared/find/session.js'

/**
 * The one wire between a find bar leaving the overlay layer and the highlight coming off the page.
 *
 * Small, and worth a test for one reason: the subscription is made in exactly one place, on first
 * use, and if it were ever dropped nothing else would fail. Every unit test of the controller drives
 * `overlayVacated` directly, so all of them would still pass while the shipped browser left a
 * highlighted match on every page a find bar had ever visited.
 */

interface Recorded {
  action: FindStopAction
}

function pageAndHost(): { stops: Recorded[]; host: FindHost; presented: OverlayPresentation[] } {
  const stops: Recorded[] = []
  const bounds = { x: 0, y: 88, width: 800, height: 600 }
  const target: FindTarget = {
    id: 'tab-1',
    tileIndex: 0,
    view: {
      getBounds: () => bounds,
      webContents: {
        isDestroyed: () => false,
        findInPage: () => 1,
        stopFindInPage: (action) => {
          stops.push({ action })
        },
        on: () => undefined,
        removeListener: () => undefined
      }
    }
  }

  const presented: OverlayPresentation[] = []
  let overlay: OverlayState = null
  const host: FindHost = {
    activeTab: () => target,
    tab: (tabId) => (tabId === target.id ? target : undefined),
    presentOverlay: (presentation) => {
      overlay = presentation
      presented.push(presentation)
    },
    dismissOverlay: () => {
      overlay = null
    },
    overlayPresentation: () => overlay
  }
  return { stops, host, presented }
}

describe('the find service', () => {
  it('is one controller for the whole application', () => {
    // Per window would mean one subscription to the vacancy registry per window, each of them
    // handling every other window's announcements.
    expect(findService()).toBe(findService())
  })

  it('clears the page when the layer announces that a bar has gone', () => {
    const { stops, host, presented } = pageAndHost()
    const find = findService()
    find.open(host)
    find.setQuery(host, 'tab-1', 'needle')

    const [bar] = presented.slice(-1)
    expect(bar?.kind).toBe('find-bar')
    if (bar === undefined) return

    // Exactly what `OverlayLayer` does when a resize, a blur or a permission prompt takes the bar off.
    notifyOverlayVacancy(bar, 'dismissed')

    expect(stops).toEqual([{ action: 'clearSelection' }])
    expect(find.sessionFor(host)).toBeNull()
  })
})
