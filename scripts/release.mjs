/**
 * Cuts an alpha release: raises the version, builds, publishes it to GitHub.
 *
 *   pnpm release:alpha            0.1.0 → 0.1.1-alpha.0, or alpha.3 → alpha.4
 *   pnpm release:alpha --dry-run  everything except the publish
 *
 * ## Why this is a script and not a line in package.json
 *
 * Because the version has to *move*, and where it moves to is a rule rather than a command.
 * `0.1.0 → 0.1.1-alpha.0` (the next patch, first alpha) and `0.1.1-alpha.3 → 0.1.1-alpha.4` (the next
 * alpha of the same patch) are two different answers to "bump", and a wrong one is not a typo: publish
 * `0.1.0-alpha.4` after `0.1.0` and every user on the release channel is offered nothing while every
 * alpha user is offered a version *older* than what they have.
 *
 * ## Why not the GitHub CLI
 *
 * `gh` is not installed here, and it is the wrong tool anyway: a release for an auto-updating
 * application is not just a tag with files attached. `electron-updater` reads `latest.yml`,
 * `latest-mac.yml` and `latest-linux.yml` — the checksums and the file names — and `electron-builder`
 * generates those as part of publishing. Uploading installers by hand produces a release that looks
 * complete and that no browser will ever update from.
 *
 * ## What it refuses to do
 *
 * Publish from a dirty tree, and publish without a token. Both would produce a release whose contents
 * nobody can reconstruct: a build from uncommitted work is not the tag it claims to be.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = new URL('../package.json', import.meta.url)

const dryRun = process.argv.includes('--dry-run')

const run = (command, args) =>
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env })

const capture = (command, args) =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim()

/**
 * The next alpha, from the version that is there now.
 *
 * Kept here rather than imported from `src/main/updates/version.ts` on purpose: that module is compiled
 * into the application and must stay free of anything only a release needs. The *ordering* rules are
 * tested there; this is one arithmetic step and its own tests are the two examples in the header.
 */
function nextAlpha(current) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-alpha\.(\d+))?$/.exec(current)
  if (match === null) {
    throw new Error(
      `version "${current}" is neither x.y.z nor x.y.z-alpha.n, so there is no next alpha of it`
    )
  }
  const [, major, minor, patch, alpha] = match
  // Already an alpha: the next one of the same patch. A release: the first alpha of the *next* patch,
  // because an alpha of a version that is already out would sort below it.
  if (alpha !== undefined) return `${major}.${minor}.${patch}-alpha.${Number(alpha) + 1}`
  return `${major}.${minor}.${Number(patch) + 1}-alpha.0`
}

function assertCleanTree() {
  const dirty = capture('git', ['status', '--porcelain'])
  if (dirty === '') return
  console.error(
    'the working tree has uncommitted changes, so a published build would not be the tag it claims:\n'
  )
  console.error(dirty)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const from = manifest.version
const to = nextAlpha(from)

console.log(`${from} → ${to}${dryRun ? '  (dry run)' : ''}\n`)

if (!dryRun) {
  assertCleanTree()
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) {
    console.error(
      'no GH_TOKEN (or GITHUB_TOKEN) in the environment; electron-builder needs one to create the release.'
    )
    console.error('A token with `contents: write` on this repository is enough.')
    process.exit(1)
  }
}

const writeVersion = (version) => {
  manifest.version = version
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

/*
  Restored on *any* exit, not only on a thrown error.

  The version has to be written before the build, because it is compiled in — `app.getVersion()` reads
  this file's value out of the packaged application, and that is what the update check compares against.
  Which means the file is wrong for the whole length of a build, and a build takes minutes. A `catch`
  covers a failure; it does not cover Ctrl-C, a closed pipe, or a killed terminal, and any of those left
  the tree claiming a version that was never published. The next run would then skip that number, and
  nobody would be able to say why.
*/
let published = false
const restoreUnlessPublished = () => {
  if (published) return
  writeVersion(from)
}
process.on('exit', restoreUnlessPublished)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    restoreUnlessPublished()
    process.exit(1)
  })
}

writeVersion(to)

try {
  run('pnpm', ['run', 'build'])
  // `--publish always` is what generates and uploads `latest*.yml` alongside the installers. Without
  // those the release is a set of downloads that no running browser will ever notice.
  run('pnpm', [
    'exec',
    'electron-builder',
    '--publish',
    dryRun ? 'never' : 'always'
  ])
} catch (error) {
  // The exit handler puts the version back; this only says so, because a restore nobody is told about
  // looks like the bump silently not having happened.
  console.error(`\nrelease failed; version restored to ${from}`)
  throw error
}

if (dryRun) {
  console.log(`\ndry run finished; version restored to ${from}`)
} else {
  published = true
  console.log(`\npublished ${to} as a prerelease.`)
  console.log('Commit the version bump and tag it, so the release matches a commit:')
  console.log(`  git commit -am "${to}" && git tag v${to} && git push --follow-tags`)
}
