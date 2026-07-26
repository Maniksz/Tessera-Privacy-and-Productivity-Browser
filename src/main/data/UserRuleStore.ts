import { z } from 'zod'
import {
  MAX_USER_RULE_LENGTH,
  addUserRule,
  emptyUserRuleDocument,
  enabledUserRuleText,
  removeUserRule,
  repairUserRules,
  setUserRuleEnabled,
  userRulesForHost,
  type AddUserRuleOutcome,
  type UserRule,
  type UserRuleDocument,
  type UserRuleInput
} from '@shared/filters/user-rules.js'
import type { BrowsingMode } from './HistoryStore.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'

/**
 * Persistence for the rules the user wrote themselves — the element picker's output.
 *
 * The rules themselves live in `@shared/filters/user-rules.ts` as pure functions over
 * Adblock Plus lines; this class supplies identity, time, and the decision about who
 * may write, which is the same division `HistoryStore` and `QuickLinkStore` use.
 *
 * The schema is here rather than beside the model because a page listing these rules is
 * a renderer, and zod must not reach a renderer bundle. Two assignments per shape keep
 * the two definitions from drifting in either direction.
 */

/**
 * What the file must look like to be usable.
 *
 * Wrong *kinds* of data are rejected here; wrong *amounts* are healed by
 * `repairUserRules`. A `.max()` on the array would turn "grew past what we expected"
 * into "lost every rule the user wrote", and these rules exist precisely because they
 * are the user's own work rather than something re-downloadable.
 *
 * `text` is bounded because a bound belongs on a single line the user typed; a line
 * longer than this is a paste accident, and one bad line must not cost the file.
 * `repairUserRules` drops the line, the rest survives.
 */
const userRuleSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_USER_RULE_LENGTH),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  origin: z.enum(['picker', 'manual'])
})

const userRuleDocumentSchema = z.object({
  version: z.literal(1),
  rules: z.array(userRuleSchema)
})

type SchemaRule = z.output<typeof userRuleSchema>
type SchemaDocument = z.output<typeof userRuleDocumentSchema>

const _ruleMatchesModel: SchemaRule = null as unknown as UserRule
const _modelMatchesRule: UserRule = null as unknown as SchemaRule
const _documentMatchesModel: SchemaDocument = null as unknown as UserRuleDocument
const _modelMatchesDocument: UserRuleDocument = null as unknown as SchemaDocument
void _ruleMatchesModel
void _modelMatchesRule
void _documentMatchesModel
void _modelMatchesDocument

export interface AddRuleResult {
  readonly outcome: AddUserRuleOutcome
  readonly rule: UserRule | null
}

/**
 * The only way to change the rule set.
 *
 * Reading is not behind this, because a private window has to *see* the rules to apply
 * them, and because a list the user can look at is the whole point.
 */
export interface UserRuleEditor {
  add(input: UserRuleInput): AddRuleResult
  /** True when something changed; false for an unknown id or a no-op. */
  setEnabled(id: string, enabled: boolean): boolean
  /** True when a rule with that id was there to remove. */
  remove(id: string): boolean
  /** Every rule, oldest first — storage order. */
  list(): UserRule[]
  /** Rules bearing on a host, newest first: the "why is this site broken" view. */
  forHost(hostname: string): UserRule[]
  /** Enabled rules as one filter-list body, for `FilterEngine.replaceUserRules`. */
  enabledText(): string
  onChange(listener: (rules: UserRule[]) => void): () => void
}

export interface UserRuleStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps are predictable. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

export class UserRuleStore {
  readonly #store: JsonStore<UserRuleDocument>
  readonly #generateId: () => string
  readonly #now: () => number

  private constructor(
    store: JsonStore<UserRuleDocument>,
    generateId: () => string,
    now: () => number
  ) {
    this.#store = store
    this.#generateId = generateId
    this.#now = now
  }

  static async open(options: UserRuleStoreOptions): Promise<UserRuleStore> {
    const store = await JsonStore.open<UserRuleDocument>({
      filePath: options.filePath,
      schema: userRuleDocumentSchema,
      fallback: emptyUserRuleDocument,
      // A line an older build could parse and this one cannot would otherwise sit in
      // the list looking active while blocking nothing.
      repair: (document) => ({ ...document, rules: repairUserRules(document.rules) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    return new UserRuleStore(
      store,
      options.generateId ?? defaultIdGenerator,
      options.now ?? (() => Date.now())
    )
  }

  /**
   * The only way to obtain an editor, and it cannot be obtained without saying which
   * kind of session it is for.
   *
   * A private window gets an editor that holds no reference to this store's write path
   * at all — the same structural guarantee as `HistoryStore.recorderFor`, so no call
   * site can forget a check it does not have to make.
   *
   * What it is *not* is a discarding editor. History in a private window is meant to
   * vanish; a hiding rule is meant to hide something, and an editor that accepted the
   * rule and did nothing would make the picker appear broken in exactly the window
   * where a user is most likely to be trying it. So the private editor is an overlay:
   * it reads the stored rules through, keeps its own additions and its own disabling in
   * memory, and dies with the session. The rule works, the file is untouched.
   */
  editorFor(mode: BrowsingMode): UserRuleEditor {
    if (mode === 'private') {
      return new SessionUserRuleEditor(
        () => this.rules(),
        () => this.#now()
      )
    }
    return {
      add: (input) => this.#add(input),
      setEnabled: (id, enabled) => this.#setEnabled(id, enabled),
      remove: (id) => this.#remove(id),
      list: () => this.rules(),
      forHost: (hostname) => userRulesForHost(this.rules(), hostname),
      enabledText: () => enabledUserRuleText(this.rules()),
      onChange: (listener) => this.onChange(listener)
    }
  }

  /** Every stored rule, oldest first. Readable from any session. */
  rules(): UserRule[] {
    return [...this.#store.get().rules]
  }

  enabledText(): string {
    return enabledUserRuleText(this.#store.get().rules)
  }

  onChange(listener: (rules: UserRule[]) => void): () => void {
    return this.#store.onChange((document) => listener([...document.rules]))
  }

  /**
   * Everything. What a "clear my own filter rules" button runs, and deliberately not
   * behind `editorFor`: a user asking to clear from a private window means the stored
   * set, the same way clearing history does.
   */
  clear(): number {
    const before = this.#store.get().rules.length
    this.#store.update((document) => ({ ...document, rules: [] }))
    return before
  }

  flush(): Promise<void> {
    return this.#store.flush()
  }

  get recoveredFromInvalidFile(): boolean {
    return this.#store.diagnostics.recoveredFromInvalidFile
  }

  #add(input: UserRuleInput): AddRuleResult {
    const result = addUserRule(this.#store.get().rules, input, {
      id: this.#generateId(),
      now: this.#now()
    })
    // A rejected line must not schedule a write or wake a listener: the picker offers a
    // proposal on every hover, and a duplicate is the expected answer, not an event.
    if (result.added === null) return { outcome: result.outcome, rule: null }
    this.#store.update((document) => ({ ...document, rules: result.rules }))
    return { outcome: result.outcome, rule: result.added }
  }

  #setEnabled(id: string, enabled: boolean): boolean {
    if (!this.#store.get().rules.some((rule) => rule.id === id && rule.enabled !== enabled)) {
      return false
    }
    this.#store.update((document) => ({
      ...document,
      rules: setUserRuleEnabled(document.rules, id, enabled)
    }))
    return true
  }

  #remove(id: string): boolean {
    if (!this.#store.get().rules.some((rule) => rule.id === id)) return false
    this.#store.update((document) => ({
      ...document,
      rules: removeUserRule(document.rules, id)
    }))
    return true
  }
}

/**
 * A private window's editor: the stored rules, plus this session's own changes.
 *
 * Holds a reader rather than the store, so there is no write path to forget to avoid.
 * Ids are local to the session and prefixed, so an interface listing them can tell the
 * user which rules will not survive the window closing — a rule that silently vanishes
 * is worse than one that was never accepted.
 */
class SessionUserRuleEditor implements UserRuleEditor {
  readonly #stored: () => UserRule[]
  readonly #now: () => number
  readonly #added: UserRule[] = []
  /** Ids the session disabled or deleted, whichever the stored rule was. */
  readonly #disabled = new Set<string>()
  readonly #removed = new Set<string>()
  readonly #listeners = new Set<(rules: UserRule[]) => void>()
  #sequence = 0

  constructor(stored: () => UserRule[], now: () => number) {
    this.#stored = stored
    this.#now = now
  }

  add(input: UserRuleInput): AddRuleResult {
    this.#sequence += 1
    const result = addUserRule(this.list(), input, {
      id: `session-${this.#sequence}`,
      now: this.#now()
    })
    if (result.added === null) return { outcome: result.outcome, rule: null }
    this.#added.push(result.added)
    this.#notify()
    return { outcome: result.outcome, rule: result.added }
  }

  setEnabled(id: string, enabled: boolean): boolean {
    if (!this.list().some((rule) => rule.id === id)) return false
    if (enabled) this.#disabled.delete(id)
    else this.#disabled.add(id)
    this.#notify()
    return true
  }

  remove(id: string): boolean {
    if (!this.list().some((rule) => rule.id === id)) return false
    this.#removed.add(id)
    this.#notify()
    return true
  }

  list(): UserRule[] {
    return [...this.#stored(), ...this.#added]
      .filter((rule) => !this.#removed.has(rule.id))
      .map((rule) => (this.#disabled.has(rule.id) ? { ...rule, enabled: false } : rule))
  }

  forHost(hostname: string): UserRule[] {
    return userRulesForHost(this.list(), hostname)
  }

  enabledText(): string {
    return enabledUserRuleText(this.list())
  }

  onChange(listener: (rules: UserRule[]) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  #notify(): void {
    const rules = this.list()
    for (const listener of this.#listeners) listener(rules)
  }
}

let counter = 0

/**
 * Ids only have to be unique within this file, so a counter plus the clock is enough —
 * and unlike `crypto.randomUUID()` it stays readable in a document the user might open
 * to work out which rule broke a page. Same convention as `QuickLinkStore`.
 */
function defaultIdGenerator(): string {
  counter += 1
  return `ur-${Date.now().toString(36)}-${counter.toString(36)}`
}
