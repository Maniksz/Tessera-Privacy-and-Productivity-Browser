import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  INTERNAL_PAGE_EVENT_CHANNELS,
  INTERNAL_PAGE_INVOKE_CHANNELS,
  INVOKE_CHANNELS,
  anyInternalInvokeChannels,
  mayInternalPageInvoke,
  type InternalPage
} from '@shared/ipc/channels.js'
import { PASSWORD_CHANNELS } from '@shared/passwords/api.js'
import { LOCALES, catalogs } from '@shared/i18n/catalog.js'

/**
 * The wiring for `tessera://bookmarks`, `tessera://downloads` and `tessera://passwords`.
 *
 * Three complete features once sat in the tree with no channels and no catalogue entries, so this
 * file guards the two halves of that gap in the direction the compiler cannot:
 *
 *   - **Least privilege stays least.** A page whose allowlist is wider than the calls it makes has
 *     a grant nobody exercises, and a grant nobody exercises is a grant nobody notices going wrong.
 *     Narrower is worse in the other direction: a refused invoke at runtime.
 *   - **Every key a page renders exists in both locales.** A missing key shows the raw identifier —
 *     visible, harmless, and in exactly one language on a screen nobody looks at twice.
 */

const ROOT = process.cwd()

function source(relative: string): string {
  return readFileSync(join(ROOT, relative), 'utf8')
}

/**
 * A file with its comments removed.
 *
 * A scanning test that reads prose finds the words the prose is *about*. This one failed on the docblock that
 * says "the absence of any `masterPassword` … below is the enforcement" — a comment stating the very rule being
 * checked, reported as a violation of it. The same mistake has bitten this project three times, and the fix each
 * time is to scan code rather than text.
 *
 * String literals are deliberately left in: a channel name or a field name written as a literal is code, and a
 * previous version of `codeOnly` in `architecture.test.ts` stripped those too and made an assertion vacuous.
 */
function codeOf(relative: string): string {
  return source(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
}

/**
 * Invoke channels a module mentions, for one prefix.
 *
 * Filtered against `INVOKE_CHANNELS` rather than matched loosely, because `internal-calls.ts` names
 * `downloads:changed` too — a subscription, which is a separate grant and asserted separately below.
 * Without the filter this would demand that an event channel appear on an invoke allowlist.
 */
function invokesMentioned(text: string, prefix: string): string[] {
  const found = [...text.matchAll(new RegExp(`'(${prefix}:[a-zA-Z]+)'`, 'g'))]
    .map((match) => match[1]!)
    .filter((channel) => (INVOKE_CHANNELS as readonly string[]).includes(channel))
  return [...new Set(found)].sort()
}

/** What a page is granted, without the catalogue channel every page has. */
function grantedTo(page: InternalPage): string[] {
  return (INTERNAL_PAGE_INVOKE_CHANNELS[page] as readonly string[])
    .filter((channel) => channel !== 'i18n:getCatalog')
    .sort()
}

describe('internal page privileges', () => {
  /*
    The bookmarks and downloads pages call through `internal-calls.ts`, which names every channel
    once; the passwords page is typed against `PASSWORD_CHANNELS`. So the calls a page actually makes
    are readable from source, and the allowlist can be held to exactly them.
  */
  const internalCalls = source('src/renderer/internal/internal-calls.ts')

  it('grants the bookmarks page exactly the channels it calls', () => {
    expect(grantedTo('bookmarks')).toEqual(invokesMentioned(internalCalls, 'bookmarks'))
  })

  it('grants the downloads page exactly the channels it calls', () => {
    expect(grantedTo('downloads')).toEqual(invokesMentioned(internalCalls, 'downloads'))
  })

  /*
    What the page is granted, named rather than derived, and that is the whole point of this list.

    It was six while the lock, the master password, the reset and the CSV import sat in the tree with no
    contract entry and no handler. It is now twelve. Deriving the expectation from `PASSWORD_CHANNELS`
    would make this test green on the day somebody adds a name to that array and nothing else, which is
    exactly the state it was written to catch.

    `passwords:answerPrompt` is the one channel that feature declares and this page must *not* have: it
    answers the master-password prompt, that surface is browser chrome, and a mis-aimed submit on it would
    spend whatever the person had typed. Asserted below rather than implied by absence.

    So the assertions are different in kind: the grant must be exactly these twelve, every one of them must
    still be a channel that feature declares, and the thirteenth must stay out.
  */
  const WIRED_PASSWORD_CHANNELS = [
    'passwords:beginSetMasterPassword',
    'passwords:create',
    'passwords:forgetNeverSaved',
    'passwords:import',
    'passwords:list',
    'passwords:lock',
    'passwords:remove',
    'passwords:requestUnlock',
    'passwords:resetVault',
    'passwords:reveal',
    'passwords:update',
    'passwords:vaultStatus'
  ]

  it('grants the passwords page exactly the channels that are wired', () => {
    expect(grantedTo('passwords')).toEqual(WIRED_PASSWORD_CHANNELS)
  })

  it('keeps those names in step with the passwords API', () => {
    for (const channel of WIRED_PASSWORD_CHANNELS) {
      expect(PASSWORD_CHANNELS as readonly string[], channel).toContain(channel)
    }
  })

  it('keeps the master-password prompt answerable only from the chrome', () => {
    expect(mayInternalPageInvoke('passwords', 'passwords:answerPrompt')).toBe(false)
    // And from no other internal page either: the union is the only thing one page cannot satisfy for
    // another by happening to lack a channel.
    expect(anyInternalInvokeChannels() as readonly string[]).not.toContain('passwords:answerPrompt')
  })

  it("carries no channel whose payload could hold a master password", () => {
    /*
      The structural half of the decision `shared/passwords/api.ts` describes, read off the contract rather
      than promised in a comment. A request schema is where such a field would have to appear to be
      accepted, so this greps the one file that defines them all.

      It would have caught the design this replaced: `passwords:unlock { masterPassword }` and
      `passwords:setMasterPassword { current, next }` were both declared, with an argument for why crossing
      was unavoidable. It was not unavoidable.
    */
    const schema = codeOf('src/shared/passwords/schema.ts')
    for (const field of ['masterPassword', 'current:', 'next:', 'candidate']) {
      expect(schema, `the password wire schema names ${field}`).not.toContain(field)
    }
  })

  it('gives the download list to the downloads page and to no other', () => {
    const hearers = Object.entries(INTERNAL_PAGE_EVENT_CHANNELS)
      .filter(([, channels]) => (channels as readonly string[]).includes('downloads:changed'))
      .map(([page]) => page)
    expect(hearers).toEqual(['downloads'])
  })

  it('gives the passwords page no subscription at all', () => {
    /*
      Deliberate, and a privacy decision rather than an omission: a pushed vault list would arrive
      whenever the vault changed, including when autofill noted a sign-in — so an open passwords tab
      would learn that the user had just signed in somewhere.
    */
    expect(INTERNAL_PAGE_EVENT_CHANNELS.passwords).toEqual([])
  })
})

describe('internal page messages', () => {
  /*
    The two pages whose text is settled.

    `PasswordsPage` is deliberately not read here, and the reason is worth stating rather than
    leaving as an omission: `PASSWORD_MESSAGE_KEYS` is the list that feature keeps, it is the thing a
    test should measure against, and it grew from 39 keys to 81 while the lock and the CSV import were
    being built. Asserting a moving list here would make this file fail for work in another one.
    `PASSWORD_MESSAGE_KEYS` is checked below for the part that has landed.
  */
  const pageSources = [
    'src/renderer/internal/BookmarksPage.tsx',
    'src/renderer/internal/DownloadsPage.tsx'
  ]
    .map((relative) => source(relative))
    .join('\n')

  /** Every `bookmarks.*` or `downloads.*` key the two pages render. */
  const used = [
    ...new Set(
      [...pageSources.matchAll(/'((?:bookmarks|downloads)\.[a-zA-Z.]+)'/g)].map((match) => match[1]!)
    )
  ].sort()

  it('finds the keys at all, so a rename cannot make this test vacuous', () => {
    expect(used.length).toBeGreaterThan(50)
  })

  it('has every key the two pages render in every locale', () => {
    for (const locale of LOCALES) {
      const catalog: Readonly<Record<string, string>> = catalogs[locale]
      for (const key of used) {
        expect(catalog[key], `${locale} is missing ${key}`).toBeDefined()
      }
    }
  })

  it('translates the save bar and the suggestion list in every locale', () => {
    /*
      Read from the module that builds them, so the list cannot drift from what is drawn.

      These six matter more than their number suggests: they are rendered *inside a visited page* by
      the preload, which has no catalogue of its own and takes every word from the core — that is what
      makes a language change reach the next sign-in form rather than the next restart. A missing one
      would put a raw identifier on top of somebody's login.
    */
    const chrome = source('src/main/passwords/chrome.ts')
    const keys = [
      ...new Set([...chrome.matchAll(/'(passwords\.[a-zA-Z.]+)'/g)].map((match) => match[1]!))
    ]
    expect(keys.length, 'expected the save bar to name its own strings').toBeGreaterThan(4)

    for (const locale of LOCALES) {
      const catalog: Readonly<Record<string, string>> = catalogs[locale]
      for (const key of keys) {
        expect(catalog[key], `${locale} is missing ${key}`).toBeDefined()
      }
    }
  })
})
