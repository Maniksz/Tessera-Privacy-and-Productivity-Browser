import { describe, expect, it } from 'vitest'
import {
  InvalidQuickLinkUrlError,
  MAX_QUICK_LINKS,
  MAX_TITLE_LENGTH,
  QuickLinkLimitError,
  QuickLinkNestingError,
  QuickLinkNotFoundError,
  childrenOf,
  countChildren,
  createLink,
  emptyQuickLinkDocument,
  findLink,
  isQuickLinkKind,
  moveLink,
  normalizeQuickLinkUrl,
  removeLink,
  repairTree,
  titleFromUrl,
  updateLink,
  type QuickLink
} from '@shared/quicklinks/model.js'
import { quickLinkDocumentSchema, quickLinkSchema } from '@shared/quicklinks/schema.js'

/**
 * The pure quick-link operations.
 *
 * The Gherkin feature covers the behaviour a user would describe; these cover the
 * edges a user would never think to describe but which decide whether the data
 * survives — index clamping, ordering across parents, and what happens to a
 * document that is already inconsistent.
 */

let counter = 0
function ctx() {
  counter += 1
  return { id: `id-${counter}`, now: 1_700_000_000_000 + counter }
}

function link(overrides: Partial<QuickLink> = {}): QuickLink {
  return {
    id: 'l1',
    kind: 'link',
    title: 'Example',
    url: 'https://example.com',
    parentId: null,
    createdAt: 1,
    ...overrides
  }
}

describe('normalizeQuickLinkUrl', () => {
  it('adds https to a bare host', () => {
    expect(normalizeQuickLinkUrl('example.com')).toBe('https://example.com')
  })

  it('keeps an explicit scheme', () => {
    expect(normalizeQuickLinkUrl('http://example.com/a')).toBe('http://example.com/a')
  })

  it('refuses a search term rather than turning it into a search', () => {
    expect(() => normalizeQuickLinkUrl('how tall is everest')).toThrow(InvalidQuickLinkUrlError)
  })

  it('refuses an empty address', () => {
    expect(() => normalizeQuickLinkUrl('')).toThrow(InvalidQuickLinkUrlError)
  })

  it('refuses javascript URLs', () => {
    expect(() => normalizeQuickLinkUrl('javascript:alert(1)')).toThrow(InvalidQuickLinkUrlError)
  })

  it('carries the offending input on the error, for the message shown to the user', () => {
    try {
      normalizeQuickLinkUrl('not a url')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as InvalidQuickLinkUrlError).input).toBe('not a url')
    }
  })
})

describe('titleFromUrl', () => {
  it('uses the host without www', () => {
    expect(titleFromUrl('https://www.example.com/path')).toBe('example.com')
  })

  it('keeps a subdomain that is not www', () => {
    expect(titleFromUrl('https://mail.example.com')).toBe('mail.example.com')
  })

  it('falls back to the path for a hostless URL', () => {
    expect(titleFromUrl('tessera://settings')).toBe('settings')
  })

  it('returns the input unchanged when it cannot be parsed', () => {
    expect(titleFromUrl('nonsense')).toBe('nonsense')
  })

  it('never answers with an empty string, even for an address with neither host nor path', () => {
    /*
      The last uncovered branch in this function, and it matters: the answer becomes a tile's title
      when the user leaves the name blank, and a tile with no text is one they cannot identify or
      decide about. `mailto:` parses, has no host and has an empty path — so both earlier branches
      produce nothing and only the fallback saves it.
    */
    expect(titleFromUrl('mailto:')).toBe('mailto:')
    for (const url of ['mailto:', 'tessera://start', 'https://example.com/', 'nonsense', 'a b']) {
      expect(titleFromUrl(url), url).not.toBe('')
    }
  })
})

describe('createLink', () => {
  it('stores a normalised URL', () => {
    const links = createLink([], { kind: 'link', title: 'X', url: 'example.com' }, ctx())
    expect(links[0]?.url).toBe('https://example.com')
  })

  it('derives the title from the URL when none is given', () => {
    const links = createLink([], { kind: 'link', title: '  ', url: 'example.com' }, ctx())
    expect(links[0]?.title).toBe('example.com')
  })

  it('trims a title and caps its length', () => {
    const long = 'x'.repeat(MAX_TITLE_LENGTH + 40)
    const links = createLink([], { kind: 'link', title: long, url: 'example.com' }, ctx())
    expect(links[0]?.title).toHaveLength(MAX_TITLE_LENGTH)
  })

  it('gives a folder no URL', () => {
    const links = createLink([], { kind: 'folder', title: 'Work' }, ctx())
    expect(links[0]?.url).toBe('')
  })

  it('appends by default', () => {
    let links = createLink([], { kind: 'link', title: 'A', url: 'a.example' }, ctx())
    links = createLink(links, { kind: 'link', title: 'B', url: 'b.example' }, ctx())
    expect(links.map((l) => l.title)).toEqual(['A', 'B'])
  })

  it('inserts at a requested index', () => {
    let links = createLink([], { kind: 'link', title: 'A', url: 'a.example' }, ctx())
    links = createLink(links, { kind: 'link', title: 'B', url: 'b.example' }, ctx())
    links = createLink(links, { kind: 'link', title: 'C', url: 'c.example', index: 0 }, ctx())
    expect(links.map((l) => l.title)).toEqual(['C', 'A', 'B'])
  })

  it('clamps a negative index to the front', () => {
    let links = createLink([], { kind: 'link', title: 'A', url: 'a.example' }, ctx())
    links = createLink(links, { kind: 'link', title: 'B', url: 'b.example', index: -5 }, ctx())
    expect(links.map((l) => l.title)).toEqual(['B', 'A'])
  })

  it('refuses a parent that does not exist', () => {
    expect(() =>
      createLink([], { kind: 'link', title: 'X', url: 'a.example', parentId: 'nope' }, ctx())
    ).toThrow(QuickLinkNotFoundError)
  })

  it('refuses a parent that is not a folder', () => {
    const links = [link({ id: 'p', kind: 'link' })]
    expect(() =>
      createLink(links, { kind: 'link', title: 'X', url: 'a.example', parentId: 'p' }, ctx())
    ).toThrow(QuickLinkNestingError)
  })

  it('refuses a folder inside a folder', () => {
    const links = [link({ id: 'f', kind: 'folder', url: '' })]
    expect(() => createLink(links, { kind: 'folder', title: 'Inner', parentId: 'f' }, ctx())).toThrow(
      QuickLinkNestingError
    )
  })

  it('refuses to exceed the limit rather than growing without bound', () => {
    const links = Array.from({ length: MAX_QUICK_LINKS }, (_, index) =>
      link({ id: `l${index}` })
    )
    expect(() => createLink(links, { kind: 'link', title: 'X', url: 'a.example' }, ctx())).toThrow(
      QuickLinkLimitError
    )
  })
})

describe('updateLink', () => {
  it('changes a title', () => {
    const links = updateLink([link()], 'l1', { title: 'Renamed' })
    expect(links[0]?.title).toBe('Renamed')
  })

  it('normalises a new URL', () => {
    const links = updateLink([link()], 'l1', { url: 'other.example' })
    expect(links[0]?.url).toBe('https://other.example')
  })

  it('refuses an unusable URL and leaves the entry alone', () => {
    expect(() => updateLink([link()], 'l1', { url: 'not a url' })).toThrow(InvalidQuickLinkUrlError)
  })

  it('refuses to give a folder an address', () => {
    const folder = link({ kind: 'folder', url: '' })
    expect(() => updateLink([folder], 'l1', { url: 'example.com' })).toThrow(QuickLinkNestingError)
  })

  it('refuses an unknown id', () => {
    expect(() => updateLink([], 'missing', { title: 'X' })).toThrow(QuickLinkNotFoundError)
  })

  it('leaves an empty title as the URL-derived one rather than blank', () => {
    const links = updateLink([link({ title: 'Something' })], 'l1', { title: '   ' })
    expect(links[0]?.title).toBe('example.com')
  })

})

describe('removeLink', () => {
  it('removes a single link', () => {
    expect(removeLink([link()], 'l1')).toEqual([])
  })

  it('removes a folder together with its children', () => {
    const links = [
      link({ id: 'f', kind: 'folder', url: '' }),
      link({ id: 'c1', parentId: 'f' }),
      link({ id: 'c2', parentId: 'f' }),
      link({ id: 'keep' })
    ]
    expect(removeLink(links, 'f').map((l) => l.id)).toEqual(['keep'])
  })

  it('refuses an unknown id instead of silently doing nothing', () => {
    expect(() => removeLink([], 'missing')).toThrow(QuickLinkNotFoundError)
  })
})

describe('moveLink', () => {
  const three = [link({ id: 'a', title: 'A' }), link({ id: 'b', title: 'B' }), link({ id: 'c', title: 'C' })]

  it('moves to the front', () => {
    expect(moveLink(three, 'c', null, 0).map((l) => l.id)).toEqual(['c', 'a', 'b'])
  })

  it('moves to the middle', () => {
    expect(moveLink(three, 'a', null, 1).map((l) => l.id)).toEqual(['b', 'a', 'c'])
  })

  it('appends when the index is past the end', () => {
    expect(moveLink(three, 'a', null, 99).map((l) => l.id)).toEqual(['b', 'c', 'a'])
  })

  it('is a no-op in effect when moving to its own position', () => {
    expect(moveLink(three, 'b', null, 1).map((l) => l.id)).toEqual(['a', 'b', 'c'])
  })

  it('files a link into a folder', () => {
    const links = [link({ id: 'f', kind: 'folder', url: '' }), link({ id: 'a' })]
    const moved = moveLink(links, 'a', 'f', 0)
    expect(findLink(moved, 'a')?.parentId).toBe('f')
    expect(childrenOf(moved, null).map((l) => l.id)).toEqual(['f'])
  })

  it('takes a link back out of a folder', () => {
    const links = [link({ id: 'f', kind: 'folder', url: '' }), link({ id: 'a', parentId: 'f' })]
    const moved = moveLink(links, 'a', null, 0)
    expect(findLink(moved, 'a')?.parentId).toBeNull()
  })

  it('refuses to move an item into itself', () => {
    const links = [link({ id: 'f', kind: 'folder', url: '' })]
    expect(() => moveLink(links, 'f', 'f', 0)).toThrow(QuickLinkNestingError)
  })

  it('refuses to nest folders', () => {
    const links = [
      link({ id: 'f1', kind: 'folder', url: '' }),
      link({ id: 'f2', kind: 'folder', url: '' })
    ]
    expect(() => moveLink(links, 'f2', 'f1', 0)).toThrow(QuickLinkNestingError)
  })

  it('refuses a parent that is not a folder', () => {
    const links = [link({ id: 'a' }), link({ id: 'b' })]
    expect(() => moveLink(links, 'a', 'b', 0)).toThrow(QuickLinkNestingError)
  })

  it('refuses an unknown id', () => {
    expect(() => moveLink([], 'missing', null, 0)).toThrow(QuickLinkNotFoundError)
  })

  it('refuses an unknown parent', () => {
    expect(() => moveLink([link({ id: 'a' })], 'a', 'nope', 0)).toThrow(QuickLinkNotFoundError)
  })

  it('keeps siblings of other parents undisturbed', () => {
    // The list is flat, so a sibling index has to be translated to an absolute
    // one. This is the case that catches a translation mistake.
    const links = [
      link({ id: 'f', kind: 'folder', url: '' }),
      link({ id: 'in1', parentId: 'f' }),
      link({ id: 'top1' }),
      link({ id: 'in2', parentId: 'f' }),
      link({ id: 'top2' })
    ]
    const moved = moveLink(links, 'top2', null, 0)
    expect(childrenOf(moved, null).map((l) => l.id)).toEqual(['top2', 'f', 'top1'])
    expect(childrenOf(moved, 'f').map((l) => l.id)).toEqual(['in1', 'in2'])
  })
})

describe('childrenOf and countChildren', () => {
  const links = [
    link({ id: 'f', kind: 'folder', url: '' }),
    link({ id: 'a', parentId: 'f' }),
    link({ id: 'b', parentId: 'f' }),
    link({ id: 'top' })
  ]

  it('lists a folder’s children in order', () => {
    expect(childrenOf(links, 'f').map((l) => l.id)).toEqual(['a', 'b'])
  })

  it('lists the top level for null', () => {
    expect(childrenOf(links, null).map((l) => l.id)).toEqual(['f', 'top'])
  })

  it('counts children', () => {
    expect(countChildren(links, 'f')).toBe(2)
    expect(countChildren(links, 'top')).toBe(0)
  })
})

describe('repairTree', () => {
  it('re-parents a link whose folder is missing', () => {
    const links = [link({ id: 'a', parentId: 'ghost' })]
    expect(repairTree(links)[0]?.parentId).toBeNull()
  })

  it('re-parents a link whose parent is not a folder', () => {
    const links = [link({ id: 'p', kind: 'link' }), link({ id: 'a', parentId: 'p' })]
    expect(repairTree(links)[1]?.parentId).toBeNull()
  })

  it('flattens a nested folder', () => {
    const links = [
      link({ id: 'f1', kind: 'folder', url: '' }),
      link({ id: 'f2', kind: 'folder', url: '', parentId: 'f1' })
    ]
    expect(repairTree(links)[1]?.parentId).toBeNull()
  })

  it('leaves a healthy tree untouched', () => {
    const links = [
      link({ id: 'f', kind: 'folder', url: '' }),
      link({ id: 'a', parentId: 'f' })
    ]
    expect(repairTree(links)).toEqual(links)
  })
})

describe('schema and model agree', () => {
  it('validates a well-formed link', () => {
    expect(quickLinkSchema.safeParse(link()).success).toBe(true)
  })

  it('rejects an empty id', () => {
    expect(quickLinkSchema.safeParse(link({ id: '' })).success).toBe(false)
  })

  it('rejects an over-long title', () => {
    expect(quickLinkSchema.safeParse(link({ title: 'x'.repeat(MAX_TITLE_LENGTH + 1) })).success).toBe(
      false
    )
  })

  it('rejects an unknown kind', () => {
    expect(quickLinkSchema.safeParse({ ...link(), kind: 'widget' }).success).toBe(false)
  })

  it('validates an empty document', () => {
    expect(quickLinkDocumentSchema.safeParse(emptyQuickLinkDocument()).success).toBe(true)
  })

  it('rejects a document with the wrong version', () => {
    expect(quickLinkDocumentSchema.safeParse({ version: 2, links: [] }).success).toBe(false)
  })

  it('rejects a document over the limit', () => {
    const links = Array.from({ length: MAX_QUICK_LINKS + 1 }, (_, i) => link({ id: `l${i}` }))
    expect(quickLinkDocumentSchema.safeParse({ version: 1, links }).success).toBe(false)
  })
})

describe('isQuickLinkKind', () => {
  it('accepts the two kinds', () => {
    expect(isQuickLinkKind('link')).toBe(true)
    expect(isQuickLinkKind('folder')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isQuickLinkKind('widget')).toBe(false)
    expect(isQuickLinkKind(null)).toBe(false)
    expect(isQuickLinkKind(1)).toBe(false)
  })
})
