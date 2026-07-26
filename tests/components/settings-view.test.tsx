import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsView, type SettingsHost } from '@renderer-shared/SettingsView.js'
import type { SettingDescriptor } from '@shared/settings/control.js'
import type { MessageKey } from '@shared/i18n/catalog.js'

/**
 * The settings surface, in both of its hosts.
 *
 * This file exists to hold a specific promise. The user asked to keep the in-window panel *and* have a
 * real `tessera://settings` tab, and the answer was "both entry points, one implementation" — so the
 * claim that needs testing is not that settings work, but that the *same component* behaves correctly
 * whether it is a modal panel or a page.
 *
 * The difference between the two hosts is exactly one prop, `onClose`, and everything that follows from
 * it: a panel is modal, dismissible, traps focus and claims `role="dialog"`; a page is none of those.
 * Getting that wrong is not cosmetic — a page announcing itself as a modal dialogue tells a screen
 * reader the rest of the browser is unavailable, and a page trapping Tab takes the key away from the
 * browser's own chrome.
 */

/** Keys through unchanged, so an assertion reads as the key rather than as English prose. */
const t = (key: MessageKey, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${Object.values(params).join(',')}`

function descriptor(overrides: Partial<SettingDescriptor> = {}): SettingDescriptor {
  // Annotated rather than asserted: an assertion would have hidden that `applies` was `'immediately'`, a
  // value the type does not have — which is exactly what it did until the compiler was allowed to look.
  const base: SettingDescriptor = {
    key: 'privacy.blockerEnabled',
    kind: 'toggle',
    section: 'privacy',
    applies: 'live'
  }
  return { ...base, ...overrides }
}

interface Recorded {
  set: Array<{ key: string; value: unknown }>
  reset: string[]
}

function hostWith(options: {
  descriptors?: SettingDescriptor[]
  refuse?: string
}): { host: SettingsHost; calls: Recorded } {
  const calls: Recorded = { set: [], reset: [] }
  return {
    calls,
    host: {
      describe: () => Promise.resolve(options.descriptors ?? [descriptor()]),
      set: (key, value) => {
        calls.set.push({ key, value })
        return options.refuse === undefined
          ? Promise.resolve()
          : Promise.reject(new Error(options.refuse))
      },
      reset: (key) => {
        calls.reset.push(key)
        return Promise.resolve()
      },
      t
    }
  }
}

afterEach(cleanup)

describe('the same component in both hosts', () => {
  it('renders its controls either way', async () => {
    // The claim itself: nothing about *what* settings are depends on which host is rendering them.
    const { host } = hostWith({})
    const { unmount } = render(<SettingsView host={host} settings={{}} onClose={vi.fn()} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
    unmount()

    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())
  })

  it('writes through whichever host it was given', async () => {
    /*
      The seam. The panel's host binds to the chrome bridge, the page's to the narrow internal one which
      carries exactly the seven settings channels — and the component cannot tell them apart, which is
      what makes one implementation safe.
    */
    const { host, calls } = hostWith({})
    render(<SettingsView host={host} settings={{ 'privacy.blockerEnabled': false }} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Blocker Enabled'))
    await waitFor(() => expect(calls.set).toEqual([{ key: 'privacy.blockerEnabled', value: true }]))
  })

  it('shows a refusal rather than a control that flipped and did nothing', async () => {
    // Spec 5's rule made visible. A rejected write must surface: a toggle that moved while the value did
    // not is how a user learns the settings screen cannot be trusted.
    const { host } = hostWith({ refuse: 'value out of range' })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Blocker Enabled'))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('out of range'))
  })
})

describe('what differs between the two hosts', () => {
  it('is a dialogue only in the panel', () => {
    // A page claiming `aria-modal` tells a screen reader the rest of the browser is unavailable, which
    // is false and makes the page harder to leave than any other tab.
    const { host } = hostWith({})
    const { unmount } = render(<SettingsView host={host} settings={{}} onClose={vi.fn()} />)
    expect(screen.getByRole('dialog')).toBeTruthy()
    unmount()

    render(<SettingsView host={host} settings={{}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers a close button only where closing means something', () => {
    const { host } = hostWith({})
    const { unmount } = render(<SettingsView host={host} settings={{}} onClose={vi.fn()} />)
    expect(screen.getByLabelText('settings.close')).toBeTruthy()
    unmount()

    render(<SettingsView host={host} settings={{}} />)
    expect(screen.queryByLabelText('settings.close')).toBeNull()
  })

  it('closes on Escape in the panel', () => {
    const onClose = vi.fn()
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('ignores Escape as a page, where it would swallow the key from the browser', () => {
    /*
      Not an omission. Escape in a tab belongs to the page and to the browser — stopping a load, leaving
      a full-screen video. A settings *tab* that consumed it would take that away and give nothing back,
      because there is nothing to close.
    */
    const { host } = hostWith({})
    const { container } = render(<SettingsView host={host} settings={{}} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    // Still rendered, and nothing threw: the handler was never installed.
    expect(container.querySelector('.panel')).not.toBeNull()
  })

  it('has no backdrop as a page', () => {
    // The backdrop is what a click-outside dismisses. On a page it would be an invisible layer over the
    // whole tab that swallowed clicks and dismissed nothing.
    const { host } = hostWith({})
    const { container, unmount } = render(<SettingsView host={host} settings={{}} onClose={vi.fn()} />)
    expect(container.querySelector('.overlay')).not.toBeNull()
    unmount()

    const page = render(<SettingsView host={host} settings={{}} />)
    expect(page.container.querySelector('.overlay')).toBeNull()
  })
})

describe('the controls the descriptors produce', () => {
  it('renders a choice as a select with the offered values', async () => {
    const { host } = hostWith({
      descriptors: [
        descriptor({
          key: 'privacy.referrerPolicy',
          kind: 'choice',
          choices: ['origin-only', 'strict', 'default']
        })
      ]
    })
    render(<SettingsView host={host} settings={{ 'privacy.referrerPolicy': 'strict' }} />)
    await waitFor(() => expect(screen.getByLabelText('Referrer Policy')).toBeTruthy())
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('shows a setting it cannot edit rather than hiding it', async () => {
    /*
      A shape the UI has no control for — a map, say — is still something the user should be able to
      see. Omitting it would make the settings screen quietly incomplete, and there would be no way to
      tell that from a setting that does not exist.
    */
    const { host } = hostWith({
      descriptors: [descriptor({ key: 'advanced.customShortcuts', kind: 'map' })]
    })
    render(<SettingsView host={host} settings={{ 'advanced.customShortcuts': { a: 'b' } }} />)
    await waitFor(() => expect(screen.getByText('settings.readOnly')).toBeTruthy())
    expect(screen.getByText(/"a":\s*"b"/)).toBeTruthy()
  })

  it('says when a setting needs a restart', async () => {
    // Otherwise the user changes it, sees nothing happen, and changes it back.
    const { host } = hostWith({
      descriptors: [descriptor({ key: 'privacy.partitionStatePerSite', applies: 'restart' })]
    })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByText('settings.needsRestart')).toBeTruthy())
  })

  it('resets one setting without touching the others', async () => {
    const { host, calls } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('settings.reset: Blocker Enabled'))
    expect(calls.reset).toEqual(['privacy.blockerEnabled'])
    expect(calls.set).toEqual([])
  })
})

describe('searching the settings', () => {
  it('filters by key and by the readable name', async () => {
    const { host } = hostWith({
      descriptors: [
        descriptor({ key: 'privacy.blockerEnabled' }),
        descriptor({ key: 'appearance.theme', kind: 'choice', section: 'appearance', choices: ['dark'] })
      ]
    })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Theme')).toBeTruthy())

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'blocker' } })
    expect(screen.queryByLabelText('Theme')).toBeNull()
    expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy()
  })

  it('says nothing matched rather than showing an empty screen', async () => {
    // An empty settings screen and a settings screen that failed to load look identical.
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Blocker Enabled')).toBeTruthy())

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } })
    expect(screen.getByText(/settings\.noMatches/)).toBeTruthy()
  })
})
