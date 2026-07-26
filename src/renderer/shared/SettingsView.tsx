import { useEffect, useMemo, useRef, useState } from 'react'
import { SETTINGS_SECTIONS, type SettingsSection } from '@shared/settings/sections.js'
import type { SettingDescriptor } from '@shared/settings/control.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { usePanelDismiss } from './usePanelDismiss.js'
import { useCoreCall } from './useCoreCall.js'

/**
 * The settings surface, hosted by either the chrome UI or the `tessera://settings` page.
 *
 * ## Why one component and two hosts
 *
 * The user asked to keep the in-window panel *and* have a real tab — the tab so settings can be
 * zoomed, linked to and shown in a tile, the panel because it is one click away. Two entry points is a
 * product decision; two implementations would be a mistake, and the second one always drifts. So this
 * holds every decision about what settings look like and how they behave, and each host supplies only
 * the four things it can do that the other cannot.
 *
 * ## Why the seam is four methods and not a bridge
 *
 * The obvious shape is to pass in an `invoke`. This deliberately does not: the two bridges are typed
 * over *different* channel unions — the chrome one over all of them, the internal one over the seven
 * this page is allowed — and a single generic signature covering both is either a lie or a cast.
 * Naming the four operations instead makes the component's needs explicit, keeps both adapters about
 * ten lines, and means a test can supply them without a bridge at all.
 *
 * ## Why an internal page is safe, contrary to what this component's docblock used to say
 *
 * It said settings could not be a page because "an internal page only gets the narrow bridge, which
 * deliberately excludes the settings channels — putting settings on an internal page would mean
 * widening that hole". That was backwards. `INTERNAL_PAGE_INVOKE_CHANNELS.settings` already grants
 * exactly the seven settings channels, and the chrome renderer that hosts the panel has *all* sixty:
 * the page is the strictly less privileged of the two hosts.
 *
 * The one real difference is reachability — a web page can link to `tessera://settings`, and cannot
 * link to the chrome UI. That is acceptable because the link only navigates: the two documents are
 * cross-origin, so the linking page gets no DOM access and no scripting handle, and this surface
 * listens to no `postMessage`. What keeps it that way is the page's CSP (`default-src 'none'`,
 * `script-src 'self'`, no `unsafe-inline`), so injected script cannot run even if content reached the
 * markup.
 */

const SECTION_LABELS: Readonly<Record<SettingsSection, MessageKey>> = {
  appearance: 'settings.section.appearance',
  search: 'settings.section.search',
  splitView: 'settings.section.splitView',
  privacy: 'settings.section.privacy',
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
 * Everything this surface needs from whichever renderer is hosting it.
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
  t: Translate
}

export interface SettingsViewProps {
  host: SettingsHost
  /** The current values, or `null` before the first snapshot has arrived. */
  settings: Snapshot | null
  /**
   * Closing, where closing means something.
   *
   * The panel dismisses itself; a tab has nothing to dismiss, so its adapter passes `undefined` and
   * this drops the close button, the backdrop and the Escape handler. A close button on a tab that did
   * nothing would be worse than none.
   */
  onClose?: (() => void) | undefined
}

/** Turns `privacy.blockThirdPartyCookies` into `Block third party cookies`. */
function humanise(key: string): string {
  const leaf = key.slice(key.indexOf('.') + 1)
  const spaced = leaf.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[._]/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function SettingsView({ host, settings, onClose }: SettingsViewProps): React.ReactNode {
  const { t } = host
  const [descriptors, setDescriptors] = useState<SettingDescriptor[]>([])
  const [query, setQuery] = useState('')
  const { error, run } = useCoreCall()
  const panelRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    /*
      The first load goes through `run`, which it did not before.

      It was `void host.describe().then(setDescriptors)`: a rejection went nowhere, and this surface
      renders no empty-state text when it has no descriptors — the `noMatches` message is gated on
      having some — so a refused `settings:describe` produced a blank panel body. "The core refused"
      and "this browser has no settings" must not be the same picture.

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

  // Panel-only, and the hook says why. Shared with `ExtensionsView`, which claimed `aria-modal`
  // without it.
  usePanelDismiss(panelRef, onClose)

  const write = (key: string, value: unknown): Promise<void> => run(() => host.set(key, value))

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return descriptors
    return descriptors.filter(
      (d) => d.key.toLowerCase().includes(needle) || humanise(d.key).toLowerCase().includes(needle)
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

  const control = (descriptor: SettingDescriptor): React.ReactNode => {
    const value = settings?.[descriptor.key]
    const id = `setting-${descriptor.key}`

    switch (descriptor.kind) {
      case 'toggle':
        return (
          <input
            id={id}
            className="field__toggle"
            type="checkbox"
            checked={value === true}
            onChange={(event) => void write(descriptor.key, event.target.checked)}
          />
        )

      case 'choice':
        return (
          <select
            id={id}
            className="field__select"
            value={typeof value === 'string' ? value : ''}
            onChange={(event) => void write(descriptor.key, event.target.value)}
          >
            {(descriptor.choices ?? []).map((choice) => (
              <option key={choice} value={choice}>
                {choice}
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
            aria-describedby={`${id}-hint`}
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
          <output className="field__readonly" id={id}>
            {JSON.stringify(value)}
          </output>
        )
    }
  }

  const body = (
    <div
      className="panel"
      // A tab is not a dialogue. Claiming `role="dialog" aria-modal` on a whole page tells a screen
      // reader the rest of the browser is unavailable, which is false and makes it harder to leave.
      {...(onClose === undefined ? {} : { role: 'dialog', 'aria-modal': true })}
      aria-labelledby="settings-heading"
      ref={panelRef}
    >
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
        {onClose !== undefined && (
          <button type="button" className="iconbutton" aria-label={t('settings.close')} onClick={onClose}>
            ×
          </button>
        )}
      </header>

      {error !== null && (
        <p className="panel__error" role="alert">
          {error}
        </p>
      )}

      <div className="panel__body">
        {visible.length === 0 && descriptors.length > 0 && (
          <p className="panel__empty">{t('settings.noMatches', { query })}</p>
        )}

        {SETTINGS_SECTIONS.filter((section) => (bySection.get(section)?.length ?? 0) > 0).map(
          (section) => (
            <section className="panel__section" key={section}>
              <h3 className="panel__sectionTitle">{t(SECTION_LABELS[section])}</h3>

              {(bySection.get(section) ?? []).map((descriptor) => {
                const note = appliesNote(descriptor.applies)
                const id = `setting-${descriptor.key}`
                return (
                  <div className="field" key={descriptor.key}>
                    <div className="field__text-block">
                      <label className="field__label" htmlFor={id}>
                        {humanise(descriptor.key)}
                      </label>
                      <code className="field__key">{descriptor.key}</code>
                      {note !== null && <span className="field__note">{note}</span>}
                      {descriptor.kind === 'text-list' && (
                        <span className="field__note" id={`${id}-hint`}>
                          {t('settings.listHint')}
                        </span>
                      )}
                      {(descriptor.kind === 'map' || descriptor.kind === 'unsupported') && (
                        <span className="field__note">{t('settings.readOnly')}</span>
                      )}
                    </div>

                    <div className="field__control">{control(descriptor)}</div>

                    <button
                      type="button"
                      className="field__reset"
                      aria-label={`${t('settings.reset')}: ${humanise(descriptor.key)}`}
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
      </div>
    </div>
  )

  // The panel floats over the window and dismisses on a backdrop click; the page is just the page.
  if (onClose === undefined) return body
  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      {body}
    </div>
  )
}
