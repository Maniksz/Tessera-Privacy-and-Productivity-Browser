import type { MenuItemConstructorOptions } from 'electron'
import type { SecurityState } from '@shared/model.js'
import { PERMISSION_TOPICS, type PermissionTopic } from '@shared/overlay/permission.js'
import type { SitePermission } from '../permissions/model.js'
import { blockerMenuTemplate, type BlockerMenuDeps } from './blocker-menu-items.js'
import { menuLabel, type MenuLabelKey, type MenuTextKey } from './menu-text.js'

/**
 * The menu behind the lock in the address bar (U19, R33): everything that holds for the site in front of
 * the user, in one place.
 *
 * ## One menu, and why it absorbed the blocker's
 *
 * The shield next to the lock already opened a native menu about this site — what was blocked, the
 * per-site switch, the user's own rules. A second menu about the same site would have split one question
 * ("what is this page allowed to do to me, and what am I doing to it?") across two buttons, and the
 * answer to "why is this page broken?" can be in either half. So the blocker's items are carried in
 * unchanged (`blockerMenuTemplate`, still tested on its own) and both buttons open this (KTD13). Native
 * for the reason `blocker-menu-items.ts` gives: a DOM menu here would drop down behind the page.
 *
 * ## What is not in it
 *
 * Camera, microphone and screen sharing. Their behaviour stays exactly as it is today — that is a
 * standing decision, not a gap (Key Decisions, R33) — and listing a stored camera answer with a "forget"
 * next to it would change it. So those topics are neither shown nor forgotten: "forget all" covers what
 * the menu lists and nothing more, which is the part a count of the visible lines would get wrong.
 *
 * ## Zoom is the tile's, not the site's
 *
 * The user decided that on 29.07.2026 (`shared/zoom/model.ts` says why), so the three zoom entries act on
 * the pane the menu was opened for, through the same calls the toolbar's zoom badge and the View menu
 * make.
 *
 * The template is separate from the menu for the reason `tab-context-items.ts` gives: `Menu` needs
 * Electron and holds no decision, while everything here is one.
 */

/** Topics the menu leaves alone, listing and forgetting alike. */
export const UNLISTED_TOPICS: ReadonlySet<PermissionTopic> = new Set<PermissionTopic>([
  'camera',
  'microphone',
  'display-capture'
])

type ListedTopic = Exclude<PermissionTopic, 'camera' | 'microphone' | 'display-capture'>

/**
 * A menu name per listed topic.
 *
 * A record over the topics rather than a lookup with a fallback, so a topic added to `PERMISSION_TOPICS`
 * does not compile until somebody decides whether this menu shows it — and a new device topic is exactly
 * the kind that should join `UNLISTED_TOPICS` instead.
 */
const TOPIC_LABELS: Readonly<Record<ListedTopic, MenuTextKey>> = {
  geolocation: 'site.topic.geolocation',
  notifications: 'site.topic.notifications',
  'clipboard-read': 'site.topic.clipboardRead',
  'clipboard-write': 'site.topic.clipboardWrite',
  midi: 'site.topic.midi',
  'midi-sysex': 'site.topic.midiSysex',
  'storage-access': 'site.topic.storageAccess',
  'top-level-storage-access': 'site.topic.topLevelStorageAccess'
}

const SECURITY_LABELS: Readonly<Record<SecurityState, MenuLabelKey>> = {
  secure: 'omnibox.security.secure',
  insecure: 'omnibox.security.insecure',
  'invalid-certificate': 'omnibox.security.invalidCertificate',
  internal: 'omnibox.security.internal'
}

function isListed(topic: PermissionTopic): topic is ListedTopic {
  return !UNLISTED_TOPICS.has(topic)
}

/**
 * The origin a page's permission answers are stored under, or `null`.
 *
 * `URL.origin` for the same reason `permission-policy.ts` keys the store with it: the menu has to find
 * the entries the prompt wrote, so it has to spell the key the way the prompt did. An opaque origin —
 * the browser's own pages, `about:`, `file:` — serialises as `"null"`, and nothing is stored under that.
 */
export function permissionOriginOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

/** This origin's stored answers the menu may show, in the order the topics are declared. */
export function listedPermissions(
  sites: readonly SitePermission[],
  origin: string
): SitePermission[] {
  return sites
    .filter((site) => site.origin === origin && isListed(site.topic))
    .sort(
      (left, right) =>
        PERMISSION_TOPICS.indexOf(left.topic) - PERMISSION_TOPICS.indexOf(right.topic)
    )
}

export interface SiteMenuDeps extends BlockerMenuDeps {
  /** `TabState.security` of the tab the menu was opened for. */
  security: SecurityState
  /** Where this page's permission answers are keyed; `null` leaves the section out. */
  origin: string | null
  /**
   * True in a private window, whose answers are never stored (`PermissionStore.answersFor`).
   *
   * Said in the menu rather than shown as "no saved permissions", which would read as though the normal
   * profile had none either.
   */
  privateWindow: boolean
  /** What the store holds for this window's mode; filtered here to this origin and the listed topics. */
  storedPermissions: readonly SitePermission[]
  /** The tile's effective zoom, `appearance.defaultZoom` standing in for a pane never zoomed. */
  zoomPercent: number
  fingerprintMode: 'uniform' | 'off'
  /** Forgets exactly these topics for this origin. */
  onForgetPermissions(origin: string, topics: readonly PermissionTopic[]): void
  onZoom(step: 'in' | 'out' | 'reset'): void
  onSetFingerprintMode(mode: 'uniform' | 'off'): void
}

type Translate = (key: MenuLabelKey, params?: Record<string, string | number>) => string

export function siteMenuTemplate(deps: SiteMenuDeps): MenuItemConstructorOptions[] {
  const t: Translate = (key, params) => menuLabel(deps.locale, key, params)

  const items: MenuItemConstructorOptions[] = [
    // A statement, disabled for the reason the blocker's count is: it is the answer to what made the user
    // open the menu, and inside the menu it is reachable from the keyboard, which a tooltip is not.
    { label: t(SECURITY_LABELS[deps.security]), enabled: false },
    { type: 'separator' },
    ...blockerMenuTemplate(deps),
    { type: 'separator' }
  ]

  if (deps.origin !== null) {
    items.push(...permissionItems(deps, deps.origin, t), { type: 'separator' })
  }

  items.push(
    {
      label: t('site.zoom', { percent: deps.zoomPercent }),
      submenu: [
        { label: t('menu.view.zoomIn'), click: () => deps.onZoom('in') },
        { label: t('menu.view.zoomOut'), click: () => deps.onZoom('out') },
        { type: 'separator' },
        { label: t('menu.view.zoomReset'), click: () => deps.onZoom('reset') }
      ]
    },
    { type: 'separator' },
    {
      label: t('site.fingerprint'),
      type: 'checkbox',
      checked: deps.fingerprintMode === 'uniform',
      click: () => deps.onSetFingerprintMode(deps.fingerprintMode === 'uniform' ? 'off' : 'uniform')
    },
    /*
      The masking plan is computed per host when a page loads, and the setting is `applies: 'new-tab'`,
      so a tab that was open before the change keeps the plan it loaded with. Said here, under the switch,
      because this is where somebody flips it and then wonders why the page in front of them did not
      change.
    */
    { label: t('site.fingerprint.newTabs'), enabled: false }
  )

  return items
}

/**
 * One line per stored answer, each with its own "forget", and one "forget all" under them.
 *
 * The answer is in the label and the action one level down, so the state can be read at a glance without
 * a click doing anything — the same reason the blocker's rules are checkboxes rather than delete items.
 */
function permissionItems(
  deps: SiteMenuDeps,
  origin: string,
  t: Translate
): MenuItemConstructorOptions[] {
  // Checked here as well as by the store's forgetful answers: a private window must show nothing even if
  // a caller were ever to hand this the normal profile's list.
  if (deps.privateWindow) return [{ label: t('site.permissions.private'), enabled: false }]

  const listed = listedPermissions(deps.storedPermissions, origin)
  if (listed.length === 0) return [{ label: t('site.permissions.none'), enabled: false }]

  const items: MenuItemConstructorOptions[] = listed.map((site) => {
    // `listedPermissions` has already dropped the unlisted topics; the cast restates that for the record.
    const topic = t(TOPIC_LABELS[site.topic as ListedTopic])
    return {
      label: t(site.decision === 'allow' ? 'site.permission.allowed' : 'site.permission.blocked', {
        topic
      }),
      submenu: [
        {
          label: t('site.permission.forget'),
          click: () => deps.onForgetPermissions(origin, [site.topic])
        }
      ]
    }
  })
  items.push({
    label: t('site.permissions.forgetAll', { count: listed.length }),
    click: () =>
      deps.onForgetPermissions(
        origin,
        listed.map((site) => site.topic)
      )
  })
  return items
}
