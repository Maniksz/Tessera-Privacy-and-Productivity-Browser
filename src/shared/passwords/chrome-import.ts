import {
  MAX_PASSWORD_LENGTH,
  MAX_USERNAME_LENGTH,
  passwordOriginOf,
  type SaveCredentialInput
} from './model.js'

/**
 * Reading Chrome's exported passwords.
 *
 * ## Why this exists, and why it is the only importer
 *
 * A password manager nobody can move into is a password manager nobody uses, and the file every
 * such person actually has is `Chrome Passwords.csv`. Chrome, Edge, Brave and every other
 * Chromium-derived browser write the same header — `name,url,username,password,note` — and Firefox
 * writes a superset of the three columns that matter. So one parser covers the migration people
 * attempt, which is why this was judged worth building rather than deferred with the sync adapters.
 *
 * ## The file is untrusted input, and this is not a formality
 *
 * It is a file the user picked, but its *contents* were written by whatever produced it, and "export
 * your passwords from your old browser" is an instruction an attacker can plausibly give. Every case
 * below has a test named after the damage it prevents.
 *
 *   1. **A field with a comma, a quote or a newline in it.** The damage is not the mangled field: it
 *      is *field shift*. Split a record on the first newline inside a quoted password and every
 *      following field moves one place left, so the next row's password is filed against this row's
 *      site — silently, and only discovered when a sign-in fails. Hence a character-by-character
 *      RFC 4180 scanner rather than `split(',')`.
 *   2. **A leading `=`, `+`, `-` or `@`.** In a spreadsheet those are formulas, and `=HYPERLINK(…)`
 *      or `=cmd|…` in a CSV is a real, catalogued attack. The honest position here is narrower than
 *      the usual advice, and it matters: **this browser is not a spreadsheet**, so nothing in the
 *      import path evaluates anything, and there is no CSV export to re-emit them into — `api.ts`
 *      explains why an export deliberately does not exist. So a formula prefix is **not stripped
 *      from a secret**: `=hunter2` is a valid password, and quietly removing the `=` would store one
 *      that cannot sign in, which is the manager remembering the wrong thing. It *is* refused in the
 *      `url` column, because a formula is not an address, and a refusal there is named so that the
 *      row is reported rather than mis-filed.
 *   3. **A `url` that is not one.** `javascript:`, `data:`, `file:`, `chrome://`, `about:`, a bare
 *      word, an empty cell. Every address goes through `passwordOriginOf`, which accepts `http:` and
 *      `https:` and nothing else — the same function the save path uses, so an imported credential
 *      cannot be filed anywhere a typed one could not.
 *   4. **The columns in a different order.** Mapped by *name* from the header row, never by position.
 *      A positional reader given Firefox's export — which starts `url,username,password` — would put
 *      every URL in the name column, and given a hand-edited file would import every username as a
 *      password. A header without `url` and `password` refuses the whole file rather than importing
 *      part of it.
 *   5. **A UTF-8 BOM.** `\uFEFFname` matches no column, so *every* mapping fails and the file is
 *      refused for a reason that has nothing to do with what is wrong with it. Stripped once, at the
 *      front, before anything is scanned — and written as an escape wherever it appears in this file,
 *      because a literal one is invisible to a reviewer and was once silently eaten out of the very
 *      comparison that does the stripping. See `parseChromePasswordCsv`.
 *   6. **CRLF line endings.** Chrome on Windows writes them. A scanner that only knows `\n` leaves a
 *      carriage return on the last field of every record, so every imported password has an
 *      invisible character appended and not one of them works.
 *   7. **Size.** A hundred megabytes of rows is a main process that stops answering. Bounded before
 *      the scan, and a file over the bound is *refused* rather than truncated — half an import, of an
 *      unknown half, is worse than none.
 *
 * ## What is read and thrown away
 *
 * The `name` column, which is a page title, and the `note` column, which Chrome added in 2022.
 * `model.ts` refuses both by design — a title is browsing history by another route, and a note is
 * where people keep recovery codes and TOTP seeds, which makes the vault a single factor wearing the
 * costume of two. Dropped notes are **counted**, because a user whose notes held a recovery code
 * needs to hear that they did not come across.
 *
 * ## What is not decided here
 *
 * Duplicates. Whether a row that collides with something already stored is skipped or overwrites is
 * a question about the vault, not about the file, and it is answered in `main/passwords/import.ts` —
 * where a within-file duplicate falls out of the same rule for free, because by the time the second
 * row is considered the first is already stored.
 */

/**
 * Longest file scanned, in characters.
 *
 * Eight megabytes is around forty thousand credentials — twenty times the vault's own cap — and still
 * a scan measured in milliseconds.
 */
export const MAX_CSV_LENGTH = 8 * 1024 * 1024

/**
 * Most records read.
 *
 * Ten times `MAX_PASSWORD_CREDENTIALS`, so a real export can be over the vault's cap and still be
 * *read* — the caller then reports what did not fit. A file past this is refused rather than cut, for
 * the same reason as the length bound.
 */
export const MAX_CSV_ROWS = 20_000

/**
 * Why the whole file was refused, as an array.
 *
 * Exported because the wire schema in `shared/ipc/contract.ts` has to enumerate it: the import report
 * crosses IPC, and a refusal validated as a bare `string` would let a future value through as a key the
 * page has no sentence for — a blank line where the explanation belonged. `satisfies` ties it to the
 * union, so adding one without adding it here is a build failure.
 */
export const CSV_REFUSALS = [
  'empty',
  'unknown-columns',
  'too-large',
  'too-many-rows'
] as const satisfies readonly CsvRefusal[]

/** Why the whole file was refused. One of these means no credential was read at all. */
export type CsvRefusal =
  /** No records, or a header and nothing under it. */
  | 'empty'
  /** No `url` column, or no `password` column. See point 4 above. */
  | 'unknown-columns'
  | 'too-large'
  | 'too-many-rows'

/** Why one row was refused. Counted rather than listed: a list of rows would be a map of the file. */
export type RowRefusal =
  | 'no-url'
  /** A `url` cell that a spreadsheet would execute. See point 2 above. */
  | 'formula-url'
  /** Not `http:` or `https:`, or not an address at all. */
  | 'unsupported-url'
  | 'no-password'
  | 'password-too-long'
  | 'username-too-long'

/** Exported for the wire schema, for the reason `CSV_REFUSALS` gives. */
export const ROW_REFUSALS = [
  'no-url',
  'formula-url',
  'unsupported-url',
  'no-password',
  'password-too-long',
  'username-too-long'
] as const satisfies readonly RowRefusal[]

export type RowRefusalCounts = Readonly<Record<RowRefusal, number>>

export interface ChromeImportParse {
  /**
   * Rows that survived, in file order, with the address already reduced to an origin.
   *
   * `SaveCredentialInput` rather than a shape of this file's own, so what comes out of an import is
   * literally what the save path takes. There is no second write path for imported data — the
   * classic way an importer ends up bypassing a rule the rest of the code maintains.
   */
  readonly credentials: readonly SaveCredentialInput[]
  readonly skipped: RowRefusalCounts
  /** Rows whose `note` column held something. See "What is read and thrown away". */
  readonly notesDropped: number
  /** Non-null means nothing was read; `credentials` is then empty. */
  readonly refusal: CsvRefusal | null
}

function noRowsSkipped(): Record<RowRefusal, number> {
  const counts: Record<string, number> = {}
  for (const reason of ROW_REFUSALS) counts[reason] = 0
  // Built from the list above, so every key is present and the type already says so — no assertion needed, and
  // an assertion here would have hidden the day the loop stopped covering the list.
  return counts
}

function refused(refusal: CsvRefusal): ChromeImportParse {
  return { credentials: [], skipped: noRowsSkipped(), notesDropped: 0, refusal }
}

/** The characters a spreadsheet reads as the start of a formula, plus the two DDE lead-ins. */
const FORMULA_PREFIXES: readonly string[] = ['=', '+', '-', '@', '\t', '\r']

/**
 * Whether a cell would be executed by a spreadsheet.
 *
 * Applied to the `url` column only, and deliberately not to the secret. See point 2 of the docblock
 * for the whole argument; the short version is that mangling a password to protect a program we are
 * not is a bug, and refusing a formula where an address belongs is a diagnosis.
 */
export function looksLikeSpreadsheetFormula(cell: string): boolean {
  const [first] = cell
  if (first === undefined) return false
  return FORMULA_PREFIXES.includes(first)
}

/**
 * Splits a CSV document into records, RFC 4180 with the tolerances real files need.
 *
 * Exported because it is the half that is easy to get wrong and worth testing on its own. The rules,
 * and why each is where it is:
 *
 *   - A `"` at the *start* of a field opens a quoted field; anywhere else it is an ordinary
 *     character. Chrome quotes only what needs it, and a password containing a bare `"` in an
 *     unquoted field is something a hand-edited file really contains.
 *   - Inside quotes, `""` is one `"`, and `,`, `\r` and `\n` are data. This is the rule that stops
 *     field shift.
 *   - A closing quote followed by more text — `"a"b` — appends the text. Strictly that is malformed;
 *     every tolerant reader does this, and the alternative is discarding a record over a stray quote.
 *   - An *unterminated* quote runs to the end of the file and that field ends there. A truncated
 *     download then loses its last record instead of every record.
 *   - `\r\n`, `\n` and a lone `\r` all end a record, so a file written on any of the three platforms
 *     reads the same. Without the first, every last field would keep a carriage return.
 *   - A trailing newline does not make an empty final record, and a record of one empty field is
 *     dropped — that is what a blank line is.
 *
 * `null` when the row limit is reached, so the caller refuses the file rather than importing a
 * prefix of it.
 */
export function parseCsvRecords(text: string, maxRows: number = MAX_CSV_ROWS): string[][] | null {
  const records: string[][] = []
  let fields: string[] = []
  let field = ''
  let quoted = false
  let atFieldStart = true

  const endField = (): void => {
    fields.push(field)
    field = ''
    atFieldStart = true
  }
  const endRecord = (): boolean => {
    endField()
    const [only] = fields
    // A blank line is one empty field, and it is not a record. Dropping it here rather than in the
    // mapper keeps "how many rows did this file have" an answer about the file.
    if (!(fields.length === 1 && only === '')) records.push(fields)
    fields = []
    return records.length <= maxRows
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text.charAt(index)

    if (quoted) {
      if (character !== '"') {
        field += character
        continue
      }
      if (text.charAt(index + 1) === '"') {
        field += '"'
        index += 1
        continue
      }
      quoted = false
      continue
    }

    if (character === '"' && atFieldStart) {
      quoted = true
      atFieldStart = false
      continue
    }
    if (character === ',') {
      endField()
      continue
    }
    if (character === '\r' || character === '\n') {
      // `\r\n` is one separator, not two. Consuming the `\n` here is what keeps a Windows export from
      // producing an empty record between every pair of real ones.
      if (character === '\r' && text.charAt(index + 1) === '\n') index += 1
      if (!endRecord()) return null
      continue
    }
    atFieldStart = false
    field += character
  }

  // Whatever is left is the last record, unless the file ended on a separator. `field !== ''` covers
  // an unterminated quote too: the text collected so far is kept rather than thrown away.
  if (fields.length > 0 || field !== '') {
    if (!endRecord()) return null
  }
  return records
}

/**
 * Which column is which, by name.
 *
 * Case-insensitive and trimmed, because exporters disagree about both. `note` and `notes` are both
 * accepted: Chrome writes the first, some derivatives the second, and the column is dropped either
 * way — the only thing that changes is whether the user is told it was dropped.
 */
interface ColumnMap {
  readonly url: number
  readonly password: number
  /** `-1` when the file has none. An absent username column means every entry is nameless, which is legal. */
  readonly username: number
  readonly note: number
}

function mapColumns(header: readonly string[]): ColumnMap | null {
  const names = header.map((name) => name.trim().toLowerCase())
  const url = names.indexOf('url')
  const password = names.indexOf('password')
  if (url < 0 || password < 0) return null
  const note = names.indexOf('note')
  return {
    url,
    password,
    username: names.indexOf('username'),
    note: note >= 0 ? note : names.indexOf('notes')
  }
}

/**
 * One cell, or `''` when the row is short.
 *
 * `slice` rather than an index plus a guard, per the house rule, and short rows are *normal*: a file
 * whose last row lost its trailing commas is common, and treating a missing cell as empty means such
 * a row is refused for the reason that actually applies — no password — rather than crashing the
 * scan.
 */
function cellAt(row: readonly string[], index: number): string {
  if (index < 0) return ''
  const [value] = row.slice(index, index + 1)
  return value ?? ''
}

/**
 * Reads an exported CSV into credentials the save path will accept.
 *
 * Total: any input produces a report. A file that is not a password export at all comes back with
 * `refusal: 'unknown-columns'`, which the page can distinguish from "nothing in it was usable" — and
 * that distinction is the difference between "you picked the wrong file" and "your file was rejected
 * row by row".
 */
export function parseChromePasswordCsv(text: string): ChromeImportParse {
  if (text.length > MAX_CSV_LENGTH) return refused('too-large')

  /*
    The BOM is stripped once, here, before anything reads a column name. Left in place it would make
    the first header cell `\uFEFFname`, so `mapColumns` would fail and the file would be refused as
    "not a password export" — a true statement about the wrong thing.

    Written as the escape rather than as the character itself, and that is not style. This line used to
    read `text.startsWith('')` with the BOM pasted literally between the quotes — where an editor, a
    copy through a terminal or a `prettier` pass had eaten it, leaving an **empty string**. Since
    `''.startsWith('')` is always true, the first character of *every* imported file was discarded.
    Chrome's own export survived by luck: `name,url,…` became `ame,url,…`, and the columns that matter
    are found by name, so the damaged one was the one nothing needed. Firefox's export begins with
    `url`, so the damage landed on a column that is required and the whole file came back
    `unknown-columns` — "you picked the wrong file", about a file that was exactly right.

    An invisible character inside a string literal cannot be reviewed, which is the whole argument for
    the escape: a literal one is invisible in a diff, and `'\uFEFF'` is not.
  */
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text

  const records = parseCsvRecords(source)
  if (records === null) return refused('too-many-rows')
  const [header, ...rows] = records
  if (header === undefined) return refused('empty')
  const columns = mapColumns(header)
  if (columns === null) return refused('unknown-columns')
  if (rows.length === 0) return refused('empty')

  const credentials: SaveCredentialInput[] = []
  const skipped = noRowsSkipped()
  let notesDropped = 0

  for (const row of rows) {
    if (cellAt(row, columns.note) !== '') notesDropped += 1

    const rawUrl = cellAt(row, columns.url).trim()
    if (rawUrl === '') {
      skipped['no-url'] += 1
      continue
    }
    if (looksLikeSpreadsheetFormula(rawUrl)) {
      skipped['formula-url'] += 1
      continue
    }
    const origin = passwordOriginOf(rawUrl)
    if (origin === null) {
      skipped['unsupported-url'] += 1
      continue
    }

    // Not trimmed. A password's leading and trailing space is part of the password, and a manager
    // that helpfully removed it would store one that does not sign in.
    const password = cellAt(row, columns.password)
    if (password === '') {
      skipped['no-password'] += 1
      continue
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      // Refused, never cut. A truncated password looks stored and is not.
      skipped['password-too-long'] += 1
      continue
    }

    const username = cellAt(row, columns.username)
    if (username.trim().length > MAX_USERNAME_LENGTH) {
      skipped['username-too-long'] += 1
      continue
    }

    // The origin rather than the exported address: the path and query are dropped here, at the edge,
    // so nothing downstream ever holds the `?session=…` a login URL in an old export can carry.
    credentials.push({ url: origin, username, password })
  }

  return { credentials, skipped, notesDropped, refusal: null }
}

/** Total rows refused, for a sentence the page can show without enumerating reasons. */
export function totalSkipped(counts: RowRefusalCounts): number {
  return ROW_REFUSALS.reduce((sum, reason) => sum + counts[reason], 0)
}

// --- what an import did ------------------------------------------------------

/*
  The report lives here rather than beside the code that produces it, and for the usual reason: the
  passwords page has to render it and cannot see the main process. `main/passwords/import.ts` fills it
  in and holds the collision rules; this is only the shape both sides agree on.
*/

/** A collision worth reporting: an origin and a name, never a password. */
export interface ImportConflict {
  readonly origin: string
  readonly username: string
}

/**
 * How many conflicts are named back.
 *
 * A bound rather than the whole list, because the reply crosses IPC and lands in a page: a file
 * engineered to collide with everything would otherwise turn the report into a copy of the vault's
 * index. Fifty is more than anybody reconciles by hand, and `duplicatesConflicting` stays exact
 * regardless.
 */
export const MAX_REPORTED_CONFLICTS = 50

export interface ChromeImportResult {
  imported: number
  /** Already stored, byte for byte. Nothing to do. */
  duplicatesIdentical: number
  /** Already stored with a different password; the stored one was kept. See `import.ts`. */
  duplicatesConflicting: number
  /** Up to `MAX_REPORTED_CONFLICTS` of the above, so they can be reconciled. Never carries a secret. */
  conflicts: ImportConflict[]
  /** Rows the file itself made unusable. See `RowRefusal`. */
  skipped: RowRefusalCounts
  /** Rows that did not fit under `MAX_PASSWORD_CREDENTIALS`. */
  full: number
  /**
   * Rows the vault refused for a reason the parser had already ruled out.
   *
   * Should be zero, and counted rather than asserted: an unreachable branch that throws is a crash in
   * the middle of an import, and one that is silently ignored is a row that vanished. A non-zero number
   * here means the parser and the model have drifted apart, which is worth being able to see.
   */
  refusedByVault: number
  notesDropped: number
  /** Non-null means the file was refused whole and nothing was written. */
  refusal: CsvRefusal | null
}
