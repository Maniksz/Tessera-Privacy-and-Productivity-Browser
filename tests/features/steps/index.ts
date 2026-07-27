/**
 * Registers every Gherkin step definition.
 *
 * Loaded via `setupFiles`, so the steps exist before any `.feature` runs. Step
 * expressions are global — one text, one definition — which is why they are split
 * by feature area but share the scenario scope in `world.ts`.
 */

import './settings.steps.js'
import './privacy.steps.js'
import './quicklinks.steps.js'
import './split-view.steps.js'
import './address-bar.steps.js'
import './window-layering.steps.js'
import './session-restore.steps.js'
import './find-in-page.steps.js'
import './bookmarks.steps.js'
import './downloads.steps.js'
import './reader-mode.steps.js'
import './content-blocker.steps.js'
