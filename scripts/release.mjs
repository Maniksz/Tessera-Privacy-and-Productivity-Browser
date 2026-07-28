/**
 * One command: raise the version, build, and publish the release with the files in it.
 *
 *   pnpm run release              0.2.0-ALPHA → 0.3.0-ALPHA
 *   pnpm run release --patch      for an alpha that only fixes something
 *   pnpm run release --major      0.x → 1.0.0-ALPHA
 *   pnpm run release --dry-run    builds, publishes nothing, puts the version back
 *
 * Refuse on a dirty tree or an existing tag → raise the version → commit → annotated tag → push both →
 * build and package here into `dist/`. The push starts `.github/workflows/release.yml`, which is what
 * publishes the release, for all three platforms.
 *
 * ## Why this does not publish, when it is a release command
 *
 * Because two publishers cannot share one release, and both orders fail. Publish before pushing the tag and
 * GitHub refuses — a published release needs an existing tag. Push first and the workflow has already
 * created the release by the time the local upload starts, so creating it again is `already_exists`. Both
 * happened, in that order.
 *
 * The workflow is therefore the only publisher, and it is also the only one that can produce all three
 * platforms: `electron-builder` packages for the platform it runs on, so a local publish would upload macOS
 * and leave Windows and Linux users with no feed file and no way to know why. The local build stays because
 * the *files* are worth having: `dist/` ends up with this machine's installers.
 *
 * ## No token, and that is the point
 *
 * A local publish needed one — creating a release is the GitHub REST API over HTTPS, which an SSH key
 * cannot authenticate. Since the workflow publishes, the token it uses is `secrets.GITHUB_TOKEN`, minted
 * for that run and destroyed with it. Nothing to create, store or rotate on anybody's machine.
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
  if (capture('git', ['tag', '--list', tag]) !== '') {
    console.error(`The tag ${tag} exists locally, so this version has been released before.`)
    console.error('Pick another level (--patch, --major), or delete that tag deliberately first.')
    process.exit(1)
  }
  /*
    The remote as well, and this half is not thoroughness.

    A publish that fails creates the tag on GitHub anyway — creating a release creates a tag, against
    whatever the remote branch points at, which is the commit *before* the version bump. That tag then
    describes a commit whose `package.json` names a different version, and the next run would happily build
    against it. It happened twice; the local check cannot see it, because the local tag was cleaned up.
  */
  if (capture('git', ['ls-remote', '--tags', 'origin', tag]).includes(tag)) {
    console.error(`The tag ${tag} already exists on the remote.`)
    console.error('If a failed run left it behind, remove it and any release attached to it:')
    console.error(`  git push origin :refs/tags/${tag}`)
    process.exit(1)
  }
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
    `--follow-tags` is what once made this script report success while the tag stayed on the machine — so
    no workflow ran and nothing was built.
  */
  run('git', ['tag', '-a', tag, '-m', to])

  /*
    Pushed *before* anything is published. This order is the whole lesson of two failed attempts.

    GitHub refuses to create a published release for a tag that does not exist on the remote — "Published
    releases must have a valid tag", a 422 in the middle of uploading. And the attempt does not fail
    cleanly: it leaves a tag behind on GitHub pointing at whatever the remote branch happened to be, which
    is the commit *before* the version bump. So the remote ends up with a tag whose `package.json` names a
    different version, which is worse than no release at all.

    Tag first, verified there, and only then is there something for a release to attach to.
  */
  run('git', ['push', 'origin', 'HEAD'])
  run('git', ['push', 'origin', tag])
  if (!capture('git', ['ls-remote', '--tags', 'origin', tag]).includes(tag)) {
    console.error(`\n${tag} did not reach the remote, so there is nothing to publish against.`)
    console.error(`Push it by hand and run again:  git push origin ${tag}`)
    process.exit(1)
  }
  /*
    From here the version and the tag stay, whatever happens next. They are on the remote and the workflow
    is already building this tag for all three platforms; undoing them locally would only make this machine
    disagree with what everyone else can see.
  */
  pushed = true
}

/*
  Built here, published there — and the split is not a preference, it is the only arrangement that works.

  Two publishers cannot share one release. Pushing the tag *starts the workflow*, which creates the release
  within seconds; a local `--publish always` then asks GitHub to create the same one and gets
  `422 already_exists`. Ordering them the other way is no better: GitHub refuses a published release for a
  tag that does not exist yet, which was the previous failure. There is no sequence in which both publish.

  So the workflow is the only publisher — it is also the only one that *can* produce all three platforms —
  and this build exists for the files themselves: `dist/` gets the installers for this machine, which is
  what you want when you are about to try the thing you just tagged, or hand somebody a file directly.
*/
run('pnpm', ['run', 'build'])
run('pnpm', ['exec', 'electron-builder', ...macSigningArguments(), '--publish', 'never'])

if (dryRun) {
  console.log(`\nBuilt into dist/. Nothing tagged or published; version restored to ${from}.`)
  process.exit(0)
}

console.log(`\n${to} is tagged and pushed, and dist/ holds this machine's installers.`)
console.log('The workflow is building and publishing the release for macOS, Windows and Linux:')
console.log('  https://github.com/Maniksz/Tessera-Privacy-and-Productivity-Browser/actions')
