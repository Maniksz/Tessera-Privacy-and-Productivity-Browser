import { injectableDocumentUrl } from '@shared/filters/injection.js'
import { filteringExemptFor } from '@shared/filters/site-exemption.js'
import type { PickerAbortReason } from '@shared/filters/picker-session.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { registrableDomainOfUrl } from '@shared/url/domain.js'
import type { OverlayVacancyReason } from '../permissions/vacancy.js'

/**
 * The three questions the picker's wiring has to answer about the world, kept where a test can ask
 * them.
 *
 * `ElementPicker.ts` is on `vitest.config.ts`'s coverage exclude list, admitted there on the
 * understanding that what it decides lives somewhere reachable. The session itself went to
 * `shared/filters/picker-session.ts`; these three did not fit there, because each of them is about
 * something only the core can see — a browsing session's settings, an Electron navigation event, an
 * overlay layer's announcement — and none of them may be a branch in a file no test can enter.
 */

/** What a document is worth to a picker: whether a rule may be written here, and keyed on what. */
export interface PickableDocument {
  /**
   * The registrable domain a rule would be scoped to, or `null` for a document that has none.
   *
   * Read here rather than in the page, and never from a message: a rule keyed on a host a renderer
   * named would be a page choosing which site's rules it writes into.
   */
  readonly host: string | null
  /**
   * Whether a hiding rule would actually reach this document.
   *
   * Not merely "is this an http(s) page". A rule the cosmetic injector will not deliver is a rule
   * whose preview never appears and whose measurement always reports no effect, so the honest place
   * to say no is the entry rather than three steps later, dressed as a failure of the rule.
   */
  readonly filterable: boolean
}

/**
 * Whether the picker may start on this document, and what it would key a rule on (R19).
 *
 * One function, called by all three entries — the page's context menu, the keyboard route and the
 * blocker menu — because the failure R19 names is three entries with three opinions, two of which
 * are out of date. It is not itself the refusal: `pickerStep` is, and it takes these two answers as
 * its `host` and `filterable` so that the *wording* of a refusal is decided in the same exhaustive
 * place as every other outcome.
 *
 * ## Why the two blocker switches are conditions and the per-site exemption is too
 *
 * `CosmeticInjector` gates its host-specific answer on `privacy.blockerEnabled`,
 * `privacy.cosmeticFiltering` and the per-site exemption, and returns before any addition is
 * composed. So with any of the three against us, the preview cannot be delivered and neither can the
 * rule once it is written — the picker would highlight an element, promise to hide it, save a line,
 * and report that it changed nothing, every time. That is worse than being told at the outset that
 * filtering is off here.
 *
 * The per-site exemption deserves its own sentence because the blocker menu argues the other way for
 * *offering* the item: hiding one more thing on a site you have stopped filtering is a coherent wish,
 * and the rule would apply again the moment filtering came back. That argument survives — the item is
 * still offered — and it ends here, at the point where the promise would have to be kept. A rule
 * accepted now would be a rule that hides nothing until a switch nobody is looking at is flipped
 * back, and the whole subject of this work is a picker that stopped claiming to have done things.
 *
 * ## Why this never answers "no host" in practice
 *
 * `injectableDocumentUrl` admits only `http:` and `https:`, and a URL of either scheme always parses
 * with a hostname — so every document with no host to key a rule on is refused as unfilterable
 * *first*, which is the wording the session deliberately puts ahead of the other. `no-host` is
 * therefore the model's answer rather than a case this path reaches, and it is kept because the
 * model is the one place that gets to be exhaustive about the eight: a later entry that admitted
 * another scheme would find it waiting rather than have to invent it.
 */
export function pickableDocument(url: string, settings: SettingsSnapshot): PickableDocument {
  // The view's own address, which is all the core has here — the preload's report is for the
  // injector, where a `document-start` race makes the page the better authority. There is no race at
  // this moment: the user chose the picker for the page they are looking at.
  const documentUrl = injectableDocumentUrl(url, '')
  if (documentUrl === null) return { host: null, filterable: false }
  const filterable =
    settings['privacy.blockerEnabled'] &&
    settings['privacy.cosmeticFiltering'] &&
    !filteringExemptFor(documentUrl, settings['privacy.blockerOffForSites'])
  return { host: registrableDomainOfUrl(documentUrl), filterable }
}

/**
 * Which of R11's navigation events a `did-start-navigation` payload is, or `null` for none of them.
 *
 * Total over `unknown` like the wire guards, because the payload is an Electron event object whose
 * shape this project reads rather than declares — `endsFindSession` reads the same one the same way.
 *
 * Three distinctions, and only the first changes behaviour:
 *
 *   - **A subframe navigation is not one.** An advert refreshing itself inside its own iframe would
 *     otherwise end a session the user is in the middle of, and adverts do that on a timer.
 *   - `navigated` for a same-document move. R11 lists it separately because it is the one that used
 *     to be missed: the old picker cleared its state on `did-start-navigation` and a single-page
 *     application changing route never produced one that mattered, so the selection stayed frozen
 *     over an element that had gone (AE10).
 *   - `reloaded` when the address is the one already open. A label rather than a decision — every
 *     abort does the same thing — but a label that is wrong is worse than none, and "the page you
 *     were picking in reloaded" is the one a person can recognise.
 */
export function navigationAbortReason(
  payload: unknown,
  currentUrl: string
): PickerAbortReason | null {
  if (typeof payload !== 'object' || payload === null) return null
  const details = payload as { isMainFrame?: unknown; isSameDocument?: unknown; url?: unknown }
  if (details.isMainFrame !== true) return null
  if (details.isSameDocument === true) return 'navigated'
  return details.url === currentUrl ? 'reloaded' : 'document-changed'
}

/**
 * What a bar leaving the overlay layer means for the session behind it.
 *
 * Every way out of this surface arrives here, which is the arrangement `FindController` settled on
 * and for a stronger reason: a departed find bar strands a highlight, a departed picker bar strands a
 * provisional rule *injected into a live document* with nothing on screen to say so. The layer
 * announces all three of its reasons and none of them knows what a picking session is, so the mapping
 * is here.
 *
 * `dismissed` is the bar's own Cancel and everything shaped like it — a resize, a lost focus, a
 * layout change. It is reported as `cancelled` rather than being split further, because the session
 * does the same thing for all of them and a reason that guessed between them would be guessing.
 */
export function vacancyAbortReason(reason: OverlayVacancyReason): PickerAbortReason {
  switch (reason) {
    case 'dismissed':
      return 'cancelled'
    case 'replaced':
      return 'displaced'
    case 'gone':
      // The layer itself is gone: the window closed, or its surface renderer died. Either way there
      // is no bar to raise again, which is what `window-closed` means to the session.
      return 'window-closed'
  }
}
