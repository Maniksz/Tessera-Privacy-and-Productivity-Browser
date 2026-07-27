import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, dialog, shell, type BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { Locale } from '@shared/i18n/catalog.js'
import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import { currentPlatform } from '../paths.js'
import {
  UpdateService,
  type UpdateAnswer,
  type UpdateFeedResult,
  type UpdatePrompt,
  type UpdaterPort
} from './UpdateService.js'

/**
 * The Electron half of the update check, and nothing else.
 *
 * Every decision — whether to check, what a person is offered, what a failure says, which platform
 * gets a download and which gets a web page — lives in `UpdateService`, which is covered in full.
 * What is left here is translation: `electron-updater`'s events and throws into the total results
 * that service reads, and its presentations into `dialog.showMessageBox`. That is the same split as
 * `install-autofill.ts`, `CosmeticInjector` and `ElementPicker`, and the same reason this file is in
 * the coverage exclusions: it cannot run outside a browser process, and there is nothing left in it
 * to decide.
 *
 * ## The identifier this closes
 *
 * `electron-updater` sends `x-user-staging-id` on the check, and fills it with a random UUID it
 * creates once and keeps in `<userData>/.updaterId`. That is a permanent per-installation identifier
 * attached to every update check — precisely what `electron-builder.yml` promises this check does not
 * carry, and the promise was untrue the moment anything called `checkForUpdates`.
 *
 * Two lines close it, and both are needed:
 *
 *   - `requestHeaders` overrides the header with the **nil UUID**, which is what actually goes over
 *     the wire (`computeFinalHeaders` assigns `requestHeaders` last, so it wins).
 *   - the file is written with the same nil UUID before the first check, so no unique value is ever
 *     generated on disk either. Without this the identifier would merely be unsent — one edit away
 *     from being sent again, and meanwhile sitting in the profile.
 *
 * The nil UUID is a value the library accepts (`UUID.check` names it explicitly) and it feeds only
 * one other thing: the staged-rollout percentage, where it reads as 0 and therefore always inside
 * the rollout. That is the safe direction — a browser must not be held back from a security fix —
 * and no release this project publishes sets a staging percentage at all.
 */

/** `00000000-0000-0000-0000-000000000000`: a valid UUID that identifies nobody. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * The name `electron-updater` reads its staging id from, relative to the profile.
 *
 * Spelled out because the library gives no way to configure it. If a future version renames the
 * file, the override on `requestHeaders` still holds — which is the reason there are two measures
 * and not one.
 */
const STAGING_ID_FILE = '.updaterId'

export interface InstallUpdatesOptions {
  readonly getSettings: () => SettingsSnapshot
  readonly locale: () => Locale
  /**
   * The window a message box is modal to, or `null` for none.
   *
   * A parent makes the box modal to that window, which is what stops somebody pressing the menu item
   * again behind it. `null` is a real case rather than a fallback — on macOS the application keeps
   * running with no windows — and Electron takes an optional parent, so it needs no cast.
   */
  readonly parentWindow: () => BrowserWindow | null
}

/**
 * Builds the service, hands it the real ports and starts the recurring check.
 *
 * Returns it, because the Help menu needs `checkNow()`. Starting here rather than leaving it to the
 * caller is deliberate: `installAutofill()` was written, tested and never called, and autofill
 * therefore did not run at all. A factory that returns something un-started is the same trap with a
 * different name.
 */
export function installUpdateChecks(options: InstallUpdatesOptions): UpdateService {
  const service = new UpdateService({
    updater: electronUpdaterPort(),
    getSettings: options.getSettings,
    locale: options.locale,
    currentVersion: () => app.getVersion(),
    platform: currentPlatform(),
    showPrompt: (prompt) => showPrompt(prompt, options.parentWindow()),
    openReleasePage: (url) => {
      void shell.openExternal(url)
    }
  })
  service.start()
  return service
}

function electronUpdaterPort(): UpdaterPort {
  /*
    The library's own logging, off.

    Its default logger is `console`, and a failed check prints a stack trace with a URL in it. A check
    that fails is ordinary — offline, rate-limited, nothing published — and `UpdateService` says the
    one line that is worth saying. A stack trace per failed check is noise that hides the real ones.
  */
  autoUpdater.logger = null
  autoUpdater.requestHeaders = { 'x-user-staging-id': NIL_UUID }

  let neutralised: Promise<void> | null = null
  const neutraliseStagingId = async (): Promise<void> => {
    neutralised ??= writeFile(join(app.getPath('userData'), STAGING_ID_FILE), NIL_UUID, 'utf8').catch(
      (error: unknown) => {
        // Best effort. The header override is what keeps the id off the network; this only keeps a
        // unique one from existing locally, so a profile that cannot be written to costs nothing
        // more than that.
        console.warn('[updates] could not neutralise the staging id file:', String(error))
      }
    )
    await neutralised
  }

  return {
    configure: (policy) => {
      autoUpdater.autoDownload = policy.autoDownload
      autoUpdater.autoInstallOnAppQuit = policy.autoInstallOnAppQuit
      autoUpdater.allowPrerelease = policy.allowPrerelease
    },

    check: async (): Promise<UpdateFeedResult> => {
      await neutraliseStagingId()
      try {
        const result = await autoUpdater.checkForUpdates()
        // `null` means the updater is inactive: not packaged, so there is no `app-update.yml`.
        if (result === null) return { kind: 'no-feed' }
        return { kind: 'offer', version: result.updateInfo.version }
      } catch (error) {
        return classifyCheckFailure(error)
      }
    },

    download: async () => {
      try {
        await autoUpdater.downloadUpdate()
        return { kind: 'downloaded' }
      } catch (error) {
        return { kind: 'failed', detail: String(error) }
      }
    },

    /*
      The defaults, named rather than left implicit: not silent, and run afterwards.

      `quitAndInstall()` closes the windows and quits, which goes through `before-quit` in
      `index.ts` — so the flush that writes history, bookmarks and the session still happens on the
      way into the installer.
    */
    installAndRestart: () => {
      autoUpdater.quitAndInstall(false, true)
    }
  }
}

/**
 * Which of the ordinary failures this was.
 *
 * Matched on `electron-updater`'s own error codes, which is the brittle part and the reason it is
 * here rather than in the service: a renamed code degrades to "unreachable", which is a true
 * sentence about every one of these cases. The two named separately are the ones where "GitHub could
 * not be reached" would be a lie — the repository was reached and has nothing to offer.
 */
function classifyCheckFailure(error: unknown): UpdateFeedResult {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined
  if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' || code === 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND') {
    return { kind: 'nothing-published' }
  }
  return { kind: 'unreachable', detail: String(error) }
}

async function showPrompt(prompt: UpdatePrompt, parent: BrowserWindow | null): Promise<UpdateAnswer> {
  const options: Electron.MessageBoxOptions = {
    type: prompt.severity,
    title: prompt.title,
    message: prompt.message,
    ...(prompt.detail === undefined ? {} : { detail: prompt.detail }),
    buttons: prompt.buttons.map((button) => button.label),
    // The first button is the platform's default; the cancel one is what Escape picks. Both come
    // from the presentation, because which button is safe is a decision and not a layout detail.
    defaultId: 0,
    cancelId: prompt.cancelIndex
  }

  const answer = await (parent === null
    ? dialog.showMessageBox(options)
    : dialog.showMessageBox(parent, options))

  const [chosen] = prompt.buttons.slice(answer.response, answer.response + 1)
  // A response outside the buttons we offered can only mean the box was dismissed, and dismissing
  // has to mean "do nothing" rather than "do the first thing".
  return chosen?.answer ?? 'dismiss'
}
