import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MasterPasswordPrompt,
  type MasterPasswordHost,
  type MasterPasswordVault
} from '@main/passwords/MasterPasswordPrompt.js'
import type { OverlayVacancyReason } from '@main/permissions/vacancy.js'
import type { MasterPasswordPresentation, OverlayPresentation } from '@shared/overlay/surface.js'
import type { MasterPasswordStep, PromptKey } from '@shared/passwords/prompt.js'
import {
  MAX_MASTER_PASSWORD_LENGTH,
  MIN_MASTER_PASSWORD_LENGTH,
  VAULT_IDLE_TIMEOUT_MS,
  type MasterPasswordOutcome,
  type UnlockOutcome,
  type VaultStatus
} from '@shared/passwords/vault.js'

/**
 * The prompt that asks for the master password, and what a mistake in it costs.
 *
 * The class is free of Electron on purpose, so everything here is driven through the four things it
 * is given: a window that records what it was told to draw, a vault that records what it was handed,
 * a clipboard and a request-id source. Every assertion below is about a decision the *prompt* made.
 *
 * What breaks in the product if these stop holding:
 *
 *   - **A question that leaves the layer without an answer must still resolve.** The overlay layer is
 *     taken down constantly by things that know nothing about what was on it: a window resize, a lost
 *     focus, a layout change, the next surface claiming the layer. A departure that settled nothing
 *     would leave `passwords:requestUnlock` unresolved for ever and the passwords page on a spinner
 *     with no error anywhere; a departure reported as `wrong-password` would make that page say "that
 *     was not it" about something nobody finished typing.
 *   - **That departure must not dismiss the layer.** The surface is already gone, so `dismissOverlay`
 *     would take down whatever displaced it — which for a permission prompt means refusing a request
 *     nobody was asked about. This project has shipped that defect once already, from the other side.
 *   - **The presentation must carry a count and never the characters.** A field holding the value is
 *     the master password sitting in a renderer's heap, one `executeJavaScript` away from leaving it;
 *     the absence of any such field is the whole of what this design is sold on.
 *   - **The purpose must be derived from the vault, never taken from the caller.** A caller that could
 *     turn a `change` into a `set` would have found the one route to replacing the lock without
 *     opening it, and a `remove` that skipped its proof would make "take the lock off" the one
 *     operation needing no key.
 *   - **A mismatched repeat must re-ask both questions.** This is the operation whose mistakes cannot
 *     be discovered later: a vault re-wrapped under something nobody knows is a vault nobody opens.
 */

/** Long enough to pass `assessMasterPassword`, and distinctive enough to be searched for. */
const GOOD_PASSWORD = 'zebra-quartz-77'
const OTHER_PASSWORD = 'walrus-cobalt-31'
const OLD_PASSWORD = 'ancient-marmalade'
const CLIPBOARD_PASSPHRASE = 'seven-tin-lanterns'

interface FakeHost extends MasterPasswordHost {
  presented: OverlayPresentation[]
  dismissals: number
  /**
   * What the real layer does while dismissing: announce the departure, synchronously.
   *
   * Left null except in the one test that needs it, because it is the shape that turns a wrong
   * ordering inside `#finish` into an overwritten outcome.
   */
  onDismiss: (() => void) | null
}

function fakeHost(): FakeHost {
  const host: FakeHost = {
    presented: [],
    dismissals: 0,
    onDismiss: null,
    presentOverlay: (presentation) => {
      host.presented.push(presentation)
    },
    dismissOverlay: () => {
      host.dismissals += 1
      host.onDismiss?.()
    }
  }
  return host
}

function vaultStatus(overrides: Partial<VaultStatus> = {}): VaultStatus {
  return {
    protection: 'keystore+master',
    unlocked: false,
    unreadable: false,
    idleTimeoutMs: VAULT_IDLE_TIMEOUT_MS,
    ...overrides
  }
}

interface VaultBehaviour {
  readonly status?: VaultStatus
  readonly unlock?: (candidate: string) => UnlockOutcome | Promise<UnlockOutcome>
  readonly verify?: (candidate: string) => boolean | Promise<boolean>
  readonly set?: () => MasterPasswordOutcome | Promise<MasterPasswordOutcome>
}

/**
 * The vault, recording every secret it was handed.
 *
 * The records are the point: `unlocked`, `verified` and `written` are the complete list of places a
 * master password goes, so what the prompt assembled and where it sent it is visible without the
 * prompt having to expose either.
 */
interface FakeVault extends MasterPasswordVault {
  readonly unlocked: string[]
  readonly verified: string[]
  readonly written: Array<{ current: string | null; next: string | null }>
}

function fakeVault(behaviour: VaultBehaviour = {}): FakeVault {
  const status = behaviour.status ?? vaultStatus()
  const vault: FakeVault = {
    unlocked: [],
    verified: [],
    written: [],
    status: () => status,
    unlock: (candidate) => {
      vault.unlocked.push(candidate)
      return Promise.resolve(behaviour.unlock?.(candidate) ?? 'unlocked')
    },
    verifyMasterPassword: (candidate) => {
      vault.verified.push(candidate)
      return Promise.resolve(behaviour.verify?.(candidate) ?? true)
    },
    setMasterPassword: (request) => {
      vault.written.push({ current: request.current, next: request.next })
      return Promise.resolve(behaviour.set?.() ?? 'changed')
    }
  }
  return vault
}

function promptFor(vault: MasterPasswordVault, clipboard = ''): MasterPasswordPrompt {
  let counter = 0
  return new MasterPasswordPrompt({
    vault,
    readClipboard: () => clipboard,
    newRequestId: () => {
      counter += 1
      return `question-${counter}`
    }
  })
}

function keyDown(key: string, modifiers: Partial<Omit<PromptKey, 'key'>> = {}): PromptKey {
  return {
    type: 'keyDown',
    key,
    control: false,
    meta: false,
    alt: false,
    shift: false,
    isComposing: false,
    ...modifiers
  }
}

/**
 * Every question that reached the layer, narrowed.
 *
 * `presented` holds the whole `OverlayPresentation` union — the same host draws menus and permission
 * dialogues — so narrowing once here makes a test that provoked the wrong surface fail loudly instead
 * of reading a field off the wrong member.
 */
function questions(host: FakeHost): MasterPasswordPresentation[] {
  return host.presented.filter(
    (presentation): presentation is MasterPasswordPresentation =>
      presentation.kind === 'master-password'
  )
}

function onScreen(host: FakeHost): MasterPasswordPresentation {
  const [latest] = questions(host).slice(-1)
  if (latest === undefined) throw new Error('no question was presented')
  return latest
}

/** The questions asked in order, with the re-presentation after each keystroke collapsed. */
function stepsAsked(host: FakeHost): MasterPasswordStep[] {
  const asked: MasterPasswordStep[] = []
  for (const question of questions(host)) {
    const [previous] = asked.slice(-1)
    if (question.step !== previous) asked.push(question.step)
  }
  return asked
}

/**
 * Types into the question that is on screen.
 *
 * Each keystroke is matched against the presentation the layer would have captured it for, which is
 * how `onOverlayKey` delivers them.
 */
function typeText(prompt: MasterPasswordPrompt, host: FakeHost, text: string): void {
  for (const character of text) prompt.key(onScreen(host), keyDown(character))
}

/** Lets everything already scheduled run, so an awaited derivation has finished being awaited. */
function flush(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), 0)
  })
}

/** Return, and then the derivation the core awaits before it changes what is on screen. */
async function submit(prompt: MasterPasswordPrompt, host: FakeHost): Promise<void> {
  prompt.key(onScreen(host), keyDown('Enter'))
  await flush()
}

interface Watched<T> {
  readonly promise: Promise<T>
  outcome: T | 'pending'
}

/** Watches a request without waiting for it, so "this settled nothing" can be asserted. */
function watch<T>(promise: Promise<T>): Watched<T> {
  const watched: Watched<T> = { promise, outcome: 'pending' }
  void promise.then((outcome) => {
    watched.outcome = outcome
  })
  return watched
}

interface Deferred<T> {
  readonly promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let settle: (value: T) => void = () => {
    throw new Error('the deferred was resolved before its executor ran')
  }
  const promise = new Promise<T>((resolve) => {
    settle = resolve
  })
  return { promise, resolve: (value) => settle(value) }
}

/** A surface of another kind wearing the pending question's own id. */
function impostorSurface(requestId: string): OverlayPresentation {
  return {
    kind: 'permission-request',
    requestId,
    origin: 'https://example.com',
    subject: 'camera',
    devices: ['camera'],
    waiting: 0
  }
}

describe('requestUnlock answers the cases a dialogue would only make worse', () => {
  it('refuses a request from a window it cannot be drawn in', async () => {
    // Nowhere to draw the question means nobody can answer it, so it is refused rather than left
    // waiting for a dialogue that will never appear.
    const prompt = promptFor(fakeVault())
    await expect(prompt.requestUnlock(null)).resolves.toBe('cancelled')
    expect(prompt.pendingCount, 'a question with no window was recorded').toBe(0)
  })

  it('reports an open vault as unlocked without asking for what was already proved', async () => {
    const vault = fakeVault({ status: vaultStatus({ unlocked: true }) })
    const host = fakeHost()
    await expect(promptFor(vault).requestUnlock(host)).resolves.toBe('unlocked')
    expect(host.presented, 'an open vault put a dialogue on screen').toEqual([])
    expect(vault.unlocked, 'an open vault was derived against again').toEqual([])
  })

  it('reports an unreadable key file rather than asking for a password that cannot open it', async () => {
    // No password can open a key file whose wrapping is gone. A field that cannot succeed is the
    // theatre the passwords page has a panel instead of.
    const vault = fakeVault({ status: vaultStatus({ unreadable: true }) })
    const host = fakeHost()
    await expect(promptFor(vault).requestUnlock(host)).resolves.toBe('unreadable')
    expect(host.presented).toEqual([])
    expect(vault.unlocked).toEqual([])
  })

  it('reopens a vault with no master password and answers in the same word as a real success', async () => {
    /*
      The one case where an answer could have revealed something about the vault. A distinct word here
      — or a dialogue at all — would let anything that can reach `passwords:requestUnlock` discover
      whether this user has a master password set, which is a fact about them that a page linking to
      `tessera://passwords` has no business learning.
    */
    const silent = fakeVault({ status: vaultStatus({ protection: 'keystore' }) })
    const silentHost = fakeHost()
    const silentOutcome = await promptFor(silent).requestUnlock(silentHost)

    const guarded = fakeVault({ unlock: () => 'unlocked' })
    const askedHost = fakeHost()
    const asking = promptFor(guarded)
    const answered = asking.requestUnlock(askedHost)
    typeText(asking, askedHost, GOOD_PASSWORD)
    await submit(asking, askedHost)

    expect(silentOutcome).toBe('unlocked')
    expect(await answered, 'the two vaults are told apart by their answer').toBe(silentOutcome)
    expect(silentHost.presented, 'a password was asked for that nothing would check').toEqual([])
    expect(silent.unlocked, 'the vault with no master password was not reopened').toEqual([''])
  })

  it('reports unreadable when the silent reopen finds the key file damaged', async () => {
    const vault = fakeVault({
      status: vaultStatus({ protection: 'plain' }),
      unlock: () => 'unreadable'
    })
    const host = fakeHost()
    await expect(promptFor(vault).requestUnlock(host)).resolves.toBe('unreadable')
    expect(host.presented).toEqual([])
  })
})

describe('requestMasterPassword derives its purpose from the vault and errs towards proof', () => {
  it('refuses a request from a window it cannot be drawn in', async () => {
    const prompt = promptFor(fakeVault({ status: vaultStatus({ unlocked: true }) }))
    await expect(prompt.requestMasterPassword(null, 'change')).resolves.toBe('cancelled')
    expect(prompt.pendingCount).toBe(0)
  })

  it('refuses to re-wrap a key that is not in this process', async () => {
    // The vault is closed, so there is nothing here to re-wrap. Asking for a new master password
    // would leave the user believing they had changed something.
    const vault = fakeVault({ status: vaultStatus({ unlocked: false }) })
    const host = fakeHost()
    await expect(promptFor(vault).requestMasterPassword(host, 'set')).resolves.toBe('locked')
    expect(host.presented, 'a locked vault asked for a new master password').toEqual([])
  })

  it('has nothing to remove from a vault that is not protected', async () => {
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'keystore' }) })
    const host = fakeHost()
    await expect(promptFor(vault).requestMasterPassword(host, 'remove')).resolves.toBe(
      'not-protected'
    )
    expect(host.presented).toEqual([])
  })

  it('turns a set on a vault that already has a master password into a change', async () => {
    /*
      The one route to replacing the lock without opening it, closed. A caller asking to "set" a
      master password on a protected vault is asked for the existing one first, whatever it called the
      operation.
    */
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'master' }) })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'set')

    expect(onScreen(host).step, 'a set skipped the proof of the existing password').toBe('current')
    expect(onScreen(host).purpose).toBe('change')

    prompt.overlayVacated(onScreen(host), 'gone')
    await expect(request).resolves.toBe('cancelled')
  })

  it('asks a fresh vault for a new password rather than a current one that does not exist', async () => {
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'plain' }) })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'set')

    expect(onScreen(host).step).toBe('new')
    expect(onScreen(host).purpose).toBe('set')

    prompt.overlayVacated(onScreen(host), 'gone')
    await expect(request).resolves.toBe('cancelled')
  })

  it('turns a change on an unprotected vault into a set', async () => {
    // The mirror of the rule above: the sequence follows the vault's state, so a caller cannot
    // provoke a question about a password that does not exist.
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'keystore' }) })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'change')

    expect(onScreen(host).purpose).toBe('set')
    expect(onScreen(host).step).toBe('new')

    prompt.overlayVacated(onScreen(host), 'gone')
    await expect(request).resolves.toBe('cancelled')
  })
})

describe('the questions each purpose asks, in order', () => {
  it('asks an unlock for the existing password and nothing else', async () => {
    const vault = fakeVault({ unlock: () => 'unlocked' })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('unlocked')
    expect(stepsAsked(host)).toEqual(['current'])
    expect(vault.unlocked, 'the characters did not arrive as they were typed').toEqual([
      GOOD_PASSWORD
    ])
    expect(host.dismissals, 'the answered question stayed on screen').toBe(1)
  })

  it('asks a fresh vault for a new password and then for it again', async () => {
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'keystore' }),
      set: () => 'set'
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'set')

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)
    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('set')
    expect(stepsAsked(host)).toEqual(['new', 'repeat'])
    // Nothing to prove and nothing proved: a vault with no master password has no current one.
    expect(vault.verified).toEqual([])
    expect(vault.written).toEqual([{ current: null, next: GOOD_PASSWORD }])
  })

  it('asks a change for the existing password, a new one, and the new one again', async () => {
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'keystore+master' }),
      set: () => 'changed'
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'change')

    typeText(prompt, host, OLD_PASSWORD)
    await submit(prompt, host)
    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)
    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('changed')
    expect(stepsAsked(host)).toEqual(['current', 'new', 'repeat'])
    /*
      The existing password is checked when it is typed rather than three questions later. Discovering
      a mistyped current password after somebody had chosen and repeated a new one would mean throwing
      all three away.
    */
    expect(vault.verified).toEqual([OLD_PASSWORD])
    expect(vault.written).toEqual([{ current: OLD_PASSWORD, next: GOOD_PASSWORD }])
  })

  it('makes a removal prove knowledge of the password it is taking off', async () => {
    /*
      Otherwise "remove the lock" is the one operation that needs no key, which is the same as having
      no lock: anything that reached the channel could unprotect the vault of a user who had stepped
      away from an open one.
    */
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'master' }),
      set: () => 'removed'
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'remove')

    typeText(prompt, host, OLD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('removed')
    expect(stepsAsked(host), 'a removal asked for a new password as well').toEqual(['current'])
    expect(vault.verified).toEqual([OLD_PASSWORD])
    // `next: null` is what makes this a removal rather than a change.
    expect(vault.written).toEqual([{ current: OLD_PASSWORD, next: null }])
  })
})

describe('what the surface is told about the password being typed', () => {
  it('counts the characters and carries not one of them', async () => {
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    expect(onScreen(host).filled, 'a fresh question had something in its field').toBe(0)
    const counted: number[] = []
    for (const character of GOOD_PASSWORD) {
      prompt.key(onScreen(host), keyDown(character))
      counted.push(onScreen(host).filled)
    }
    expect(counted).toEqual(Array.from(GOOD_PASSWORD, (_character, index) => index + 1))

    for (const question of questions(host)) {
      // There is no field for the value, and this list is the proof: a future field carrying one
      // would fail here before it reached a renderer.
      expect(Object.keys(question).sort()).toEqual([
        'filled',
        'kind',
        'minLength',
        'problem',
        'purpose',
        'requestId',
        'step'
      ])
      /*
        No prefix of the candidate either. A growing string would have strewn every prefix of the
        password across the messages, and a prefix is most of a password.
      */
      const serialised = JSON.stringify(question)
      for (let length = 2; length <= GOOD_PASSWORD.length; length += 1) {
        expect(serialised, 'a prefix of the candidate reached the surface').not.toContain(
          GOOD_PASSWORD.slice(0, length)
        )
      }
    }
    // The floor is stated before it can be broken rather than after.
    expect(onScreen(host).minLength).toBe(MIN_MASTER_PASSWORD_LENGTH)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request).resolves.toBe('cancelled')
  })

  it('cuts a pasted file down to the longest allowed password rather than refusing it', async () => {
    /*
      Paste has to work — the length floor pushes people towards passphrases they keep somewhere else
      — and a pasted file or a held key would otherwise grow the buffer without limit. The bound and
      the rule have to agree: text cut to the maximum must not then be refused as too long.
    */
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'keystore' }) })
    const prompt = promptFor(vault, 'p'.repeat(MAX_MASTER_PASSWORD_LENGTH + 500))
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'set')

    prompt.key(onScreen(host), keyDown('v', { control: true }))
    expect(onScreen(host).filled).toBe(MAX_MASTER_PASSWORD_LENGTH)
    prompt.key(onScreen(host), keyDown('v', { control: true }))
    expect(onScreen(host).filled, 'a second paste grew a full buffer').toBe(
      MAX_MASTER_PASSWORD_LENGTH
    )

    await submit(prompt, host)
    expect(onScreen(host).step, 'the bounded paste was refused as too long').toBe('repeat')
    expect(onScreen(host).problem).toBeNull()

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request).resolves.toBe('cancelled')
    expect(vault.written).toEqual([])
  })
})

describe('one keystroke at a time', () => {
  it('cancels on Escape and takes the surface down', async () => {
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    typeText(prompt, host, GOOD_PASSWORD)
    prompt.key(onScreen(host), keyDown('Escape'))

    await expect(request).resolves.toBe('cancelled')
    expect(host.dismissals, 'the cancelled question was left on screen').toBe(1)
    expect(prompt.pendingCount).toBe(0)
  })

  it('removes one character on Backspace and the whole attempt on Ctrl+Backspace', async () => {
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    typeText(prompt, host, 'abcd')
    prompt.key(onScreen(host), keyDown('Backspace'))
    expect(onScreen(host).filled).toBe(3)
    prompt.key(onScreen(host), keyDown('Backspace', { control: true }))
    expect(onScreen(host).filled, 'the accelerator deleted a single character').toBe(0)
    // A backspace on an empty field is a keystroke like any other, not an error.
    prompt.key(onScreen(host), keyDown('Backspace'))
    expect(onScreen(host).filled).toBe(0)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request).resolves.toBe('cancelled')
  })

  it('throws the attempt away on Ctrl+U, which is what a lost count reaches for', async () => {
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    typeText(prompt, host, GOOD_PASSWORD)
    prompt.key(onScreen(host), keyDown('u', { meta: true }))
    expect(onScreen(host).filled).toBe(0)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request).resolves.toBe('cancelled')
  })

  it('pastes from the clipboard the main process read, which no renderer saw', async () => {
    const vault = fakeVault({ unlock: () => 'unlocked' })
    const prompt = promptFor(vault, CLIPBOARD_PASSPHRASE)
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    prompt.key(onScreen(host), keyDown('v', { control: true }))
    expect(onScreen(host).filled).toBe(CLIPBOARD_PASSPHRASE.length)
    await submit(prompt, host)

    await expect(request).resolves.toBe('unlocked')
    // The pasted text reached the derivation without ever being a value a renderer held.
    expect(vault.unlocked).toEqual([CLIPBOARD_PASSPHRASE])
  })

  it('sends nothing back for a key it does not understand', async () => {
    /*
      A presentation per ignored key would be a message per keystroke of every shortcut the user
      happens to try — and each of those messages is a statement about a master password being typed.
    */
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)
    const before = questions(host).length

    const ignored = [
      keyDown('Shift'),
      keyDown('F5'),
      keyDown('ArrowLeft'),
      keyDown('a', { alt: true }),
      keyDown('x', { control: true }),
      keyDown('v', { control: true, alt: true }),
      keyDown('a', { type: 'keyUp' }),
      keyDown('a', { type: 'char' }),
      keyDown('a', { isComposing: true })
    ]
    for (const key of ignored) prompt.key(onScreen(host), key)

    expect(questions(host).length, 'an ignored key produced a message').toBe(before)
    expect(onScreen(host).filled, 'an ignored key landed a character').toBe(0)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request).resolves.toBe('cancelled')
  })

  it('drops a keystroke captured for a question that has already been settled', async () => {
    // The prompt can be settled between the press and this call — a window closing, a click on
    // Cancel — and the first settlement is the one that counts.
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)
    const captured = onScreen(host)

    prompt.key(captured, keyDown('Escape'))
    const after = questions(host).length
    prompt.key(captured, keyDown('a'))
    prompt.key(captured, keyDown('Enter'))

    expect(questions(host).length, 'a settled question was drawn again').toBe(after)
    await expect(request).resolves.toBe('cancelled')
  })

  it('ignores a keystroke captured for another surface wearing the same request id', async () => {
    // It is the kind that decides, not the id: only the surface that collects a master password may
    // deliver characters into one.
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    prompt.key(impostorSurface(onScreen(host).requestId), keyDown('a'))
    expect(onScreen(host).filled).toBe(0)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request).resolves.toBe('cancelled')
  })
})

describe('a refusal says what was wrong and asks the same question again', () => {
  it('refuses a new password below the floor without writing anything', async () => {
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'keystore' }) })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = watch(prompt.requestMasterPassword(host, 'set'))

    typeText(prompt, host, 'short')
    await submit(prompt, host)

    expect(onScreen(host).problem).toBe('too-short')
    expect(onScreen(host).step, 'a refusal moved the sequence on').toBe('new')
    expect(onScreen(host).filled, 'the refused attempt was left in the field').toBe(0)
    expect(vault.written, 'a password the rules refuse was written').toEqual([])
    expect(request.outcome, 'a refusal ended the request instead of asking again').toBe('pending')

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request.promise).resolves.toBe('cancelled')
  })

  it('keeps the refusal on screen for another Continue and clears it on the next keystroke', async () => {
    /*
      "That was not it" has to stop being on screen the moment a new attempt starts, and not before.
      Pressing Continue on an empty field is not a new attempt; typing is — and a refusal of the
      previous attempt sitting above the one being made now is how a person retries at random.
    */
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'keystore' }) })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'set')

    typeText(prompt, host, 'short')
    await submit(prompt, host)
    prompt.answer(onScreen(host).requestId, 'submit')
    await flush()
    expect(onScreen(host).problem, 'Continue cleared the refusal it had just earned').toBe(
      'too-short'
    )

    prompt.key(onScreen(host), keyDown('z'))
    expect(onScreen(host).problem, 'the previous refusal sat above the new attempt').toBeNull()
    expect(onScreen(host).filled).toBe(1)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request).resolves.toBe('cancelled')
  })

  it('asks both new-password questions again when the repeat disagrees', async () => {
    /*
      Back two steps, not one. Somebody who mistyped does not know *which* of the two they mistyped,
      so re-asking only the repeat would let them confirm a password they did not mean — and this is
      the operation whose mistakes cannot be discovered later, because the vault would be re-wrapped
      under something nobody knows.
    */
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'keystore' }),
      set: () => 'set'
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'set')

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)
    typeText(prompt, host, OTHER_PASSWORD)
    await submit(prompt, host)

    expect(onScreen(host).step).toBe('new')
    expect(onScreen(host).problem).toBe('mismatch')
    expect(onScreen(host).filled).toBe(0)
    expect(stepsAsked(host)).toEqual(['new', 'repeat', 'new'])
    expect(vault.written, 'a password only one of the two questions agreed on was written').toEqual(
      []
    )

    // The discarded proposal is gone: both questions have to be answered again from nothing.
    typeText(prompt, host, OTHER_PASSWORD)
    await submit(prompt, host)
    typeText(prompt, host, OTHER_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('set')
    expect(vault.written).toEqual([{ current: null, next: OTHER_PASSWORD }])
  })

  it('refuses a mistyped current password where it was typed, not three questions later', async () => {
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'master' }),
      verify: (candidate) => candidate === OLD_PASSWORD
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = watch(prompt.requestMasterPassword(host, 'change'))

    typeText(prompt, host, OTHER_PASSWORD)
    await submit(prompt, host)

    expect(onScreen(host).problem).toBe('wrong-password')
    expect(onScreen(host).step, 'a wrong current password moved on to the new one').toBe('current')
    expect(onScreen(host).filled).toBe(0)
    expect(request.outcome, 'one mistyped character ended the whole request').toBe('pending')
    expect(host.dismissals, 'the question the user is still answering was taken down').toBe(0)

    // And the same question, answered correctly, carries on.
    typeText(prompt, host, OLD_PASSWORD)
    await submit(prompt, host)
    expect(onScreen(host).step).toBe('new')
    expect(onScreen(host).problem).toBeNull()

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request.promise).resolves.toBe('cancelled')
  })

  it('asks an unlock again after a wrong password rather than settling it', async () => {
    const vault = fakeVault({
      unlock: (candidate) => (candidate === GOOD_PASSWORD ? 'unlocked' : 'wrong-password')
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = watch(prompt.requestUnlock(host))

    typeText(prompt, host, OTHER_PASSWORD)
    await submit(prompt, host)
    expect(onScreen(host).problem).toBe('wrong-password')
    expect(request.outcome).toBe('pending')

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request.promise).resolves.toBe('unlocked')
    expect(vault.unlocked).toEqual([OTHER_PASSWORD, GOOD_PASSWORD])
  })

  it('stops asking when the attempt finds the key file unreadable', async () => {
    // Discovered during the derivation rather than in the status. No further password can help, so
    // asking again would be a field that cannot succeed.
    const vault = fakeVault({ unlock: () => 'unreadable' })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('unreadable')
    expect(host.dismissals).toBe(1)
    expect(prompt.pendingCount).toBe(0)
  })

  it('treats a vault that turns out to have no master password as open', async () => {
    // `not-protected` from the derivation means the document is open, which is what was asked for.
    const vault = fakeVault({ unlock: () => 'not-protected' })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('unlocked')
  })
})

describe('a held Return cannot start a second derivation', () => {
  it('runs one derivation for three submits while the first is still going', async () => {
    /*
      `scrypt` at N = 2^17 takes about half a second by design and Return auto-repeats. Without the
      guard a held key starts a dozen derivations against a buffer that is being emptied underneath
      them — every one of them a joined copy of the master password on the heap.
    */
    const held = deferred<UnlockOutcome>()
    const vault = fakeVault({ unlock: () => held.promise })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    typeText(prompt, host, GOOD_PASSWORD)
    prompt.key(onScreen(host), keyDown('Enter'))
    prompt.key(onScreen(host), keyDown('Enter'))
    prompt.answer(onScreen(host).requestId, 'submit')
    await flush()

    expect(vault.unlocked, 'a repeated Return started another derivation').toEqual([GOOD_PASSWORD])

    held.resolve('unlocked')
    await expect(request).resolves.toBe('unlocked')
  })
})

describe('a question that leaves the layer without an answer', () => {
  const reasons: OverlayVacancyReason[] = ['dismissed', 'replaced', 'gone']

  it('settles as cancelled however the surface went, and never as a wrong password', async () => {
    /*
      A window resize, a lost focus, a closed window and the next surface claiming the layer all
      arrive here. Every one of them is the browser taking the question away, not the user getting
      their own master password wrong — and `wrong-password` is what the passwords page renders as
      "that was not it".
    */
    for (const reason of reasons) {
      const prompt = promptFor(fakeVault())
      const host = fakeHost()
      const request = prompt.requestUnlock(host)

      typeText(prompt, host, 'half-typ')
      prompt.overlayVacated(onScreen(host), reason)

      await expect(request, reason).resolves.toBe('cancelled')
      expect(prompt.pendingCount, reason).toBe(0)
    }
  })

  it('does not take down whatever displaced it', async () => {
    /*
      There is nothing left to dismiss: the layer has already replaced or destroyed this surface, so
      `dismissOverlay` here would take down the surface that displaced it. For a permission prompt
      that means refusing a request nobody was asked about — the defect this project has already
      shipped once, from the other side.
    */
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)

    prompt.overlayVacated(onScreen(host), 'replaced')

    await expect(request).resolves.toBe('cancelled')
    expect(host.dismissals, 'the vacated question dismissed a layer it no longer owned').toBe(0)
  })

  it('settles nothing when the departure names another question', async () => {
    /*
      The narrow version of the same bug: a re-present of the same *kind* announces a vacancy, and if
      the id were not checked it would settle a question that is still on screen being typed into.
    */
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = watch(prompt.requestUnlock(host))

    prompt.overlayVacated({ ...onScreen(host), requestId: 'question-never-asked' }, 'replaced')
    await flush()

    expect(request.outcome, "a stranger's departure settled this question").toBe('pending')
    expect(prompt.pendingCount).toBe(1)
    expect(host.dismissals).toBe(0)

    prompt.overlayVacated(onScreen(host), 'gone')
    await expect(request.promise).resolves.toBe('cancelled')
  })

  it('settles nothing when the departure is of another surface', async () => {
    // Every surface's departure is announced to every listener, so the kind is what makes this
    // announcement ours. A find bar going away is not an unanswered password prompt.
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = watch(prompt.requestUnlock(host))

    prompt.overlayVacated(impostorSurface(onScreen(host).requestId), 'gone')
    await flush()

    expect(request.outcome).toBe('pending')
    expect(prompt.pendingCount).toBe(1)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(request.promise).resolves.toBe('cancelled')
  })

  it('keeps the outcome it determined when its own dismissal announces the departure back', async () => {
    /*
      The real layer announces the vacancy from inside `dismissOverlay`, synchronously. If the request
      were still pending at that moment the announcement would find it and settle it as cancelled,
      overwriting the outcome just determined — so a user who typed the right password would be told
      they had cancelled, and the caller that asked for the vault would never learn it was open.
    */
    const vault = fakeVault({ unlock: () => 'unlocked' })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestUnlock(host)
    const captured = onScreen(host)
    host.onDismiss = () => {
      prompt.overlayVacated(captured, 'dismissed')
    }

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('unlocked')
    expect(host.dismissals).toBe(1)
  })
})

describe('one question per window', () => {
  it('answers a second request rather than queueing it behind the first', async () => {
    /*
      Unlike a permission prompt there is nothing to queue *for*: every caller of this wants the same
      thing — the vault open — so the question on screen will serve them all, and the honest answer to
      the second is "you were not asked". Queueing would also mean two questions sharing one input
      pipeline, which the single-buffer design cannot support.
    */
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const first = prompt.requestUnlock(host)
    const asked = questions(host).length

    await expect(prompt.requestUnlock(host)).resolves.toBe('cancelled')
    expect(questions(host).length, 'the question on screen was redrawn or replaced').toBe(asked)
    expect(prompt.pendingCount).toBe(1)

    typeText(prompt, host, 'abc')
    expect(onScreen(host).filled, 'the second request emptied the buffer being typed into').toBe(3)

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(first).resolves.toBe('cancelled')
  })

  it('answers a second request of another purpose the same way', async () => {
    // Not "the newest purpose wins": a `remove` arriving while a `change` is being answered must not
    // be able to take over the buffer the user is typing their current password into.
    const vault = fakeVault({ status: vaultStatus({ unlocked: true, protection: 'master' }) })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const first = prompt.requestMasterPassword(host, 'change')

    await expect(prompt.requestMasterPassword(host, 'remove')).resolves.toBe('cancelled')
    expect(onScreen(host).purpose, 'a second request changed the question on screen').toBe('change')

    prompt.key(onScreen(host), keyDown('Escape'))
    await expect(first).resolves.toBe('cancelled')
  })

  it('gives each question an id of its own without being handed a source of them', async () => {
    /*
      The injected `newRequestId` is a convenience for these tests; the application supplies none and
      gets `randomUUID`. Two questions sharing an id would let an answer shown for one resolve the
      other, which is the failure ids exist to prevent — so the default has to be a real source of
      distinct ones rather than a placeholder.
    */
    const prompt = new MasterPasswordPrompt({ vault: fakeVault(), readClipboard: () => '' })
    const one = fakeHost()
    const two = fakeHost()
    const asking = prompt.requestUnlock(one)
    const alsoAsking = prompt.requestUnlock(two)

    expect(onScreen(one).requestId).not.toBe('')
    expect(onScreen(one).requestId, 'two questions were named the same thing').not.toBe(
      onScreen(two).requestId
    )

    prompt.overlayVacated(onScreen(one), 'gone')
    prompt.overlayVacated(onScreen(two), 'gone')
    await expect(asking).resolves.toBe('cancelled')
    await expect(alsoAsking).resolves.toBe('cancelled')
  })

  it('lets two windows each ask their own question', async () => {
    // Keyed by request id rather than held in one field, because two windows may each be asking —
    // and neither one's keystrokes, cancel or departure may reach the other.
    const prompt = promptFor(fakeVault())
    const one = fakeHost()
    const two = fakeHost()
    const asking = prompt.requestUnlock(one)
    const alsoAsking = prompt.requestUnlock(two)

    expect(prompt.pendingCount).toBe(2)
    expect(onScreen(one).requestId).not.toBe(onScreen(two).requestId)

    typeText(prompt, one, 'abc')
    expect(onScreen(two).filled, "one window's typing reached the other's buffer").toBe(0)

    prompt.key(onScreen(one), keyDown('Escape'))
    await expect(asking).resolves.toBe('cancelled')
    expect(two.dismissals, "one window's cancel took the other's question down").toBe(0)
    expect(prompt.pendingCount).toBe(1)

    prompt.overlayVacated(onScreen(two), 'gone')
    await expect(alsoAsking).resolves.toBe('cancelled')
  })
})

describe('the mouse route', () => {
  it('submits on Continue and cancels on Cancel', async () => {
    // The two buttons carry nothing but which one was pressed; every keyboard route is handled in the
    // core, because this surface's keys never reach a renderer.
    const vault = fakeVault({ unlock: () => 'unlocked' })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const answered = prompt.requestUnlock(host)
    typeText(prompt, host, GOOD_PASSWORD)
    prompt.answer(onScreen(host).requestId, 'submit')
    await expect(answered).resolves.toBe('unlocked')

    const cancelling = promptFor(fakeVault())
    const second = fakeHost()
    const abandoned = cancelling.requestUnlock(second)
    cancelling.answer(onScreen(second).requestId, 'cancel')
    await expect(abandoned).resolves.toBe('cancelled')
    expect(second.dismissals).toBe(1)
  })

  it('ignores a button press that names a question nobody is holding', async () => {
    // A click can land after the question has gone — a closed window, a resize, an Escape a moment
    // earlier — and the first settlement is the one that counts.
    const prompt = promptFor(fakeVault())
    const host = fakeHost()
    const request = prompt.requestUnlock(host)
    const settled = onScreen(host).requestId

    prompt.key(onScreen(host), keyDown('Escape'))
    prompt.answer(settled, 'submit')
    prompt.answer(settled, 'cancel')
    prompt.answer('question-never-asked', 'cancel')
    await flush()

    await expect(request).resolves.toBe('cancelled')
    expect(host.dismissals, 'a stale click took the layer down again').toBe(1)
  })
})

describe('committing the change', () => {
  it('reports a proof that went stale rather than swallowing it', async () => {
    /*
      Unreachable today: the current password was proved a moment earlier. It becomes reachable the
      day another window changes the master password while this prompt is open, and the honest report
      then is that the proof is no longer good — not a fourth question, and not a silent success.
    */
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'master' }),
      set: () => 'wrong-password'
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'remove')

    typeText(prompt, host, OLD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('wrong-password')
    expect(host.dismissals).toBe(1)
    expect(prompt.pendingCount).toBe(0)
  })

  it('passes a refusal from the vault through as it stands', async () => {
    // The vault applies the same rules again against the bytes it is about to write. A `rejected` from
    // there is reported rather than translated, because the page already knows what the rules are.
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'keystore' }),
      set: () => 'rejected'
    })
    const prompt = promptFor(vault)
    const host = fakeHost()
    const request = prompt.requestMasterPassword(host, 'set')

    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)
    typeText(prompt, host, GOOD_PASSWORD)
    await submit(prompt, host)

    await expect(request).resolves.toBe('rejected')
  })
})

describe('pendingCount', () => {
  it('counts the questions on screen, from none to one and back', async () => {
    // Diagnostics only, and asserted here because it is how a leaked pending entry — a question that
    // was settled but never forgotten — would first become visible.
    const prompt = promptFor(fakeVault())
    expect(prompt.pendingCount).toBe(0)

    const host = fakeHost()
    const request = prompt.requestUnlock(host)
    expect(prompt.pendingCount).toBe(1)

    prompt.key(onScreen(host), keyDown('Escape'))
    expect(prompt.pendingCount).toBe(0)
    await expect(request).resolves.toBe('cancelled')
  })
})

describe('a vault that cannot do the work at all', () => {
  /**
   * Not a wrong password: an I/O failure on `passwords.key`.
   *
   * `PasswordVault` answers a wrong candidate and a broken rule as *values*, and deliberately rethrows
   * everything else — no permission on the profile, a full disk, a device that went away. So a rejection
   * from any of its three methods is a fact about the machine and never about what was typed, and it has
   * to be handled here rather than escaping.
   *
   * Two failures if it is not, and the second is worse than it sounds. The request never settles, so
   * `passwords:requestUnlock` waits on a promise nothing will resolve — the same debt a vanished surface
   * leaves, by another route. And `#submit` is started with `void`, so the rejection is an unhandled one:
   * Node terminates the process for those by default, which makes a disk error during an unlock a way to
   * take the whole browser down.
   */
  let errors: string[] = []

  beforeEach(() => {
    errors = []
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map((value) => String(value)).join(' '))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('settles an unlock as unreadable rather than leaving the button dead', async () => {
    const vault = fakeVault({
      unlock: () => {
        throw new Error('EACCES: permission denied, open /profile/passwords.key')
      }
    })
    const prompt = promptFor(vault)
    const host = fakeHost()

    const request = prompt.requestUnlock(host)
    typeText(prompt, host, 'correct horse battery')
    await submit(prompt, host)

    await expect(request).resolves.toBe('unreadable')
    // Settled and taken down, not left on screen: the previous behaviour was a Continue that did
    // nothing, which a user cannot tell apart from a mistyped password however often they retry.
    expect(prompt.pendingCount).toBe(0)
    expect(host.dismissals).toBe(1)
  })

  it('settles a master-password change as locked, which is the word for "no key to re-wrap"', async () => {
    const vault = fakeVault({
      status: vaultStatus({ unlocked: true, protection: 'keystore+master' }),
      set: () => {
        throw new Error('ENOSPC: no space left on device')
      }
    })
    const prompt = promptFor(vault)
    const host = fakeHost()

    const request = prompt.requestMasterPassword(host, 'change')
    typeText(prompt, host, 'the old passphrase')
    await submit(prompt, host)
    typeText(prompt, host, 'a brand new passphrase')
    await submit(prompt, host)
    typeText(prompt, host, 'a brand new passphrase')
    await submit(prompt, host)

    await expect(request).resolves.toBe('locked')
    expect(prompt.pendingCount).toBe(0)
  })

  it('names the failure in the log and never a character of the candidate', async () => {
    /*
      The log line is the one place a failure on this path becomes text, so it is the one place a
      candidate could escape into something that is written down, copied into a bug report and kept.
      The operating system's message names a path, which is not a secret; the buffer must not appear.
    */
    /*
      Deliberately unlike prose. A candidate made of English words shares two- and three-letter runs
      with the operating system's own message ("read" contains "re"), so the assertion below would fail
      on a coincidence rather than on a leak — and a test that cries wolf about a password escaping is
      one somebody eventually loosens.
    */
    const candidate = 'Zq7Wv2xLm9kRt4bYp6'
    const vault = fakeVault({
      unlock: () => {
        throw new Error('EIO: i/o error, read')
      }
    })
    const prompt = promptFor(vault)
    const host = fakeHost()

    const request = prompt.requestUnlock(host)
    typeText(prompt, host, candidate)
    await submit(prompt, host)
    await expect(request).resolves.toBe('unreadable')

    expect(errors).toHaveLength(1)
    const [logged] = errors
    expect(logged).toContain('EIO')
    // Every four-character run, so a partial leak fails this as surely as the whole phrase would.
    for (let start = 0; start + 4 <= candidate.length; start += 1) {
      expect(logged, `logged a fragment of the candidate at ${String(start)}`).not.toContain(
        candidate.slice(start, start + 4)
      )
    }
  })

  it('lets the next question be asked, so a transient failure is not the end of the prompt', async () => {
    /*
      `busy` is reset in a `finally`, and it has to be: a disk that was briefly unavailable would
      otherwise leave every later attempt in this process refusing to derive anything, with the prompt
      opening and Continue doing nothing for the rest of the session.
    */
    let failing = true
    const vault = fakeVault({
      unlock: () => {
        if (failing) throw new Error('EIO: i/o error, read')
        return 'unlocked'
      }
    })
    const prompt = promptFor(vault)

    const first = fakeHost()
    const firstRequest = prompt.requestUnlock(first)
    typeText(prompt, first, 'correct horse battery')
    await submit(prompt, first)
    await expect(firstRequest).resolves.toBe('unreadable')

    failing = false
    const second = fakeHost()
    const secondRequest = prompt.requestUnlock(second)
    typeText(prompt, second, 'correct horse battery')
    await submit(prompt, second)
    await expect(secondRequest).resolves.toBe('unlocked')
  })
})
