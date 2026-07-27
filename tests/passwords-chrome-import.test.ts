import { describe, expect, it } from 'vitest'
import { applyChromeImport, type ImportTarget } from '@main/passwords/import.js'
import {
  CSV_REFUSALS,
  MAX_CSV_LENGTH,
  MAX_CSV_ROWS,
  MAX_REPORTED_CONFLICTS,
  ROW_REFUSALS,
  looksLikeSpreadsheetFormula,
  parseChromePasswordCsv,
  parseCsvRecords,
  totalSkipped,
  type ChromeImportParse,
  type CsvRefusal,
  type RowRefusal,
  type RowRefusalCounts
} from '@shared/passwords/chrome-import.js'
import {
  MAX_PASSWORD_CREDENTIALS,
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  usernameKey,
  type SaveCredentialInput,
  type SaveOutcome
} from '@shared/passwords/model.js'

/**
 * Reading a password export written by another browser, and putting it into the vault.
 *
 * What breaks in the product when these rules are wrong:
 *
 *   - **A password ends up filed against the wrong site.** A comma, a quote or a newline inside a
 *     quoted cell, split naively, shifts every following field one place left — so the next row's
 *     password is stored under this row's origin. Nothing fails at import time. The user finds out
 *     weeks later, when a sign-in does not work and the value that used to work is gone.
 *   - **A password arrives subtly altered.** A carriage return left on the last field of a Windows
 *     export, a stripped leading space, a truncated over-long secret. Each one looks stored and none
 *     of them signs in, which is the manager remembering the wrong thing.
 *   - **An English stack trace on a translated page.** The user is standing in front of a file
 *     chooser, so every malformed shape has to become one of the *named* refusals the passwords page
 *     has a sentence for. A throw in here is an import dialogue with an exception in it.
 *   - **"42 imported" for a file of fifty rows.** Every row has to be accounted for exactly once, and
 *     the report has to match what was actually written.
 *   - **A working password replaced by a stale one.** The vault wins over the file, and that
 *     direction is unrecoverable if it is wrong: the value that still signs in would be overwritten
 *     hundreds of rows at a time, with nothing left to compare against.
 *
 * `model.ts` has its own tests in `tests/passwords-model.test.ts`. Where a case below is really about
 * the model it says so, and what it asserts is the *importer's* use of the model's answer.
 */

/** Chrome's own header row. Edge, Brave and the rest write the same one. */
const HEADER = 'name,url,username,password,note'

/**
 * Lines joined explicitly, so the line ending a fixture is testing is visible here rather than
 * inherited from whatever this source file happens to be saved with.
 */
function csv(...lines: readonly string[]): string {
  return lines.join('\n')
}

/**
 * Written out rather than generated, so adding a `RowRefusal` is a build failure here.
 *
 * A refusal nobody enumerated is a sentence the user can be shown that no test has read.
 */
const NO_ROWS_SKIPPED: RowRefusalCounts = {
  'no-url': 0,
  'formula-url': 0,
  'unsupported-url': 0,
  'no-password': 0,
  'password-too-long': 0,
  'username-too-long': 0
}

describe('the cell a spreadsheet would execute', () => {
  it('names the four formula lead-ins and the two DDE ones', () => {
    for (const prefix of ['=', '+', '-', '@', '\t', '\r']) {
      expect(looksLikeSpreadsheetFormula(`${prefix}HYPERLINK("http://x")`), prefix).toBe(true)
    }
  })

  it('leaves an ordinary cell and an empty one alone', () => {
    expect(looksLikeSpreadsheetFormula('https://example.com')).toBe(false)
    expect(looksLikeSpreadsheetFormula('hunter2')).toBe(false)
    expect(looksLikeSpreadsheetFormula('')).toBe(false)
  })
})

describe('splitting a document into records', () => {
  it('reads plain comma-separated rows', () => {
    expect(parseCsvRecords(csv('a,b', 'c,d'))).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('treats a comma inside a quoted field as data, so no field shifts left', () => {
    // The whole reason this is a character scanner. A password containing a comma is ordinary, and
    // splitting on it would move the next field into the password's place.
    expect(parseCsvRecords('a,"one,two",c')).toEqual([['a', 'one,two', 'c']])
  })

  it('reads a doubled quote inside a quoted field as one quote', () => {
    expect(parseCsvRecords('a,"say ""hi""",c')).toEqual([['a', 'say "hi"', 'c']])
  })

  it('treats a newline inside a quoted field as data rather than the end of the record', () => {
    expect(parseCsvRecords(csv('a,"line one', 'line two",c', 'next,row,here'))).toEqual([
      ['a', 'line one\nline two', 'c'],
      ['next', 'row', 'here']
    ])
  })

  it('keeps a carriage return inside a quoted field, because there it is a character', () => {
    // The `\r\n` collapse below is about *separators*. Inside quotes both characters are part of the
    // secret, and normalising them would change a password.
    expect(parseCsvRecords('a,"one\r\ntwo",c')).toEqual([['a', 'one\r\ntwo', 'c']])
  })

  it('reads a quote that is not at the start of a field as an ordinary character', () => {
    // A hand-edited file really contains these, and discarding the record over one would lose a
    // credential the user can see in their own file.
    expect(parseCsvRecords('a,b"c,d')).toEqual([['a', 'b"c', 'd']])
  })

  it('appends text that follows a closing quote instead of discarding the record', () => {
    expect(parseCsvRecords('a,"one"two,c')).toEqual([['a', 'onetwo', 'c']])
  })

  it('ends an unterminated quoted field at the end of the file', () => {
    // A truncated download then loses whatever was cut off, not every record before it.
    expect(parseCsvRecords(csv('a,b', 'c,"unfinished'))).toEqual([
      ['a', 'b'],
      ['c', 'unfinished']
    ])
  })

  it('treats CRLF as one separator, so no field keeps a carriage return', () => {
    expect(parseCsvRecords(['a,b', 'c,d'].join('\r\n'))).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('treats a lone carriage return as a separator too', () => {
    expect(parseCsvRecords('a,b\rc,d')).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('does not turn a trailing newline into an empty record', () => {
    expect(parseCsvRecords('a,b\n')).toEqual([['a', 'b']])
    expect(parseCsvRecords(['a,b', ''].join('\r\n'))).toEqual([['a', 'b']])
  })

  it('drops a blank line, which is not a record', () => {
    expect(parseCsvRecords(csv('a,b', '', 'c,d'))).toEqual([
      ['a', 'b'],
      ['c', 'd']
    ])
  })

  it('keeps a trailing empty field, because a row ending in a comma has one', () => {
    expect(parseCsvRecords('a,')).toEqual([['a', '']])
  })

  it('reads nothing from an empty document, and nothing from a document of newlines', () => {
    expect(parseCsvRecords('')).toEqual([])
    expect(parseCsvRecords('\n\r\n\r')).toEqual([])
  })

  it('refuses the whole document at the row limit rather than returning a prefix of it', () => {
    // Half an import, of an unknown half, is worse than none: the user cannot tell which half.
    expect(parseCsvRecords(csv('a', 'b'), 2)).toEqual([['a'], ['b']])
    expect(parseCsvRecords(csv('a', 'b', 'c'), 2)).toBeNull()
  })

  it('refuses at the limit wherever the record that broke it ends', () => {
    /*
      The row check has two call sites — the separator and the end-of-text flush — and a real file
      goes through whichever its last byte happens to be. A limit enforced at only one of them would
      let a file over the bound through when it ended in a newline, which is how most of them end.
    */
    expect(parseCsvRecords('a\nb\nc\n', 2), 'the third record ends at a newline').toBeNull()
    expect(parseCsvRecords('a\nb', 1), 'the second record ends at the end of the text').toBeNull()
  })
})

describe('finding the columns by name', () => {
  it('reads the columns wherever they are, not wherever Chrome last put them', () => {
    /*
      The single most damaging thing a positional reader would do: given a header in another order it
      would import every username as a password. Here `url` is last and `password` is second.
    */
    const parse = parseChromePasswordCsv(
      csv('name,password,note,username,url', 'Example,hunter2,,alice,https://example.com/login')
    )
    expect(parse.refusal).toBeNull()
    expect(parse.credentials).toEqual([
      { url: 'https://example.com', username: 'alice', password: 'hunter2' }
    ])
  })

  it('ignores a column it has no use for', () => {
    const parse = parseChromePasswordCsv(
      csv(
        'name,url,username,password,note,totp',
        'Example,https://example.com,alice,hunter2,,JBSWY3DP'
      )
    )
    expect(parse.credentials).toEqual([
      { url: 'https://example.com', username: 'alice', password: 'hunter2' }
    ])
  })

  it('matches a header name whatever its case and spacing', () => {
    const parse = parseChromePasswordCsv(
      csv('name, URL , UserName ,PASSWORD, Note ', 'Example,https://example.com,alice,hunter2,')
    )
    expect(parse.credentials).toHaveLength(1)
  })

  it('accepts `notes` as well as `note`, so a derivative export still reports a dropped note', () => {
    const parse = parseChromePasswordCsv(
      csv('name,url,username,password,notes', 'Example,https://example.com,alice,hunter2,recovery')
    )
    expect(parse.notesDropped).toBe(1)
  })

  it('imports a nameless credential from a file with no username column at all', () => {
    // Legal: some sites authenticate on a password alone, and an absent column is not a malformed
    // file. `model.ts` owns whether an empty name may be stored; this asserts what is handed to it.
    const parse = parseChromePasswordCsv(
      csv('name,url,password', 'Example,https://example.com,hunter2')
    )
    expect(parse.credentials).toEqual([
      { url: 'https://example.com', username: '', password: 'hunter2' }
    ])
    expect(parse.notesDropped, 'a file with no note column drops no notes').toBe(0)
  })

  it('imports a Firefox export, whose first column is the one the BOM strip used to eat', () => {
    /*
      The regression test for a shipped defect, and the reason it is written from the *first column*
      rather than from the byte-order mark.

      The strip read `text.startsWith('') ? text.slice(1) : text` — an **empty** string literal where
      U+FEFF was meant, the character having been eaten out of the source by an editor or a formatter at
      some point. `''.startsWith('')` is always true, so the first character of every imported file was
      discarded. Chrome's own export survived by luck: `name,url,...` became `ame,url,...`, and since
      columns are found by name the damaged one was the only one nothing needed. Firefox's export begins
      with `url` — a column that *is* required — so the whole file came back `unknown-columns`, which the
      page renders as "you picked the wrong file" about a file that was exactly right.

      A fixture starting with `name` therefore cannot catch this, which is precisely why it went
      unnoticed. Both halves below are load-bearing: with no mark nothing may be removed, and with one
      exactly one character may be.

      Worth knowing for whoever touches the strip next: `mapColumns` lower-cases through `String.trim`,
      and `trim` already removes U+FEFF. So the strip is defence in depth for the header, and a genuine
      byte-order mark would have been survived without it — which is why only a bug that ate a *real*
      character, rather than a mark, could break Firefox's export. Neither guard is load-bearing alone;
      removing both would be.
    */
    const firefox = csv('url,username,password', 'https://example.com,alice,hunter2')
    const expected = [{ url: 'https://example.com', username: 'alice', password: 'hunter2' }]

    expect(parseChromePasswordCsv(firefox).credentials).toEqual(expected)
    expect(parseChromePasswordCsv(`\uFEFF${firefox}`).credentials).toEqual(expected)
  })
})

describe('a file refused whole', () => {
  /**
   * One fixture per `CsvRefusal`, so every value of the vocabulary is produced by something.
   *
   * Thunks rather than strings: one of these is eight megabytes and another is twenty thousand rows,
   * and there is no reason to build either while a different case is being run.
   */
  const wholeFileRefusals: Readonly<Record<CsvRefusal, () => string>> = {
    empty: () => '',
    'unknown-columns': () => csv('title,address,secret', 'Example,https://example.com,hunter2'),
    'too-large': () => 'x'.repeat(MAX_CSV_LENGTH + 1),
    'too-many-rows': () =>
      csv(
        HEADER,
        ...Array.from(
          { length: MAX_CSV_ROWS },
          (_value, index) => `Example,https://s${index}.example,alice,hunter2,`
        )
      )
  }

  it('reports each refusal, with nothing read and nothing counted', () => {
    for (const refusal of CSV_REFUSALS) {
      const parse = parseChromePasswordCsv(wholeFileRefusals[refusal]())
      expect(parse.refusal, refusal).toBe(refusal)
      // The contract says `credentials` is empty whenever a refusal is set, and the page shows the
      // refusal instead of a count — a non-empty list here would be a written row nobody reported.
      expect(parse.credentials, refusal).toEqual([])
      expect(parse.skipped, refusal).toEqual(NO_ROWS_SKIPPED)
      expect(parse.notesDropped, refusal).toBe(0)
    }
  })

  it('refuses a file that is only a header as empty rather than as the wrong kind of file', () => {
    // The distinction the page needs: "you picked the wrong file" is a different sentence from "there
    // was nothing under the header".
    expect(parseChromePasswordCsv(HEADER).refusal).toBe('empty')
    expect(parseChromePasswordCsv(`${HEADER}\n`).refusal).toBe('empty')
    expect(parseChromePasswordCsv(csv(HEADER, '', '')).refusal).toBe('empty')
  })

  it('refuses a file with no header row, reading the first record as one', () => {
    expect(parseChromePasswordCsv('https://example.com,alice,hunter2').refusal).toBe(
      'unknown-columns'
    )
  })

  it('refuses a header missing either of the two columns it cannot do without', () => {
    // Refusing the whole file rather than importing the part it can read: a file whose `password`
    // column is absent would otherwise import a vault full of entries with no secret in them.
    expect(
      parseChromePasswordCsv(csv('name,url,username', 'A,https://a.example,alice')).refusal
    ).toBe('unknown-columns')
    expect(parseChromePasswordCsv(csv('name,username,password', 'A,alice,hunter2')).refusal).toBe(
      'unknown-columns'
    )
  })
})

describe('a row refused', () => {
  /** One fixture per `RowRefusal`, each producing exactly one refused row and nothing else. */
  const rowRefusals: Readonly<Record<RowRefusal, string>> = {
    'no-url': csv(HEADER, 'Example,,alice,hunter2,'),
    'formula-url': csv(HEADER, 'Example,=HYPERLINK("https://evil.example"),alice,hunter2,'),
    'unsupported-url': csv(HEADER, 'Example,javascript:alert(1),alice,hunter2,'),
    'no-password': csv(HEADER, 'Example,https://example.com,alice,,'),
    'password-too-long': csv(
      HEADER,
      `Example,https://example.com,alice,${'x'.repeat(MAX_PASSWORD_LENGTH + 1)},`
    ),
    'username-too-long': csv(
      HEADER,
      `Example,https://example.com,${'x'.repeat(MAX_USERNAME_LENGTH + 1)},hunter2,`
    )
  }

  it('counts each reason under its own name, and refuses nothing else by accident', () => {
    for (const refusal of ROW_REFUSALS) {
      const parse = parseChromePasswordCsv(rowRefusals[refusal])
      expect(parse.refusal, refusal).toBeNull()
      expect(parse.credentials, refusal).toEqual([])
      expect(parse.skipped[refusal], refusal).toBe(1)
      expect(totalSkipped(parse.skipped), refusal).toBe(1)
    }
  })

  it('refuses a url cell holding only whitespace as a missing address', () => {
    expect(
      parseChromePasswordCsv(csv(HEADER, 'Example,"   ",alice,hunter2,')).skipped['no-url']
    ).toBe(1)
  })

  it('refuses every address a typed credential could not be filed under either', () => {
    /*
      `passwordOriginOf` is the model's, and `tests/passwords-model.test.ts` owns which schemes it
      accepts. What matters here is that the importer routes through it rather than round it: an
      imported credential must not be able to land somewhere a typed one cannot.
    */
    for (const address of [
      'file:///tmp/login.html',
      'data:text/html,x',
      'chrome://settings',
      'about:blank',
      'tessera://passwords',
      'example.com',
      'not a url'
    ]) {
      const parse = parseChromePasswordCsv(csv(HEADER, `Example,${address},alice,hunter2,`))
      expect(parse.skipped['unsupported-url'], address).toBe(1)
    }
  })

  it('refuses a formula in the url column with its own reason, not as an unparseable address', () => {
    // Named separately because a formula is a *diagnosis*: the file came out of a spreadsheet, and
    // "this is not an address" would send the user looking for the wrong problem.
    const parse = parseChromePasswordCsv(
      csv(HEADER, `Example,"=cmd|'/c calc.exe'!A1",alice,hunter2,`)
    )
    expect(parse.skipped['formula-url']).toBe(1)
    expect(parse.skipped['unsupported-url']).toBe(0)
  })

  it('keeps a formula-looking password exactly as it is, because it is a password', () => {
    // `=hunter2` is a valid secret and this browser is not a spreadsheet. Quietly removing the `=`
    // would store one that cannot sign in.
    const parse = parseChromePasswordCsv(csv(HEADER, 'Example,https://example.com,alice,=hunter2,'))
    expect(parse.credentials[0]?.password).toBe('=hunter2')
  })

  it('accepts a password of exactly the maximum length, so the bound refuses nothing valid', () => {
    // The row one character longer is refused above. A bound that was off by one here would refuse a
    // generated passphrase for no reason the user could see.
    const atLimit = 'x'.repeat(MAX_PASSWORD_LENGTH)
    const parse = parseChromePasswordCsv(
      csv(HEADER, `Example,https://example.com,alice,${atLimit},`)
    )
    expect(parse.credentials[0]?.password).toBe(atLimit)
    expect(totalSkipped(parse.skipped)).toBe(0)
  })

  it('measures an over-long username on the trimmed name, as the vault will', () => {
    // Padding is not part of a name, so a name that only exceeds the limit with its spaces is not
    // over-long. Measuring the untrimmed cell would refuse a row the vault would have accepted.
    const padded = `  ${'x'.repeat(MAX_USERNAME_LENGTH)}  `
    const parse = parseChromePasswordCsv(
      csv(HEADER, `Example,https://example.com,"${padded}",hunter2,`)
    )
    expect(parse.skipped['username-too-long']).toBe(0)
    expect(parse.credentials).toHaveLength(1)
  })

  it('refuses a row whose trailing commas were lost for the reason that actually applies', () => {
    // Common in a hand-edited file, and it must not crash the scan: the missing cell reads as empty,
    // so the row is refused as having no password rather than taking the whole import down.
    const parse = parseChromePasswordCsv(csv(HEADER, 'Example,https://example.com'))
    expect(parse.skipped['no-password']).toBe(1)
    expect(parse.refusal).toBeNull()
  })
})

describe('what a surviving row becomes', () => {
  it('keeps the origin and drops the path and query the old export carried', () => {
    // A login URL in an old export can carry `?session=…`. Reduced at the edge, so nothing downstream
    // ever holds it.
    const parse = parseChromePasswordCsv(
      csv(HEADER, 'Bank,https://bank.example/login?session=8f1c,alice,hunter2,')
    )
    expect(parse.credentials[0]?.url).toBe('https://bank.example')
  })

  it('keeps a password containing a comma, and leaves the fields around it in place', () => {
    /*
      Field shift, which is the failure this parser exists to prevent. A naive split would give
      `username: 'hun'` and file `ter2` as the password — under the right origin, so nothing would
      look wrong until a sign-in failed.
    */
    const parse = parseChromePasswordCsv(
      csv(HEADER, 'Example,https://example.com,alice,"hun,ter2",note text')
    )
    expect(parse.credentials).toEqual([
      { url: 'https://example.com', username: 'alice', password: 'hun,ter2' }
    ])
    expect(parse.notesDropped, 'the note column is still the note column').toBe(1)
  })

  it('keeps a password containing a quote or a newline, and still reads the next row correctly', () => {
    const parse = parseChromePasswordCsv(
      csv(
        HEADER,
        'Example,https://example.com,alice,"say ""hi""",',
        'Other,https://other.example,bob,"two',
        'lines",',
        'Third,https://third.example,carol,plain,'
      )
    )
    expect(parse.credentials).toEqual([
      { url: 'https://example.com', username: 'alice', password: 'say "hi"' },
      { url: 'https://other.example', username: 'bob', password: 'two\nlines' },
      { url: 'https://third.example', username: 'carol', password: 'plain' }
    ])
  })

  it('leaves no carriage return on the last field of a Windows export', () => {
    // Chrome on Windows writes CRLF, and `note` is the last column — so without the CRLF rule it is
    // the *note* that would carry the `\r` here. The row below has no note, which puts the password
    // last and makes the damage a password that cannot sign in.
    const parse = parseChromePasswordCsv(
      ['name,url,username,password', 'Example,https://example.com,alice,hunter2'].join('\r\n')
    )
    expect(parse.credentials[0]?.password).toBe('hunter2')
  })

  it('keeps the space a password begins or ends with', () => {
    // Trimming would store a password that does not sign in. The username is trimmed and the password
    // is not, and the two live in the same row.
    const parse = parseChromePasswordCsv(
      csv(HEADER, 'Example,https://example.com," alice ","  hunter2  ",')
    )
    expect(parse.credentials[0]?.password).toBe('  hunter2  ')
    expect(parse.credentials[0]?.username, 'the name is handed over untrimmed too').toBe(' alice ')
  })

  it('keeps the rows in file order, which is the only tiebreak a file offers', () => {
    const parse = parseChromePasswordCsv(
      csv(
        HEADER,
        'Second,https://b.example,bob,q,',
        'First,https://a.example,alice,p,',
        'Third,https://c.example,carol,r,'
      )
    )
    expect(parse.credentials.map((entry) => entry.url)).toEqual([
      'https://b.example',
      'https://a.example',
      'https://c.example'
    ])
  })
})

describe('the report adds up', () => {
  /**
   * Eight rows: two usable, one of each of the six refusals, and a note on the first.
   *
   * The `note` on a *refused* row is deliberate — see the assertion about it below.
   */
  const mixed = csv(
    HEADER,
    'Bank,https://bank.example/login?session=abc,alice,hunter2,recovery code 1234',
    'Shop,https://shop.example,bob,"s,cret",',
    'Broken,,carol,p,',
    `Formula,"=cmd|'/c calc'!A1",dave,p,`,
    'Script,javascript:alert(1),erin,p,',
    'NoPass,https://nopass.example,frank,,',
    `Long,https://long.example,gina,${'x'.repeat(MAX_PASSWORD_LENGTH + 1)},`,
    `LongName,https://longname.example,${'x'.repeat(MAX_USERNAME_LENGTH + 1)},p,`
  )

  it('accounts for every row of the file exactly once', () => {
    // A total that is not the sum of its parts is how a user is told "42 imported" for a file of 50.
    const parse = parseChromePasswordCsv(mixed)
    expect(parse.credentials).toHaveLength(2)
    expect(totalSkipped(parse.skipped)).toBe(6)
    expect(parse.credentials.length + totalSkipped(parse.skipped), 'eight data rows').toBe(8)
    expect(parse.skipped).toEqual({
      'no-url': 1,
      'formula-url': 1,
      'unsupported-url': 1,
      'no-password': 1,
      'password-too-long': 1,
      'username-too-long': 1
    })
  })

  it('counts a dropped note even when the row itself was refused', () => {
    /*
      A user whose notes held a recovery code needs to hear that it did not come across, and that is
      just as true of a row that was refused for some other reason. Counting the note only on rows
      that survived would under-report exactly the file that went worst.
    */
    const parse = parseChromePasswordCsv(
      csv(HEADER, 'Broken,,carol,p,recovery code 1234', 'Fine,https://fine.example,dan,p,')
    )
    expect(parse.notesDropped).toBe(1)
    expect(parse.credentials).toHaveLength(1)
  })

  it('does not turn a blank trailing line or a blank line between rows into a refused row', () => {
    // Otherwise a file saved by an editor that adds a final newline would report one mysterious
    // refusal that corresponds to nothing the user can see.
    const parse = parseChromePasswordCsv(
      `${csv(HEADER, 'A,https://a.example,alice,p,', '', 'B,https://b.example,bob,q,')}\n`
    )
    expect(parse.credentials).toHaveLength(2)
    expect(totalSkipped(parse.skipped)).toBe(0)
  })

  it('counts nothing at all for a file it refused whole', () => {
    expect(totalSkipped(parseChromePasswordCsv('').skipped)).toBe(0)
  })
})

// --- putting a parse into the vault ------------------------------------------

interface Recording extends ImportTarget {
  /** Every `create` argument, in the order it was asked for. */
  written: SaveCredentialInput[]
  countCalls: number
}

/**
 * A vault that records what it was asked to write.
 *
 * `compareStored` answers the way `PasswordStore.compareStored` does — by (origin, folded username),
 * over what it held at the start *and* over what this import has added since. The second half is what
 * makes the duplicate tests real: the store cannot tell a caller whether an entry arrived a minute ago
 * or a moment ago, so a fake that only remembered its initial contents would make a within-file
 * duplicate look like a fresh row and the rule would never be exercised.
 *
 * There is deliberately no way to *change* an entry here, because there is none on `ImportTarget`
 * either. "An import cannot overwrite" is a property of that interface, and this fake would have to
 * grow a method before it could be broken.
 */
function recordingVault(
  options: {
    held?: readonly SaveCredentialInput[]
    storedCount?: number
    outcome?: SaveOutcome
  } = {}
): Recording {
  const held: SaveCredentialInput[] = [...(options.held ?? [])]
  const outcome = options.outcome ?? 'created'
  const vault: Recording = {
    written: [],
    countCalls: 0,
    count: () => {
      vault.countCalls += 1
      return options.storedCount ?? held.length
    },
    compareStored: (url, username, password) => {
      const existing = held.find(
        (entry) => entry.url === url && usernameKey(entry.username) === usernameKey(username)
      )
      if (existing === undefined) return 'none'
      return existing.password === password ? 'same-password' : 'different-password'
    },
    create: (input) => {
      vault.written.push(input)
      if (outcome === 'created') held.push(input)
      return outcome
    }
  }
  return vault
}

/** A parse of a file with nothing wrong with it, for the cases that are about the vault instead. */
function parsedFile(credentials: readonly SaveCredentialInput[]): ChromeImportParse {
  return { credentials, skipped: NO_ROWS_SKIPPED, notesDropped: 0, refusal: null }
}

const alice: SaveCredentialInput = {
  url: 'https://example.com',
  username: 'alice',
  password: 'hunter2'
}

describe('writing a parsed export into the vault', () => {
  it('hands every row to the vault untouched, so there is no second write path', () => {
    const bob = { url: 'https://other.example', username: 'bob', password: 's,cret' }
    const vault = recordingVault()
    const result = applyChromeImport(vault, parsedFile([alice, bob]))

    expect(vault.written).toEqual([alice, bob])
    expect(result.imported).toBe(2)
  })

  it('measures the room left once rather than on every row', () => {
    // `count()` walks the credential list, and a two-thousand-row file would walk it two thousand
    // times. The number only moves when this loop moves it.
    const vault = recordingVault()
    applyChromeImport(
      vault,
      parsedFile([
        alice,
        { url: 'https://b.example', username: 'b', password: 'p' },
        { url: 'https://c.example', username: 'c', password: 'p' }
      ])
    )
    expect(vault.countCalls).toBe(1)
  })

  it('writes nothing for a file that was refused, and carries the refusal out', () => {
    const vault = recordingVault()
    const result = applyChromeImport(vault, parseChromePasswordCsv(''))

    expect(result.refusal).toBe('empty')
    expect(vault.written).toEqual([])
    expect(vault.countCalls, 'it does not even ask how full the vault is').toBe(0)
    expect(result.imported).toBe(0)
  })

  it('passes the file’s own refusals and dropped notes through unchanged', () => {
    // The page shows one report. If these did not survive the write step the six row refusals the
    // parser counted would vanish and the numbers would stop adding up.
    const parse = parseChromePasswordCsv(
      csv(HEADER, 'Broken,,carol,p,recovery code', 'Fine,https://fine.example,dan,p,')
    )
    const result = applyChromeImport(recordingVault(), parse)

    expect(result.skipped['no-url']).toBe(1)
    expect(totalSkipped(result.skipped)).toBe(1)
    expect(result.notesDropped).toBe(1)
    expect(result.imported + totalSkipped(result.skipped), 'both data rows are accounted for').toBe(
      2
    )
  })
})

describe('a row that collides with something already stored', () => {
  it('reports an identical entry as noise and writes nothing', () => {
    // The common case on any second import of the same file. Nothing to see, and nothing to do.
    const vault = recordingVault({ held: [alice] })
    const result = applyChromeImport(vault, parsedFile([alice]))

    expect(result).toMatchObject({ imported: 0, duplicatesIdentical: 1, duplicatesConflicting: 0 })
    expect(vault.written).toEqual([])
    expect(result.conflicts).toEqual([])
  })

  it('keeps the stored password when the file disagrees, and names the entry back', () => {
    /*
      The direction the whole feature turns on. The file is usually *older* than the vault — exported
      weeks ago, found in a downloads folder, imported — so "the file is newer" would replace a working
      password with a stale one, hundreds of rows at a time, with nothing left to compare against.
      Skipping is recoverable; the credential the user already had still signs in.
    */
    const vault = recordingVault({ held: [alice] })
    const result = applyChromeImport(
      vault,
      parsedFile([{ ...alice, password: 'from-the-stale-export' }])
    )

    expect(result).toMatchObject({ imported: 0, duplicatesIdentical: 0, duplicatesConflicting: 1 })
    expect(vault.written, 'nothing was written, so nothing was overwritten').toEqual([])
    expect(result.conflicts).toEqual([{ origin: 'https://example.com', username: 'alice' }])
  })

  it('names a conflict without its secret, so the report can cross IPC and land in a page', () => {
    const result = applyChromeImport(
      recordingVault({ held: [alice] }),
      parsedFile([{ ...alice, password: 'from-the-stale-export' }])
    )
    expect(JSON.stringify(result.conflicts)).not.toContain('hunter2')
    expect(JSON.stringify(result.conflicts)).not.toContain('from-the-stale-export')
  })

  it('reports a duplicate as one even when the vault is full', () => {
    /*
      Order of operations, and it is visible to the user. Asking "is this already here?" before "is
      there room?" means a re-import into a full vault reports hundreds of duplicates rather than
      hundreds of rows that did not fit — two very different pieces of advice.
    */
    const vault = recordingVault({ held: [alice], storedCount: MAX_PASSWORD_CREDENTIALS })
    const result = applyChromeImport(vault, parsedFile([alice]))

    expect(result).toMatchObject({ duplicatesIdentical: 1, full: 0 })
  })

  it('caps the conflicts it names while keeping the count exact', () => {
    // A file engineered to collide with everything would otherwise turn the report into a copy of the
    // vault's index, on its way through IPC into a page.
    const many = Array.from({ length: MAX_REPORTED_CONFLICTS + 5 }, (_value, index) => ({
      url: `https://s${index}.example`,
      username: 'alice',
      password: 'from-the-stale-export'
    }))
    const held = many.map((entry) => ({ ...entry, password: 'hunter2' }))
    const result = applyChromeImport(recordingVault({ held }), parsedFile(many))

    expect(result.conflicts).toHaveLength(MAX_REPORTED_CONFLICTS)
    expect(result.duplicatesConflicting).toBe(MAX_REPORTED_CONFLICTS + 5)
  })
})

describe('a file that contains the same account twice', () => {
  it('imports the first row and reports the second as already stored', () => {
    // No separate rule for a within-file duplicate, and none needed: by the time the second row is
    // considered the first is in the vault, so it is a collision like any other.
    const vault = recordingVault()
    const result = applyChromeImport(vault, parsedFile([alice, alice]))

    expect(result).toMatchObject({ imported: 1, duplicatesIdentical: 1 })
    expect(vault.written).toEqual([alice])
  })

  it('keeps the earlier row when the two disagree, and does not ask the user to reconcile it', () => {
    /*
      Counted as a conflict, but *not* named in `conflicts` — because a named conflict is an
      instruction to go and compare the vault against something, and here both values came out of the
      same file. Pointing the user at their own export would be advice they cannot act on.
    */
    const vault = recordingVault()
    const result = applyChromeImport(
      vault,
      parsedFile([alice, { ...alice, password: 'second-row' }])
    )

    expect(result).toMatchObject({ imported: 1, duplicatesConflicting: 1 })
    expect(result.conflicts, 'the collision is with a row of this same file').toEqual([])
    expect(vault.written, 'file order is the tiebreak, so the first row won').toEqual([alice])
  })

  it('treats two spellings of one name as one account when deciding what to name back', () => {
    /*
      `usernameKey` is the model's, and `tests/passwords-model.test.ts` owns the folding itself. What
      is asserted here is the importer's *use* of it: the key it remembers a written row under. Were
      that key the raw username, `Alice` would not match the `alice` just written and the report would
      tell the user to reconcile a conflict with their own file.
    */
    const vault = recordingVault()
    const result = applyChromeImport(
      vault,
      parsedFile([alice, { ...alice, username: '  ALICE ', password: 'second-row' }])
    )

    expect(result).toMatchObject({ imported: 1, duplicatesConflicting: 1 })
    expect(result.conflicts).toEqual([])
  })
})

describe('a file bigger than the room left', () => {
  it('counts the rows that do not fit instead of evicting what the user already had', () => {
    /*
      `saveCredential` prunes by dropping the least useful entry, which is right for a save the user
      just made and catastrophic for a bulk import: a two-thousand-row file would evict every
      credential the user had, one row at a time, and report success. An import must not delete
      anything.
    */
    const vault = recordingVault({ storedCount: MAX_PASSWORD_CREDENTIALS })
    const result = applyChromeImport(
      vault,
      parsedFile([alice, { url: 'https://b.example', username: 'bob', password: 'q' }])
    )

    expect(result).toMatchObject({ imported: 0, full: 2 })
    expect(vault.written).toEqual([])
  })

  it('fills the last free place and counts the rest as full', () => {
    const vault = recordingVault({ storedCount: MAX_PASSWORD_CREDENTIALS - 1 })
    const result = applyChromeImport(
      vault,
      parsedFile([
        alice,
        { url: 'https://b.example', username: 'bob', password: 'q' },
        { url: 'https://c.example', username: 'carol', password: 'r' }
      ])
    )

    expect(result).toMatchObject({ imported: 1, full: 2 })
    expect(vault.written).toEqual([alice])
  })
})

describe('a vault answer the parser said could not happen', () => {
  it('counts it rather than throwing, whichever answer it was', () => {
    /*
      An import that crashes halfway leaves a vault nobody can reason about, and one that silently
      ignores the answer leaves a row that vanished. A non-zero number here means the parser and the
      model have drifted apart, which is worth being able to see.
    */
    for (const outcome of ['rejected', 'updated', 'unchanged'] as const) {
      const vault = recordingVault({ outcome })
      const result = applyChromeImport(vault, parsedFile([alice]))

      expect(result.refusedByVault, outcome).toBe(1)
      expect(result.imported, outcome).toBe(0)
      expect(vault.written, outcome).toEqual([alice])
    }
  })

  it('does not spend the place it failed to fill', () => {
    // The tracked count is what the cap is measured against. Counting a rejected row against it would
    // make a file of rejected rows report the rest as "did not fit".
    const vault = recordingVault({ storedCount: MAX_PASSWORD_CREDENTIALS - 1, outcome: 'rejected' })
    const result = applyChromeImport(
      vault,
      parsedFile([alice, { url: 'https://b.example', username: 'bob', password: 'q' }])
    )

    expect(result).toMatchObject({ refusedByVault: 2, full: 0 })
  })
})

describe('a whole import, from the file to the report', () => {
  it('accounts for every row of the file in the report the page is shown', () => {
    /*
      The end-to-end version of the accounting: five data rows, one already stored identically, one
      already stored with a different password, one importable, and two the file itself made unusable.
      Every one of the five has to appear in exactly one column of the report.
    */
    const file = csv(
      HEADER,
      'Bank,https://bank.example/login,alice,hunter2,recovery code 1234',
      'Stale,https://stale.example,bob,from-the-stale-export,',
      'Shop,https://shop.example,carol,"s,cret",',
      'Broken,,dave,p,',
      'Script,javascript:alert(1),erin,p,'
    )
    const vault = recordingVault({
      held: [
        { url: 'https://bank.example', username: 'alice', password: 'hunter2' },
        { url: 'https://stale.example', username: 'bob', password: 'the-one-that-works' }
      ]
    })
    const result = applyChromeImport(vault, parseChromePasswordCsv(file))

    expect(result).toMatchObject({
      imported: 1,
      duplicatesIdentical: 1,
      duplicatesConflicting: 1,
      full: 0,
      refusedByVault: 0,
      notesDropped: 1,
      refusal: null
    })
    expect(result.conflicts).toEqual([{ origin: 'https://stale.example', username: 'bob' }])
    expect(vault.written, 'only the row that was neither stored nor refused').toEqual([
      { url: 'https://shop.example', username: 'carol', password: 's,cret' }
    ])
    expect(
      result.imported +
        result.duplicatesIdentical +
        result.duplicatesConflicting +
        result.full +
        result.refusedByVault +
        totalSkipped(result.skipped),
      'five data rows, each counted once'
    ).toBe(5)
  })
})
