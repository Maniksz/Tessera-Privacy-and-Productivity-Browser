import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { MessageKey } from '@shared/i18n/catalog.js'
import type {
  BackupStatus,
  CreateBackupOutcome,
  OpenRestoreOutcome,
  StageRestoreRequest
} from '@shared/backup/model.js'
import { BackupSection, type BackupHost } from '@renderer-internal/BackupSection.js'

/**
 * „Sichern und Wiederherstellen" (U23): what the page lets a person send, and what it starts ticked.
 *
 * The core refuses a short passphrase and stages only what it is told; these hold the page to the
 * other half — the passphrase typed twice (Q2), and permissions, filter rules and changed security
 * settings unticked until somebody ticks them (R38).
 */

const t = (key: MessageKey, params?: Record<string, string | number>): string =>
  params === undefined ? key : `${key}:${Object.values(params).join(',')}`

const LONG = 'twelve chars or more'

interface Recorded {
  created: string[]
  opened: string[]
  staged: StageRestoreRequest[]
}

function host(
  overrides: {
    status?: BackupStatus
    create?: CreateBackupOutcome
    open?: OpenRestoreOutcome
  } = {}
): { host: BackupHost; recorded: Recorded } {
  const recorded: Recorded = { created: [], opened: [], staged: [] }
  return {
    recorded,
    host: {
      status: () =>
        Promise.resolve(overrides.status ?? { vault: 'no-vault', pendingRestore: false }),
      create: (passphrase) => {
        recorded.created.push(passphrase)
        return Promise.resolve(overrides.create ?? { outcome: 'saved', vault: 'no-vault' })
      },
      openRestore: (passphrase) => {
        recorded.opened.push(passphrase)
        return Promise.resolve(overrides.open ?? { outcome: 'cancelled' })
      },
      stage: (request) => {
        recorded.staged.push(request)
        return Promise.resolve({ outcome: 'staged' })
      },
      t
    }
  }
}

afterEach(cleanup)

describe('making a backup', () => {
  it('asks for the passphrase twice, at least twelve characters, and says it cannot be recovered', async () => {
    const { host: backup, recorded } = host()
    render(<BackupSection host={backup} />)
    expect(screen.getByText('backup.hint')).toBeTruthy()
    const button = screen.getByRole('button', { name: 'backup.create' })
    const [first, second] = [
      screen.getByLabelText('backup.passphrase'),
      screen.getByLabelText('backup.repeat')
    ]
    fireEvent.change(first, { target: { value: 'too short' } })
    fireEvent.change(second, { target: { value: 'too short' } })
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(first, { target: { value: LONG } })
    fireEvent.change(second, { target: { value: `${LONG}!` } })
    expect(screen.getByText('backup.mismatch')).toBeTruthy()
    expect((button as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(second, { target: { value: LONG } })
    fireEvent.click(button)
    await waitFor(() => expect(screen.getByText('backup.saved')).toBeTruthy())
    expect(recorded.created).toEqual([LONG])
  })

  it('says what becomes of the vault, and that a restore is waiting', async () => {
    const { host: backup } = host({ status: { vault: 'no-master-password', pendingRestore: true } })
    render(<BackupSection host={backup} />)
    await waitFor(() => expect(screen.getByText('backup.vaultNoMasterPassword')).toBeTruthy())
    expect(screen.getByText('backup.pending')).toBeTruthy()
  })

  it('shows a refusal and a failure in words', async () => {
    for (const [outcome, text] of [
      [{ outcome: 'refused', reason: 'passphrase-too-short' }, 'backup.tooShort'],
      [{ outcome: 'failed' }, 'backup.failed']
    ] as const) {
      const { host: backup } = host({ create: outcome })
      render(<BackupSection host={backup} />)
      fireEvent.change(screen.getByLabelText('backup.passphrase'), { target: { value: LONG } })
      fireEvent.change(screen.getByLabelText('backup.repeat'), { target: { value: LONG } })
      fireEvent.click(screen.getByRole('button', { name: 'backup.create' }))
      await waitFor(() => expect(screen.getByText(text)).toBeTruthy())
      cleanup()
    }
  })
})

describe('restoring', () => {
  const preview: OpenRestoreOutcome = {
    outcome: 'preview',
    preview: {
      token: 'token-1',
      createdAt: 0,
      appVersion: '0.21.0-ALPHA',
      items: ['historyFile', 'permissionsFile', 'settingsFile', 'userRulesFile'],
      vault: 'no-master-password',
      settings: [{ key: 'network.proxyMode', label: 'Proxy', value: '"manual"' }]
    }
  }

  it('starts permissions, filter rules and security settings unticked, and sends what is ticked', async () => {
    const { host: backup, recorded } = host({ open: preview })
    render(<BackupSection host={backup} />)
    fireEvent.change(screen.getByLabelText('backup.restorePassphrase'), { target: { value: LONG } })
    fireEvent.click(screen.getByRole('button', { name: 'backup.restore' }))
    await waitFor(() => expect(screen.getByText('backup.securitySettings')).toBeTruthy())
    expect(screen.getByText('backup.vaultNoMasterPassword')).toBeTruthy()

    const box = (name: string): HTMLInputElement =>
      screen.getByRole('checkbox', { name: new RegExp(name) })
    expect(box('history.title').checked).toBe(true)
    expect(box('settings.title').checked).toBe(true)
    expect(box('settings.section.permissions').checked).toBe(false)
    expect(box('backup.userRules').checked).toBe(false)
    expect(box('Proxy').checked).toBe(false)

    fireEvent.click(box('history.title'))
    fireEvent.click(box('Proxy'))
    fireEvent.click(screen.getByRole('button', { name: 'backup.stage' }))
    await waitFor(() => expect(screen.getByText('backup.staged')).toBeTruthy())
    expect(recorded.staged).toEqual([
      { token: 'token-1', items: ['settingsFile'], settings: ['network.proxyMode'] }
    ])
  })

  it('names a wrong passphrase or damaged file, and keeps no preview', async () => {
    const { host: backup } = host({
      open: { outcome: 'refused', reason: 'wrong-passphrase-or-damaged' }
    })
    render(<BackupSection host={backup} />)
    fireEvent.change(screen.getByLabelText('backup.restorePassphrase'), { target: { value: LONG } })
    fireEvent.click(screen.getByRole('button', { name: 'backup.restore' }))
    await waitFor(() => expect(screen.getByText('backup.wrongPassphrase')).toBeTruthy())
    expect(screen.queryByText('backup.stage')).toBeNull()
  })

  it('lets the preview be put away without staging anything', async () => {
    const { host: backup, recorded } = host({ open: preview })
    render(<BackupSection host={backup} />)
    fireEvent.change(screen.getByLabelText('backup.restorePassphrase'), { target: { value: LONG } })
    fireEvent.click(screen.getByRole('button', { name: 'backup.restore' }))
    await waitFor(() => expect(screen.getByText('backup.stage')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: 'passwords.cancel' }))
    expect(screen.queryByText('backup.stage')).toBeNull()
    expect(recorded.staged).toEqual([])
  })
})
