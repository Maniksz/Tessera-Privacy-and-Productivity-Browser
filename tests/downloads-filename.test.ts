import { describe, expect, it } from 'vitest'
import {
  FALLBACK_DOWNLOAD_FILE_NAME,
  MAX_DOWNLOAD_FILE_NAME_LENGTH,
  downloadFileNameFor,
  parseContentDispositionFilename,
  safeDownloadFileName
} from '@shared/downloads/filename.js'

/**
 * A name chosen by a remote server, turned into a name this machine may write.
 *
 * This is the most security-relevant file in the download feature: everything else can fail
 * and cost the download, this can fail and cost a file outside the downloads directory. So the
 * tests are written as the attacks they defend against, each named for what it would achieve.
 */

/** No result may ever contain a path separator or resolve to a traversal. */
function expectSafe(name: string): void {
  expect(name).not.toContain('/')
  expect(name).not.toContain('\\')
  expect(name).not.toBe('.')
  expect(name).not.toBe('..')
  expect(name.startsWith('.')).toBe(false)
  expect(name.length).toBeGreaterThan(0)
  expect(name.length).toBeLessThanOrEqual(MAX_DOWNLOAD_FILE_NAME_LENGTH)
}

describe('a hostile Content-Disposition filename', () => {
  it('cannot traverse out of the downloads directory', () => {
    /*
      The case to be total about: `Content-Disposition: attachment; filename="../../.bashrc"`.

      Joined naively onto the downloads directory that writes to the user's home. Only the last
      path segment can ever be a filename, so the traversal is removed structurally rather than
      by hunting for the string `..`.
    */
    const name = downloadFileNameFor({
      contentDisposition: 'attachment; filename="../../.bashrc"'
    })
    expect(name).toBe('bashrc')
    expectSafe(name)
  })

  it('cannot traverse with backslashes either, on any platform', () => {
    /*
      `..\..\evil.exe` traverses on Windows and is a legal *filename* on Linux.

      A Linux build that stripped only `/` would write a file literally called `..\..\evil.exe`,
      which traverses the moment that profile is opened on Windows or the file is copied there.
      The rule cannot be per-platform, because the data outlives the platform.
    */
    const name = downloadFileNameFor({
      contentDisposition: 'attachment; filename="..\\..\\Windows\\System32\\evil.exe"'
    })
    expect(name).toBe('evil.exe')
    expectSafe(name)
  })

  it('cannot traverse by being percent-encoded once or twice', () => {
    /*
      The classic bypass: sanitise first and decode afterwards and you have done nothing.

      `%2e%2e%2f` is `../`, and `..%252f` decodes to `..%2f` which decodes again to `../`. So
      decoding repeats until the string stops changing, *before* anything is stripped.
    */
    expect(
      downloadFileNameFor({
        contentDisposition: "attachment; filename*=UTF-8''%2e%2e%2f%2e%2e%2fpasswd"
      })
    ).toBe('passwd')
    expect(safeDownloadFileName('..%252f..%252fpasswd')).toBe('passwd')
  })

  it('cannot write a hidden file', () => {
    // `.bashrc` is invisible in every file manager the user might look in, so a download that
    // landed as one would be a file they cannot see, cannot find and did not ask for.
    expect(safeDownloadFileName('.bash_profile')).toBe('bash_profile')
    expect(safeDownloadFileName('...hidden.txt')).toBe('hidden.txt')
  })

  it('cannot name a Windows device', () => {
    // `CON.txt` on Windows addresses a device rather than a file. Prefixed rather than
    // rejected, because `aux.pdf` is a name somebody might legitimately have.
    expect(safeDownloadFileName('CON')).toBe('_CON')
    expect(safeDownloadFileName('nul.txt')).toBe('_nul.txt')
    expect(safeDownloadFileName('COM9.dat')).toBe('_COM9.dat')
    // And an ordinary name that merely starts the same way is left alone.
    expect(safeDownloadFileName('console.log')).toBe('console.log')
  })

  it('cannot hide behind a trailing dot', () => {
    /*
      Windows silently discards trailing dots and spaces when it creates a file.

      So any check performed on the untrimmed name is a check on a name that will not exist —
      `evil.exe.` becomes `evil.exe` on disk, which is how an extension allowlist gets bypassed.
    */
    expect(safeDownloadFileName('evil.exe.')).toBe('evil.exe')
    expect(safeDownloadFileName('report.pdf   ')).toBe('report.pdf')
  })

  it('cannot lie about its extension with a bidirectional override', () => {
    /*
      A name carrying U+202E renders its tail reversed, so this is drawn as `invoiceexe.pdf`
      by every list that shows it, ours included — while the operating system opens an `.exe`.
    */
    const spoofed = `invoice‮fdp.exe`
    const safe = safeDownloadFileName(spoofed)
    expect(safe).not.toContain('‮')
    expect(safe).toBe('invoice_fdp.exe')
    // And the isolate spelling of the same trick.
    expect(safeDownloadFileName('a⁦b⁩c.txt')).toBe('a_b_c.txt')
  })

  it('cannot smuggle a control character or a NUL', () => {
    // A newline breaks every log line that mentions the name; NUL truncates it inside any C
    // library it reaches.
    expect(safeDownloadFileName('re\u0000port\n.txt')).toBe('re_port_.txt')
  })

  it('cannot use a character Windows refuses', () => {
    expect(safeDownloadFileName('a:b*c?d"e<f>g|h.txt')).toBe('a_b_c_d_e_f_g_h.txt')
  })

  it('falls back to a name rather than to nothing', () => {
    /*
      Total: there is no input that produces an empty name, so no caller has to check.

      The last two entries are the case that made this rule wider than "empty": a name made
      only of characters that had to be replaced sanitises to `_`, which is safe but carries no
      information — and it would then beat a perfectly good name taken from the address.
    */
    for (const hostile of [
      '',
      '..',
      '.',
      '/',
      '\\',
      '...',
      '   ',
      '/////',
      '\u0000',
      '\u0000\u0000'
    ]) {
      expectSafe(safeDownloadFileName(hostile))
      expect(safeDownloadFileName(hostile), hostile).toBe(FALLBACK_DOWNLOAD_FILE_NAME)
    }
  })

  it('keeps a stray percent rather than losing the name over it', () => {
    // `100%_done.pdf` is a real filename, and `decodeURIComponent` throws on it.
    expect(safeDownloadFileName('100%_done.pdf')).toBe('100%_done.pdf')
  })

  it('stops decoding rather than looping on nested encodings', () => {
    // An unbounded decode loop over attacker-controlled input is itself a denial of service.
    const nested = `${'%25'.repeat(40)}2fetc%2fpasswd`
    expect(() => safeDownloadFileName(nested)).not.toThrow()
    expectSafe(safeDownloadFileName(nested))
  })
})

describe('length', () => {
  it('keeps the extension when it has to truncate', () => {
    // The extension is what decides which application opens the file, so cutting at a fixed
    // length and losing it would make the download unopenable.
    const name = safeDownloadFileName(`${'a'.repeat(400)}.pdf`)
    expect(name.endsWith('.pdf')).toBe(true)
    expect(name).toHaveLength(MAX_DOWNLOAD_FILE_NAME_LENGTH)
  })

  it('treats an implausibly long extension as part of the name', () => {
    // Past `MAX_EXTENSION_LENGTH` a suffix is not an extension, so there is nothing to protect
    // from truncation and the whole string is the stem.
    const name = safeDownloadFileName(`archive.${'z'.repeat(40)}`)
    expect(name).toBe(`archive.${'z'.repeat(40)}`)
  })

  it('does not produce an empty name from a name that was only an extension', () => {
    expect(safeDownloadFileName(`.${'z'.repeat(400)}`)).toHaveLength(MAX_DOWNLOAD_FILE_NAME_LENGTH)
  })

  it('leaves a name with no extension alone', () => {
    expect(safeDownloadFileName('README')).toBe('README')
  })
})

describe('parsing the header', () => {
  it('prefers filename* over filename, as RFC 6266 requires', () => {
    /*
      A server sending both intends the extended form; the plain one is a fallback for clients
      that cannot read it, and is commonly deliberately mangled.
    */
    const header = `attachment; filename="_______.pdf"; filename*=UTF-8''Rechnung%20M%C3%A4rz.pdf`
    expect(parseContentDispositionFilename(header)).toBe('Rechnung%20M%C3%A4rz.pdf')
    expect(downloadFileNameFor({ contentDisposition: header })).toBe('Rechnung März.pdf')
  })

  it('reads the malformed extended form some servers write', () => {
    // `UTF-8''` with no language part, and the value after the last quote either way.
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''a.pdf")).toBe('a.pdf')
    expect(parseContentDispositionFilename('attachment; filename*=a.pdf')).toBe('a.pdf')
  })

  it('unescapes a quoted string before anything else touches it', () => {
    /*
      `"a\\b"` names the file `a\b`.

      Undoing the escape has to happen before sanitising: leave the backslash in and the
      sanitiser reads it as a path separator and keeps only `b`, losing half the name.
    */
    expect(parseContentDispositionFilename('attachment; filename="a\\"b.txt"')).toBe('a"b.txt')
  })

  it('reads a bare token', () => {
    expect(parseContentDispositionFilename('attachment; filename=report.pdf')).toBe('report.pdf')
  })

  it('answers null for a header that names nothing', () => {
    expect(parseContentDispositionFilename('attachment')).toBeNull()
    expect(parseContentDispositionFilename('attachment; filename=')).toBeNull()
    expect(parseContentDispositionFilename('attachment; filename=""')).toBeNull()
    expect(parseContentDispositionFilename("attachment; filename*=UTF-8''")).toBeNull()
  })
})

describe('choosing between the sources', () => {
  it('believes Chromium first, because it has already reconciled the others', () => {
    const name = downloadFileNameFor({
      suggested: 'chromium-chose.pdf',
      contentDisposition: 'attachment; filename="header.pdf"',
      url: 'https://example.com/url.pdf'
    })
    expect(name).toBe('chromium-chose.pdf')
  })

  it('does not let a hostile header cost the good name in the address', () => {
    /*
      A candidate that sanitises away to nothing gets no veto over the next one.

      Returning the fallback here would name a perfectly identifiable file `download`.
    */
    const name = downloadFileNameFor({
      contentDisposition: 'attachment; filename="../"',
      url: 'https://example.com/annual-report.pdf'
    })
    expect(name).toBe('annual-report.pdf')
  })

  it('falls back to the address when there is no header', () => {
    expect(downloadFileNameFor({ url: 'https://example.com/a/b/c.zip?token=x' })).toBe('c.zip')
  })

  it('percent-decodes a name taken from the address', () => {
    expect(downloadFileNameFor({ url: 'https://example.com/Big%20Buck%20Bunny.mp4' })).toBe(
      'Big Buck Bunny.mp4'
    )
  })

  it('falls back to a name when nothing at all is usable', () => {
    expect(downloadFileNameFor({})).toBe(FALLBACK_DOWNLOAD_FILE_NAME)
    expect(downloadFileNameFor({ url: 'not a url' })).toBe(FALLBACK_DOWNLOAD_FILE_NAME)
    expect(downloadFileNameFor({ url: 'https://example.com/' })).toBe(FALLBACK_DOWNLOAD_FILE_NAME)
    expect(downloadFileNameFor({ suggested: '   ' })).toBe(FALLBACK_DOWNLOAD_FILE_NAME)
  })
})
