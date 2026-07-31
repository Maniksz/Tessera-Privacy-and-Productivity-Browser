import { useEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react'
import type { TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import {
  SEARCH_ENGINES,
  classifyOmniboxInput,
  omniboxDisplayValue
} from '@shared/url/omnibox.js'
import { filteringExemptFor } from '@shared/filters/site-exemption.js'
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

  /*
    Whether this page is being filtered, and the three states the shield has to tell apart.

    Read from the settings snapshot rather than pushed down as a new field on `TabState`: both inputs are
    already here, and the alternative would be the core recomputing a boolean per tab on every settings
    change and broadcasting it.

    `filteringExemptFor` is the same function `RequestPipeline` and `CosmeticInjector` decide with, so
    the shield cannot claim a site is filtered while the pipeline is skipping it. That agreement is the
    reason this is an import and not two lines of host comparison here.
  */
  const blockerEnabled = settings?.['privacy.blockerEnabled'] ?? true
  const exemptHere = filteringExemptFor(tab?.url ?? null, settings?.['privacy.blockerOffForSites'] ?? [])
  const filtering = blockerEnabled && !exemptHere
  const blockerLabel = !blockerEnabled
    ? t('omnibox.blockerOff')
    : exemptHere
      ? t('omnibox.blockerOffHere')
      : tab !== undefined && tab.blockedRequests > 0
        ? t('omnibox.blockedCount', { count: tab.blockedRequests })
        : t('omnibox.blocker')

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

      {/*
        The blocker, on every page rather than only where something was blocked.

        ## Why it used to be conditional, and why that was the bug

        This was `tab.blockedRequests > 0 && …`: a badge that appeared when the blocker had done
        something and was absent otherwise. As a *report* that is right — the count is real, not an
        estimate (spec 1). As the way into the blocker's menu it is not, and the menu is what is behind
        it: the element picker, the per-site off switch, the user's own rules. Every one of those is
        something a person reaches for **because a page looks wrong**, which is exactly the case where
        nothing has been blocked and the button was not there. Reported as wanting element blocking
        "mit quick access"; the picker had existed for some time behind a control that hid itself.

        So the button is always present and the count is what is conditional. The icon is a shield, and
        it is dimmed when this site is not being filtered — which makes the state readable without
        opening anything, and is the answer to somebody who switched filtering off for a site last week
        and has forgotten.

        A native menu still, because a DOM one here would drop down behind the page: content is a native
        view above this renderer's own document.
      */}
      {tab !== undefined && (
        <button
          type="button"
          className={`omnibox__blocker${filtering ? '' : ' omnibox__blocker--off'}`}
          title={blockerLabel}
          aria-label={blockerLabel}
          onClick={() => void invoke('blocker:menu')}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.6l5 1.7v4.2c0 3-2 5.4-5 6.9-3-1.5-5-3.9-5-6.9V3.3z" />
          </svg>
          {tab.blockedRequests > 0 && (
            <span className="omnibox__blockerCount">{tab.blockedRequests}</span>
          )}
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
