/**
 * Runs the application's own checks against the built application.
 *
 *   node scripts/smoke.mjs        (or: pnpm run test:smoke, which builds first)
 *
 * All this does is start the built application with `--run-checks=<module>` and pass on its exit
 * status. The checks themselves are in `smoke-checks.mjs` and run *inside* the browser process, where
 * `webContents.executeJavaScript` and `sendInputEvent` are ordinary method calls.
 *
 * ## Why there is nothing else here
 *
 * This script used to be the driver: it started the application with a debugging port open, found each
 * renderer by asking that port for its target list, and spoke CDP to each over a WebSocket. That is the
 * standard technique for reading cookies and saved passwords out of a browser, so endpoint protection
 * flags the shape rather than the intent — a different port or a second attempt changes nothing, and
 * the alert goes to somebody's IT department. The checks were never the problem; the driver was.
 *
 * Exits 0 when every check passed and non-zero otherwise; how many failed, and which, is printed by
 * the checks as they run.
 */

import { spawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** A profile of its own, wiped first: the checks count filter lists, quick links and history. */
const PROFILE = join(tmpdir(), 'tessera-smoke-profile')

// Resolved against this file rather than the working directory: this is the path the application will
// be told to load and execute, and "no such module" from inside the browser process is a poor way to
// find out that the script was started from somewhere unexpected.
const CHECK_MODULE = fileURLToPath(new URL('./smoke-checks.mjs', import.meta.url))

/**
 * A ceiling on the whole run, because the drag sweep is long and a hung window is silent.
 *
 * Generous on purpose: the sweep drives every zone of every layout with real input and waits for the
 * core to answer each time, so a slow machine legitimately takes minutes. This is here to turn "no
 * output ever again" into a failure, not to police how long the checks may take.
 */
const BUDGET_MINUTES = 20

await rm(PROFILE, { recursive: true, force: true })

const env = { ...process.env }
// An editor-hosted shell may export this, which makes the Electron binary run as
// plain Node and never start a browser process.
delete env.ELECTRON_RUN_AS_NODE

const electron =
  process.platform === 'win32' ? 'node_modules/.bin/electron.cmd' : 'node_modules/.bin/electron'

// `inherit`, so each check prints as it happens: a run that hangs then says where it got to, which a
// buffered log only reveals once the process is over.
const child = spawn(
  electron,
  ['out/main/index.js', `--user-data-dir=${PROFILE}`, `--run-checks=${CHECK_MODULE}`],
  { env, stdio: 'inherit' }
)

const watchdog = setTimeout(
  () => {
    console.error(`\nno verdict within ${BUDGET_MINUTES} minutes; stopping the application`)
    child.kill('SIGKILL')
  },
  BUDGET_MINUTES * 60 * 1000
)

const status = await new Promise((settle) => {
  child.on('error', (error) => {
    console.error('could not start the application:', error)
    settle(1)
  })
  // A signal means it was killed rather than that it decided: the watchdog above, or a Ctrl-C.
  child.on('exit', (code, signal) => settle(signal === null ? (code ?? 1) : 1))
})

clearTimeout(watchdog)
process.exit(status)
