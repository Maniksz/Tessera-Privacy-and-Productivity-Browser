import { join } from 'node:path'
import { app } from 'electron'
import type { Platform } from '@shared/model.js'
import { FILTER_LIST_CACHE_DIRNAME } from './privacy/FilterListStore.js'

/**
 * Filesystem locations (spec 10: use each platform's intended directories, no
 * hard-coded paths).
 *
 * Electron's `app.getPath` already resolves to the right place per platform —
 * `%APPDATA%` on Windows, `~/.config` on Linux, `~/Library/Application Support`
 * on macOS — so everything is derived from it rather than assembled by hand.
 */

export function currentPlatform(): Platform {
  switch (process.platform) {
    case 'win32':
      return 'win32'
    case 'darwin':
      return 'darwin'
    default:
      // Every other Electron target behaves like Linux for our purposes.
      return 'linux'
  }
}

/** Configuration and user data: settings, bookmarks, history, passwords. */
export function userDataDir(): string {
  return app.getPath('userData')
}

/** Discardable data. Losing this must never lose user data. */
export function cacheDir(): string {
  return app.getPath('sessionData')
}

export function settingsFile(): string {
  return join(userDataDir(), 'settings.json')
}

export function sessionStateFile(): string {
  return join(userDataDir(), 'session.json')
}

/**
 * The two Chromium switches that must be known before the application is ready.
 *
 * A separate, unencrypted file on purpose — see `src/main/startup-flags.ts` for why the settings
 * file cannot serve this and why these two values are safe to leave readable.
 */
export function startupFlagsFile(): string {
  return join(userDataDir(), 'startup-flags.json')
}

/** Folders of unpacked extensions to reload at startup. */
export function extensionsFile(): string {
  return join(userDataDir(), 'extensions.json')
}

/** Start-page quick links (spec 1). User data, not cache: never discardable. */
export function quickLinksFile(): string {
  return join(userDataDir(), 'quicklinks.json')
}

/**
 * The key every local document is encrypted with, wrapped by the OS key store.
 *
 * It sits with the data it protects on purpose. Wrapped, the file is useless
 * without the user's keychain, and keeping it inside the profile means copying a
 * profile between machines fails visibly instead of half-working.
 */
export function localDataKeyFile(): string {
  return join(userDataDir(), 'local-data.key')
}

/**
 * Notice written when there is no key store and the data is therefore readable.
 *
 * In the profile directory rather than a log, because it has to be found next to
 * the unprotected files by someone who never opens a console. Named in capitals for
 * the same reason. `openLocalDataProtection` removes it once a key store appears.
 */
export function unencryptedDataNoticeFile(): string {
  return join(userDataDir(), 'LOCAL-DATA-NOT-ENCRYPTED.txt')
}

/**
 * Browsing history.
 *
 * User data, not cache. `cacheDir()` maps to `sessionData`, which Electron and the
 * platform both treat as discardable — putting history there would mean a cache clear,
 * a disk cleaner or a profile reset silently erasing what the user visited, and
 * "losing this must never lose user data" is exactly the line that directory draws.
 */
export function historyFile(): string {
  return join(userDataDir(), 'history.json')
}

/**
 * Tab groups.
 *
 * User data rather than cache: a group is something the user made, with a name and a colour they
 * chose. That it currently cannot survive a restart is a *missing feature* — session restore — and
 * not a reason to file it somewhere a disk cleaner may remove. See `retainTabs`.
 */
export function tabGroupsFile(): string {
  return join(userDataDir(), 'tab-groups.json')
}

/**
 * Per-site permission answers.
 *
 * User data, not cache. A disk cleaner emptying this would mean every site asking for the camera again —
 * which is not data loss in the usual sense but is exactly the nagging a remembered answer exists to
 * prevent, and the user would have no idea why it came back.
 */
export function permissionsFile(): string {
  return join(userDataDir(), 'permissions.json')
}

/**
 * The user's own blocking rules — what the element picker writes.
 *
 * User data, emphatically. Every other filter rule can be downloaded again; these are the ones the
 * person made by hand, one element at a time, and a cache clear must not take them.
 */
export function userRulesFile(): string {
  return join(userDataDir(), 'user-rules.json')
}

/** Bookmarks: a tree the user built by hand. User data, never discardable. */
export function bookmarksFile(): string {
  return join(userDataDir(), 'bookmarks.json')
}

/**
 * The download history.
 *
 * User data rather than cache, and the distinction bites here: the *files* are wherever the user chose, and this
 * is only the record of them. Losing it would not lose a download, but it would lose the only list that says
 * where each one went.
 */
export function downloadsFile(): string {
  return join(userDataDir(), 'downloads.json')
}

/**
 * Saved credentials.
 *
 * The most sensitive file this browser writes, and it goes through the same envelope as every other — see
 * `local-data-protection.ts`. The important consequence is stated there rather than here: without an OS key
 * store the envelope is unavailable and the file is readable, which the browser says out loud in a file named
 * in capitals next to it.
 */
export function passwordsFile(): string {
  return join(userDataDir(), 'passwords.json')
}

/**
 * The vault's own key, wrapped by the OS key store and — once one is set — by the master password.
 *
 * Beside the document it seals, for the reason `localDataKeyFile` gives: wrapped, the file is useless
 * without the keychain or the password, and keeping it inside the profile means copying a profile between
 * machines fails visibly instead of half-working.
 *
 * Separate from `local-data.key` on purpose, and that separation is the whole design of the lock. The
 * profile-wide key has to be usable at startup with nobody present, so it can never be behind a password;
 * this one can, which is what lets the vault be closed while history and settings are open. See
 * `crypto/vault-key.ts`.
 *
 * Spelled here rather than inline in `index.ts`, which is where it started: this file owns every path in
 * the application, and a path assembled at its one call site is a path the next caller assembles
 * differently — which for a key file means a vault nobody can open.
 */
export function passwordVaultKeyFile(): string {
  return join(userDataDir(), 'passwords.key')
}

/** Locally stored favicons — never fetched from a third-party service (spec 1). */
export function faviconCacheDir(): string {
  return join(cacheDir(), 'favicons')
}

/**
 * Start-page screenshots, taken locally.
 *
 * Cache rather than user data, and deliberately: every picture can be taken again by visiting the
 * page, so losing the directory costs nothing the user typed. It also means these go with the
 * `cache` category of "clear data" — which is the right default for a directory holding pictures of
 * pages somebody visited.
 */
export function thumbnailCacheDir(): string {
  return join(cacheDir(), 'thumbnails')
}

/**
 * Downloaded filter lists.
 *
 * Cache, and the distinction is load-bearing: losing this directory costs one download per list and
 * nothing the user made. The name comes from `FILTER_LIST_CACHE_DIRNAME` so the store and the wiring
 * cannot disagree about it.
 */
export function filterListCacheDir(): string {
  return join(cacheDir(), FILTER_LIST_CACHE_DIRNAME)
}

export function defaultDownloadsDir(): string {
  return app.getPath('downloads')
}

/** Which preload a renderer gets. A file each, not a flag — see `preloadFile`. */
export type PreloadRole = 'chrome' | 'content'

/**
 * The built preload bundle for a role, emitted by electron-vite as CommonJS.
 *
 * Two bundles, and which one a view is given is the *whole* of its bridge privilege:
 *
 *   - `content` — `index.cjs`, for tab views. Fingerprint masking, cosmetic filtering, the element
 *     picker, autofill, and the narrow allowlist a `tessera://` page gets. No chrome bridge exists
 *     inside it, so no page loading it can be given one however the role is spoofed.
 *   - `chrome` — `chrome.cjs`, for the window and the overlay layer. The full contract surface, and
 *     none of the per-document machinery those two have no document to apply it to.
 *
 * Content keeps the default name on purpose. `index.cjs` is what a stale path, a hand-written
 * `webPreferences` or a future copy-paste will name, and the file that answers to the obvious name
 * should be the one with the least in it. It is also the file `scripts/metrics.mjs` weighs, which is
 * right: the budget exists because a tab view parses its preload once per page.
 *
 * Getting this wrong fails at runtime rather than at build time — a view whose bridge is absent —
 * so `tests/preload-roles.test.ts` checks each call site against the role its view actually has.
 */
export function preloadFile(role: PreloadRole): string {
  return join(__dirname, '../preload', role === 'chrome' ? 'chrome.cjs' : 'index.cjs')
}

export const PRELOAD_ROLE_PREFIX = '--tessera-role='

/**
 * The argument that tells a preload which role its renderer was created for.
 *
 * Kept after the split, with a smaller job: it no longer *chooses* what to expose — the file does
 * that — and is instead the second of two facts that have to agree before a bridge appears. Each
 * entry compares the role it was given against the role it is, and exposes nothing when they differ.
 * So a view handed the wrong bundle ends with no bridge and a line in the console, rather than with
 * privileges nobody meant to grant.
 *
 * Set by the main process per renderer, which is the only source page content cannot influence —
 * unlike a URL, which a dev server or a crafted address can make ambiguous.
 */
export function preloadRoleArgument(role: PreloadRole): string {
  return `${PRELOAD_ROLE_PREFIX}${role}`
}
