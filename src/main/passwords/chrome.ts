import { translate, type Locale } from '@shared/i18n/catalog.js'
import type { BadgeChrome, SaveBarChrome } from '@shared/passwords/wire.js'

/**
 * How the badge and the save bar look, and what they say.
 *
 * The account picker used to be here too. It is drawn on the overlay layer now (R5), so its wording
 * left with it — a list of the user's own account names has no business being assembled in a module
 * whose output is injected into a page's document, and the sentence "saved for example.com" was the
 * last thing on this side that named a site to a page.
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

const HOST_STYLES = `
  :host {
    all: initial;
    position: fixed;
    z-index: 2147483647;
  }
  * { box-sizing: border-box; }
`

const SAVE_STYLES = `${HOST_STYLES}
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
 * The badge: a key, drawn as a background image, on a button with no text in it.
 *
 * An image rather than a character, and it is not a preference. A glyph would inherit the page's
 * font, and a site that ships an icon font — or sets `font-family` to something with no key in it —
 * would put an arbitrary shape of its own choosing on top of a password field. The path is ours, so
 * what appears is ours. It rides in the stylesheet rather than in markup so the preload carries
 * neither the icon nor a second string to put it in.
 *
 * `outline` on focus is not decoration either: the badge is reached by Tab from the field (KTD12),
 * and a route with no visible focus ring is no route at all. A page cannot reach in — the shadow
 * root is closed — but the value is stated here rather than left to be inherited from nothing.
 */
const BADGE_ICON =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='%23e6e6ea'><path d='M14 7a4 4 0 1 0-3.9 4L9 12.1V14H7v2H5v2H2v-3l6.1-6.1A4 4 0 0 0 14 7Zm1.5-1.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3Z'/></svg>\")"

const BADGE_STYLES = `${HOST_STYLES}
  .badge {
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    border-radius: 4px;
    background: #202024 ${BADGE_ICON} center / 76% no-repeat;
    cursor: default;
    opacity: 0.85;
  }
  .badge:hover { opacity: 1; }
  .badge:focus-visible { outline: 2px solid #6da8ff; outline-offset: 1px; opacity: 1; }
`

/**
 * The badge's chrome, for one language.
 *
 * No site, no count, no state of the vault: this is sent on a focus, which a page can cause at will,
 * so it has to be worthless when it fires a thousand times. What it costs the core is two strings.
 */
export function badgeChromeFor(locale: Locale): BadgeChrome {
  return { styles: BADGE_STYLES, label: translate(locale, 'passwords.fillBadge') }
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
    styles: SAVE_STYLES,
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
