import { describe, expect, it } from 'vitest'
import { DOWNLOAD_STATES, type DownloadRecord } from '@shared/downloads/model.js'
import {
  BYTE_UNITS,
  DOWNLOAD_STATE_LABELS,
  byteSize,
  downloadNumberFormat,
  downloadProgressText,
  downloadSizeText,
  type DownloadTranslate
} from '@shared/downloads/presentation.js'
import { translate, type Locale } from '@shared/i18n/catalog.js'

/**
 * Byte counts as a person reads them.
 *
 * Total on purpose: the number comes from a remote server by way of Chromium, so a negative,
 * fractional or absent one must produce a row rather than an exception.
 */

describe('byteSize', () => {
  it('uses decimal units, like every file manager and the build log', () => {
    expect(byteSize(999)).toEqual({ value: 999, unit: 'B' })
    expect(byteSize(1000)).toEqual({ value: 1, unit: 'kB' })
    expect(byteSize(1_500_000)).toEqual({ value: 1.5, unit: 'MB' })
  })

  it('shows three significant figures, as a file manager does', () => {
    expect(byteSize(1_234_567)).toEqual({ value: 1.2, unit: 'MB' })
    expect(byteSize(234_000_000)).toEqual({ value: 234, unit: 'MB' })
  })

  it('reports whole bytes below a kilobyte', () => {
    // `1.5 B` is not a thing, and a fractional count can only come from a bad header.
    expect(byteSize(1.5)).toEqual({ value: 1, unit: 'B' })
  })

  it('stops at the largest unit rather than running off the end', () => {
    // A number past a terabyte must be reported in terabytes, not in `undefined`.
    const enormous = byteSize(5 * 1000 ** 5)
    expect(enormous.unit).toBe(BYTE_UNITS[BYTE_UNITS.length - 1])
    expect(enormous.value).toBe(5000)
  })

  it('answers zero for every number that is not one', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(byteSize(bad), String(bad)).toEqual({ value: 0, unit: 'B' })
    }
  })
})

/**
 * The words the downloads page shows for a row, pinned before they moved out of the page.
 *
 * The expected strings are what `DownloadsPage` produced when the state map and the size and
 * progress text were still local to it — so these tests are what "the page shows the same
 * after the move" rests on, and they are also the contract the toolbar panel inherits. The
 * translator is the bundled catalogue's, whose `downloads.*` entries are word for word the
 * page's staged copy; any translator the page or the chrome UI holds is accepted, because
 * only the keys named in `DownloadTextKey` are ever asked for.
 */

function translatorFor(locale: Locale): DownloadTranslate {
  return (key, params) => translate(locale, key, params)
}

function record(overrides: Partial<DownloadRecord>): DownloadRecord {
  return {
    id: 'd1',
    url: 'https://example.com/file.zip',
    fileName: 'file.zip',
    savePath: '/downloads/file.zip',
    mimeType: 'application/zip',
    totalBytes: 0,
    receivedBytes: 0,
    state: 'progressing',
    startedAt: 1_000,
    endedAt: null,
    interruptReason: '',
    ...overrides
  }
}

describe('DOWNLOAD_STATE_LABELS', () => {
  it('names every state with the key the page has always used', () => {
    expect(DOWNLOAD_STATE_LABELS).toEqual({
      progressing: 'downloads.state.progressing',
      paused: 'downloads.state.paused',
      completed: 'downloads.state.completed',
      cancelled: 'downloads.state.cancelled',
      interrupted: 'downloads.state.interrupted'
    })
    expect(Object.keys(DOWNLOAD_STATE_LABELS).sort()).toEqual([...DOWNLOAD_STATES].sort())
  })

  it('reads as the words the page shows', () => {
    const en = DOWNLOAD_STATES.map((state) => translate('en', DOWNLOAD_STATE_LABELS[state]))
    expect(en).toEqual(['Downloading', 'Paused', 'Finished', 'Cancelled', 'Failed'])
    const de = DOWNLOAD_STATES.map((state) => translate('de', DOWNLOAD_STATE_LABELS[state]))
    expect(de).toEqual(['Wird geladen', 'Angehalten', 'Fertig', 'Abgebrochen', 'Fehlgeschlagen'])
  })
})

describe('downloadSizeText', () => {
  it('formats the number for the locale and appends the unit', () => {
    expect(downloadSizeText(1_234_567, translatorFor('en'), downloadNumberFormat('en'))).toBe(
      '1.2 MB'
    )
    expect(downloadSizeText(1_234_567, translatorFor('de'), downloadNumberFormat('de'))).toBe(
      '1,2 MB'
    )
  })

  it('groups thousands the way the locale does, past the largest unit', () => {
    expect(downloadSizeText(5 * 1000 ** 5, translatorFor('en'), downloadNumberFormat('en'))).toBe(
      '5,000 TB'
    )
    expect(downloadSizeText(5 * 1000 ** 5, translatorFor('de'), downloadNumberFormat('de'))).toBe(
      '5.000 TB'
    )
  })

  it('shows whole units without a trailing decimal', () => {
    expect(downloadSizeText(5_000_000, translatorFor('en'), downloadNumberFormat('en'))).toBe(
      '5 MB'
    )
    expect(downloadSizeText(0, translatorFor('en'), downloadNumberFormat('en'))).toBe('0 B')
  })
})

describe('downloadProgressText', () => {
  it('says how much of how much when the total is known', () => {
    const known = record({ receivedBytes: 1_234_567, totalBytes: 5_000_000 })
    expect(downloadProgressText(known, translatorFor('en'), downloadNumberFormat('en'))).toBe(
      '1.2 MB of 5 MB'
    )
    expect(downloadProgressText(known, translatorFor('de'), downloadNumberFormat('de'))).toBe(
      '1,2 MB von 5 MB'
    )
  })

  it('says only how much when the server declared no length', () => {
    const unknown = record({ receivedBytes: 1_500, totalBytes: 0 })
    expect(downloadProgressText(unknown, translatorFor('en'), downloadNumberFormat('en'))).toBe(
      '1.5 kB downloaded'
    )
    expect(downloadProgressText(unknown, translatorFor('de'), downloadNumberFormat('de'))).toBe(
      '1,5 kB geladen'
    )
  })
})
