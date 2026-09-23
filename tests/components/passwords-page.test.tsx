import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PasswordsPage } from '@renderer-internal/PasswordsPage.js'
import { catalogs } from '@shared/i18n/catalog.js'
import type { PasswordSummary } from '@shared/passwords/model.js'
import type { VaultStatus } from '@shared/passwords/vault.js'
import type { OwnBrowserInternalBridge } from '../../src/preload/internal-api.js'

/**
 * What the passwords page says about a vault document that did not load cleanly (R3, AE2).
 *
 * The core decides and the page only reports, so the bridge answers with a `VaultStatus` and the
 * assertions are on the sentences a user reads — in German, because the catalogue the core sends is
 * what the page draws, and the German count sentence is the one the plan names.
 */

function setBridge(bridge: OwnBrowserInternalBridge | undefined): void {
  Object.defineProperty(window, 'tesseraInternal', {
    value: bridge,
    configurable: true,
    writable: true
  })
}

const alice: PasswordSummary = {
  id: 'pw-1',
  origin: 'https://example.com',
  username: 'alice',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null
}

function installBridge(document: Partial<VaultStatus>): void {
  const vault: VaultStatus = {
    protection: 'keystore',
    unlocked: true,
    unreadable: false,
    idleTimeoutMs: 600_000,
    ...document
  }
  const bridge = {
    invoke: (channel: string): Promise<unknown> => {
      switch (channel) {
        case 'i18n:getCatalog':
          return Promise.resolve({ locale: 'de', messages: catalogs.de })
        case 'passwords:list':
          return Promise.resolve({ credentials: [alice], neverSaved: [], vault })
        default:
          return Promise.reject(new Error(`unexpected channel ${channel}`))
      }
    },
    on: () => () => {},
    channels: { invoke: [], event: [] }
  }
  setBridge(bridge as unknown as OwnBrowserInternalBridge)
}

async function rendered(document: Partial<VaultStatus>): Promise<void> {
  installBridge(document)
  render(<PasswordsPage />)
  await waitFor(() => expect(screen.getByText('alice')).toBeTruthy())
}

afterEach(() => {
  cleanup()
  setBridge(undefined)
})

describe('entries the vault could not read', () => {
  it('counts one in the singular', async () => {
    await rendered({ unreadableEntries: 1 })
    expect(screen.getByText(/^1 Eintrag konnte nicht gelesen werden/)).toBeTruthy()
  })

  it('counts several in the plural', async () => {
    await rendered({ unreadableEntries: 3 })
    expect(screen.getByText(/^3 Einträge konnten nicht gelesen werden/)).toBeTruthy()
  })

  it('says nothing when every entry was readable', async () => {
    await rendered({})
    expect(screen.queryByText(/nicht gelesen werden/)).toBeNull()
    expect(screen.queryByText(/neuere Version/)).toBeNull()
    expect(screen.queryByText(/nicht sichern/)).toBeNull()
  })
})

describe('a vault document this version cannot write back', () => {
  it('says a newer version wrote it, and not that a backup failed', async () => {
    await rendered({ newer: true, readOnly: true })
    expect(screen.getByText(/neuere Version/)).toBeTruthy()
    expect(screen.queryByText(/nicht sichern/)).toBeNull()
  })

  it('names the copy of a document it could not use', async () => {
    await rendered({ invalid: true })
    expect(screen.getByText(/passwords\.json\.unreadable/)).toBeTruthy()
  })

  it('does not claim a copy that could not be made', async () => {
    await rendered({ invalid: true, readOnly: true })
    expect(screen.queryByText(/passwords\.json\.unreadable/)).toBeNull()
    expect(screen.getByText(/nicht sichern/)).toBeTruthy()
  })
})
