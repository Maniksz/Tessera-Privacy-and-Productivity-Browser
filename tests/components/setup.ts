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

/**
 * `draggable` as Chromium has it: a property on every element, reflected as `"true"` or `"false"`.
 *
 * happy-dom has no such property, so Preact — which sets a prop as a property only when the element has
 * one — falls back to the attribute, and removes it for `false`. In Chromium the property exists and
 * `draggable={false}` arrives as `draggable="false"`; without this a test would see the one browser the
 * app never runs in.
 */
if (!('draggable' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'draggable', {
    configurable: true,
    get(this: HTMLElement): boolean {
      return this.getAttribute('draggable') === 'true'
    },
    set(this: HTMLElement, value: boolean) {
      this.setAttribute('draggable', value ? 'true' : 'false')
    }
  })
}

/**
 * The `on…` properties Chromium puts on every element and happy-dom leaves off some of.
 *
 * Both Preact and `@testing-library/preact` spell an event by asking whether the element has the
 * lower-case handler property: with it, `onSubmit` listens for `submit`; without it, for `Submit`, which
 * nothing ever dispatches — and `fireEvent.submit(input)` sends a `Submit` that never reaches the form.
 * Chromium has every one of these on every element, so a test here must too.
 */
for (const handler of [
  'onsubmit',
  'ondragstart',
  'ondragover',
  'ondragleave',
  'ondragend',
  'ondrop'
]) {
  if (handler in HTMLElement.prototype) continue
  Object.defineProperty(HTMLElement.prototype, handler, {
    configurable: true,
    writable: true,
    value: null
  })
}
