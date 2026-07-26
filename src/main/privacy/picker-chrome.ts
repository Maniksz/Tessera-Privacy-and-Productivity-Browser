import { catalogs, type Locale } from '@shared/i18n/catalog.js'
import type { PickerChrome } from '@shared/filters/picker-wire.js'

/**
 * How the element picker looks and what it says.
 *
 * On this side of the boundary rather than in the preload, for two reasons that happen to point the same
 * way. The preload cannot read the i18n catalogue — importing it would put every translation into a bundle
 * that is parsed before every page in every tab — so the words have to be sent. And the preload's size
 * budget is the tightest in the project, so a stylesheet and eight sentences for a feature most pages never
 * use do not belong there either.
 *
 * The colours are literals rather than `var(--…)` references, and that is the one unavoidable duplication
 * here: this stylesheet is injected into a *page*, where the browser's own custom properties do not exist.
 * They are the same values as `tokens.css`, and an architecture test keeps the two in step.
 */

const PICKER_STYLES = `
  .box {
    position: fixed;
    z-index: 2147483647;
    pointer-events: none;
    border: 2px solid #6da8ff;
    background: rgba(109, 168, 255, 0.14);
    border-radius: 2px;
  }
  .bar {
    position: fixed;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    z-index: 2147483647;
    display: flex;
    align-items: center;
    gap: 10px;
    max-width: min(92vw, 60rem);
    padding: 10px 14px;
    border-radius: 10px;
    background: #202024;
    color: #e6e6ea;
    font: 13px/1.4 system-ui, sans-serif;
    box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
  }
  .selector {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: ui-monospace, monospace;
  }
  .hint { color: #8b8b96; }
  .warn { color: #ff8b6b; }
`

/**
 * Builds the picker's chrome for one language.
 *
 * The warning table is keyed by the `SelectorWarning` names the picker's own model defines, so a warning
 * added there without a sentence here shows its key rather than nothing — visible in testing, and never a
 * silently reassuring blank where a caveat belonged.
 */
export function pickerChromeFor(locale: Locale): PickerChrome {
  const t = catalogs[locale]
  return {
    styles: PICKER_STYLES,
    hint: t['picker.hint'],
    noRule: t['picker.noRule'],
    warnings: {
      'matches-ancestor': t['picker.warning.matchesAncestor'],
      'matches-many': t['picker.warning.matchesMany'],
      positional: t['picker.warning.positional'],
      'no-stable-feature': t['picker.warning.noStableFeature']
    }
  }
}
