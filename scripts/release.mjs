/**
 * One command: raise the version, build, and publish the release with the files in it.
 *
 *   pnpm run release              0.2.0-ALPHA → 0.3.0-ALPHA
 *   pnpm run release --patch      for an alpha that only fixes something
 *   pnpm run release --major      0.x → 1.0.0-ALPHA
 *   pnpm run release --dry-run    builds, publishes nothing, puts the version back
 *
 * Refuse on a dirty tree or an existing tag → raise the version → commit → annotated tag → **build and
 * package here** → publish to GitHub → push the commit and the tag.
 *
 * ## What this machine can and cannot produce
 *
 * `electron-builder` packages for the platform it runs on, so a run here uploads the macOS files: `.dmg`
 * and `.zip` for x64 and arm64, plus `latest-mac.yml`. Pushing the tag then starts
 * `.github/workflows/release.yml`, which adds Windows and Linux to the **same** release. So the release is
 * complete either way; this command just does not wait for the other two.
 *
 * ## Why it needs a token, and where it looks
 *
 * Creating a release is the GitHub REST API over HTTPS; an SSH key cannot authenticate it. `GH_TOKEN` or
 * `GITHUB_TOKEN` from the environment, otherwise the macOS Keychain — because a token in a shell profile is
 * a plain file every process can read, and one typed on the command line is a line in `~/.zsh_history`.
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

const KEYCHAIN_ITEM = 'tessera-gh-token'

/** The token, from the environment or the Keychain. Captured, never inherited, never logged. */
function findToken() {
  const fromEnvironment = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
  if (process.platform !== 'darwin') return null
  try {
    const stored = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_ITEM, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return stored === '' ? null : stored
  } catch {
    return null
  }
}

function explainMissingToken() {
  console.error('No GitHub token, so the release cannot be created.\n')
  console.error('Make one: GitHub → Settings → Developer settings → Personal access tokens →')
  console.error('  Fine-grained → this repository → Permissions → Contents: Read and write.\n')
  console.error('Keep it in the Keychain and it is found automatically from then on:')
  console.error(`  security add-generic-password -a "$USER" -s ${KEYCHAIN_ITEM} -w`)
  console.error('  (prompts for the value, so it stays out of your shell history)\n')
  console.error('Or for one run:  GH_TOKEN=… pnpm run release')
}

/**
 * Signing, and what a build does without it.
 *
 * `electron-builder.yml` asks for a hardened runtime and notarisation, which needs an Apple Developer ID.
 * Without one the build fails minutes in, with a message about credentials. So the absence is detected
 * first and turned into an unsigned build — and the consequence is said here rather than discovered:
 * **Squirrel.Mac will not replace an unsigned application**, so this build installs by hand and cannot
 * update itself. Removing these two overrides is the whole change once a certificate exists.
 */
function macSigningArguments() {
  if (process.platform !== 'darwin') return []
  const signable =
    (process.env.CSC_LINK ?? '') !== '' ||
    (process.env.CSC_NAME ?? '') !== '' ||
    (process.env.APPLE_TEAM_ID ?? '') !== ''
  if (signable) return []
  console.log('No Apple signing credentials, so this mac build is unsigned: it installs by hand and')
  console.log('cannot update itself. Windows and Linux from the workflow are unaffected.\n')
  return ['--config.mac.notarize=false', '--config.mac.identity=null']
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
const from = manifest.version
const to = nextVersion(from, levelFrom(process.argv))
const tag = tagFor(to)

console.log(`${from} → ${to}   tag ${tag}${dryRun ? '   (dry run)' : ''}\n`)

assertCleanTree()
assertTagIsFree(tag)

const token = dryRun ? '' : findToken()
if (!dryRun && token === null) {
  explainMissingToken()
  process.exit(1)
}
if (token !== null && token !== '') process.env.GH_TOKEN = token

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

if (!dryRun) {
  run('git', ['commit', '-am', to])
  /*
    Annotated, because `git push --follow-tags` transmits annotated tags only. A lightweight tag plus
    `--follow-tags` is what made an earlier version of this script report success while the tag stayed on
    the machine — so no workflow ran and nothing was built.
  */
  run('git', ['tag', '-a', tag, '-m', to])
}

// Built here, which is the point: the files this run publishes are made on this machine.
run('pnpm', ['run', 'build'])
run('pnpm', [
  'exec',
  'electron-builder',
  ...macSigningArguments(),
  '--publish',
  dryRun ? 'never' : 'always'
])

if (dryRun) {
  console.log(`\nBuilt into dist/. Nothing published; version restored to ${from}.`)
  process.exit(0)
}

run('git', ['push', 'origin', 'HEAD'])
// By name, not via `--follow-tags`, and then verified: the only thing that answers "will the other two
// platforms build?" is whether the tag is actually on the other side.
run('git', ['push', 'origin', tag])
if (!capture('git', ['ls-remote', '--tags', 'origin', tag]).includes(tag)) {
  console.error(`\n${tag} did not reach the remote, so Windows and Linux will not build.`)
  console.error(`The macOS files are published. Push the tag to finish it:  git push origin ${tag}`)
  process.exit(1)
}
pushed = true

console.log(`\nPublished ${to} with the macOS files, and pushed ${tag}.`)
console.log('The workflow is now adding Windows and Linux to the same release:')
console.log('  https://github.com/Maniksz/Tessera-Privacy-and-Productivity-Browser/actions')
