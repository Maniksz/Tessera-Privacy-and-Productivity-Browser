/**
 * Procedural cosmetic selectors — `:has-text()`, `:upward()`, `:style()` and the rest of the family that
 * no CSS engine can evaluate.
 *
 * ## Why they cannot be CSS
 *
 * A cosmetic rule is normally a selector handed to the browser: `example.com##.ad-slot` becomes a
 * stylesheet and the engine does the matching. Some things a filter author needs cannot be expressed that
 * way at all — "the box that contains the word *Anzeige*", "the container two levels above this image",
 * "the element whose computed position is fixed". So uBlock Origin and AdGuard both grew a small
 * *procedural* language: a CSS selector to start from, then a chain of steps that transform the set of
 * elements, evaluated in the page by script.
 *
 * ## Where the syntax comes from
 *
 * Read off both implementations rather than invented, because a filter list is written against theirs:
 *
 *   - uBO, *Procedural cosmetic filters*: operators chain left to right, a plain CSS selector may precede
 *     the chain, and the action operators come last.
 *   - AdGuard, *ExtendedCss*: the same idea with `:contains()` where uBO writes `:has-text()`, and the
 *     same rule that an extended pseudo-class belongs after the standard part —
 *     `div[class="ad"]:has(img)` is valid, `div:has(img)[class="ad"]` is not.
 *
 * Both are honoured: `:contains()` is accepted as a spelling of `:has-text()`, because a user pasting a
 * rule from an AdGuard list should not have to know which of the two they are holding.
 *
 * ## What is implemented, chosen by measurement
 *
 * Counted over the three lists this browser ships with, ignoring `:has()`, `:not()`, `:is()` and
 * `:nth-of-type()` — those are ordinary CSS now and the declarative path already handles them:
 *
 * | operator | uses | |
 * |---|---|---|
 * | `:style(…)` | 537 | restyle instead of hide |
 * | `:has-text(…)` / `:contains(…)` | 101 | the one people write by hand |
 * | `:remove()` | 34 | take the element out |
 * | `:remove-attr(…)` | 24 | also as a `/regex/`, for a name a site randomises |
 * | `:upward(…)` | 11 | the container of a thing |
 * | `:remove-class(…)` | 10 | also as a `/regex/` |
 * | `:matches-css(…)` | 1 | |
 *
 `:min-text-length()` is in as well — it costs three lines and pairs with `:has-text()` in hand-written
 * rules.
 *
 * Measured end to end after the fact rather than predicted: of the 897 procedural rules in those three
 * lists, **876 are honoured and 21 are refused**. The refusals, each counted by its own name:
 * `:-abp-properties()` 6, `:xpath()` 6, a procedural operator nested inside a CSS `:has()` 4, CSS written
 * *after* the chain 3, `:-abp-has()` 1, `:watch-attr()` 1.
 *
 * `:watch-attr()` is the one whose absence costs nothing: it exists to force re-evaluation when an attribute
 * changes, and the matcher already re-runs on attribute mutations. `:matches-attr()`, `:matches-prop()`,
 * `:matches-media()`, `:others()` and `:not()` with a procedural argument are unimplemented too and appear
 * in these lists not at all.
 *
 * ## One shape only: CSS first, then the chain
 *
 * uBO allows CSS *after* a procedural step as well. This does not, and refuses such a rule rather than
 * half-honouring it. The reason is not effort — it is that the refusal is countable and a partial
 * implementation is not: a rule read as `.a:has-text(x)` when it said `.a:has-text(x) .b` hides the wrong
 * element, on a page nobody is testing. AdGuard's own documentation states the same restriction as the
 * rule of its syntax, so this is the common subset of the two rather than a reduction of both.
 *
 * ## Zod-free
 *
 * Like the rest of this directory: the settings page renders the user's own rules, so it imports these
 * types at runtime.
 */

/** A step that narrows or moves the set of elements. */
export type ProceduralStep =
  /** Keep elements whose text matches. uBO's `:has-text()`, AdGuard's `:contains()`. */
  | { readonly op: 'has-text'; readonly pattern: string }
  /** Keep elements with at least this much text — pairs with `has-text` to skip empty wrappers. */
  | { readonly op: 'min-text-length'; readonly length: number }
  /** Move to the nearest ancestor: `n` levels up, or the closest one matching a selector. */
  | { readonly op: 'upward'; readonly levels: number | null; readonly selector: string | null }
  /** Keep elements whose *computed* style has this property/value. */
  | { readonly op: 'matches-css'; readonly property: string; readonly value: string }

/**
 * What to do with whatever the chain selected.
 *
 * `hide` is the default and is not written in a rule — it is what a cosmetic rule means. The other three
 * are uBO's *action* operators, and both implementations require them last, which is why they are a
 * separate field rather than another step: an action in the middle of a chain has no meaning, and making
 * that unrepresentable is better than checking for it.
 */
export type ProceduralAction =
  | { readonly kind: 'hide' }
  /** `:style(…)` — apply these declarations instead of hiding. */
  | { readonly kind: 'style'; readonly declarations: string }
  /** `:remove()` — take the element out of the document. */
  | { readonly kind: 'remove' }
  /**
   * `:remove-attr(a|b)` / `:remove-class(a|b)`, or a `/regex/` matched against the names present.
   *
   * Both forms because both occur: the lists carry `:remove-attr(/oncontextmenu|onselectstart/)` and
   * `:remove-class(/scroll-block--is-blocked/)`, and the regular expression is the form that matters for the
   * case these rules exist for — a class or attribute whose name a site randomises per session cannot be
   * named literally. Refusing it reported three real rules as malformed, which they are not.
   */
  | { readonly kind: 'remove-attr'; readonly names: readonly string[]; readonly pattern: string | null }
  | {
      readonly kind: 'remove-class'
      readonly names: readonly string[]
      readonly pattern: string | null
    }

export interface ProceduralSelector {
  /** The plain CSS the chain starts from. Never empty: a chain with no starting set matches nothing. */
  readonly css: string
  readonly steps: readonly ProceduralStep[]
  readonly action: ProceduralAction
}

/** A procedural rule from a list or from the user, scoped like any cosmetic rule. */
export interface ProceduralRule {
  readonly selector: ProceduralSelector
  /** The line as written, so the settings page can show the user their own rule back. */
  readonly text: string
  /** Hosts the rule names. Never empty — see `PROCEDURAL_NEEDS_HOST`. */
  readonly includeHosts: readonly string[]
  readonly excludeHosts: readonly string[]
}

/**
 * Why a procedural selector was refused, as a diagnostic key.
 *
 * `procedural-unimplemented:<name>` carries the operator, the way `scriptlet-unimplemented:` does, so the
 * counter answers *which* one is missing instead of only how many.
 */
export type ProceduralProblem =
  | 'procedural-generic'
  | 'procedural-no-css-prefix'
  | 'procedural-trailing-css'
  | 'procedural-bad-argument'
  | `procedural-unimplemented:${string}`

/**
 * uBlock Origin refuses a procedural filter that names no host, and so does this.
 *
 * Not copied for the sake of compatibility. A procedural rule is evaluated by *script*, on every matching
 * document, and re-evaluated on every mutation burst — so a generic one is that work on every page the
 * user opens for the rest of the session. One badly written generic rule would be a browser that feels
 * broken, with nothing on screen to connect it to a filter list. The host requirement is what keeps the
 * cost proportional to the rule.
 */
export const PROCEDURAL_NEEDS_HOST = true

/** Every operator this file recognises, implemented or not, so a plain CSS selector is not mistaken for one. */
const PROCEDURAL_OPERATORS: ReadonlySet<string> = new Set([
  'has-text',
  'contains',
  'min-text-length',
  'upward',
  'matches-css',
  'matches-css-before',
  'matches-css-after',
  'style',
  'remove',
  'remove-attr',
  'remove-class',
  // Recognised and refused, each counted with its name.
  'xpath',
  'watch-attr',
  'matches-path',
  'matches-attr',
  'matches-prop',
  'matches-media',
  'others',
  'void',
  'spath',
  '-abp-properties',
  '-abp-contains',
  '-abp-has',
  '-ext-contains',
  '-ext-has',
  '-ext-matches-css'
])

/** Whether this selector is procedural at all — i.e. whether the engine has to be involved. */
export function isProceduralSelector(selector: string): boolean {
  return operatorNamesIn(selector).length > 0
}

/** Operator names appearing at the top level of a selector, in order. */
function operatorNamesIn(selector: string): string[] {
  const names: string[] = []
  for (const part of splitTopLevel(selector)) {
    if (part.kind === 'operator' && PROCEDURAL_OPERATORS.has(part.name)) names.push(part.name)
  }
  return names
}

type TopLevelPart =
  | { kind: 'css'; text: string }
  | { kind: 'operator'; name: string; argument: string }

/**
 * Splits a selector into plain-CSS runs and top-level `:name(argument)` groups.
 *
 * "Top level" is the load-bearing word. `div:has(.a:has-text(b))` has one top-level operator — `has` —
 * and the `has-text` inside it belongs to that argument, not to the chain. A scan that ignored nesting
 * would read the inner one as a step and evaluate it against the wrong set of elements.
 *
 * Quotes and escapes are respected for the reason `selector-safety.ts` gives at length: `[title=":has"]`
 * is a string, and `.md\:flex` is a class whose name contains a colon.
 */
function splitTopLevel(selector: string): TopLevelPart[] {
  const parts: TopLevelPart[] = []
  let css = ''
  let index = 0

  const flushCss = (): void => {
    if (css !== '') parts.push({ kind: 'css', text: css })
    css = ''
  }

  while (index < selector.length) {
    const character = selector[index]!

    if (character === '\\') {
      css += selector.slice(index, index + 2)
      index += 2
      continue
    }
    if (character === '"' || character === "'") {
      const end = closingQuote(selector, index)
      css += selector.slice(index, end + 1)
      index = end + 1
      continue
    }
    if (character === '[') {
      const end = matchingBracket(selector, index, '[', ']')
      if (end === -1) {
        css += selector.slice(index)
        break
      }
      css += selector.slice(index, end + 1)
      index = end + 1
      continue
    }
    if (character === ':') {
      const name = /^::?([a-zA-Z-][a-zA-Z0-9-]*)\(/.exec(selector.slice(index))
      if (name !== null) {
        const open = index + name[0].length - 1
        const close = matchingBracket(selector, open, '(', ')')
        if (close === -1) {
          css += selector.slice(index)
          break
        }
        flushCss()
        parts.push({
          kind: 'operator',
          name: name[1]!.toLowerCase(),
          argument: selector.slice(open + 1, close)
        })
        index = close + 1
        continue
      }
    }

    css += character
    index += 1
  }

  flushCss()
  return parts
}

function closingQuote(text: string, start: number): number {
  const quote = text[start]!
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') {
      index += 1
      continue
    }
    if (text[index] === quote) return index
  }
  return text.length - 1
}

function matchingBracket(text: string, start: number, open: string, close: string): number {
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const character = text[index]!
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '"' || character === "'") {
      index = closingQuote(text, index)
      continue
    }
    if (character === open) depth += 1
    else if (character === close) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

const ACTION_OPERATORS: ReadonlySet<string> = new Set([
  'style',
  'remove',
  'remove-attr',
  'remove-class'
])

/**
 * The operators this build can actually evaluate.
 *
 * Kept apart from `PROCEDURAL_OPERATORS`, which is every spelling *recognised* — including the ones refused
 * by name. Two sets rather than one, because they answer different questions: "is this selector procedural at
 * all" has to include the unimplemented ones or a `:xpath()` rule would be handed to the CSS parser, and "can
 * this be honoured" must not.
 */
const IMPLEMENTED_OPERATORS: ReadonlySet<string> = new Set([
  'has-text',
  'contains',
  '-abp-contains',
  '-ext-contains',
  'min-text-length',
  'upward',
  'matches-css',
  ...ACTION_OPERATORS
])

/**
 * A procedural selector, or the reason it cannot be honoured.
 *
 * Returns the problem rather than `null` so the caller can count it by name — the rule the whole of
 * `parse.ts` is built on. A selector with no procedural operator in it is not this function's business
 * and yields `procedural-no-css-prefix`; ask `isProceduralSelector` first.
 */
export function parseProceduralSelector(
  selector: string
): ProceduralSelector | { readonly problem: ProceduralProblem } {
  const parts = splitTopLevel(selector.trim())

  /*
    The CSS prefix, and the shape this accepts: every plain-CSS run must come before every procedural
    operator. A `css` part appearing after one is uBO's "CSS after a procedural step", which is refused
    whole — see the docblock for why a partial reading is worse than a counted refusal.
  */
  const css: string[] = []
  const operators: Array<{ name: string; argument: string }> = []
  for (const part of parts) {
    if (part.kind === 'css') {
      if (operators.length > 0) return { problem: 'procedural-trailing-css' }
      css.push(part.text)
      continue
    }
    // A non-procedural functional pseudo — `:has(.a)`, `:not(.b)`, `:nth-child(2n)` — is ordinary CSS and
    // belongs in the prefix, not in the chain.
    if (!PROCEDURAL_OPERATORS.has(part.name)) {
      if (operators.length > 0) return { problem: 'procedural-trailing-css' }
      css.push(`:${part.name}(${part.argument})`)
      continue
    }
    operators.push({ name: part.name, argument: part.argument })
  }

  /*
    An unimplemented operator is reported *before* the prefix is checked, and that order was wrong first
    time round.

    The lists carry eleven rules like `example.com##:xpath('//*[contains(text(),"Adblock")]')` and
    `example.com##:-abp-properties(data:)` — an operator with no CSS in front of it, because for those two
    operators the whole selector *is* the operator. Checking the prefix first reported all eleven as
    `procedural-no-css-prefix`, which is a true statement about the text and a misleading one about the
    reason: it reads as "this rule is malformed" when what it means is "this browser has no `:xpath()`".
    The counters exist so the next thing worth building is a number somebody can read, and a wrong name
    defeats that more thoroughly than a missing one.
  */
  for (const operator of operators) {
    if (!IMPLEMENTED_OPERATORS.has(operator.name)) {
      return { problem: `procedural-unimplemented:${operator.name}` }
    }
  }

  const prefix = css.join('').trim()
  if (prefix === '') return { problem: 'procedural-no-css-prefix' }
  if (operators.length === 0) return { problem: 'procedural-no-css-prefix' }

  const steps: ProceduralStep[] = []
  let action: ProceduralAction = { kind: 'hide' }

  for (const [position, operator] of operators.entries()) {
    const isLast = position === operators.length - 1

    if (ACTION_OPERATORS.has(operator.name)) {
      /*
        Both implementations require an action last, and this enforces it rather than tolerating it. An
        action in the middle would have to mean "restyle these, then keep filtering from them", which
        neither uBO nor AdGuard defines — so honouring it would be inventing semantics a list author
        cannot have intended.
      */
      if (!isLast) return { problem: 'procedural-bad-argument' }
      const parsed = parseAction(operator.name, operator.argument)
      if (parsed === null) return { problem: 'procedural-bad-argument' }
      action = parsed
      continue
    }

    const step = parseStep(operator.name, operator.argument)
    if (step === null) {
      return { problem: `procedural-unimplemented:${operator.name}` }
    }
    if (step === 'bad-argument') return { problem: 'procedural-bad-argument' }
    steps.push(step)
  }

  return { css: prefix, steps, action }
}

/** A step, `null` for an operator this build does not implement, or the sentinel for a bad argument. */
function parseStep(name: string, argument: string): ProceduralStep | null | 'bad-argument' {
  switch (name) {
    // AdGuard writes `:contains()` where uBO writes `:has-text()`. The same operator; a user pasting a
    // rule should not have to know which list it came from.
    case 'has-text':
    case 'contains':
    case '-abp-contains':
    case '-ext-contains':
      return argument.trim() === '' ? 'bad-argument' : { op: 'has-text', pattern: argument.trim() }

    case 'min-text-length': {
      const length = Number(argument.trim())
      if (!Number.isInteger(length) || length < 0) return 'bad-argument'
      return { op: 'min-text-length', length }
    }

    case 'upward': {
      const text = argument.trim()
      if (text === '') return 'bad-argument'
      if (/^\d+$/.test(text)) {
        const levels = Number(text)
        // uBO's own bound. Zero would mean "this element", which is what no operator at all means, and a
        // very large number is a rule that always reaches `<html>` — neither is a rule anybody wrote.
        if (levels < 1 || levels > 255) return 'bad-argument'
        return { op: 'upward', levels, selector: null }
      }
      return { op: 'upward', levels: null, selector: text }
    }

    case 'matches-css':
    case 'matches-css-before':
    case 'matches-css-after': {
      /*
        `:matches-css(position: fixed)`. Only the plain form is implemented: the `-before` and `-after`
        variants test a *pseudo-element's* computed style, which is a different call, and there is one use
        of the whole family in the three default lists. Refused by name rather than silently treated as
        the plain form, which would test the wrong element.
      */
      if (name !== 'matches-css') return null
      const separator = argument.indexOf(':')
      if (separator <= 0) return 'bad-argument'
      const property = argument.slice(0, separator).trim()
      const value = argument.slice(separator + 1).trim()
      if (property === '' || value === '') return 'bad-argument'
      return { op: 'matches-css', property, value }
    }

    default:
      return null
  }
}

function parseAction(name: string, argument: string): ProceduralAction | null {
  switch (name) {
    case 'style': {
      const declarations = argument.trim()
      if (declarations === '') return null
      /*
        A brace would end the declaration list. These are applied through `style.cssText`, which parses
        declarations only and cannot escape into a rule — so this is belt and braces rather than the only
        guard, and it costs one test.
      */
      if (declarations.includes('{') || declarations.includes('}')) return null
      return { kind: 'style', declarations }
    }
    case 'remove':
      // `:remove()` takes no argument. One with an argument is a rule this does not understand.
      return argument.trim() === '' ? { kind: 'remove' } : null
    case 'remove-attr':
    case 'remove-class': {
      const text = argument.trim()
      /*
        A `/regex/` is one pattern, not a list. Split on `|` first and it becomes two broken halves —
        `/oncontextmenu` and `onselectstart/` — each of which fails the identifier test, which is how three
        valid rules came to be counted as malformed.
      */
      if (text.startsWith('/') && text.endsWith('/') && text.length > 2) {
        return name === 'remove-attr'
          ? { kind: 'remove-attr', names: [], pattern: text }
          : { kind: 'remove-class', names: [], pattern: text }
      }
      const names = text
        .split(/[|,]/)
        .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
        .filter((entry) => entry !== '' && /^[A-Za-z_-][\w:-]*$/.test(entry))
      if (names.length === 0) return null
      return name === 'remove-attr'
        ? { kind: 'remove-attr', names, pattern: null }
        : { kind: 'remove-class', names, pattern: null }
    }
    default:
      return null
  }
}
