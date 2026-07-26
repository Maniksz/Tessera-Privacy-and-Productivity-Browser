import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import type { TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import {
  SEARCH_ENGINES,
  classifyOmniboxInput,
  omniboxDisplayValue
} from '@shared/url/omnibox.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * Address bar (spec 1).
 *
 * The preview under the field ("Search with DuckDuckGo" versus "Open
 * example.com") comes from `classifyOmniboxInput` — the same function the core
 * uses to resolve the navigation. The label can therefore never promise
 * something different from what pressing Enter does.
 */

interface OmniboxProps {
  tab: TabState | undefined
  settings: SettingsSnapshot | null
  privateMode: boolean
  /**
   * Bumped when the user asks for the address bar — Ctrl+L, Alt+D, F6.
   *
   * A counter rather than a boolean, because the request has to be repeatable: pressing Ctrl+L twice must
   * focus and select twice, and a boolean that is already `true` produces nothing the second time.
   */
  focusRequest: number
}

export function Omnibox({
  tab,
  settings,
  privateMode,
  focusRequest
}: OmniboxProps): React.ReactNode {
  const { t } = useI18n()
  const [value, setValue] = useState('')
  const [editing, setEditing] = useState(false)
  const [syncedUrl, setSyncedUrl] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  /*
    Focus *and* select, which is what every other browser does for Ctrl+L.

    Focusing alone would put the caret somewhere in the middle of the address the user wants to replace, and
    the whole point of the shortcut is to type over it. Skipped on the first render — `focusRequest` starts at
    zero — so opening a window does not steal the caret from the page.
  */
  useEffect(() => {
    if (focusRequest === 0) return
    const input = inputRef.current
    if (input === null) return
    input.focus()
    input.select()
  }, [focusRequest])

  /**
   * Follows the tab's URL unless the user is mid-edit — overwriting someone's
   * half-typed address because a background load finished is maddening.
   *
   * Adjusted during render rather than in an effect. The effect version ran after
   * paint, so every navigation rendered twice: once with the old address still in
   * the field, then again with the new one. React documents this pattern for state
   * derived from props precisely to avoid that.
   */
  // Empty on the home page rather than showing `tessera://start/`, which tells the
  // user nothing and occupies the field they are about to type into.
  const currentUrl = omniboxDisplayValue(tab?.url ?? '')
  if (!editing && currentUrl !== syncedUrl) {
    setSyncedUrl(currentUrl)
    setValue(currentUrl)
  }

  const submit = (event: SyntheticEvent): void => {
    event.preventDefault()
    if (value.trim() === '') return
    void invoke('nav:navigate', { input: value })
    setEditing(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Escape') {
      setEditing(false)
      setValue(omniboxDisplayValue(tab?.url ?? ''))
      inputRef.current?.blur()
    }
  }

  const intent = classifyOmniboxInput(value)
  const engine = (settings?.['search.defaultEngine'] ?? 'duckduckgo')
  const hint =
    !editing || intent.kind === 'empty'
      ? null
      : intent.kind === 'search'
        ? t('omnibox.searchWith', { engine: SEARCH_ENGINES[engine].label })
        : t('omnibox.openUrl', { url: intent.url })

  const security = tab?.security ?? 'internal'
  const securityLabel = t(
    security === 'secure'
      ? 'omnibox.security.secure'
      : security === 'insecure'
        ? 'omnibox.security.insecure'
        : security === 'invalid-certificate'
          ? 'omnibox.security.invalidCertificate'
          : 'omnibox.security.internal'
  )

  return (
    <form className="omnibox" onSubmit={submit} role="search">
      <span
        className={`omnibox__security omnibox__security--${security}`}
        title={securityLabel}
        aria-label={securityLabel}
      >
        {security === 'secure' ? '🔒' : security === 'insecure' ? '⚠' : security === 'invalid-certificate' ? '⛔' : '◆'}
      </span>

      {privateMode && (
        <span className="omnibox__badge omnibox__badge--private">{t('omnibox.privateMode')}</span>
      )}

      <input
        ref={inputRef}
        className="omnibox__input"
        value={value}
        placeholder={t('omnibox.placeholder')}
        aria-label={t('omnibox.placeholder')}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          setValue(event.target.value)
          setEditing(true)
        }}
        onFocus={(event) => {
          setEditing(true)
          event.target.select()
        }}
        onBlur={() => setEditing(false)}
        onKeyDown={onKeyDown}
      />

      {/* Real count of blocked requests for this page, not an estimate (spec 1). */}
      {tab !== undefined && tab.blockedRequests > 0 && (
        <button
          type="button"
          className="omnibox__badge"
          title={t('omnibox.blockedCount', { count: tab.blockedRequests })}
          aria-label={t('omnibox.blockedCount', { count: tab.blockedRequests })}
          /*
            Opens the blocker's menu, which the *core* draws.

            A native menu, because a DOM one here would drop down behind the page — page content is a native
            view above this renderer's own document. The badge used to be a button that did nothing at all;
            what a person wants when they notice "12 blocked" is to see what happened, hide something the
            blocker missed, or switch it off because the page is broken.
          */
          onClick={() => void invoke('blocker:menu')}
        >
          {tab.blockedRequests}
        </button>
      )}

      {hint !== null && (
        <div className="omnibox__hint" role="status">
          {hint}
        </div>
      )}
    </form>
  )
}
