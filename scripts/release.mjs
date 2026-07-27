/**
 * One command: raise the version, and publish a release with the files in it.
 *
 *   pnpm run release              0.1.0 → 0.2.0-ALPHA, tagged v0.2.0-ALPHA
 *   pnpm run release --patch      for an alpha that only fixes something
 *   pnpm run release --major      0.x → 1.0.0-ALPHA
 *   pnpm run release --dry-run    everything up to the push, then put it all back
 *
 * ## What it does, in order
 *
 * Refuse on a dirty tree or an existing tag → raise the version → commit it → tag it → push. The build
 * and the publishing then happen in `.github/workflows/release.yml`: install, typecheck, lint, test,
 * build, and `electron-builder --publish always` on macOS, Windows **and** Linux.
 *
 * ## Why the bytes are not built here
 *
 * Because `electron-builder` can only package for the platform it runs on. A release cut on this machine
 * would carry the mac `.dmg`, the mac `.zip` and `latest-mac.yml` — and **nothing for Windows or Linux**,
 * including the `latest.yml` and `latest-linux.yml` their updaters read. Those users would never be
 * offered the update, and nothing anywhere would say why. That is not a missing convenience; it is a
 * release that silently does not work for two thirds of the platforms this browser claims to support.
 *
 * So this is still one command. It ends with a push rather than an upload, and three runners produce a
 * release nobody has to complete by hand. `pnpm run package` is the separate job of getting an installer
 * onto this disk; it writes to `dist/` and publishes nothing.
 *
 * ## Why it touches git, when git is otherwise the user's
 *
 * Because a tag is the deliverable. The version has to be *in* the commit the tag points at — otherwise
 * the release says `0.2.0-ALPHA` while the code it was built from says `0.1.0`, and `app.getVersion()`
 * then reports the wrong thing to the update check for the whole life of that build.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { levelFrom, nextVersion, tagFor } from './next-version.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MANIFEST = new URL('../package.json', import.meta.url)

const dryRun = process.argv.includes('--dry-run')

const run = (command, args) =>
  execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', env: process.env })

const capture = (command, args) =>
  execFileSync(command, args, { cwd: ROOT, encoding: 'utf8' }).trim()

function assertCleanTree() {
  const dirty = capture('git', ['status', '--porcelain'])
  if (dirty === '') return
  console.error('The working tree has changes, so a tag here would not describe what was built:\n')
  console.error(dirty)
  console.error('\nCommit or stash them first.')
  process.exit(1)
}

/** Refuse a tag that exists: pushing it would fail, and moving it would be worse. */
function assertTagIsFree(tag) {
  if (capture('git', ['tag', '--list', tag]) === '') return
  console.error(`The tag ${tag} already exists, so this version has been released before.`)
  console.error('Pick another level (--patch, --major), or delete that tag deliberately first.')
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const from = manifest.version
const to = nextVersion(from, levelFrom(process.argv))
const tag = tagFor(to)

console.log(`${from} → ${to}   tag ${tag}${dryRun ? '   (dry run)' : ''}\n`)

assertCleanTree()
assertTagIsFree(tag)

const writeVersion = (version) => {
  manifest.version = version
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}

/*
  Undone on any exit that is not a completed push.

  A version written but never pushed leaves the tree claiming to be something that was not released, and
  the next run then steps past that number with nobody able to say why. A `catch` covers a failure; it does
  not cover Ctrl-C or a closed pipe, and either can land in the middle of the commit-tag-push sequence.

  The *commit* is deliberately left alone. Rewriting history to tidy up after an interruption is a far
  worse habit than one visible commit somebody can drop by hand.
*/
let pushed = false
const undo = () => {
  if (pushed) return
  writeVersion(from)
  try {
    if (capture('git', ['tag', '--list', tag]) !== '') run('git', ['tag', '-d', tag])
  } catch {
    // No tag to remove, or git refused. Either way the message the user acts on is above.
  }
}
process.on('exit', undo)
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    undo()
    process.exit(1)
  })
}

writeVersion(to)

if (dryRun) {
  console.log('Would now commit, tag and push:\n')
  console.log(`  git commit -am ${to}`)
  console.log(`  git tag ${tag}`)
  console.log('  git push --follow-tags\n')
  console.log(`dry run finished; version restored to ${from}`)
  process.exit(0)
}

run('git', ['commit', '-am', to])
run('git', ['tag', tag])
run('git', ['push', '--follow-tags'])
pushed = true

console.log(`\nPushed ${tag}. GitHub is now running the gates, then building and publishing`)
console.log('for macOS, Windows and Linux:')
console.log('  https://github.com/Maniksz/Tessera-Privacy-and-Productivity-Browser/actions')
console.log('\nThe release appears as a prerelease carrying the installers and the latest*.yml feeds.')
