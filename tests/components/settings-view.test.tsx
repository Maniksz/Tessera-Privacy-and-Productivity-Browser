import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingsView, type SettingsHost } from '@renderer-shared/SettingsView.js'
import type { SettingDescriptor } from '@shared/settings/control.js'
import type { MessageKey } from '@shared/i18n/catalog.js'

/**
 * The settings surface, which has one host.
 *
 * ## What this file used to hold, and why half of it went
 *
 * It was written when settings had two entry points — an in-window panel and the
 * `tessera://settings` tab — and its central claim was that the *same component* behaved
 * correctly as both. A whole block, `what differs between the two hosts`, pinned the panel half:
 * `role="dialog"`, a close button, Escape calling `onClose`, and a `.overlay` backdrop.
 *
 * The user asked for settings to be a real page rather than something drawn over the window, and
 * chose to remove the panel outright. Those four assertions therefore described nothing, so the
 * block was rewritten rather than deleted: each one has a surviving half, and the surviving half is
 * the one that was always the point. A page **must not** claim to be a modal dialogue, **must not**
 * offer a close button that closes nothing, **must not** eat Escape, and **must not** lay an
 * invisible backdrop over the tab. Those were asserted before as the negative arm of a comparison;
 * they are asserted now on their own, which is if anything harder to make pass by accident — the
 * old version could have been satisfied by a component that did nothing at all when handed no
 * `onClose`, and this one cannot, because the same tests render a working surface.
 *
 * What is *not* here is any coverage that was lost. The panel's own behaviour is not tested
 * anywhere any more because the panel does not exist anywhere any more.
 *
 * ## The other half of this file is new
 *
 * Labels, descriptions and readable option names arrive on the descriptor from the core. That is
 * the change that makes this surface translatable at all — it used to build every label out of the
 * key with a `humanise()` helper, so a German user read `Block third party cookies`. Every
 * assertion below that names a label names one the *test* supplied, which is the point: this
 * component must render what the core sent and invent nothing.
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
    applies: 'live',
    // Supplied, never derived. A fixture that left this out would not compile, which is the whole
    // reason `label` is required on the descriptor rather than optional.
    label: 'Werbung und Tracker blockieren'
  }
  return { ...base, ...overrides }
}

interface Recorded {
  set: Array<{ key: string; value: unknown }>
  reset: string[]
  checks: number
}

function hostWith(options: {
  descriptors?: SettingDescriptor[]
  refuse?: string
  /** Refuses the update check specifically, which is a different path from a refused write. */
  refuseCheck?: string
  /** Held open so a test can look at the surface *while* a check is running. */
  checkRunsUntil?: Promise<void>
}): { host: SettingsHost; calls: Recorded } {
  const calls: Recorded = { set: [], reset: [], checks: 0 }
  return {
    calls,
    host: {
      describe: () => Promise.resolve(options.descriptors ?? [descriptor()]),
      /*
        The rule editor, stubbed to an empty list.

        This file is about the settings *table* — descriptors in, controls out — and the editor is a block
        beside it with its own host and its own tests. An empty list is what keeps it from rendering anything
        these assertions could trip over, while still exercising the wiring: a required member means the
        compiler asks whoever adds a host to answer for it, which is the same reason `checkForUpdates` is
        required rather than optional.
      */
      userRules: {
        list: () => Promise.resolve({ rules: [], text: {} }),
        add: () => Promise.resolve('added' as const),
        setEnabled: () => Promise.resolve(),
        remove: () => Promise.resolve()
      },
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
      checkForUpdates: async () => {
        calls.checks += 1
        if (options.refuseCheck !== undefined) throw new Error(options.refuseCheck)
        await options.checkRunsUntil
      },
      t
    }
  }
}

const BLOCKER = 'Werbung und Tracker blockieren'

afterEach(cleanup)

describe('the surface and the host it is given', () => {
  it('renders its controls from whatever the host describes', async () => {
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())
  })

  it('writes through the host rather than reaching for a bridge', async () => {
    /*
      The seam. The page's adapter binds these three operations to the narrow internal bridge, which
      carries exactly the five settings channels — and the component cannot tell that from any other
      implementation, which is what lets it be tested without a bridge at all.
    */
    const { host, calls } = hostWith({})
    render(<SettingsView host={host} settings={{ 'privacy.blockerEnabled': false }} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    fireEvent.click(screen.getByLabelText(BLOCKER))
    await waitFor(() => expect(calls.set).toEqual([{ key: 'privacy.blockerEnabled', value: true }]))
  })

  it('shows a refusal rather than a control that flipped and did nothing', async () => {
    // Spec 5's rule made visible. A rejected write must surface: a toggle that moved while the value did
    // not is how a user learns the settings screen cannot be trusted.
    const { host } = hostWith({ refuse: 'value out of range' })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    fireEvent.click(screen.getByLabelText(BLOCKER))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('out of range'))
  })
})

/**
 * The one control here that is not a setting.
 *
 * Everything else on this surface is generated from a descriptor: a stored value, a control, a reset.
 * "Check for updates now" has no value and no default, and the reason it is worth its own block of
 * tests is that it is the first thing in this component that had to be written by hand — so it is the
 * first thing that can drift from the pattern without anything noticing.
 */
describe('checking for updates', () => {
  const CHECK = 'updates.checkNow'

  it('offers the check above the settings rather than at the bottom of the last section', async () => {
    /*
      Position asserted, not just presence, because position is the requirement. The two update
      settings live in `advanced`, which is the last of ten sections, so a control placed "with the
      other update things" would be the very last thing on the page. The user asked for it near the
      top.
    */
    const { host } = hostWith({})
    const { container } = render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    // `querySelectorAll` answers in document order, so the first of the two kinds of block is the
    // one the user meets first. Both must be present, or this would pass on a page with no sections.
    const blocks = [...container.querySelectorAll('.panel__lead, .panel__section')]
    expect(blocks.length, 'the page rendered no sections to be above').toBeGreaterThan(1)
    expect(blocks[0]?.className).toBe('panel__lead')
  })

  it('is an action and not a row, so nothing offers to reset it', async () => {
    // The rejected design: a descriptor with a control that ignores its value. It would have brought a
    // reset button that resets nothing and a key naming no setting.
    const { host } = hostWith({})
    const { container } = render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    expect(container.querySelectorAll('.field')).toHaveLength(1)
    expect(screen.queryByLabelText(`settings.reset: ${CHECK}`)).toBeNull()
  })

  it('stays disabled until the check is over, so leaning on it cannot fan out requests', async () => {
    /*
      The only progress this control reports. There is no "checking…" in the catalogue and none may be
      added — the chunk is inside a couple of hundred bytes of an enforced budget — so the disabled
      state is the whole of the feedback, and it has to last exactly as long as the check does.

      The core is not defenceless if this slips: `UpdateService` answers a second request from the one
      in flight. But that is a backstop, and a button that looks pressable while it is working invites
      the press.
    */
    let finish = (): void => {}
    const running = new Promise<void>((resolve) => {
      finish = resolve
    })
    const { host, calls } = hostWith({ checkRunsUntil: running })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    const button = screen.getByRole('button', { name: CHECK })
    fireEvent.click(button)
    await waitFor(() => expect(button).toHaveProperty('disabled', true))
    expect(calls.checks).toBe(1)

    // A second press while it is out: nothing reaches the host, because the control is not pressable.
    fireEvent.click(button)
    expect(calls.checks).toBe(1)

    finish()
    await waitFor(() => expect(button).toHaveProperty('disabled', false))
  })

  it('adds no report of its own, because the core already answered in a dialog', async () => {
    // A second textual answer here would say the same thing in different words — and in words this
    // surface has no catalogue entry for.
    const { host } = hostWith({})
    const { container } = render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())
    const before = container.textContent

    fireEvent.click(screen.getByRole('button', { name: CHECK }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: CHECK })).toHaveProperty('disabled', false)
    )
    expect(container.textContent).toBe(before)
  })

  it('shows a refused check and gives the button back', async () => {
    // Spec 5 again: a control that appears to act and does not is the defect. And a button left
    // disabled by a failure is one the user cannot retry with.
    const { host } = hostWith({ refuseCheck: 'the update checker has not started yet' })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: CHECK }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('has not started'))
    expect(screen.getByRole('button', { name: CHECK })).toHaveProperty('disabled', false)
  })
})

/**
 * The answer this button would otherwise give a `stable` user, and the caveat beside it.
 *
 * Every version published so far is a prerelease and GitHub's "latest release" excludes those, so a
 * check on the `stable` channel finds nothing and reports "No new version" — a wrong answer that
 * looks like a right one. A prominent button makes it far more reachable than the Help-menu item was.
 */
describe('the channel this check cannot see past', () => {
  const CHANNEL_LABEL = 'Über welche Veröffentlichungen du erfährst'

  const channelDescriptor = (): SettingDescriptor =>
    descriptor({
      key: 'updates.channel',
      section: 'advanced',
      kind: 'choice',
      label: CHANNEL_LABEL,
      description: 'Jede bisher veröffentlichte Version ist eine Vorabversion …',
      choices: ['stable', 'alpha']
    })

  it('says why nothing will ever be found, in the words the core already sent', async () => {
    /*
      The descriptor's own sentence, not a second one written here. A bespoke string would need a
      catalogue key in two locales — which the budget has no room for — and would be a second place to
      correct on the day the first non-prerelease is published.
    */
    const { host } = hostWith({ descriptors: [channelDescriptor()] })
    render(<SettingsView host={host} settings={{ 'updates.channel': 'stable' }} />)
    await waitFor(() => expect(screen.getAllByText(/Vorabversion/).length).toBeGreaterThan(1))
  })

  it('says nothing extra to somebody on the channel that works', async () => {
    // On `alpha` the check answers correctly, and a warning nobody needs is a warning everybody
    // learns to skip.
    const { host } = hostWith({ descriptors: [channelDescriptor()] })
    const { container } = render(<SettingsView host={host} settings={{ 'updates.channel': 'alpha' }} />)
    // The exact label, not a fragment of it: the row's reset button carries the same words in its
    // `aria-label`, so a loose match finds two elements and the query throws.
    await waitFor(() => expect(screen.getByLabelText(CHANNEL_LABEL)).toBeTruthy())
    expect(container.querySelector('.panel__lead .panel__notice')).toBeNull()
  })
})

/**
 * A page is a page.
 *
 * The four assertions that used to be the negative arm of a panel-versus-page comparison. Each one
 * names a thing a settings *tab* must not do, and each was a live defect risk while one component
 * served both hosts — the panel needed all four, so all four were one prop away from appearing here.
 */
describe('what a settings tab must not do', () => {
  it('never announces itself as a modal dialogue', () => {
    // Claiming `aria-modal` on a whole page tells a screen reader the rest of the browser is
    // unavailable, which is false, and makes the tab harder to leave than any other.
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('offers no close button, because there is nothing to close', () => {
    // A button that appears to dismiss the surface and does not is the failure spec 5 is written
    // against, in its most literal form.
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    expect(screen.queryByLabelText('settings.close')).toBeNull()
  })

  it('leaves Escape to the page and to the browser', () => {
    /*
      Not an omission. Escape in a tab belongs to the page and to the browser — stopping a load,
      leaving a full-screen video, walking back down the split-view escalation ladder. A settings tab
      that consumed it would take that away and give nothing back.
    */
    const { host } = hostWith({})
    const { container } = render(<SettingsView host={host} settings={{}} />)
    fireEvent.keyDown(window, { key: 'Escape' })
    // Still rendered, and nothing threw: no handler was ever installed.
    expect(container.querySelector('.panel')).not.toBeNull()
  })

  it('lays no backdrop over the tab', () => {
    // The backdrop is what a click-outside dismisses. On a page it would be an invisible layer over
    // the whole tab that swallowed clicks and dismissed nothing.
    const { host } = hostWith({})
    const { container } = render(<SettingsView host={host} settings={{}} />)
    expect(container.querySelector('.overlay')).toBeNull()
  })

  it('does not trap Tab, which would steal the key from the browser', async () => {
    // The other half of the modal machinery. Spec 7 asks for focus management; a tab that trapped
    // focus would be the opposite of accessible.
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    const toggle = screen.getByLabelText(BLOCKER)
    toggle.focus()
    fireEvent.keyDown(window, { key: 'Tab' })
    // Unmoved: the browser's own focus order takes over from here.
    expect(document.activeElement).toBe(toggle)
  })
})

describe('the words the core sent', () => {
  it('renders the label it was given and derives nothing from the key', async () => {
    /*
      The defect this replaced: every label was built from the key by a `humanise()` helper, so this
      descriptor would have rendered as `Blocker Enabled` regardless of what the core said, in a
      browser that ships in two languages. A German label here is the cheapest way to make that
      failure impossible to pass — a component still deriving from the key cannot produce it.
    */
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())
    expect(screen.queryByLabelText('Blocker Enabled')).toBeNull()
  })

  it('shows a description where there is one, and describes the control with it', async () => {
    // Read out after the control's name by a screen reader, which is the point: the descriptions are
    // where a cost or an unimplemented switch is admitted, and admitting it only in ink admits it
    // only to sighted users.
    const { host } = hostWith({
      descriptors: [
        descriptor({
          key: 'network.killSwitch',
          label: 'Notabschaltung',
          description: 'Nicht umgesetzt. Nichts erzwingt das heute.'
        })
      ]
    })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByText(/Nicht umgesetzt/)).toBeTruthy())

    const control = screen.getByLabelText('Notabschaltung')
    const described = control.getAttribute('aria-describedby')
    expect(described).toBe('setting-network.killSwitch-description')
    expect(document.getElementById(described ?? '')?.textContent).toContain('Nicht umgesetzt')
  })

  it('adds no description element for a setting that has none', async () => {
    // Most settings have no sentence, by design. An empty paragraph under each of them would be a
    // gap that reads as a rendering fault.
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())
    expect(document.querySelector('.field__description')).toBeNull()
    expect(screen.getByLabelText(BLOCKER).getAttribute('aria-describedby')).toBeNull()
  })
})

describe('the controls the descriptors produce', () => {
  it('renders a choice as a select with the offered values', async () => {
    const { host } = hostWith({
      descriptors: [
        descriptor({
          key: 'privacy.referrerPolicy',
          label: 'Referrer',
          kind: 'choice',
          choices: ['origin-only', 'strict', 'default']
        })
      ]
    })
    render(<SettingsView host={host} settings={{ 'privacy.referrerPolicy': 'strict' }} />)
    await waitFor(() => expect(screen.getByLabelText('Referrer')).toBeTruthy())
    expect(screen.getAllByRole('option')).toHaveLength(3)
  })

  it('shows a readable name for an option rather than the raw enum member', async () => {
    /*
      `disable_non_proxied_udp` was being rendered verbatim as option text, in both languages. The
      value written back is still the member — the schema would reject anything else — so this pins
      both halves: what the user reads and what the core is sent.
    */
    const { host, calls } = hostWith({
      descriptors: [
        descriptor({
          key: 'network.webrtcIpPolicy',
          label: 'Lokale Adressen über WebRTC',
          kind: 'choice',
          choices: ['default', 'disable_non_proxied_udp'],
          choiceLabels: {
            default: 'Keine Einschränkung',
            disable_non_proxied_udp: 'Nichts am Proxy vorbei'
          }
        })
      ]
    })
    render(<SettingsView host={host} settings={{ 'network.webrtcIpPolicy': 'default' }} />)
    const select = await screen.findByLabelText('Lokale Adressen über WebRTC')
    expect(screen.getByRole('option', { name: 'Nichts am Proxy vorbei' })).toBeTruthy()
    expect(screen.queryByText('disable_non_proxied_udp')).toBeNull()

    fireEvent.change(select, { target: { value: 'disable_non_proxied_udp' } })
    await waitFor(() =>
      expect(calls.set).toEqual([
        { key: 'network.webrtcIpPolicy', value: 'disable_non_proxied_udp' }
      ])
    )
  })

  it('falls back to the raw member where the core named none', async () => {
    // The layout ids arrive unnamed on purpose — `1x2` reads the same in every language — so an
    // unnamed member must render, not vanish.
    const { host } = hostWith({
      descriptors: [
        descriptor({
          key: 'splitView.defaultLayout',
          label: 'Layout für ein neues Fenster',
          section: 'splitView',
          kind: 'choice',
          choices: ['1x1', '2x2']
        })
      ]
    })
    render(<SettingsView host={host} settings={{ 'splitView.defaultLayout': '1x1' }} />)
    await waitFor(() => expect(screen.getByRole('option', { name: '2x2' })).toBeTruthy())
  })

  it('shows a setting it cannot edit rather than hiding it', async () => {
    /*
      A shape the UI has no control for — a map, say — is still something the user should be able to
      see. Omitting it would make the settings screen quietly incomplete, and there would be no way to
      tell that from a setting that does not exist.
    */
    const { host } = hostWith({
      descriptors: [
        descriptor({
          key: 'advanced.customShortcuts',
          label: 'Eigene Tastenkürzel',
          section: 'advanced',
          kind: 'map'
        })
      ]
    })
    render(<SettingsView host={host} settings={{ 'advanced.customShortcuts': { a: 'b' } }} />)
    await waitFor(() => expect(screen.getByText('settings.readOnly')).toBeTruthy())
    expect(screen.getByText(/"a":\s*"b"/)).toBeTruthy()
  })

  it('says when a setting needs a restart', async () => {
    // Otherwise the user changes it, sees nothing happen, and changes it back.
    const { host } = hostWith({
      descriptors: [
        descriptor({
          key: 'privacy.partitionStatePerSite',
          label: 'Speicher pro Website trennen',
          applies: 'restart'
        })
      ]
    })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByText('settings.needsRestart')).toBeTruthy())
  })

  it('resets one setting without touching the others', async () => {
    const { host, calls } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    // The reset button names the setting the way the user sees it named, not the way the key spells
    // it — otherwise a screen reader announces a German row with an English action.
    fireEvent.click(screen.getByLabelText(`settings.reset: ${BLOCKER}`))
    expect(calls.reset).toEqual(['privacy.blockerEnabled'])
    expect(calls.set).toEqual([])
  })
})

describe('searching the settings', () => {
  const twoSettings = (): SettingDescriptor[] => [
    descriptor({
      key: 'privacy.blockerEnabled',
      description: 'Entfernt Werbung, bevor sie geladen wird.'
    }),
    descriptor({
      key: 'appearance.theme',
      label: 'Erscheinungsbild',
      kind: 'choice',
      section: 'appearance',
      choices: ['dark']
    })
  ]

  it('filters by the label, which is the only word on screen a user can type', async () => {
    /*
      The reason this changed from filtering on the key and a name derived from it: every key is
      English. A German user searching for a German word matched nothing at all — the search box
      answered "no matches" for a setting sitting three rows down under exactly that name.
    */
    const { host } = hostWith({ descriptors: twoSettings() })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Erscheinungsbild')).toBeTruthy())

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'werbung' } })
    expect(screen.queryByLabelText('Erscheinungsbild')).toBeNull()
    expect(screen.getByLabelText(BLOCKER)).toBeTruthy()
  })

  it('still filters by the key, which is what a bug report quotes', async () => {
    const { host } = hostWith({ descriptors: twoSettings() })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Erscheinungsbild')).toBeTruthy())

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'appearance.' } })
    expect(screen.queryByLabelText(BLOCKER)).toBeNull()
    expect(screen.getByLabelText('Erscheinungsbild')).toBeTruthy()
  })

  it('filters by the description, where the searchable nouns actually are', async () => {
    // Nothing in `webrtcIpPolicy` or its label contains the word VPN, and the sentence underneath is
    // the reason somebody would be looking for it.
    const { host } = hostWith({ descriptors: twoSettings() })
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText('Erscheinungsbild')).toBeTruthy())

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'geladen' } })
    expect(screen.queryByLabelText('Erscheinungsbild')).toBeNull()
    expect(screen.getByLabelText(BLOCKER)).toBeTruthy()
  })

  it('says nothing matched rather than showing an empty screen', async () => {
    // An empty settings screen and a settings screen that failed to load look identical.
    const { host } = hostWith({})
    render(<SettingsView host={host} settings={{}} />)
    await waitFor(() => expect(screen.getByLabelText(BLOCKER)).toBeTruthy())

    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzzz' } })
    expect(screen.getByText(/settings\.noMatches/)).toBeTruthy()
  })
})
