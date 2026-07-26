/**
 * Whether an id or a class name is worth building a filter rule out of.
 *
 * This is the part of an element picker that decides whether the rule the user
 * confirms today still blocks anything tomorrow. `#comment-4711` is an id, and it is
 * useless: the next comment gets a different number. `.css-1a2b3c` is a class, and it
 * is worse than useless — Emotion rehashes it on the next deployment, so the rule
 * silently stops matching and the advertising comes back with nothing to say why.
 *
 * The criterion is a set of independent signals, any one of which is enough to
 * refuse, and the reason each one is safe to apply aggressively is the **asymmetry of
 * the two mistakes**:
 *
 *   - Refusing a name that would in fact have been stable costs a longer selector.
 *     The picker falls through to classes, to an ancestor, or in the worst case to a
 *     positional step — uglier, still working today.
 *   - Accepting a generated name costs a rule that works when it is created, is
 *     confirmed by the user because it visibly works, and then quietly stops. That is
 *     the failure the user cannot diagnose and the one this file exists to prevent.
 *
 * So every signal is tuned to refuse on suspicion. What must not happen is silence:
 * each refusal carries a named reason, so the picker can say "this id looks
 * generated" instead of producing a mysteriously long selector.
 *
 * Deliberately not attempted: recognising the framework. There is no reliable way to
 * tell Emotion from a hand-written hash, and a build that guessed wrong would apply a
 * different rule to the same markup. The signals are all properties of the name
 * itself, which is the only evidence that is actually present.
 */

export type IdentifierVerdict =
  | 'usable'
  /** Empty, or not a CSS identifier without escaping — React's `useId` (`:r0:`). */
  | 'not-an-identifier'
  /** One character: what a CSS minifier emits, never what a person writes. */
  | 'too-short'
  /** Three or more digits in a row: a counter, a timestamp or a hash. */
  | 'digit-run'
  /** Ends in digits: `ember1`, `mat-input-3`, `cdk-overlay-0`, `comment-2`. */
  | 'counter-suffix'
  /** A part that reads as a hash rather than as words: `1a2b3c`, `hXpVsL`. */
  | 'hash-like'
  /** A known build-tool prefix, whatever follows it. */
  | 'framework-prefix'
  /** Describes state rather than identity, so it changes as the user interacts. */
  | 'state-name'

/**
 * A CSS identifier that needs no escaping in a selector.
 *
 * Anything else has to be written `#\:r0\:`, and a filter list carrying an escape is
 * a filter list this engine will not key (see `features.ts`). Refusing it here keeps
 * the picker from producing a rule the rest of the pipeline treats as unkeyable.
 */
const PLAIN_IDENTIFIER = /^-?[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff-]*$/

/** Three digits in a row. Two is a section number; three is a counter. */
const DIGIT_RUN = /\d{3}/

/** Trailing digits, with or without a separator: `ember1`, `overlay-0`, `c46-1`. */
const COUNTER_SUFFIX = /\d$/

/**
 * Build-tool prefixes whose remainder is a hash or a counter by construction.
 *
 * Each entry earns its place by being *only* generated — `mui-` is absent because
 * MUI's own `MuiButton-root` is stable and only its `#mui-1234` ids are not, and the
 * digit-run signal already has those. A list of prefixes dates badly, which is why it
 * is the last signal rather than the first: everything here would also be caught by
 * the shape of the name, and the prefix only buys a clearer reason to show the user.
 */
const FRAMEWORK_PREFIXES: readonly string[] = [
  'css-', // Emotion
  'sc-', // styled-components
  'jsx-', // styled-jsx (Next.js)
  'svelte-', // Svelte scoped styles
  'emotion-',
  'ember', // Ember's auto-assigned view ids: `ember1234`
  'ng-tns-', // Angular transition-scoped names
  '_ngcontent', // Angular view encapsulation
  '_nghost',
  'cdk-', // Angular CDK overlays
  'radix-', // Radix UI
  'headlessui-',
  'react-aria-'
]

/**
 * Names that describe state, not identity.
 *
 * A rule built on `.is-active` blocks while the element is active and stops when it is
 * not, which the user experiences as a blocker that works intermittently — harder to
 * report than one that never works. Matched per hyphen- or underscore-separated word,
 * so `.nav-open` and `.open` both count.
 */
const STATE_WORDS: ReadonlySet<string> = new Set([
  'active',
  'inactive',
  'open',
  'opened',
  'closed',
  'visible',
  'hidden',
  'shown',
  'selected',
  'checked',
  'focused',
  'focus',
  'hover',
  'hovered',
  'pressed',
  'disabled',
  'enabled',
  'expanded',
  'collapsed',
  'loading',
  'loaded',
  'pending',
  'error',
  'success',
  'sticky',
  'stuck',
  'fixed',
  'current',
  'dragging',
  'dragover',
  'playing',
  'paused',
  'muted',
  'empty',
  'filled',
  'invalid',
  'valid',
  'touched',
  'dirty',
  'ready',
  'entering',
  'leaving',
  'transitioning'
])

/** `is-`, `has-` and Vue's transition classes are state by convention. */
const STATE_PREFIXES: readonly string[] = ['is-', 'has-', 'v-enter', 'v-leave', 'ng-star-']

function wordsOf(name: string): readonly string[] {
  return name.split(/[-_]+/).filter((word) => word !== '')
}

function letterRunsAreShort(part: string): boolean {
  // Case-alternating runs of one or two characters are what a base-36 hash of a
  // build id looks like (`hXpVsL`, `bdVaJa`). Real camel case has words in it, so
  // `topAdContainer` has a run of eight and survives — which matters, because ids
  // like that are exactly what a hand-written page uses.
  const runs = part.match(/[A-Z]+|[a-z]+|\d+/g) ?? []
  return runs.length >= 3 && runs.every((run) => run.length <= 2)
}

function hasNoVowel(part: string): boolean {
  return /^[A-Za-z]{5,}$/.test(part) && !/[aeiouy]/i.test(part)
}

function mixesLettersAndDigits(part: string): boolean {
  return part.length >= 5 && /[A-Za-z]/.test(part) && /\d/.test(part)
}

/**
 * A part that reads as a hash rather than as a word.
 *
 * Three shapes, each cheap to compute and each seen in the wild: letters mixed with
 * digits (`1a2b3c` from Emotion, `2xY9z` from CSS modules), letters with no vowel at
 * all (`hXpVsL` from styled-components), and case that alternates every character or
 * two (`bdVaJa`, same source).
 */
function looksHashed(name: string): boolean {
  return wordsOf(name).some(
    (part) => mixesLettersAndDigits(part) || hasNoVowel(part) || letterRunsAreShort(part)
  )
}

function looksGenerated(name: string): IdentifierVerdict {
  if (name === '') return 'not-an-identifier'
  if (!PLAIN_IDENTIFIER.test(name)) return 'not-an-identifier'
  if (name.length < 2) return 'too-short'
  if (FRAMEWORK_PREFIXES.some((prefix) => name.startsWith(prefix))) return 'framework-prefix'
  if (DIGIT_RUN.test(name)) return 'digit-run'
  if (COUNTER_SUFFIX.test(name)) return 'counter-suffix'
  if (looksHashed(name)) return 'hash-like'
  return 'usable'
}

/**
 * Whether an element's `id` is worth naming in a rule.
 *
 * An id is the best thing a picker can find — one element, shortest possible selector
 * — which is exactly why it is worth being suspicious of: frameworks assign ids far
 * more freely than authors do, because they only need them to be unique, not to mean
 * anything.
 */
export function classifyElementId(id: string): IdentifierVerdict {
  return looksGenerated(id)
}

/**
 * Whether a class name is worth naming in a rule.
 *
 * Everything that disqualifies an id disqualifies a class, plus state: an id rarely
 * describes state, and a class very often does.
 */
export function classifyClassName(className: string): IdentifierVerdict {
  const generated = looksGenerated(className)
  if (generated !== 'usable') return generated
  if (STATE_PREFIXES.some((prefix) => className.startsWith(prefix))) return 'state-name'
  if (wordsOf(className).some((word) => STATE_WORDS.has(word.toLowerCase()))) return 'state-name'
  return 'usable'
}

/**
 * Attributes whose value identifies what an element *is*.
 *
 * An allowlist rather than a denylist, because the useful set is small and the harmful
 * set is not: `class` and `id` have their own treatment, `style` changes with every
 * layout, and a framework's own bookkeeping (`data-v-7ba5bd90`, `data-reactroot`)
 * changes with every build. `data-*` is admitted as a family because that is where a
 * publisher names its own ad slots, with the framework prefixes taken back out.
 */
const ATTRIBUTE_DENY_PREFIXES: readonly string[] = [
  'data-v-', // Vue scoped-style marker: a build hash
  'data-react',
  'data-ember',
  'data-svelte',
  'data-emotion',
  'data-n-', // Nuxt
  'data-turbo'
]

const IDENTIFYING_ATTRIBUTES: ReadonlySet<string> = new Set([
  'role',
  'aria-label',
  'name',
  'type',
  'alt',
  'title',
  'rel',
  'target'
])

/**
 * Whether `name="value"` is worth putting in a selector.
 *
 * The value has to survive the same scrutiny as a class: `data-ad-slot="4711"` names
 * the slot today and something else next week. `href` and `src` are absent from the
 * allowlist on purpose — a full URL usually carries a cache-busting parameter, and
 * matching a prefix of one is a different feature with its own decisions to make.
 */
export function classifyAttribute(name: string, value: string): IdentifierVerdict {
  const lowered = name.toLowerCase()
  if (ATTRIBUTE_DENY_PREFIXES.some((prefix) => lowered.startsWith(prefix))) {
    return 'framework-prefix'
  }
  if (!lowered.startsWith('data-') && !IDENTIFYING_ATTRIBUTES.has(lowered)) {
    return 'not-an-identifier'
  }
  if (value === '') return 'too-short'
  // A value is quoted in the selector, so it need not be a CSS identifier — but a
  // value carrying a quote, a backslash or a newline would need escaping there, and
  // one longer than a short phrase is prose rather than a name.
  if (value.length > 64 || /["'\\\n]/.test(value)) return 'not-an-identifier'
  if (DIGIT_RUN.test(value)) return 'digit-run'
  if (looksHashed(value)) return 'hash-like'
  return 'usable'
}
