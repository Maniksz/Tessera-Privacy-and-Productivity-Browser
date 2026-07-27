import { describe, expect, it } from 'vitest'
import {
  MAX_MASTER_PASSWORD_LENGTH,
  MIN_MASTER_PASSWORD_LENGTH,
  RESET_VAULT_CONFIRMATION,
  VAULT_IDLE_SWEEP_MS,
  VAULT_IDLE_TIMEOUT_MS,
  assessMasterPassword,
  isVaultIdle,
  vaultHasMasterPassword,
  vaultKeyIsExposed,
  vaultKeyProtection,
  type VaultKeyProtection
} from '@shared/passwords/vault.js'
import {
  MASTER_PASSWORD_INTENTS,
  MASTER_PASSWORD_PROBLEMS,
  MASTER_PASSWORD_PURPOSES,
  MASTER_PASSWORD_REQUEST_OUTCOMES,
  MASTER_PASSWORD_SEQUENCE,
  MASTER_PASSWORD_STEPS,
  PROMPT_ACTIONS,
  UNLOCK_REQUEST_OUTCOMES,
  boundedAppend,
  promptKeyAction,
  stepsFor,
  type MasterPasswordPurpose,
  type MasterPasswordStep,
  type PromptKey
} from '@shared/passwords/prompt.js'

/**
 * The lock's rules and the prompt's rules, which are the two places a mistake costs a secret or a
 * vault.
 *
 * Neither module touches a key, a file or a window, and that is why they are worth this much
 * attention: everything downstream of them believes them. Four ways this file is the thing that
 * notices:
 *
 *   - **The lock stops bounding anything.** `isVaultIdle` erring the other way on a clock that moved
 *     forwards — an NTP correction, a resumed laptop — leaves the vault open for as long as the
 *     correction was large, which is the one direction where being wrong hands over a password
 *     instead of asking for one again. `VAULT_IDLE_TIMEOUT_MS` quietly raised, or
 *     `VAULT_IDLE_SWEEP_MS` raised past it, turns the promise "the key is dropped after fifteen
 *     minutes" into a suggestion nothing enforces.
 *   - **Somebody is locked out of a password they chose.** `assessMasterPassword` is off by one at
 *     either bound, or is "fixed" to count grapheme clusters, and a passphrase that the derivation
 *     would take is refused — or one it will not take is accepted and then fails at the point where
 *     the vault is already sealed with it.
 *   - **The prompt stores a different password from the one that was typed.** `promptKeyAction`
 *     counting a `keyUp` as well as a `keyDown` doubles every character, and counting a key
 *     mid-composition accumulates text the user never chose. Neither is visible: the field draws
 *     bullets, so the only symptom is a master password that is wrong for ever with no way to see
 *     why.
 *   - **The page says the wrong sentence about the vault.** `vaultKeyProtection` and
 *     `vaultKeyIsExposed` are how `tessera://passwords` decides whether to tell the user their key
 *     sits readable in the profile directory beside the document it protects. A wrong answer there
 *     is a reassurance that is not true.
 */

const T0 = 1_700_000_000_000

/**
 * The four sentences the passwords page has to be able to say, with the two facts each of them
 * implies.
 *
 * A `Record` keyed by the union rather than a list, so a fifth `VaultKeyProtection` cannot be added
 * without this table failing to compile — which is the point of the union being four named values
 * instead of a pair of booleans.
 */
const PROTECTION_FACTS: Readonly<
  Record<VaultKeyProtection, { readonly masterPassword: boolean; readonly exposed: boolean }>
> = {
  'keystore+master': { masterPassword: true, exposed: false },
  master: { masterPassword: true, exposed: false },
  keystore: { masterPassword: false, exposed: false },
  plain: { masterPassword: false, exposed: true }
}

describe('how the vault key is protected on this machine', () => {
  it('reports both layers when both are present', () => {
    expect(vaultKeyProtection({ keystore: true, masterPassword: true })).toBe('keystore+master')
  })

  it('reports master-password-only, which is the keyring-less desktop and real protection', () => {
    // The case where a master password matters most: it is the only thing between a copied profile
    // directory and the vault, so it must not be collapsed into "not properly protected".
    expect(vaultKeyProtection({ keystore: false, masterPassword: true })).toBe('master')
  })

  it('reports keystore-only, which is today’s default and no re-authentication at all', () => {
    expect(vaultKeyProtection({ keystore: true, masterPassword: false })).toBe('keystore')
  })

  it('reports plain when neither layer is there', () => {
    // Still offered rather than refused — a browser that will not run on a keyring-less desktop is
    // not private, only unavailable — which is exactly why this value has to be nameable.
    expect(vaultKeyProtection({ keystore: false, masterPassword: false })).toBe('plain')
  })

  it('answers whether a master password guards the key for every protection there is', () => {
    for (const [name, facts] of Object.entries(PROTECTION_FACTS)) {
      const protection = name as keyof typeof PROTECTION_FACTS
      expect(vaultHasMasterPassword(protection), name).toBe(facts.masterPassword)
    }
  })

  it('answers whether the key itself is readable for every protection there is', () => {
    /*
      `vaultKeyIsExposed` rather than `protection === 'plain'` at the call site, and driven from the
      table for the same reason: this is the predicate the page uses to decide whether to shout, and
      a fifth protection that also left the key readable must not reach the page as a quiet one.
    */
    for (const [name, facts] of Object.entries(PROTECTION_FACTS)) {
      const protection = name as keyof typeof PROTECTION_FACTS
      expect(vaultKeyIsExposed(protection), name).toBe(facts.exposed)
    }
  })
})

describe('what a master password has to be', () => {
  it('refuses anything under the floor', () => {
    expect(assessMasterPassword('x'.repeat(MIN_MASTER_PASSWORD_LENGTH - 1))).toBe('too-short')
  })

  it('accepts one exactly at the floor', () => {
    // The boundary is the whole point: one off here refuses a password somebody has already chosen
    // and gives them no way to find out that the rule they read was not the rule that ran.
    expect(assessMasterPassword('x'.repeat(MIN_MASTER_PASSWORD_LENGTH))).toBeNull()
  })

  it('accepts one exactly at the ceiling', () => {
    expect(assessMasterPassword('x'.repeat(MAX_MASTER_PASSWORD_LENGTH))).toBeNull()
  })

  it('refuses one a single character past the ceiling', () => {
    // The other direction of the same off-by-one: accepting this would seal the vault with something
    // the derivation is documented not to take.
    expect(assessMasterPassword('x'.repeat(MAX_MASTER_PASSWORD_LENGTH + 1))).toBe('too-long')
  })

  it('refuses the empty string as too short rather than as a special case', () => {
    // A blank field is the commonest submission of all, and it has to come back with the rule that
    // was broken — a refusal with no reason is a form the user retries at random.
    expect(assessMasterPassword('')).toBe('too-short')
  })

  it('counts code units, so a string of emoji is longer than it looks', () => {
    /*
      Deliberate, and load-bearing rather than an oversight to be "fixed" with `Array.from`: the
      derivation consumes bytes, so code units are the number that bounds its work. Six emoji are
      twelve code units and are accepted; six letters are six and are not. A rule about characters
      would disagree with the derivation for exactly these inputs.
    */
    expect(assessMasterPassword('😀'.repeat(6))).toBeNull()
    expect(assessMasterPassword('abcdef')).toBe('too-short')
  })

  it('counts code units at the ceiling too', () => {
    // 513 emoji are 1026 code units: refused, though a count of characters would call it 513.
    expect(assessMasterPassword('😀'.repeat(513))).toBe('too-long')
  })
})

describe('when an open vault is closed again', () => {
  it('is idle when nothing has ever counted as activity', () => {
    // There is nothing holding the vault open, so the answer cannot be "not idle" — that would keep
    // a key alive on the strength of a value that was never set.
    expect(isVaultIdle(null, T0)).toBe(true)
  })

  it('is idle when the last activity is in the future', () => {
    /*
      A clock that moved: an NTP correction, a resumed laptop, a manually set date. Read as activity
      it would make the window unbounded — the one direction where being wrong costs a secret rather
      than a re-entry.
    */
    expect(isVaultIdle(T0 + 60_000, T0)).toBe(true)
  })

  it('is idle exactly at the timeout', () => {
    expect(isVaultIdle(T0, T0 + VAULT_IDLE_TIMEOUT_MS)).toBe(true)
  })

  it('is not idle a millisecond short of the timeout', () => {
    expect(isVaultIdle(T0, T0 + VAULT_IDLE_TIMEOUT_MS - 1)).toBe(false)
  })

  it('is not idle at the moment of the activity itself', () => {
    expect(isVaultIdle(T0, T0)).toBe(false)
  })

  it('honours an explicit timeout as well as the default one', () => {
    // The core passes its own for tests and for a future explicit lock; the default is what ships,
    // so both paths are worth having covered.
    expect(isVaultIdle(T0, T0 + 5_000, 5_000)).toBe(true)
    expect(isVaultIdle(T0, T0 + 4_999, 5_000)).toBe(false)
  })
})

describe('the bounds the lock is specified to have', () => {
  it('drops the key after fifteen minutes', () => {
    expect(VAULT_IDLE_TIMEOUT_MS).toBe(900_000)
  })

  it('checks every thirty seconds', () => {
    expect(VAULT_IDLE_SWEEP_MS).toBe(30_000)
  })

  it('sweeps more often than the timeout it enforces', () => {
    // A sweep slower than the timeout would make the timeout a suggestion: the key would still be in
    // memory after the moment it was promised to be gone, which is precisely what a memory dump gets.
    expect(VAULT_IDLE_SWEEP_MS).toBeLessThan(VAULT_IDLE_TIMEOUT_MS)
  })

  it('puts the floor on a master password at twelve characters', () => {
    // Specification, not a preference. A well-meant edit to make the lock less annoying fails here
    // instead of shipping silently.
    expect(MIN_MASTER_PASSWORD_LENGTH).toBe(12)
  })

  it('puts the ceiling at the same place a stored password gets', () => {
    expect(MAX_MASTER_PASSWORD_LENGTH).toBe(1024)
    expect(MIN_MASTER_PASSWORD_LENGTH).toBeLessThan(MAX_MASTER_PASSWORD_LENGTH)
  })

  it('requires a word in the payload before the vault can be destroyed', () => {
    // So `passwords:resetVault` cannot be reached by an empty invoke. Not user-visible and therefore
    // not translated; the sentence the user reads is a separate, translated thing on the page.
    expect(RESET_VAULT_CONFIRMATION).toBe('delete-vault')
  })
})

/** A keystroke with everything off, so each test names only the part it is about. */
function press(overrides: Partial<PromptKey> = {}): PromptKey {
  return {
    type: 'keyDown',
    key: 'a',
    control: false,
    meta: false,
    alt: false,
    shift: false,
    isComposing: false,
    ...overrides
  }
}

describe('one press is one keystroke', () => {
  it('reads a key going down', () => {
    expect(promptKeyAction(press({ key: 'q' }))).toEqual({ kind: 'append', text: 'q' })
  })

  it('ignores the key going up, which would otherwise double every character', () => {
    // Electron emits `keyDown`, `keyUp` and `char` for one press. A defect here would be invisible,
    // because the field draws bullets — the only symptom is a password that is wrong for ever.
    expect(promptKeyAction(press({ type: 'keyUp' }))).toEqual({ kind: 'ignore' })
  })

  it('ignores the char event of the same press, for the same reason', () => {
    expect(promptKeyAction(press({ type: 'char' }))).toEqual({ kind: 'ignore' })
  })

  it('ignores a keystroke mid-composition rather than half-handling an IME', () => {
    /*
      Accumulating pre-composition keystrokes would store a *different* password from the one the user
      believes they chose, and they would then be locked out of their own vault. Refusing to enter a
      master password through a composition editor is the smaller cost, and it is a stated one.
    */
    expect(promptKeyAction(press({ key: 'a', isComposing: true }))).toEqual({ kind: 'ignore' })
  })
})

describe('the keys the prompt acts on', () => {
  it('submits on Enter', () => {
    expect(promptKeyAction(press({ key: 'Enter' }))).toEqual({ kind: 'submit' })
  })

  it('cancels on Escape', () => {
    expect(promptKeyAction(press({ key: 'Escape' }))).toEqual({ kind: 'cancel' })
  })

  it('deletes one character on Backspace', () => {
    expect(promptKeyAction(press({ key: 'Backspace' }))).toEqual({ kind: 'backspace' })
  })

  it('clears the whole buffer on Ctrl+Backspace and on Cmd+Backspace', () => {
    // Both, because the same person uses both platforms and a prompt that cleared on one and deleted
    // one character on the other is a prompt whose bullet count nobody can trust.
    expect(promptKeyAction(press({ key: 'Backspace', control: true }))).toEqual({ kind: 'clear' })
    expect(promptKeyAction(press({ key: 'Backspace', meta: true }))).toEqual({ kind: 'clear' })
  })

  it('clears on Ctrl+U and on Cmd+U, the readline way of throwing the line away', () => {
    // What a person reaches for when they have lost track of how many bullets they meant to type.
    expect(promptKeyAction(press({ key: 'u', control: true }))).toEqual({ kind: 'clear' })
    expect(promptKeyAction(press({ key: 'u', meta: true }))).toEqual({ kind: 'clear' })
  })

  it('pastes on Ctrl+V and on Cmd+V', () => {
    // Paste had to be supported: the length floor pushes people towards passphrases they keep
    // elsewhere, and a field that cannot be pasted into is one people work around with something short.
    expect(promptKeyAction(press({ key: 'v', control: true }))).toEqual({ kind: 'paste' })
    expect(promptKeyAction(press({ key: 'v', meta: true }))).toEqual({ kind: 'paste' })
  })

  it('recognises the accelerator letter whatever case it arrives in', () => {
    // Electron reports `V` while Shift is held, and Caps Lock reports it with no modifier at all.
    expect(promptKeyAction(press({ key: 'V', control: true, shift: true }))).toEqual({
      kind: 'paste'
    })
    expect(promptKeyAction(press({ key: 'U', meta: true }))).toEqual({ kind: 'clear' })
  })
})

describe('a key nobody mapped does nothing', () => {
  it('ignores an accelerator that means something else', () => {
    // Select-all and save are window commands. The default being `ignore` rather than `append` is the
    // whole safety property here: an unmapped chord must not land a stray character in a password.
    expect(promptKeyAction(press({ key: 'a', control: true }))).toEqual({ kind: 'ignore' })
    expect(promptKeyAction(press({ key: 's', meta: true }))).toEqual({ kind: 'ignore' })
  })

  it('ignores an Alt-modified key, which belongs to a menu', () => {
    expect(promptKeyAction(press({ key: 'f', alt: true }))).toEqual({ kind: 'ignore' })
  })

  it('ignores an accelerator that also holds Alt', () => {
    // Ctrl+Alt+V is not paste on any platform, and reading it as one would paste on a chord the user
    // pressed for something else entirely.
    expect(promptKeyAction(press({ key: 'v', control: true, alt: true }))).toEqual({
      kind: 'ignore'
    })
    expect(promptKeyAction(press({ key: 'u', meta: true, alt: true }))).toEqual({ kind: 'ignore' })
  })

  it('ignores every named key', () => {
    // Each of these is more than one code point, which is what admits the printable keys and nothing
    // else. A `Tab` counted as a character is a character the user cannot see and cannot retype.
    for (const key of ['Tab', 'Shift', 'F5', 'ArrowLeft', 'CapsLock', 'Delete']) {
      expect(promptKeyAction(press({ key })), key).toEqual({ kind: 'ignore' })
    }
  })
})

describe('what counts as one character', () => {
  it('appends a plain letter', () => {
    expect(promptKeyAction(press({ key: 'h' }))).toEqual({ kind: 'append', text: 'h' })
  })

  it('appends a space, which a passphrase is mostly made of', () => {
    expect(promptKeyAction(press({ key: ' ' }))).toEqual({ kind: 'append', text: ' ' })
  })

  it('appends a character from outside the basic plane', () => {
    /*
      Counted in code points, not code units: an emoji's `key` is a surrogate pair, so `key.length
      === 1` would refuse it — and then drop it silently, leaving the user with a password they cannot
      reproduce and a bullet count that does not match what they typed.
    */
    expect(promptKeyAction(press({ key: '😀' }))).toEqual({ kind: 'append', text: '😀' })
    expect(promptKeyAction(press({ key: '𝔞' }))).toEqual({ kind: 'append', text: '𝔞' })
  })
})

describe('the buffer the characters go into', () => {
  it('appends to what is already there', () => {
    expect(boundedAppend(['a', 'b'], 'c')).toEqual(['a', 'b', 'c'])
  })

  it('appends a paste one character per entry', () => {
    // One array of single characters, joined once at the moment it is used, rather than a growing
    // string that would leave every prefix of the password on the heap.
    expect(boundedAppend([], 'hunter2')).toEqual(['h', 'u', 'n', 't', 'e', 'r', '2'])
  })

  it('stops at the ceiling without being told where it is', () => {
    // The default bound is the length past which `assessMasterPassword` refuses anyway; a held key or
    // a pasted file would otherwise grow this without limit.
    const nearlyFull = Array.from({ length: MAX_MASTER_PASSWORD_LENGTH - 1 }, () => 'x')
    const result = boundedAppend(nearlyFull, 'ab')
    expect(result).toHaveLength(MAX_MASTER_PASSWORD_LENGTH)
    expect(result.at(-1)).toBe('a')
  })

  it('stops at an explicit ceiling', () => {
    expect(boundedAppend(['a'], 'bcd', 3)).toEqual(['a', 'b', 'c'])
  })

  it('returns a new array rather than the input when there is no room left', () => {
    /*
      A copy, not the same array. The buffer's whole reason for being an array is that the caller owns
      exactly one of them and can overwrite it; handing back the input on the full path would make
      that ownership depend on which branch ran, and a caller that then cleared "its" array would be
      clearing somebody else's.
    */
    const full = ['a', 'b']
    const result = boundedAppend(full, 'c', 2)
    expect(result).toEqual(['a', 'b'])
    expect(result).not.toBe(full)
  })

  it('refuses to grow past a ceiling already exceeded', () => {
    expect(boundedAppend(['a', 'b', 'c'], 'd', 2)).toEqual(['a', 'b', 'c'])
  })

  it('truncates a paste in code points, so half an emoji is never stored', () => {
    // Counting code units would cut a surrogate pair in two and store a lone half — a character that
    // is not the one the user pasted, in a password they cannot then reproduce.
    expect(boundedAppend([], '😀😀😀', 2)).toEqual(['😀', '😀'])
  })
})

/** What each purpose has to ask, in order. Keyed by the union so a new purpose fails to compile. */
const EXPECTED_SEQUENCE: Readonly<Record<MasterPasswordPurpose, readonly MasterPasswordStep[]>> = {
  unlock: ['current'],
  set: ['new', 'repeat'],
  change: ['current', 'new', 'repeat'],
  remove: ['current']
}

describe('the questions a purpose asks', () => {
  it('asks each purpose for exactly the steps it is specified to ask for', () => {
    for (const purpose of MASTER_PASSWORD_PURPOSES) {
      expect(stepsFor(purpose), purpose).toEqual(EXPECTED_SEQUENCE[purpose])
    }
  })

  it('makes removing a master password prove knowledge of it', () => {
    /*
      The entry that matters. Without `current`, "remove the lock" would be the one operation needing
      no key — which is the same as not having a lock at all, since anyone at an unlocked laptop could
      take it off and then read the vault.
    */
    expect(stepsFor('remove')).toEqual(['current'])
  })

  it('asks for the current password for everything except setting a first one', () => {
    // `set` has nothing to prove; the core refuses a `set` on a vault that already has a master
    // password rather than trusting the caller's word about which case it is.
    for (const purpose of MASTER_PASSWORD_PURPOSES) {
      const asksCurrent = stepsFor(purpose).includes('current')
      expect(asksCurrent, purpose).toBe(purpose !== 'set')
    }
  })

  it('always asks for a new password twice', () => {
    // A single field would turn a typo into a vault nobody can open — including the person who just
    // chose the password, who has no way to find out what they actually typed.
    for (const purpose of MASTER_PASSWORD_PURPOSES) {
      const steps = stepsFor(purpose)
      if (!steps.includes('new')) continue
      expect(steps, purpose).toContain('repeat')
      expect(steps.indexOf('repeat'), purpose).toBeGreaterThan(steps.indexOf('new'))
    }
  })

  it('never asks the same question twice in one sequence', () => {
    for (const purpose of MASTER_PASSWORD_PURPOSES) {
      const steps = stepsFor(purpose)
      expect(new Set(steps).size, purpose).toBe(steps.length)
    }
  })

  it('asks only questions the prompt knows how to draw', () => {
    for (const purpose of MASTER_PASSWORD_PURPOSES) {
      for (const step of stepsFor(purpose)) {
        expect(MASTER_PASSWORD_STEPS as readonly string[], `${purpose} -> ${step}`).toContain(step)
      }
    }
  })

  it('reads the published table rather than keeping a second copy of the rules', () => {
    // The renderer imports the table and the core calls the function; two sources of the same
    // sequence would let a prompt ask one thing while a page announced another.
    for (const purpose of MASTER_PASSWORD_PURPOSES) {
      expect(stepsFor(purpose), purpose).toBe(MASTER_PASSWORD_SEQUENCE[purpose])
    }
  })
})

/** Every vocabulary that travels to a renderer as the answer to a password question. */
const OUTCOME_VOCABULARIES: Readonly<Record<string, readonly string[]>> = {
  MASTER_PASSWORD_PROBLEMS,
  UNLOCK_REQUEST_OUTCOMES,
  MASTER_PASSWORD_REQUEST_OUTCOMES,
  PROMPT_ACTIONS
}

describe('the vocabulary the renderer is allowed to learn', () => {
  it('names the four purposes a sequence can have', () => {
    expect(MASTER_PASSWORD_PURPOSES).toEqual(['unlock', 'set', 'change', 'remove'])
  })

  it('lets a caller ask for less than the core can do', () => {
    // The intents are narrower on purpose, and the narrowing is the security boundary: a page cannot
    // ask for an `unlock` on this channel, so it cannot use it to find out whether a vault is locked.
    const purposes: readonly string[] = MASTER_PASSWORD_PURPOSES
    for (const intent of MASTER_PASSWORD_INTENTS) expect(purposes, intent).toContain(intent)
    expect(MASTER_PASSWORD_INTENTS).toEqual(['set', 'change', 'remove'])
  })

  it('keeps unlock out of the intents, because it has its own channel and its own outcome', () => {
    const intents: readonly string[] = MASTER_PASSWORD_INTENTS
    expect(intents).not.toContain('unlock')
  })

  it('names the three questions and no more', () => {
    expect(MASTER_PASSWORD_STEPS).toEqual(['current', 'new', 'repeat'])
  })

  it('tells a mismatch apart from a broken rule', () => {
    // The next action differs: one is "type it again", the other is "choose a longer one". A single
    // "invalid" would leave the user guessing which.
    expect(MASTER_PASSWORD_PROBLEMS).toEqual([
      'wrong-password',
      'too-short',
      'too-long',
      'mismatch'
    ])
  })

  it('answers an unlock request with exactly four words', () => {
    /*
      And not one of them says whether the vault exists or holds anything: `wrong-password` covers
      both a failed derivation and a key file with no master password to check, so this channel cannot
      be used to discover a fact about the user that a page linking to `tessera://passwords` has no
      business learning.
    */
    expect(UNLOCK_REQUEST_OUTCOMES).toEqual([
      'unlocked',
      'wrong-password',
      'cancelled',
      'unreadable'
    ])
  })

  it('answers a set, change or remove request with exactly eight', () => {
    expect(MASTER_PASSWORD_REQUEST_OUTCOMES).toEqual([
      'set',
      'changed',
      'removed',
      'wrong-password',
      'cancelled',
      'rejected',
      'locked',
      'not-protected'
    ])
  })

  it('gives the surface two buttons and no third', () => {
    expect(PROMPT_ACTIONS).toEqual(['submit', 'cancel'])
  })

  it('has no word in any answer that could be carrying a candidate', () => {
    /*
      The reason every outcome is a value rather than a thrown error: an error's message travels, gets
      logged and gets shown, and the one thing that must never appear in any of those is what the user
      typed. Holding the whole vocabulary to short lower-case tokens is how a future entry that
      interpolates a candidate — or a name, or an origin — fails here rather than in a log file.
    */
    for (const [table, words] of Object.entries(OUTCOME_VOCABULARIES)) {
      for (const word of words) {
        expect(word, `${table} -> ${word}`).toMatch(/^[a-z]+(?:-[a-z]+)*$/)
        expect(word.length, `${table} -> ${word}`).toBeLessThanOrEqual(20)
      }
    }
  })

  it('gives no two answers in one vocabulary the same word', () => {
    // Two entries meaning the same thing would make one of them unreachable, and the unreachable one
    // is the branch nobody tests.
    for (const [table, words] of Object.entries(OUTCOME_VOCABULARIES)) {
      expect(new Set(words).size, table).toBe(words.length)
    }
  })
})
