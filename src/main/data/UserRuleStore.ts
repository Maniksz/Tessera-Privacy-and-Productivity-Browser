import { z } from 'zod'
import {
  MAX_USER_RULE_LENGTH,
  addUserRule,
  describeUserRule,
  emptyUserRuleDocument,
  enabledUserRuleText,
  removeUserRule,
  repairUserRules,
  setUserRuleEnabled,
  tooBroadUserRules,
  userRulesForHost,
  type AddUserRuleOutcome,
  type UserRule,
  type UserRuleDocument,
  type UserRuleInput
} from '@shared/filters/user-rules.js'
import type { BrowsingMode } from './HistoryStore.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { KnownFields } from '@shared/known-fields.js'
import type { StoreLoadReport } from './store-load.js'

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
const userRuleSchema = z.looseObject({
  id: z.string().min(1),
  text: z.string().min(1).max(MAX_USER_RULE_LENGTH),
  enabled: z.boolean(),
  createdAt: z.number().int().nonnegative(),
  origin: z.enum(['picker', 'manual'])
})

const userRuleDocumentSchema = z.looseObject({
  version: z.literal(1),
  rules: z.array(userRuleSchema)
})

type SchemaRule = KnownFields<z.output<typeof userRuleSchema>>
type SchemaDocument = KnownFields<z.output<typeof userRuleDocumentSchema>>

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
  /**
   * The rule the answer is about: the one just stored, or — on either duplicate outcome
   * — the one already there.
   *
   * Filled in the duplicate case rather than left null, because "you already have this
   * rule" is only useful with the rule attached. A surface handed the bare word has to
   * go looking through the list for the line it just refused, and the surface that
   * matters here is an element picker that has hidden nothing and has to explain why.
   */
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
  /**
   * Whether this editor may switch the rule off or remove it.
   *
   * Always, for the stored editor and a rule it has. Only for its own rules, for a private window's:
   * the stored ones are the profile's, which a private window may read but not change — and a change
   * it recorded anyway would be listed without reaching the page, which is served the stored rules by
   * the engine whatever the session thinks of them.
   */
  mayChange(id: string): boolean
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
  /** The one editor a normal window gets; see `editorFor`. */
  readonly #stored: UserRuleEditor
  /** The one editor a private window gets, and the state of the private session; see `editorFor`. */
  readonly #session: SessionUserRuleEditor

  private constructor(
    store: JsonStore<UserRuleDocument>,
    generateId: () => string,
    now: () => number
  ) {
    this.#store = store
    this.#generateId = generateId
    this.#now = now
    this.#stored = {
      add: (input) => this.#add(input),
      setEnabled: (id, enabled) => this.#setEnabled(id, enabled),
      remove: (id) => this.#remove(id),
      mayChange: (id) => this.#store.get().rules.some((rule) => rule.id === id),
      list: () => this.rules(),
      forHost: (hostname) => userRulesForHost(this.rules(), hostname),
      enabledText: () => enabledUserRuleText(this.rules()),
      onChange: (listener) => this.onChange(listener)
    }
    this.#session = new SessionUserRuleEditor(
      () => this.rules(),
      () => this.#now()
    )
  }

  static async open(options: UserRuleStoreOptions): Promise<UserRuleStore> {
    const store = await JsonStore.open<UserRuleDocument>({
      filePath: options.filePath,
      schema: userRuleDocumentSchema,
      fallback: emptyUserRuleDocument,
      // Version 1 is the only one there has been; see `StoreMigrations`.
      migrations: [],
      criticality: 'degradable',
      // A line an older build could parse and this one cannot would otherwise sit in
      // the list looking active while blocking nothing.
      repair: (document) => ({ ...document, rules: repairUserRules(document.rules) }),
      ...(options.codec === undefined ? {} : { codec: options.codec }),
      ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs })
    })

    /*
      Said once, when the rules are read, rather than per compile: the list does not change during a
      run (see `configurePublicSuffixes`), so neither does the answer.
    */
    const tooBroad = tooBroadUserRules(store.get().rules)
    if (tooBroad.length > 0) {
      console.warn(
        '[user-rules] not applied, because each names a public suffix rather than a site:',
        tooBroad.map((rule) => rule.text)
      )
    }

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
   * it reads the stored rules through and keeps its own additions and its own disabling
   * in memory. The rule works, the file is untouched.
   *
   * ## Why the same object comes back every time
   *
   * This used to construct the private editor per call, and that made it useless: a
   * rule added through one IPC call was gone by the next one, so blocking an element in
   * a private window did nothing and the rule was in no list the user could open. An
   * editor whose state lasts one call also cannot be listened to — `onChange` had no
   * subscriber anywhere in the core, because there was no object to subscribe to that
   * would still exist when it fired. Both are held now (KTD5).
   *
   * ## Why per mode rather than per private window (OQ3)
   *
   * Both answers satisfy R16, and they differ in what happens when the first of two
   * private windows closes: per mode, the rules stay for the second; per window, they
   * go with the first. Per mode was chosen for two reasons.
   *
   * The first is that this seam is *named* by mode. `editorFor('private')` returning
   * the held editor makes "a private window's rules survive" a property of the object
   * every call site already asks for, rather than a convention that each of the three
   * callers — the picker, the IPC handlers and the injector's pull — has to honour by
   * routing through a window. A per-window editor would have to be handed out at window
   * creation and looked up from a controller, and any call site that asked the store
   * directly would silently get a rule set nobody sees. That is the difference between
   * an invariant and a convention this file keeps everywhere else.
   *
   * The second is delivery. These rules reach a page through a single subscription made
   * once at startup (KTD3): `onChange` re-serves the views of the private windows. One
   * held editor means one subscription that cannot be forgotten for a window opened
   * later — and being forgotten is exactly the defect being repaired here.
   *
   * The cost is real and is not hidden: two private windows open at once share their
   * session rules, so one of them lists — and applies — a line the user wrote in the
   * other. `TabGroupStore.bookFor` refused precisely that sharing for tab groups, and
   * was right to, because a group carries a name the user typed for a set of open tabs.
   * A rule is a narrower thing: one line about one site's markup, never sent anywhere,
   * never written down, and gone from both windows the moment the mode ends. Weighed
   * against a picker that would stop working in a window opened from a private window,
   * the sharing is the smaller surprise. If that ever stops being true, the change is to
   * key the held editor by window here — the callers already resolve one.
   */
  editorFor(mode: BrowsingMode): UserRuleEditor {
    return mode === 'private' ? this.#session : this.#stored
  }

  /**
   * The private session is over: everything it held goes.
   *
   * Called when the last private window closes, which is what "the life of the session"
   * means for an editor held per mode. Without it a private window opened later in the
   * same run of the browser would inherit the rules of an earlier one — a private
   * session leaving something behind in memory, which is the one thing it promises not
   * to do.
   *
   * The editor object itself survives, and that is the point: it is what the delivery
   * subscription is attached to. What is dropped is its contents, and the listeners are
   * told, so the views of a window still open are re-served without the rules.
   */
  endPrivateSession(): void {
    this.#session.endSession()
  }

  /**
   * The private session's own enabled rules as one filter-list body, and nothing of the stored set.
   *
   * What a private window's views are served on top of the engine's rules. The stored rules are left
   * out because the engine serves them already — to every view, private ones included — and serving
   * them here again made a private window's page apply each stored rule twice.
   */
  privateSessionText(): string {
    return this.#session.ownText()
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

  /** What opening the file found, for the warning `index.ts` logs. See `describeStoreLoad`. */
  get loadReport(): StoreLoadReport {
    return this.#store.loadReport
  }

  #add(input: UserRuleInput): AddRuleResult {
    const result = addUserRule(this.#store.get().rules, input, {
      id: this.#generateId(),
      now: this.#now()
    })
    // A rejected line must not schedule a write or wake a listener: the picker offers a
    // proposal on every hover, and a duplicate is the expected answer, not an event.
    // `existing` rides back out so a duplicate answer arrives with the rule it is about;
    // it is null for the two refusals that have no rule to point at.
    if (result.added === null) return { outcome: result.outcome, rule: result.existing }
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
 * A private window's editor: the stored rules to read, plus this session's own to change.
 *
 * Holds a reader rather than the store, so there is no write path to forget to avoid.
 * Ids are local to the session and prefixed, so an interface listing them can tell the
 * user which rules will not survive the window closing — a rule that silently vanishes
 * is worse than one that was never accepted.
 *
 * One of these exists per browsing mode and outlives every window; `endSession` is what
 * ends a session, and `UserRuleStore.editorFor` argues why the object is the long-lived
 * one and the session is not.
 */
class SessionUserRuleEditor implements UserRuleEditor {
  readonly #stored: () => UserRule[]
  readonly #now: () => number
  /**
   * This session's own rules, each carrying whether it is switched on.
   *
   * The only rules this editor changes. The stored ones are read through `#stored` and never masked:
   * a mask kept here would be listed and not applied, because the stored rules reach every page
   * through the engine, which a session cannot speak to.
   */
  #added: UserRule[] = []
  readonly #listeners = new Set<(rules: UserRule[]) => void>()
  #sequence = 0

  constructor(stored: () => UserRule[], now: () => number) {
    this.#stored = stored
    this.#now = now
  }

  add(input: UserRuleInput): AddRuleResult {
    /*
      Refused before anything else, and as `invalid`, because a private window has no way to honour
      either kind: its rules reach the page only as a per-view stylesheet (`viewStylesheet`), which
      can hide an element and do nothing more. An exception would have to cancel a rule inside the
      engine, and a procedural rule needs the matcher the engine feeds. Accepting them would list a
      rule the page never sees.
    */
    const detail = describeUserRule(input.text)
    if (detail !== null && (detail.isException || detail.kind === 'procedural')) {
      return { outcome: 'invalid', rule: null }
    }
    this.#sequence += 1
    /*
      Against `list()`, which is the stored rules plus this session's own — so the limit
      is read against the set the user can actually see. It was already the argument
      here, but the limit used to be applied by *trimming the returned list*, and this
      method keeps only `result.added` and throws that list away. A private window was
      therefore the one place the five hundred could be exceeded without bound. Refusing
      at the limit rather than trimming is what closes that, because the answer is the
      outcome rather than a list somebody has to remember to keep.
    */
    const result = addUserRule(this.list(), input, {
      id: `session-${this.#sequence}`,
      now: this.#now()
    })
    if (result.added === null) return { outcome: result.outcome, rule: result.existing }
    this.#added.push(result.added)
    this.#notify()
    return { outcome: result.outcome, rule: result.added }
  }

  setEnabled(id: string, enabled: boolean): boolean {
    if (!this.#added.some((rule) => rule.id === id && rule.enabled !== enabled)) return false
    this.#added = this.#added.map((rule) => (rule.id === id ? { ...rule, enabled } : rule))
    this.#notify()
    return true
  }

  remove(id: string): boolean {
    if (!this.mayChange(id)) return false
    this.#added = this.#added.filter((rule) => rule.id !== id)
    this.#notify()
    return true
  }

  mayChange(id: string): boolean {
    return this.#added.some((rule) => rule.id === id)
  }

  list(): UserRule[] {
    return [...this.#stored(), ...this.#added]
  }

  forHost(hostname: string): UserRule[] {
    return userRulesForHost(this.list(), hostname)
  }

  enabledText(): string {
    return enabledUserRuleText(this.list())
  }

  /** This session's own enabled rules, without the stored ones. See `UserRuleStore.privateSessionText`. */
  ownText(): string {
    return enabledUserRuleText(this.#added)
  }

  onChange(listener: (rules: UserRule[]) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /**
   * Everything this session did, undone: its own rules.
   *
   * The listeners are kept — they belong to the wiring, not to the session — and are
   * told, because a private window that is still open (the mode ends with the *last*
   * one) has views showing rules that no longer exist. Silent when there was nothing to
   * undo, which is the ordinary case: a private window in which the user never wrote a
   * rule must not cost every open page a re-serve on its way out.
   *
   * The id counter deliberately keeps running: an interface holding `session-3` from
   * the last session must not find it pointing at a different rule in the next one.
   */
  endSession(): void {
    if (this.#added.length === 0) return
    this.#added = []
    this.#notify()
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
