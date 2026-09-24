import { useEffect, useMemo } from 'react'
import { bundledI18n } from './bundled-i18n.js'

/**
 * `tessera://about`, opened by Help › About: the product's name, its version and its licence.
 *
 * Served without privileges — it is not in `INTERNAL_PAGES`, so the preload gives it no bridge and the
 * core would refuse it anything. It needs nothing: the text comes from the bundled catalogue chosen by
 * `navigator.language` (see `bundled-i18n.ts`), and the version and licence are build constants that
 * `electron.vite.config.ts` reads from `package.json`, so the page cannot state a version the installer
 * was not stamped with.
 */
export function AboutPage(): React.ReactNode {
  // Once per document: without a bridge nothing tells the page the language changed, and the
  // browser's language does not change under a loaded document.
  const { locale, t } = useMemo(() => bundledI18n(), [])
  const title = t('about.title')

  useEffect(() => {
    // The static markup says `lang="en"` and a placeholder title; both are the catalogue's to set.
    document.documentElement.lang = locale
    document.title = title
  }, [locale, title])

  return (
    <main className="about">
      <h1 className="about__name">{t('app.name')}</h1>
      <p className="about__version">{t('about.version', { version: __TESSERA_VERSION__ })}</p>
      <p className="about__licence">{t('about.licence', { licence: __TESSERA_LICENSE__ })}</p>
    </main>
  )
}
