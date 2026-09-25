import { useEffect, useRef, useState } from 'react'
import type { TargetedEvent, TargetedKeyboardEvent } from 'preact'
import type { SecurityState, TabState } from '@shared/model.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { omniboxDisplayValue } from '@shared/url/omnibox.js'
import {
  OMNIBOX_MAX_TEXT,
  nextSelection,
  type OmniboxSuggestionsPresentation
} from '@shared/omnibox/model.js'
import { filteringExemptFor } from '@shared/filters/site-exemption.js'
import { invoke, subscribe } from '../bridge.js'
import { chooseSuggestion } from '../omnibox-choice.js'
import { useI18n } from '../i18n.js'
import { Icon, type IconName } from '../../shared/Icon.js'

/**
 * Address bar (spec 1), and the keyboard half of its suggestion list (U18, R28–R30).
 *
 * ## The list
 *
 * Every keystroke asks the core for suggestions with a running number; the core ranks, presents the list
 * on the overlay layer and tells both renderers. This field keeps only the presentation that answers its
 * *latest* number — an older one describes text it no longer holds — and walks it with the arrow keys.
 * Row zero is what Enter does with the text as typed ("Search with DuckDuckGo", "Open example.com"), the
 * line the old hint under the field said from behind the page, and its label comes from the same
 * classification the core navigates with.
 *
 * Enter with no row reached opens the text. Escape closes the list first and reverts the text second.
 * During an IME composition Enter and the arrows belong to the composition. The list is never closed on
 * this field's `blur`: a press on a row takes the keyboard into the overlay first, and closing here would
 * race the choice. The core closes it — a choice, Escape, a tab switch, a navigation, the window losing
 * focus, a click into a page.
 */

/** What the badge in front of the address draws, per state. The label says it in words. */
const SECURITY_ICONS: Readonly<Record<SecurityState, IconName>> = {
  secure: 'lock',
  insecure: 'warning',
  'invalid-certificate': 'blocked',
  internal: 'internal'
}

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
  const formRef = useRef<HTMLFormElement>(null)
  /** The latest request's number. A presentation carrying any other is stale and is not walked. */
  const seqRef = useRef(0)
  /** The row Enter opens, kept here so a key pressed before the core answers means the row reached. */
  const selectedRef = useRef(0)
  const [suggestions, setSuggestions] = useState<OmniboxSuggestionsPresentation | null>(null)

  useEffect(() => {
    return subscribe('overlay:presented', ({ presentation }) => {
      if (presentation?.kind !== 'omnibox-suggestions') setSuggestions(null)
      else if (presentation.seq === seqRef.current) setSuggestions(presentation)
    })
  }, [])

  /** Asks for the list for `text` with row `selected` reached; closes it for text that would do nothing. */
  const suggest = (text: string, selected: number): void => {
    const form = formRef.current
    selectedRef.current = selected
    if (form === null || text.trim() === '' || text.length > OMNIBOX_MAX_TEXT) {
      closeSuggestions()
      return
    }
    seqRef.current += 1
    const box = form.getBoundingClientRect()
    const anchor = { x: box.x, y: box.y, width: box.width, height: box.height }
    void invoke('omnibox:suggest', { seq: seqRef.current, text, anchor, selected })
  }

  const closeSuggestions = (): void => {
    selectedRef.current = 0
    setSuggestions(null)
    void invoke('omnibox:close')
  }

  /** Leaves the field after Enter; the core closes the list on the navigation or the tab switch. */
  const finish = (): void => {
    selectedRef.current = 0
    setSuggestions(null)
    setEditing(false)
    inputRef.current?.blur()
  }

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

  const submit = (event: TargetedEvent): void => {
    event.preventDefault()
    if (value.trim() === '') return
    void invoke('nav:navigate', { input: value })
    finish()
  }

  const onKeyDown = (event: TargetedKeyboardEvent<HTMLInputElement>): void => {
    // The composition owns these keys until it ends; Enter there commits text, it never picks a row.
    // `Process` is how Chromium names a key an IME has taken, for the moment before `isComposing` is set.
    if (event.isComposing || event.key === 'Process') return
    const list = suggestions
    if (list !== null && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 'down' : 'up'
      const next = nextSelection(selectedRef.current, list.rows.length, step)
      if (next !== selectedRef.current) suggest(value, next)
      return
    }
    if (event.key === 'Enter' && list !== null && selectedRef.current > 0) {
      event.preventDefault()
      chooseSuggestion(list, selectedRef.current)
      finish()
      return
    }
    if (event.key !== 'Escape') return
    // Closed either way: a list this field has not been told about yet may still be up.
    closeSuggestions()
    if (list !== null) return
    setEditing(false)
    setValue(omniboxDisplayValue(tab?.url ?? ''))
    inputRef.current?.blur()
  }

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
  const exemptHere = filteringExemptFor(
    tab?.url ?? null,
    settings?.['privacy.blockerOffForSites'] ?? []
  )
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
    <form ref={formRef} className="omnibox" onSubmit={submit} role="search">
      {/*
        The lock, and a button now rather than a picture of one (U19).

        It opens the site menu — connection, blocker, stored permissions, the tile's zoom, fingerprint mode —
        which is the same native menu the shield opens (KTD13). A button so that it has a name, is in the tab
        order and opens on Enter or Space; the name stays the connection's state, which is what it says
        before it is pressed, and `aria-haspopup` says that pressing it opens a menu.
      */}
      <button
        type="button"
        className={`omnibox__security omnibox__security--${security}`}
        title={securityLabel}
        aria-label={securityLabel}
        aria-haspopup="menu"
        onClick={() => void invoke('site:menu')}
      >
        <Icon name={SECURITY_ICONS[security]} size={13} />
      </button>

      {privateMode && (
        <span className="omnibox__badge omnibox__badge--private">{t('omnibox.privateMode')}</span>
      )}

      <input
        ref={inputRef}
        className="omnibox__input"
        value={value}
        placeholder={t('omnibox.placeholder')}
        aria-label={t('omnibox.placeholder')}
        spellcheck={false}
        autoComplete="off"
        onChange={(event) => {
          setValue(event.currentTarget.value)
          setEditing(true)
          // What is on screen now describes the previous text; it is not walked until the answer arrives.
          setSuggestions(null)
          suggest(event.currentTarget.value, 0)
        }}
        onFocus={(event) => {
          setEditing(true)
          event.currentTarget.select()
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
        view above this renderer's own document. Since U19 it is the site menu, the one the lock opens; the
        blocker's items are carried in it unchanged.
      */}
      {tab !== undefined && (
        <button
          type="button"
          className={`omnibox__blocker${filtering ? '' : ' omnibox__blocker--off'}`}
          title={blockerLabel}
          aria-label={blockerLabel}
          aria-haspopup="menu"
          onClick={() => void invoke('site:menu')}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 1.6l5 1.7v4.2c0 3-2 5.4-5 6.9-3-1.5-5-3.9-5-6.9V3.3z" />
          </svg>
          {tab.blockedRequests > 0 && (
            <span className="omnibox__blockerCount">{tab.blockedRequests}</span>
          )}
        </button>
      )}
    </form>
  )
}
