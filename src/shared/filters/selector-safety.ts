/**
 * Whether a cosmetic rule's payload is a CSS selector this browser can safely put in a stylesheet.
 *
 * ## The two problems this answers, which are one check
 *
 * **A batch of selectors is all-or-nothing.** `cosmeticCss` joins the selectors that apply to a
 * document into one CSS rule, because 28 914 generic selectors as 28 914 rules is a quarter of a
 * megabyte of repeated `{ display: none !important; }`. A CSS selector list is not forgiving: one
 * member the parser cannot read invalidates the *entire* rule. So a single unreadable selector does not
 * cost itself — it costs every selector it was sent with.
 *
 * That is not hypothetical. uBlock Origin's syntax puts three different things behind the same `##`
 * separator: plain hiding (`example.com##.ad-slot`), **scriptlet injection**
 * (`example.com##+js(set-constant, adsShown, true)`) and **procedural selectors**
 * (`example.com##.box:has-text(Anzeige)`). The parser recognised the separator and took the rest to be
 * a selector, so both of the latter were written into pages as CSS. `annoyances-others.txt` from
 * uAssets is on by default and is full of both, so on a great many sites the host-specific hiding
 * rules were computed, sent, injected and then dropped by the CSS parser on arrival — with nothing
 * anywhere reporting it.
 *
 * **A selector goes into a stylesheet verbatim.** The text comes from a file downloaded over the
 * network. `cosmeticCss` interpolates it straight into `<selector> { display: none !important; }`, so a
 * selector containing `}` closes the rule and everything after it is *stylesheet* rather than selector:
 * arbitrary CSS from a filter list, including `background: url(…)` on an attribute match, which is a
 * documented way to exfiltrate the value of an input field. No list ships that today. The reason to
 * refuse it here is that "no list ships that" is a statement about other people's files.
 *
 * ## Why an allowlist, and why fail-closed
 *
 * The check has no CSS engine to consult — this module is under `src/shared`, reachable from a renderer,
 * and `document.querySelector` exists in neither the main process nor a filter compile. So validity is
 * decided syntactically, and a syntactic decision is either too strict or too lax. Too strict drops a
 * working rule and under-blocks by one; too lax lets the batch die. Those are not the same size, so this
 * is an allowlist: constructs known to be CSS pass, everything else is refused and counted.
 *
 * Counted is the load-bearing half, and it is `parse.ts`'s own rule — spec 4's objection is to a blocker
 * that "understands a fraction of the syntax and discards the rest", where the discarding is what hurts.
 * A refusal here becomes a named line in `FilterListDiagnostics.unsupportedByReason`, so being too
 * strict is a number in the settings rather than a silence.
 */

/** Why a selector was refused. Stable strings: they are diagnostic keys the settings page lists. */
export type SelectorProblem =
  /** `+js(…)` — a scriptlet to run, not a selector to match. */
  | 'scriptlet'
  /** `:has-text()`, `:upward()`, `:style()` and friends: an operator no CSS engine implements. */
  | 'procedural-cosmetic'
  /**
   * `selector { declarations }` — a rule that restyles rather than hides.
   *
   * Its own reason because it is common enough to be worth naming and because the fix is a different
   * one: hiding is `display: none`, and these ask for `top: 0` on a sticky header or `height: 0` on a
   * reserved advert slot. EasyList writes 34 of them with a plain `##` separator, so they arrive by
   * this route rather than through `#$#`.
   *
   * They were the worst of the accepted-and-injected cases. `.header {top:0;}` written into
   * `<selectors> { display: none !important; }` does not merely fail — the CSS parser reads
   * `.header {top:0;}` as a *complete rule*, applies `top: 0` to `.header`, and then discards the
   * browser's own `{ display: none !important; }` and every selector that followed the offending one in
   * the batch. So one such line silently turned part of the batch into a restyling of the page.
   */
  | 'cosmetic-declaration'
  /** Anything else this check cannot vouch for. */
  | 'unsupported-selector'

/**
 * uBlock Origin's and Adblock Plus's procedural operators.
 *
 * Named separately from "unsupported" although both are refused, because the difference is the whole of
 * what the diagnostics are for: `procedural-cosmetic: 812` says *this browser lacks a feature the lists
 * use*, which is a thing to build. `unsupported-selector: 3` says *three lines look like nothing we
 * recognise*, which is a thing to go and read.
 *
 * `:remove()` and `:style()` are in here despite not being matchers at all — they are actions uBO
 * performs on what the rest of the selector found. They cannot be honoured by hiding, and treating them
 * as hiding would be wrong rather than merely incomplete: `:style(height: 0)` asks for a page's own
 * element to be reshaped, not for it to disappear.
 */
const PROCEDURAL_PSEUDOS: ReadonlySet<string> = new Set([
  'has-text',
  'contains',
  'matches-css',
  'matches-css-before',
  'matches-css-after',
  'matches-media',
  'matches-path',
  'matches-attr',
  'matches-prop',
  'min-text-length',
  'others',
  'upward',
  'watch-attr',
  'xpath',
  'shadow',
  'spath',
  'remove',
  'remove-attr',
  'remove-class',
  'style',
  // Adblock Plus's own spelling of the same ideas.
  '-abp-has',
  '-abp-contains',
  '-abp-properties',
  // uBO's older prefixed forms, still present in older list snapshots.
  '-ext-has',
  '-ext-contains',
  '-ext-matches-css'
])

/**
 * Functional pseudo-classes that are real CSS and that filter lists genuinely use.
 *
 * Tight on purpose. `:not()`, `:has()` and the `nth-` family are everywhere in EasyList and refusing
 * them to be safe would throw away tens of thousands of working rules to avoid a few hundred broken
 * ones — but the list stops at what is both standard and observed. `:matches()` and `:any()` are absent
 * deliberately: they are the historical prefixed spellings of `:is()`, no current engine takes them
 * unprefixed, and a rule using one is a rule that does not work anyway.
 */
const CSS_FUNCTIONAL_PSEUDOS: ReadonlySet<string> = new Set([
  'not',
  'is',
  'where',
  'has',
  'nth-child',
  'nth-last-child',
  'nth-of-type',
  'nth-last-of-type',
  'lang',
  'dir'
])

/**
 * Pseudo-classes and pseudo-elements that take no argument.
 *
 * Checked as well as the functional ones, because an unknown *bare* pseudo is just as fatal to the batch
 * as an unknown functional one — `:-abp-something` invalidates the rule exactly as `:has-text(x)` does.
 * The set is the standard vocabulary, which is finite and stable; anything outside it is refused and
 * counted rather than guessed at.
 */
const CSS_BARE_PSEUDOS: ReadonlySet<string> = new Set([
  // Structural.
  'root',
  'empty',
  'first-child',
  'last-child',
  'only-child',
  'first-of-type',
  'last-of-type',
  'only-of-type',
  'scope',
  // Interaction and state. A stylesheet may legitimately hide, say, a hovered overlay.
  'hover',
  'active',
  'focus',
  'focus-visible',
  'focus-within',
  'target',
  'visited',
  'link',
  'any-link',
  'enabled',
  'disabled',
  'checked',
  'indeterminate',
  'default',
  'valid',
  'invalid',
  'required',
  'optional',
  'in-range',
  'out-of-range',
  'read-only',
  'read-write',
  'placeholder-shown',
  'defined',
  'fullscreen',
  'popover-open',
  // Pseudo-elements. Written with one colon as well as two in older lists, which is why they are here
  // rather than in a set of their own: `:before` is legal CSS and means `::before`.
  'before',
  'after',
  'first-line',
  'first-letter',
  'selection',
  'placeholder',
  'marker',
  'backdrop',
  'file-selector-button'
])

/**
 * Characters that must never reach a stylesheet inside a selector.
 *
 * `{` and `}` are the injection: they end the selector and start a declaration block, so everything
 * after one is CSS of the list author's choosing. `;` and `@` are refused with them — a `@import` or an
 * at-rule smuggled through would be the same class of thing — and so is a comment opener, which could
 * swallow the browser's own declaration and leave the page unstyled by whatever followed.
 *
 * A selector legitimately containing any of these inside a quoted attribute value is possible in
 * principle (`[title="a}b"]`) and does not occur in any filter list. Refusing it costs one rule and is
 * counted; admitting it costs the guarantee.
 */
const FORBIDDEN_IN_SELECTOR = /[;@]|\/\*|\*\//

/** A declaration block, which means the payload restyles rather than hides. Reported as its own reason. */
const DECLARATION_BLOCK = /[{}]/

/**
 * The selector with everything that is *text* rather than structure neutralised.
 *
 * Two things have to be taken out of the way before a pattern may be believed, and both were found by
 * asking what real lists contain rather than by reasoning about CSS:
 *
 *   - **Escapes.** `.md\:flex` is the single class `md:flex`, which Tailwind produces and filter lists
 *     therefore carry. Scanned raw, the `\:flex` reads as a pseudo-class named `flex` and the rule is
 *     refused for a colon that is not one. `features.ts` has the same warning about `.\31 23`.
 *   - **Quoted values.** `[title=":hover"]` and `[data-x="a}b"]` are a string token to the CSS
 *     tokenizer, so neither the colon nor the brace is structure. Refusing them would be refusing valid
 *     CSS, and admitting them unscrubbed would be reading an attribute value as a selector.
 *
 * Both become `x`, one character per character, so offsets are preserved and nothing that survives can
 * be a false positive from either source. Callable only after `bracketsBalanced`, which is what
 * establishes that the quotes are terminated at all.
 */
function scrub(selector: string): string {
  let out = ''
  let quote: string | null = null

  for (let index = 0; index < selector.length; index++) {
    const character = selector[index]!
    if (character === '\\') {
      // The escape and what it escapes, both neutral. A hex escape (`\31 23`) has more characters
      // after it, but they are digits and a space — nothing this scan reacts to.
      out += 'xx'
      index += 1
      continue
    }
    if (quote !== null) {
      out += character === quote ? character : 'x'
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      out += character
      continue
    }
    out += character
  }

  return out
}

/**
 * Whether every `(`, `[` and quote has its partner, in order.
 *
 * An unbalanced selector cannot be parsed by anything, so this is the one check that has to run on the
 * raw text — it is what makes `scrub` above trustworthy, and an unterminated quote is refused here
 * rather than silently swallowing the rest of the selector.
 */
function bracketsBalanced(selector: string): boolean {
  const stack: string[] = []
  const partners: Readonly<Record<string, string>> = { ')': '(', ']': '[' }
  let quote: string | null = null

  for (let index = 0; index < selector.length; index++) {
    const character = selector[index]!
    if (character === '\\') {
      index += 1
      continue
    }
    if (quote !== null) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(' || character === '[') {
      stack.push(character)
      continue
    }
    const opener = partners[character]
    if (opener === undefined) continue
    if (stack.pop() !== opener) return false
  }

  return stack.length === 0 && quote === null
}

/**
 * The problem with this selector, or `null` if there is none.
 *
 * Called from two places on purpose. `parse.ts` calls it so a bad line is refused and counted at the
 * moment it is read, which is where the diagnostics can see it. `cosmeticCss` calls it again on the way
 * out, which is not redundancy: user rules, picked elements and a future list format all reach the
 * stylesheet by other routes, and the guarantee wanted is about what enters a page rather than about
 * what one parser accepted.
 */
export function selectorProblem(selector: string): SelectorProblem | null {
  const text = selector.trim()
  if (text === '') return 'unsupported-selector'

  // Checked before anything else, because a scriptlet is not a malformed selector — it is a different
  // kind of instruction, and saying so is more useful than "unsupported".
  if (text.startsWith('+js(')) return 'scriptlet'

  // First, and on the raw text: it is what establishes that the quotes below are terminated.
  if (!bracketsBalanced(text)) return 'unsupported-selector'

  const scrubbed = scrub(text)

  /*
    Both patterns are built here rather than kept at module scope. They are `/g`, so they carry a
    `lastIndex` between calls, and a shared one is a bug that only appears on the second selector —
    the kind that looks like a flaky test. Constructing two small regexes per selector is not the
    expensive part of compiling a filter list.

    The bare pattern needs *two* lookaheads and the first one is not obvious. `\b` is the natural way to
    say "the name ends here" and it is wrong: regex counts `-` as a non-word character while a CSS
    identifier counts it as part of the name. So on `:nth-child(2n)` the engine backtracked to `nth`,
    found the `\b` it wanted between `h` and `-`, saw that the next character was not `(`, and reported a
    bare pseudo-class called `nth` — refusing one of the most common selectors in EasyList. The
    identifier-character lookahead is what actually says "the name ends here".
  */
  const functionalPseudo = /::?([a-zA-Z-][a-zA-Z0-9-]*)\s*\(/g
  const barePseudo = /::?([a-zA-Z-][a-zA-Z0-9-]*)(?![a-zA-Z0-9-])(?!\s*\()/g

  let match: RegExpExecArray | null
  while ((match = functionalPseudo.exec(scrubbed)) !== null) {
    const name = match[1]!.toLowerCase()
    if (PROCEDURAL_PSEUDOS.has(name)) return 'procedural-cosmetic'
    if (!CSS_FUNCTIONAL_PSEUDOS.has(name)) return 'unsupported-selector'
  }

  while ((match = barePseudo.exec(scrubbed)) !== null) {
    const name = match[1]!.toLowerCase()
    // A procedural operator written without its parentheses is still one, and still not CSS.
    if (PROCEDURAL_PSEUDOS.has(name)) return 'procedural-cosmetic'
    if (!CSS_BARE_PSEUDOS.has(name)) return 'unsupported-selector'
  }

  /*
    The brace test runs *after* the pseudo scan, and the order is the whole difference between a
    diagnostic somebody can act on and one that sends them reading files.

    `:style(… !important; …)` carries a semicolon and a brace-free payload, so a forbidden-character
    test placed first reported 502 lines of uAssets' annoyances list as "unsupported-selector" — a
    reason that says "we do not recognise this at all" about the single most common procedural operator
    there is. Asking what the pseudo *is* first gets them all named `procedural-cosmetic`, which is a
    feature request rather than a mystery.
  */
  if (DECLARATION_BLOCK.test(scrubbed)) return 'cosmetic-declaration'
  if (FORBIDDEN_IN_SELECTOR.test(scrubbed)) return 'unsupported-selector'

  return null
}

/** Whether this selector may be written into a stylesheet. The positive form, for readability. */
export function isSafeSelector(selector: string): boolean {
  return selectorProblem(selector) === null
}
