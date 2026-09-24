import { readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LOCALE, LOCALES, catalogs, resolveLocale } from '@shared/i18n/catalog.js'
import {
  NO_ANSWER,
  loadCatalog,
  loadedCatalog,
  messageFor,
  withReference
} from '@shared/i18n/load-catalog.js'

/**
 * One question, asked in one way: which language is the interface in?
 *
 * `appearance.uiLanguage` is not that answer. Its default is `'system'`, a value `resolveLocale` has
 * never heard of — so handing the setting straight over returns `DEFAULT_LOCALE` for every user who
 * has not picked a language by hand. That is most of them, and the symptom is a browser that is
 * bilingual with itself: the menu bar, built through the resolver, in German, and the save-password
 * bar, the element picker, the page context menu, the update dialogue and the blocker menu — all
 * built through the raw setting — in English.
 *
 * The two correct resolvers are `uiLocale` in `main/index.ts` and `activeLocale` in
 * `main/ipc/handlers.ts`. Both ask the desktop when the setting says `'system'`. This file pins the
 * reason the rule exists, and then that nothing in the core goes around it again — seven call sites
 * did, each one a plausible line to write.
 */

const ROOT = process.cwd()

interface SourceFile {
  relative: string
  text: string
}

async function collect(dir: string): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue
      out.push({ relative: relative(ROOT, full), text: readFileSync(full, 'utf8') })
    }
  }
  await walk(join(ROOT, dir))
  return out
}

/**
 * Comments go, string literals stay.
 *
 * The subject here *is* a literal — `'appearance.uiLanguage'` — so erasing strings the way the
 * architecture tests usually do would erase the very thing being looked for, and this file would
 * pass by never finding anything.
 */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
}

describe('the setting is not a locale', () => {
  it('answers the default language for the default value', () => {
    // Not a quirk to work around: `resolveLocale` maps OS locale strings, and `'system'` is not one.
    // This is the line that makes the rule below worth enforcing.
    expect(resolveLocale('system')).toBe(DEFAULT_LOCALE)
  })

  it('answers a real language for an OS locale', () => {
    expect(resolveLocale('de-AT')).toBe('de')
  })
})

describe('locale resolution in the core', () => {
  it('never hands the raw setting to resolveLocale', async () => {
    for (const file of await collect('src/main')) {
      const offenders = [...withoutComments(file.text).matchAll(/resolveLocale\(([^)]*)/g)]
        .map((match) => match[1] ?? '')
        .filter((argument) => argument.includes('appearance.uiLanguage'))
      expect(
        offenders,
        `${file.relative} reads appearance.uiLanguage straight into resolveLocale; use uiLocale or activeLocale`
      ).toEqual([])
    }
  })

  it('keeps both resolvers answering the system default', async () => {
    /*
      So the test above cannot be satisfied by deleting the resolvers and inlining `resolveLocale`
      somewhere it is spelled differently. What matters about each of them is the one branch: the
      setting says `'system'`, so ask the desktop.
    */
    const files = await collect('src/main')
    const bodies = new Map(files.map((file) => [file.relative, withoutComments(file.text)]))

    const index = bodies.get(join('src', 'main', 'index.ts'))
    const handlers = bodies.get(join('src', 'main', 'ipc', 'handlers.ts'))
    expect(index).toBeDefined()
    expect(handlers).toBeDefined()

    expect(index).toMatch(/function uiLocale\([\s\S]*?app\.getLocale\(\)/)
    expect(handlers).toMatch(/function activeLocale\([\s\S]*?app\.getLocale\(\)/)
  })
})

/*
  The renderer side of the question: once the language is known, which messages arrive, and from where.

  `load-catalog.ts` is what split the renderer catalogue into one chunk per locale. What a renderer
  loads is asserted through the real entries in `tests/components/first-render-locale.test.tsx`; this
  pins the loader's own rules, in a module graph where nothing has been loaded yet.
*/
describe('the per-locale catalogues', () => {
  it('loads nothing until a locale is asked for, and then that locale alone', async () => {
    expect(loadedCatalog('de')).toBeUndefined()
    expect(loadedCatalog('en')).toBeUndefined()
    // With no reference loaded, the key is all a lookup has left.
    expect(messageFor({}, 'history.title')).toBe('history.title')

    const german = await loadCatalog('de')

    expect(german).toEqual(catalogs.de)
    expect(loadedCatalog('de')).toBe(german)
    expect(loadedCatalog('en')).toBeUndefined()
  })

  it('answers every later request for a locale with the same load', async () => {
    const first = loadCatalog('en')
    expect(loadCatalog('en')).toBe(first)
    expect(await first).toEqual(catalogs.en)
  })

  it('has a loader for every locale, each answering its own catalogue', async () => {
    for (const locale of LOCALES) expect(await loadCatalog(locale)).toEqual(catalogs[locale])
  })
})

describe('the fallback for a key the answer lacks', () => {
  it("takes the core's message first", () => {
    expect(messageFor({ 'history.title': 'Verlauf' }, 'history.title')).toBe('Verlauf')
  })

  it('takes the reference catalogue next, once it is loaded', async () => {
    await loadCatalog(DEFAULT_LOCALE)
    expect(messageFor({}, 'history.title')).toBe(catalogs[DEFAULT_LOCALE]['history.title'])
  })

  it('loads the reference behind an answer with nothing in it', async () => {
    const answer = await withReference(NO_ANSWER)
    expect(answer).toBe(NO_ANSWER)
    expect(loadedCatalog(DEFAULT_LOCALE)).toEqual(catalogs[DEFAULT_LOCALE])
  })

  it('passes a real answer through untouched', async () => {
    const answer = { locale: 'de' as const, messages: { ...catalogs.de } }
    expect(await withReference(answer)).toBe(answer)
  })
})
