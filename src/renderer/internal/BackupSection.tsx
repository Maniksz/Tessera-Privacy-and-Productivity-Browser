import { useEffect, useState } from 'react'
import type { MessageKey } from '@shared/i18n/catalog.js'
import {
  CONFIRMED_ITEMS,
  passphraseLongEnough,
  type BackupRefusal,
  type BackupStatus,
  type CreateBackupOutcome,
  type OpenRestoreOutcome,
  type RestoreItem,
  type RestorePreview,
  type StageRestoreOutcome,
  type StageRestoreRequest,
  type VaultInBackup
} from '@shared/backup/model.js'
import type { Translate } from '@renderer-shared/SettingsView.js'
import { useAsyncStatus } from './useAsyncStatus.js'

/**
 * „Sichern und Wiederherstellen" — the settings page's section for the encrypted backup (U23).
 *
 * The page asks and shows; the core decides. It sends a passphrase and, for a restore, the choice
 * made from a preview — never a path and never a document: the core opens the dialog, reads or writes
 * the file, and keeps the decrypted backup until the choice arrives.
 *
 * Twice the passphrase and a sentence that a forgotten one is lost (Q2). Permissions, filter rules
 * and every security-relevant setting that differs start unticked (R38), so taking over a proxy or a
 * site's camera answer from a file is something a person does, not something a file does.
 */

export interface BackupHost {
  status(): Promise<BackupStatus>
  create(passphrase: string): Promise<CreateBackupOutcome>
  openRestore(passphrase: string): Promise<OpenRestoreOutcome>
  stage(request: StageRestoreRequest): Promise<StageRestoreOutcome>
  t: Translate
}

const ITEM_LABELS: Readonly<Record<RestoreItem, MessageKey>> = {
  historyFile: 'history.title',
  permissionsFile: 'settings.section.permissions',
  bookmarksFile: 'bookmarks.title',
  quickLinksFile: 'start.quickLinks',
  settingsFile: 'settings.title',
  userRulesFile: 'backup.userRules',
  workspacesFile: 'workspaces.title',
  vault: 'passwords.title'
}

const VAULT_NOTES: Readonly<Record<VaultInBackup, MessageKey | null>> = {
  included: 'backup.vaultIncluded',
  'no-master-password': 'backup.vaultNoMasterPassword',
  unreadable: 'backup.vaultUnreadable',
  'no-vault': null
}

const REFUSALS: Readonly<Record<BackupRefusal, MessageKey>> = {
  'not-a-backup': 'backup.notABackup',
  'too-large': 'backup.tooLarge',
  'wrong-passphrase-or-damaged': 'backup.wrongPassphrase',
  newer: 'backup.newer',
  'passphrase-too-short': 'backup.tooShort'
}

export function BackupSection({ host }: { host: BackupHost }): React.ReactNode {
  const { t } = host
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [repeat, setRepeat] = useState('')
  const [restorePassphrase, setRestorePassphrase] = useState('')
  const [preview, setPreview] = useState<RestorePreview | null>(null)
  const [items, setItems] = useState<ReadonlySet<RestoreItem>>(new Set())
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set())

  const refresh = (): void => {
    void host.status().then(setStatus)
  }
  useEffect(refresh, [host])

  const { busy, message, run } = useAsyncStatus(t, refresh)

  const create = (): void => {
    run(async () => {
      const outcome = await host.create(passphrase)
      if (outcome.outcome === 'cancelled') return null
      if (outcome.outcome === 'refused') return t(REFUSALS[outcome.reason])
      if (outcome.outcome === 'failed') return t('backup.failed')
      setPassphrase('')
      setRepeat('')
      return t('backup.saved')
    })
  }

  const open = (): void => {
    run(async () => {
      const outcome = await host.openRestore(restorePassphrase)
      if (outcome.outcome === 'cancelled') return null
      if (outcome.outcome === 'refused') return t(REFUSALS[outcome.reason])
      if (outcome.outcome === 'failed') return t('backup.failed')
      setRestorePassphrase('')
      setPreview(outcome.preview)
      setItems(new Set(outcome.preview.items.filter((item) => !CONFIRMED_ITEMS.includes(item))))
      setConfirmed(new Set())
      return null
    })
  }

  const stage = (chosen: RestorePreview): void => {
    run(async () => {
      const outcome = await host.stage({
        token: chosen.token,
        items: [...items],
        settings: [...confirmed]
      })
      setPreview(null)
      return t(outcome.outcome === 'staged' ? 'backup.staged' : 'backup.failed')
    })
  }

  const toggle = <T,>(set: ReadonlySet<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  const mismatch = repeat !== '' && repeat !== passphrase
  const canCreate = passphraseLongEnough(passphrase) && repeat === passphrase && !busy
  const vaultNote = status === null ? null : VAULT_NOTES[status.vault]

  return (
    <section className="panel__section" aria-labelledby="backup-heading">
      <h3 className="panel__sectionTitle" id="backup-heading">
        {t('backup.title')}
      </h3>
      {status?.pendingRestore === true && <p className="panel__notice">{t('backup.pending')}</p>}

      <div className="field">
        <div className="field__text-block">
          <label className="field__label" htmlFor="backup-passphrase">
            {t('backup.passphrase')}
          </label>
          <p className="field__description" id="backup-hint">
            {t('backup.hint')}
          </p>
          {vaultNote !== null && <p className="field__description">{t(vaultNote)}</p>}
        </div>
        <div className="field__control backup__inputs">
          <input
            id="backup-passphrase"
            className="field__text"
            type="password"
            autoComplete="new-password"
            aria-describedby="backup-hint"
            value={passphrase}
            onChange={(event) => setPassphrase(event.currentTarget.value)}
          />
          <input
            className="field__text"
            type="password"
            autoComplete="new-password"
            aria-label={t('backup.repeat')}
            placeholder={t('backup.repeat')}
            aria-invalid={mismatch}
            value={repeat}
            onChange={(event) => setRepeat(event.currentTarget.value)}
          />
          {mismatch && <span className="field__note">{t('backup.mismatch')}</span>}
          <button type="button" className="dialog__button" disabled={!canCreate} onClick={create}>
            {t('backup.create')}
          </button>
        </div>
      </div>

      <div className="field">
        <div className="field__text-block">
          <label className="field__label" htmlFor="backup-restore-passphrase">
            {t('backup.restorePassphrase')}
          </label>
        </div>
        <div className="field__control backup__inputs">
          <input
            id="backup-restore-passphrase"
            className="field__text"
            type="password"
            autoComplete="off"
            value={restorePassphrase}
            onChange={(event) => setRestorePassphrase(event.currentTarget.value)}
          />
          <button
            type="button"
            className="dialog__button"
            disabled={busy || !passphraseLongEnough(restorePassphrase)}
            onClick={open}
          >
            {t('backup.restore')}
          </button>
        </div>
      </div>

      {message !== null && (
        <p className="panel__notice" role="status">
          {message}
        </p>
      )}

      {preview !== null && (
        <fieldset className="backup__preview">
          <legend>
            {t('backup.from', {
              date: new Date(preview.createdAt).toLocaleString(),
              version: preview.appVersion
            })}
          </legend>
          <p className="field__description">{t('backup.confirm')}</p>
          {VAULT_NOTES[preview.vault] !== null && preview.vault !== 'included' && (
            <p className="field__description">{t(VAULT_NOTES[preview.vault]!)}</p>
          )}
          {preview.items.map((item) => (
            <label className="backup__choice" key={item}>
              <input
                type="checkbox"
                checked={items.has(item)}
                onChange={() => setItems(toggle(items, item))}
              />
              {t(ITEM_LABELS[item])}
            </label>
          ))}
          {preview.settings.length > 0 && items.has('settingsFile') && (
            <>
              <p className="field__label">{t('backup.securitySettings')}</p>
              {preview.settings.map((setting) => (
                <label className="backup__choice" key={setting.key}>
                  <input
                    type="checkbox"
                    checked={confirmed.has(setting.key)}
                    onChange={() => setConfirmed(toggle(confirmed, setting.key))}
                  />
                  {setting.label} <code className="field__key">{setting.value}</code>
                </label>
              ))}
            </>
          )}
          <div className="panel__lead">
            <button
              type="button"
              className="dialog__button dialog__button--primary"
              disabled={busy || items.size === 0}
              onClick={() => stage(preview)}
            >
              {t('backup.stage')}
            </button>
            <button type="button" className="dialog__button" onClick={() => setPreview(null)}>
              {t('passwords.cancel')}
            </button>
          </div>
        </fieldset>
      )}
    </section>
  )
}
