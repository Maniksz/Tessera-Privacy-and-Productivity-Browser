import { describe, expect, it } from 'vitest'
import {
  emptyExtensionDocument,
  withPath,
  withoutPath
} from '@shared/extensions/model.js'

/**
 * The remembered list of extension folders.
 *
 * Small functions, but the list is what an extension's survival across restarts depends
 * on: Electron does not persist extensions itself. A duplicate entry means loading the
 * same folder twice at startup, and a failed removal means a deleted extension comes
 * back on every launch.
 */

describe('extension document', () => {
  it('starts empty at the current version', () => {
    expect(emptyExtensionDocument()).toEqual({ version: 1, paths: [] })
  })

  it('returns a fresh document each time', () => {
    // A shared object would let one window's edits leak into another's fallback.
    const first = emptyExtensionDocument()
    first.paths.push('/tmp/one')
    expect(emptyExtensionDocument().paths).toEqual([])
  })
})

describe('withPath', () => {
  it('appends a new folder', () => {
    expect(withPath([], '/a')).toEqual(['/a'])
    expect(withPath(['/a'], '/b')).toEqual(['/a', '/b'])
  })

  it('keeps the order the user added them in', () => {
    expect(withPath(['/b', '/a'], '/c')).toEqual(['/b', '/a', '/c'])
  })

  it('ignores a folder that is already remembered', () => {
    expect(withPath(['/a', '/b'], '/a')).toEqual(['/a', '/b'])
  })

  it('does not mutate the list it was given', () => {
    const original = ['/a']
    const next = withPath(original, '/b')
    expect(original).toEqual(['/a'])
    expect(next).not.toBe(original)
  })

  it('returns a copy even when nothing changes', () => {
    // Returning the input would let a caller mutate stored state through its own
    // reference.
    const original = ['/a']
    expect(withPath(original, '/a')).not.toBe(original)
  })

  it('treats paths as exact strings, not as loose matches', () => {
    expect(withPath(['/a/b'], '/a')).toEqual(['/a/b', '/a'])
    expect(withPath(['/a'], '/a/')).toEqual(['/a', '/a/'])
  })
})

describe('withoutPath', () => {
  it('removes the named folder', () => {
    expect(withoutPath(['/a', '/b'], '/a')).toEqual(['/b'])
  })

  it('removes every occurrence, so a duplicate cannot survive a removal', () => {
    expect(withoutPath(['/a', '/b', '/a'], '/a')).toEqual(['/b'])
  })

  it('leaves the list alone when the folder is absent', () => {
    expect(withoutPath(['/a'], '/missing')).toEqual(['/a'])
  })

  it('does not mutate the list it was given', () => {
    const original = ['/a', '/b']
    withoutPath(original, '/a')
    expect(original).toEqual(['/a', '/b'])
  })

  it('empties a single-entry list', () => {
    expect(withoutPath(['/a'], '/a')).toEqual([])
  })
})
