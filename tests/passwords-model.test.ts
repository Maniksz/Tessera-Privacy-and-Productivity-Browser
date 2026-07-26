import { describe, expect, it } from 'vitest'
import {
  MAX_NEVER_SAVED_ORIGINS,
  MAX_PASSWORD_CREDENTIALS,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  discardingPasswordWriter,
  emptyPasswordDocument,
  forgetNeverSavedOrigin,
  listSummaries,
  neverSaveOrigin,
  noteCredentialUsed,
  normalizeUsername,
  passwordOriginOf,
  removeCredential,
  repairNeverSaved,
  repairPasswords,
  resolveSubmittedUsername,
  saveCredential,
  searchSummaries,
  updateCredential,
  usernameKey,
  withoutSecret,
  type PasswordCredential
} from '@shared/passwords/model.js'

/**
 * The vault's own rules: what an entry is keyed on, what a repeat sign-in does to it, and what a
 * damaged file becomes.
 *
 * The single most damaging thing a password manager can get wrong is offering two credentials for
 * one account, one of which no longer works — so most of this file is about identity: the (origin,
 * username) pair, how a username is compared, and what happens when a file already holds a
 * duplicate.
 */

const T0 = 1_700_000_000_000

function credential(overrides: Partial<PasswordCredential> & { id: string }): PasswordCredential {
  return {
    origin: 'https://example.com',
    username: 'alice',
    password: 'secret',
    createdAt: T0,
    updatedAt: T0,
    lastUsedAt: null,
    ...overrides
  }
}

function ids(credentials: readonly PasswordCredential[]): string[] {
  return credentials.map((entry) => entry.id)
}

const context = { now: T0 + 1000, newId: () => 'new' }

describe('what an entry is filed under', () => {
  it('keeps the origin and throws the path and query away', () => {
    // A path is not an authentication boundary, and `?session=…` in a login URL would park a token
    // in the vault for ever.
    expect(passwordOriginOf('https://example.com/login?session=8f1c')).toBe('https://example.com')
  })

  it('canonicalises the default port away, so one site cannot become two entries', () => {
    expect(passwordOriginOf('https://example.com:443/x')).toBe('https://example.com')
    expect(passwordOriginOf('http://example.com:80/x')).toBe('http://example.com')
  })

  it('keeps a non-default port, because it is a different application', () => {
    expect(passwordOriginOf('https://example.com:8443/x')).toBe('https://example.com:8443')
  })

  it('lower-cases the host', () => {
    expect(passwordOriginOf('https://EXAMPLE.com/x')).toBe('https://example.com')
  })

  it('refuses schemes that cannot authenticate anybody', () => {
    expect(passwordOriginOf('file:///tmp/login.html')).toBeNull()
    expect(passwordOriginOf('data:text/html,x')).toBeNull()
    expect(passwordOriginOf('tessera://passwords')).toBeNull()
    expect(passwordOriginOf('about:blank')).toBeNull()
  })

  it('refuses an address it cannot parse', () => {
    expect(passwordOriginOf('not a url')).toBeNull()
    expect(passwordOriginOf('')).toBeNull()
  })

  it('accepts the single-slash form the URL parser normalises for a special scheme', () => {
    // Recorded because it looks like a hostless address and is not: `https:/example.com` parses to
    // `https://example.com`. A hand-written check for `//` would have refused a valid address.
    expect(passwordOriginOf('https:/example.com')).toBe('https://example.com')
  })

  it('refuses an absurdly long origin rather than storing it', () => {
    expect(passwordOriginOf(`https://${'a'.repeat(300)}.example/x`)).toBeNull()
  })
})

describe('how a username is compared and how it is kept', () => {
  it('compares case-insensitively, so one account cannot become two entries', () => {
    expect(usernameKey('  Alice@Example.com ')).toBe('alice@example.com')
  })

  it("keeps the user's own capitalisation for what is shown and submitted", () => {
    expect(normalizeUsername('  Alice@Example.com ')).toBe('Alice@Example.com')
  })
})

describe('saving a credential', () => {
  it('creates a new entry', () => {
    const result = saveCredential([], { url: 'https://example.com/login', username: 'alice', password: 'p1' }, context)
    expect(result.outcome).toBe('created')
    expect(result.credentials).toEqual([
      {
        id: 'new',
        origin: 'https://example.com',
        username: 'alice',
        password: 'p1',
        createdAt: T0 + 1000,
        updatedAt: T0 + 1000,
        lastUsedAt: null
      }
    ])
  })

  it('replaces the password of an existing account rather than adding a second entry', () => {
    /*
      The rule the whole feature stands on. A user signing in with a new password means "this is the
      password now"; inserting a second row would leave autofill offering two entries with the same
      name, one of which fails — the most confusing outcome available.
    */
    const existing = [credential({ id: 'a', password: 'old' })]
    const result = saveCredential(
      existing,
      { url: 'https://example.com/account', username: 'alice', password: 'new' },
      context
    )
    expect(result.outcome).toBe('updated')
    expect(result.credentials).toHaveLength(1)
    expect(result.credentials[0]?.password).toBe('new')
    expect(result.credentials[0]?.createdAt, 'creation time survives an update').toBe(T0)
    expect(result.credentials[0]?.updatedAt).toBe(T0 + 1000)
  })

  it('matches an existing account whatever case the name was typed in', () => {
    const result = saveCredential(
      [credential({ id: 'a', username: 'Alice' })],
      { url: 'https://example.com/', username: 'alice', password: 'new' },
      context
    )
    expect(result.outcome).toBe('updated')
    expect(result.credentials).toHaveLength(1)
  })

  it('reports an unchanged pair without rewriting the document', () => {
    // What keeps the save bar from appearing on every single sign-in.
    const existing = [credential({ id: 'a', password: 'same' })]
    const result = saveCredential(
      existing,
      { url: 'https://example.com/', username: 'alice', password: 'same' },
      context
    )
    expect(result.outcome).toBe('unchanged')
    expect(result.credentials[0]?.updatedAt).toBe(T0)
  })

  it('keeps two different accounts on one site apart', () => {
    const first = saveCredential([], { url: 'https://example.com/', username: 'alice', password: 'p' }, context)
    const second = saveCredential(first.credentials, { url: 'https://example.com/', username: 'bob', password: 'q' }, {
      ...context,
      newId: () => 'second'
    })
    expect(second.outcome).toBe('created')
    expect(second.credentials).toHaveLength(2)
  })

  it('stores a credential with no username, because some sites authenticate on a password alone', () => {
    const result = saveCredential([], { url: 'https://example.com/', username: '', password: 'p' }, context)
    expect(result.outcome).toBe('created')
    expect(result.credentials[0]?.username).toBe('')
  })

  it('refuses an empty password, which would be a row that looks stored and fills nothing', () => {
    const result = saveCredential([], { url: 'https://example.com/', username: 'a', password: '' }, context)
    expect(result).toEqual({ credentials: [], outcome: 'rejected' })
  })

  it('refuses an unusable address', () => {
    expect(saveCredential([], { url: 'file:///x', username: 'a', password: 'p' }, context).outcome).toBe(
      'rejected'
    )
  })

  it('refuses rather than truncating an over-long password', () => {
    // A cut password is a password that does not sign in, and it would look like the manager
    // remembering the wrong thing.
    const result = saveCredential(
      [],
      { url: 'https://example.com/', username: 'a', password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) },
      context
    )
    expect(result.outcome).toBe('rejected')
  })

  it('refuses rather than truncating an over-long username', () => {
    const result = saveCredential(
      [],
      { url: 'https://example.com/', username: 'x'.repeat(MAX_USERNAME_LENGTH + 1), password: 'p' },
      context
    )
    expect(result.outcome).toBe('rejected')
  })

  it('drops the least useful entry when the cap is reached', () => {
    const many = Array.from({ length: MAX_PASSWORD_CREDENTIALS }, (_value, index) =>
      credential({ id: `c${String(index)}`, username: `user${String(index)}`, updatedAt: T0 + index })
    )
    const result = saveCredential(many, { url: 'https://other.example/', username: 'z', password: 'p' }, context)
    expect(result.credentials).toHaveLength(MAX_PASSWORD_CREDENTIALS)
    expect(ids(result.credentials)).toContain('new')
  })
})

describe('editing an entry', () => {
  it('changes the password and the name but never the origin', () => {
    // Re-pointing a stored password at another site is not a correction; it is a new credential, and
    // a mistyped edit must not be able to do it silently.
    const [updated] = updateCredential(
      [credential({ id: 'a' })],
      'a',
      { username: 'bob', password: 'q' },
      { now: T0 + 5 }
    )
    expect(updated).toEqual({
      id: 'a',
      origin: 'https://example.com',
      username: 'bob',
      password: 'q',
      createdAt: T0,
      updatedAt: T0 + 5,
      lastUsedAt: null
    })
  })

  it('refuses to blank a password', () => {
    const result = updateCredential([credential({ id: 'a' })], 'a', { password: '' }, { now: T0 + 5 })
    expect(result[0]?.password).toBe('secret')
    expect(result[0]?.updatedAt, 'nothing was touched at all').toBe(T0)
  })

  it('refuses an over-long password or username', () => {
    const long = updateCredential([credential({ id: 'a' })], 'a', { password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }, { now: T0 + 5 })
    expect(long[0]?.password).toBe('secret')
    const name = updateCredential([credential({ id: 'a' })], 'a', { username: 'x'.repeat(MAX_USERNAME_LENGTH + 1) }, { now: T0 + 5 })
    expect(name[0]?.username).toBe('alice')
  })

  it('leaves an unknown id alone', () => {
    expect(updateCredential([credential({ id: 'a' })], 'nope', { password: 'q' }, { now: T0 })[0]?.password).toBe(
      'secret'
    )
  })

  it('removes by id', () => {
    expect(removeCredential([credential({ id: 'a' }), credential({ id: 'b', username: 'bob' })], 'a')).toHaveLength(1)
  })
})

describe('recording that a credential was used', () => {
  it('moves the timestamp and puts the entry first', () => {
    const before = [credential({ id: 'a' }), credential({ id: 'b', username: 'bob' })]
    const after = noteCredentialUsed(before, 'b', { now: T0 + 10 })
    expect(ids(after)).toEqual(['b', 'a'])
  })

  it('does nothing for an unknown id', () => {
    const before = [credential({ id: 'a' })]
    expect(noteCredentialUsed(before, 'nope', { now: T0 + 10 })).toEqual(before)
  })
})

describe('a private window holds a writer that keeps nothing', () => {
  it('reports a refusal rather than pretending to have saved', () => {
    // It holds no store at all, which is the point: a forgotten `privateMode` check cannot leak a
    // credential because there is nothing here to leak it into.
    expect(discardingPasswordWriter.save({ url: 'https://example.com/', username: 'a', password: 'p' })).toBe(
      'rejected'
    )
    expect(() => {
      discardingPasswordWriter.neverSaveFor('https://example.com/')
      discardingPasswordWriter.noteUsed('a')
    }).not.toThrow()
  })
})

describe('"never here"', () => {
  it('remembers an origin once', () => {
    const once = neverSaveOrigin([], 'https://example.com/login')
    expect(once).toEqual(['https://example.com'])
    expect(neverSaveOrigin(once, 'https://example.com/other')).toEqual(once)
  })

  it('ignores an address it could not file a credential under either', () => {
    expect(neverSaveOrigin([], 'file:///x')).toEqual([])
  })

  it('forgets an origin, so a change of mind is possible', () => {
    expect(forgetNeverSavedOrigin(['https://example.com'], 'https://example.com')).toEqual([])
    expect(forgetNeverSavedOrigin(['https://example.com'], 'nonsense')).toEqual(['https://example.com'])
  })

  it('caps the list', () => {
    const many = Array.from({ length: MAX_NEVER_SAVED_ORIGINS }, (_value, index) => `https://s${String(index)}.example`)
    expect(neverSaveOrigin(many, 'https://new.example')).toHaveLength(MAX_NEVER_SAVED_ORIGINS)
  })
})

describe('reading the vault', () => {
  it('never hands out a password in a summary', () => {
    const summary = withoutSecret(credential({ id: 'a' }))
    expect(Object.keys(summary)).not.toContain('password')
    expect(JSON.stringify(summary)).not.toContain('secret')
  })

  it('orders by most recently used, then most recently changed', () => {
    const summaries = listSummaries([
      credential({ id: 'stale', username: 'c', updatedAt: T0 }),
      credential({ id: 'used', username: 'a', lastUsedAt: T0 + 50 }),
      credential({ id: 'fresh', username: 'b', updatedAt: T0 + 10 })
    ])
    expect(summaries.map((entry) => entry.id)).toEqual(['used', 'fresh', 'stale'])
  })

  it('searches origins and usernames, and cannot be pointed at a password', () => {
    const summaries = listSummaries([
      credential({ id: 'a', origin: 'https://bank.example', username: 'alice' }),
      credential({ id: 'b', origin: 'https://shop.example', username: 'bob' })
    ])
    expect(searchSummaries(summaries, 'bank').map((entry) => entry.id)).toEqual(['a'])
    expect(searchSummaries(summaries, 'BOB').map((entry) => entry.id)).toEqual(['b'])
    expect(searchSummaries(summaries, '  ')).toHaveLength(2)
    // The word is a password in the fixture and appears in no summary, so a search for it finds
    // nothing — the type makes this true and the test says so out loud.
    expect(searchSummaries(summaries, 'secret')).toEqual([])
  })
})

describe('a submission with no username field', () => {
  it('is read as the site’s only stored account', () => {
    /*
      A change-password form usually has no name field. Saved as-is, the empty name creates a second
      nameless entry beside the real one and the user is then offered two credentials for the site.
    */
    const summaries = listSummaries([credential({ id: 'a', username: 'alice' })])
    expect(resolveSubmittedUsername(summaries, 'https://example.com', '')).toBe('alice')
  })

  it('stays empty when the site has two accounts, because guessing would overwrite one', () => {
    const summaries = listSummaries([
      credential({ id: 'a', username: 'alice' }),
      credential({ id: 'b', username: 'bob' })
    ])
    expect(resolveSubmittedUsername(summaries, 'https://example.com', '')).toBe('')
  })

  it('stays empty when the site has none', () => {
    expect(resolveSubmittedUsername([], 'https://example.com', '')).toBe('')
  })

  it('leaves a submitted name alone, trimmed', () => {
    const summaries = listSummaries([credential({ id: 'a', username: 'alice' })])
    expect(resolveSubmittedUsername(summaries, 'https://example.com', '  bob ')).toBe('bob')
  })

  it('does not borrow a name from another site', () => {
    const summaries = listSummaries([credential({ id: 'a', origin: 'https://other.example' })])
    expect(resolveSubmittedUsername(summaries, 'https://example.com', '')).toBe('')
  })
})

describe('a damaged or hand-edited file', () => {
  it('starts empty', () => {
    expect(emptyPasswordDocument()).toEqual({ version: 1, credentials: [], neverSaved: [] })
  })

  it('keeps the most recently updated of two entries for one account', () => {
    // There is no sensible merge of two different passwords for one account — one of them is simply
    // wrong — and "the newer one" is the only answer that matches what the user last did.
    const repaired = repairPasswords([
      credential({ id: 'old', password: 'old', updatedAt: T0 }),
      credential({ id: 'new', password: 'new', updatedAt: T0 + 10 })
    ])
    expect(repaired).toHaveLength(1)
    expect(repaired[0]?.password).toBe('new')
  })

  it('drops a repeated id, which would make "reveal this one" ambiguous', () => {
    const repaired = repairPasswords([
      credential({ id: 'dup', username: 'alice' }),
      credential({ id: 'dup', username: 'bob' })
    ])
    expect(repaired).toHaveLength(1)
  })

  it('drops an entry with an empty password, which cannot be filled', () => {
    expect(repairPasswords([credential({ id: 'a', password: '' })])).toEqual([])
  })

  it('keeps an entry whose origin this build would refuse to fill', () => {
    /*
      Deliberate, and the opposite of a cleanup. Narrowing the accepted schemes later would otherwise
      delete every affected credential on the next start — data loss wearing the costume of
      housekeeping. The entry stays visible on the passwords page; `fill-policy.ts` refuses it.
    */
    const repaired = repairPasswords([credential({ id: 'a', origin: 'http://intranet.example' })])
    expect(repaired).toHaveLength(1)
  })

  it('trims the collection to the cap rather than rejecting the file', () => {
    const many = Array.from({ length: MAX_PASSWORD_CREDENTIALS + 5 }, (_value, index) =>
      credential({ id: `c${String(index)}`, username: `user${String(index)}` })
    )
    expect(repairPasswords(many)).toHaveLength(MAX_PASSWORD_CREDENTIALS)
  })

  it('normalises and de-duplicates the "never here" list', () => {
    expect(repairNeverSaved(['https://example.com:443', 'https://example.com', 'nonsense'])).toEqual([
      'https://example.com'
    ])
  })
})
