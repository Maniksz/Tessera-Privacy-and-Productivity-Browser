import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MAX_RANKED_ROWS, rankCandidates, type RankCandidate } from '@shared/search/rank.js'
import { instrumented } from './instrumented-source.js'

/**
 * The local ranker behind address-bar suggestions and the tab search (U17, KTD11).
 *
 * What is asserted here is order, not scores: the numbers inside the ranker are tuning, and a test
 * pinned to them would only make retuning expensive. Every scenario is therefore phrased as "this row
 * comes before that one", which is also the only thing a user ever sees.
 */

const NOW = Date.UTC(2026, 8, 24, 12)
const DAY = 86_400_000

const history = (
  url: string,
  title: string,
  visitCount: number,
  daysAgo: number
): RankCandidate => ({
  source: 'history',
  url,
  title,
  visitCount,
  lastVisitedAt: NOW - daysAgo * DAY
})

const urls = (rows: readonly { url: string }[]): string[] => rows.map((row) => row.url)

describe('rankCandidates: the scenarios of U17', () => {
  it('puts a host-prefix match before a page that only has the text in its title', () => {
    const rows = rankCandidates(
      [
        // Visited far more often, so only the match class can put it second.
        history('https://example.com/blog', 'Learning git the hard way', 40, 0),
        history('https://github.com/', 'GitHub', 1, 3)
      ],
      'git',
      NOW
    )

    expect(urls(rows)).toEqual(['https://github.com/', 'https://example.com/blog'])
    expect(rows.map((row) => row.match)).toEqual(['prefix', 'word'])
  })

  it('merges history and a bookmark of the same address into one row with the bookmark as source', () => {
    const rows = rankCandidates(
      [
        history('https://github.com/?utm_source=newsletter#top', 'GitHub', 12, 1),
        { source: 'bookmark', url: 'https://github.com', title: 'Code' }
      ],
      'git',
      NOW
    )

    expect(rows).toEqual([
      { source: 'bookmark', url: 'https://github.com', title: 'Code', match: 'prefix' }
    ])
  })

  it('lets five visits yesterday outrank fifty visits ninety days ago', () => {
    const rows = rankCandidates(
      [
        history('https://docs.example.com/old', 'Docs old', 50, 90),
        history('https://docs.example.com/new', 'Docs new', 5, 1)
      ],
      'docs',
      NOW
    )

    expect(urls(rows)).toEqual(['https://docs.example.com/new', 'https://docs.example.com/old'])
  })

  it('offers nothing for empty text, and nothing for text that is only whitespace', () => {
    const candidates = [history('https://github.com/', 'GitHub', 3, 1)]

    expect(rankCandidates(candidates, '', NOW)).toEqual([])
    expect(rankCandidates(candidates, '   \t', NOW)).toEqual([])
  })

  it('returns at most eight rows out of two hundred matching candidates', () => {
    const candidates = Array.from({ length: 200 }, (_, index) =>
      history(`https://site${index}.example/`, `Site ${index}`, index, 1)
    )

    const rows = rankCandidates(candidates, 'site', NOW)

    expect(MAX_RANKED_ROWS).toBe(8)
    expect(rows).toHaveLength(8)
    // And the eight are the most visited, in order — the cap cuts the tail, not a random slice.
    expect(urls(rows)).toEqual(
      [199, 198, 197, 196, 195, 194, 193, 192].map((index) => `https://site${index}.example/`)
    )
  })

  it('ignores case and a leading www. on either side', () => {
    const candidates = [history('https://www.GitHub.com/', 'Repositories', 2, 1)]

    for (const text of ['git', 'GIT', 'GiThUb.CoM', 'www.git', 'WWW.GitHub', 'https://www.git']) {
      expect(rankCandidates(candidates, text, NOW), text).toEqual([
        {
          source: 'history',
          url: 'https://www.GitHub.com/',
          title: 'Repositories',
          match: 'prefix'
        }
      ])
    }
  })
})

describe('rankCandidates: match classes', () => {
  it('ranks prefix before word start before substring, whatever the visits say', () => {
    const rows = rankCandidates(
      [
        history('https://example.com/a', 'Collaboration notes', 90, 0), // substring "lab" in title
        history('https://example.org/', 'Tessera Labs', 30, 0), // word start in title
        history('https://labs.example/', 'Home', 1, 60) // host prefix
      ],
      'lab',
      NOW
    )

    expect(rows.map((row) => row.match)).toEqual(['prefix', 'word', 'substring'])
    expect(urls(rows)).toEqual([
      'https://labs.example/',
      'https://example.org/',
      'https://example.com/a'
    ])
  })

  it('counts a word start after punctuation, not only after a space', () => {
    const rows = rankCandidates(
      [history('https://a.example/', 'Release notes (beta)', 1, 1)],
      'beta',
      NOW
    )

    expect(rows.map((row) => row.match)).toEqual(['word'])
  })

  it('finds a word start that follows an earlier mid-word occurrence', () => {
    // "tab" occurs inside "Notable" first; the word "Tabs" comes after it.
    const rows = rankCandidates([history('https://a.example/', 'Notable Tabs', 1, 1)], 'tab', NOW)

    expect(rows.map((row) => row.match)).toEqual(['word'])
  })

  it('treats text in the middle of the address as a substring match', () => {
    const rows = rankCandidates(
      [history('https://example.com/docs/rank', 'Untitled', 1, 1)],
      'docs/ra',
      NOW
    )

    expect(rows.map((row) => row.match)).toEqual(['substring'])
  })

  it('carries a prefix match on past the host into the path', () => {
    const rows = rankCandidates(
      [history('https://github.com/mniksztat/tessera', 'Tessera', 1, 1)],
      'github.com/mnik',
      NOW
    )

    expect(rows.map((row) => row.match)).toEqual(['prefix'])
  })

  it('does not let the scheme match every address', () => {
    const rows = rankCandidates(
      [
        history('https://github.com/', 'GitHub', 1, 1),
        history('http://example.com/', 'Example', 1, 1)
      ],
      'https',
      NOW
    )

    expect(rows).toEqual([])
  })

  it('keeps a typed port as part of the address instead of reading it as a scheme', () => {
    const rows = rankCandidates(
      [history('http://localhost:3000/', 'Dev server', 1, 1)],
      'localhost:30',
      NOW
    )

    expect(rows.map((row) => row.match)).toEqual(['prefix'])
  })

  it('matches nothing for text that is only a scheme or only www.', () => {
    const candidates = [history('https://www.github.com/', 'GitHub', 1, 1)]

    expect(rankCandidates(candidates, 'https://', NOW)).toEqual([])
    expect(rankCandidates(candidates, 'www.', NOW)).toEqual([])
  })

  it('drops candidates that match nowhere', () => {
    const rows = rankCandidates(
      [
        history('https://github.com/', 'GitHub', 1, 1),
        history('https://example.com/', 'Example', 9, 0)
      ],
      'git',
      NOW
    )

    expect(urls(rows)).toEqual(['https://github.com/'])
  })
})

describe('rankCandidates: weight within a class', () => {
  it('gives an unvisited bookmark a fixed weight above a page visited a few times', () => {
    const rows = rankCandidates(
      [
        history('https://news.example/a', 'News A', 3, 0),
        { source: 'bookmark', url: 'https://news.example/b', title: 'News B' }
      ],
      'news',
      NOW
    )

    expect(urls(rows)).toEqual(['https://news.example/b', 'https://news.example/a'])
  })

  it('treats a quick link like a bookmark', () => {
    const rows = rankCandidates(
      [
        history('https://news.example/a', 'News A', 3, 0),
        { source: 'quicklink', url: 'https://news.example/q', title: 'News Q' }
      ],
      'news',
      NOW
    )

    expect(rows[0]).toEqual({
      source: 'quicklink',
      url: 'https://news.example/q',
      title: 'News Q',
      match: 'prefix'
    })
  })

  it('still lets a heavily and recently visited page pass an unvisited bookmark', () => {
    const rows = rankCandidates(
      [
        { source: 'bookmark', url: 'https://news.example/b', title: 'News B' },
        history('https://news.example/a', 'News A', 40, 0)
      ],
      'news',
      NOW
    )

    expect(urls(rows)).toEqual(['https://news.example/a', 'https://news.example/b'])
  })

  it('gives an open tab a bonus over a bookmark and over a visited page', () => {
    const rows = rankCandidates(
      [
        history('https://mail.example/inbox', 'Mail inbox', 8, 0),
        { source: 'bookmark', url: 'https://mail.example/drafts', title: 'Mail drafts' },
        { source: 'tab', url: 'https://mail.example/sent', title: 'Mail sent', tabId: 't-7' }
      ],
      'mail',
      NOW
    )

    expect(urls(rows)).toEqual([
      'https://mail.example/sent',
      'https://mail.example/drafts',
      'https://mail.example/inbox'
    ])
  })

  it('adds the visits of a bookmarked page to its bookmark weight', () => {
    // Both are bookmarks; only one also has history behind it.
    const rows = rankCandidates(
      [
        { source: 'bookmark', url: 'https://wiki.example/a', title: 'Wiki A' },
        { source: 'bookmark', url: 'https://wiki.example/b', title: 'Wiki B' },
        history('https://wiki.example/b', 'Wiki B', 2, 0)
      ],
      'wiki',
      NOW
    )

    expect(urls(rows)).toEqual(['https://wiki.example/b', 'https://wiki.example/a'])
  })

  it('counts visits without a date as nothing rather than as fresh', () => {
    const rows = rankCandidates(
      [
        { source: 'history', url: 'https://a.example/undated', title: 'Page', visitCount: 500 },
        history('https://a.example/dated', 'Page', 1, 5)
      ],
      'page',
      NOW
    )

    expect(urls(rows)).toEqual(['https://a.example/dated', 'https://a.example/undated'])
  })

  it('treats a visit stamped in the future as happening now, not as extra weight', () => {
    // Clock skew between machines must not let one entry grow without bound.
    const rows = rankCandidates(
      [
        { ...history('https://a.example/skewed', 'Page', 1, 0), lastVisitedAt: NOW + 365 * DAY },
        history('https://a.example/twice', 'Page', 2, 0)
      ],
      'page',
      NOW
    )

    expect(urls(rows)).toEqual(['https://a.example/twice', 'https://a.example/skewed'])
  })
})

describe('rankCandidates: merging', () => {
  it('keeps the tab id when a history entry and an open tab share an address', () => {
    const rows = rankCandidates(
      [
        history('https://github.com/', 'GitHub', 30, 0),
        { source: 'tab', url: 'https://github.com/#readme', title: 'GitHub · tab', tabId: 'tab-42' }
      ],
      'git',
      NOW
    )

    expect(rows).toEqual([
      {
        source: 'tab',
        url: 'https://github.com/#readme',
        title: 'GitHub · tab',
        tabId: 'tab-42',
        match: 'prefix'
      }
    ])
  })

  it('does not attach a tab id to a row whose strongest source is not a tab', () => {
    const [row] = rankCandidates([history('https://github.com/', 'GitHub', 1, 0)], 'git', NOW)

    expect(row).not.toHaveProperty('tabId')
  })

  it('ranks tab over bookmark over quick link over history as the source of a merged row', () => {
    const url = 'https://github.com/'
    const merged = (sources: RankCandidate['source'][]): string | undefined =>
      rankCandidates(
        sources.map((source) => ({ source, url, title: source })),
        'git',
        NOW
      )[0]?.source

    expect(merged(['history', 'quicklink', 'bookmark', 'tab'])).toBe('tab')
    expect(merged(['history', 'quicklink', 'bookmark'])).toBe('bookmark')
    expect(merged(['bookmark', 'quicklink', 'history'])).toBe('bookmark')
    expect(merged(['history', 'quicklink'])).toBe('quicklink')
    expect(merged(['quicklink', 'history'])).toBe('quicklink')
  })

  it('keeps the first of two open tabs on the same page', () => {
    const rows = rankCandidates(
      [
        { source: 'tab', url: 'https://github.com/', title: 'First', tabId: 'a' },
        { source: 'tab', url: 'https://github.com/', title: 'Second', tabId: 'b' }
      ],
      'git',
      NOW
    )

    expect(rows).toEqual([
      { source: 'tab', url: 'https://github.com/', title: 'First', tabId: 'a', match: 'prefix' }
    ])
  })

  it('shows a merged row when only a weaker member matches the text', () => {
    // The bookmark's own title says nothing about "hub"; the history title does.
    const rows = rankCandidates(
      [
        { source: 'bookmark', url: 'https://example.com/x', title: 'Work' },
        history('https://example.com/x', 'Hub of things', 1, 1)
      ],
      'hub',
      NOW
    )

    expect(rows).toEqual([
      { source: 'bookmark', url: 'https://example.com/x', title: 'Work', match: 'word' }
    ])
  })

  it('merges visits by the stronger member, not by their sum', () => {
    // Two copies of one page must not outrank a page visited more often than either.
    const rows = rankCandidates(
      [
        history('https://a.example/twin', 'Page', 3, 0),
        history('https://a.example/twin#again', 'Page', 3, 0),
        history('https://a.example/single', 'Page', 4, 0)
      ],
      'page',
      NOW
    )

    expect(urls(rows)).toEqual(['https://a.example/single', 'https://a.example/twin'])
  })
})

describe('rankCandidates: determinism and odd addresses', () => {
  it('breaks ties by the shorter address, then alphabetically, independent of input order', () => {
    const candidates: RankCandidate[] = [
      { source: 'bookmark', url: 'https://git.example/aaa', title: 'x' },
      { source: 'bookmark', url: 'https://git.example/zz', title: 'x' },
      { source: 'bookmark', url: 'https://git.example/aa', title: 'x' },
      { source: 'bookmark', url: 'https://git.example/', title: 'x' }
    ]
    // `/aaa` sorts before `/zz` alphabetically, so only the length rule can put it last.
    const expected = [
      'https://git.example/',
      'https://git.example/aa',
      'https://git.example/zz',
      'https://git.example/aaa'
    ]

    expect(urls(rankCandidates(candidates, 'git', NOW))).toEqual(expected)
    expect(urls(rankCandidates([...candidates].reverse(), 'git', NOW))).toEqual(expected)
  })

  it('gives the same answer twice for the same input', () => {
    const candidates = Array.from({ length: 30 }, (_, index) =>
      history(`https://git${index % 7}.example/${index}`, `Git ${index % 3}`, index % 5, index % 4)
    )

    expect(rankCandidates(candidates, 'git', NOW)).toEqual(rankCandidates(candidates, 'git', NOW))
  })

  it('handles an address without a host: an internal page and a file', () => {
    const rows = rankCandidates(
      [
        { source: 'quicklink', url: 'tessera://settings', title: 'Einstellungen' },
        history('file:///Users/me/settings.txt', 'notes', 1, 1)
      ],
      'settings',
      NOW
    )

    expect(rows).toEqual([
      { source: 'quicklink', url: 'tessera://settings', title: 'Einstellungen', match: 'prefix' },
      {
        source: 'history',
        url: 'file:///Users/me/settings.txt',
        title: 'notes',
        match: 'substring'
      }
    ])
  })

  it('keeps an unparseable address as its own row and still matches it by title', () => {
    const rows = rankCandidates(
      [
        { source: 'bookmark', url: 'not a url', title: 'Broken link' },
        { source: 'bookmark', url: 'not a url', title: 'Same broken link' }
      ],
      'broken',
      NOW
    )

    expect(rows).toEqual([
      { source: 'bookmark', url: 'not a url', title: 'Broken link', match: 'word' }
    ])
  })

  it('does not mutate the candidates it is given', () => {
    const candidates = [history('https://github.com/', 'GitHub', 1, 1)]
    const copy = structuredClone(candidates)

    rankCandidates(candidates, 'git', NOW)

    expect(candidates).toEqual(copy)
  })
})

/** Whether the mutation run reads an instrumented copy of the source checked below; see `instrumented`. */
const RANK_INSTRUMENTED = instrumented('src/shared/search/rank.ts')

/**
 * The two fitness checks of KTD11.
 *
 * They follow every import the ranker makes, relative or through `@shared/`, because the promise is
 * about what the module *pulls in*: a helper two hops away that imports zod lands in the renderer
 * bundle just the same, and one that can reach the network breaks "nothing leaves the device" (R28)
 * just the same.
 */
describe.skipIf(RANK_INSTRUMENTED)('rank.ts fitness', () => {
  const ROOT = resolve(__dirname, '..')
  const ENTRY = join(ROOT, 'src/shared/search/rank.ts')

  /** Every specifier a file imports, value or type, static or dynamic, plus `require` calls. */
  const specifiersOf = (text: string): string[] => {
    const found: string[] = []
    const patterns = [
      /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g,
      /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g
    ]
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) found.push(match[1]!)
    }
    return found
  }

  /** The source file a local specifier points at, or `null` for a package. */
  const resolveLocal = (from: string, specifier: string): string | null => {
    let base: string
    if (specifier.startsWith('.')) base = resolve(dirname(from), specifier)
    else if (specifier.startsWith('@shared/'))
      base = join(ROOT, 'src/shared', specifier.slice('@shared/'.length))
    else return null
    const path = base.replace(/\.js$/, '.ts')
    expect(existsSync(path), `${specifier} imported from ${from} does not resolve`).toBe(true)
    return path
  }

  /** The ranker and every local module it reaches, each with the specifiers it imports. */
  const closure = (): Map<string, { text: string; specifiers: string[] }> => {
    const seen = new Map<string, { text: string; specifiers: string[] }>()
    const visit = (path: string): void => {
      if (seen.has(path)) return
      const text = readFileSync(path, 'utf8')
      const specifiers = specifiersOf(text)
      seen.set(path, { text, specifiers })
      for (const specifier of specifiers) {
        const local = resolveLocal(path, specifier)
        if (local !== null) visit(local)
      }
    }
    visit(ENTRY)
    return seen
  }

  it('reuses the history normalizer instead of a second copy of it', () => {
    const entry = closure().get(ENTRY)!

    expect(entry.specifiers).toContain('../history/model.js')
    expect(entry.text).toMatch(/\bhistoryUrlOf\b/)
  })

  it('imports no zod, directly or through anything it imports', () => {
    const modules = closure()

    expect(modules.size).toBeGreaterThan(1)
    for (const [path, { specifiers }] of modules) {
      for (const specifier of specifiers) {
        expect(specifier, `${path} imports ${specifier}`).not.toMatch(/^zod(\/|$)/)
      }
    }
  })

  it('imports nothing from the network layer and calls no network API', () => {
    const NETWORK_PACKAGES =
      /^(?:node:)?(?:net|http|https|http2|dns|tls|dgram)(?:\/|$)|^electron(?:\/|$)|^undici|^ws$|^node-fetch|^axios/
    const MAIN = join(ROOT, 'src/main')

    for (const [path, { text, specifiers }] of closure()) {
      expect(path.startsWith(MAIN), `${path} is main-process code`).toBe(false)
      for (const specifier of specifiers) {
        expect(specifier, `${path} imports ${specifier}`).not.toMatch(NETWORK_PACKAGES)
        expect(specifier, `${path} imports ${specifier}`).not.toMatch(/^@main\//)
      }
      expect(text, `${path} calls a network API`).not.toMatch(
        /\bfetch\(|\bXMLHttpRequest\b|\bWebSocket\b|\bEventSource\b|\bsendBeacon\b/
      )
    }
  })
})
