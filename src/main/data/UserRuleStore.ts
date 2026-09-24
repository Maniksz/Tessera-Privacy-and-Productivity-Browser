import { z } from 'zod'
import {
  MAX_USER_RULE_LENGTH,
  addUserRule,
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
import { isAdditionRule } from '@shared/filters/preview-styles.js'
import {
  applyUserRuleSource,
  projectUserRuleSource,
  repairUserRuleSource,
  type ApplyUserRuleSourceOutcome,
  type UserRuleSourceView
} from '@shared/filters/user-rules-source.js'
import type { BrowsingMode } from './HistoryStore.js'
import { JsonStore, type DocumentCodec } from './JsonStore.js'
import type { KnownFields } from '@shared/known-fields.js'
import type { StoreLoadReport, StoreMigrations } from './store-load.js'

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

/*
  `source` without a bound here, for the reason `rules` has none: a `.max()` would turn "a text that grew
  too long" into "lost every rule the user wrote". `repairUserRuleSource` lets an oversized text go instead,
  and what that costs is the notes, never a rule.
*/
const userRuleDocumentSchema = z.looseObject({
  version: z.literal(1),
  rules: z.array(userRuleSchema),
  source: z.string().optional()
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
 * The only way to change the rule set, one rule at a time.
 *
 * Reading is not behind this, because a private window has to *see* the rules to apply
 * them, and because a list the user can look at is the whole point.
 *
 * What the element picker is handed. It writes, undoes and switches back on one rule, and
 * that is all it should be able to reach — the whole-text operations are on
 * `UserRuleTextEditor` below, which only the settings page's channels are given.
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

/**
 * The rule set as one text: the rule manager's view of the same editor (U8, KTD7).
 *
 * A wider interface rather than two more methods on `UserRuleEditor`, so the element
 * picker keeps being handed exactly the operations it performs. `editorFor` returns this;
 * the picker's wiring narrows it.
 */
export interface UserRuleTextEditor extends UserRuleEditor {
  /**
   * Whether `setEnabled(id, enabled)` would be honoured — what a surface asks before it offers the switch.
   *
   * Always, for a rule a normal window's editor has. A private window's cannot switch a rule from the
   * normal profile off, or on when it has no way to deliver it; see `SessionUserRuleEditor`. On this wider
   * interface rather than the picker's, which never offers either.
   */
  canSetEnabled(id: string, enabled: boolean): boolean
  /** Whether `remove(id)` would be honoured; the same question, for deleting. */
  canRemove(id: string): boolean
  /** The rules as the text the editor shows, and the lines in it the browser refuses. */
  source(): UserRuleSourceView
  /**
   * A whole text, taken back: every line checked, unchanged lines traced to the rules
   * they came from, and nothing at all written past the limit.
   *
   * `loadedIds` are the rules the text was written against — the ones the page was
   * showing. A missing line deletes only one of those, so a rule the picker wrote in
   * another window while the text was open survives the save, and one deleted elsewhere
   * meanwhile is simply already gone. What is still last-write-wins is every line the
   * text names: see `applyUserRuleSource`.
   */
  applySource(
    text: string,
    loadedIds: readonly string[]
  ): { readonly outcome: ApplyUserRuleSourceOutcome }
}

export interface UserRuleStoreOptions {
  filePath: string
  codec?: DocumentCodec
  /** Injected in tests so ids and timestamps are predictable. */
  generateId?: () => string
  now?: () => number
  debounceMs?: number
}

/**
 * The steps up to the version this store writes. Version 1 is the only one there has been; see
 * `StoreMigrations`. Exported for the backup, which refuses a document newer than this (U23, AE8).
 */
export const USER_RULE_MIGRATIONS: StoreMigrations = []

export class UserRuleStore {
  readonly #store: JsonStore<UserRuleDocument>
  readonly #generateId: () => string
  readonly #now: () => number
  /** The one editor a normal window gets; see `editorFor`. */
  readonly #stored: UserRuleTextEditor
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
      canSetEnabled: (id) => this.#store.get().rules.some((rule) => rule.id === id),
      canRemove: (id) => this.#store.get().rules.some((rule) => rule.id === id),
      list: () => this.rules(),
      forHost: (hostname) => userRulesForHost(this.rules(), hostname),
      enabledText: () => enabledUserRuleText(this.rules()),
      onChange: (listener) => this.onChange(listener),
      source: () => projectUserRuleSource(this.rules(), this.#store.get().source),
      applySource: (text, loadedIds) => this.#applySource(text, loadedIds)
    }
    this.#session = new SessionUserRuleEditor(
      () => this.rules(),
      () => this.#store.get().source,
      () => this.#now()
    )
  }

  static async open(options: UserRuleStoreOptions): Promise<UserRuleStore> {
    const store = await JsonStore.open<UserRuleDocument>({
      filePath: options.filePath,
      schema: userRuleDocumentSchema,
      fallback: emptyUserRuleDocument,
      migrations: USER_RULE_MIGRATIONS,
      criticality: 'degradable',
      // A line an older build could parse and this one cannot would otherwise sit in
      // the list looking active while blocking nothing.
      repair: (document) =>
        withSource(
          { version: document.version, rules: repairUserRules(document.rules) },
          repairUserRuleSource(document.source)
        ),
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
   * it reads the stored rules through and keeps its own rules, and its switching on of
   * stored ones, in memory. The rule works, the file is untouched.
   *
   * The overlay can only add, and it says so rather than pretending otherwise: it cannot
   * switch off or delete a stored rule, nor hold a rule its pages have no way to receive.
   * `SessionUserRuleEditor` gives the reason.
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
  editorFor(mode: BrowsingMode): UserRuleTextEditor {
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
   * What a private window's views are served on top of the engine's rules, as one filter-list body:
   * the session's own enabled rules and the stored rules it switched on.
   *
   * The stored rules that are on in the file are left out because the engine serves them already —
   * to every view, private ones included — and serving them here again made a private window's page
   * apply each one twice, and re-hid what a stored exception cancels in the engine.
   */
  privateSessionText(): string {
    return this.#session.additionText()
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
   *
   * The saved text goes too. Its notes are *about* the rules, and a box that came back
   * after "clear" holding nothing but the notes and refused lines would read as a clear
   * that half worked.
   */
  clear(): number {
    const before = this.#store.get().rules.length
    this.#store.update((document) => ({ version: document.version, rules: [] }))
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

  /*
    One write for the whole text, and none for a text that changes nothing.

    Not a sequence of `add`, `setEnabled` and `remove`: each of those is a write and a
    notification, and every notification recompiles the engine's user rules and re-serves
    every open page. Five hundred lines saved at once would have been five hundred of
    both, and a limit checked rule by rule could have been passed halfway — having already
    deleted the lines the text dropped.
  */
  #applySource(
    text: string,
    loadedIds: readonly string[]
  ): { readonly outcome: ApplyUserRuleSourceOutcome } {
    const result = applyUserRuleSource(this.#store.get(), text, {
      nextId: () => this.#generateId(),
      now: this.#now(),
      loaded: new Set(loadedIds)
    })
    if (result.changed) {
      this.#store.update((document) =>
        withSource({ version: document.version, rules: result.rules }, result.source)
      )
    }
    return { outcome: result.outcome }
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
 *
 * ## What it can change, and why only that
 *
 * Its rules reach a page one way: `CosmeticInjector` asks `sessionStylesFor` for this
 * editor's `enabledText()` and `viewStylesheet` appends it to the view's stylesheet
 * (KTD3). The stored rules reach every window — this one included — a second way, through
 * the engine's one global slot, which is fed from the file and must stay that way (R20).
 * An addition can only add. So:
 *
 *   - **Its own rules**: anything. They exist only in the addition.
 *   - **A stored rule that is off**: can be switched on (`#enabled`), and back off again,
 *     because that is taking back the session's own switch. Switched on, it is in
 *     `enabledText()` and so in the addition. Not when it is procedural or an exception —
 *     `viewStylesheet` drops those, and a rule listed on that does nothing is the lie this
 *     section exists against.
 *   - **A stored rule that is on**: cannot be switched off or deleted. The global slot goes
 *     on hiding its element here whatever this list says, and making it true would take a
 *     per-view *exception* stylesheet, which is a change to the injector and not here.
 *   - **A new procedural rule or exception**: refused, for the same reason as above.
 *
 * `setEnabled` and `remove` refuse what they cannot do — `false`, nothing changed, nobody
 * told — rather than keep doing it and rely on every surface not offering it. The old
 * behaviour recorded the switch and changed the list, and that is exactly how the blocker
 * menu came to show a rule unchecked while it kept hiding its element: the operation looked
 * like it worked. A refusal the caller can see cannot be mistaken for a change, and a
 * future surface that forgets to ask `canSetEnabled` first gets an honest no rather than
 * a list that lies. The surfaces ask anyway, so that they do not offer it.
 */
class SessionUserRuleEditor implements UserRuleTextEditor {
  readonly #stored: () => UserRule[]
  readonly #storedSource: () => string | undefined
  readonly #now: () => number
  readonly #added: UserRule[] = []
  /**
   * The text this session saved, or undefined to read the stored one through.
   *
   * Read through until the session saves its own, so a private window opens its rule
   * manager on the user's notes rather than on a bare list — and kept here, not written,
   * once it does.
   */
  #source: string | undefined = undefined
  /** The session's own rules it switched off, and deleted. Never a stored id — see the class docblock. */
  readonly #disabled = new Set<string>()
  readonly #removed = new Set<string>()
  /** Stored rules that are off in the file and that this session switched on. */
  readonly #enabled = new Set<string>()
  /**
   * Stored rules whose change the last save asked for and this editor could not make, for the rule
   * manager to mark (`normal-profile`). Replaced by every save that is taken; emptied with the session.
   */
  #refused: ReadonlySet<string> = new Set()
  readonly #listeners = new Set<(rules: UserRule[]) => void>()
  #sequence = 0

  constructor(stored: () => UserRule[], storedSource: () => string | undefined, now: () => number) {
    this.#stored = stored
    this.#storedSource = storedSource
    this.#now = now
  }

  add(input: UserRuleInput): AddRuleResult {
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
    /*
      A rule this session could not deliver is `invalid` here, as its line is refused in the
      rule manager. The picker never writes one — it writes plain selectors — but this is the
      editor a typed or menu path reaches too, and "added" for a rule that then hides nothing
      would be the same lie as listing it. One it already has is still answered as the
      duplicate it is: a stored procedural rule works here, through the engine.
    */
    const text = input.text.trim()
    const list = this.list()
    if (!isAdditionRule(text) && !list.some((rule) => rule.text === text)) {
      return { outcome: 'invalid', rule: null }
    }
    const result = addUserRule(list, input, {
      id: `session-${this.#sequence}`,
      now: this.#now()
    })
    if (result.added === null) return { outcome: result.outcome, rule: result.existing }
    this.#added.push(result.added)
    this.#notify()
    return { outcome: result.outcome, rule: result.added }
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const rule = this.list().find((entry) => entry.id === id)
    if (rule === undefined || rule.enabled === enabled || !this.canSetEnabled(id, enabled)) {
      return false
    }
    if (this.#isOwn(id)) {
      if (enabled) this.#disabled.delete(id)
      else this.#disabled.add(id)
    } else if (enabled) {
      this.#enabled.add(id)
    } else {
      this.#enabled.delete(id)
    }
    this.#notify()
    return true
  }

  remove(id: string): boolean {
    if (!this.canRemove(id)) return false
    this.#removed.add(id)
    this.#notify()
    return true
  }

  /**
   * Any switch of its own rules; for a stored one, on when it can be delivered, and off only
   * when it was this session that switched it on. The class docblock says why.
   */
  canSetEnabled(id: string, enabled: boolean): boolean {
    if (this.#isOwn(id)) return true
    const stored = this.#stored().find((rule) => rule.id === id)
    if (stored === undefined) return false
    return enabled ? stored.enabled || isAdditionRule(stored.text) : this.#enabled.has(id)
  }

  /** Its own rules only: a stored rule deleted here would go on hiding its element here. */
  canRemove(id: string): boolean {
    return this.#isOwn(id)
  }

  list(): UserRule[] {
    return [...this.#stored(), ...this.#added]
      .filter((rule) => !this.#removed.has(rule.id))
      .map((rule) => {
        if (this.#disabled.has(rule.id)) return { ...rule, enabled: false }
        if (this.#enabled.has(rule.id) && !rule.enabled) return { ...rule, enabled: true }
        return rule
      })
  }

  forHost(hostname: string): UserRule[] {
    return userRulesForHost(this.list(), hostname)
  }

  enabledText(): string {
    return enabledUserRuleText(this.list())
  }

  /**
   * What this session serves on top of the engine: its own enabled rules, and the stored rules it
   * switched on. Not the stored rules that are on in the file, which the engine serves already. See
   * `UserRuleStore.privateSessionText`.
   */
  additionText(): string {
    const servedByEngine = new Set(
      this.#stored()
        .filter((rule) => rule.enabled)
        .map((rule) => rule.id)
    )
    return enabledUserRuleText(this.list().filter((rule) => !servedByEngine.has(rule.id)))
  }

  onChange(listener: (rules: UserRule[]) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  source(): UserRuleSourceView {
    return projectUserRuleSource(this.list(), this.#currentSource(), {
      admits: isAdditionRule,
      refused: this.#refused
    })
  }

  /**
   * The text, taken back into the session's overlay rather than into the file.
   *
   * Computed against `list()` like `add`, so the limit counts the stored rules too, and
   * with this editor's limits, so the pure function refuses what the class docblock says
   * this editor cannot do: a new procedural or exception line is refused and marked where
   * it stands (`private-window`), and switching off or deleting a stored rule is left
   * undone and its line marked (`normal-profile`). The rest of the text is taken, as with
   * any refused line. What comes back is then translated into the things this overlay can
   * hold: stored rules it switched on, and its own rules. A stored rule's id never lands in
   * `#added`, so the file's rules stay the file's however the text rearranges them.
   *
   * `loadedIds` works as it does for the stored editor, over both halves: a rule this
   * session's picker wrote after the page opened, and a rule a normal window wrote to the
   * file meanwhile, are neither switched nor removed by a text that never showed them.
   */
  applySource(
    text: string,
    loadedIds: readonly string[]
  ): { readonly outcome: ApplyUserRuleSourceOutcome } {
    const result = applyUserRuleSource(
      { rules: this.list(), source: this.#currentSource() },
      text,
      {
        nextId: () => {
          this.#sequence += 1
          return `session-${this.#sequence}`
        },
        now: this.#now(),
        loaded: new Set(loadedIds),
        admits: isAdditionRule,
        canSetEnabled: (rule, enabled) => this.canSetEnabled(rule.id, enabled),
        canRemove: (rule) => this.canRemove(rule.id)
      }
    )
    if (result.outcome !== 'applied') return { outcome: result.outcome }
    // Before the early return: a text that changes nothing may still be one asking again for
    // a change this editor refused, and its mark has to stay. It is read by `source()` only,
    // which is not what the listeners are for, so no notification either way.
    this.#refused = new Set(result.refused)
    if (!result.changed) return { outcome: result.outcome }

    const kept = new Map(result.rules.map((rule) => [rule.id, rule]))
    const storedIds = new Set<string>()
    for (const rule of this.#stored()) {
      storedIds.add(rule.id)
      // Always there: a stored rule cannot be deleted from here, so the text cannot drop one.
      // What can differ is its switch, and only upwards from the file's — `canSetEnabled`.
      if (kept.get(rule.id)?.enabled === true && !rule.enabled) this.#enabled.add(rule.id)
      else this.#enabled.delete(rule.id)
    }
    const own = result.rules.filter((rule) => !storedIds.has(rule.id))
    // The session's own rules carry their switch on the record itself from here on.
    for (const rule of own) this.#disabled.delete(rule.id)
    this.#added.splice(0, this.#added.length, ...own)
    this.#source = result.source
    this.#notify()
    return { outcome: result.outcome }
  }

  #isOwn(id: string): boolean {
    return this.#added.some((rule) => rule.id === id && !this.#removed.has(rule.id))
  }

  #currentSource(): string | undefined {
    return this.#source ?? this.#storedSource()
  }

  /**
   * Everything this session did, undone: its own rules, its switching on of stored ones,
   * and the marks of what it refused.
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
    if (
      this.#added.length === 0 &&
      this.#disabled.size === 0 &&
      this.#removed.size === 0 &&
      this.#enabled.size === 0 &&
      this.#refused.size === 0 &&
      this.#source === undefined
    ) {
      return
    }
    this.#added.length = 0
    this.#disabled.clear()
    this.#removed.clear()
    this.#enabled.clear()
    this.#refused = new Set()
    this.#source = undefined
    this.#notify()
  }

  #notify(): void {
    const rules = this.list()
    for (const listener of this.#listeners) listener(rules)
  }
}

/**
 * A document with its saved text, or without one when there is none.
 *
 * Absent rather than `source: undefined`, and the difference is observable: the store's
 * repair check compares key counts, so a document that gained an undefined key on the way
 * in would be reported as repaired on every start — and a file that never had a text
 * would stop being byte-identical to one written before the text box existed.
 */
function withSource(document: UserRuleDocument, source: string | undefined): UserRuleDocument {
  return source === undefined ? document : { ...document, source }
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
