import { omniboxChoice, type OmniboxSuggestionsPresentation } from '@shared/omnibox/model.js'
import { invoke } from './bridge.js'

/**
 * Acts on row `index` of the address bar's list: an open tab is switched to over `tabs:activate`, every
 * other row is opened over `nav:navigate` (U18).
 *
 * Shared by the two renderers that can choose — the address bar on Enter, the overlay on `pointerdown` —
 * so a click and a key cannot do different things with one row. The core closes the list on either
 * (`BrowserWindowController.activateTab`, `navigateFromInput`); nothing here dismisses it.
 */
export function chooseSuggestion(
  presentation: Pick<OmniboxSuggestionsPresentation, 'text' | 'rows'>,
  index: number
): void {
  const choice = omniboxChoice(presentation, index)
  if ('tabId' in choice) void invoke('tabs:activate', { tabId: choice.tabId })
  else void invoke('nav:navigate', { input: choice.input })
}
