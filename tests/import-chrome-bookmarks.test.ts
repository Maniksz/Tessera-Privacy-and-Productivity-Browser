import { describe, expect, it } from 'vitest'
import { parseChromeBookmarks } from '@shared/import/chrome-bookmarks.js'
import { MAX_IMPORT_LENGTH, graftImportedBookmarks } from '@shared/bookmarks/import.js'
import {
  BOOKMARK_BAR_ID,
  BOOKMARK_OTHER_ID,
  childrenOf,
  type Bookmark
} from '@shared/bookmarks/model.js'

/**
 * The `Bookmarks` file of a Chrome, Edge or Chromium profile (U24, R39, KTD19).
 *
 * JSON rather than the Netscape export, so no step in the other browser is needed. Its three roots
 * land where the HTML import puts them: the bar on our bar, everything else in one folder. The file is
 * as untrusted as an export — a `javascript:` entry is counted and refused by the same `bookmarkUrlOf`.
 */

const T0 = 1_700_000_000_000

interface ChromeNode {
  type: string
  name?: string
  url?: string
  date_added?: string
  children?: ChromeNode[]
}

function file(roots: Record<string, ChromeNode>): string {
  return JSON.stringify({ checksum: 'x', roots, version: 1 })
}

const PROFILE = file({
  bookmark_bar: {
    type: 'folder',
    name: 'Bookmarks bar',
    children: [
      { type: 'url', name: 'News', url: 'https://news.example/', date_added: '13345678901234567' },
      {
        type: 'folder',
        name: 'Work',
        date_added: '13345678901234567',
        children: [
          {
            type: 'folder',
            name: 'Deep',
            children: [{ type: 'url', name: 'Tickets', url: 'https://tickets.example/board' }]
          },
          { type: 'url', name: 'Evil', url: 'javascript:alert(1)' }
        ]
      }
    ]
  },
  other: {
    type: 'folder',
    name: 'Other bookmarks',
    children: [{ type: 'url', name: 'Elsewhere', url: 'https://elsewhere.example/' }]
  },
  synced: {
    type: 'folder',
    name: 'Mobile bookmarks',
    children: [{ type: 'url', name: 'Phone', url: 'https://phone.example/' }]
  }
})

function graft(json: string, nodes: readonly Bookmark[] = [], prefix = 'i') {
  const report = parseChromeBookmarks(json)
  if (report === null) throw new Error('not a bookmarks file')
  let counter = 0
  return graftImportedBookmarks([...nodes], report, {
    nextId: () => `${prefix}${(counter += 1)}`,
    now: T0,
    folderTitle: 'From Chrome'
  })
}

describe('reading a Chrome profile’s bookmarks', () => {
  it('keeps the bar, “other bookmarks” and nested folders as they were', () => {
    const report = parseChromeBookmarks(PROFILE)
    expect(report?.nodes.map((node) => [node.title, node.onToolbar])).toEqual([
      ['Bookmarks bar', true],
      ['Elsewhere', false],
      ['Mobile bookmarks', false]
    ])

    const result = graft(PROFILE)
    expect(childrenOf(result.nodes, BOOKMARK_BAR_ID).map((node) => node.title)).toEqual([
      'News',
      'Work'
    ])
    const work = result.nodes.find((node) => node.title === 'Work')
    const deep = result.nodes.find((node) => node.title === 'Deep')
    expect(childrenOf(result.nodes, work?.id ?? '').map((node) => node.title)).toEqual(['Deep'])
    expect(childrenOf(result.nodes, deep?.id ?? '').map((node) => node.url)).toEqual([
      'https://tickets.example/board'
    ])
    const [folder] = childrenOf(result.nodes, BOOKMARK_OTHER_ID)
    expect(folder?.title).toBe('From Chrome')
    expect(childrenOf(result.nodes, folder?.id ?? '').map((node) => node.title)).toEqual([
      'Elsewhere',
      'Mobile bookmarks'
    ])
  })

  it('refuses a javascript: entry and counts it', () => {
    expect(parseChromeBookmarks(PROFILE)?.skipped).toBe(1)
    const result = graft(PROFILE)
    expect(result.skipped).toBe(1)
    expect(result.nodes.some((node) => node.url.startsWith('javascript:'))).toBe(false)
  })

  it('dates each entry from `date_added`, Chrome’s microseconds since 1601', () => {
    const result = graft(PROFILE)
    expect(result.nodes.find((node) => node.title === 'News')?.createdAt).toBe(1_701_205_301_234)
    expect(result.nodes.find((node) => node.title === 'Work')?.createdAt).toBe(1_701_205_301_234)
    // No date at all: the import's own time.
    expect(result.nodes.find((node) => node.title === 'Elsewhere')?.createdAt).toBe(T0)
  })

  it('does not create a bookmark twice when the same profile is imported again', () => {
    const first = graft(PROFILE)
    const second = graft(PROFILE, first.nodes, 'j')
    expect(second.nodes).toEqual(first.nodes)
    expect(second.imported).toBe(0)
    expect(second.duplicates).toBe(4)
  })

  it('leaves out an empty mobile root and a root it does not know', () => {
    const report = parseChromeBookmarks(
      file({
        bookmark_bar: { type: 'folder', children: [] },
        synced: { type: 'folder', name: 'Mobile bookmarks', children: [] },
        workspace: {
          type: 'folder',
          children: [{ type: 'url', url: 'https://w.example/' }]
        }
      })
    )
    expect(report?.nodes.map((node) => node.title)).toEqual([''])
    expect(report?.nodes[0]?.onToolbar).toBe(true)
  })

  it('reads a folder without children and an entry without a name', () => {
    const report = parseChromeBookmarks(
      file({
        other: {
          type: 'folder',
          children: [
            { type: 'folder', name: '  Empty  ' },
            { type: 'url', url: 'https://nameless.example/' },
            { type: 'url', name: 'No address' },
            { type: 'separator' }
          ]
        }
      })
    )
    expect(report?.nodes.map((node) => [node.kind, node.title, node.url])).toEqual([
      ['folder', 'Empty', ''],
      ['bookmark', '', 'https://nameless.example/']
    ])
    // The entry without an address and the node of a type Chrome does not write are refused.
    expect(report?.skipped).toBe(2)
  })

  it('does not overflow the stack on a deeply nested file', () => {
    let deepest: ChromeNode = { type: 'url', name: 'Bottom', url: 'https://bottom.example/' }
    for (let level = 0; level < 5_000; level += 1) {
      deepest = { type: 'folder', name: 'F', children: [deepest] }
    }
    const report = parseChromeBookmarks(file({ other: { type: 'folder', children: [deepest] } }))
    expect(report?.nodes).toHaveLength(1)
  })

  it('answers null for a file that is not a Chrome bookmarks file', () => {
    for (const text of ['', 'not json', '[]', 'null', '{"roots": 3}', '{"version": 1}']) {
      expect(parseChromeBookmarks(text), text).toBeNull()
    }
    expect(parseChromeBookmarks(' '.repeat(MAX_IMPORT_LENGTH + 1))).toBeNull()
  })

  it('reads roots and children that are not objects as nothing', () => {
    const report = parseChromeBookmarks(
      JSON.stringify({
        roots: {
          bookmark_bar: 'nope',
          other: { type: 'folder', children: [null, 3, { type: 'url', url: 7 }] },
          synced: { type: 'folder', children: 'nope' }
        }
      })
    )
    expect(report).toEqual({ nodes: [], skipped: 3 })
  })
})
