import { z } from 'zod'
import { LAYOUT_IDS } from '../split/layout.js'
import { TILE_BAR_MODES } from '../split/tile-bar.js'
import { SETTINGS_SECTIONS } from './sections.js'
import type { SettingsApplies, SettingsSection } from './sections.js'

/**
 * THE single source of truth for every setting (spec 5).
 *
 * UI and core both read this table. There is no second naming scheme to drift
 * against, no mapping layer, no "core key" versus "UI key". A setting that is
 * not in this table does not exist: writing one fails loudly rather than being
 * dropped in silence.
 *
 * Each entry carries its own schema, its default, the settings section it
 * appears under, and how it takes effect. `applies: 'live'` is a promise to the
 * user that the switch works without a restart, and it is the default because
 * spec 5 requires it — anything needing a restart has to say so explicitly.
 */

// Sections and timing live in `sections.ts`, which has no heavy imports, so the
// settings UI can read them without pulling zod into the renderer bundle. Re-exported
// here as types only; a value re-export would defeat the split for anyone importing
// from this module.
export type { SettingsSection, SettingsApplies } from './sections.js'

export interface SettingDefinition<S extends z.ZodType = z.ZodType> {
  readonly schema: S
  readonly default: z.output<S>
  readonly section: SettingsSection
  readonly applies: SettingsApplies
}

/**
 * Ties a default to its own schema at the type level, so a default that the
 * schema would reject is a compile error rather than a startup crash.
 */
function def<S extends z.ZodType>(
  schema: S,
  defaultValue: z.output<S>,
  section: SettingsSection,
  applies: SettingsApplies = 'live'
): SettingDefinition<S> {
  return { schema, default: defaultValue, section, applies }
}

const percentage = z.number().int().min(30).max(300)

export const settingDefinitions = {
  // --- Darstellung -----------------------------------------------------------
  'appearance.theme': def(z.enum(['system', 'light', 'dark']), 'system', 'appearance'),
  'appearance.uiLanguage': def(z.enum(['system', 'de', 'en']), 'system', 'appearance'),
  'appearance.showBookmarksBar': def(z.boolean(), false, 'appearance'),
  'appearance.defaultZoom': def(percentage, 100, 'appearance'),
  'appearance.tabBarPosition': def(z.enum(['top', 'bottom']), 'top', 'appearance'),

  // --- Suche ---------------------------------------------------------------
  // Privacy-friendly default (spec 8). No engine that profiles the query.
  'search.defaultEngine': def(z.enum(['duckduckgo', 'startpage', 'brave', 'mojeek', 'custom']), 'duckduckgo', 'search'),
  'search.customEngineUrl': def(z.string(), '', 'search'),
  'search.suggestFromHistory': def(z.boolean(), true, 'search'),
  'search.suggestFromBookmarks': def(z.boolean(), true, 'search'),
  'search.suggestFromOpenTabs': def(z.boolean(), true, 'search'),
  // Off by default: remote suggestions send every keystroke to a third party.
  'search.remoteSuggestions': def(z.boolean(), false, 'search'),

  // --- Split View ----------------------------------------------------------
  'splitView.defaultLayout': def(z.enum(LAYOUT_IDS), '1x1', 'splitView'),
  'splitView.restoreLayoutOnStart': def(z.boolean(), true, 'splitView'),
  'splitView.showTileHeaders': def(z.boolean(), true, 'splitView'),
  /**
   * Keep the number of tiles matched to the tabs in them.
   *
   * Growing the layout gives every empty tile a start-page tab, and closing a tab takes its
   * tile away again. One switch for both directions because they are the same idea: a layout
   * with empty panes is an instruction rather than a browser, and a pane left behind by a closed
   * tab is the same thing.
   *
   * On by default. It is a setting rather than a rule because each filler is a renderer process,
   * which is real memory on a modest machine.
   */
  'splitView.adaptLayoutToTabs': def(z.boolean(), true, 'splitView'),
  /**
   * Website fullscreen inside a split layout stays within its own tile
   * (spec 2). `window` reverts to conventional browser behaviour for users who
   * want it.
   */
  'splitView.fullscreenScope': def(z.enum(['tile', 'window']), 'tile', 'splitView'),
  'splitView.onlyActiveTileAudible': def(z.boolean(), false, 'splitView'),
  'splitView.muteAllButActive': def(z.boolean(), false, 'splitView'),
  /**
   * Chromium throttles background content by default, which would stall the
   * videos in unfocused tiles — the exact thing split view exists to avoid
   * (spec 2). Leaving this on is a supported escape hatch for battery-bound
   * machines, but it is off by default.
   */
  'splitView.throttleInactiveTiles': def(z.boolean(), false, 'splitView', 'new-tab'),
  /**
   * When each tile shows its own navigation bar.
   *
   * `hover` reveals it as the pointer nears a tile's top edge; `keyboard` only on the shortcut, for somebody
   * who finds a bar appearing under the pointer distracting; `off` not at all. Default `hover`, because a
   * feature nobody discovers is a feature nobody uses — and the keyboard route exists in every mode but
   * `off`, so it is never pointer-only (spec 7).
   */
  'splitView.tileBarMode': def(z.enum(TILE_BAR_MODES), 'hover', 'splitView'),
  'splitView.autoplayInTiles': def(z.enum(['allow', 'block']), 'allow', 'splitView', 'new-tab'),

  // --- Datenschutz ---------------------------------------------------------
  'privacy.blockerEnabled': def(z.boolean(), true, 'privacy'),
  /**
   * The lists enabled on a fresh profile.
   *
   * EasyList and EasyPrivacy are the pair both uBlock Origin and AdGuard build on: adverts and
   * trackers, around a hundred thousand rules, very few false positives. Cookie Monster removes the
   * consent banners, and uBO's annoyances list defuses anti-adblock walls — the sites that detect a
   * blocker and refuse to show anything.
   *
   * The last two are the ones with a cost: they touch page layout rather than network requests, so a
   * false positive hides something the user wanted. They are on by default because being asked
   * about cookies on every site is a certainty and a hidden element is a possibility, and both are
   * one switch away in the settings.
   */
  'privacy.blockerLists': def(
    z.array(z.url()),
    [
      'https://easylist.to/easylist/easylist.txt',
      'https://easylist.to/easylist/easyprivacy.txt',
      'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
      'https://ublockorigin.github.io/uAssets/filters/annoyances-others.txt'
    ],
    'privacy'
  ),
  'privacy.cosmeticFiltering': def(z.boolean(), true, 'privacy'),
  'privacy.blockRedirectTrackers': def(z.boolean(), true, 'privacy'),
  'privacy.stripTrackingParameters': def(z.boolean(), true, 'privacy'),
  'privacy.blockTelemetryDomains': def(z.boolean(), true, 'privacy'),
  'privacy.httpsOnlyMode': def(z.boolean(), true, 'privacy'),
  'privacy.blockThirdPartyCookies': def(z.boolean(), true, 'privacy'),
  'privacy.referrerPolicy': def(z.enum(['origin-only', 'strict', 'default']), 'origin-only', 'privacy'),
  'privacy.sendDoNotTrack': def(z.boolean(), true, 'privacy'),
  'privacy.sendGlobalPrivacyControl': def(z.boolean(), true, 'privacy'),
  'privacy.partitionStatePerSite': def(z.boolean(), true, 'privacy', 'restart'),
  /**
   * Cloud-based lookup would hand every visited address to a third party, so
   * the local blocklist is the default and the trade-off is stated in the UI
   * rather than hidden (spec 4).
   */
  'privacy.malwareProtection': def(z.enum(['local-list', 'off']), 'local-list', 'privacy'),

  // --- Fingerprinting ------------------------------------------------------
  // Masking must be consistent, never random: contradictory values make a user
  // *more* identifiable, which is worse than no measure at all (spec 4).
  'fingerprint.mode': def(z.enum(['uniform', 'off']), 'uniform', 'privacy', 'new-tab'),
  'fingerprint.normalizeUserAgent': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.normalizeClientHints': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.normalizeAcceptLanguage': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.maskCanvas': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.maskWebgl': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.maskAudio': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.limitFonts': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.normalizeScreen': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.blockDeviceApis': def(z.boolean(), true, 'privacy', 'new-tab'),
  'fingerprint.spoofTimezone': def(z.string(), '', 'privacy', 'new-tab'),
  'fingerprint.spoofLocale': def(z.string(), '', 'privacy', 'new-tab'),

  // --- Berechtigungen ------------------------------------------------------
  // Everything denied until the user says otherwise (spec 4). Chromium's
  // default is to auto-approve, so these are load-bearing.
  'permissions.geolocation': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),
  'permissions.camera': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),
  'permissions.microphone': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),
  'permissions.notifications': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),
  'permissions.clipboard': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),
  'permissions.displayCapture': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),
  'permissions.persistentStorage': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),
  'permissions.midi': def(z.enum(['ask', 'allow', 'deny']), 'deny', 'permissions'),

  // --- Netzwerk ------------------------------------------------------------
  'network.proxyMode': def(z.enum(['direct', 'system', 'manual']), 'direct', 'network', 'restart'),
  'network.proxyUrl': def(z.string(), '', 'network', 'restart'),
  /** No traffic at all if the tunnel drops (spec 4). */
  'network.killSwitch': def(z.boolean(), true, 'network'),
  'network.secureDnsMode': def(z.enum(['secure', 'automatic', 'off']), 'secure', 'network'),
  'network.secureDnsServers': def(
    z.array(z.string()),
    ['https://dns.quad9.net/dns-query', 'https://base.dns.mullvad.net/dns-query'],
    'network'
  ),
  /** Closes the local-IP leak that survives an active VPN (spec 4). */
  'network.webrtcIpPolicy': def(
    z.enum(['default', 'default_public_interface_only', 'disable_non_proxied_udp']),
    'disable_non_proxied_udp',
    'network'
  ),

  // --- Downloads -----------------------------------------------------------
  'downloads.directory': def(z.string(), '', 'downloads'),
  'downloads.askForEachFile': def(z.boolean(), false, 'downloads'),

  // --- Sitzung -------------------------------------------------------------
  'session.startupBehaviour': def(
    z.enum(['speed-dial', 'blank', 'restore', 'custom-url']),
    'speed-dial',
    'session'
  ),
  'session.customStartupUrl': def(z.string(), '', 'session'),
  /** Honoured for real, not just stored (spec 3). */
  'session.restoreOnStart': def(z.boolean(), false, 'session'),
  'session.restoreAfterCrash': def(z.boolean(), true, 'session'),

  // --- Daten löschen -------------------------------------------------------
  'clearData.onExit': def(z.boolean(), false, 'clearData'),
  'clearData.onExitCategories': def(
    z.array(z.enum(['cookies', 'cache', 'storage', 'history', 'downloads', 'formData'])),
    ['cookies', 'cache', 'storage'],
    'clearData'
  ),

  // --- Erweitert -----------------------------------------------------------
  'advanced.hardwareAcceleration': def(z.boolean(), true, 'advanced', 'restart'),
  'advanced.spellcheck': def(z.boolean(), true, 'advanced'),
  'advanced.spellcheckLanguages': def(z.array(z.string()), ['de-DE', 'en-US'], 'advanced'),
  'advanced.unloadInactiveTabs': def(z.boolean(), true, 'advanced'),
  'advanced.unloadAfterMinutes': def(z.number().int().min(1).max(1440), 30, 'advanced'),
  'advanced.autoUpdate': def(z.boolean(), true, 'advanced'),
  'advanced.customShortcuts': def(z.record(z.string(), z.string()), {}, 'advanced')
} satisfies Record<string, SettingDefinition>

export type SettingsKey = keyof typeof settingDefinitions

export type SettingValue<K extends SettingsKey> = z.output<(typeof settingDefinitions)[K]['schema']>

export type SettingsSnapshot = {
  readonly [K in SettingsKey]: SettingValue<K>
}

export const SETTINGS_KEYS = Object.keys(settingDefinitions) as SettingsKey[]

export function isSettingsKey(value: unknown): value is SettingsKey {
  return typeof value === 'string' && Object.hasOwn(settingDefinitions, value)
}

/**
 * Whole-snapshot schema. Strict on purpose: an unknown key is an error, which
 * is what turns a typo into a visible failure instead of a switch that flips
 * and does nothing (spec 5).
 */
export const settingsSnapshotSchema = z.strictObject(
  Object.fromEntries(
    Object.entries(settingDefinitions).map(([key, definition]) => [key, definition.schema])
  ) as { [K in SettingsKey]: (typeof settingDefinitions)[K]['schema'] }
)

export function defaultSettings(): SettingsSnapshot {
  return Object.fromEntries(
    Object.entries(settingDefinitions).map(([key, definition]) => [key, definition.default])
  ) as unknown as SettingsSnapshot
}

export function sectionOf(key: SettingsKey): SettingsSection {
  return settingDefinitions[key].section
}

export function appliesOf(key: SettingsKey): SettingsApplies {
  return settingDefinitions[key].applies
}

/** Keys grouped by section, for rendering the settings pages. */
export function keysBySection(): Readonly<Record<SettingsSection, readonly SettingsKey[]>> {
  const grouped = Object.fromEntries(SETTINGS_SECTIONS.map((s) => [s, [] as SettingsKey[]])) as Record<
    SettingsSection,
    SettingsKey[]
  >
  for (const key of SETTINGS_KEYS) grouped[sectionOf(key)].push(key)
  return grouped
}
