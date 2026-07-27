import { contextBridge } from 'electron'
import {
  EVENT_CHANNELS,
  INVOKE_CHANNELS,
  isEventChannel,
  isInvokeChannel
} from '@shared/ipc/channels.js'
import { makeInvoker, makeSubscriber, markPreloadRan, type Role } from './bridge.js'

/**
 * The preload for the browser's own interface, and the only bundle that contains the full bridge.
 *
 * Loaded by `preloadFile('chrome')` from two places, both of them our own code: the window itself
 * (`window-options.ts`, built by `BrowserWindowController`) and the overlay layer stacked above the
 * tab views (`OverlayLayer.ts`). No visited page, and no `tessera://` page, is ever given this file —
 * tab views get `index.ts` instead.
 *
 * ## Why this is a file of its own
 *
 * It used to be a branch inside the one preload, which meant every web page in every tab parsed the
 * chrome bridge and its channel tables to then be refused them. The bytes were the visible cost; the
 * real one was that the code which hands out the whole contract surface was loaded in the renderer a
 * hostile page runs in, and only a condition kept it from being called.
 *
 * As a separate file, none of that reaches a page. A spoofed role, a compromised content renderer, a
 * future edit that inverts a check — none of them can produce `window.tessera` in a web page, because
 * the function that would create it is not in the bundle that page loaded. That is a stronger
 * statement than any branch can make, and it is the reason for the split.
 *
 * ## What is left of the role argument
 *
 * A cross-check, not a switch. `additionalArguments` still carries the role, and this file refuses to
 * expose anything unless the view it landed in was created for the chrome role. So the *wrong* view
 * getting the *right* file — a tab view handed this bundle by a mistaken call — still ends in no
 * bridge rather than in a web page holding the full contract. Two independent facts have to agree
 * before the bridge appears: which file was loaded, and which role the core asked for.
 *
 * ## Two gates, not one
 *
 * This file decides what to expose; `main/ipc/sender-policy.ts` decides, from web contents identity,
 * what to accept. A renderer that has been taken over is exactly the case where this side's judgement
 * is worthless, so the core never relies on it (spec 6).
 */

const ROLE_PREFIX = '--tessera-role='

/**
 * The role the view was created with.
 *
 * Duplicated from `index.ts` rather than shared, for the reason given there: what a bundle does when
 * the role disagrees with it is the security-critical sentence about that bundle, and it should be
 * readable in the bundle's own file. `tests/preload-roles.test.ts` holds both copies to the same rule.
 */
function readRole(): Role {
  const argument = process.argv.find((value) => value.startsWith(ROLE_PREFIX))
  const role = argument?.slice(ROLE_PREFIX.length)
  // Least privilege by default: an unrecognised or absent role is content.
  return role === 'chrome' ? 'chrome' : 'content'
}

markPreloadRan('chrome')

if (readRole() === 'chrome') {
  // The trusted browser UI: full contract surface, still name-checked.
  contextBridge.exposeInMainWorld('tessera', {
    invoke: makeInvoker(isInvokeChannel, 'chrome UI'),
    on: makeSubscriber(isEventChannel),
    channels: { invoke: INVOKE_CHANNELS, event: EVENT_CHANNELS }
  })
} else {
  /*
    This bundle in a view that was not created for the chrome role.

    Nothing is exposed, and the mistake is reported: the renderer's symptom is a missing
    `window.tessera`, which says nothing about the cause. See `preloadFile()` in `src/main/paths.ts`
    for which view is supposed to get which file.
  */
  console.error('[preload] the chrome preload was loaded into a non-chrome view; no bridge exposed')
}

export {}
