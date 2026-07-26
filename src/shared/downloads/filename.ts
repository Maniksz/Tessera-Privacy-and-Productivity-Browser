/**
 * Turning a name a remote server chose into a name this machine may write.
 *
 * ## Why this is its own module, and pure
 *
 * The string it produces becomes a path on the user's disk. Everything else about a
 * download can go wrong and cost the download; this can go wrong and cost a file outside
 * the downloads directory. So it is separated from the Electron-bound half, has no
 * dependencies at all, and is total: every input produces a name that is safe to join onto
 * a directory. There is no failure mode where a caller must remember to check something.
 *
 * ## The input is hostile, not merely untidy
 *
 * A filename reaches us from three places, none of them trustworthy:
 *
 *   - the `Content-Disposition` header, which the server writes freely;
 *   - the last path segment of the URL, which the server also controls;
 *   - Chromium's own suggestion, which is derived from the first two.
 *
 * The case to be total about is `Content-Disposition: attachment; filename="../../.bashrc"`.
 * Joined naively onto the downloads directory that writes to the user's home. It is the
 * oldest bug in file transfer and it is still shipped regularly, because the naive code
 * looks exactly like the correct code.
 *
 * ## The traps, each with the reason it is not obvious
 *
 * **Decode before sanitising, never after.** `%2e%2e%2f` is `../`, and `..%252f` is
 * `..%2f`, which decodes again to `../`. Code that strips separators and *then*
 * percent-decodes has done nothing at all — the classic bypass, and the reason the order in
 * `safeDownloadFileName` is fixed and commented rather than incidental. Decoding repeats
 * until the string stops changing, so a doubly-encoded traversal cannot survive by arriving
 * one layer deeper than the single decode we happened to write.
 *
 * **Both separators, on every platform.** `..\..\evil` traverses on Windows and is a
 * perfectly legal *filename character* on Linux — so a Linux build that only stripped `/`
 * would write a file literally called `..\..\evil`, which traverses the moment that profile
 * is opened on Windows or the file is copied there. The rule cannot be per-platform,
 * because the data outlives the platform.
 *
 * **A leading dot is not decoration.** `.bashrc` is invisible in every file manager the
 * user might look in, so a download that lands as one is a file the user cannot see, cannot
 * find, and did not ask for. Stripped, so the download is visible.
 *
 * **Windows device names.** `CON`, `NUL`, `COM1` and friends address a device rather than a
 * file, with or without an extension — opening `CON.txt` on Windows does not open a text
 * file. Prefixed rather than rejected, because `aux.pdf` is a legitimate name a person
 * might have.
 *
 * **Trailing dots and spaces.** Windows silently discards them when creating a file, so
 * `evil.exe.` becomes `evil.exe` on disk. Any check performed on the untrimmed string is
 * therefore a check on a name that will not exist, which is how an extension allowlist gets
 * bypassed.
 *
 * **Bidirectional overrides.** A name carrying U+202E renders its tail reversed, so
 * `invoice<RLO>gnp.exe` is drawn as `invoiceexe.png` by every list that shows it, ours
 * included. The extension the user believes they are opening is not the one the operating
 * system will use. Those characters are removed, so the name reads the way it behaves.
 *
 * **Truncation keeps the extension.** Cutting a long name at a fixed length usually removes
 * the extension, and on every desktop platform the extension is what decides which
 * application opens the file. So the stem is shortened and the extension kept.
 */

/**
 * Longest name written to disk.
 *
 * Filesystems allow 255 bytes; this is well inside that even for names made of three-byte
 * characters, and leaves room for the `-2` a duplicate gets.
 */
export const MAX_DOWNLOAD_FILE_NAME_LENGTH = 120

/** Longest extension kept when a name is truncated. Beyond this it is not an extension. */
const MAX_EXTENSION_LENGTH = 16

/** Used when nothing usable survives sanitising. */
export const FALLBACK_DOWNLOAD_FILE_NAME = 'download'

/** Punctuation Windows refuses in a filename, plus both path separators. */
const RESERVED_PUNCTUATION = '/\\<>:"|?*'

/**
 * Whether one character must not reach a filesystem.
 *
 * Written as named code-point ranges rather than as a character class, and that is a
 * deliberate choice about *reviewability*: a character class made of literal bidi and
 * control bytes looks identical to a correct one in every editor, so nobody can check it by
 * reading. Each range below is here for a specific attack and says which.
 */
function isUnsafeCharacter(character: string): boolean {
  const code = character.codePointAt(0) ?? 0
  // C0 controls and DEL. A newline in a filename breaks every log line that mentions it,
  // and NUL truncates the name inside any C library it reaches.
  if (code < 0x20 || code === 0x7f) return true
  // LEFT-TO-RIGHT MARK, RIGHT-TO-LEFT MARK.
  if (code === 0x200e || code === 0x200f) return true
  // The bidirectional embedding and override characters, U+202A..U+202E.
  if (code >= 0x202a && code <= 0x202e) return true
  // The bidirectional isolates, U+2066..U+2069 — the modern spelling of the same trick.
  if (code >= 0x2066 && code <= 0x2069) return true
  return RESERVED_PUNCTUATION.includes(character)
}

/**
 * Replaces every unsafe character with an underscore.
 *
 * Iterated by code point, so a character outside the basic plane — an emoji in a filename
 * is ordinary now — is examined once rather than as two lone surrogates that would each
 * fail a range check.
 */
function replaceUnsafeCharacters(name: string): string {
  /*
    `Intl.Segmenter` rather than `[...name]`.

    Both iterate by code point, which is what the docblock above is about — but a spread also splits a grapheme
    cluster, so a flag or a family emoji becomes several characters and a range check sees pieces of one symbol.
    Segmenting by grapheme keeps a user-perceived character whole, which is the unit a filename is read in.
  */
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  return [...segmenter.segment(name)]
    .map(({ segment }) => (isUnsafeCharacter(segment) ? '_' : segment))
    .join('')
}

/** Windows device names, which are names rather than paths and so cannot be escaped. */
const WINDOWS_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9'
])

/**
 * Percent-decodes until the string stops changing.
 *
 * Bounded, because an unbounded decode loop over attacker-controlled input is itself a
 * denial of service: a long run of `%25` shrinks by one layer per pass. Four passes is far
 * more nesting than any real name has, and it terminates in constant time.
 */
function fullyDecode(raw: string): string {
  let current = raw
  for (let pass = 0; pass < 4; pass += 1) {
    let next: string
    try {
      next = decodeURIComponent(current)
    } catch {
      // A stray `%` is not worth losing the name over — `100%_done.pdf` is a real filename.
      return current
    }
    if (next === current) return current
    current = next
  }
  return current
}

/** The stem and extension of a name, with the dot dropped. */
function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and a name that is *only* an extension, where the
  // dot sits at position zero and the stem would be empty.
  if (dot <= 0) return { stem: name, extension: '' }
  const extension = name.slice(dot + 1)
  if (extension.length > MAX_EXTENSION_LENGTH) return { stem: name, extension: '' }
  return { stem: name.slice(0, dot), extension }
}

/**
 * A name that is safe to join onto a directory.
 *
 * Guarantees, every one of them relied upon by `resolveSavePath`: no path separator, no `.`
 * or `..`, no leading dot, no control or bidirectional character, no Windows device name, no
 * trailing dot or space, and a length under `MAX_DOWNLOAD_FILE_NAME_LENGTH`. Never empty.
 */
export function safeDownloadFileName(raw: string): string {
  // Decode first. Sanitising before decoding is the bypass this whole module exists to
  // avoid; see the header.
  const decoded = fullyDecode(raw)

  // Only the last segment can be a filename. Splitting on both separators is what turns
  // `../../.bashrc` into `.bashrc` and `..\..\evil` into `evil` — structurally, rather than
  // by hunting for the string `..`.
  const [lastSegment] = decoded.split(/[/\\]/).slice(-1)

  const cleaned = replaceUnsafeCharacters(lastSegment ?? '')
    // Leading dots and spaces: a hidden file, or a name Windows will not create.
    .replace(/^[.\s]+/, '')
    // Trailing dots and spaces, which Windows silently drops from the name it creates.
    .replace(/[.\s]+$/, '')
    .replace(/_{2,}/g, '_')

  /*
    A name that survived only as replacement characters carries no information.

    Treated as nothing, so `downloadFileNameFor` moves on to the next candidate rather than
    calling a perfectly identifiable file `_`. Without this, a header of three NUL bytes would
    beat the good name in the URL — a worse outcome than the header having been absent.
  */
  if (cleaned === '' || /^_+$/.test(cleaned)) return FALLBACK_DOWNLOAD_FILE_NAME

  const { stem, extension } = splitExtension(cleaned)

  // A device name with or without an extension. `_con.txt` is an ordinary file.
  const safeStem = WINDOWS_DEVICE_NAMES.has(stem.toLowerCase()) ? `_${stem}` : stem

  const suffix = extension === '' ? '' : `.${extension}`
  // The extension survives truncation, because it is what decides which application opens
  // the file. The subtraction cannot reach zero: `MAX_EXTENSION_LENGTH` is far below the
  // overall limit.
  const truncated = safeStem.slice(0, MAX_DOWNLOAD_FILE_NAME_LENGTH - suffix.length)
  // Truncation can expose a trailing dot or space again, and can empty a stem that was
  // nothing but an over-long extension.
  const settled = `${truncated}${suffix}`.replace(/[.\s]+$/, '')
  return settled === '' ? FALLBACK_DOWNLOAD_FILE_NAME : settled
}

/**
 * The filename a `Content-Disposition` header names, exactly as written.
 *
 * Parsing and sanitising are separate on purpose: the sanitiser stays the single choke
 * point, so a second parser added later — for a header form this one does not handle —
 * cannot bypass it by returning a name that looks already safe.
 *
 * `filename*` wins over `filename` when both are present, which is what RFC 6266 requires:
 * a server sending both intends the extended form and offers the plain one as a fallback for
 * clients that cannot read it. Preferring the plain one would mean taking a name that was
 * deliberately mangled — servers commonly send `filename="_____.pdf"` beside a correct
 * `filename*=UTF-8''Rechnung.pdf`.
 */
export function parseContentDispositionFilename(header: string): string | null {
  const extended = /filename\*\s*=\s*([^;]+)/i.exec(header)
  if (extended !== null) {
    const value = (extended[1] ?? '').trim()
    /*
      The form is `charset'language'value`.

      The charset is ignored: `decodeURIComponent` produces UTF-8, and honouring a declared
      ISO-8859-1 would mean shipping a decoder for a charset nobody sends, driven by a label
      nobody validated. Taking the text after the last quote also handles the malformed
      `UTF-8''` that some servers write with no language part.
    */
    const lastQuote = value.lastIndexOf("'")
    const encoded = lastQuote === -1 ? value : value.slice(lastQuote + 1)
    if (encoded !== '') return encoded
  }

  const quoted = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i.exec(header)
  if (quoted !== null) {
    /*
      Only `\"` and `\\` are unescaped, not every `\X`.

      RFC 6266's quoted-string permits `\` before any character, but the only two that *need*
      escaping are the quote and the backslash itself — and real servers routinely send an
      unescaped Windows path, `filename="C:\folder\report.pdf"`. Unescaping `\f` there would
      merge the path into one blob, `Cfolderreport.pdf`, instead of leaving the separators for
      the sanitiser to split on and take the last segment. So the general rule is dropped in
      favour of the two cases it exists for, and a path stays a path.

      Found by the traversal test: `"..\..\Windows\System32\evil.exe"` came out safe either way,
      but as `WindowsSystem32evil.exe` rather than `evil.exe`.
    */
    const value = (quoted[1] ?? '').replace(/\\(["\\])/g, '$1')
    if (value !== '') return value
  }

  const bare = /filename\s*=\s*([^;"\s]+)/i.exec(header)
  const value = (bare?.[1] ?? '').trim()
  return value === '' ? null : value
}

/** Everything that can name a download, in the order it should be believed. */
export interface DownloadNameSources {
  /**
   * What Chromium suggested. Believed *first*, because it has already reconciled the header,
   * the address and the MIME type — but never believed *blindly*, which is the point of
   * running it through the sanitiser like everything else.
   */
  suggested?: string
  /** The raw header, when the caller has it. Parsed here, not by the caller. */
  contentDisposition?: string
  url?: string
}

/**
 * The name a download is written under.
 *
 * Every path through this function ends at `safeDownloadFileName`, so there is no way out of
 * it that returns an unsanitised string. That property is structural rather than a
 * convention, and it is what the tests assert: the sanitiser is applied on the way out,
 * once, to whichever candidate won.
 */
export function downloadFileNameFor(sources: DownloadNameSources): string {
  const header = sources.contentDisposition ?? ''
  const fromHeader = header === '' ? null : parseContentDispositionFilename(header)

  const candidates = [sources.suggested ?? '', fromHeader ?? '', lastUrlSegment(sources.url ?? '')]
  for (const candidate of candidates) {
    if (candidate.trim() === '') continue
    const safe = safeDownloadFileName(candidate)
    // The fallback means this candidate sanitised away to nothing, so the next one gets a
    // turn: a hostile header should not cost the perfectly good name in the URL.
    if (safe !== FALLBACK_DOWNLOAD_FILE_NAME) return safe
  }
  return FALLBACK_DOWNLOAD_FILE_NAME
}

/**
 * The last path segment of an address, still encoded.
 *
 * Still encoded deliberately: `safeDownloadFileName` decodes, and doing it here as well
 * would put a second decode outside the module that owns the ordering rule.
 */
function lastUrlSegment(url: string): string {
  let pathname: string
  try {
    pathname = new URL(url).pathname
  } catch {
    return ''
  }
  const [segment] = pathname.split('/').slice(-1)
  return segment ?? ''
}
