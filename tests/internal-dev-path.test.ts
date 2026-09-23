import { describe, expect, it } from 'vitest'
import { devServerPathFor } from '../src/main/internal-dev-path.js'

describe('where the development server keeps what an internal page asked for', () => {
  it('finds the entry script a page wrote relative to its own file', () => {
    expect(devServerPathFor('/start.tsx')).toBe('/internal/start.tsx')
    expect(devServerPathFor('/settings.tsx')).toBe('/internal/settings.tsx')
  })

  it('leaves the paths Vite itself serves alone', () => {
    expect(devServerPathFor('/@vite/client')).toBe('/@vite/client')
    expect(devServerPathFor('/@react-refresh')).toBe('/@react-refresh')
    expect(devServerPathFor('/@fs/Users/x/project/src/shared/url/omnibox.ts')).toBe(
      '/@fs/Users/x/project/src/shared/url/omnibox.ts'
    )
  })

  it('leaves the absolute imports Vite rewrote alone', () => {
    expect(devServerPathFor('/internal/StartPage.tsx')).toBe('/internal/StartPage.tsx')
    expect(devServerPathFor('/node_modules/.vite/deps/react.js')).toBe(
      '/node_modules/.vite/deps/react.js'
    )
  })

  it('finds a stylesheet a page linked relative to its own file', () => {
    expect(devServerPathFor('/start.css')).toBe('/internal/start.css')
  })
})
