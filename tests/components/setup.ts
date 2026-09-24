import { beforeAll } from 'vitest'
import { LOCALES } from '@shared/i18n/locale.js'
import { loadCatalog } from '@shared/i18n/load-catalog.js'

/**
 * The catalogues a renderer's entry would have loaded before its first render.
 *
 * Since the split (`shared/i18n/load-catalog.ts`) no renderer carries a catalogue in its own chunk: the
 * entry asks the core, or loads its one language, and only then renders. A component test renders the
 * component and not the entry, so this stands in for that step — every locale, because a test may render
 * a page in either language, and before any test, because the lookup it feeds cannot wait.
 *
 * What it must not hide is the step itself. `tests/components/first-render-locale.test.tsx` starts from a
 * fresh module graph, where nothing is loaded, and goes through the real entries.
 */
beforeAll(async () => {
  await Promise.all(LOCALES.map((locale) => loadCatalog(locale)))
})
