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
/*
  Raise the version and stop — the route that needs no token at all.

  Creating a GitHub release is the REST API over HTTPS, so an SSH key cannot authenticate it and a local
  publish needs a personal access token on disk. Pushing a *tag* needs only the SSH key that is already
  there, and `.github/workflows/release.yml` does the publishing from the other side with a token GitHub
  mints for that run alone. It also builds for all three platforms, which this machine cannot: a release
  cut here carries `latest-mac.yml` and nothing else, so Windows and Linux users would never be offered
  the update.

  So this mode is the recommended one, and the git commands are printed rather than run: committing and
  tagging is the user's, not this script's.
*/
const prepareOnly = process.argv.includes('--prepare')

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

const writeVersion = (version) => {
  manifest.version = version
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)
}


/**
 * The token, from the environment or from the macOS Keychain.
 *
 * The Keychain is offered because the obvious alternatives are both bad: a token in a shell profile is a
 * secret in a plain file that every process the user runs can read, and a token typed on the command
 * line is a secret in `~/.zsh_history`. `security` prints it on stdout, so it is captured and never
 * inherited — an `stdio: 'inherit'` here would put the token on the terminal, which is the thing being
 * avoided.
 *
 * Read at each run rather than cached anywhere, and never logged.
 */
function findToken() {
  const fromEnvironment = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
  if (fromEnvironment !== undefined && fromEnvironment !== '') return fromEnvironment
  if (process.platform !== 'darwin') return null

  try {
    const stored = execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_ITEM, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return stored === '' ? null : stored
  } catch {
    // No such item, or the user declined the Keychain prompt. Both mean "no token", and the message
    // below says how to put one there.
    return null
  }
}

const KEYCHAIN_ITEM = 'tessera-gh-token'

function explainMissingToken() {
  console.error('No GitHub token, so there is nothing that could create the release.\n')
  console.error('Make one: GitHub → Settings → Developer settings → Personal access tokens →')
  console.error('  Fine-grained tokens → this repository → Permissions → Contents: Read and write.\n')
  console.error('Then either keep it in the Keychain, which is read automatically from now on:')
  console.error(`  security add-generic-password -a "$USER" -s ${KEYCHAIN_ITEM} -w`)
  console.error('  (prompts for the value, so it stays out of your shell history)\n')
  console.error('…or pass it for one run:')
  console.error('  GH_TOKEN=… pnpm run release:alpha')
}

/**
 * Signing, and what a build does when there is none.
 *
 * `electron-builder.yml` asks for a hardened runtime and notarisation, which is right and which needs an
 * Apple Developer ID. Without one the mac build fails partway through — after minutes of packaging — and
 * the message is about credentials rather than about what to do. So the absence is detected first, said
 * plainly, and turned into an unsigned build rather than a failure.
 *
 * The consequence is not cosmetic and is stated at the point of the decision: **Squirrel.Mac refuses to
 * replace an application that is not signed**, so a mac alpha built this way can be downloaded and
 * installed by hand but can never update itself. Windows and Linux are unaffected.
 */
function macSigningArguments() {
  if (process.platform !== 'darwin') return []
  const signable =
    (process.env.CSC_LINK ?? '') !== '' ||
    (process.env.CSC_NAME ?? '') !== '' ||
    (process.env.APPLE_TEAM_ID ?? '') !== ''
  if (signable) return []

  console.log('No Apple signing credentials found, so this mac build will be unsigned.')
  console.log('It installs by hand and cannot update itself — Squirrel.Mac will not replace an')
  console.log('unsigned application. Windows and Linux builds are unaffected.\n')
  return ['--config.mac.notarize=false', '--config.mac.identity=null']
}

if (prepareOnly) {
  assertCleanTree()
  writeVersion(to)
  console.log(`package.json is now ${to}. Commit it, tag it, and push:\n`)
  console.log(`  git commit -am "${to}"`)
  console.log(`  git tag v${to}`)
  console.log('  git push --follow-tags\n')
  console.log('The Release workflow builds mac, Windows and Linux and publishes the prerelease.')
  process.exit(0)
}

if (!dryRun) {
  assertCleanTree()
  const token = findToken()
  if (token === null) {
    explainMissingToken()
    process.exit(1)
  }
  // Put it where electron-builder looks, without it having been in the environment of the shell that
  // started this.
  process.env.GH_TOKEN = token
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
    ...macSigningArguments(),
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
