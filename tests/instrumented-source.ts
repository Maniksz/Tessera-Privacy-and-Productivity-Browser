import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether any of these source files, relative to the project root, is Stryker's instrumented copy.
 *
 * The mutation run (`vitest.stryker.config.ts`) runs every test against an instrumented copy of each
 * file in `stryker.config.json`'s `mutate`: the code is reprinted with `stryMutAct_…() ? … : …` around
 * every branch. A test that reads such a file as text and asserts on its shape then fails the dry run
 * over formatting that is not in the repository, and kills no mutants either — what it checks is the
 * code's shape, and the behaviour behind it is asserted elsewhere. So those tests `skipIf` this, the way
 * `filter-scriptlets.test.ts` steps aside, and run as usual everywhere else.
 */
export function instrumented(...files: readonly string[]): boolean {
  return files.some((file) =>
    readFileSync(join(process.cwd(), file), 'utf8').includes('stryMutAct')
  )
}
