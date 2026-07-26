import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PasswordSummary } from '@shared/passwords/model.js'
import { searchSummaries } from '@shared/passwords/model.js'
import { originMayReceiveCredentials } from '@shared/passwords/fill-policy.js'
import {
  REVEAL_TIMEOUT_MS,
  isRevealed,
  nextRevealState,
  revealState,
  type RevealState
} from '@shared/passwords/reveal.js'
import type { PasswordCalls, PasswordChannel } from '@shared/passwords/api.js'
import { passwordMessage, type PasswordMessageKey } from '@shared/passwords/messages.js'
import type { VaultKeyProtection } from '@shared/passwords/vault.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://passwords`.
 *
 * ## Why a list of credentials is drawn this way
 *
 * A saved-password list is itself a secret, and an unlocked passwords tab left open on a desk is —
 * in most browsers' design — the whole vault. `shared/passwords/reveal.ts` carries the full argument,
 * including the honest admission that meaningful re-authentication is not achievable with
 * `safeStorage` and needs a master password, with the design for one written out. What this page does
 * with that:
 *
 *   1. **It is never sent the passwords.** `passwords:list` answers with origins, usernames and
 *      timestamps. There is no call on this page's allowlist that returns more than one secret.
 *   2. **Revealing is one at a time**, fetched by id when the user asks for it, and the reducer in
 *      `reveal.ts` makes two-revealed-at-once unrepresentable rather than merely unlikely.
 *   3. **A revealed password is dropped** after half a minute and immediately when the document stops
 *      being visible — another tab, a minimised window, a locked screen.
 *
 * So the worst case for a forgotten tab is a list of sites and names, plus one password for thirty
 * seconds. That is a real bound, and it is as far as this can honestly be taken without a master
 * password.
 *
 * ## Why the address is shown with its scheme
 *
 * `https://example.com`, not `example.com`. The scheme is not decoration here: an entry saved over
 * plain `http:` is one autofill will refuse to fill, and the user has no other way to know why the
 * suggestion never appears. `originMayReceiveCredentials` is the same predicate the fill path uses,
 * so the note on the row cannot disagree with the behaviour.
 *
 * ## Privileges
 *
 * An internal page rendered as content: the per-page allowlist grants the six password channels and
 * `i18n:getCatalog`, and nothing else. It cannot read a setting, touch a tab, or reach the window.
 */

/** What a concealed password looks like. Not text, so it needs no translation. */
const MASK = '••••••••••'

/** How often the countdown is re-checked. A second is enough for a thirty-second bound. */
const TICK_MS = 1000

/**
 * The bridge, as this page needs to see it.
 *
 * The typed helper in `bridge.ts` is generic over `InternalInvokeChannel`, which is derived from
 * `INTERNAL_PAGE_INVOKE_CHANNELS` — and the `passwords` entry there lands in a separate, coordinated
 * edit to a file this change does not own. So the six channels are declared here, once, against the
 * request and response types in `shared/passwords/api.ts`, which is also what the core's `PasswordApi`
 * is typed against. When the allowlist entry is in place this whole block collapses to
 * `import { invoke } from './bridge.js'` and the compiler takes over again.
 */
interface PasswordBridge {
  invoke(channel: PasswordChannel, payload?: unknown): Promise<unknown>
}

function passwordBridge(): PasswordBridge | null {
  const bridge: unknown = window.tesseraInternal
  if (typeof bridge !== 'object' || bridge === null) return null
  return bridge as PasswordBridge
}

async function call<C extends PasswordChannel>(
  channel: C,
  payload: PasswordCalls[C]['request']
): Promise<PasswordCalls[C]['response']> {
  const bridge = passwordBridge()
  if (bridge === null) {
    throw new Error('tessera internal bridge is unavailable on this page')
  }
  const answer = await bridge.invoke(channel, payload)
  // One assertion, at the boundary the contract will type once its entries land. The core validates
  // both directions in `ipc/router.ts`, so this is a typing gap rather than a trust gap.
  return answer as PasswordCalls[C]['response']
}

interface Revealed {
  readonly state: RevealState
  readonly password: string
}

/**
 * One sentence per protection level, keyed by the level itself.
 *
 * A table rather than a template, because the key names are not the union members: `keystore+master` is not a
 * legal identifier. Written out so a level added to `VaultKeyProtection` without a sentence here is a compile
 * error rather than a blank paragraph on the page that explains the guarantee.
 */
const PROTECTION_MESSAGES: Readonly<Record<VaultKeyProtection, PasswordMessageKey>> = {
  'keystore+master': 'passwords.protection.keystoreMaster',
  master: 'passwords.protection.master',
  keystore: 'passwords.protection.keystore',
  plain: 'passwords.protection.plain'
}

export function PasswordsPage(): React.ReactNode {
  const { locale, t: translateKey } = useInternalI18n()
  const t = useCallback(
    (key: PasswordMessageKey, params?: Record<string, string | number>): string =>
      translateKey(passwordMessage(key), params),
    [translateKey]
  )

  const [credentials, setCredentials] = useState<PasswordSummary[]>([])
  const [neverSaved, setNeverSaved] = useState<string[]>([])
  /*
    The vault's protection level, from `VaultKeyProtection` rather than a two-way flag.

    It was `'os-keystore' | 'unencrypted'`, which cannot express the state that matters most once a master
    password exists: key store *and* master password, versus only one of them. Starting at the weakest value is
    deliberate — a page about credentials must not claim a guarantee it has not yet been told it has.
  */
  const [protection, setProtection] = useState<VaultKeyProtection>('plain')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [revealed, setRevealed] = useState<Revealed | null>(null)
  /*
    The clock, as state.

    Reading `Date.now()` while rendering is impure — React may render at any moment, so a row would
    decide whether a password is still on screen from a time nobody chose. Worse for this page than
    for most: the answer changes from "shown" to "hidden" on its own, so a render triggered by
    something unrelated would hide a password mid-read, or keep one after its time was up.

    Set when a reveal starts and advanced by the timer below, so the moment the view is drawn for is
    always one this component decided on.
  */
  const [now, setNow] = useState(0)
  const [editing, setEditing] = useState<string | null>(null)
  const [draftPassword, setDraftPassword] = useState('')
  const [adding, setAdding] = useState(false)
  const [draftSite, setDraftSite] = useState('')
  const [draftUsername, setDraftUsername] = useState('')
  const [draftNew, setDraftNew] = useState('')

  const timeFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  const refresh = useCallback(async (): Promise<void> => {
    const answer = await call('passwords:list', undefined)
    setCredentials(answer.credentials)
    setNeverSaved(answer.neverSaved)
    setProtection(answer.vault.protection)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (passwordBridge() === null) {
      // Reported through the same asynchronous path as everything else, so this effect holds no
      // synchronous state write. Same shape as the history page.
      queueMicrotask(() => {
        if (!cancelled) setLoaded(true)
      })
      return () => {
        cancelled = true
      }
    }
    void (async () => {
      try {
        await refresh()
      } finally {
        if (!cancelled) setLoaded(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refresh])

  /*
    The two ways a reveal ends without the user pressing anything.

    The timer is the thirty-second bound. `visibilitychange` is the one that matters more in practice:
    switching to another tab, minimising the window or locking the screen all fire it, and each of
    those is a moment when a password on screen has stopped being something the user is looking at.
  */
  useEffect(() => {
    if (revealed === null) return
    const handle = setInterval(() => {
      const at = Date.now()
      setNow(at)
      // Through the reducer, so the timeout is enforced by the one tested function rather than by a
      // comparison written again here. The state is *dropped*, not merely hidden: the password must
      // leave this component's memory when its time is up, not only stop being drawn.
      if (nextRevealState(revealed.state, { kind: 'tick', at }) === null) setRevealed(null)
    }, TICK_MS)
    const conceal = (): void => {
      if (document.visibilityState !== 'visible') {
        setRevealed(nextRevealState(revealed.state, { kind: 'concealed' }) === null ? null : revealed)
      }
    }
    document.addEventListener('visibilitychange', conceal)
    return () => {
      clearInterval(handle)
      document.removeEventListener('visibilitychange', conceal)
    }
  }, [revealed])

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    try {
      setNotice(null)
      await action()
    } catch (cause) {
      // A refused call must be visible. Silently leaving the list unchanged is how a user learns not
      // to trust the delete button. The message is the core's; it never contains a password.
      setNotice(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  const visible = useMemo(() => searchSummaries(credentials, query), [credentials, query])

  const reveal = (entry: PasswordSummary): void => {
    void run(async () => {
      const answer = await call('passwords:reveal', { id: entry.id })
      if (answer.password === null) {
        // The entry went between the row being drawn and the button being pressed. Refreshing is a
        // truer answer than an error about an id.
        await refresh()
        return
      }
      // Built with `revealState` rather than through the reducer, so there is no `null` branch here
      // that the reducer could never produce for a `reveal`. The clock is advanced with it, so the
      // first render after a reveal is drawn for the moment the reveal happened.
      const at = Date.now()
      setNow(at)
      setRevealed({ state: revealState(entry.id, at), password: answer.password })
    })
  }

  const remove = (entry: PasswordSummary): void => {
    if (!globalThis.confirm(t('passwords.removeConfirm', { site: entry.origin }))) return
    void run(async () => {
      const answer = await call('passwords:remove', { id: entry.id })
      if (answer.removed) setNotice(t('passwords.removed'))
      setRevealed(null)
      await refresh()
    })
  }

  const saveEdit = (entry: PasswordSummary): void => {
    void run(async () => {
      await call('passwords:update', { id: entry.id, password: draftPassword })
      setEditing(null)
      setDraftPassword('')
      setRevealed(null)
      setNotice(t('passwords.updated'))
      await refresh()
    })
  }

  const add = (): void => {
    void run(async () => {
      const answer = await call('passwords:create', {
        url: draftSite,
        username: draftUsername,
        password: draftNew
      })
      if (answer.outcome === 'rejected') {
        setNotice(t('passwords.rejected'))
        return
      }
      setAdding(false)
      setDraftSite('')
      setDraftUsername('')
      setDraftNew('')
      setNotice(t('passwords.created'))
      await refresh()
    })
  }

  const forgetNeverSaved = (origin: string): void => {
    void run(async () => {
      await call('passwords:forgetNeverSaved', { origin })
      await refresh()
    })
  }

  return (
    <main className="passwords">
      <header className="passwords__header">
        <h1 className="passwords__title">{t('passwords.title')}</h1>
        <input
          className="passwords__search"
          type="search"
          value={query}
          placeholder={t('passwords.searchPlaceholder')}
          aria-label={t('passwords.searchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="passwords__add" onClick={() => setAdding((open) => !open)}>
          {t('passwords.add')}
        </button>
      </header>

      {/*
        Shown always, not only when something is wrong.

        What these entries are worth depends on a fact the user cannot discover for themselves —
        whether the operating system had a key store to wrap a key with, and that anyone already
        logged in as this user can read them either way. A manager that mentioned neither would be
        misrepresenting itself on its own front page.
      */}
      <p className="passwords__protection" role="note">
        {/*
          One sentence per protection level, keyed by the level itself.

          It used to be a two-way choice between "protected" and "unencrypted", which could not say the thing
          that matters most once a master password exists: whether the vault is behind the OS key store *and* a
          master password, or only one of them. A page about credentials must not round its own guarantee up.
        */}
        {/* The table covers every member of the union, so this read is total. */}
        {t(PROTECTION_MESSAGES[protection])}
      </p>

      {notice !== null && (
        <p className="passwords__notice" role="status">
          {notice}
        </p>
      )}

      {adding && (
        <section className="passwords__form">
          <h2 className="passwords__formTitle">{t('passwords.addTitle')}</h2>
          <label className="passwords__field">
            <span>{t('passwords.site')}</span>
            <input
              type="url"
              value={draftSite}
              placeholder={t('passwords.sitePlaceholder')}
              onChange={(event) => setDraftSite(event.target.value)}
            />
          </label>
          <label className="passwords__field">
            <span>{t('passwords.username')}</span>
            <input
              type="text"
              value={draftUsername}
              onChange={(event) => setDraftUsername(event.target.value)}
            />
          </label>
          <label className="passwords__field">
            <span>{t('passwords.password')}</span>
            {/*
              `type="password"` even here, where the user is the one typing it.

              A field that showed the value would put it on any screen recording or shoulder that
              happens to be nearby, for the whole time it takes to type — which is longer than the
              thirty seconds the reveal above is bounded to.
            */}
            <input
              type="password"
              value={draftNew}
              onChange={(event) => setDraftNew(event.target.value)}
            />
          </label>
          <div className="passwords__formActions">
            <button type="button" className="passwords__primary" onClick={add}>
              {t('passwords.saveChanges')}
            </button>
            <button type="button" onClick={() => setAdding(false)}>
              {t('passwords.cancel')}
            </button>
          </div>
        </section>
      )}

      {loaded && visible.length === 0 && (
        <p className="passwords__empty">
          {query === '' ? t('passwords.empty') : t('passwords.noMatches', { query })}
        </p>
      )}

      <ul className="passwords__list">
        {visible.map((entry) => {
          /*
            One value rather than a boolean plus a lookup.

            `revealed !== null && isRevealed(…)` does not narrow `revealed` for the branch that reads
            its password, so the naive shape needs the null check written twice — and the second one
            reads like a defensive branch when it is really a limit of narrowing. Deriving the string
            once removes both.
          */
          const shownPassword =
            revealed !== null && isRevealed(revealed.state, entry.id, now)
              ? revealed.password
              : null
          const shown = shownPassword !== null
          return (
            <li className="passwords__entry" key={entry.id}>
              <span className="passwords__site">{entry.origin}</span>
              <span className="passwords__username">
                {entry.username === '' ? t('passwords.noUsername') : entry.username}
              </span>

              <span className="passwords__secret">{shownPassword ?? MASK}</span>
              <button
                type="button"
                className="passwords__action"
                aria-label={shown ? t('passwords.hide') : t('passwords.reveal', { site: entry.origin })}
                onClick={() => (shown ? setRevealed(null) : reveal(entry))}
              >
                {shown ? t('passwords.hide') : t('passwords.reveal', { site: entry.origin })}
              </button>

              <span className="passwords__meta">
                {entry.lastUsedAt === null
                  ? t('passwords.neverUsed')
                  : t('passwords.lastUsed', { time: timeFormat.format(entry.lastUsedAt) })}
                {!originMayReceiveCredentials(entry.origin) && ` · ${t('passwords.notFilled')}`}
              </span>

              {editing === entry.id ? (
                <span className="passwords__edit">
                  <input
                    type="password"
                    aria-label={t('passwords.newPassword')}
                    value={draftPassword}
                    onChange={(event) => setDraftPassword(event.target.value)}
                  />
                  <button type="button" onClick={() => saveEdit(entry)}>
                    {t('passwords.saveChanges')}
                  </button>
                  <button type="button" onClick={() => setEditing(null)}>
                    {t('passwords.cancel')}
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="passwords__action"
                  aria-label={t('passwords.editTitle', { site: entry.origin })}
                  onClick={() => {
                    setEditing(entry.id)
                    setDraftPassword('')
                  }}
                >
                  {t('passwords.edit')}
                </button>
              )}

              <button
                type="button"
                className="passwords__action passwords__action--danger"
                aria-label={t('passwords.remove', { site: entry.origin })}
                onClick={() => remove(entry)}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>

      <section className="passwords__never">
        <h2 className="passwords__groupTitle">{t('passwords.neverSavedTitle')}</h2>
        {neverSaved.length === 0 ? (
          <p className="passwords__empty">{t('passwords.neverSavedEmpty')}</p>
        ) : (
          <ul className="passwords__list">
            {neverSaved.map((origin) => (
              <li className="passwords__neverEntry" key={origin}>
                <span className="passwords__site">{origin}</span>
                <button
                  type="button"
                  className="passwords__action"
                  aria-label={t('passwords.forgetNeverSaved', { site: origin })}
                  onClick={() => forgetNeverSaved(origin)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        The bound the reveal above is held to, said out loud.

        A user who does not know a password will vanish in half a minute reads the disappearance as a
        fault. The number comes from the same constant the reducer enforces, so the sentence cannot
        drift from the behaviour.
      */}
      <p className="passwords__footnote">
        {t('passwords.revealNotice', { seconds: Math.round(REVEAL_TIMEOUT_MS / 1000) })}
      </p>
    </main>
  )
}
