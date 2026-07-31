import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExtensionsPanel } from '@renderer/components/ExtensionsPanel.js'
import { I18nProvider } from '@renderer/i18n.js'
import { SettingsPage } from '@renderer-internal/SettingsPage.js'
import { ExtensionsPage } from '@renderer-internal/ExtensionsPage.js'
import {
  INTERNAL_PAGE_EVENT_CHANNELS,
  INTERNAL_PAGE_INVOKE_CHANNELS
} from '@shared/ipc/channels.js'
import type { SettingDescriptor } from '@shared/settings/control.js'
import type { ExtensionInfo } from '@shared/extensions/model.js'
import type { OwnBrowserBridge } from '../../src/preload/api.js'
import type { OwnBrowserInternalBridge } from '../../src/preload/internal-api.js'

/**
 * The settings and extensions surfaces, through the real bridges they will run on.
 *
 * ## The claim this file exists to hold
 *
 * `settings-view.test.tsx` drives the shared view against a hand-written host, which proves the view
 * is host-agnostic; it cannot prove the *adapter* is wired to the bridge it claims. A settings page
 * whose adapter silently called the chrome bridge would pass every test in that file and fail the
 * moment it ran in a sandboxed renderer, where `window.tessera` does not exist. So these tests go in
 * through the real components and the real globals.
 *
 * ## What changed when settings stopped having two entry points
 *
 * Six of these tests rendered `SettingsPanel`, and the block they sat in was called `the settings
 * surface in both entry points`. The panel is gone: the user asked for settings to be a real page
 * rather than something drawn over the window, and chose to remove the panel rather than keep both.
 *
 * The valuable assertions in that block were never about the panel. They were about the *bridge*
 * — that the page reaches `window.tesseraInternal` and nothing else, that it re-reads rather than
 * trusting what it sent, and that its traffic stays inside the privilege table — and about refusals
 * travelling the whole way from a rejecting bridge to a message on screen. All of those are kept, and
 * kept against the page. What was dropped is the half that compared two hosts, because there is one:
 * every `expect(inPanel).toEqual(onPage)` had become a comparison of a thing with itself.
 *
 * Two assertions are *stronger* than what they replaced. "The page did not reach the chrome bridge"
 * used to be the second half of a symmetric pair; it is now checked with both globals installed and
 * the chrome one required to stay untouched from first render to last, which is the form that catches
 * a crossed wire. And the privilege check now covers the page's event subscription as well as its
 * calls, which nothing checked before, because the page did not have one.
 *
 * ExtensionsPanel is untouched: extensions still has a panel and a tab, so the two-host claim is
 * still true there and is still tested here.
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
 * The descriptors the page is given.
 *
 * Four kinds rather than one, so a page that lost a control or rendered the wrong kind of input for
 * it fails here rather than looking plausible.
 *
 * The labels are German and the keys are English, which is deliberate. Descriptors carry their own
 * text now — the core resolves it per request — and a surface that fell back to deriving a name from
 * the key would render `Blocker Enabled` and fail every selector below. That is the regression this
 * fixture is shaped to catch, because it is the state the surface was actually in.
 */
const DESCRIPTORS: SettingDescriptor[] = [
  {
    key: 'privacy.blockerEnabled',
    kind: 'toggle',
    section: 'privacy',
    applies: 'live',
    label: 'Werbung und Tracker blockieren'
  },
  {
    key: 'privacy.referrerPolicy',
    kind: 'choice',
    section: 'privacy',
    applies: 'new-tab',
    label: 'Referrer',
    choices: ['origin-only', 'strict'],
    choiceLabels: { 'origin-only': 'Nur die Website', strict: 'Gar nichts' }
  },
  {
    key: 'splitView.maxTiles',
    kind: 'number',
    section: 'splitView',
    applies: 'restart',
    label: 'Kacheln höchstens',
    min: 1,
    max: 4,
    integer: true
  },
  {
    key: 'network.blockedHosts',
    kind: 'text-list',
    section: 'network',
    applies: 'live',
    label: 'Gesperrte Hosts',
    description: 'Eine Adresse je Zeile.'
  }
]

/** Named once, because every selector in the settings tests reaches for the same row. */
const BLOCKER = 'Werbung und Tracker blockieren'

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
  /** Event channels something actually subscribed to, for the same reason. */
  listening: () => string[]
  /** Pushes an event the way the core does, to whatever subscribed to it. */
  emit: (channel: string, payload: unknown) => void
  bridge: OwnBrowserBridge & OwnBrowserInternalBridge
}

/**
 * One fake core, installable on either global.
 *
 * Deliberately a single implementation for both bridges: the two differ in *which* channels they carry,
 * and that difference is enforced by the preload and by `sender-policy.ts` in the core, not by the shape
 * of the object. Writing two stubs here would invent a difference the running system does not have, and
 * would hide the one it does — which is checked directly against `INTERNAL_PAGE_INVOKE_CHANNELS` below.
 *
 * `channels` is filled from the real privilege tables rather than left empty, and that is load-bearing
 * now: `internal/bridge.ts` reads `channels.event` to decide whether this page may subscribe at all, so
 * an empty list would silently turn every subscription in the code under test into a no-op and the tests
 * would pass without exercising any of it.
 */
function fakeCore(
  options: {
    refuse?: Record<string, string>
    /** A folder the core could not read, which it reports as data rather than as a rejection. */
    loadError?: string
    /** Whose privilege row this bridge carries. The settings page is the one that has an event. */
    page?: 'settings' | 'extensions'
  } = {}
): FakeCore {
  const calls: Call[] = []
  const listeners = new Map<string, Array<(payload: unknown) => void>>()
  const page = options.page ?? 'settings'
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
        /*
          The rule editor's own channels.

          Answered here rather than left to fall through to the `default` rejection, because the settings page
          renders the editor unconditionally: an unhandled channel becomes a visible error on the surface and
          every assertion in this file about "no alert is shown" would fail for a reason that has nothing to
          do with what it is testing.

          One rule in the list rather than none, so the privilege sweep below sees the row's controls exist —
          an empty editor calls `list` and nothing else, which would let a missing grant pass unnoticed.
        */
        case 'userrules:list':
          return Promise.resolve({
            rules: [
              {
                id: 'u1',
                text: 'example.com##.ad',
                enabled: true,
                createdAt: 1,
                origin: 'manual',
                kind: 'declarative'
              }
            ],
            text: { heading: 'My filter rules', add: 'Add rule', remove: 'Delete this rule', toggle: 'Apply this rule' }
          })
        case 'userrules:add':
          return Promise.resolve({ outcome: 'added' })
        case 'userrules:setEnabled':
        case 'userrules:remove':
          return Promise.resolve(undefined)
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
        /*
          Answers `{ ok: true }` and nothing else, which is the contract.

          The real core resolves this when the check has finished and reports what it found in a
          native dialog — there is no payload to stand in for here, and a fake that invented one
          would let a page be written against data it will never receive.
        */
        case 'updates:checkNow':
          return Promise.resolve({ ok: true })
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
    on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
      const existing = listeners.get(channel) ?? []
      listeners.set(channel, [...existing, listener])
      return () => {
        listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== listener))
      }
    },
    channels: {
      invoke: INTERNAL_PAGE_INVOKE_CHANNELS[page],
      event: INTERNAL_PAGE_EVENT_CHANNELS[page]
    }
  }

  // One cast, at the boundary: `invoke` is generic over a channel union and this stands in for it with
  // a switch. The channel names inside are the ones the surfaces are actually allowed to call.
  return {
    calls,
    channels: () => calls.map((call) => call.channel),
    listening: () => [...listeners.keys()].filter((channel) => (listeners.get(channel)?.length ?? 0) > 0),
    emit: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload)
    },
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

describe('the settings surface, which is now only a page', () => {
  it('renders a control for every descriptor, with the stored value in it', async () => {
    /*
      What the two-host equality test became.

      It used to render the panel and the page and compare the two reductions. With one host that is a
      comparison of a thing with itself, so the surviving claim is the half that was doing the work: a
      control of the right kind for every descriptor, carrying the value the core actually stored — not
      the one the page sent, and not a default.
    */
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    const page = render(<SettingsPage />)
    // Waits for the *value*, not just the control: the page fetches its own snapshot, so a premature
    // read would be of a surface whose numbers had not arrived.
    await waitFor(() => expect(screen.getByLabelText('Kacheln höchstens')).toHaveProperty('value', '4'))

    // Section order, not descriptor order: the surface groups by section and renders the sections in
    // the order `SETTINGS_SECTIONS` declares, so split view comes before privacy whatever the core
    // sent. Asserted as a list rather than a set because that ordering is part of what the user sees.
    expect(controlsOf(page.container)).toEqual([
      'Kacheln höchstens | INPUT | 4',
      `${BLOCKER} | INPUT | true`,
      'Referrer | SELECT | strict',
      'Gesperrte Hosts | TEXTAREA | ads.example\ntrackers.example'
    ])
  })

  it('writes through the internal bridge, and never touches the chrome one', async () => {
    /*
      The seam, and the reason both globals are installed for a surface that only uses one.

      With only the internal bridge present, an adapter reaching for `window.tessera` throws and reads
      as a broken test rather than as a crossed wire. With both present and the chrome one required to
      stay at zero calls from first render to last, reaching for the wrong one is a failure that names
      itself. This is stricter than the symmetric version it replaces, which only compared a count
      before and after a single click.
    */
    const chrome = fakeCore()
    const internal = fakeCore()
    define('tessera', chrome.bridge)
    define('tesseraInternal', internal.bridge)

    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())
    fireEvent.click(screen.getByLabelText(BLOCKER))

    await waitFor(() =>
      expect(internal.calls).toContainEqual({
        channel: 'settings:set',
        payload: { key: 'privacy.blockerEnabled', value: false }
      })
    )
    expect(chrome.calls, 'the settings page reached the chrome bridge').toEqual([])
  })

  it('is an ordinary document, not a dialogue drawn over the window', async () => {
    /*
      What is left of the panel-versus-page comparison, and the half that was always the requirement.

      A page claiming `aria-modal` tells a screen reader the rest of the browser is unavailable, which
      is false. A close button on a tab closes nothing. Escape in a tab belongs to the page and to the
      browser — stopping a load, leaving a full-screen video. All three were one prop away while this
      component served a panel too; the prop is gone, and so is the arm that used them.
    */
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    expect(screen.queryByRole('dialog'), 'the settings page announces itself as modal').toBeNull()
    expect(screen.queryByLabelText('Close settings')).toBeNull()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.getByLabelText(BLOCKER)).toBeTruthy()
  })

  it('reads its own snapshot, because nothing hands it one', async () => {
    // The page is content in a sandboxed renderer: there is no `useBrowserState` above it holding a
    // live snapshot, so fetching one is not duplication here — it is the only source it has.
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(internal.channels()).toContain('settings:getAll'))
  })

  it('re-reads after a write rather than trusting what it sent', async () => {
    // The core may clamp or normalise a value. A page that displayed what it *sent* would disagree with
    // what was stored, and the disagreement would survive until the tab was reloaded.
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    fireEvent.click(screen.getByLabelText(BLOCKER))
    await waitFor(() => {
      const after = internal.channels()
      expect(after.indexOf('settings:getAll')).toBeLessThan(after.lastIndexOf('settings:getAll'))
    })
  })

  it('shows a change somebody else made, without being asked', async () => {
    /*
      New, and it is what the page gained by being the only entry point.

      A setting can move without this tab touching it — a menu in another window, a second settings tab
      — and an open settings screen showing values that were true when it loaded is the one thing a
      settings screen must never do. The panel never needed this because the chrome renderer's
      `useBrowserState` already pushed it a fresh snapshot; the page has to subscribe for itself.

      The event carries the whole snapshot, so this asserts the value changes with no further call.
    */
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toHaveProperty('checked', true))
    const before = internal.channels().length

    internal.emit('settings:changed', {
      changed: { 'privacy.blockerEnabled': false },
      snapshot: { ...STORED, 'privacy.blockerEnabled': false }
    })

    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toHaveProperty('checked', false))
    expect(internal.channels().length, 'the page re-fetched what the event already carried').toBe(before)
  })

  it('re-describes when the language changes, because the labels come from the core', async () => {
    /*
      The consequence of moving the text into the core, asserted end to end.

      `settings:describe` is locale-dependent now: the core resolves the label, the description and the
      option names for the language the profile is set to. So a language change that did not re-describe
      would leave a page whose headings switched and whose seventy-six settings did not — the one place
      the old English labels would still be showing.

      The chain under test is the real one. `useInternalI18n` hears the change and re-reads the
      catalogue, `t` gets a new identity, the memoised host does too, and the view's describe effect —
      keyed on the host — runs again. Nothing here reaches past the seam to force it.

      The event is `locale:changed` rather than `settings:changed`, and that is the point of it: the
      core resolves `'system'` against the operating system and sends the language it landed on, so a
      page never has to hold the whole settings snapshot to notice one. Every internal page is granted
      this channel; `settings:changed` stays with this page alone, for the values it displays.
    */
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())
    const before = internal.channels().filter((channel) => channel === 'settings:describe').length

    internal.emit('locale:changed', { locale: 'de' })

    await waitFor(() => {
      const after = internal.channels().filter((channel) => channel === 'settings:describe').length
      expect(after, 'the page kept the descriptors it fetched in the old language').toBeGreaterThan(
        before
      )
    })
    // And the catalogue with it, or the chrome around the settings would stay in the old language while
    // the settings themselves changed.
    expect(internal.channels().filter((channel) => channel === 'i18n:getCatalog').length).toBeGreaterThan(1)
  })

  it('asks the core for an update check through the bridge it is granted', async () => {
    /*
      The one call this page makes that leaves the machine, end to end through the real adapter.

      Worth its own test rather than being folded into the privilege sweep below, because the sweep
      would still pass if the button called nothing at all. What is asserted here is that the press
      reaches `updates:checkNow` on the *internal* bridge — the chrome bridge is installed and
      required to stay untouched, exactly as it is for a settings write — and that the page adds no
      report of its own afterwards, because the core answers in a native dialog.
    */
    const chrome = fakeCore()
    const internal = fakeCore()
    define('tessera', chrome.bridge)
    define('tesseraInternal', internal.bridge)

    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates…' }))

    await waitFor(() =>
      expect(internal.calls).toContainEqual({ channel: 'updates:checkNow', payload: undefined })
    )
    expect(chrome.calls, 'the settings page reached the chrome bridge').toEqual([])
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('reaches nothing the settings page is not granted, calls or events', async () => {
    /*
      The privilege table, checked against behaviour instead of by reading.

      `INTERNAL_PAGE_INVOKE_CHANNELS.settings` is the list the preload installs and the core enforces.
      Asserting the page's actual traffic is a subset of it is what turns "I checked the lists match"
      into something that stays true — a future control reaching for a channel nobody granted fails here
      rather than in a sandboxed renderer where the only symptom is a rejected promise.

      The subscription is checked too, which is new: the page did not have one before, and an event is
      the same kind of grant as a call. `INTERNAL_PAGE_EVENT_CHANNELS.settings` names exactly one.
    */
    const internal = fakeCore()
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    // Every control the page drives, so the traffic under test is the whole of it.
    fireEvent.click(screen.getByLabelText(BLOCKER))
    fireEvent.change(screen.getByLabelText('Referrer'), { target: { value: 'origin-only' } })
    fireEvent.change(screen.getByLabelText('Kacheln höchstens'), { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Gesperrte Hosts'), { target: { value: 'a.example' } })
    fireEvent.click(screen.getByRole('button', { name: 'Check for Updates…' }))
    fireEvent.click(screen.getByLabelText(`Reset to default: ${BLOCKER}`))

    await waitFor(() => expect(internal.channels()).toContain('settings:reset'))
    const granted: readonly string[] = INTERNAL_PAGE_INVOKE_CHANNELS.settings
    expect([...new Set(internal.channels())].filter((channel) => !granted.includes(channel))).toEqual([])

    const heard: readonly string[] = INTERNAL_PAGE_EVENT_CHANNELS.settings
    expect(internal.listening().filter((channel) => !heard.includes(channel))).toEqual([])
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
 * Refusals, travelling the whole way.
 *
 * Each of these fails against the code as it stood before the surfaces were lifted: writes surfaced a
 * refusal and nothing else did. They are here rather than in `settings-view.test.tsx` because the
 * interesting part is that the rejection travels from a bridge that rejects, through the adapter, into
 * a message on screen — and only the real adapters can show that.
 *
 * There used to be a pair for the settings reset, one against each host, with the second annotated
 * "same defect, same fix, other host". The panel is gone, so the pair is a single test. That is not a
 * gap: the assertion was always about `useCoreCall` catching a rejection the adapter passed up, and
 * that is the same code either way — the second copy only ever proved the panel used it too.
 */
describe('a refused call is shown rather than swallowed', () => {
  it('shows a refused reset instead of leaving the value silently unchanged', async () => {
    const internal = fakeCore({ refuse: { 'settings:reset': 'unknown setting' } })
    define('tesseraInternal', internal.bridge)
    render(<SettingsPage />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    fireEvent.click(screen.getByLabelText(`Reset to default: ${BLOCKER}`))
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
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    fireEvent.click(screen.getByLabelText(BLOCKER))
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
