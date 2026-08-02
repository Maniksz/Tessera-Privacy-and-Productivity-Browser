import { useEffect, useMemo, useRef, useState } from 'react'
import { SETTINGS_SECTIONS, type SettingsSection } from '@shared/settings/sections.js'
import type { SettingDescriptor } from '@shared/settings/control.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { useCoreCall } from './useCoreCall.js'
import { UserRulesEditor, type UserRulesHost } from './UserRulesEditor.js'

/**
 * The settings surface, rendered by `tessera://settings` and by nothing else.
 *
 * ## Why there is one host now, where there were two
 *
 * This used to be shared between the chrome UI's settings panel and the tab, with `onClose` as the
 * one prop that told them apart: present meant a modal dialogue with a backdrop, a close button and
 * an Escape handler; absent meant a page. The user asked for settings to be a real page and not
 * something drawn over the window, and chose to drop the panel rather than keep both — so the fork
 * has one arm left and the other has been removed rather than left as a prop nobody passes.
 *
 * Nothing about *this* file was the reason for the change. It already rendered correctly as a page;
 * the panel was the surface that could not be zoomed, could not be linked to and could not sit in a
 * split tile. What is left here is the page's half, with the dialogue machinery gone.
 *
 * `SettingsHost` survives the deletion of the second host on purpose. It is what lets a test drive
 * this component without a bridge at all, and it is why the page's adapter is ten lines: the four
 * operations are named, rather than a generic `invoke` being handed in over a channel union this
 * component has no business knowing.
 *
 * ## Why an internal page is safe
 *
 * A web page can link to `tessera://settings`, and the surface can write every setting the browser
 * has. That link only navigates: the two documents are cross-origin, so the linking page gets no DOM
 * access and no scripting handle, and this surface listens to no `postMessage`. What keeps it that
 * way is the page's CSP (`default-src 'none'`, `script-src 'self'`, no `unsafe-inline`), so injected
 * script cannot run even if content reached the markup. The page is also the *less* privileged of
 * the two hosts it once had: its bridge carries exactly the six channels
 * `INTERNAL_PAGE_INVOKE_CHANNELS.settings` grants, where the chrome renderer has all sixty.
 *
 * The sixth is `updates:checkNow`, which arrived with the button below and is the only grant in that
 * whole table that lets a page cause an outbound request. It is held to this one page by a fitness
 * function — `gives no page but settings an update command` — rather than by this paragraph.
 *
 * ## Where the words come from
 *
 * Not from here. Every label used to be derived from the key by a `humanise()` helper, so a German
 * user read `Block third party cookies` beside seventy-six switches — spec 7's rule against
 * hard-coded strings, broken in the one way a catalogue check could never see, because the strings
 * were generated at render time. Labels, descriptions and readable option names now arrive on the
 * descriptor from `main/settings/settings-text.*`; that module explains why they are not in the
 * shared catalogue. The only text this file still resolves itself is its own chrome — the heading,
 * the search box, the section titles, the update button's label — which is catalogue work and stays
 * catalogue work. `updates.checkNow` was already there for the Help menu, which is why the button
 * needed no new key; nothing else about it may grow one, because the catalogue chunk is inside about
 * two hundred bytes of a budget a fitness test enforces.
 */

const SECTION_LABELS: Readonly<Record<SettingsSection, MessageKey>> = {
  appearance: 'settings.section.appearance',
  search: 'settings.section.search',
  splitView: 'settings.section.splitView',
  privacy: 'settings.section.privacy',
  passwords: 'settings.section.passwords',
  permissions: 'settings.section.permissions',
  network: 'settings.section.network',
  downloads: 'settings.section.downloads',
  session: 'settings.section.session',
  clearData: 'settings.section.clearData',
  advanced: 'settings.section.advanced'
}

export type Snapshot = Record<string, unknown>

export type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/**
 * Everything this surface needs from the renderer hosting it.
 *
 * Each method maps to exactly one channel, so an adapter cannot accidentally give this component a
 * power it was not meant to have — and the page's adapter physically cannot, because its bridge has
 * only these.
 */
export interface SettingsHost {
  describe(): Promise<SettingDescriptor[]>
  /** Writes one setting. Must reject on refusal rather than resolving: see `write` below. */
  set(key: string, value: unknown): Promise<void>
  reset(key: string): Promise<void>
  /**
   * Asks the core to look for a new version now.
   *
   * Resolves when the check is finished, and with nothing: the answer is a native dialog the core
   * raises. What this promise is for is the *duration* — the button is disabled until it settles.
   *
   * Required rather than optional. An optional method would let a host omit it and render a button
   * that does nothing, which is the exact defect `useCoreCall`'s docblock is about; required means
   * the compiler asks the question.
   */
  checkForUpdates(): Promise<void>
  /**
   * The user's own filter rules.
   *
   * A nested host rather than four more methods here, because the rules are not settings: they have no
   * default to go back to, no descriptor, and their own vocabulary of outcomes. Grouping them keeps this
   * interface about the settings table and lets the editor be driven on its own in a test.
   */
  userRules: UserRulesHost
  /**
   * Opens the passwords page.
   *
   * Here rather than as a link, because a link does not work: `navigation-policy.ts` refuses page
   * content navigating to an internal address, and this screen is page content. See
   * `passwords:openManager`, whose whole payload is nothing at all.
   */
  openPasswordManager(): Promise<void>
  t: Translate
}

export interface SettingsViewProps {
  host: SettingsHost
  /** The current values, or `null` before the first snapshot has arrived. */
  settings: Snapshot | null
}

export function SettingsView({ host, settings }: SettingsViewProps): React.ReactNode {
  const { t } = host
  const [descriptors, setDescriptors] = useState<SettingDescriptor[]>([])
  const [query, setQuery] = useState('')
  const [checking, setChecking] = useState(false)
  const { error, run } = useCoreCall()
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    /*
      The first load goes through `run`, which it did not before.

      It was `void host.describe().then(setDescriptors)`: a rejection went nowhere, and this surface
      renders no empty-state text when it has no descriptors — the `noMatches` message is gated on
      having some — so a refused `settings:describe` produced a blank page body. "The core refused"
      and "this browser has no settings" must not be the same picture.

      Re-runs whenever `host` changes identity, which is now load-bearing rather than incidental: the
      page rebuilds its host after a language change precisely so this refetches, because the labels
      and descriptions live on the descriptors and the core resolved them in the old language.

      An async body rather than `.then`: a state write attached directly to a promise in an effect body
      has no relationship to the effect's own cleanup, which is what the `react-hooks` rule flags.
    */
    void run(async () => {
      const next = await host.describe()
      if (!cancelled) setDescriptors(next)
    })
    return () => {
      cancelled = true
    }
  }, [host, run])

  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  const write = (key: string, value: unknown): Promise<void> => run(() => host.set(key, value))

  /*
    The check, and the whole of what this surface knows about updates.

    Disabled until the promise settles, and that is the only progress this control reports. There is
    no "checking…" anywhere in the message catalogue, the catalogue is one chunk with both locales in
    it and it sits under a budget a fitness test enforces with about two hundred bytes to spare — so
    a word here would cost a failing test in `architecture.test.ts`. The disabled state is honest
    about the one thing that matters (something is happening, pressing again will not help) and the
    result arrives as a native dialog a moment later, which is where the sentences already exist.

    `run` swallows nothing: a refused invoke lands in the same `role="alert"` a refused write does.
    Re-enabled in `finally`, because a button left disabled by a failure is a button the user cannot
    retry with.
  */
  const checkForUpdates = (): void => {
    setChecking(true)
    void run(() => host.checkForUpdates()).finally(() => {
      setChecking(false)
    })
  }

  /*
    The one case where the button's answer would be a lie, admitted next to the button.

    `updates.channel` defaults to `alpha`; a user who chooses `stable` is told "No new version"
    forever, because every version this project has published is a prerelease and GitHub's "latest
    release" excludes those. That was a tolerable footnote while the only way to ask was a Help-menu
    item nobody finds. A button at the top of the settings page makes a wrong answer far easier to
    reach, so this surface must not present it without the caveat.

    The sentence is the descriptor's own — the same text the `updates.channel` row renders nine
    sections further down, resolved by the core in the user's language. Written out here instead, it
    would be a second wording of the same fact in two locales, a new catalogue key the budget has no
    room for, and one more place to forget when the first stable release makes it untrue.

    This is a mitigation and not the fix. The dialog still says "No new version" to that user, and
    correcting *that* needs wording and an outcome this component cannot see; see the report.
  */
  const channelCaveat = useMemo(() => {
    if (settings?.['updates.channel'] !== 'stable') return null
    return (
      descriptors.find((descriptor) => descriptor.key === 'updates.channel')?.description ?? null
    )
  }, [descriptors, settings])

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return descriptors
    /*
      Key, label *and* description, where it used to be key and a name derived from the key.

      Searching only the key would mean a German user searching for a German word finds nothing at all
      — every key is English, and the label beside it is the only word on screen they can type. The
      description is included as well because that is where the searchable nouns are: nothing in
      `webrtcIpPolicy` or its label contains the word VPN, and the sentence underneath is the reason
      somebody would be looking. The cost is that a search occasionally matches a row whose title does
      not obviously contain the term; a search that silently finds nothing is the worse failure.
    */
    return descriptors.filter(
      (descriptor) =>
        descriptor.key.toLowerCase().includes(needle) ||
        descriptor.label.toLowerCase().includes(needle) ||
        (descriptor.description ?? '').toLowerCase().includes(needle)
    )
  }, [descriptors, query])

  const bySection = useMemo(() => {
    const grouped = new Map<SettingsSection, SettingDescriptor[]>()
    for (const descriptor of visible) {
      const list = grouped.get(descriptor.section) ?? []
      list.push(descriptor)
      grouped.set(descriptor.section, list)
    }
    return grouped
  }, [visible])

  const appliesNote = (applies: SettingDescriptor['applies']): string | null => {
    if (applies === 'restart') return t('settings.needsRestart')
    if (applies === 'new-tab') return t('settings.appliesNewTab')
    return null
  }

  const control = (descriptor: SettingDescriptor, describedBy: string | null): React.ReactNode => {
    const value = settings?.[descriptor.key]
    const id = `setting-${descriptor.key}`
    // Spread rather than passed as `undefined`: an `aria-describedby=""` on a control with nothing to
    // describe it points a screen reader at a node that is not there.
    const description = describedBy === null ? {} : { 'aria-describedby': describedBy }

    switch (descriptor.kind) {
      case 'toggle':
        return (
          <input
            id={id}
            className="field__toggle"
            type="checkbox"
            checked={value === true}
            {...description}
            onChange={(event) => void write(descriptor.key, event.target.checked)}
          />
        )

      case 'choice':
        return (
          <select
            id={id}
            className="field__select"
            value={typeof value === 'string' ? value : ''}
            {...description}
            onChange={(event) => void write(descriptor.key, event.target.value)}
          >
            {(descriptor.choices ?? []).map((choice) => (
              <option key={choice} value={choice}>
                {/*
                  The raw member is the fallback, not the norm. `disable_non_proxied_udp` was being
                  rendered verbatim as option text. Where the core sends no name the member is shown
                  as it is, which is right for the layout ids — `1x2` reads the same in any language.
                */}
                {descriptor.choiceLabels?.[choice] ?? choice}
              </option>
            ))}
          </select>
        )

      case 'number':
        return (
          <input
            id={id}
            className="field__number"
            type="number"
            value={typeof value === 'number' ? value : ''}
            {...(descriptor.min === undefined ? {} : { min: descriptor.min })}
            {...(descriptor.max === undefined ? {} : { max: descriptor.max })}
            step={descriptor.integer === true ? 1 : 'any'}
            {...description}
            onChange={(event) => {
              const parsed = Number(event.target.value)
              if (Number.isNaN(parsed)) return
              void write(descriptor.key, parsed)
            }}
          />
        )

      case 'text':
        return (
          <input
            id={id}
            className="field__text"
            type="text"
            value={typeof value === 'string' ? value : ''}
            {...description}
            onChange={(event) => void write(descriptor.key, event.target.value)}
          />
        )

      case 'text-list':
        return (
          <textarea
            id={id}
            className="field__list"
            rows={Math.min(6, Math.max(2, Array.isArray(value) ? value.length + 1 : 2))}
            value={Array.isArray(value) ? value.join('\n') : ''}
            {...description}
            onChange={(event) => {
              const lines = event.target.value
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line !== '')
              void write(descriptor.key, lines)
            }}
          />
        )

      // A map or an unrecognised shape is shown, not silently omitted — a setting the UI cannot edit is
      // still something the user should be able to see.
      default:
        return (
          <output className="field__readonly" id={id} {...description}>
            {JSON.stringify(value)}
          </output>
        )
    }
  }

  return (
    <div className="panel" aria-labelledby="settings-heading">
      <header className="panel__header">
        <h2 className="panel__heading" id="settings-heading">
          {t('settings.title')}
        </h2>
        <input
          ref={searchRef}
          className="panel__search"
          type="search"
          value={query}
          placeholder={t('settings.searchPlaceholder')}
          aria-label={t('settings.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
      </header>

      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}

      <div className="panel__body">
        {/*
          An action, at the top, in a surface that is otherwise generated entirely from descriptors.

          Every other row here is label + key + control + reset, built from `settings:describe`. This
          one is deliberately not: a descriptor row is a *value that is stored*, with a current state
          and a default to go back to, and "check now" has none of those. Adding it as a pseudo-setting
          would have meant a control kind that ignores its value, a reset button that resets nothing,
          and a key that names no setting — a lie in four places to avoid one small block of markup.

          It is also why it sits above the section list rather than beside the two update settings. Those
          are the last two rows of `advanced`, which is the last of ten sections; the user asked for this
          "recht weit oben", and a button is not a setting anyway. What keeps this from growing into a
          second settings screen is that it holds one control: anything with a value to store belongs in
          `definitions.ts`, and anything that needs its own words needs a catalogue key the budget does
          not have.
        */}
        <div className="panel__lead">
          <button
            type="button"
            className="dialog__button"
            disabled={checking}
            onClick={checkForUpdates}
          >
            {t('updates.checkNow')}
          </button>
          {channelCaveat !== null && <p className="panel__notice">{channelCaveat}</p>}
        </div>

        {visible.length === 0 && descriptors.length > 0 && (
          <p className="panel__empty">{t('settings.noMatches', { query })}</p>
        )}

        {SETTINGS_SECTIONS.filter((section) => (bySection.get(section)?.length ?? 0) > 0).map(
          (section) => (
            <section className="panel__section" key={section}>
              <h3 className="panel__sectionTitle">{t(SECTION_LABELS[section])}</h3>

              {/*
                The one section that leads somewhere, and the reason it has to.

                Everything else on this screen is a value with a default. A saved password is neither:
                it has no default to reset to, it must not sit in a list that a search box filters into
                view, and reading one needs a master password this surface has no business collecting.
                So the section holds the two switches that *are* settings and points at the page that
                holds the rest — which is what somebody means when they look here for "Passwörter" and
                find nothing.

                Directly under the heading rather than after the switches: it is the thing most people
                came for, and a link below two rows of controls is a link found by the people who did
                not need it.
              */}
              {section === 'passwords' && (
                <div className="panel__lead">
                  <button
                    type="button"
                    className="dialog__button"
                    onClick={() => void run(() => host.openPasswordManager())}
                  >
                    {t('settings.openPasswordManager')}
                  </button>
                </div>
              )}

              {(bySection.get(section) ?? []).map((descriptor) => {
                const note = appliesNote(descriptor.applies)
                const id = `setting-${descriptor.key}`
                const isList = descriptor.kind === 'text-list'
                /*
                  Every sentence under the label, joined into one `aria-describedby`.

                  A screen reader reads these after the control's name, so a user hears "Kill switch,
                  checkbox, not implemented — nothing enforces this today" rather than the label alone.
                  The description is the important half: it is where a cost or an unimplemented switch
                  is admitted, and admitting it only in ink is admitting it to sighted users only.
                */
                const describedBy =
                  [
                    descriptor.description === undefined ? null : `${id}-description`,
                    isList ? `${id}-hint` : null
                  ]
                    .filter((part) => part !== null)
                    .join(' ') || null

                return (
                  <div className="field" key={descriptor.key}>
                    <div className="field__text-block">
                      <label className="field__label" htmlFor={id}>
                        {descriptor.label}
                      </label>
                      {descriptor.description !== undefined && (
                        <p className="field__description" id={`${id}-description`}>
                          {descriptor.description}
                        </p>
                      )}
                      <code className="field__key">{descriptor.key}</code>
                      {note !== null && <span className="field__note">{note}</span>}
                      {isList && (
                        <span className="field__note" id={`${id}-hint`}>
                          {t('settings.listHint')}
                        </span>
                      )}
                      {(descriptor.kind === 'map' || descriptor.kind === 'unsupported') && (
                        <span className="field__note">{t('settings.readOnly')}</span>
                      )}
                    </div>

                    <div className="field__control">{control(descriptor, describedBy)}</div>

                    <button
                      type="button"
                      className="field__reset"
                      aria-label={`${t('settings.reset')}: ${descriptor.label}`}
                      title={t('settings.reset')}
                      onClick={() => {
                        void run(() => host.reset(descriptor.key))
                      }}
                    >
                      ↺
                    </button>
                  </div>
                )
              })}
            </section>
          )
        )}

        {/*
          The user's own filter rules, after the generated sections and taking part in the search.

          After, because it is the one block here that is not a settings row: the rules have no default to
          reset to and no descriptor, so putting them among the sections would mean a section built by hand
          sitting between nine that are generated.

          It used to be *hidden* whenever the box had anything in it, on the argument that a block the
          search cannot filter must not stay put while everything around it disappears. That was the wrong
          half of the problem: somebody looking for their filter rules types the word for them, and typing
          it made the only screen that shows them vanish — which is how a screen that exists gets reported
          as missing. So the query goes in instead and the block answers it; `UserRulesEditor` has the
          words to match against and this file does not.
        */}
        <UserRulesEditor host={host.userRules} query={query} />
      </div>
    </div>
  )
}
