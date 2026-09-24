import { describe, expect, it } from 'vitest'
import { textOf } from '@shared/import/text.js'

/** The one text rule both bookmark readers apply to a stored name or title (U24). */
describe('textOf', () => {
  it('folds every run of whitespace into one space and trims the ends', () => {
    expect(textOf('  Reading\n\tlist   later ')).toBe('Reading list later')
    expect(textOf('Plain')).toBe('Plain')
  })

  it('answers the empty string for anything that is not text', () => {
    for (const value of [undefined, null, 42, 42n, {}, ['a']]) expect(textOf(value)).toBe('')
    expect(textOf('   ')).toBe('')
  })
})
