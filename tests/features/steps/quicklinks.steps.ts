import { writeFileSync } from 'node:fs'
import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import { QuickLinkStore } from '@main/data/QuickLinkStore.js'
import { childrenOf, countChildren, type QuickLink } from '@shared/quicklinks/model.js'
import { capture, captureAsync, quickLinkStore, scope, tempFile } from './world.js'

/**
 * Steps for `quicklinks.feature`.
 *
 * These drive the real `QuickLinkStore` against a temporary file, not a stub. The
 * scenarios include restart and corrupt-file cases, and a stub would prove nothing
 * about either — the interesting behaviour is precisely what happens between the
 * in-memory list and the bytes on disk.
 */

async function openStore(state: unknown, filePath: string): Promise<void> {
  let counter = 0
  const store = await QuickLinkStore.open({
    filePath,
    // Deterministic ids and timestamps: a scenario that asserts on order must not
    // depend on how fast the machine happens to be.
    generateId: () => `id-${++counter}`,
    now: () => 1_700_000_000_000,
    debounceMs: 0
  })
  const current = scope(state)
  current.quickLinkStore = store
  current.quickLinksFilePath = filePath
}

function links(state: unknown): QuickLink[] {
  return quickLinkStore(state).list()
}

function byName(state: unknown, name: string): QuickLink {
  const found = links(state).find((link) => link.title === name)
  if (found === undefined) {
    throw new Error(`no tile named "${name}"; have: ${links(state).map((l) => l.title).join(', ')}`)
  }
  return found
}

// --- background --------------------------------------------------------------

Given('an empty set of quick links', async (state: unknown) => {
  const filePath = tempFile('ql', 'quicklinks.json')
  scope(state).scratch['filePath'] = filePath
  await openStore(state, filePath)
})

Given('the quick links file contains {string}', async (state: unknown, contents: string) => {
  const filePath = tempFile('ql', 'quicklinks.json')
  writeFileSync(filePath, contents)
  scope(state).scratch['filePath'] = filePath
  })

Given('the quick links file references a folder that does not exist', async (state: unknown) => {
  const filePath = tempFile('ql', 'quicklinks.json')
  writeFileSync(
    filePath,
    JSON.stringify({
      version: 1,
      links: [
        {
          id: 'orphan',
          kind: 'link',
          title: 'Orphan',
          url: 'https://example.com',
          // Points at a folder that is not in the document.
          parentId: 'missing-folder',
          faviconPath: null,
          createdAt: 1
        }
      ]
    })
  )
  scope(state).scratch['filePath'] = filePath
  })

// --- given: existing tiles ---------------------------------------------------

Given('a tile named {string} for {string}', (state: unknown, name: string, url: string) => {
  quickLinkStore(state).create({ kind: 'link', title: name, url })
})

Given('a folder named {string}', (state: unknown, name: string) => {
  quickLinkStore(state).create({ kind: 'folder', title: name })
})

Given(
  'a tile named {string} for {string} inside the folder {string}',
  (state: unknown, name: string, url: string, folder: string) => {
    quickLinkStore(state).create({
      kind: 'link',
      title: name,
      url,
      parentId: byName(state, folder).id
    })
  }
)

Given('the following tiles:', (state: unknown, table: { hashes(): Array<Record<string, string>> }) => {
  for (const row of table.hashes()) {
    quickLinkStore(state).create({ kind: 'link', title: row['name'] ?? '', url: row['url'] ?? '' })
  }
})

// --- when --------------------------------------------------------------------

When('I add a tile named {string} for {string}', (state: unknown, name: string, url: string) => {
  quickLinkStore(state).create({ kind: 'link', title: name, url })
})

When(
  'I try to add a tile named {string} for {string}',
  (state: unknown, name: string, url: string) => {
    capture(state, () => {
      quickLinkStore(state).create({ kind: 'link', title: name, url })
    })
  }
)

When(
  'I try to add a folder named {string} inside the folder {string}',
  (state: unknown, name: string, folder: string) => {
    capture(state, () => {
      quickLinkStore(state).create({
        kind: 'folder',
        title: name,
        parentId: byName(state, folder).id
      })
    })
  }
)

When('I rename the tile {string} to {string}', (state: unknown, from: string, to: string) => {
  quickLinkStore(state).update(byName(state, from).id, { title: to })
})

When('I try to set the address of {string} to {string}', (state: unknown, name: string, url: string) => {
  capture(state, () => {
    quickLinkStore(state).update(byName(state, name).id, { url })
  })
})

When('I move the tile {string} to position {int}', (state: unknown, name: string, index: number) => {
  quickLinkStore(state).move(byName(state, name).id, null, index)
})

When('I move the tile {string} into the folder {string}', (state: unknown, name: string, folder: string) => {
  quickLinkStore(state).move(byName(state, name).id, byName(state, folder).id, 0)
})

When(
  'I try to move the tile {string} into the folder {string}',
  (state: unknown, name: string, folder: string) => {
    capture(state, () => {
      quickLinkStore(state).move(byName(state, name).id, byName(state, folder).id, 0)
    })
  }
)

When('I remove the tile {string}', (state: unknown, name: string) => {
  quickLinkStore(state).remove(byName(state, name).id)
})

When('the quick links are written and read back', async (state: unknown) => {
  // Flush first, then reopen from the same path: this is what makes the scenario a
  // persistence test rather than a test of the in-memory list.
  await quickLinkStore(state).flush()
  const filePath = scope(state).quickLinksFilePath
  if (filePath === null) throw new Error('no quick links file in this scenario')
  await openStore(state, filePath)
})

When('the quick links are read', async (state: unknown) => {
  await captureAsync(state, async () => {
    await openStore(state, scope(state).scratch['filePath'] as string)
  })
})

// --- then --------------------------------------------------------------------

Then('there is {int} tile at the top level', (state: unknown, count: number) => {
  expect(childrenOf(links(state), null)).toHaveLength(count)
})

Then('there are {int} tiles at the top level', (state: unknown, count: number) => {
  expect(childrenOf(links(state), null)).toHaveLength(count)
})

Then('the tile {string} points at {string}', (state: unknown, name: string, url: string) => {
  expect(byName(state, name).url).toBe(url)
})

Then('the tile list contains a tile named {string}', (state: unknown, name: string) => {
  expect(links(state).map((link) => link.title)).toContain(name)
})

Then('the tile list does not contain a tile named {string}', (state: unknown, name: string) => {
  expect(links(state).map((link) => link.title)).not.toContain(name)
})

Then('the top level order is {string}', (state: unknown, expected: string) => {
  const actual = childrenOf(links(state), null).map((link) => link.title)
  expect(actual.join(', ')).toBe(expected)
})

Then('the folder {string} contains {int} tile', (state: unknown, folder: string, count: number) => {
  expect(countChildren(links(state), byName(state, folder).id)).toBe(count)
})

Then('the attempt fails with {string}', (state: unknown, errorName: string) => {
  const error = scope(state).lastError
  expect(error, 'expected the attempt to fail, but it succeeded').not.toBeNull()
  expect(error?.name).toBe(errorName)
})

Then('the store reports that it recovered from an invalid file', (state: unknown) => {
  expect(quickLinkStore(state).recoveredFromInvalidFile).toBe(true)
})
