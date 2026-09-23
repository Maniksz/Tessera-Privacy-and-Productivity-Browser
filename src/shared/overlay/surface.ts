import type { LayoutId } from '../split/layout.js'
import type { DropZone } from '../split/dropzones.js'
import type {
  MasterPasswordPromptProblem,
  MasterPasswordPurpose,
  MasterPasswordStep
} from '../passwords/prompt.js'
import type { Rect, Size } from '../ui/anchor.js'
import type { PermissionDevice, PermissionSubject } from './permission.js'
import type { PickerBarMode } from './picker-bar.js'

/**
 * What the chrome UI can put on the window's topmost layer.
 *
 * ## Why this exists at all
 *
 * Tab content is rendered by native views stacked *above* the window's own web contents.
 * Anything the toolbar draws into the content area is therefore painted behind the page
 * and receives no pointer events. That is not a z-index problem: the pixels have to be
 * produced by a layer above the views, and the only ways to get one are a native menu, a
 * separate window, or a view of our own. The overlay surface is that view.
 *
 * A menu opened from the toolbar used to be drawn in the chrome DOM, where roughly 190 of
 * its 190 pixels sat underneath the page. It looked right in a DOM snapshot and was
 * unusable with a mouse — see
 * `docs/solutions/ui-issues/chrome-popups-behind-content-views.md`.
 *
 * ## Why a presentation is data
 *
 * The chrome UI does not render the surface; it *describes* what should appear and where.
 * That keeps one rule in one place — the surface renderer never has to guess an anchor —
 * and it makes each kind's payload part of the typed IPC contract rather than an
 * agreement between two components.
 *
 * Zod-free so both renderers can import it at runtime.
 */

export const OVERLAY_KINDS = [
  'layout-menu',
  'tab-drop',
  'permission-request',
  'tile-bar',
  'find-bar',
  'master-password',
  'navigation-request',
  'picker-bar'
] as const

export type OverlayKind = (typeof OVERLAY_KINDS)[number]

/**
 * How much of the window a surface needs to own while it is up.
 *
 * `window` — the whole window, including the toolbar. Correct for menus: a click
 *   anywhere outside dismisses, which is what a menu is expected to do, and the surface
 *   can visually connect to the button that opened it.
 * `content` — the tile area only, leaving the toolbar and tab strip live. Needed by
 *   surfaces that appear *during* an interaction the chrome is still handling, such as
 *   dragging a tab out of the tab strip.
 */
export type OverlayWindowRegion = 'window' | 'content'

/**
 * `tile` — a rectangle inside one tile that the presentation itself names, and the only region
 *   whose rectangle cannot be derived from the window: which tile, and where in it, is known only
 *   to the surface being presented. See `overlayBounds`.
 */
export type OverlayRegion = OverlayWindowRegion | 'tile'

export const OVERLAY_REGION = {
  'layout-menu': 'window',
  /**
   * Only the tile area. The drag starts in the tab strip and the strip has to keep
   * receiving it — a surface over the whole window would swallow the gesture that opened
   * it and the tab could never be dropped back where it came from.
   */
  'tab-drop': 'content',
  /**
   * The whole window, like a menu, and for a stronger reason than a menu has.
   *
   * A permission prompt is modal to the tab that asked: while it is up, the answer is the
   * only thing the window is for. Sized to the tile area it would leave the toolbar live,
   * so the user could navigate away, change the layout or close the tab underneath a
   * dialogue that is still asking about a page that no longer exists — and each of those
   * would take the prompt down, which the safe default turns into a refusal of a request
   * the user was in the middle of answering.
   */
  'permission-request': 'window',
  /**
   * One tile's top strip, and nothing else in the window.
   *
   * The narrowest region any surface takes, because this is the only one that appears while the
   * user is *reading* rather than in the middle of a gesture. The layer swallows every pointer
   * event inside its bounds, so a bar sized to the content area would make four live pages
   * unclickable to reveal a control in one of them, and one sized to the window would take the
   * tab strip with it. A strip forty pixels tall costs the page the forty pixels it covers.
   */
  'tile-bar': 'tile',
  /**
   * A box in one tile's top-right corner, and nothing else in the window.
   *
   * The tile bar's reasoning, one step further. A find bar is up for as long as somebody is walking
   * through matches, so every pixel it covers is a pixel of the document they are searching — which
   * is why it is a corner rather than a strip; see `findBarBounds`. Sized to the window it would
   * make the other three pages unclickable while one of them was being searched.
   */
  'find-bar': 'tile',
  /**
   * The whole window, and this is the surface with the least room for argument about it.
   *
   * While the master password is being typed, the window is for that and nothing else. Sized to the
   * content area it would leave the toolbar and the tab strip live, so a click there would take the
   * prompt down mid-word — and a keystroke that arrived after the layer had lost focus would land in
   * the address bar, which is to say part of somebody's master password would appear in the omnibox
   * and then in its history. The full region is what makes that unreachable rather than unlikely.
   */
  'master-password': 'window',
  /**
   * The whole window, on the permission prompt's reasoning rather than the find bar's.
   *
   * This is a question about where the browser is going, and while it is up the answer is the only thing
   * the window is for. Sized to the content area it would leave the toolbar live, so the user could
   * navigate away or close the tab underneath a dialogue asking about a page that no longer exists — and
   * each of those takes the prompt down, which the safe default turns into a refusal of something the
   * user was in the middle of allowing.
   */
  'navigation-request': 'window',
  /**
   * A box in the corner of the tile being picked in, and nothing else in the window.
   *
   * The find bar's region for the find bar's reason, with one addition of its own. While this bar is up a
   * provisional rule is hiding something in the page behind it, and the point of the whole exercise is
   * that the user can *look at the page* and decide whether the right thing disappeared. A surface over
   * the content area would cover the evidence it exists to present; a surface over the window would take
   * the toolbar and the tab strip with it, in a mode the user is expected to sit in for a moment.
   *
   * Which tile it belongs to is known only to the session that raised it, so the rectangle travels with
   * the presentation; see `pickerBarBounds` and `overlayBounds`.
   */
  'picker-bar': 'tile'
} as const satisfies Record<OverlayKind, OverlayRegion>

/** The layout menu carries the current layout so it can render its radio state at once. */
export interface LayoutMenuPresentation {
  kind: 'layout-menu'
  /** The button's rect in window coordinates. */
  anchor: Rect
  current: LayoutId
}

/**
 * A tab being dragged, with every place it could land.
 *
 * Rectangles are relative to the overlay's own bounds — the content area — because that is
 * the coordinate space the surface renders in. Converting once in the core beats every
 * component doing its own arithmetic against an inset it has to be told about.
 */
export interface TabDropPresentation {
  kind: 'tab-drop'
  /**
   * Where the overlay's own bounds sit in window space.
   *
   * The surface needs it to report pointer positions: the core reasons in window
   * coordinates, and a surface inset below the toolbar sees its own origin as (0, 0). One
   * offset carried with the presentation beats telling the surface about the chrome inset
   * through a second channel it would then have to keep in sync.
   */
  origin: { x: number; y: number }
  zones: DropZone[]
  /** The zone the pointer is currently over, or null while it is outside the tile area. */
  activeZoneId: string | null
  /** Title of the dragged tab, so the indicator can name what is being moved. */
  title: string
}

/**
 * A page asking for the camera, the microphone, its location or anything else that needs a
 * person's consent (spec 4).
 *
 * Everything the dialogue renders is here, and that is the point: the surface must not have to
 * ask a second channel who is asking or what for. A prompt that appeared before its own text
 * arrived would be a dialogue about nothing, and the one thing a consent dialogue may never do is
 * present a button before it can say what the button agrees to.
 */
export interface PermissionRequestPresentation {
  kind: 'permission-request'
  /**
   * The request this dialogue is asking about.
   *
   * Echoed back with the answer so a reply can only ever resolve the question it was shown
   * for. Without it, a click that landed while the surface was being replaced by the next
   * queued prompt would answer the *new* request — the user consenting to one thing and
   * granting another.
   */
  requestId: string
  /**
   * The site asking, as an origin.
   *
   * Never empty. A request whose origin cannot be established is refused rather than shown,
   * because "something wants your camera" is not a question anybody can answer.
   */
  origin: string
  subject: PermissionSubject
  /**
   * The devices this request would reach, so the dialogue can name them individually.
   *
   * Empty for everything that is not a media request. Carried rather than derived in the
   * renderer because the core already knows, and two derivations of one fact eventually
   * disagree.
   */
  devices: PermissionDevice[]
  /**
   * How many further requests are queued behind this one.
   *
   * Shown, not hidden: a person who is about to answer three prompts should be told before the
   * first one, or the second looks like the first one failing to close.
   */
  waiting: number
}

/**
 * Why a surface came up, for the surfaces where it changes what they do.
 *
 * `pointer` — the user reached for it with the mouse and is looking at something else. Such a
 *   surface must not take the keyboard: focus would leave the page mid-sentence because the
 *   pointer drifted near an edge.
 * `keyboard` — the user asked for it by key, so focus moving into it *is* the request.
 */
export type OverlayInvocation = 'pointer' | 'keyboard'

/**
 * The navigation bar of one tile: back, forward, reload, and that tile's address (spec 2).
 *
 * ## Why the tab is named in the presentation
 *
 * Every control here acts on `tabId`, never on "the active tab". In a split layout the toolbar
 * already acts on the active tile, and a second set of buttons that did the same would be worse
 * than none: the user would press back on the tile they are looking at and watch a different one
 * navigate. So the tab is decided once, in the core, at the moment the bar is built — and it
 * travels with the bar rather than being resolved again when a button is pressed, which is the
 * version that goes wrong when the active tile changes under an open bar.
 *
 * ## Why the bounds are here and not derived from the region
 *
 * This is the one surface whose rectangle depends on *which* tile it belongs to, so the region
 * alone cannot produce it. The core computes the strip with the same function that positions the
 * tile views (`tileBarBounds`), which is what keeps the bar from ever covering a neighbour.
 */
export interface TileBarPresentation {
  kind: 'tile-bar'
  /** The tile this bar belongs to. Also its label: "tile 2" is what a screen reader reads. */
  tileIndex: number
  /** The strip, in window coordinates — the bounds the layer takes while this is up. */
  bounds: Rect
  /**
   * The tab the buttons act on.
   *
   * Never empty: a tile with no tab gets no bar at all, because there is nothing for back,
   * forward or an address to mean.
   */
  tabId: string
  url: string
  canGoBack: boolean
  canGoForward: boolean
  /** Turns the reload button into stop, exactly as the toolbar's does. */
  loading: boolean
  /**
   * This pane's zoom, resolved: what it shows at, and whether that is its own choice.
   *
   * On the bar rather than only in the toolbar, because zoom is per pane and the toolbar has one of
   * itself. Reported as *"es gibt den zoom button nicht per kachel individuell in dessen overlay"* —
   * and it is the tile bar that already names a tab, so it is the only surface where a zoom control
   * can act on the pane the user is pointing at rather than on whichever one is active.
   */
  zoomPercent: number
  /** False for a pane still following `appearance.defaultZoom`; see `PaneZoom`. */
  zoomed: boolean
  invokedBy: OverlayInvocation
}

/**
 * Find in page for one tile (Ctrl+F, spec 9).
 *
 * ## Why the tab is named here too, and why that is not the same reason as the tile bar's
 *
 * A tile bar names its tab so its buttons cannot navigate a neighbour. A find bar names its tab
 * because the *search itself* belongs to one document: Chromium keeps the find state per page, the
 * highlight is on that page, and stopping the session on the wrong one leaves the right one marked.
 * So the tab is fixed when the bar opens and travels with every message the bar sends — the active
 * tile may well change while somebody is typing into it, and a query resolved against "whatever is
 * active" would search a page they are not looking at and highlight it there.
 *
 * ## Why the counts are in the presentation rather than on a channel of their own
 *
 * The core owns what is on screen, here as everywhere else on this layer, so the bar renders a count
 * it was given instead of one it accumulated. The cost is that the presentation is re-sent as
 * results arrive, and that is what `sessionId` is for: it changes when the bar opens and never as
 * counts arrive, so the surface can re-focus its field for a new search and leave the caret alone
 * for the tenth result of the current one.
 */
export interface FindBarPresentation {
  kind: 'find-bar'
  /**
   * Identity of the search, not of the bar.
   *
   * Two jobs, both load-bearing. The surface keys its focus-and-select effect on it, exactly as the
   * permission dialogue keys on `requestId`; and the core finds the session a departed bar belonged
   * to by it, which is how a bar the layer took down for reasons of its own still gets its highlight
   * cleared.
   */
  sessionId: string
  /** The tile searched. Also its label: "find in tile 2" is what a screen reader reads. */
  tileIndex: number
  /** The box, in window coordinates — the bounds the layer takes while this is up. */
  bounds: Rect
  /** The tab searched. Never empty: there is no find bar without a page to find in. */
  tabId: string
  query: string
  /**
   * Matches found, or `null` while the page has not answered yet.
   *
   * `null` rather than `0`, and the distinction is the whole difference between a bar that counts
   * and a bar that flickers: a search in flight rendered as zero announces "no matches" on every
   * keystroke and corrects itself a moment later.
   */
  matches: number | null
  /** One-based position of the highlighted match; `0` when nothing is highlighted. */
  activeMatch: number
}

/**
 * The master password, being asked for (see `shared/passwords/prompt.ts`).
 *
 * ## Why this presentation has no value in it
 *
 * There is no field here for what the user has typed, in either direction, and that absence is the
 * feature. The characters live in the main process — captured from the input pipeline before this
 * layer's renderer sees them, see `capturesKeyboard` — so the only thing the surface is told is *how
 * many* there are, and the only thing it draws is that many bullets. A renderer that never holds the
 * master password cannot be the way it escapes, and no channel has to be trusted not to carry it.
 *
 * The cost of that is real and is stated in `prompt.ts`: this is a hand-driven field, so there is no
 * IME and no caret. It is not a cost this presentation can hide, which is why the surface says what
 * keys do.
 *
 * ## Why the problem travels with the question
 *
 * A refused attempt re-presents the same surface with `problem` set rather than opening a second
 * one, exactly as a permission prompt re-presents with a new `waiting` count. `surfaceIdentity` keys
 * on `requestId`, so that is an update and not a departure — which matters more here than anywhere
 * else on this layer, because a departure of this surface settles the request as cancelled.
 */
export interface MasterPasswordPresentation {
  kind: 'master-password'
  /**
   * Identity of the question.
   *
   * Echoed back with a click on Continue or Cancel, for the reason `PermissionRequestPresentation`
   * gives: an answer must only ever be able to resolve the question it was shown for. It is also how
   * the core finds the pending request a departed prompt belonged to.
   */
  requestId: string
  purpose: MasterPasswordPurpose
  /** Which question of the sequence is on screen. One at a time; see `MASTER_PASSWORD_STEPS`. */
  step: MasterPasswordStep
  /**
   * How many characters have been typed, so the field can draw that many bullets.
   *
   * A count and not the text. This is the whole of what the renderer is allowed to know about the
   * secret being entered into it.
   */
  filled: number
  /** Why the previous attempt was refused, or null. Never the candidate. */
  problem: MasterPasswordPromptProblem | null
  /** The length floor, so the rule can be stated before it is broken rather than after. */
  minLength: number
}

/**
 * A page tried to open a tab, or to send itself somewhere else, and nothing the user did explains it.
 *
 * Everything the dialogue says comes from here, for the reason the permission prompt gives: a prompt that
 * appeared before its own text arrived would be a dialogue about nothing, and this one has to name the
 * address before it offers a button that goes there.
 */
export interface NavigationRequestPresentation {
  kind: 'navigation-request'
  /**
   * Identity of the question, echoed back with the answer.
   *
   * The same rule as every other prompt on this layer: a reply may only resolve the question it was shown
   * for, or a click that landed while the surface was being replaced would answer a different one.
   */
  requestId: string
  /** Whether a new tab was asked for, or the tab moving itself. The dialogue says which. */
  navigationKind: 'popup' | 'navigation'
  /**
   * Where the page wants to go, in full.
   *
   * In full, and not shortened. This is the one fact the answer depends on, and a truncated address is
   * how a user is persuaded that `evil.test/paypal.com` is PayPal. The surface elides it visually if it
   * has to; the value is the whole thing.
   */
  url: string
  /** The host of that address, so the dialogue can lead with the part that decides the answer. */
  host: string
}

/**
 * "Block this element": what has been chosen, what it would hide, and what became of it.
 *
 * ## Why the result appears here rather than in the page
 *
 * The picker used to draw its own bar into the document it was picking in, and that is the reason a
 * click could fail five different ways without anybody finding out: the surface that would have carried
 * the news tore itself down in the same breath as the message that asked for the rule. It also cannot
 * work everywhere it is needed — a document that carries no picker surface at all is exactly the kind
 * of document a refusal has to be reported on.
 *
 * So the news arrives on the window's own layer, where the browser can always speak, and the page is
 * left to do the one thing only it can do: show what disappeared.
 *
 * ## Why the whole visible state is one message
 *
 * The bar holds no opinion of its own. Every field below is the core's answer to "what should be on
 * screen right now", and the surface renders it — the find bar's rule, for the find bar's reason: two
 * places accumulating the same state eventually disagree, and the one that is wrong is always the one
 * the user is looking at. The cost is that the presentation is re-sent as the selection is refined and
 * as measurements arrive, which is what `sessionId` is for; see `surfaceIdentity`.
 */
export interface PickerBarPresentation {
  kind: 'picker-bar'
  /**
   * Identity of the *picking session*, not of the bar.
   *
   * Two jobs, both load-bearing, and both taken from the find bar. The layer tells an update from a
   * departure by it, so a new match count does not read as the bar leaving — which here would end the
   * session the moment it had something to report. And the session that owns a departed bar is found by
   * it, which is how a bar the layer took down for reasons of its own still gets its provisional rule
   * lifted off the page.
   */
  sessionId: string
  /** The tile picked in. Also its label: "block an element in tile 2" is what a screen reader reads. */
  tileIndex: number
  /** The box, in window coordinates — the bounds the layer takes while this is up. */
  bounds: Rect
  /** The tab picked in. Never empty: there is no picker session without a document to pick in. */
  tabId: string
  mode: PickerBarMode
  /**
   * The selector that would be written, in the form the user is being asked to accept.
   *
   * Shown at every stage rather than only once frozen: a person cannot judge "wider" and "narrower"
   * without seeing what changed, and a confirmation that hides what it confirms is not one.
   */
  selector: string
  /**
   * How many elements the selector hits in the open document, or `null` while nothing has been measured.
   *
   * `null` rather than `0`, and the difference is the whole point of measuring at all: zero means "this
   * rule changes nothing here", which is a real and reportable finding, while "not yet counted" is the
   * absence of a finding. Collapsed into one value, a measurement in flight would announce the finding
   * before it was made.
   */
  matches: number | null
  /**
   * Whether the selection can still be pulled outwards, and inwards.
   *
   * Carried rather than left for the surface to guess, because the core is the only side that holds the
   * ancestor chain — and because a control that silently does nothing at the end of the chain is the
   * defect this feature is being rebuilt to remove, reproduced in miniature. `canWiden` is false once the
   * selection has reached the outermost element the chain allows, which stops below `body`: a step past
   * that selects the document itself, and a rule for it empties the page.
   */
  canWiden: boolean
  canNarrow: boolean
  /**
   * What became of the attempt, as a key, or `null` while it is still going on.
   *
   * A key rather than a sentence: the sentence is looked up in `text` below, under `outcome.${outcome}`.
   * A key rather than an enum declared here, too, and that is deliberate — the set of outcomes belongs to
   * the picking session, which is where they are produced and where they are held to being exhaustive.
   * Two lists of the same eight names in two modules is how a ninth outcome comes to render as nothing at
   * all; the surface renders the key itself if it does not recognise it, which is a name on screen
   * instead of an empty bar.
   */
  outcome: string | null
  /**
   * Whether there is a written rule to take back.
   *
   * The one thing about an outcome the bar cannot work out from an opaque key, and the difference
   * matters: "already there, disabled" and "saved but it changes nothing here" both name a rule that
   * exists, while "no host" and "limit reached" name one that was never written. Offering Undo for the
   * second pair would be a button that removes something the user never added.
   */
  canUndo: boolean
  /**
   * Every word the bar can say, already in the language the interface is in.
   *
   * The core's, like every other field here: the prose lives in `main/privacy/picker-bar-text.ts` rather
   * than in the renderer's catalogue, and that module says why — the catalogue is one measured chunk that
   * every renderer parses, and only this surface ever shows these sentences. The whole table travels,
   * not just the sentence the current mode needs, so the surface still chooses which one a mode says and
   * still resolves an outcome by its key.
   *
   * A record of strings rather than a type naming each key, on the precedent of `userrules:list`: a word
   * missing from it renders as its own key, which is a name on screen rather than an unlabelled button.
   * `{index}` and `{count}` arrive as placeholders and are filled in by the surface.
   */
  text: Readonly<Record<string, string>>
}

export type OverlayPresentation =
  | LayoutMenuPresentation
  | TabDropPresentation
  | PermissionRequestPresentation
  | TileBarPresentation
  | FindBarPresentation
  | MasterPasswordPresentation
  | NavigationRequestPresentation
  | PickerBarPresentation

/** Nothing presented is a first-class state, not an absent one. */
export type OverlayState = OverlayPresentation | null

/**
 * Whether something is waiting on this surface for an answer.
 *
 * The distinction is not cosmetic. A menu that disappears because the window was resized has
 * cost nobody anything; a permission prompt that disappears leaves a page holding a promise that
 * will never settle — `getUserMedia` never resolves, never rejects, and the site simply hangs.
 *
 * So the layer reports every departure of a surface that is marked here, and whoever is waiting
 * settles it the safe way: refused. Marked as data next to the regions rather than as a check
 * inside the layer, for the same reason the regions are — `satisfies` makes a new kind that
 * forgot to answer the question a build failure.
 */
export const OVERLAY_AWAITS_ANSWER = {
  'layout-menu': false,
  'tab-drop': false,
  'permission-request': true,
  /** Nothing is pending on a navigation bar: it goes, and the page it belonged to is unaffected. */
  'tile-bar': false,
  /**
   * Nothing is *waiting* on a find bar either — but its departure is not free; see
   * `OVERLAY_MARKS_THE_PAGE`. The two facts are kept apart because they are different: one is a
   * promise nobody will settle, the other a mark left on a document.
   */
  'find-bar': false,
  /**
   * Somebody invoked `passwords:requestUnlock` and is holding a promise for one of four words.
   *
   * The same shape of debt as a permission prompt and a different safe answer: a vanished consent
   * dialogue means "no", a vanished password prompt means `cancelled`. Refusing would be wrong here —
   * `wrong-password` is what the page renders as "that was not it", and a window resize is not the
   * user getting their own master password wrong.
   */
  'master-password': true,
  /**
   * A page is waiting to find out whether it may open a tab or leave the page.
   *
   * Awaiting in the same sense as a permission prompt and with a stronger safe answer: nothing in the
   * page is holding a promise — a popup that does not open simply does not — so a vanished dialogue
   * refuses, and refusing is also exactly what was asked for. *"Sonst bleiben wir auf der seite."*
   */
  'navigation-request': true,
  /**
   * Nothing is holding a promise for a picked element, and that is worth stating rather than assuming.
   *
   * The bar does ask a question — confirm or discard — but nobody is *blocked* on the answer: no page
   * call is pending, and a session that ends without one has written nothing, which is the state the
   * user was in before they started. What its departure does cost is a provisional rule left in a
   * document; that is the other table.
   */
  'picker-bar': false
} as const satisfies Record<OverlayKind, boolean>

export function awaitsAnswer(presentation: OverlayPresentation): boolean {
  return OVERLAY_AWAITS_ANSWER[presentation.kind]
}

/**
 * Whether this surface has changed something *on a page* that its departure has to undo.
 *
 * ## The failure this exists to prevent
 *
 * `webContents.findInPage` highlights its match in the document, and only `stopFindInPage` takes
 * that highlight off. So a find bar is the first surface on this layer whose disappearance leaves a
 * visible mark somewhere else — and the layer is taken down constantly by things that know nothing
 * about what was on it: a window resize, losing focus, a layout change, a permission prompt
 * claiming the layer, the surface's own renderer crashing. Every one of those would otherwise leave
 * a block of highlighted text on the page with nothing on screen to explain it and no way to get
 * rid of it short of clicking somewhere.
 *
 * That is the same *shape* of problem as an unanswered permission prompt, so it uses the same
 * mechanism — the layer announces the departure and whoever owns the consequence undoes it. It is
 * not the same *fact*, which is why it is a second table rather than a widened first one: nothing is
 * waiting on a find bar for an answer, and a future surface could easily have one property without
 * the other.
 */
export const OVERLAY_MARKS_THE_PAGE = {
  'layout-menu': false,
  'tab-drop': false,
  /** A dialogue over a page changes nothing in it. */
  'permission-request': false,
  'tile-bar': false,
  'find-bar': true,
  /** A dialogue over a page changes nothing in it, and this one does not even read it. */
  'master-password': false,
  /** Nothing is written into the page: the navigation was stopped before it started. */
  'navigation-request': false,
  /**
   * The strongest case on this table, and the reason it is a table rather than a find-bar special case.
   *
   * A find bar leaves a highlight behind. This one leaves *a provisional rule injected into the
   * document* and an outline around an element — so a bar taken down by a resize, a lost focus or a
   * consent dialogue would leave part of a page hidden by a rule that was never saved, with nothing on
   * screen to say what happened or how to get it back, and nothing on disk to remove. Announced, the
   * session lifts the preview at the one place it is lifted from.
   */
  'picker-bar': true
} as const satisfies Record<OverlayKind, boolean>

export function marksThePage(presentation: OverlayPresentation): boolean {
  return OVERLAY_MARKS_THE_PAGE[presentation.kind]
}

/**
 * Whether the layer has to say that this surface left.
 *
 * The one question `OverlayLayer` asks, so that the layer itself needs to know neither about
 * permissions nor about find sessions — only that *somebody* has to be told. Two reasons, either of
 * which is enough, and keeping them separate is what stops the answer from becoming folklore: a
 * departure that strands a page's promise, and a departure that strands a highlight.
 */
export function departureMatters(presentation: OverlayPresentation): boolean {
  if (awaitsAnswer(presentation)) return true
  return marksThePage(presentation)
}

/**
 * A stable name for *which* surface a presentation is, not merely which kind.
 *
 * ## The defect this exists to fix
 *
 * `present` is `replace`, and a replaced surface whose departure matters is announced as vacated.
 * But the layer is also how a surface is *updated*: a permission prompt is re-presented when the
 * number of prompts queued behind it changes, and a find bar is re-presented every time the page
 * reports a new match count. Those went through the same path as a genuine replacement, so the
 * announcement fired for a surface that had not left at all — the arbiter settled the prompt on
 * screen as refused the moment a second request queued behind it, and a find bar would have cleared
 * its own highlight on its first result.
 *
 * So the layer compares identities rather than kinds: same surface means an update, and an update is
 * not a departure. An exhaustive switch rather than a table, because two of the five kinds have an
 * identity of their own and three are singletons — a menu, a drag and a tile's bar can each only be
 * one thing at a time on one layer.
 */
export function surfaceIdentity(presentation: OverlayPresentation): string {
  switch (presentation.kind) {
    case 'layout-menu':
    case 'tab-drop':
      return presentation.kind
    case 'permission-request':
      return `permission-request:${presentation.requestId}`
    case 'tile-bar':
      return `tile-bar:${presentation.tileIndex}`
    case 'find-bar':
      return `find-bar:${presentation.sessionId}`
    case 'master-password':
      return `master-password:${presentation.requestId}`
    case 'navigation-request':
      return `navigation-request:${presentation.requestId}`
    /*
      By session, and never by kind. The bar is re-presented on every step of the picking — a click that
      freezes the selection, a widening, an arriving match count, the outcome — and keyed by kind alone
      each of those would read as a departure, which for this surface means "lift the preview and end the
      session". The bar would take itself down the moment it had something to report.
    */
    case 'picker-bar':
      return `picker-bar:${presentation.sessionId}`
  }
}

/**
 * Whether the *core* takes this surface's keystrokes instead of letting its renderer have them.
 *
 * ## The failure this table prevents
 *
 * One surface on this layer is a password field, and the password it collects is the one whose loss
 * costs every other one. A normal field would put it in the overlay renderer's DOM, and there is no
 * version of that which is safe enough: it would then have to travel back over a channel, and a
 * channel that carries a master password is a channel a compromised renderer can be made to answer
 * on — while the guarantee this feature is sold on is that no such channel exists.
 *
 * So for this one kind the layer intercepts every keystroke in the main process and **does not pass
 * it on**. The renderer draws a count of bullets it was given and never sees a character. The other
 * five kinds must not be treated that way: a find bar is a real text field, and taking its keys in
 * the core would mean hand-implementing text editing for a search box.
 *
 * A table rather than a check inside the layer, for the reason the regions are: `satisfies` makes a
 * seventh kind that nobody considered a build failure rather than a surface that quietly loses every
 * keystroke — or quietly keeps one it should not have.
 */
export const OVERLAY_CAPTURES_KEYBOARD = {
  'layout-menu': false,
  'tab-drop': false,
  /** Its buttons are reached by Tab and answered by Return, in the renderer, as a dialogue should be. */
  'permission-request': false,
  'tile-bar': false,
  /** A real text field with a real caret; see the docblock above. */
  'find-bar': false,
  'master-password': true,
  /** Two buttons, reached by Tab and answered by Return, in the renderer — as a dialogue should be. */
  'navigation-request': false,
  /**
   * Its keys are its own, because none of them is a secret and all of them are ordinary controls.
   *
   * Up and down widen and narrow the selection, Return confirms, Escape cancels — four keys that map
   * onto buttons the bar already draws. Taking them in the core would mean the main process
   * hand-implementing the keyboard half of a surface whose mouse half the renderer implements anyway,
   * for no gain: there is nothing here that must never reach a renderer, and the renderer is already
   * being told the selector.
   */
  'picker-bar': false
} as const satisfies Record<OverlayKind, boolean>

export function capturesKeyboard(presentation: OverlayPresentation): boolean {
  return OVERLAY_CAPTURES_KEYBOARD[presentation.kind]
}

/**
 * Who wins when two things want the one layer.
 *
 * ## The failure this table prevents
 *
 * There is one overlay layer per window and it shows one surface at a time, so presenting is
 * really *replacing* — and a replaced surface that something was waiting on is reported as
 * vacated, which for a permission prompt means the page's request is refused (see
 * `OVERLAY_AWAITS_ANSWER` and `permissions/vacancy.ts`). Before the tile bar arrived, every
 * claim on the layer came from a deliberate act: clicking a button, starting a drag, a page
 * asking for the camera. The tile bar is the first one that comes from *drifting a mouse near an
 * edge*. Without a rule, moving the pointer to the top of a tile would silently deny a camera
 * request the user was reading — the browser answering a consent dialogue on the user's behalf
 * because their hand moved.
 *
 * ## The rule
 *
 * Higher number wins; equal replaces. Concretely:
 *
 *  - **A permission prompt outranks everything.** It cannot be displaced by a hover, and it
 *    cannot be displaced by a keyboard-invoked tile bar either. While a prompt is up, the window
 *    is for answering it; the shortcut is simply declined and the prompt keeps the layer.
 *  - **The tile bar outranks nothing.** It is presented onto a free layer or not at all, and
 *    anything else may take the layer from it — nothing is waiting on a bar, so displacing it
 *    costs a redraw and no correctness.
 *  - **The find bar sits between the tile bar and the deliberate surfaces**, which is the one rank
 *    that had to be argued rather than read off. It holds something the user typed, so displacing it
 *    costs more than a redraw — and a *hovered* tile bar must never be what destroys it: the query
 *    would vanish because a hand moved towards a tile's top edge, which is the same accident the
 *    prompt is protected from, one rank down. But it yields to a menu and to a tab drag, because
 *    both of those cannot function without the layer: a drag with no drop indicator is a drop
 *    landing blind. Losing a search term to a gesture the user deliberately started is a fair
 *    trade; the term comes back, because the core remembers it and the shortcut restores it.
 *  - **The master-password prompt outranks even a permission prompt**, and it is the only surface
 *    that does. Both await an answer, so displacing either costs something real, and the question is
 *    which cost is worse — the two directions are not symmetrical:
 *
 *    A camera prompt displacing a vault prompt would destroy a half-typed master password *and* aim
 *    the rest of it at a consent dialogue: the layer takes this surface's keystrokes in the core (see
 *    `capturesKeyboard`), so the moment something else holds the layer the remaining characters
 *    become ordinary keys in a renderer — where Return is a button. A page can cause a camera request
 *    at any moment, so that path lets a *page* choose when to interrupt somebody typing their master
 *    password, and lands their next keystroke on "Allow". That is the worst outcome available on this
 *    layer.
 *
 *    The other direction costs the page a refused request, which is the safe default it already gets
 *    for a dismissal, a resize or a lost focus. A person who deliberately asked to unlock their vault
 *    wins over a request nobody asked for; the page may ask again.
 *
 *    It cannot be claimed by drifting a pointer or by a page: it exists only because somebody pressed
 *    Unlock or chose a master-password action, which is why giving it the top rank grants nothing to
 *    anything untrusted.
 *  - **Equal replaces**, which is what makes the next queued prompt able to follow the one just
 *    answered, what lets a tile bar move from one tile to the next, what lets a find bar update
 *    its own match count, and what lets this prompt redraw its bullet count on every keystroke.
 *
 * Data rather than a chain of `if`s inside the layer, and `satisfies` rather than a lookup with a
 * fallback: a seventh kind that nobody ranked is a build failure instead of a surface that silently
 * displaces a consent dialogue.
 */
export const OVERLAY_PRECEDENCE = {
  'tile-bar': 0,
  'find-bar': 1,
  /**
   * Level with the find bar, and the tie is the answer to a question the plan left open rather than an
   * oversight: which of the two wins when a picking session and a search want the same tile.
   *
   * The rank itself is the find bar's argument applied unchanged. Both hold something a person built —
   * a typed term, a chosen element — so neither may be destroyed by a *hovered* tile bar, which is the
   * one claim on this layer that nobody makes on purpose. And both yield to a menu, to a tab drag and to
   * every dialogue above them, because those cannot function without the layer at all.
   *
   * Between the two of them, equal replaces, which means the most recent deliberate request wins. That
   * is the right answer in both directions here and it is the only one that is symmetrical: pressing
   * Ctrl+F during a pick and starting a pick during a search are the same act, and neither loses
   * anything that cannot be had again — the search term is remembered by the core, and a displaced
   * picking session lifts its preview and leaves the page exactly as it was found.
   */
  'picker-bar': 1,
  'layout-menu': 2,
  'tab-drop': 2,
  'permission-request': 3,
  /**
   * Ranked with the permission prompt, and the tie is the decision rather than an omission.
   *
   * Both await an answer that a person has to give, and neither may be displaced by a hover or by a
   * find bar. Between the two of them, *equal replaces* — which is right in both directions here: a page
   * that gets a camera prompt in front of a pending popup question has not gained anything (the popup is
   * refused, which is the safe default it already gets from a dismissal), and neither can be summoned to
   * destroy half-typed input, because neither collects any.
   *
   * Below `master-password` for the reason given at length above: nothing a page can cause may interrupt
   * somebody typing their master password, and a page can cause this one at any moment.
   */
  'navigation-request': 3,
  'master-password': 4
} as const satisfies Record<OverlayKind, number>

/** Whether `incoming` may take the layer from whatever is on it. */
export function mayPresentOver(incoming: OverlayKind, current: OverlayState): boolean {
  if (current === null) return true
  return OVERLAY_PRECEDENCE[incoming] >= OVERLAY_PRECEDENCE[current.kind]
}

/**
 * Whether presenting this surface should move the keyboard into it.
 *
 * Five of the six kinds always should: each is the direct result of the user asking for it, and
 * a menu or a dialogue that did not take the keyboard would be unusable without a mouse (spec 7).
 * The find bar is the strongest case of all — it is a text field, reached only by shortcut, and its
 * entire purpose is to receive typing. A find bar that did not take focus would be a search box you
 * cannot type in.
 *
 * The master-password prompt needs it for a reason of its own, and needs it absolutely: the core reads
 * its keystrokes off *this view's* input pipeline (`capturesKeyboard`), which only ever carries them
 * while this view has the keyboard. Without focus the prompt would draw a field that swallows nothing
 * and count zero bullets for ever, while the characters went to whatever did have focus.
 *
 * The picker's confirmation bar needs it because the keyboard is half of what it offers: up and down
 * widen and narrow the selection, Return confirms, Escape cancels. A bar that did not hold the focus
 * would advertise those four keys and receive none of them — they would go to the page underneath,
 * where Return and the arrows mean something else entirely. Taking the focus is safe here for the same
 * reason it is safe for a menu: no drifting pointer can raise this surface, and no page can either. It
 * exists only because somebody chose "block an element" in the browser's own interface.
 *
 * A tile bar revealed by the pointer must not, and that is the whole reason this function exists.
 * The layer's renderer is a real web contents; focusing it takes focus away from the page. A bar
 * that appears because the pointer drifted towards the top of a tile would therefore interrupt
 * whatever the user was typing in that page — and interrupt it *silently*, since the bar looks
 * like decoration until the next keystroke goes missing. The same bar asked for by keyboard is the
 * opposite case: moving focus into it is the request.
 *
 * An exhaustive switch rather than a table, because the answer for one kind is not a constant.
 */
export function takesFocus(presentation: OverlayPresentation): boolean {
  switch (presentation.kind) {
    case 'layout-menu':
    case 'tab-drop':
    case 'permission-request':
    case 'find-bar':
    case 'master-password':
    /*
      `navigation-request` is focused like every other dialogue here, although it is the one surface on
      this list that a *page* can cause. Taking focus is what makes Escape reach it, and Escape is a
      refusal — so the surface a page can raise is one whose default answer the keyboard gives fastest.

      The comment sits above the group rather than between the two cases: a comment between them reads as
      an intentional fallthrough to `no-fallthrough`, which then wants a `break` that would change the
      behaviour.
    */
    case 'navigation-request':
    case 'picker-bar':
      return true
    case 'tile-bar':
      return presentation.invokedBy === 'keyboard'
  }
}

/**
 * The bounds the overlay view takes for a given region.
 *
 * Pure so the choice is testable: a surface sized to the whole window when it should have
 * left the tab strip alone would silently swallow every click on the tab strip.
 */
export function overlayRegionRect(
  region: OverlayWindowRegion,
  windowSize: Size,
  contentRect: Rect
): Rect {
  if (region === 'content') return contentRect
  return { x: 0, y: 0, width: windowSize.width, height: windowSize.height }
}

/**
 * Where the layer goes for one particular surface.
 *
 * The entry point the layer actually uses, and it exists because `tile` is not a rectangle the
 * window can produce: only the presentation knows which tile it belongs to. Kept as one function
 * so there is a single answer to "how big is the layer right now" — two call sites deciding it
 * separately is how a surface ends up drawn in one place and hit-tested in another.
 *
 * The `tile` surfaces carry their own rectangle rather than being handed a tile index to resolve. Each is
 * computed where the tiles are: the tile bar's from the same function that positions the views, the find
 * bar's from the searched view's own bounds, the picker bar's from the picked view's. A second resolution
 * here would be a second opinion about where a tile is, and the two eventually disagree.
 *
 * A kind left out of the list below does not fall through to a wrong rectangle: `overlayRegionRect` takes
 * a `OverlayWindowRegion`, so a `tile` kind that is not narrowed away first fails the build. The check is
 * written as a union of names rather than as a lookup because that is what narrows the type — but which
 * names belong in it is the compiler's answer, not a list somebody has to remember.
 */
export function overlayBounds(
  presentation: OverlayPresentation,
  windowSize: Size,
  contentRect: Rect
): Rect {
  if (
    presentation.kind === 'tile-bar' ||
    presentation.kind === 'find-bar' ||
    presentation.kind === 'picker-bar'
  ) {
    return presentation.bounds
  }
  return overlayRegionRect(OVERLAY_REGION[presentation.kind], windowSize, contentRect)
}

export function regionOf(kind: OverlayKind): OverlayRegion {
  return OVERLAY_REGION[kind]
}

/**
 * The surfaces whose rectangle belongs to a tile, and which therefore cannot survive the tiles moving.
 *
 * A `tile` surface's bounds are captured when it is presented, and `layout()` repositions the layer from
 * that stored rectangle — so a layout change, a dragged divider, a reassigned tab or a maximised tile
 * leaves the surface hanging over a page it has nothing to do with. Every one of those sites therefore
 * takes them down, by kind and never wholesale: an unconditional `dismiss()` there would answer a consent
 * dialogue that happened to be up.
 *
 * Derived from the regions rather than written out at each site, for the reason `DISMISSED_ON_INTERRUPTION`
 * is: the four call sites each listed two kinds by name, so a third tile surface would have been correct in
 * the region table, correct in every other table, and still left sitting over the wrong page four times
 * over — with the comment beside each list saying it was handled.
 */
export const TILE_BOUND_KINDS: readonly OverlayKind[] = OVERLAY_KINDS.filter(
  (kind) => OVERLAY_REGION[kind] === 'tile'
)
