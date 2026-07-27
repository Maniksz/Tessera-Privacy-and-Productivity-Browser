import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Toolbar } from '@renderer/components/Toolbar.js'
import { TabBar } from '@renderer/components/TabBar.js'
import type { SplitState, TabState } from '@shared/model.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * The keys the toolbar and the tab strip advertise.
 *
 * What breaks if this is wrong: the tooltip names a key that does something else, or names one for a
 * button that has none. Both are only visible by reading the rendered `title`, and neither is reachable
 * from the smoke test — a native tooltip is drawn by the OS and there is no channel to ask about it.
 *
 * The mapping is what these tests are for. A button is matched to a `ShortcutAction` by what it *does*,
 * and getting that wrong is the mistake that survives review: `Home` next to `home` looks obviously
 * right, and `Reload` printing the reload key while the button says `Stop` looks obviously right too
 * until you notice the button is doing the other thing.
 */

function installBridge(): void {
  const bridge = {
    invoke: (): Promise<unknown> => Promise.resolve({ ok: true }),
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
}

function tab(overrides: Partial<TabState> = {}): TabState {
  return {
    id: 't1',
    url: 'https://example.com/',
    pendingInput: null,
    title: 'Example',
    faviconUrl: null,
    loading: false,
    canGoBack: true,
    canGoForward: true,
    pinned: false,
    muted: false,
    audible: false,
    security: 'secure',
    blockedRequests: 0,
    zoomPercent: 100,
    tileIndex: 0,
    unloaded: false,
    ...overrides
  }
}

/** Two tiles, because the maximize button only exists once there is a layout to maximize. */
function split(overrides: Partial<SplitState> = {}): SplitState {
  return {
    layout: '1x2',
    fractions: {},
    tileTabIds: ['t1', 't2'],
    tileAudio: [],
    activeTile: 0,
    maximizedTile: null,
    fullscreenTile: null,
    escalation: 'none',
    ...overrides
  }
}

function renderToolbar(
  options: { platform: 'win32' | 'darwin'; tabState?: TabState } = { platform: 'win32' }
): void {
  installBridge()
  render(
    <Toolbar
      tab={options.tabState ?? tab()}
      split={split()}
      settings={null}
      privateMode={false}
      layoutMenuOpen={false}
      focusRequest={0}
      onOpenSettings={() => {}}
      onOpenExtensions={() => {}}
      titleWithShortcut={shortcutTitles(options.platform)}
    />
  )
}

const titleOf = (name: RegExp): string =>
  screen.getByRole('button', { name }).getAttribute('title') ?? ''

afterEach(cleanup)

describe('the toolbar names the key beside the button', () => {
  it('gives navigation the keys those buttons actually fire', () => {
    renderToolbar()
    expect(titleOf(/^Back$/)).toBe('Back\nAlt+Left')
    expect(titleOf(/^Forward$/)).toBe('Forward\nAlt+Right')
    expect(titleOf(/^Reload$/)).toBe('Reload\nF5')
    expect(titleOf(/^Home$/)).toBe('Home\nAlt+Home')
  })

  it('writes them the way the platform writes them', () => {
    // The same buttons, the same actions, a different convention: symbols and no separator.
    renderToolbar({ platform: 'darwin' })
    expect(titleOf(/^Back$/)).toBe('Back\n⌘[')
    expect(titleOf(/^Reload$/)).toBe('Reload\n⌘R')
    expect(titleOf(/^Home$/)).toBe('Home\n⇧⌘H')
  })

  it('says nothing about a key while the button means Stop', () => {
    /*
      The reload button becomes a stop button mid-load, and `stop` is bound to Escape in the tables but
      registered nowhere: it is deliberately kept out of the menu so it cannot swallow Escape in a form,
      and the renderer's Escape handler walks the fullscreen ladder rather than cancelling a load.
      Printing `Esc` would promise something this browser does not do.
    */
    renderToolbar({ platform: 'win32', tabState: tab({ loading: true }) })
    expect(titleOf(/^Stop loading$/)).toBe('Stop loading')
  })

  it('names the key on the maximize button, which is a split-view command', () => {
    renderToolbar()
    expect(titleOf(/^Maximize tile$/)).toBe('Maximize tile\nCtrl+Shift+Enter')
  })

  it('keeps the key on the maximize button when it turns into Restore', () => {
    // Same action, other label. The pair used to be spelled out twice, which is how a label and its
    // accessible name drift apart.
    installBridge()
    render(
      <Toolbar
        tab={tab()}
        split={split({ maximizedTile: 0 })}
        settings={null}
        privateMode={false}
        layoutMenuOpen={false}
        focusRequest={0}
        onOpenSettings={() => {}}
        onOpenExtensions={() => {}}
        titleWithShortcut={shortcutTitles('win32')}
      />
    )
    expect(titleOf(/^Restore layout$/)).toBe('Restore layout\nCtrl+Shift+Enter')
  })

  it('names the key on Settings, which is the same panel the key opens', () => {
    renderToolbar()
    expect(titleOf(/^Settings$/)).toBe('Settings\nCtrl+,')
  })

  it('leaves the buttons with no shortcut exactly as they were', () => {
    /*
      Extensions has no `ShortcutAction`, and the security chip and the blocked-request badge are
      statements rather than commands. A key on any of them would have to be invented, and an invented
      shortcut is the failure this whole change is meant to avoid.
    */
    renderToolbar()
    expect(titleOf(/^Extensions$/)).toBe('Extensions')
    expect(document.querySelector('.omnibox__security')?.getAttribute('title')).toBe(
      'Connection is encrypted'
    )
  })

  it('leaves the layout button alone, because it opens a menu rather than applying a layout', () => {
    // The four keys that apply a layout belong on the menu's entries, drawn on the overlay layer. The
    // current layout's key here would answer a question nobody asked.
    renderToolbar()
    expect(titleOf(/^Split layout/)).not.toContain('\n')
  })

  it('keeps the accessible name free of the key', () => {
    /*
      A screen reader announcing `Back, Alt+Left` on every focus is noise, and `aria-label` beats
      `title` for the accessible name — so the key is in the tooltip only. Asserted because the obvious
      way to write this change is to put the joined string in both.
    */
    renderToolbar()
    expect(screen.getByRole('button', { name: /^Back$/ }).getAttribute('aria-label')).toBe('Back')
  })
})

describe('the tab strip names the key beside its one command', () => {
  it('gives the new-tab button the new-tab key', () => {
    installBridge()
    render(
      <TabBar
        tabs={[tab()]}
        groups={[]}
        activeTabId="t1"
        split={null}
        leftInset={0}
        rightInset={0}
        titleWithShortcut={shortcutTitles('win32')}
      />
    )
    expect(titleOf(/^New tab$/)).toBe('New tab\nCtrl+T')
  })

  it('leaves a tab and a group chip without one', () => {
    /*
      A tab already puts a second line in its `title` — the tile it sits in — which is the precedent the
      separator follows. Neither a tab nor a group chip is a command with a key, so neither grows a
      third line.
    */
    installBridge()
    render(
      <TabBar
        tabs={[tab()]}
        groups={[
          { id: 'g1', tabIds: ['t1'], name: 'Work', color: 'blue', collapsed: false, createdAt: 1 }
        ]}
        activeTabId="t1"
        split={null}
        leftInset={0}
        rightInset={0}
        titleWithShortcut={shortcutTitles('win32')}
      />
    )
    expect(document.querySelector('[data-tab-id="t1"]')?.getAttribute('title')).toBe(
      'Example\nIn tile 1'
    )
    expect(titleOf(/^Collapse group Work$/)).toBe('Work')
  })
})
