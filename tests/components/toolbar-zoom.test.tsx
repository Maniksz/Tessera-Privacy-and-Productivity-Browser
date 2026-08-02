import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Toolbar } from '@renderer/components/Toolbar.js'
import type { PaneZoom } from '@shared/zoom/model.js'
import type { SplitState, TabState } from '@shared/model.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * The zoom badge: when it is there, what it says, and what pressing it does.
 *
 * Reported as *"es gibt keinen zoom reset button"*, and the command was not the missing part — the
 * View menu has had Reset Zoom and `Ctrl+0` all along. What was missing is that **nothing on screen
 * ever said a pane was zoomed**, so the way back was a shortcut you had to already know about. A
 * trackpad pinch is easy to perform by accident and, until this, hard to undo by looking.
 *
 * The rule under test is therefore about *presence* more than about the number, and it is not "zoom is
 * not 100": it is "this pane is not at the size this profile calls normal". Those differ the moment
 * somebody sets `appearance.defaultZoom`, and getting it wrong the obvious way — comparing against 100
 * — would put a permanent badge on every pane of a person who reads at 125 %.
 */

const invocations: Array<{ channel: string; payload: unknown }> = []

function installBridge(): void {
  const bridge = {
    invoke: (channel: string, payload: unknown): Promise<unknown> => {
      invocations.push({ channel, payload })
      return Promise.resolve({ ok: true })
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
}

function tab(zoomPercent: PaneZoom): TabState {
  return {
    id: 't1',
    url: 'https://example.com/',
    pendingInput: null,
    title: 'Example',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    pinned: false,
    muted: false,
    audible: false,
    security: 'secure',
    blockedRequests: 0,
    zoomPercent,
    tileIndex: 0,
    unloaded: false
  }
}

function split(): SplitState {
  return {
    layout: '1x1',
    fractions: {},
    tileTabIds: ['t1'],
    tileAudio: [],
    activeTile: 0,
    maximizedTile: null,
    fullscreenTile: null,
    escalation: 'none'
  }
}

function settingsWithDefaultZoom(percent: number): SettingsSnapshot {
  return { ...defaultSettings(), 'appearance.defaultZoom': percent }
}

function renderToolbar(zoomPercent: PaneZoom, defaultZoom = 100): void {
  installBridge()
  render(
    <Toolbar
      tab={tab(zoomPercent)}
      split={split()}
      settings={settingsWithDefaultZoom(defaultZoom)}
      privateMode={false}
      layoutMenuOpen={false}
      focusRequest={0}
      onOpenSettings={() => {}}
      onOpenExtensions={() => {}}
      titleWithShortcut={shortcutTitles('win32')}
    />
  )
}

/** The badge, or null. Matched on the accessible name, which carries the command and the level. */
const badge = (): HTMLElement | null => screen.queryByRole('button', { name: /^Reset zoom/ })

afterEach(() => {
  invocations.length = 0
  cleanup()
})

describe('a pane at the size this profile calls normal', () => {
  it('shows no badge when it has never been zoomed', () => {
    renderToolbar(null)
    expect(badge()).toBeNull()
  })

  it('shows no badge when it was zoomed back to exactly the default', () => {
    /*
      `null` and `100` are different states — see `PaneZoom` — and this asserts that the difference is
      deliberately *not* visible here. A badge on a pane that looks like every other pane would be a
      control the user cannot act on: pressing it changes nothing they can see.
    */
    renderToolbar(100)
    expect(badge()).toBeNull()
  })

  it('measures normal against the setting rather than against 100', () => {
    // The case that makes the comparison worth writing down: at `appearance.defaultZoom: 125`, a pane
    // at 125 is a pane nobody has touched, and the naive test against 100 would badge all of them.
    renderToolbar(125, 125)
    expect(badge()).toBeNull()
  })
})

describe('a pane that is not at that size', () => {
  it('says how far off it is', () => {
    renderToolbar(150)
    expect(badge()?.textContent).toBe('150%')
  })

  it('appears at 100 % when the profile reads at 125 %', () => {
    // The mirror of the case above, and the reason the rule is a comparison rather than a threshold:
    // *smaller* than normal is just as much a pane somebody needs a way back from.
    renderToolbar(100, 125)
    expect(badge()?.textContent).toBe('100%')
  })

  it('names the command and the level to a screen reader, not just the number', () => {
    renderToolbar(150)
    // The face of the button is a bare number, which says nothing on its own about what pressing it
    // does. The accessible name has to carry both.
    expect(badge()?.getAttribute('aria-label')).toBe('Reset zoom: 150%')
  })

  it('offers the key that does the same thing, so the badge teaches the shortcut', () => {
    renderToolbar(150)
    // Two lines, which is `shortcutTitles`' own shape — the label, then the key under it.
    expect(badge()?.getAttribute('title')).toBe('Reset zoom\nCtrl+0')
  })

  it('resets rather than setting the number the default happens to hold', () => {
    /*
      `zoom:reset` and nothing else. The plausible-looking alternative — `settings` says 100, so put the
      pane at 100 — leaves the pane *touched*, so a later change to `appearance.defaultZoom` would no
      longer reach it. Reset is the only way back into the group that follows the setting.
    */
    renderToolbar(150)
    const button = badge()
    expect(button).not.toBeNull()
    fireEvent.click(button!)
    expect(invocations).toEqual([{ channel: 'zoom:reset', payload: {} }])
  })
})

describe('before the settings have arrived', () => {
  it('shows nothing, because what counts as normal is not known yet', () => {
    /*
      The first paint of a window happens before `settings:getAll` answers. Guessing 100 there would
      flash a badge onto every pane of a profile that reads at 125 % and then take it away again.
    */
    installBridge()
    render(
      <Toolbar
        tab={tab(150)}
        split={split()}
        settings={null}
        privateMode={false}
        layoutMenuOpen={false}
        focusRequest={0}
        onOpenSettings={() => {}}
        onOpenExtensions={() => {}}
        titleWithShortcut={shortcutTitles('win32')}
      />
    )
    expect(badge()).toBeNull()
  })
})
