import { describe, expect, it } from 'vitest'
import { liveContentsOf } from '@main/browser/view-contents.js'

/**
 * `liveContentsOf`: the one answer to "is there a live page in this view".
 *
 * The case that matters is the second one. Electron's typings promise a `WebContents` on every view, and its
 * getter hands back `undefined` once the page has gone — which a `view.webContents.isDestroyed()` guard reads
 * as a crash rather than as "no". The rest of the codebase's fakes model that as well, in
 * `tests/tab-unloader.test.ts`, where the real `Tab` and the real close contract run against it.
 */

function contents(destroyed: boolean): { isDestroyed(): boolean; readonly id: number } {
  return { id: 7, isDestroyed: () => destroyed }
}

describe('liveContentsOf', () => {
  it('hands back the contents of a view whose page is live', () => {
    const page = contents(false)
    expect(liveContentsOf({ webContents: page })).toBe(page)
  })

  it('answers null for a view Electron has emptied, without asking anything of it', () => {
    expect(liveContentsOf({ webContents: undefined })).toBeNull()
    expect(liveContentsOf({ webContents: null })).toBeNull()
  })

  it('answers null for contents that are still attached but destroyed', () => {
    expect(liveContentsOf({ webContents: contents(true) })).toBeNull()
  })

  it('answers null when there is no view at all', () => {
    expect(liveContentsOf(undefined)).toBeNull()
    expect(liveContentsOf(null)).toBeNull()
  })

  it('reads the getter once, so a page going between two reads cannot be half seen', () => {
    let reads = 0
    const page = contents(false)
    const view = {
      get webContents() {
        reads += 1
        return page
      }
    }
    expect(liveContentsOf(view)).toBe(page)
    expect(reads).toBe(1)
  })
})
