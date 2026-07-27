import { translate, type Locale } from '@shared/i18n/catalog.js'
import type { FillChrome, SaveBarChrome } from '@shared/passwords/wire.js'

/**
 * How the suggestion list and the save bar look, and what they say.
 *
 * On this side of the boundary rather than in the preload, for the reasons `picker-chrome.ts`
 * gives and one more that matters here. The preload cannot read the i18n catalogue — importing it
 * would put every translation into a bundle parsed before every page in every tab — so the words
 * have to be sent. And a preload that carried this wording would carry the sentence "save the
 * password for …" into every renderer, including ones showing pages that have no form at all.
 *
 * The colours are literals rather than `var(--…)`, the one unavoidable duplication: this
 * stylesheet is injected into a *page*, where the browser's own custom properties do not exist.
 * Same values as `tokens.css`.
 *
 * ## Why the styles are defensive to the point of being tedious
 *
 * These elements live in the page's document, inside a closed shadow root. The shadow root stops
 * the page's own selectors reaching in, but inherited properties still cross it — a site with
 * `font-size: 0`, a `visibility: hidden` ancestor or a huge `line-height` on `html` would make
 * the bar unreadable or invisible. `all: initial` on the host and an explicit `font` shorthand put
 * every inherited value back to something known. An invisible consent bar is worse than none: the
 * user would be answering a question they cannot see.
 */

const SHARED_STYLES = `
  :host {
    all: initial;
    position: fixed;
    z-index: 2147483647;
  }
  * { box-sizing: border-box; }
  .panel {
    display: flex;
    flex-direction: column;
    max-width: min(92vw, 26rem);
    padding: 8px;
    border: 1px solid #34343a;
    border-radius: 10px;
    background: #202024;
    color: #e6e6ea;
    font: 13px/1.4 system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  }
  .title {
    padding: 2px 6px 6px;
    color: #8b8b96;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .entry {
    display: block;
    width: 100%;
    padding: 7px 8px;
    border: 0;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: default;
  }
  .entry:hover, .entry:focus-visible { background: #2c2c32; }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
    padding-top: 8px;
  }
  .action {
    padding: 6px 10px;
    border: 1px solid #34343a;
    border-radius: 6px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: default;
  }
  .action:hover, .action:focus-visible { border-color: #6da8ff; }
  .primary { border-color: #6da8ff; color: #6da8ff; }
  .message { padding: 2px 6px; }
  .who { padding: 4px 6px 0; color: #8b8b96; }
`

/**
 * The suggestion list's chrome, for one language and one site.
 *
 * The site is interpolated here rather than in the preload because the preload has no translator,
 * and because a heading assembled from fragments in the renderer is how a sentence ends up
 * ungrammatical in the language nobody on the team reads.
 */
export function fillChromeFor(locale: Locale, site: string): FillChrome {
  return {
    styles: SHARED_STYLES,
    title: translate(locale, 'passwords.fillTitle', { site }),
    noUsernameLabel: translate(locale, 'passwords.noUsername')
  }
}

/**
 * The save bar's chrome.
 *
 * `kind` decides the question, and the distinction is not cosmetic: "save the password for
 * example.com?" and "update the saved password for example.com?" have different consequences, and
 * a user who is told the first while the second is about to happen has been misinformed about
 * losing something.
 */
export function saveBarChromeFor(options: {
  locale: Locale
  kind: 'create' | 'update'
  site: string
  username: string
}): SaveBarChrome {
  const { locale, kind, site, username } = options
  return {
    styles: SHARED_STYLES,
    message: translate(
      locale,
      kind === 'create' ? 'passwords.savePrompt' : 'passwords.saveUpdatePrompt',
      { site }
    ),
    // Empty stays empty rather than becoming "(no username)": on the save bar the name is a fact
    // about what is being stored, and a placeholder there would read as the *value* being saved.
    username,
    saveLabel: translate(locale, 'passwords.saveAction'),
    neverLabel: translate(locale, 'passwords.neverAction'),
    dismissLabel: translate(locale, 'passwords.dismissAction')
  }
}
