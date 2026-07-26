import { describe, expect, it } from 'vitest'
import { LOCALES, type Locale } from '@shared/i18n/catalog.js'
import {
  MEDIA_MESSAGES_DE,
  MEDIA_MESSAGES_EN,
  manifestFailureSentence,
  mediaMessage,
  mediaMessageKeys,
  refusalSentence
} from '@shared/media/messages.js'
import { DOWNLOAD_REFUSALS, MANIFEST_FAILURES } from '@shared/media/model.js'

/**
 * The words behind the codes.
 *
 * Every value in `DOWNLOAD_REFUSALS` exists because the interface has to explain a
 * decision — that is why the list says `separate-audio-track` and `dash-needs-muxer`
 * rather than one `unsupported`. These tests hold the other half of that: that each one
 * has a sentence, in both languages, and that a code cannot reach a user by the sentence
 * being missing.
 */

const fragments: Readonly<Record<Locale, Readonly<Record<string, string>>>> = {
  en: MEDIA_MESSAGES_EN,
  de: MEDIA_MESSAGES_DE
}

describe('media message coverage', () => {
  it('has a sentence for every refusal in every language', () => {
    for (const locale of LOCALES) {
      for (const refusal of DOWNLOAD_REFUSALS) {
        const sentence = refusalSentence(locale, refusal)
        expect(sentence, `${locale}/${refusal}`).not.toBe('')
        // The code itself must not be the answer: that is the failure this whole file
        // exists to prevent.
        expect(sentence, `${locale}/${refusal}`).not.toContain(refusal)
      }
    }
  })

  it('has a sentence for every manifest failure in every language', () => {
    for (const locale of LOCALES) {
      for (const failure of MANIFEST_FAILURES) {
        const sentence = manifestFailureSentence(locale, failure)
        expect(sentence, `${locale}/${failure}`).not.toBe('')
        expect(sentence, `${locale}/${failure}`).not.toContain(failure)
      }
    }
  })

  it('covers exactly the derived key set, in both languages', () => {
    // Derived from the enumerations rather than restated, so a refusal added to the model
    // with nothing written for it fails here as well as at compile time.
    const expected = [...mediaMessageKeys()].sort()
    for (const locale of LOCALES) {
      expect(Object.keys(fragments[locale]).sort(), locale).toEqual(expected)
    }
  })

  it('writes trimmed sentences rather than restating the enumeration', () => {
    for (const locale of LOCALES) {
      for (const key of mediaMessageKeys()) {
        const sentence = mediaMessage(locale, key)
        expect(sentence.trim(), `${locale}/${key}`).toBe(sentence)
        expect(sentence.length, `${locale}/${key}`).toBeGreaterThan(3)
      }
    }
  })

  it('uses no placeholders, because two resolvers would fill them differently', () => {
    /*
      These sentences are resolved twice over: by the core through `refusalSentence`, and by
      a renderer through the catalogue it fetched, which interpolates. A `{placeholder}`
      would come out filled on one path and literal on the other — and the literal one is
      the path the user sees.
    */
    for (const locale of LOCALES) {
      for (const key of mediaMessageKeys()) {
        expect(mediaMessage(locale, key), `${locale}/${key}`).not.toMatch(/\{\w+\}/)
      }
    }
  })

  it('files every key under the media namespace', () => {
    // The catalogue is composed from this fragment; a key outside the namespace would
    // collide with something else in it.
    for (const key of mediaMessageKeys()) {
      expect(key.startsWith('media.'), key).toBe(true)
    }
  })

  it('says something different in each language', () => {
    // A German catalogue that quietly held the English string would pass every check
    // above. The panel labels are short enough that a coincidence is possible, so this
    // asks it of the refusals, which are sentences.
    for (const refusal of DOWNLOAD_REFUSALS) {
      expect(refusalSentence('de', refusal), refusal).not.toBe(refusalSentence('en', refusal))
    }
  })
})
