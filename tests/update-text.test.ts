import { describe, expect, it } from 'vitest'
import { updateText, updateTexts, type UpdateTextKey } from '@main/updates/update-text.js'
import { LOCALES } from '@shared/i18n/catalog.js'
import { PRODUCT_NAME } from '@shared/product.js'

/**
 * The update check's message-box text, held to the rules the message catalogue is held to.
 *
 * These sentences left `shared/i18n/catalog.*` for the core (see `main/updates/update-text.ts`),
 * and with that they left the reach of the catalogue's checks in `tests/ipc-contract.test.ts`.
 * The compiler still refuses a German table with a missing or extra key; what it cannot see —
 * a key set that differs at runtime, an empty string, a placeholder a translation dropped — is
 * written out again here, on the pattern `tests/settings-describe.test.ts` set for the settings
 * text.
 */
describe('the update text tables', () => {
  const keys = Object.keys(updateTexts.en) as UpdateTextKey[]

  it('has the same keys in every locale', () => {
    for (const locale of LOCALES) {
      expect(Object.keys(updateTexts[locale]).sort(), locale).toEqual([...keys].sort())
    }
  })

  it('has no empty string anywhere in it', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        expect(updateTexts[locale][key].trim(), `${locale}/${key}`).not.toBe('')
      }
    }
  })

  it('keeps placeholders consistent across locales', () => {
    // A translation that drops {version} or {current} loses the one fact the dialogue exists to state.
    const placeholders = (text: string): string[] =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()

    for (const key of keys) {
      const reference = placeholders(updateTexts.en[key])
      for (const locale of LOCALES) {
        expect(placeholders(updateTexts[locale][key]), `${locale}/${key}`).toEqual(reference)
      }
    }
  })

  it('fills placeholders with the catalogue’s rules, {app} included', () => {
    expect(updateText('en', 'readyMessage', { version: '1.1.0' })).toBe(
      `Version 1.1.0 has been downloaded. It is installed while ${PRODUCT_NAME} restarts; nothing changes until you choose to.`
    )
    expect(updateText('de', 'offerMessage', { version: '1.1.0', current: '1.0.0' })).toBe(
      'Version 1.1.0 ist veröffentlicht. Diese Kopie ist 1.0.0.'
    )
  })

  it('leaves an unknown placeholder visible rather than blanking it', () => {
    expect(updateText('en', 'upToDateMessage')).toContain('{current}')
  })
})
