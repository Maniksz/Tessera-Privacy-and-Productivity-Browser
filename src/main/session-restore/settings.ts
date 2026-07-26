import type { SettingsSnapshot } from '@shared/settings/definitions.js'
import type { RestoreSettings } from '@shared/session/restore.js'

/**
 * The settings a restore obeys, read out of the snapshot.
 *
 * Here rather than in `shared/session` so the pure rules stay free of the module that
 * holds the schemas, and so this mapping is typed against the real `SettingsSnapshot` — a
 * renamed or retyped settings key is then a compile error here instead of a restore that
 * silently reads `undefined` and decides "no".
 *
 * ## Why either session key counts as asking
 *
 * The settings express this twice, and they did so before restore existed:
 * `session.startupBehaviour` has a `'restore'` option *and* `session.restoreOnStart` is a
 * boolean of its own. Honouring only one of them would make the other a switch that flips
 * and does nothing — the exact failure spec 5 forbids and the one this project already
 * found in `Strg+L`. So either asks, which is also the forgiving reading of a profile
 * where a user ticked the box and never opened the dropdown.
 *
 * The duplication itself is a defect in the settings, not here, and it wants resolving
 * in `definitions.ts`: two keys for one behaviour will eventually be shown as two
 * controls, and a user will set them against each other.
 */
export function restoreSettingsFrom(snapshot: SettingsSnapshot): RestoreSettings {
  return {
    wantsRestore:
      snapshot['session.startupBehaviour'] === 'restore' || snapshot['session.restoreOnStart'],
    afterCrash: snapshot['session.restoreAfterCrash'],
    restoreLayout: snapshot['splitView.restoreLayoutOnStart'],
    defaultLayout: snapshot['splitView.defaultLayout']
  }
}
