/**
 * Quality metrics.
 *
 * Prints the numbers that would otherwise only be noticed once they had already
 * gone wrong, and fails when one crosses a line. The point is not the numbers
 * themselves but the direction they move in, so each has a threshold and a reason
 * rather than being reported for its own sake.
 *
 *   node scripts/metrics.mjs            print and check
 *   node scripts/metrics.mjs --json     machine-readable, for CI
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, relative, extname } from 'node:path'

const ROOT = process.cwd()
const asJson = process.argv.includes('--json')
const failures = []

function walk(dir, extensions, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, extensions, out)
    else if (extensions.includes(extname(name))) out.push(full)
  }
  return out
}

function lineCount(file) {
  return readFileSync(file, 'utf8').split('\n').length
}

/** Comment lines, as a rough proxy for whether decisions are written down. */
function commentRatio(files) {
  let code = 0
  let comments = 0
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'))
        comments++
      else code++
    }
  }
  return comments / (code + comments)
}

function check(label, value, { max, min, unit = '', reason }) {
  const ok = (max === undefined || value <= max) && (min === undefined || value >= min)
  if (!ok) {
    failures.push({ label, value, max, min, reason })
  }
  return { label, value, unit, max, min, ok, reason }
}

const sourceFiles = walk(join(ROOT, 'src'), ['.ts', '.tsx'])
const testFiles = walk(join(ROOT, 'tests'), ['.ts', '.tsx'])
const featureFiles = walk(join(ROOT, 'tests/features'), ['.feature'])

/**
 * The ratio is measured against the unit-testable surface, not all of `src`.
 *
 * Renderer components and Electron-bound modules are covered by the smoke test and
 * by the QA procedures instead, on purpose. Counting their lines in the denominator
 * makes the number drop every time the UI grows, which says nothing about whether
 * anything is tested — a metric that moves for the wrong reason gets ignored, and an
 * ignored metric is worse than none.
 */
const testableFiles = sourceFiles.filter(
  (file) => file.includes('/src/shared/') || file.includes('/src/main/')
)
const rendererFiles = sourceFiles.filter((file) => file.includes('/src/renderer/'))

/**
 * Which renderer files a component test actually reaches.
 *
 * This replaces a raw line count that was reported under the name "covered by smoke test only".
 * The intent behind that number was right and its measurement could not see the thing it was named
 * after: it summed the renderer's lines, so it rose when the UI grew and never moved when a test was
 * written. A metric that cannot respond to the work it is asking for gets worked around rather than
 * heeded, and the obvious way around it — extracting lines elsewhere to duck under the bar — leaves
 * the UI exactly as untested as before.
 *
 * Reachability rather than line coverage, because the renderer is deliberately outside the coverage
 * report (see `vitest.config.ts`): including it drags the global 90 % bar down for the core logic
 * that bar was written to guard. A file a component test imports is a file whose behaviour someone
 * has had to think about; that is a coarser claim than a covered line, and it is honest about being
 * coarse.
 */
const IMPORT_PATTERN = /(?:from|import)\s+['"]([^'"]+)['"]/g

const ALIASES = [
  ['@renderer-internal/', 'src/renderer/internal/'],
  // Added after this metric reported the two best-tested renderer files as reached by nothing: the alias was
  // missing here, so the resolver returned `null` and the traversal simply stopped. A reachability metric that
  // cannot resolve an import silently under-reports, which is the direction that looks like bad news and is
  // therefore never questioned.
  ['@renderer-shared/', 'src/renderer/shared/'],
  ['@renderer/', 'src/renderer/src/'],
  ['@shared/', 'src/shared/'],
  ['@main/', 'src/main/']
]

/** Resolves an import to a file on disk, or `null` for a package. TypeScript writes `.js`. */
function resolveImport(specifier, fromFile) {
  const aliased = ALIASES.slice(0)
    .filter(([prefix]) => specifier.startsWith(prefix))
    .map(([prefix, target]) => join(ROOT, target + specifier.slice(prefix.length)))
  const relativeTo = specifier.startsWith('.') ? [join(fromFile, '..', specifier)] : []
  const candidates = aliased.concat(relativeTo).flatMap((base) => {
    const withoutJs = base.replace(/\.js$/, '')
    return [withoutJs + '.ts', withoutJs + '.tsx', base]
  })
  return (
    candidates.filter((candidate) => existsSync(candidate) && statSync(candidate).isFile())[0] ??
    null
  )
}

function reachableFrom(entryFiles) {
  const seen = new Set()
  const queue = entryFiles.slice(0)
  while (queue.length > 0) {
    const file = queue.shift()
    if (seen.has(file)) continue
    seen.add(file)
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(IMPORT_PATTERN)) {
      const resolved = resolveImport(match[1], file)
      if (resolved !== null && !seen.has(resolved)) queue.push(resolved)
    }
  }
  return seen
}

const componentTests = walk(join(ROOT, 'tests/components'), ['.ts', '.tsx'])
const testedByComponents = reachableFrom(componentTests)
const untestedRendererFiles = rendererFiles.filter((file) => !testedByComponents.has(file))

const testableLines = testableFiles.reduce((sum, file) => sum + lineCount(file), 0)
const untestedRendererLines = untestedRendererFiles.reduce((sum, file) => sum + lineCount(file), 0)
const testLines = testFiles.reduce((sum, file) => sum + lineCount(file), 0)

const metrics = []

// --- size and shape ---------------------------------------------------------

metrics.push(
  check('source files', sourceFiles.length, {
    reason: 'informational'
  })
)

/**
 * A floor, not a target.
 *
 * Coverage and the mutation score are the binding measures of whether the tests do
 * anything; this ratio is a cheap early warning that fires when a large piece of core
 * logic arrives with no tests at all, before either of the slower checks runs. Setting
 * it just above the current value would make it fail on the next commit for no reason,
 * which is how a metric gets deleted instead of heeded.
 */
metrics.push(
  check('test to testable-source ratio', Number((testLines / testableLines).toFixed(2)), {
    min: 0.5,
    reason: 'a floor: below this, a substantial piece of the core arrived without tests'
  })
)

metrics.push(
  /*
    The reached/total fraction rides in the label, so the number audits itself.

    A resolver bug that reached too *few* files raises the line count and fails loudly. One that
    claimed too many would be silent and would quietly retire the gate — unless the reader can see
    "3 of 27 files reached" next to it.
  */
  check(
    `renderer lines no component test reaches (${rendererFiles.length - untestedRendererFiles.length} of ${rendererFiles.length} files reached)`,
    untestedRendererLines,
    {
      max: 2800,
      unit: ' lines',
      reason:
        'the smoke test proves each surface loads once; past this much, what a surface does when a call is refused or a list is empty needs a component test'
    }
  )
)

metrics.push(
  check('gherkin scenarios', countScenarios(featureFiles), {
    min: 40,
    reason: 'behaviour has to be described somewhere a non-programmer can read'
  })
)

/**
 * Largest file, as a proxy for a module that has quietly become several.
 * A cap rather than a target: some files legitimately hold a big table.
 */
const bySize = sourceFiles
  .map((file) => ({ file: relative(ROOT, file), lines: lineCount(file) }))
  .sort((a, b) => b.lines - a.lines)
const largest = bySize[0]

metrics.push(
  check(`largest source file (${largest?.file ?? 'none'})`, largest?.lines ?? 0, {
    /*
      Raised from 750 once, with the reason and the next test written down.

      `BrowserWindowController` is a coordinator: no member in it is longer than 79 lines, and what makes it
      long is the number of seams it delegates to — five controllers, each behind its own host interface.
      That is the opposite of what this metric's message describes ("usually two modules that have not been
      separated"), so at 754 the number had stopped meaning what it was set to mean.

      Two extractions have happened since, and both were the real thing rather than line shuffling: the audio
      policy became `TileAudioController` (testable for the first time), and the six seam constructions became
      `window-seams.ts`, whose `WindowInternals` interface is now the one place that says what each controller
      may reach — a question that previously took reading a hundred lines of closures to answer.

      The file is 800 and this bar is 780, and it is left failing rather than raised again. What would lower it:
      `#wireWindowEvents` is sixty-nine lines of "what the OS tells the window and what it does about it", of
      which about fifty could move to a `window-events.ts` taking the same `WindowInternals`. The `closed`
      handler must stay — it is the window's own teardown, not a reaction to anything.
    */
    max: 780,
    unit: ' lines',
    reason: 'a file this long is usually two modules that have not been separated'
  })
)

/**
 * How many files are over that bar, not just the worst one.
 *
 * The bar above is per file, but only the maximum was ever measured — so once one file sat over it, every
 * other file could drift past it in silence. That is exactly what happened: `shared/tabgroups/model.ts`
 * reached 863 lines, over the bar and forty lines from being reported at all, while the number on screen
 * went on naming `catalog.ts`.
 *
 * One is tolerated because the largest file is already its own failing check with its own written-down next
 * step; a second is a trend rather than an exception, and a trend is what this whole file exists to notice.
 */
const overBar = bySize.filter((entry) => entry.lines > 780)

metrics.push(
  check('files over the per-file line bar', overBar.length, {
    max: 1,
    unit: ' files',
    // Named in the reason rather than the label: six paths in a table column push every other row's
    // numbers off the screen, and the point of the table is that the numbers line up.
    reason: `the bar above measures only the worst file, so a second overlong file is otherwise invisible — ${overBar.map((entry) => `${entry.file} (${entry.lines})`).join(', ')}`
  })
)

metrics.push(
  check('comment ratio', Number(commentRatio(sourceFiles).toFixed(2)), {
    min: 0.15,
    reason: 'the reasons behind these decisions are the part that is expensive to rediscover'
  })
)

// --- dependency weight ------------------------------------------------------

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
metrics.push(
  check('runtime dependencies', Object.keys(pkg.dependencies ?? {}).length, {
    /*
      Raised from 2 to 4 by decision, for two named crypto packages and nothing else.

      Cryptography is the one place in this project where "write it yourself" is the wrong answer. A
      hand-written Argon2 that is *functionally* correct can still leak the key through a timing or cache
      side channel, and no amount of review here would find that — whereas a hand-written Readability
      substitute can only ever be wrong about which paragraph is the article.

      What the two slots are for: an Argon2id implementation, and the vault-format half (KDBX or the
      Bitwarden scheme) once the sync adapter lands. Not for convenience libraries. If a third crypto
      need appears, that is a decision to take again rather than a number to nudge.
    */
    max: 4,
    reason: 'every runtime dependency is code shipped to users and a supply-chain surface'
  })
)

// --- built output -----------------------------------------------------------

const assetsDir = join(ROOT, 'out/renderer/assets')
if (existsSync(assetsDir)) {
  const js = walk(assetsDir, ['.js'])
  // Decimal kB (bytes / 1000), matching what the Vite build log prints. Dividing by
  // 1024 while labelling the result "kB" is what made this project's numbers look
  // like they disagreed across README, the build log and this script — they were the
  // same bytes in two different units.
  const totalKb = Math.round(js.reduce((sum, file) => sum + statSync(file).size, 0) / 1000)
  metrics.push(
    check('renderer javascript', totalKb, {
      max: 320,
      unit: ' kB',
      reason: 'every kilobyte is parse and compile work on every window open'
    })
  )

  const preload = join(ROOT, 'out/preload/index.cjs')
  if (existsSync(preload)) {
    metrics.push(
      check('preload', Math.round(statSync(preload).size / 1000), {
        /*
          Raised from 16 kB once, for a feature that has to be exactly here.

          The preload gained cosmetic filtering, which is roughly a third of what an ad blocker does: it has
          to run at `document-start`, before the page's own scripts, or the advert appears and then vanishes.
          And it gained the element picker, whose listeners must be registered before page script so a site
          cannot take the click away from it — which is only possible from a preload.

          What did *not* have to be here was moved out first: the picker's stylesheet and every user-visible
          word now travel from the core with the start message. That also fixed a real defect — hard-coded
          English in a file that cannot read the translation catalogue.

          Left at 22 kB while the main process was raised, by decision, and deliberately so: the preload is
          parsed once per page in every tab, so a kilobyte here costs hundreds of times what one costs there.
          Autofill made it 27 kB, which is over — and the answer is to move the *user interface* halves of the
          picker and of autofill out to be fetched on demand, not to widen the one budget that matters most.
        */
        max: 22,
        unit: ' kB',
        reason: 'the preload runs before every page; it has to stay small'
      })
    )
  }

  const main = join(ROOT, 'out/main/index.js')
  if (existsSync(main)) {
    metrics.push(
      check('main process', Math.round(statSync(main).size / 1000), {
        /*
          Raised from 200 kB once. The budget was set when the core was a window manager; it has since gained
          a content blocker, media detection and download, a permission model, tab groups, thumbnails and an
          encrypted store — each of which the specification asks for.

          About 60 kB of it is zod, which is not fat: it is the validated UI/core boundary spec 6 requires,
          and the alternative is hand-written checks at sixty channels.

          What would justify the next raise: a feature the specification names. What would not: another
          convenience module. If this needs raising again without one, the thing to look at is whether the
          media downloader's manifest parsing can be loaded on demand — it is only needed when somebody
          actually downloads something.
        */
        /*
          Raised from 250 kB by decision, and this one has a list behind it: bookmarks, downloads, passwords,
          reader mode, find in page and session restore all landed in one pass, and every one of them is a
          feature the specification names.

          The preload is the budget being *held* instead — see below. That asymmetry is the point: the main
          process is parsed once per launch, the preload once per page in every tab, so a kilobyte there costs
          hundreds of times more than a kilobyte here.
        */
        max: 320,
        unit: ' kB',
        reason: 'parsed before the first window can appear'
      })
    )
  }
} else if (!asJson) {
  console.log('  (no build present — run pnpm build for bundle metrics)\n')
}

// --- coverage ---------------------------------------------------------------

const coverageSummary = join(ROOT, 'coverage/coverage-summary.json')
if (existsSync(coverageSummary)) {
  const summary = JSON.parse(readFileSync(coverageSummary, 'utf8'))
  const total = summary.total
  metrics.push(
    check('line coverage', total.lines.pct, {
      min: 90,
      unit: '%',
      reason: 'the threshold the test config already enforces; repeated here for visibility'
    })
  )
  metrics.push(
    check('branch coverage', total.branches.pct, {
      min: 85,
      unit: '%',
      reason: 'branches are where the interesting decisions live'
    })
  )
} else if (!asJson) {
  console.log('  (no coverage present — run pnpm test:coverage for coverage metrics)\n')
}

// --- mutation ---------------------------------------------------------------

const mutationReport = join(ROOT, 'reports/mutation/mutation.json')
if (existsSync(mutationReport)) {
  const report = JSON.parse(readFileSync(mutationReport, 'utf8'))
  const all = Object.values(report.files ?? {}).flatMap((file) => file.mutants ?? [])
  const count = (status) => all.filter((m) => m.status === status).length
  const killed = count('Killed')
  const timeout = count('Timeout')
  const survived = count('Survived')
  const noCoverage = count('NoCoverage')
  // Stryker's own definition, so this number matches what its report prints.
  // Leaving `NoCoverage` out of the denominator would flatter the result by hiding
  // exactly the mutants nothing exercises.
  const detected = killed + timeout
  const total = detected + survived + noCoverage
  const score = total === 0 ? 0 : Math.round((detected / total) * 100)
  metrics.push(
    check('mutation score', score, {
      min: 70,
      unit: '%',
      reason: 'coverage says a line ran; this says a test would notice if it changed'
    })
  )
}

function countScenarios(files) {
  let count = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    count += (text.match(/^\s*Scenario(?: Outline)?:/gm) ?? []).length
  }
  return count
}

// --- output -----------------------------------------------------------------

if (asJson) {
  console.log(JSON.stringify({ metrics, failures }, null, 2))
} else {
  const width = Math.max(...metrics.map((m) => m.label.length))
  console.log('\nQuality metrics\n')
  for (const metric of metrics) {
    const bound =
      metric.max !== undefined
        ? `max ${metric.max}${metric.unit}`
        : metric.min !== undefined
          ? `min ${metric.min}${metric.unit}`
          : ''
    const mark = metric.ok ? '  ok  ' : ' FAIL '
    console.log(
      `${mark} ${metric.label.padEnd(width)}  ${String(metric.value).padStart(6)}${metric.unit.padEnd(4)} ${bound}`
    )
  }

  if (failures.length > 0) {
    console.log('\nOver the line:\n')
    for (const failure of failures) {
      console.log(`  ${failure.label}: ${failure.value}`)
      console.log(`    ${failure.reason}\n`)
    }
  } else {
    console.log('\nEvery metric within bounds.')
  }
}

process.exit(failures.length > 0 ? 1 : 0)
