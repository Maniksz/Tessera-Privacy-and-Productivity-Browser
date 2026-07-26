import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsPanel } from '@renderer/components/SettingsPanel.js'
import { ExtensionsPanel } from '@renderer/components/ExtensionsPanel.js'
import { I18nProvider } from '@renderer/i18n.js'
import { SettingsPage } from '@renderer-internal/SettingsPage.js'
import { ExtensionsPage } from '@renderer-internal/ExtensionsPage.js'
import { INTERNAL_PAGE_INVOKE_CHANNELS } from '@shared/ipc/channels.js'
import type { SettingDescriptor } from '@shared/settings/control.js'
import type { ExtensionInfo } from '@shared/extensions/model.js'
import type { OwnBrowserBridge } from '../../src/preload/api.js'
import type { OwnBrowserInternalBridge } from '../../src/preload/internal-api.js'

/**
 * Settings and extensions, in both of their entry points, through both of their real bridges.
 *
 * ## The claim this file exists to hold
 *
 * The user asked to keep the in-window panels *and* have real `tessera://settings` and
 * `tessera://extensions` tabs. The answer was "both entry points, one implementation" — so what has to
 * be tested is not that settings work, but that nothing about them depends on which host is rendering
 * them. `settings-view.test.tsx` tests the shared view against a hand-written host, which proves the
 * view is host-agnostic; it cannot prove that the two *adapters* are wired to the bridges they claim.
 * A settings page whose adapter silently called the chrome bridge would pass every test in that file
 * and fail the moment it ran in a sandboxed renderer, where `window.tessera` does not exist.
 *
 * So these tests go in through `SettingsPanel` / `ExtensionsPanel` — the chrome entry points, which read
 * `window.tessera` — and through `SettingsPage` / `ExtensionsPage`, which read `window.tesseraInternal`.
 * Both globals are installed at once in the tests that matter, so "the panel wrote through the chrome
 * bridge" is asserted together with "the internal bridge saw nothing", and the other way round. Neither
 * assertion means much alone: with only one bridge present, an adapter reaching for the wrong one throws
 * and looks like a broken test rather than a crossed wire.
 *
 * ## Why the bridges are replaced on the window rather than mocked as modules
 *
 * `src/renderer/src/bridge.ts` and `src/renderer/internal/bridge.ts` both read their global on *every*
 * call, which is exactly the seam a renderer has: the preload installs an object and the page finds it
 * there. Replacing the global tests the same path the real surfaces take, module mocking would test a
 * path that only exists under Vitest.
 */

/**
 * Puts a bridge on the window, or takes it off again.
 *
 * `defineProperty` rather than assignment because both `api.d.ts` and `internal-api.d.ts` declare their
 * property `readonly` — which is right: a page must not be able to swap its own bridge, and the preload
 * installs it once. A test replacing it is the one legitimate exception, and going through
 * `defineProperty` makes that exception visible instead of hiding it behind a widening cast.
 */
function define(property: 'tessera' | 'tesseraInternal', value: unknown): void {
  Object.defineProperty(window, property, { value, configurable: true, writable: true })
}

interface Call {
  channel: string
  payload: unknown
}

/**
 * The descriptors both hosts are given.
 *
 * Four kinds rather than one, so "the same controls either way" is a claim about the whole control
 * table and not about a single checkbox that would render the same by accident.
 */
const DESCRIPTORS: SettingDescriptor[] = [
  { key: 'privacy.blockerEnabled', kind: 'toggle', section: 'privacy', applies: 'live' },
  {
    key: 'privacy.referrerPolicy',
    kind: 'choice',
    section: 'privacy',
    applies: 'new-tab',
    choices: ['origin-only', 'strict']
  },
  {
    key: 'splitView.maxTiles',
    kind: 'number',
    section: 'splitView',
    applies: 'restart',
    min: 1,
    max: 4,
    integer: true
  },
  { key: 'network.blockedHosts', kind: 'text-list', section: 'network', applies: 'live' }
]

const STORED: Record<string, unknown> = {
  'privacy.blockerEnabled': true,
  'privacy.referrerPolicy': 'strict',
  'splitView.maxTiles': 4,
  'network.blockedHosts': ['ads.example', 'trackers.example']
}

const EXTENSIONS: ExtensionInfo[] = [
  { id: 'aaaa', name: 'Test extension', version: '1.2.3', path: '/tmp/unpacked' }
]

interface FakeCore {
  calls: Call[]
  /** Channels seen, in order, for asserting against a page's allowlist. */
  channels: () => string[]
  bridge: OwnBrowserBridge & OwnBrowserInternalBridge
}

/**
 * One fake core, installable on either global.
 *
 * Deliberately a single implementation for both bridges: the two differ in *which* channels they carry,
 * and that difference is enforced by the preload and by `sender-policy.ts` in the core, not by the shape
 * of the object. Writing two stubs here would invent a difference the running system does not have, and
 * would hide the one it does — which is checked directly against `INTERNAL_PAGE_INVOKE_CHANNELS` below.
 */
function fakeCore(
  options: {
    refuse?: Record<string, string>
    /** A folder the core could not read, which it reports as data rather than as a rejection. */
    loadError?: string
  } = {}
): FakeCore {
  const calls: Call[] = []
  const snapshot = { ...STORED }
  let extensions = [...EXTENSIONS]

  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      const refusal = options.refuse?.[channel]
      if (refusal !== undefined) return Promise.reject(new Error(refusal))

      switch (channel) {
        // An empty catalogue on purpose: both `I18nProvider` and `useInternalI18n` fall back to the
        // bundled default locale, so the assertions below read as the real English strings a user sees
        // rather than as message keys. The two hosts sharing that fallback is itself part of the claim.
        case 'i18n:getCatalog':
          return Promise.resolve({ locale: 'en', messages: {} })
        case 'settings:describe':
          return Promise.resolve(DESCRIPTORS)
        case 'settings:getAll':
          return Promise.resolve({ ...snapshot })
        case 'settings:set': {
          const { key, value } = payload as { key: string; value: unknown }
          snapshot[key] = value
          return Promise.resolve(undefined)
        }
        case 'settings:reset': {
          const { key } = payload as { key: string }
          snapshot[key] = STORED[key]
          return Promise.resolve(undefined)
        }
        case 'extensions:list':
          return Promise.resolve([...extensions])
        case 'extensions:load':
          return Promise.resolve({ error: options.loadError ?? null })
        case 'extensions:remove': {
          const { id } = payload as { id: string }
          extensions = extensions.filter((item) => item.id !== id)
          return Promise.resolve(undefined)
        }
        default:
          return Promise.reject(new Error(`unexpected channel ${channel}`))
      }
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }

  // One cast, at the boundary: `invoke` is generic over a channel union and this stands in for it with
  // a switch. The channel names inside are the ones the surfaces are actually allowed to call.
  return {
    calls,
    channels: () => calls.map((call) => call.channel),
    bridge: bridge as unknown as OwnBrowserBridge & OwnBrowserInternalBridge
  }
}

/** The chrome host, wired exactly as `main.tsx` wires it. */
function renderPanel(node: React.ReactNode): ReturnType<typeof render> {
  return render(<I18nProvider>{node}</I18nProvider>)
}

/**
 * What a rendered settings surface actually offers, reduced to something comparable.
 *
 * Label, control element and rendered value per field — enough that a host which lost a control,
 * rendered the wrong kind of input, or showed a stale value would fail, and not so literal that an
 * attribute React happens to order differently makes the comparison brittle.
 */
function controlsOf(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.field')].map((field) => {
    const label = field.querySelector('.field__label')?.textContent ?? ''
    const control = field.querySelector('.field__control > *')
    const rendered =
      control instanceof HTMLInputElement && control.type === 'checkbox'
        ? String(control.checked)
        : control instanceof HTMLInputElement ||
            control instanceof HTMLSelectElement ||
            control instanceof HTMLTextAreaElement
          ? control.value
          : (control?.textContent ?? '')
    return `${label} | ${control?.tagName ?? 'none'} | ${rendered}`
  })
}

afterEach(() => {
  cleanup()
  define('tessera', undefined)
  define('tesseraInternal', undefined)
})

describe('the settings surface in both entry points', () => {
  it('offers the identical set of controls in the panel and on the page', async () => {
    /*
      The promise, stated as an equality.

      Not "both render something" — both render the *same* thing, from the same descriptors, with the
      same values, through two different bridges. This is the assertion that would fail first if anyone
      answered a future request by adding a second copy of the settings UI.
    */
    const chrome = fakeCore()
    define('tessera', chrome.bridge)
    const panel = renderPanel(<SettingsPanel settings={STORED} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
    const inPanel = controlsOf(panel.container)
    panel.unmount()

    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    const page = render(<SettingsPage />)
    // Waits for the *value*, not just the control: the page fetches its own snapshot, so a premature
    // comparison would be against a surface whose numbers had not arrived.
    await waitFor(() => expect(screen.getByLabelText('Max Tiles')).toHaveProperty('value', '4'))

    expect(controlsOf(page.container), 'the page renders a different settings surface').toEqual(inPanel)
    expect(inPanel).toHaveLength(DESCRIPTORS.length)
  })

  it('writes through the bridge belonging to its own host, and only that one', async () => {
    /*
      The seam itself, and the reason both globals are present.

      With one bridge installed, an adapter reaching for the other throws and reads as a broken test.
      With both, "wrote through mine" and "did not touch yours" are one assertion, which is the only
      form that catches a crossed wire.
    */
    const chrome = fakeCore()
    const internal = fakeCore()
    define('tessera', chrome.bridge)
    define('tesseraInternal', internal.bridge)

    const panel = renderPanel(<SettingsPanel settings={STORED} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Blocker Enabled'))

    await waitFor(() =>
      expect(chrome.calls).toContainEqual({
        channel: 'settings:set',
        payload: { key: 'privacy.blockerEnabled', value: false }
      })
    )
    expect(internal.calls, 'the chrome panel reached the internal bridge').toEqual([])
    panel.unmount()

    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
    const before = chrome.calls.length
    fireEvent.click(screen.getByLabelText('Blocker Enabled'))

    await waitFor(() =>
      expect(internal.calls).toContainEqual({
        channel: 'settings:set',
        payload: { key: 'privacy.blockerEnabled', value: false }
      })
    )
    expect(chrome.calls.length, 'the internal page reached the chrome bridge').toBe(before)
  })

  it('is a dismissible dialogue as a panel and an ordinary document as a page', async () => {
    // The one intended difference between the hosts, and everything that follows from it. A page
    // claiming `aria-modal` tells a screen reader the rest of the browser is unavailable, which is false.
    const chrome = fakeCore()
    define('tessera', chrome.bridge)
    const onClose = vi.fn()
    const panel = renderPanel(<SettingsPanel settings={STORED} onClose={onClose} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByLabelText('Close settings')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    panel.unmount()

    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
    expect(screen.queryByRole('dialog'), 'the settings page announces itself as modal').toBeNull()
    expect(screen.queryByLabelText('Close settings')).toBeNull()
    // Escape belongs to the page and to the browser in a tab — stopping a load, leaving a full-screen
    // video. Nothing to close means nothing to consume the key for.
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy()
  })

  it('reads the snapshot itself only on the page, because only the panel is given one', async () => {
    // A real difference in the adapters rather than in the view: the chrome renderer already holds a
    // live snapshot in `useBrowserState`, so a panel that fetched its own would be a second source of
    // truth for the same values.
    const chrome = fakeCore()
    const internal = fakeCore()
    define('tessera', chrome.bridge)
    define('tesseraInternal', internal.bridge)

    const panel = renderPanel(<SettingsPanel settings={STORED} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
    expect(chrome.channels()).not.toContain('settings:getAll')
    panel.unmount()

    render(<SettingsPage />)
    await waitFor(() => expect(internal.channels()).toContain('settings:getAll'))
  })

  it('re-reads after a write on the page rather than trusting what it sent', async () => {
    // The core may clamp or normalise a value. A page that displayed what it *sent* would disagree with
    // what was stored, and the disagreement would survive until the tab was reloaded.
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Blocker Enabled'))
    await waitFor(() => {
      const after = internal.channels()
      expect(after.indexOf('settings:getAll')).toBeLessThan(after.lastIndexOf('settings:getAll'))
    })
  })

  it('calls nothing the settings page is not granted', async () => {
    /*
      The privilege table, checked against behaviour instead of by reading.

      `INTERNAL_PAGE_INVOKE_CHANNELS.settings` is the list the preload installs and the core enforces.
      Asserting the page's actual traffic is a subset of it is what turns "I checked the lists match"
      into something that stays true — a future control reaching for a channel nobody granted fails here
      rather than in a sandboxed renderer where the only symptom is a rejected promise.
    */
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    // Every control the page drives, so the traffic under test is the whole of it.
    fireEvent.click(screen.getByLabelText('Blocker Enabled'))
    fireEvent.change(screen.getByLabelText('Referrer Policy'), { target: { value: 'origin-only' } })
    fireEvent.change(screen.getByLabelText('Max Tiles'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Blocked Hosts'), { target: { value: 'a.example' } })
    fireEvent.click(screen.getByLabelText('Reset to default: Blocker Enabled'))

    await waitFor(() => expect(internal.channels()).toContain('settings:reset'))
    const granted: readonly string[] = INTERNAL_PAGE_INVOKE_CHANNELS.settings
    expect([...new Set(internal.channels())].filter((channel) => !granted.includes(channel))).toEqual([])
  })
})

describe('the extensions surface in both entry points', () => {
  it('lists the same extensions in the panel and on the page', async () => {
    const chrome = fakeCore()
    define('tessera', chrome.bridge)
    const panel = renderPanel(<ExtensionsPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())
    expect(screen.getByText('1.2.3 · /tmp/unpacked')).toBeTruthy()
    panel.unmount()

    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<ExtensionsPage />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())
    expect(screen.getByText('1.2.3 · /tmp/unpacked')).toBeTruthy()
    // Stated on the surface in both hosts, not discovered by the user: the limitations are severe and
    // structural, and a page that omitted them would be the misleading half of the pair.
    expect(screen.getByText(/detectable/i)).toBeTruthy()
  })

  it('removes through the bridge belonging to its own host, and only that one', async () => {
    const chrome = fakeCore()
    const internal = fakeCore()
    define('tessera', chrome.bridge)
    define('tesseraInternal', internal.bridge)

    const panel = renderPanel(<ExtensionsPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Remove Test extension'))
    await waitFor(() =>
      expect(chrome.calls).toContainEqual({ channel: 'extensions:remove', payload: { id: 'aaaa' } })
    )
    expect(internal.calls, 'the chrome panel reached the internal bridge').toEqual([])
    // Re-read rather than spliced locally, for the same reason the settings page re-reads.
    await waitFor(() => expect(screen.getByText('No extensions loaded.')).toBeTruthy())
    panel.unmount()

    render(<ExtensionsPage />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Remove Test extension'))
    await waitFor(() =>
      expect(internal.calls).toContainEqual({ channel: 'extensions:remove', payload: { id: 'aaaa' } })
    )
  })

  it('is a dismissible dialogue as a panel and an ordinary document as a page', async () => {
    const chrome = fakeCore()
    define('tessera', chrome.bridge)
    const onClose = vi.fn()
    const panel = renderPanel(<ExtensionsPanel onClose={onClose} />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
    panel.unmount()

    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<ExtensionsPage />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())
    expect(screen.queryByRole('dialog'), 'the extensions page announces itself as modal').toBeNull()
    expect(screen.queryByLabelText('Close extensions')).toBeNull()
  })

  it('calls nothing the extensions page is not granted', async () => {
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<ExtensionsPage />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())

    fireEvent.click(screen.getByText('Load unpacked folder…'))
    fireEvent.click(screen.getByLabelText('Remove Test extension'))

    await waitFor(() => expect(internal.channels()).toContain('extensions:remove'))
    const granted: readonly string[] = INTERNAL_PAGE_INVOKE_CHANNELS.extensions
    expect([...new Set(internal.channels())].filter((channel) => !granted.includes(channel))).toEqual([])
  })
})

/**
 * Refusals, in both hosts.
 *
 * Each of these fails against the code as it stood before this feature: writes surfaced a refusal and
 * nothing else did. They are here rather than in `settings-view.test.tsx` because the interesting part
 * is that the rejection travels the whole way — from a bridge that rejects, through the adapter, into a
 * message on screen — and only the real adapters can show that.
 */
describe('a refused call is shown, in whichever host refused it', () => {
  it('shows a refused reset instead of leaving the value silently unchanged', async () => {
    const internal = fakeCore({ refuse: { 'settings:reset': 'unknown setting' } })
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Reset to default: Blocker Enabled'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unknown setting'))
  })

  it('shows a refused reset in the panel too', async () => {
    // Same defect, same fix, other host — the point of one implementation.
    const chrome = fakeCore({ refuse: { 'settings:reset': 'unknown setting' } })
    define('tessera', chrome.bridge)
    renderPanel(<SettingsPanel settings={STORED} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Reset to default: Blocker Enabled'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('unknown setting'))
  })

  it("strips Electron's wrapper so the user reads the reason, not the plumbing", async () => {
    const internal = fakeCore({
      refuse: {
        'settings:set': "Error invoking remote method 'settings:set': value out of range"
      }
    })
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Blocker Enabled'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toBe('value out of range'))
  })

  it('shows a refused removal instead of a list that quietly did not change', async () => {
    const internal = fakeCore({ refuse: { 'extensions:remove': 'extension is still running' } })
    define('tesseraInternal', internal.bridge)
    render(<ExtensionsPage />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Remove Test extension'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('still running'))
    // And the extension is still listed, which is the truth: nothing was removed.
    expect(screen.getByText('Test extension')).toBeTruthy()
  })

  it('says a folder could not be loaded', async () => {
    // The core reports an unreadable folder as data rather than as a rejection, so this is the other
    // half of the same requirement.
    const internal = fakeCore({ loadError: 'no manifest.json' })
    define('tesseraInternal', internal.bridge)

    render(<ExtensionsPage />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())
    fireEvent.click(screen.getByText('Load unpacked folder…'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('no manifest.json'))
  })

  it('says the settings list could not be fetched rather than showing an empty surface', async () => {
    /*
      The worst of the swallowed refusals, because its symptom was reassuring.

      `describe()` was `void host.describe().then(setDescriptors)`, and this surface renders no
      empty-state text when it has no descriptors — so a refused `settings:describe` produced a blank
      panel body, indistinguishable from a browser that had no settings to offer.
    */
    const internal = fakeCore({ refuse: { 'settings:describe': 'core is not ready' } })
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('core is not ready'))
  })

  it('says the extension list could not be fetched rather than claiming there are none', async () => {
    // "No extensions loaded." is a different and more reassuring claim than "the core refused".
    const internal = fakeCore({ refuse: { 'extensions:list': 'core is not ready' } })
    define('tesseraInternal', internal.bridge)
    render(<ExtensionsPage />)

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('core is not ready'))
  })
})

describe('focus, which only a panel manages', () => {
  it('keeps Tab inside the extensions panel, which claims to be modal', async () => {
    /*
      A regression test for a defect found while lifting these panels.

      `ExtensionsView` set `role="dialog" aria-modal` and kept a `panelRef` that nothing read — the
      residue of a focus trap that had been dropped. So the panel told assistive technology the rest of
      the window was unavailable and then let Tab walk out of it into content the same announcement had
      just declared unreachable.
    */
    const chrome = fakeCore()
    define('tessera', chrome.bridge)
    renderPanel(<ExtensionsPanel onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())

    const close = screen.getByLabelText('Close extensions')
    const last = screen.getByText('Load unpacked folder…')
    last.focus()
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(window, { key: 'Tab' })
    expect(document.activeElement, 'Tab left a panel that claims aria-modal').toBe(close)

    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('lets Tab leave the extensions page, where trapping it would steal the key from the browser', async () => {
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<ExtensionsPage />)
    await waitFor(() => expect(screen.getByText('Test extension')).toBeTruthy())

    const last = screen.getByText('Load unpacked folder…')
    last.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    // Unmoved: no handler was installed, so the key belongs to the document and to the chrome around it.
    expect(document.activeElement).toBe(last)
  })
})
