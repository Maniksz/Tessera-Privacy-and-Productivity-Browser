import { z } from 'zod'
import type { EventChannel, InvokeChannel } from './channels.js'
import type { SameShape } from './same-shape.js'
import {
  chromeInsetsSchema,
  historyEntrySchema,
  splitStateSchema,
  tabStateSchema,
  windowStateSchema
} from '../model.js'
import { settingsSnapshotSchema } from '../settings/definitions.js'
import { settingDescriptorSchema } from '../settings/schema.js'
import { LAYOUT_IDS } from '../split/layout.js'
import { localeSchema } from '../i18n/schema.js'
import { isInternalScheme } from '../product.js'
import { quickLinkCardSchema, quickLinkKindSchema, quickLinkSchema } from '../quicklinks/schema.js'
import { tabGroupColorSchema, tabGroupSchema } from '../tabgroups/schema.js'
import { filterStatusSchema } from '../filters/status.js'
import { readerGetRequestSchema, readerOutcomeSchema } from '../reader/schema.js'
import { userRuleSchema } from '../filters/user-rules-schema.js'
import { USER_RULE_LINE_REFUSALS } from '../filters/user-rules-lines.js'
// The bound the store enforces, so the schema and the storage cannot disagree about what is too long.
import {
  APPLY_USER_RULE_SOURCE_OUTCOMES,
  MAX_LOADED_USER_RULE_IDS,
  MAX_USER_RULE_SOURCE_LENGTH
} from '../filters/user-rules-source.js'
import {
  PERMISSION_ANSWERS,
  PERMISSION_DEVICES,
  PERMISSION_SUBJECTS
} from '../overlay/permission.js'
import { PICKER_BAR_ACTIONS, PICKER_BAR_MODES } from '../overlay/picker-bar.js'
import {
  DOWNLOADS_PANEL_ROWS,
  type OverlayPresentation,
  type OverlayRequest
} from '../overlay/surface.js'
import {
  mediaCancelRequestSchema,
  mediaCancelResponseSchema,
  mediaDescribeRequestSchema,
  mediaDownloadReportSchema,
  mediaDownloadRequestSchema,
  mediaFindingListSchema,
  mediaListRequestSchema,
  mediaManifestReportSchema
} from '../media/schema.js'
import { MAX_TAB_GROUP_NAME_LENGTH } from '../tabgroups/model.js'
import { BOOKMARK_KINDS, type Bookmark } from '../bookmarks/model.js'
import { DOWNLOAD_STATES, type DownloadEntry } from '../downloads/model.js'
import { DOWNLOAD_MARKERS, type DownloadButtonSummary } from '../downloads/summary.js'
import {
  MASTER_PASSWORD_PROBLEMS,
  MASTER_PASSWORD_PURPOSES,
  MASTER_PASSWORD_STEPS
} from '../passwords/prompt.js'
/*
  A value import, and the only place in this feature that may make one: `fill-policy.ts` carries the
  public-suffix table, and this file is linked into the main process alone — the renderers and the
  preload hold the contract by `import type` and build their allowlists from `channels.ts`, which is
  dependency-free. The bundle-weight fitness functions are what keep that true.
*/
import { FILL_REFUSALS } from '../passwords/fill-policy.js'
/*
  Every password and address-bar suggestion wire shape, and their channels, from each feature's own
  `schema.ts`: the `model.ts` / `schema.ts` split `quicklinks`, `media` and `reader` use, here also because
  those schemas took this file past its line bar. The two-way assertions against each model travel along.
*/
import {
  autofillKeyStateSchema,
  passwordInvokeContract,
  vaultStateResponseSchema
} from '../passwords/schema.js'
import { omniboxInvokeContract, omniboxSuggestionsPresentationSchema } from '../omnibox/schema.js'
import { backupInvokeContract } from '../backup/schema.js'
import { importInvokeContract } from '../import/schema.js'
import { workspaceInvokeContract } from '../workspaces/schema.js'

/**
 * The typing half of the UI <-> core boundary (spec 6).
 *
 * `satisfies Record<InvokeChannel, ...>` is doing real work here: a channel
 * added to `channels.ts` without an entry below fails the build, and an entry
 * below without a channel name fails too. Neither side can quietly grow a
 * method the other does not know about.
 *
 * Requests are validated in the main process before a handler ever sees them,
 * so a compromised renderer cannot smuggle an unexpected shape across.
 */

export interface InvokeDefinition<
  Request extends z.ZodType = z.ZodType,
  Response extends z.ZodType = z.ZodType
> {
  readonly request: Request
  readonly response: Response
}

const nothing = z.void()
const ok = z.object({ ok: z.literal(true) })

const settingsKeyRequest = z.object({ key: z.string() })

const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number()
})

/**
 * One download, plus the two fields that are never stored.
 *
 * `onDisk` is derived when the list is read and is deliberately absent from the document — a
 * stored flag could only ever be wrong, because nothing tells the browser when a user deletes a
 * file. `canPause` is derived at the same moment, from the live transfer. See `DownloadEntry`.
 *
 * Above the overlay presentations rather than beside the other download shapes, because the
 * downloads panel carries these rows and a schema has to exist before a union can name it.
 */
const downloadEntrySchema = z.object({
  id: z.string(),
  url: z.string(),
  fileName: z.string(),
  savePath: z.string(),
  mimeType: z.string(),
  /** `0` when the server declared no length, which is what Electron reports. */
  totalBytes: z.number(),
  receivedBytes: z.number(),
  state: z.enum(DOWNLOAD_STATES),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
  interruptReason: z.string(),
  onDisk: z.boolean(),
  canPause: z.boolean()
})

const _downloadWireMatchesModel: SameShape<
  z.output<typeof downloadEntrySchema>,
  DownloadEntry
> = true
void _downloadWireMatchesModel

/**
 * One member per overlay kind, discriminated so each carries exactly the data its surface
 * needs — the layout menu needs the current layout, a future drop-zone surface will need
 * something else, and neither has to accept the other's fields.
 */
const dropZoneSchema = z.object({
  id: z.string(),
  kind: z.enum(['tile', 'left', 'right', 'top', 'bottom']),
  /** Where the pointer must be for this zone to win. */
  hit: rectSchema,
  /** Where the page will actually end up — what the indicator draws. */
  preview: rectSchema,
  layout: z.enum(LAYOUT_IDS).nullable(),
  tileIndex: z.number().int().nonnegative()
})

const overlaySurfaceSchemas = [
  z.object({
    kind: z.literal('layout-menu'),
    /** The opening button's rect, in window coordinates. */
    anchor: rectSchema,
    current: z.enum(LAYOUT_IDS)
  }),
  z.object({
    kind: z.literal('tab-drop'),
    /** The overlay's own bounds origin in window space, for reporting pointer positions. */
    origin: z.object({ x: z.number(), y: z.number() }),
    /** Relative to the overlay's own bounds, which are the content area. */
    zones: z.array(dropZoneSchema),
    activeZoneId: z.string().nullable(),
    title: z.string()
  }),
  /**
   * A page asking for the camera, the microphone, its location or anything else needing consent.
   *
   * Everything the dialogue renders is in the message. A consent prompt must never present a button
   * before it can say what the button agrees to, so there is no second call for the text: a surface
   * that had to ask who was asking would, for one frame, be a dialogue about nothing.
   */
  z.object({
    kind: z.literal('permission-request'),
    /**
     * Echoed back with the answer, so a reply can only resolve the question it was shown for.
     *
     * Without it, a click landing while the surface was being replaced by the next queued prompt
     * would answer the *new* request — the user consenting to one thing and granting another.
     */
    requestId: z.string().min(1),
    /** Never empty: a request whose origin cannot be established is refused rather than shown. */
    origin: z.string().min(1),
    subject: z.enum(PERMISSION_SUBJECTS),
    /** Empty for everything that is not a media request. */
    devices: z.array(z.enum(PERMISSION_DEVICES)),
    /** How many prompts are queued behind this one, so the second does not look like a failure. */
    waiting: z.number().int().nonnegative()
  }),
  /**
   * One tile's own navigation bar (spec 2).
   *
   * The tab travels *with* the bar rather than being resolved when a button is pressed. In a split layout
   * the toolbar already acts on the active tile; a second set of buttons that also did would be worse than
   * none — the user would press back on the tile they are looking at and watch a different one navigate.
   */
  z.object({
    kind: z.literal('tile-bar'),
    tileIndex: z.number().int().nonnegative(),
    /** The strip in window coordinates, computed with the same function that positions the tile views. */
    bounds: rectSchema,
    /** Never empty: a tile with no tab gets no bar, because nothing for back or an address to mean. */
    tabId: z.string().min(1),
    url: z.string(),
    canGoBack: z.boolean(),
    canGoForward: z.boolean(),
    /** Turns the reload button into stop, exactly as the toolbar's does. */
    loading: z.boolean(),
    /** Already resolved against `appearance.defaultZoom`, so the bar can print it. */
    zoomPercent: z.number().int(),
    /** Whether the pane holds a zoom of its own, which is what Reset has to act on. */
    zoomed: z.boolean(),
    /** Keyboard invocation moves focus into the bar; a hover must not steal the caret. */
    invokedBy: z.enum(['pointer', 'keyboard'])
  }),
  /**
   * Find in page, for one tile.
   *
   * `matches: null` while the page has not answered yet, rather than `0`. That distinction is the whole
   * difference between a bar that counts and one that flickers: a search in flight rendered as zero announces
   * "no matches" on every keystroke and corrects itself a moment later.
   */
  z.object({
    kind: z.literal('find-bar'),
    /** Identity of the *search*, not of the bar: the surface keys its focus effect on it. */
    sessionId: z.string().min(1),
    tileIndex: z.number().int().nonnegative(),
    bounds: rectSchema,
    /** Never empty: there is no find bar without a page to find in. */
    tabId: z.string().min(1),
    query: z.string(),
    matches: z.number().int().nonnegative().nullable(),
    /** One-based position of the highlighted match; `0` when nothing is highlighted. */
    activeMatch: z.number().int().nonnegative()
  }),
  /**
   * The master-password prompt.
   *
   * The one presentation on this layer that is *only* a display. There is no field here for what has
   * been typed, in either direction — the characters live in the main process, taken off this view's own
   * input pipeline before its renderer is dispatched to, and the surface is told a count so it can draw
   * that many bullets. See `MasterPasswordPresentation` and `main/passwords/MasterPasswordPrompt.ts`.
   *
   * Which means this schema is worth reading for what it lacks: a validated boundary is only as good as
   * the shapes it admits, and a `masterPassword: z.string()` anywhere in this file would be the whole
   * guarantee gone.
   */
  z.object({
    kind: z.literal('master-password'),
    requestId: z.string().min(1),
    purpose: z.enum(MASTER_PASSWORD_PURPOSES),
    step: z.enum(MASTER_PASSWORD_STEPS),
    /** A count of characters, never the characters. */
    filled: z.number().int().nonnegative(),
    problem: z.enum(MASTER_PASSWORD_PROBLEMS).nullable(),
    minLength: z.number().int().positive()
  }),
  /**
   * A page tried to open a tab, or to send its tab somewhere else, with nothing the user did behind it.
   *
   * `url` is validated as a string and deliberately not as `z.url()`: the address is the thing the user is
   * being asked about, and a schema that refused an unusual one would take the *question* away rather than
   * the navigation — the surface would never appear and the caller's fallback would allow or refuse
   * without anybody being asked. Whether the address is one this browser will follow was already decided
   * before the prompt was raised.
   */
  z.object({
    kind: z.literal('navigation-request'),
    requestId: z.string().min(1),
    navigationKind: z.enum(['popup', 'navigation']),
    url: z.string().min(1),
    host: z.string()
  }),
  /**
   * "Block this element": the confirmation bar, on the layer rather than in the page.
   *
   * The whole of what the bar shows is in the message, for the permission prompt's reason and one of its
   * own: this surface is the *only* place a picked element's fate is reported, so a bar that had to ask a
   * second channel what became of the attempt would be a version of the silence this feature exists to end.
   *
   * `outcome` is a string rather than an enum, deliberately. The outcomes belong to the picking session,
   * which is where they are produced and held to being exhaustive; restating the set here would be a second
   * list of the same names, and the way that fails is that a new outcome validates as an unknown key on one
   * side and renders as nothing on the other. What this schema does guarantee is that the bar never receives
   * a selector it did not ask for and never a rule text at all.
   */
  z.object({
    kind: z.literal('picker-bar'),
    /** Identity of the picking session: an update carries the same one, a second session a new one. */
    sessionId: z.string().min(1),
    tileIndex: z.number().int().nonnegative(),
    bounds: rectSchema,
    /** Never empty: there is no picking session without a document to pick in. */
    tabId: z.string().min(1),
    mode: z.enum(PICKER_BAR_MODES),
    selector: z.string(),
    /** `null` while nothing has been measured yet; `0` is a finding, not an absence of one. */
    matches: z.number().int().nonnegative().nullable(),
    /** False at the ends of the ancestor chain, so a control that can do nothing says so. */
    canWiden: z.boolean(),
    canNarrow: z.boolean(),
    /** The key of a named outcome, or `null` while the attempt is still going on. */
    outcome: z.string().nullable(),
    /** Whether a rule was actually written, which is the one thing Undo may act on. */
    canUndo: z.boolean(),
    /**
     * The bar's words, resolved in the core for the interface language; see `main/privacy/picker-bar-text.ts`
     * for why they are not in the renderer's catalogue. A record like `userrules:list`'s, for its reason.
     */
    text: z.record(z.string(), z.string())
  }),
  /**
   * The account picker for one password field (R5).
   *
   * ## What this schema is worth reading for
   *
   * The same thing the master-password one is: what it will not admit. There is no password field here
   * in either direction, and there is no `origin` and no `url` — the surface renders names the user
   * asked to see and nothing that would make this message a description of where they were. The only
   * secret-adjacent value that crosses is a username, and only after a press on the badge.
   *
   * `entries` carries opaque ids beside those names because the choice comes back as an id. The id is
   * not a capability: the core will not fill from it without the request this presentation names, and
   * that request is spent by the first fill it authorises.
   */
  z.object({
    kind: z.literal('autofill-suggest'),
    /** Echoed back with the choice. Also the consent the fill is authorised by; see `consent.ts`. */
    requestId: z.string().min(1),
    tileIndex: z.number().int().nonnegative(),
    bounds: rectSchema,
    /**
     * The list, or the reason there is not one.
     *
     * Discriminated for the same reason the presentations themselves are: a locked vault and an
     * unsupported page are different sentences, and a single nullable list would make them the same
     * blank box. `refused` names the rule from `fill-policy.ts` rather than carrying its wording — the
     * wordlist belongs in the chrome's catalogue, not on the wire.
     */
    content: z.discriminatedUnion('state', [
      z.object({
        state: z.literal('entries'),
        /** Never empty: an offer of nothing is `empty`, which the surface renders as a sentence. */
        entries: z.array(z.object({ id: z.string().min(1), username: z.string() })).min(1)
      }),
      z.object({ state: z.literal('locked') }),
      z.object({ state: z.literal('empty') }),
      z.object({ state: z.literal('refused'), reason: z.enum(FILL_REFUSALS) }),
      z.object({ state: z.literal('disabled') })
    ])
  })
] as const

/**
 * The toolbar's downloads panel, as the layer is sent it: the anchor, and the rows the core put in.
 *
 * At most the panel's own count, so a presentation cannot become the way the full list — up to a
 * thousand rows naming what somebody downloaded — reaches a renderer four times a second (KTD2).
 */
const downloadsPanelPresentationSchema = z.object({
  kind: z.literal('downloads-panel'),
  anchor: rectSchema,
  downloads: z.array(downloadEntrySchema).max(DOWNLOADS_PANEL_ROWS)
})

/**
 * The same panel, as the chrome UI asks for it: which kind and where its button is, and nothing else.
 *
 * Strict, and the strictness is the point. The chrome UI is never sent the list, so rows in a request
 * can only be rows somebody made up — a panel showing a list the window may not see. Refused here
 * rather than overwritten in the core, so the attempt is an error and not a silent correction.
 */
const downloadsPanelRequestSchema = z.strictObject({
  kind: z.literal('downloads-panel'),
  anchor: rectSchema
})

const overlayPresentationSchema = z.discriminatedUnion('kind', [
  ...overlaySurfaceSchemas,
  downloadsPanelPresentationSchema,
  omniboxSuggestionsPresentationSchema
])

/** What `overlay:present` accepts: every surface as presented, the panel asked for bare, no suggestions. */
const overlayRequestSchema = z.discriminatedUnion('kind', [
  ...overlaySurfaceSchemas,
  downloadsPanelRequestSchema
])

const _overlayPresentationWireMatchesModel: SameShape<
  z.output<typeof overlayPresentationSchema>,
  OverlayPresentation
> = true
void _overlayPresentationWireMatchesModel
const _overlayRequestWireMatchesModel: SameShape<
  z.output<typeof overlayRequestSchema>,
  OverlayRequest
> = true
void _overlayRequestWireMatchesModel

/**
 * One recorded visit, on the wire.
 *
 * Restated here rather than imported, and the reason is a real structural limit: the persistence
 * schema lives with the store in the main process, `shared` may not see `@main`, and
 * `shared/history/model.ts` has to stay zod-free because the history page imports it at runtime.
 * There is nowhere a single definition could sit.
 *
 * So the duplication is unavoidable — but it is not left unguarded. A test asserts this shape and
 * `HistoryVisit` describe the same fields, which turns a future divergence into a red test rather
 * than a page that silently drops a column.
 */
const historyVisitSchema = z.object({
  url: z.string(),
  title: z.string(),
  firstVisitedAt: z.number(),
  lastVisitedAt: z.number(),
  visitCount: z.number().int().positive()
})

/** How many entries a deletion actually removed, so the UI can say so rather than guess. */
const removedCount = z.object({ removed: z.number().int().nonnegative() })

/**
 * An address an internal page may ask the core to follow in its own tab.
 *
 * The internal scheme is refused, and only it: both openers reach `resolveOmniboxInput`, which already
 * turns `javascript:` and `data:` into searches and hands ours straight through. So the history page —
 * one any website may link to — could steer its own tab onto the settings page and come back holding
 * the settings channels, and the navigation lock in `Tab.ts` cannot see it, because by then it *is* a
 * core `loadUrl`. The bookmarks page had it worse: it may write the tree, so it could store the target
 * first. In the schema rather than in the two handlers, so a third opener meets the rule by default.
 * The cost is a bookmark on an internal page, which is now opened from the address bar.
 */
const openableUrl = z
  .string()
  .refine((url) => !isInternalScheme(url), 'this address cannot be opened through this channel')

const extensionInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  path: z.string()
})

/**
 * One bookmark or folder, on the wire.
 *
 * Restated here rather than imported for the reason `historyVisitSchema` gives, and guarded
 * better: the assertion below fails to compile if `Bookmark` and this schema stop describing the
 * same record, where history relies on a test.
 */
const bookmarkSchema = z.object({
  id: z.string(),
  kind: z.enum(BOOKMARK_KINDS),
  title: z.string(),
  /** Always empty for a folder; normalised by the core for a bookmark. */
  url: z.string(),
  /** A root id or a folder id in the same document. Never empty, never null. */
  parentId: z.string(),
  createdAt: z.number()
})

const _bookmarkWireMatchesModel: SameShape<z.output<typeof bookmarkSchema>, Bookmark> = true
void _bookmarkWireMatchesModel

const downloadListingSchema = z.object({
  downloads: z.array(downloadEntrySchema),
  /**
   * True when the asking window is private.
   *
   * Sent because the page cannot know it and the difference is visible: a private window sees the
   * stored list and its own downloads while they last, and its own leave no row behind. Without
   * this the page could not explain why.
   */
  privateWindow: z.boolean()
})

/**
 * What the toolbar's download button says, for one window: numbers and states, and nothing else.
 *
 * Strict at every level, because the point of this shape is what it cannot carry. The download list
 * names what somebody downloaded and where from, which is why it reaches the downloads page and no
 * other renderer; the button needs none of that, and a strict schema turns "somebody added the file
 * name for a tooltip" into a failing test instead of a leak. See `summarizeWindowDownloads`.
 */
const downloadButtonSummarySchema = z.strictObject({
  visible: z.boolean(),
  activity: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('fraction'), fraction: z.number().min(0).max(1) }),
      z.strictObject({ kind: z.literal('indeterminate') })
    ])
    .nullable(),
  marker: z.enum(DOWNLOAD_MARKERS).nullable()
})

const _downloadSummaryWireMatchesModel: SameShape<
  z.output<typeof downloadButtonSummarySchema>,
  DownloadButtonSummary
> = true
void _downloadSummaryWireMatchesModel

const downloadIdRequest = z.object({ id: z.string().min(1) })
/** Whether the operation did anything. `false` is an answer, not a failure — see `DownloadManager`. */
const downloadChanged = z.object({ changed: z.boolean() })

export const invokeContract = {
  // --- settings ------------------------------------------------------------
  'settings:getAll': { request: nothing, response: settingsSnapshotSchema },
  'settings:get': { request: settingsKeyRequest, response: z.unknown() },
  /**
   * Rejects with an error the UI must surface when `key` is unknown or `value`
   * fails its schema. Returns the full snapshot so the caller can never hold a
   * stale view of what was actually stored (spec 5).
   */
  'settings:set': {
    request: z.object({ key: z.string(), value: z.unknown() }),
    response: settingsSnapshotSchema
  },
  'settings:reset': { request: settingsKeyRequest, response: settingsSnapshotSchema },
  'settings:resetAll': { request: nothing, response: settingsSnapshotSchema },
  /**
   * How each setting should be presented, derived from its own schema in the core.
   *
   * The settings UI renders from this rather than from a second hand-written table:
   * `definitions.ts` stays the single source of truth (spec 5), and the renderer
   * never imports zod.
   *
   * ## Why the words travel on this channel
   *
   * `label` is required and `description` and `choiceLabels` are the prose beside a control.
   * They are here rather than in the message catalogue every renderer already holds, because
   * that catalogue is one chunk with both locales in it, is budgeted at 46 kB with about
   * a hundred and ninety bytes to spare, and is fetched before first paint by six internal
   * pages that never show a setting. `main/settings/settings-text.ts` argues it in full.
   *
   * The consequence for this channel is that the response is **locale-dependent**: the core
   * resolves the language the same way `i18n:getCatalog` does, so a caller that changes
   * `appearance.uiLanguage` has to ask again. The settings page does exactly that, on
   * `settings:changed`.
   */
  'settings:describe': { request: nothing, response: z.array(settingDescriptorSchema) },
  /**
   * A check the user asked for, and the narrowest pair of schemas in this file.
   *
   * **Nothing in, and `{ ok: true }` out.** The request is empty because there is no argument a
   * caller could usefully supply — a channel, a version or a repository in the payload would be a
   * page choosing what this browser talks to, which is the whole thing the single grant is protecting.
   *
   * The response was the real decision. `UpdateService.checkOnDemand` resolves with an `UpdateOutcome`
   * naming the version found and how the user answered, and returning it here was the obvious shape.
   * It loses on two counts. The outcome is *already reported*, in a native dialog the core raises
   * before this promise settles, so a page rendering it too would say the same thing twice — in
   * different words, because the page has no catalogue entry for any of those cases and may not grow
   * one. And a payload would hand a document the released version number and the fact that this
   * person declined it, for no purpose.
   *
   * What the caller does get is the *timing*: this resolves when the check is over, which is what lets
   * a button stay disabled for exactly as long as something is happening.
   */
  'updates:checkNow': { request: nothing, response: ok },
  'network:probeSystemProxy': { request: nothing, response: z.object({ direct: z.boolean() }) },

  // --- window --------------------------------------------------------------
  'window:getState': { request: nothing, response: windowStateSchema },
  'window:minimize': { request: nothing, response: ok },
  'window:toggleMaximize': { request: nothing, response: ok },
  'window:close': { request: nothing, response: ok },
  'window:setChromeInsets': { request: chromeInsetsSchema, response: ok },
  /**
   * Suspends the content views so the chrome UI can use the whole window.
   *
   * Needed because tab content is rendered by native views layered *above* the
   * chrome UI: a settings panel or a drag target drawn in the DOM would otherwise
   * sit behind the page and receive no pointer events. Views are hidden, never
   * unloaded — a suspended tile keeps playing and keeps its scroll position.
   */
  'window:setOverlay': { request: z.object({ active: z.boolean() }), response: ok },

  // --- overlay surface -----------------------------------------------------
  /**
   * Puts a surface on the window's topmost layer.
   *
   * The chrome UI describes what should appear and where; the surface renderer draws it.
   * This is the only route by which browser UI can be both visible and clickable over
   * page content, because tab content is rendered by native views stacked above the
   * chrome renderer.
   */
  'overlay:present': { request: overlayRequestSchema, response: ok },
  'overlay:dismiss': { request: nothing, response: ok },

  // --- dragging a tab into a tile ------------------------------------------
  /**
   * Coordinates are in window space. The core converts them, decides which zone wins and
   * pushes the indicator, so the two renderers reporting the gesture never have to agree
   * on anything beyond where the pointer is.
   */
  'drag:start': { request: z.object({ tabId: z.string() }), response: ok },
  'drag:move': { request: z.object({ x: z.number(), y: z.number() }), response: ok },
  'drag:end': {
    request: z.object({
      x: z.number(),
      y: z.number(),
      /** False for a cancelled drag: the indicator goes, nothing moves. */
      commit: z.boolean()
    }),
    response: ok
  },

  // --- tabs ----------------------------------------------------------------
  'tabs:create': {
    request: z.object({
      url: z.string().optional(),
      /** Assign straight into a tile; omit to place it in the active tile. */
      tileIndex: z.number().int().nullable().optional(),
      background: z.boolean().optional()
    }),
    response: z.object({ tabId: z.string() })
  },
  'tabs:close': { request: z.object({ tabId: z.string() }), response: ok },
  'tabs:activate': { request: z.object({ tabId: z.string() }), response: ok },
  'tabs:move': {
    request: z.object({ tabId: z.string(), toIndex: z.number().int().nonnegative() }),
    response: ok
  },
  'tabs:setPinned': {
    request: z.object({ tabId: z.string(), pinned: z.boolean() }),
    response: ok
  },
  'tabs:reopenClosed': { request: nothing, response: z.object({ tabId: z.string().nullable() }) },

  // --- navigation ----------------------------------------------------------
  // All of these default to the active tile's tab when `tabId` is omitted.
  'nav:goBack': { request: z.object({ tabId: z.string().optional() }), response: ok },
  'nav:goForward': { request: z.object({ tabId: z.string().optional() }), response: ok },
  'nav:reload': {
    request: z.object({ tabId: z.string().optional(), ignoreCache: z.boolean().optional() }),
    response: ok
  },
  'nav:stop': { request: z.object({ tabId: z.string().optional() }), response: ok },
  /**
   * Takes raw omnibox input, not a URL: deciding address-versus-search happens
   * in the core so the rule is applied in exactly one place (spec 1).
   */
  'nav:navigate': {
    request: z.object({ input: z.string(), tabId: z.string().optional() }),
    response: z.object({ url: z.string() })
  },
  // --- reader mode ---------------------------------------------------------
  /**
   * The harvested article, or the reason it was refused.
   *
   * Refusal is a first-class answer rather than an error: an extractor that showed three paragraphs of nine
   * would be worse than one that says "this does not look like an article", because the reader cannot tell
   * until the text stops.
   */
  'reader:get': { request: readerGetRequestSchema, response: readerOutcomeSchema },

  // --- find in page --------------------------------------------------------
  /**
   * Opens the bar for the active tile's tab.
   *
   * No payload: which tile Ctrl+F means is a decision the core owns, and a renderer naming a tab here could
   * search a page the user is not looking at.
   */
  'find:open': { request: nothing, response: ok },
  /** `tabId` is required, and it is the bar's own: a query for "whatever is active" is the bug. */
  'find:query': {
    request: z.object({ tabId: z.string().min(1), query: z.string() }),
    response: ok
  },
  /** `tabId` omitted means the active tile's tab, which is what the `findNext` shortcut sends. */
  'find:step': {
    request: z.object({ tabId: z.string().min(1).optional(), forward: z.boolean() }),
    response: ok
  },

  'nav:getBackForwardList': {
    request: z.object({ tabId: z.string().optional() }),
    response: z.array(historyEntrySchema)
  },

  // --- zoom ----------------------------------------------------------------
  /**
   * Back to following `appearance.defaultZoom`, for one pane.
   *
   * `ok` rather than the new percentage, although the caller is a badge that displays one. The pane's
   * zoom travels on `TabState`, which is broadcast whenever it changes — so answering with a number
   * here would give the toolbar two sources for one value and a moment where they disagree. The same
   * rule every write in this contract follows: the state comes back through the state.
   *
   * `tabId` optional, like the navigation channels above it: absent means the active tile's tab,
   * which is what the toolbar means.
   */
  'zoom:reset': { request: z.object({ tabId: z.string().optional() }), response: ok },
  /**
   * One stop in or out, for the named pane.
   *
   * A direction rather than a percentage, which is the same shape the gesture channel uses and for
   * the same reason: the ladder lives in `shared/gestures/zoom.ts` and is walked in the core, so no
   * caller can invent a stop that is not on it or step past either end.
   */
  'zoom:step': {
    request: z.object({ tabId: z.string().optional(), direction: z.enum(['in', 'out']) }),
    response: ok
  },

  // --- split view ----------------------------------------------------------
  'split:setLayout': {
    request: z.object({ layout: z.enum(LAYOUT_IDS) }),
    response: splitStateSchema
  },
  'split:setFractions': {
    request: z.object({ fractions: z.record(z.string(), z.number()) }),
    response: splitStateSchema
  },
  'split:setActiveTile': {
    request: z.object({ tileIndex: z.number().int().nonnegative() }),
    response: splitStateSchema
  },
  'split:assignTab': {
    request: z.object({
      tabId: z.string(),
      /** null unassigns the tab without closing it (spec 2). */
      tileIndex: z.number().int().nullable()
    }),
    response: splitStateSchema
  },
  'split:toggleTileMaximized': {
    request: z.object({ tileIndex: z.number().int().optional() }),
    response: splitStateSchema
  },
  /** One step back along the escalation chain (spec 2). */
  'split:escape': { request: nothing, response: splitStateSchema },

  // --- per-tile navigation bar ----------------------------------------------
  /**
   * How far the pointer is from the top of one tile.
   *
   * Tile-relative rather than a window coordinate, and named by tile rather than by position, because the
   * renderer that reports it already knows which tile it is over — its own bounds *are* that tile. Sending a
   * window point would mean the core resolving a tile from geometry the sender had already resolved, and two
   * resolutions of one fact eventually disagree.
   *
   * `y` alone, with no `x`: whether a bar reveals itself depends only on vertical distance from the tile's
   * top edge, and carrying a horizontal position nothing reads would invite something to start reading it.
   */
  'tiles:pointerAt': {
    request: z.object({
      tileIndex: z.number().int().nonnegative(),
      y: z.number()
    }),
    response: ok
  },

  // --- site menu, behind the lock and the shield -----------------------------
  'site:menu': { request: nothing, response: ok },

  // --- element picker and the user's own rules ------------------------------
  /**
   * Puts the tab into picker mode: the next click on the page writes a hiding rule.
   *
   * `tabId` omitted means the active tile's tab, which is what the keyboard route sends. The response says
   * whether it started, so a caller can report "there is no page here" instead of appearing to work.
   */
  'picker:start': {
    request: z.object({ tabId: z.string().optional() }),
    response: z.object({ started: z.boolean() })
  },
  'picker:stop': { request: z.object({ tabId: z.string().optional() }), response: ok },
  /**
   * One press on the confirmation bar, as one word.
   *
   * ## Why the payload is a word and a session, and nothing else
   *
   * The selector is not here, and neither is the rule text. The core proposed the selector, the core holds
   * the selection, and the core is what will write the rule — so a message that carried any of those would
   * let the *sender* choose what gets written into the user's own filter list. The sender is a renderer.
   * `permissions:answer` settled this shape for the same reason: the answer is an enum and the question is
   * the core's.
   *
   * `sessionId` is echoed back on the precedent of every other answering channel on this layer — a reply may
   * only ever resolve the question it was shown for. It matters here even though at most one picking session
   * exists at a time, because the ways a session ends are numerous and mostly not clicks: a navigation, a
   * displaced bar, a closed tab. A Confirm that raced any of those would otherwise land on whatever session
   * came next and write a rule for an element nobody chose.
   *
   * ## Why the answer is `taken` rather than `ok`
   *
   * Because this whole feature exists because a picker used to end without saying anything. A word that
   * arrives for a session that is no longer running is an ordinary event rather than an error, and the
   * caller is told that nothing happened instead of being left to assume that something did.
   */
  'picker:barAction': {
    request: z.object({
      sessionId: z.string().min(1),
      action: z.enum(PICKER_BAR_ACTIONS)
    }),
    response: z.object({ taken: z.boolean() })
  },
  /**
   * The user's own rules, the text the editor shows them as, and the words it renders them with.
   *
   * Both on one answer, on the precedent `settings:describe` set: the locale is known in the core, the screen
   * is fetching anyway, and a second channel would be a second round trip at the same moment. Why the prose
   * is in the core rather than the shared catalogue is argued in `main/settings/user-rules-text.ts` — it
   * comes down to a measured bundle budget that only one screen should be paying into.
   *
   * `source` and `rejected` are computed in the core rather than in the page, and not for convenience: which
   * line is a rule, which is a note and which is refused is `describeUserRule`'s decision, and a page that
   * made it again would be a second opinion that can disagree — and would put the filter parser into the
   * settings bundle to do so. The page only finds the refused lines again by their text.
   *
   * `kind` per rule, because the two are not the same promise: a declarative rule is a line in a stylesheet
   * the browser matches, and a procedural one is script re-run on every mutation burst. An editor that
   * showed them identically would hide the one thing worth knowing about a rule just typed.
   *
   * `rejected` carries a reason per line, because a private window refuses lines for two reasons a normal
   * one never has — a rule it cannot deliver, and a change to a stored rule it cannot make — and each needs
   * its own tag and its own next step. See `USER_RULE_LINE_REFUSALS`.
   *
   * `session` says the answer came from a private window's editor, whose changes are not saved and which
   * cannot stop a stored rule from applying — something the screen has to say rather than leave to be found.
   */
  'userrules:list': {
    request: nothing,
    response: z.object({
      rules: z.array(userRuleSchema.extend({ kind: z.enum(['declarative', 'procedural']) })),
      text: z.record(z.string(), z.string()),
      source: z.string(),
      rejected: z.array(z.object({ line: z.string(), reason: z.enum(USER_RULE_LINE_REFUSALS) })),
      session: z.boolean()
    })
  },
  /**
   * The rule manager's text, saved whole (U8, R17).
   *
   * One channel in place of the three it replaces — `userrules:add`, `userrules:setEnabled` and
   * `userrules:remove` — because a saved text is all three at once, and doing it as a sequence of them would
   * be a write and an engine recompile per line and a limit that could be passed halfway. See
   * `INTERNAL_PAGE_INVOKE_CHANNELS.settings` for why the three are gone rather than kept beside it.
   *
   * Every line goes through `describeUserRule` in the core, a commented one *without* its `!` — so a
   * commented network rule or scriptlet is kept as a note and never becomes a switched-off rule that could
   * later be switched on unchecked. The outcome is returned rather than thrown, because neither answer is a
   * failure of the browser: `applied` covers a text with refused lines in it (they are marked where they
   * stand and the rest is taken), and `limit-reached` means nothing was written and nothing deleted (R18).
   *
   * Bounded in length because the text is stored as the user wrote it; see `MAX_USER_RULE_SOURCE_LENGTH`.
   * Empty is allowed and means what it looks like: a box emptied and saved is a list with no rules.
   *
   * `loadedIds` are the ids of the rules the page loaded — the list the text was written against. A missing
   * line deletes only one of those, so a rule the element picker wrote while the page was open is kept
   * rather than silently deleted by a text that never showed it. Required rather than defaulted: the only
   * default that could stand in for it is "everything", which is the loss this field exists to prevent.
   * Bounded in count by `MAX_LOADED_USER_RULE_IDS`, which says why twice the list; not in length, because an
   * id is only looked up and never stored.
   */
  'userrules:apply': {
    request: z.object({
      text: z.string().max(MAX_USER_RULE_SOURCE_LENGTH),
      loadedIds: z.array(z.string().min(1)).max(MAX_LOADED_USER_RULE_IDS)
    }),
    /*
      The outcome only. The editor re-reads through `userrules:list` afterwards rather than being handed the
      new text here — the same rule the settings page follows for every write: the core folds, normalises
      and keeps refused lines, and a screen that displayed what it *sent* would disagree with what was kept.
    */
    response: z.object({ outcome: z.enum(APPLY_USER_RULE_SOURCE_OUTCOMES) })
  },

  // --- media ---------------------------------------------------------------
  'media:setTileMuted': {
    request: z.object({ tileIndex: z.number().int().nonnegative(), muted: z.boolean() }),
    response: splitStateSchema
  },

  // --- devtools ------------------------------------------------------------
  'devtools:toggle': { request: z.object({ tabId: z.string().optional() }), response: ok },

  // --- i18n ----------------------------------------------------------------
  'i18n:getCatalog': {
    request: nothing,
    response: z.object({
      locale: localeSchema,
      messages: z.record(z.string(), z.string())
    })
  },

  // --- tab groups ----------------------------------------------------------
  /**
   * Groups the given tabs, in the order given.
   *
   * Takes the members up front rather than creating an empty group and filling it: a group with no
   * tabs is a chip with nothing behind it, and the model refuses one outright. The name may be
   * empty — an unnamed group draws as a bare colour, which is the useful state while the user is
   * still deciding, and demanding a name first would mean a dialogue before the group exists.
   */
  'tabgroups:create': {
    request: z.object({
      tabIds: z.array(z.string()).min(1),
      name: z.string().optional(),
      color: tabGroupColorSchema.optional()
    }),
    response: tabGroupSchema
  },
  'tabgroups:rename': {
    // Bounded here as well as trimmed by the model: a request is untrusted input, and the bound is
    // about what the strip can draw rather than about what the document may hold.
    request: z.object({ id: z.string(), name: z.string().max(MAX_TAB_GROUP_NAME_LENGTH) }),
    response: ok
  },
  'tabgroups:recolor': {
    request: z.object({ id: z.string(), color: tabGroupColorSchema }),
    response: ok
  },
  /** Folding a group hides its tabs and takes them out of their tiles; they stay loaded (spec 2). */
  'tabgroups:setCollapsed': {
    request: z.object({ id: z.string(), collapsed: z.boolean() }),
    response: ok
  },
  /** Removes the group and leaves its tabs alone, ungrouped. */
  'tabgroups:dissolve': { request: z.object({ id: z.string() }), response: ok },
  'tabgroups:addTab': {
    request: z.object({
      groupId: z.string(),
      tabId: z.string(),
      /** Position within the group; appended when omitted. */
      index: z.number().int().nonnegative().optional()
    }),
    response: ok
  },
  /** Takes one tab out. A group left with no members goes with it. */
  'tabgroups:removeTab': { request: z.object({ tabId: z.string() }), response: ok },
  /**
   * Opens the tab's context menu at the pointer.
   *
   * No coordinates in the request. Electron pops a menu at the cursor by default, and a renderer-
   * supplied position would be a second source of truth for something the OS already knows — and one
   * that is wrong whenever the two disagree about device pixel ratio.
   */
  'tabs:contextMenu': { request: z.object({ tabId: z.string() }), response: ok },

  // --- permissions ---------------------------------------------------------
  /**
   * The answer a person gave to one prompt.
   *
   * Chrome-only, and it must be: the request id is the only thing between a page and the ability to
   * answer a dialogue on the user's behalf. It is checked against the prompt actually on screen, so a
   * stale or invented id resolves nothing rather than resolving the wrong thing.
   */
  'permissions:answer': {
    request: z.object({ requestId: z.string().min(1), answer: z.enum(PERMISSION_ANSWERS) }),
    response: ok
  },
  /**
   * The answer to a popup or redirect prompt.
   *
   * A boolean rather than an enum, because there are two answers and no third: this once or not at all.
   * There is deliberately no "always allow for this site" — that would be a stored permission with no
   * screen to review or revoke it on, and the setting is where a blanket answer belongs.
   *
   * `requestId` is echoed back so a reply can only ever resolve the question it was shown for.
   */
  'navigation:answer': {
    request: z.object({ requestId: z.string().min(1), permitted: z.boolean() }),
    response: ok
  },

  // --- media ---------------------------------------------------------------
  /** What this tab's page has fetched that looks like media. Reads state the core already holds. */
  'media:list': { request: mediaListRequestSchema, response: mediaFindingListSchema },
  /**
   * Reads a stream's manifest to find out which qualities exist.
   *
   * Its own channel rather than part of `media:list`, because it is the one thing in the feature that
   * makes a *second* request to an address the page already asked for — so it happens when somebody asks
   * to see the qualities, not whenever a panel opens.
   */
  'media:describe': { request: mediaDescribeRequestSchema, response: mediaManifestReportSchema },
  /**
   * Resolves when the file is on disk, or when the refusal is known.
   *
   * A film keeps this pending for minutes, which is the honest representation: there is one answer and it
   * arrives when it arrives. `media:cancel` is how the user takes it back.
   */
  'media:download': { request: mediaDownloadRequestSchema, response: mediaDownloadReportSchema },
  'media:cancel': { request: mediaCancelRequestSchema, response: mediaCancelResponseSchema },

  // --- content blocker -----------------------------------------------------
  'filters:getStatus': { request: nothing, response: filterStatusSchema },
  /**
   * Answers with the same shape as `filters:getStatus`, after the refresh.
   *
   * One round trip rather than "refresh, then ask again": the two would race, and a settings page
   * that showed the pre-refresh counters after clicking "update now" reads as a broken button.
   */
  'filters:refresh': { request: nothing, response: filterStatusSchema },

  // --- quick links (start page) --------------------------------------------
  /**
   * Cards rather than bare links: each carries the address of its screenshot and of its icon.
   *
   * Built by the core because both addresses are versioned with the capture time, and only the core
   * knows it. A page that composed them itself would get a stable address per site and Chromium would
   * keep drawing the copy in its memory cache — a refreshed screenshot would never appear.
   */
  'quicklinks:list': { request: nothing, response: z.array(quickLinkCardSchema) },
  /**
   * `url` is raw user input; the core normalises it and rejects anything that is
   * a search term rather than an address, so a tile never silently becomes a
   * search for whatever was typed.
   */
  'quicklinks:create': {
    request: z.object({
      kind: quickLinkKindSchema,
      title: z.string(),
      url: z.string().optional(),
      parentId: z.string().nullable().optional(),
      index: z.number().int().nonnegative().optional()
    }),
    response: quickLinkSchema
  },
  'quicklinks:update': {
    request: z.object({
      id: z.string(),
      title: z.string().optional(),
      url: z.string().optional()
    }),
    response: quickLinkSchema
  },
  'quicklinks:remove': { request: z.object({ id: z.string() }), response: ok },
  'quicklinks:move': {
    request: z.object({
      id: z.string(),
      parentId: z.string().nullable(),
      toIndex: z.number().int().nonnegative()
    }),
    response: z.array(quickLinkSchema)
  },
  'quicklinks:open': {
    request: z.object({
      id: z.string(),
      /** Open in a new tab instead of navigating the current one. */
      newTab: z.boolean().optional(),
      background: z.boolean().optional()
    }),
    response: z.object({ url: z.string() })
  },

  // --- extensions ----------------------------------------------------------
  'extensions:list': { request: nothing, response: z.array(extensionInfoSchema) },
  /**
   * Opens a folder picker and loads the chosen unpacked extension.
   *
   * The path is chosen through the OS picker rather than passed in, so a compromised
   * renderer cannot ask the core to load an arbitrary directory as code.
   */
  'extensions:load': {
    request: nothing,
    response: z.object({
      extension: extensionInfoSchema.nullable(),
      /** Null when the user cancelled; a reason string when loading failed. */
      error: z.string().nullable()
    })
  },
  'extensions:remove': { request: z.object({ id: z.string() }), response: ok },

  // --- browsing history ----------------------------------------------------
  'history:query': {
    request: z.object({
      /** Matched against address and title alike; absent means everything. */
      text: z.string().optional(),
      from: z.number().optional(),
      to: z.number().optional(),
      limit: z.number().int().positive().optional()
    }),
    response: z.array(historyVisitSchema)
  },
  /**
   * Follows an entry in the tab that asked.
   *
   * Deliberately not `nav:navigate`: the core resolves the target from the sender, so the history
   * page cannot steer any other tab. Same reasoning as `quicklinks:open`. Steering *itself* was enough
   * to escalate, though, which is what `openableUrl` is for.
   */
  'history:open': {
    request: z.object({
      url: openableUrl,
      newTab: z.boolean().optional(),
      background: z.boolean().optional()
    }),
    response: z.object({ url: z.string() })
  },
  'history:removeVisit': { request: z.object({ url: z.string() }), response: removedCount },
  'history:removeDomain': { request: z.object({ domain: z.string() }), response: removedCount },
  'history:removeRange': {
    request: z.object({ from: z.number(), to: z.number() }),
    response: removedCount
  },
  'history:clear': { request: nothing, response: removedCount },

  // --- bookmarks -----------------------------------------------------------
  /**
   * The whole tree, in sibling order.
   *
   * Unbounded-looking but bounded at ten thousand nodes, and the page needs the structure rather
   * than a filtered list — see `bookmarks:list` in `channels.ts` and the note on `BookmarksPage`.
   */
  'bookmarks:list': { request: nothing, response: z.array(bookmarkSchema) },
  /**
   * Raw-node count (R3), never the nodes; R4's load flags only when true, as `VaultStatus` has them.
   */
  'bookmarks:status': {
    request: nothing,
    response: vaultStateResponseSchema.shape.vault
      .pick({ newer: true, invalid: true, readOnly: true })
      .extend({ unreadableEntries: z.number().int().nonnegative() })
  },
  /**
   * `url` is raw user input. The core normalises it with the same classifier the address bar uses
   * and rejects a search term, so a row can never silently become a search for whatever was typed.
   * Ignored for a folder, which has no address.
   */
  'bookmarks:create': {
    request: z.object({
      kind: z.enum(BOOKMARK_KINDS),
      title: z.string(),
      url: z.string().optional(),
      /** A root id or a folder id; the core files it under other bookmarks when omitted. */
      parentId: z.string().optional(),
      index: z.number().int().nonnegative().optional()
    }),
    response: bookmarkSchema
  },
  /** Title only, on purpose: the address is `bookmarks:relocate`, which keeps more. */
  'bookmarks:update': {
    request: z.object({ id: z.string(), title: z.string().optional() }),
    response: bookmarkSchema
  },
  /** Reports how many nodes went, because deleting a folder deletes its whole subtree. */
  'bookmarks:remove': { request: z.object({ id: z.string() }), response: removedCount },
  /** Answers with the new tree, so the page never redraws from a position it guessed. */
  'bookmarks:move': {
    request: z.object({
      id: z.string(),
      parentId: z.string(),
      toIndex: z.number().int().nonnegative()
    }),
    response: z.array(bookmarkSchema)
  },
  /**
   * Points a bookmark at a new address, keeping the title, the folder and the position.
   *
   * Its own channel rather than a field on `bookmarks:update`, because the two differ in what they
   * keep — and the title is only re-derived when it *was* the old address.
   */
  'bookmarks:relocate': {
    request: z.object({ id: z.string(), url: z.string() }),
    response: bookmarkSchema
  },
  /**
   * Follows a bookmark in the tab that asked.
   *
   * Deliberately not `nav:navigate`: the core resolves the target from the sender, so the bookmarks
   * page cannot steer any other tab. Same reasoning as `quicklinks:open` and `history:open`, and the
   * same `openableUrl` — the channel that needed it most, since this page may also write the tree.
   */
  'bookmarks:open': {
    request: z.object({ url: openableUrl }),
    response: z.object({ url: z.string() })
  },
  /**
   * Opens the OS file picker in the core and grafts what the user chose into the tree.
   *
   * No payload: the path is chosen through the picker rather than passed in, so a compromised
   * renderer cannot ask the core to read an arbitrary file and hand back its contents. The rule
   * `extensions:load` established.
   */
  'bookmarks:import': {
    request: nothing,
    response: z.object({
      imported: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      /** True when the picker was closed. Not an error, and not "nothing was imported". */
      cancelled: z.boolean()
    })
  },

  // --- downloads -----------------------------------------------------------
  /**
   * Everything the asking window may see, freshly probed.
   *
   * The probe cache is emptied for this call and reused for the pushed `downloads:changed`. That
   * split is deliberate: what somebody is looking at is worth a stat call per row, what is pushed
   * at them four times a second is not.
   */
  'downloads:list': { request: nothing, response: downloadListingSchema },
  /**
   * Opens a completed download, or reports that it cannot be opened.
   *
   * Re-probed here, ignoring the memo, and that makes this the authoritative check: between the row
   * being drawn and this click the file can have been deleted. `false` plus a refreshed list is the
   * honest answer; a native error naming a path is not.
   */
  'downloads:open': { request: downloadIdRequest, response: z.object({ opened: z.boolean() }) },
  'downloads:reveal': { request: downloadIdRequest, response: z.object({ revealed: z.boolean() }) },
  /** Forgets a row, cancelling first if it is still running. The finished file is left alone. */
  'downloads:remove': { request: downloadIdRequest, response: z.object({ removed: z.boolean() }) },
  /** Forgets every finished row. Anything still running stays; see `clearFinishedDownloads`. */
  'downloads:clear': { request: nothing, response: removedCount },
  'downloads:pause': { request: downloadIdRequest, response: downloadChanged },
  /**
   * Resumes a paused download, or reports that it cannot: `changed: false` when the server does
   * not support range requests. Electron would otherwise discard what has arrived and start again,
   * and a silent restart of a nine-tenths-finished file is worse than a button saying it cannot.
   */
  'downloads:resume': { request: downloadIdRequest, response: downloadChanged },
  'downloads:cancel': { request: downloadIdRequest, response: downloadChanged },
  /**
   * The sending window's button summary, now. The very schema the push uses, not a copy of it, so
   * what the first picture may carry cannot drift from what every later one may.
   */
  'downloads:summary': { request: nothing, response: downloadButtonSummarySchema },

  // Declared beside their schemas so this file stays under its bar; the check below covers them too.
  ...passwordInvokeContract,
  ...omniboxInvokeContract,
  ...backupInvokeContract,
  ...importInvokeContract,
  ...workspaceInvokeContract
} satisfies Record<InvokeChannel, InvokeDefinition>

export type InvokeContract = typeof invokeContract

export type InvokeRequest<C extends InvokeChannel> = z.input<InvokeContract[C]['request']>
export type InvokeResponse<C extends InvokeChannel> = z.output<InvokeContract[C]['response']>
/** What a main-process handler receives: the parsed, validated request. */
export type InvokeHandlerArg<C extends InvokeChannel> = z.output<InvokeContract[C]['request']>

/**
 * Main -> renderer notifications. Same exhaustiveness guarantee as above.
 */
export const eventContract = {
  'window:stateChanged': windowStateSchema,
  'tabs:changed': z.object({
    tabs: z.array(tabStateSchema),
    activeTabId: z.string().nullable()
  }),
  'split:changed': splitStateSchema,
  'settings:changed': z.object({
    /** Only what actually changed, so the UI can react narrowly. */
    changed: z.record(z.string(), z.unknown()),
    snapshot: settingsSnapshotSchema
  }),
  /*
    The effective interface language, and nothing else.

    It exists so an open internal tab can re-read its catalogue without being handed
    `settings:changed`, which carries the whole snapshot. Every internal page needs to know the
    language; none of them needs to know the user's configuration to find it out, and the reader
    page renders harvested website text, so the narrow channel is worth its own entry.

    Already resolved, never `'system'`: that preference is answered with `app.getLocale()`, which
    only the core can ask. A page told `'system'` would have to guess, and `resolveLocale` does not
    know the value — it would quietly fall back to English.
  */
  'locale:changed': z.object({ locale: localeSchema }),
  /**
   * A shortcut the OS delivered to the window but that has no menu item.
   * The renderer decides what to do, which keeps focus-sensitive behaviour
   * (spec 9: shortcuts must not hijack text input) in the layer that knows
   * where the caret is.
   */
  'shortcut:triggered': z.object({ action: z.string() }),
  /**
   * Pushed to the start page and to the chrome UI, so a tile added from one
   * window appears in another without a reload.
   */
  'quicklinks:changed': z.object({ links: z.array(quickLinkCardSchema) }),
  'tabgroups:changed': z.object({ groups: z.array(tabGroupSchema) }),
  'media:changed': mediaFindingListSchema,
  /**
   * The download list, pushed.
   *
   * The same shape `downloads:list` answers with, so the page applies both through one function and
   * cannot render a pushed list differently from a pulled one. Sent per window, because
   * `privateWindow` is a fact about the receiver rather than about the list.
   */
  'downloads:changed': downloadListingSchema,
  /**
   * The window's download button, pushed to its chrome UI.
   *
   * Sent when the summary changes, and again every time the window presents its downloads panel,
   * changed or not — presenting is what marks the window's outcomes as seen, and the button has to
   * drop its mark then rather than at the next download event.
   */
  'downloads:summaryChanged': downloadButtonSummarySchema,
  /** The toolbar key's state, pushed to each window's chrome UI when the vault locks. No names. */
  'passwords:autofillStateChanged': autofillKeyStateSchema,
  /** `null` means nothing is presented — an explicit state, not an absent message. */
  'overlay:presented': z.object({ presentation: overlayPresentationSchema.nullable() })
} satisfies Record<EventChannel, z.ZodType>

export type EventContract = typeof eventContract

export type EventPayload<C extends EventChannel> = z.output<EventContract[C]>
