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
import {
  RESET_VAULT_CONFIRMATION,
  vaultHasMasterPassword,
  type VaultKeyProtection,
  type VaultStatus
} from '@shared/passwords/vault.js'
import type { CsvRefusal, ChromeImportResult } from '@shared/passwords/chrome-import.js'
import { totalSkipped } from '@shared/passwords/chrome-import.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { bridgeAvailable, invoke } from './bridge.js'
import { useInternalI18n } from './useInternalI18n.js'

/**
 * `tessera://passwords`.
 *
 * ## Why a list of credentials is drawn this way
 *
 * A saved-password list is itself a secret, and an unlocked passwords tab left open on a desk is —
 * in most browsers' design — the whole vault. `shared/passwords/reveal.ts` carries the full argument.
 * What this page does with it:
 *
 *   1. **It is never sent the passwords.** `passwords:list` answers with origins, usernames and
 *      timestamps. There is no call on this page's allowlist that returns more than one secret.
 *   2. **Revealing is one at a time**, fetched by id when the user asks for it, and the reducer in
 *      `reveal.ts` makes two-revealed-at-once unrepresentable rather than merely unlikely.
 *   3. **A revealed password is dropped** after half a minute and immediately when the document stops
 *      being visible — another tab, a minimised window, a locked screen.
 *
 * So the worst case for a forgotten tab is a list of sites and names, plus one password for thirty
 * seconds — and with a master password set, only for as long as the vault is open.
 *
 * ## The one thing this page cannot do, and it is the important one
 *
 * **It cannot ask for the master password.** There is no field for it here and no channel that would
 * accept one. `passwords:requestUnlock` sends nothing: the core raises a prompt on the overlay layer,
 * reads the keystrokes in the main process, and answers with one of four words.
 *
 * That is not tidiness. The address bar is the only thing distinguishing this page from a website
 * imitating it, exactly as for every internal page in every browser — so a design where *this* page
 * could ask for the master password is a design where the imitation could too, and the master
 * password is the one secret whose loss costs all the others. Moving the field into browser chrome a
 * page cannot draw is the only version of this that a lookalike cannot copy.
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
 * An internal page rendered as content: the per-page allowlist grants twelve password channels and
 * `i18n:getCatalog`, and nothing else. It cannot read a setting, touch a tab, or reach the window —
 * and it cannot answer the master-password prompt it asks for.
 */

/** What a concealed password looks like. Not text, so it needs no translation. */
const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'

/** How often the countdown is re-checked. A second is enough for a thirty-second bound. */
const TICK_MS = 1000

/**
 * One sentence per protection level, keyed by the level itself.
 *
 * A table rather than a template, because the key names are not the union members: `keystore+master` is not a
 * legal identifier. Written out so a level added to `VaultKeyProtection` without a sentence here is a compile
 * error rather than a blank paragraph on the page that explains the guarantee.
 */
const PROTECTION_MESSAGES: Readonly<Record<VaultKeyProtection, MessageKey>> = {
  'keystore+master': 'passwords.protection.keystoreMaster',
  master: 'passwords.protection.master',
  keystore: 'passwords.protection.keystore',
  plain: 'passwords.protection.plain'
}

/**
 * Why a whole file was refused, per reason.
 *
 * Total over `CsvRefusal`, so a reason added to the parser without a sentence here is a compile error. The
 * alternative is the screen somebody reads once, after moving every credential they own, showing nothing.
 */
const IMPORT_REFUSALS: Readonly<Record<CsvRefusal, MessageKey>> = {
  empty: 'passwords.importRefusedEmpty',
  'unknown-columns': 'passwords.importRefusedColumns',
  'too-large': 'passwords.importRefusedTooLarge',
  'too-many-rows': 'passwords.importRefusedTooManyRows'
}

/** What the lock is doing, so a slow derivation is not read as a dead button. */
type Busy = 'unlock' | 'lock' | 'master' | 'import' | 'reset' | null

interface Revealed {
  readonly state: RevealState
  readonly password: string
}

export function PasswordsPage(): React.ReactNode {
  const { locale, t } = useInternalI18n()

  const [credentials, setCredentials] = useState<PasswordSummary[]>([])
  const [neverSaved, setNeverSaved] = useState<string[]>([])
  /*
    The whole `VaultStatus`, not only its protection level.

    Starting from the weakest and *locked* is deliberate in both halves. A page about credentials must not
    claim a guarantee it has not been told it has; and drawing the unlocked view before the first answer
    arrives would flash an empty list at somebody whose vault is merely closed, which reads as "they are
    gone".
  */
  const [vault, setVault] = useState<VaultStatus>({
    protection: 'plain',
    unlocked: false,
    unreadable: false,
    idleTimeoutMs: 0
  })
  const [busy, setBusy] = useState<Busy>(null)
  const [importReport, setImportReport] = useState<ChromeImportResult | null>(null)
  const [importedFile, setImportedFile] = useState<string | null>(null)
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
    const answer = await invoke('passwords:list')
    setCredentials(answer.credentials)
    setNeverSaved(answer.neverSaved)
    setVault(answer.vault)
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!bridgeAvailable()) {
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
      const answer = await invoke('passwords:reveal', { id: entry.id })
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
      const answer = await invoke('passwords:remove', { id: entry.id })
      if (answer.removed) setNotice(t('passwords.removed'))
      setRevealed(null)
      await refresh()
    })
  }

  const saveEdit = (entry: PasswordSummary): void => {
    void run(async () => {
      await invoke('passwords:update', { id: entry.id, password: draftPassword })
      setEditing(null)
      setDraftPassword('')
      setRevealed(null)
      setNotice(t('passwords.updated'))
      await refresh()
    })
  }

  const add = (): void => {
    void run(async () => {
      const answer = await invoke('passwords:create', {
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
      await invoke('passwords:forgetNeverSaved', { origin })
      await refresh()
    })
  }

  // --- the lock ---------------------------------------------------------------

  /**
   * Asks the core to raise the prompt, and waits.
   *
   * There is no field here and nothing is sent. What comes back is one of four words, and the promise
   * stays pending while somebody is being asked — which can be a minute if they walk away, so the button
   * says it is working. `cancelled` says nothing at all: the person closed the prompt, and telling them so
   * would be the browser reporting their own action back to them.
   */
  const requestUnlock = (): void => {
    void run(async () => {
      setBusy('unlock')
      try {
        const answer = await invoke('passwords:requestUnlock')
        setVault(answer.vault)
        if (answer.outcome === 'wrong-password') setNotice(t('passwords.unlockFailed'))
        if (answer.outcome === 'unlocked') await refresh()
      } finally {
        setBusy(null)
      }
    })
  }

  const lockNow = (): void => {
    void run(async () => {
      setBusy('lock')
      try {
        const answer = await invoke('passwords:lock')
        setVault(answer.vault)
        // The revealed password goes with the key. Leaving it on screen after locking would make the
        // button a claim the page had not honoured.
        setRevealed(null)
        await refresh()
      } finally {
        setBusy(null)
      }
    })
  }

  /**
   * Starts a master-password sequence.
   *
   * The intent only. Which questions get asked is the core's decision, derived from the vault as it
   * actually is — see `MasterPasswordPrompt.requestMasterPassword`, which turns "set" on a vault that
   * already has one into "change" so that the existing password still has to be proved.
   */
  const masterPassword = (intent: 'set' | 'change' | 'remove'): void => {
    void run(async () => {
      setBusy('master')
      try {
        const answer = await invoke('passwords:beginSetMasterPassword', { intent })
        setVault(answer.vault)
        if (answer.outcome === 'set') setNotice(t('passwords.masterPasswordSet'))
        if (answer.outcome === 'changed') setNotice(t('passwords.masterPasswordChanged'))
        if (answer.outcome === 'removed') setNotice(t('passwords.masterPasswordRemoved'))
        if (answer.outcome === 'wrong-password') setNotice(t('passwords.unlockFailed'))
      } finally {
        setBusy(null)
      }
    })
  }

  /**
   * Imports an exported CSV.
   *
   * No file input, deliberately: the core opens the chooser and reads the file. A `<input type="file">`
   * here would have put an entire exported vault — every password the user has ever had, in clear text —
   * into one IPC message and into this renderer's heap, which is the one thing this page is built not to
   * hold. See `shared/passwords/api.ts`.
   */
  const importFile = (): void => {
    void run(async () => {
      setBusy('import')
      try {
        const answer = await invoke('passwords:import')
        setVault(answer.vault)
        // Cancelling is an answer and not a failure, so it says nothing at all.
        if (answer.outcome === 'cancelled') return
        if (answer.outcome === 'unreadable') {
          setNotice(t('passwords.importUnreadable'))
          return
        }
        if (answer.outcome === 'locked') {
          setNotice(t('passwords.importLocked'))
          return
        }
        setImportReport(answer.report ?? null)
        setImportedFile(answer.filePath ?? null)
        await refresh()
      } finally {
        setBusy(null)
      }
    })
  }

  /**
   * Destroys the vault, and does not ask the confirming question itself.
   *
   * The sentence about keeping a copy is asked by the *core*, in a native dialogue, because that is where
   * the file chooser is and because the choice must be made at the moment of no return rather than two
   * clicks earlier. So this page asks only "are you sure", and the core asks "shall I keep a copy first".
   *
   * `copy: 'failed'` comes back with `reset: false`: nothing was deleted, because discarding a vault right
   * after failing to save it is the outcome the offer exists to prevent. The page says so rather than
   * reporting a success it did not get.
   */
  const resetVault = (): void => {
    if (!globalThis.confirm(t('passwords.resetVault'))) return
    void run(async () => {
      setBusy('reset')
      try {
        const answer = await invoke('passwords:resetVault', {
          confirmation: RESET_VAULT_CONFIRMATION
        })
        setVault(answer.vault)
        if (answer.copy === 'failed') {
          setNotice(t('passwords.unreadableBody'))
          return
        }
        if (answer.reset) {
          setRevealed(null)
          setNotice(t('passwords.resetVaultDone'))
          await refresh()
        }
      } finally {
        setBusy(null)
      }
    })
  }

  const hasMaster = vaultHasMasterPassword(vault.protection)
  const idleMinutes = Math.round(vault.idleTimeoutMs / 60_000)

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
        {t(PROTECTION_MESSAGES[vault.protection])}
      </p>

      {notice !== null && (
        <p className="passwords__notice" role="status">
          {notice}
        </p>
      )}

      {/*
        The vault, and what can be done to it. Above the list, because when the vault is closed there is
        no list and this is the only thing on the page that leads anywhere.
      */}
      <section className="passwords__vault">
        <h2 className="passwords__groupTitle">{t('passwords.masterPasswordTitle')}</h2>

        {/*
          Unreadable is its own state and must not offer a password field.

          `unlocked: false` means "type your master password"; this means "no master password will help,
          and nothing here will silently overwrite your vault to make the browser start". A single boolean
          would have made the page ask for something that cannot work. See `VaultStatus.unreadable`.
        */}
        {vault.unreadable ? (
          <>
            <h3 className="passwords__lockTitle">{t('passwords.unreadableTitle')}</h3>
            <p className="passwords__lockBody">{t('passwords.unreadableBody')}</p>
          </>
        ) : (
          !vault.unlocked && (
            <>
              <h3 className="passwords__lockTitle">{t('passwords.lockedTitle')}</h3>
              <p className="passwords__lockBody">{t('passwords.idleNotice', { minutes: idleMinutes })}</p>
              <button
                type="button"
                className="passwords__primary"
                disabled={busy !== null}
                onClick={requestUnlock}
              >
                {t('passwords.unlock')}
              </button>
            </>
          )
        )}

        <div className="passwords__vaultActions">
          {/*
            Locking is offered only when there is something to lock back to.

            A vault with no master password reopens without asking anybody, so a lock button on it would
            close the vault and then silently reopen it — a control that appears to do something and does
            nothing. `PasswordVault.sweepIdle` refuses to idle-lock such a vault for the same reason.
          */}
          {vault.unlocked && hasMaster && (
            <button type="button" disabled={busy !== null} onClick={lockNow}>
              {t('passwords.lockNow')}
            </button>
          )}
          {vault.unlocked && !hasMaster && (
            <button type="button" disabled={busy !== null} onClick={() => masterPassword('set')}>
              {t('passwords.setMasterPassword')}
            </button>
          )}
          {vault.unlocked && hasMaster && (
            <>
              <button type="button" disabled={busy !== null} onClick={() => masterPassword('change')}>
                {t('passwords.changeMasterPassword')}
              </button>
              <button type="button" disabled={busy !== null} onClick={() => masterPassword('remove')}>
                {t('passwords.removeMasterPassword')}
              </button>
            </>
          )}
          {vault.unlocked && (
            <button type="button" disabled={busy !== null} onClick={importFile}>
              {t('passwords.import')}
            </button>
          )}
          {/*
            Offered even while locked, and especially then: a forgotten master password is the only reason
            anybody wants this, and it is exactly the state in which nothing else on this page works.
          */}
          <button
            type="button"
            className="passwords__action--danger"
            disabled={busy !== null}
            onClick={resetVault}
          >
            {t('passwords.resetVault')}
          </button>
        </div>

        {importReport !== null && (
          <div className="passwords__importReport" role="status">
            {/* A file refused whole has no counts worth printing, so it prints the reason instead. */}
            {importReport.refusal !== null ? (
              <p>{t(IMPORT_REFUSALS[importReport.refusal])}</p>
            ) : (
              <>
                <p>
                  {t('passwords.importSummary', {
                    imported: importReport.imported,
                    skipped: totalSkipped(importReport.skipped)
                  })}
                </p>
                {importReport.duplicatesIdentical > 0 && (
                  <p>{t('passwords.importDuplicates', { count: importReport.duplicatesIdentical })}</p>
                )}
                {/*
                  The only line in the report worth acting on, so the colliding accounts are named — origins
                  and usernames, never a password. See `main/passwords/import.ts` for why the stored one wins.
                */}
                {importReport.duplicatesConflicting > 0 && (
                  <>
                    <p>
                      {t('passwords.importConflicts', {
                        count: importReport.duplicatesConflicting
                      })}
                    </p>
                    <ul className="passwords__list">
                      {importReport.conflicts.map((conflict) => (
                        <li key={`${conflict.origin} ${conflict.username}`}>
                          {conflict.origin} · {conflict.username}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
                {importReport.full > 0 && (
                  <p>{t('passwords.importFull', { count: importReport.full })}</p>
                )}
                {importReport.notesDropped > 0 && (
                  <p>{t('passwords.importNotesDropped', { count: importReport.notesDropped })}</p>
                )}
              </>
            )}
            {/*
              The largest exposure this whole feature creates, named.

              It is not in the vault: it is the plain-text CSV of every password the user owns, now sitting
              in their downloads folder. This browser will not delete somebody else's file behind their
              back, so the honest alternative is to say where it is and what is in it.
            */}
            {importedFile !== null && (
              <p className="passwords__warning">
                {t('passwords.importDeleteFile', { path: importedFile })}
              </p>
            )}
          </div>
        )}
      </section>

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
