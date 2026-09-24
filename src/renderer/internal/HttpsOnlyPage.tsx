import { useEffect, useMemo, useState } from 'react'
import { bundledI18n } from './bundled-i18n.js'
import { displayHost } from '@shared/url/idn.js'
import {
  BACK_URL,
  continueUrl,
  httpsVersionOf,
  interstitialTargetOf,
  interstitialTokenOf,
  withoutToken
} from '@shared/privacy/https-token.js'

/**
 * `tessera://https-only`: where HTTPS-only mode sends a top-level `http://` navigation (R7, KTD3).
 *
 * Served without privileges — it is not in `INTERNAL_PAGES`, or the navigation policy would refuse the
 * pipeline's redirect onto it and HTTPS-only would be off without a word. So it has no bridge, and every way
 * off it is a navigation:
 *
 * - **Try HTTPS** goes to the same address over `https:`, which any page could do.
 * - **Continue unencrypted** goes to the continue route with the token the core put in this page's address.
 *   The core stops that navigation and, if the token is this view's, loads the target *it* stored — not the
 *   `target` shown here, which a forged address could set to anything. Without a token the button is not
 *   offered at all: a page some site redirected here has nothing to redeem (AE1).
 * - **Go back** asks the core too, because with no history the way back is the start page, which page content
 *   may not navigate to.
 *
 * Each uses `location.replace`, so the one navigation the page completes itself — "Try HTTPS" — takes the
 * interstitial's place in the tab's history instead of stacking on it; the other two are stopped by the core
 * and carried out with a load of its own. The token leaves the visible address at once
 * (`history.replaceState`), read into memory first.
 */

/**
 * How long "Continue unencrypted" stays disabled.
 *
 * Long enough that a click or an Enter meant for the page that was loading does not land on the one button
 * that lowers protection; "Try HTTPS", which has the focus, is what an early keypress reaches.
 */
export const CONTINUE_DELAY_MS = 1000

export function HttpsOnlyPage(): React.ReactNode {
  // Once per document: the address says which language, and it does not change under a loaded page.
  const { locale, t } = useMemo(() => bundledI18n(), [])
  const [{ target, token }] = useState(() => ({
    target: interstitialTargetOf(location.href),
    token: interstitialTokenOf(location.href)
  }))
  const [continueReady, setContinueReady] = useState(false)

  const heading =
    target === null ? t('error.httpsOnly.noTarget') : t('error.httpsOnly', { host: hostOf(target) })

  useEffect(() => {
    if (token !== null) history.replaceState(history.state, '', withoutToken(location.href))
  }, [token])

  useEffect(() => {
    // The static markup says `lang="en"` and a placeholder title; both are the catalogue's to set.
    document.documentElement.lang = locale
    document.title = heading
  }, [locale, heading])

  useEffect(() => {
    if (token === null) return
    const timer = setTimeout(() => {
      setContinueReady(true)
    }, CONTINUE_DELAY_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [token])

  return (
    <main className="https-only">
      <h1 className="https-only__heading">{heading}</h1>
      <div className="https-only__actions">
        {target !== null && (
          <button
            type="button"
            className="https-only__button https-only__button--primary"
            autoFocus
            onClick={() => {
              location.replace(httpsVersionOf(target))
            }}
          >
            {t('error.httpsOnly.tryHttps')}
          </button>
        )}
        {target !== null && token !== null && (
          <button
            type="button"
            className="https-only__button"
            disabled={!continueReady}
            onClick={() => {
              location.replace(continueUrl(token))
            }}
          >
            {t('error.httpsOnly.continue')}
          </button>
        )}
        <button
          type="button"
          className="https-only__button"
          onClick={() => {
            location.replace(BACK_URL)
          }}
        >
          {t('error.httpsOnly.back')}
        </button>
      </div>
    </main>
  )
}

/** The host as the address bar would let a person read it, with its port when it has one. */
function hostOf(target: string): string {
  const { hostname, port } = new URL(target)
  const host = displayHost(hostname)
  return port === '' ? host : `${host}:${port}`
}
