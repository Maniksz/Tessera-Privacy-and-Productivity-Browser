import { defineConfig } from 'vitest/config'
import base from './vitest.config'

/*
  The configuration the mutation run uses: the ordinary one minus the architecture tests.

  Those tests read source files as text and assert on what they say — a pattern here, an export
  there. Stryker runs every test against an instrumented copy of each mutated file, so a file that
  reads `sandbox: true` in the repository reads `stryMutAct_…() ? … : true` in the sandbox, and the
  whole run died in its dry run on the first such assertion. They kill no mutants either: what they
  check is the shape of the code, and the behaviour behind it is asserted by the unit tests that
  stay in.
*/
const projects = (base.test?.projects ?? []).map((project) => {
  if (typeof project !== 'object' || !('test' in project)) return project
  if (project.test.name !== 'unit') return project
  return {
    ...project,
    test: {
      ...project.test,
      exclude: [...(project.test.exclude ?? []), 'tests/architecture.test.ts']
    }
  }
})

export default defineConfig({ ...base, test: { ...base.test, projects } })
