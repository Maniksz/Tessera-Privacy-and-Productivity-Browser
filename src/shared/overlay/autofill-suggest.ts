import type { Rect } from '../ui/anchor.js'
/*
  Type-only, and it has to stay that way. `fill-policy.ts` imports the public-suffix table, and this
  module is reachable from both renderers at runtime — a value import here would put four kilobytes of
  eTLD suffixes into a bundle that never consults one. See the bundle-weight fitness functions.
*/
import type { FillRefusal } from '../passwords/fill-policy.js'

/**
 * The account picker's payload on the overlay layer: what the `autofill-suggest` kind carries.
 *
 * ## Why it lives beside the overlay surface rather than in it
 *
 * The same reason `picker-bar.ts` does, and the precedent `omnibox/model.ts` set for the address bar's
 * list: the per-kind tables in `surface.ts` have to name every kind, but the *shape* of one kind's
 * payload is that kind's business. `surface.ts` imports it for its union and re-exports it, so callers
 * keep importing the overlay vocabulary from there.
 *
 * Zod-free and Electron-free, like everything both renderers import at runtime.
 */

/**
 * One saved credential, as the suggestion list is allowed to know it.
 *
 * An id and a username, and the absence of everything else is the point: this travels to a renderer
 * because the user pressed the badge, so it is the *only* place in this feature where names of saved
 * accounts leave the vault. No password, no address, no note, no date.
 */
export interface AutofillSuggestEntry {
  /** Opaque, and echoed back with the choice. Never a username used as a key. */
  id: string
  /** May be empty: some sites authenticate on a password alone, and the surface says so in words. */
  username: string
}

/**
 * What the list has to say, which on most presses of the badge is not a list.
 *
 * ## Why every refusal is a state here rather than an absent surface
 *
 * Pressing the badge has to produce a visible answer, and "nothing happened" is the answer a user
 * cannot tell apart from a broken browser. So the four ways there is nothing to offer are each a
 * value the surface can render a sentence for, instead of a reason the core silently declines to
 * present anything.
 *
 * `refused` carries the rule that said no rather than a translated sentence. The wording belongs in
 * the chrome's catalogue — it is a wordlist, and a wordlist in a presentation is a wordlist on the
 * wire — and the distinction between "this page is not encrypted" and "this is not the site the
 * password was saved for" is exactly what makes the refusal honest instead of "nothing found".
 */
export type AutofillSuggestContent =
  /** Never empty. An offer of nothing is `empty`, which reads as a sentence rather than as a blank box. */
  | { state: 'entries'; entries: AutofillSuggestEntry[] }
  /**
   * The vault is locked, and the surface offers to unlock it.
   *
   * Not the master-password prompt itself: that surface is raised by the user pressing *this* one's
   * button, which is an action in browser chrome. Raised straight from the badge it would be the
   * highest-ranked surface on this layer being summoned by a message from a page view.
   */
  | { state: 'locked' }
  /** Unlocked, the rules allow it, and there is nothing saved for this site. */
  | { state: 'empty' }
  /** A fill rule said no, and which one is what the surface turns into a sentence. */
  | { state: 'refused'; reason: FillRefusal }
  /** Autofill is switched off. The one state whose remedy is a setting rather than an action here. */
  | { state: 'disabled' }

/**
 * The account picker for one password field (R5).
 *
 * ## Why it is drawn here rather than in the page
 *
 * A list of the user's account names, drawn in the document, teaches the page which account the user
 * expects here — and a page that knows that can build its own mask to match. The list shows no
 * password either way, so the leak is not the secret; it is the *expectation*. Only the chrome can
 * draw a surface the page can neither read nor imitate into, which is the one step this browser can
 * take that a password-manager extension cannot.
 *
 * ## Why the request id and not a tab id
 *
 * The find bar carries a tab because every message it sends acts on that tab's document. This surface
 * sends exactly one thing back — a choice — and the core resolves the view from the request the badge
 * press opened. A tab id here would be a second name for the same thing, and the two disagree the
 * moment a tab is reassigned under an open list. The request id is also the whole of the consent that
 * authorises the fill (`shared/passwords/consent.ts`), so binding the surface to it is what makes a
 * choice unable to authorise anything but the press it came from.
 *
 * ## Why the bounds are here
 *
 * The tile-region reason, plus one this surface has alone: the rectangle depends on where a *field* is
 * inside a page, which is a fact only the core can assemble — the page reports CSS pixels, the tile
 * holds the zoom, the view holds its own bounds. See `shared/passwords/suggest-bounds.ts`, which is
 * where those four facts are turned into one rectangle, once.
 */
export interface AutofillSuggestPresentation {
  kind: 'autofill-suggest'
  /**
   * The fill request this list belongs to.
   *
   * Echoed back with the choice, for the rule every prompt on this layer follows: an answer may only
   * resolve the question it was shown for. Here it is stronger than elsewhere — the core spends this
   * id as one-shot consent, so a choice carrying a stale one authorises nothing at all rather than
   * filling the wrong form.
   */
  requestId: string
  /** The tile the field is in. Also its label: "passwords for tile 2" is what a screen reader reads. */
  tileIndex: number
  /** The list, in window coordinates — the bounds the layer takes while this is up. */
  bounds: Rect
  content: AutofillSuggestContent
}
