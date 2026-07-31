import type { ScriptletCall } from './scriptlets.js'

/**
 * The scriptlets as they run inside the page's own JavaScript world.
 *
 * ## Why this is one function and not eight
 *
 * Context isolation means the preload runs in a different world from the page: defining a property from
 * there changes nothing a page can see. The only sanctioned way across is
 * `contextBridge.executeInMainWorld`, which **serialises the function** — it is re-compiled in the
 * page's world from its own source text, with no closure and no module scope.
 *
 * `fingerprint/apply.ts` lives under the same rule and answers it by writing its small property helper
 * out again inside each of its nine measures. That is right there, because the measures share almost
 * nothing. Here the opposite is true: six of the eight scriptlets need to resolve a dotted property path
 * against a page that may not have built it yet, and three need the same "does this argument match"
 * predicate. Duplicating those six times would be six places for the same subtle bug.
 *
 * So the whole library is *one* exported function with the helpers nested inside it, and the calls
 * arrive as plain data in its single argument. One serialisation, one guard, one copy of each helper.
 * `tests/filter-scriptlets.test.ts` compiles it in an empty `node:vm` context, which is what proves the
 * self-containment claim rather than asserting it.
 *
 * **Nothing in this function may reference anything outside it.** No import, no module constant, no
 * helper from another file. The `ScriptletCall` type is imported, and that is legal for the reason
 * `fingerprint/page.ts` gives: `import type` is erased before the source this serialises ever exists.
 *
 * ## Why each one is written to fail quietly
 *
 * A scriptlet runs before the page's own scripts, in the page's world, on every matching document. A
 * throw here is not a failed measure — it is a page that does not load, caused by a filter list the user
 * did not write. So every call is wrapped, and a scriptlet that cannot do its job leaves the page as it
 * found it. Under-blocking is the acceptable failure; a blank page is not.
 *
 * ## What these cannot reach
 *
 * The same boundary `apply.ts` states: a preload runs in the main frame of its renderer, not in iframes
 * (`nodeIntegrationInSubFrames` is deliberately false) and not in workers. A wall inside an iframe is not
 * defeated by this.
 */
export function runScriptlets(calls: readonly ScriptletCall[]): void {
  /*
    The document, as a structural view rather than as `Document`.

    `src/shared` is compiled without the DOM library on purpose — `tsconfig.node.json` says so, and
    `fingerprint/mask-environment.ts` reaches the page the same way. Two things come out of that, and both
    are wanted here. The view lists exactly what this file touches, so "what does a scriptlet do to a page"
    is answerable by reading one type; and everything is optional, which is the truth at
    `document-start` — `documentElement` does not exist yet however non-nullable `lib.dom` declares it.
  */
  interface PageElement {
    removeAttribute(name: string): void
  }
  interface PageDocument {
    readyState?: string
    documentElement?: unknown
    currentScript?: { textContent?: unknown } | null
    querySelectorAll?: (selector: string) => Iterable<PageElement>
    addEventListener?: (type: string, listener: () => void, options?: { once?: boolean }) => void
  }

  const pageDocument = (): PageDocument | undefined =>
    (globalThis as unknown as { document?: PageDocument }).document

  /*
    A dotted path resolved as far as it goes, with the last segment left unresolved.

    `window.foo.bar.baz` has to be installed on `window.foo.bar`, which the page may create later — an
    anti-adblock check commonly sits behind an object built by the very script being defused. So an
    absent intermediate is not a failure: a setter is installed on the deepest object that *does* exist,
    and when the page assigns the missing link the installation continues from there.

    Returns `null` when the chain cannot be followed at all, which is the honest answer for a path whose
    root is not an object.
  */
  const walk = (
    path: string,
    onReady: (owner: Record<string, unknown>, property: string) => void
  ): void => {
    const segments = path.split('.').filter((segment) => segment !== '')
    if (segments.length === 0) return

    const step = (owner: Record<string, unknown>, index: number): void => {
      const property = segments[index]!
      if (index === segments.length - 1) {
        onReady(owner, property)
        return
      }

      const existing = owner[property]
      if (existing !== null && (typeof existing === 'object' || typeof existing === 'function')) {
        step(existing as Record<string, unknown>, index + 1)
        return
      }

      /*
        Not there yet. Wait for the page to create it, once, and then carry on down the chain.

        `configurable: true` on purpose: a page that later redefines its own property must be able to,
        and a scriptlet that made one of a page's objects permanently non-configurable would break far
        more than it fixed.
      */
      let held: unknown = existing
      try {
        Object.defineProperty(owner, property, {
          configurable: true,
          get: () => held,
          set: (value: unknown) => {
            held = value
            if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
              try {
                step(value as Record<string, unknown>, index + 1)
              } catch {
                // The page's assignment must succeed even if the rest of the chain cannot be built.
              }
            }
          }
        })
      } catch {
        // Non-configurable already, or a frozen object. Nothing to do but leave the page alone.
      }
    }

    // No cast: `globalThis` is already indexable by string, and asserting it says the compiler needed
    // convincing when it did not.
    step(globalThis, 0)
  }

  /**
   * A handler argument as the text a pattern is matched against.
   *
   * `String(value)` is what a first version did and it is wrong in a way that matters: a page may pass
   * `setTimeout` an *object* — a plain object, or one with a `toString` of its own — and stringifying that
   * yields `[object Object]`, which a loose pattern can match. Defusing a timer because its handler
   * stringified to something meaningless is defusing an arbitrary timer.
   *
   * So only the two forms a pattern can meaningfully describe are read: a function, whose source text is
   * what filter lists actually match against, and a string, which `setTimeout` accepts as code. Anything
   * else yields the empty string and matches only a pattern that matches everything.
   */
  const handlerText = (value: unknown): string => {
    if (typeof value === 'function') return Function.prototype.toString.call(value)
    if (typeof value === 'string') return value
    return ''
  }

  /**
   * The `/pattern/flags` or plain-substring argument these scriptlets take, as a predicate.
   *
   * Three of the eight are "do this unless the argument matches", and the argument is a regular
   * expression source when it is wrapped in slashes and a literal substring otherwise. An empty
   * argument matches everything, which is what the syntax means: `+js(nostif)` with no pattern defuses
   * every timeout.
   *
   * A leading `!` negates, as in uBO. A malformed regular expression yields a predicate that matches
   * nothing rather than throwing — the rule for this whole file.
   */
  const matcher = (pattern: string | undefined): ((value: string) => boolean) => {
    const raw = (pattern ?? '').trim()
    if (raw === '') return () => true

    const negated = raw.startsWith('!')
    const body = negated ? raw.slice(1) : raw

    let test: (value: string) => boolean
    const slashed = /^\/(.*)\/([a-z]*)$/.exec(body)
    if (slashed !== null) {
      try {
        const expression = new RegExp(slashed[1]!, slashed[2])
        test = (value) => expression.test(value)
      } catch {
        test = () => false
      }
    } else {
      test = (value) => value.includes(body)
    }

    return negated ? (value) => !test(value) : test
  }

  /** The value `set-constant` was asked for. Its vocabulary is fixed, so an unknown word is a refusal. */
  const constantValue = (raw: string | undefined): { ok: boolean; value: unknown } => {
    switch ((raw ?? '').trim()) {
      case 'true':
        return { ok: true, value: true }
      case 'false':
        return { ok: true, value: false }
      case 'null':
        return { ok: true, value: null }
      case 'undefined':
        return { ok: true, value: undefined }
      case 'noopFunc':
        return { ok: true, value: () => undefined }
      case 'trueFunc':
        return { ok: true, value: () => true }
      case 'falseFunc':
        return { ok: true, value: () => false }
      case 'emptyArr':
        return { ok: true, value: [] }
      case 'emptyObj':
        return { ok: true, value: {} }
      case '':
        return { ok: false, value: undefined }
      case "''":
        return { ok: true, value: '' }
      default: {
        const text = (raw ?? '').trim()
        // A number, positive or negative, integer or not. uBO also accepts a bare string here, and this
        // deliberately does not: a page reading an unexpected string is harder to reason about than a
        // scriptlet that declined, and declining is counted.
        if (/^-?\d+(\.\d+)?$/.test(text)) return { ok: true, value: Number(text) }
        return { ok: false, value: undefined }
      }
    }
  }

  /**
   * A property that throws when read, or when written.
   *
   * A `ReferenceError` rather than a quieter failure, because that is what the page's own code would
   * have produced had the variable never existed — which is the state the wall is being told it is in.
   * uBO throws the same thing.
   */
  const abortOn = (path: string, when: 'read' | 'write'): void => {
    walk(path, (owner, property) => {
      let held: unknown = owner[property]
      try {
        Object.defineProperty(owner, property, {
          configurable: true,
          get: () => {
            if (when === 'read') throw new ReferenceError(property)
            return held
          },
          set: (value: unknown) => {
            if (when === 'write') throw new ReferenceError(property)
            held = value
          }
        })
      } catch {
        // Leave the page alone.
      }
    })
  }

  const abortCurrentScript = (path: string, pattern: string | undefined): void => {
    /*
      The most-used scriptlet of all (411 rules), and the one that needs the page's own execution state.

      "Abort the *current* script" means: when this property is read, look at which script element is
      running, and if its text matches the pattern, throw so that script dies — while every other
      reader of the same property gets the real value. `document.currentScript` is what makes that
      possible, and it is the reason this cannot be expressed as `abort-on-property-read`.
    */
    const matches = matcher(pattern)
    walk(path, (owner, property) => {
      let held: unknown = owner[property]
      try {
        Object.defineProperty(owner, property, {
          configurable: true,
          get: () => {
            let text: string
            try {
              const content = pageDocument()?.currentScript?.textContent
              text = typeof content === 'string' ? content : ''
            } catch {
              text = ''
            }
            // No inline script running: an external script, or a call from a later event handler. The
            // pattern is about inline text, so with none there is nothing to abort.
            if (text !== '' && matches(text)) throw new ReferenceError(property)
            return held
          },
          set: (value: unknown) => {
            held = value
          }
        })
      } catch {
        // Leave the page alone.
      }
    })
  }

  const setConstant = (path: string, raw: string | undefined): void => {
    const wanted = constantValue(raw)
    if (!wanted.ok) return
    walk(path, (owner, property) => {
      try {
        Object.defineProperty(owner, property, {
          configurable: true,
          get: () => wanted.value,
          /*
            A silently ignored write rather than a throw.

            The page is expected to assign its own value here — that is the whole reason the wall reads
            the property — and throwing on the assignment would break the script instead of lying to
            it. `set-constant` means the answer does not change, not that writing is an error.
          */
          set: () => undefined
        })
      } catch {
        // Leave the page alone.
      }
    })
  }

  const defuseEventListener = (typePattern: string | undefined, handlerPattern: string | undefined): void => {
    const typeMatches = matcher(typePattern)
    const handlerMatches = matcher(handlerPattern)
    const target = (globalThis as unknown as { EventTarget?: { prototype?: Record<string, unknown> } })
      .EventTarget
    const prototype = target?.prototype
    if (prototype === undefined) return

    const original = prototype.addEventListener
    if (typeof original !== 'function') return

    try {
      prototype.addEventListener = function (this: unknown, ...args: unknown[]): unknown {
        try {
          const type = typeof args[0] === 'string' ? args[0] : ''
          // Dropped: the listener is never attached, and the page is told nothing, which is what the
          // page would see if it had attached a handler that never fired.
          if (typeMatches(type) && handlerMatches(handlerText(args[1]))) return undefined
        } catch {
          // Fall through and attach it: failing to *decide* must not mean failing to work.
        }
        return (original as (...values: unknown[]) => unknown).apply(this, args)
      }
    } catch {
      // Leave the page alone.
    }
  }

  const preventTimer = (
    which: 'setTimeout' | 'setInterval',
    handlerPattern: string | undefined,
    delayPattern: string | undefined
  ): void => {
    const handlerMatches = matcher(handlerPattern)
    const wantedDelay = (delayPattern ?? '').trim()
    const scope = globalThis as Record<string, unknown>
    const original = scope[which]
    if (typeof original !== 'function') return

    try {
      scope[which] = function (this: unknown, ...args: unknown[]): unknown {
        try {
          const source = handlerText(args[0])
          /*
            The delay compared as the number it is, not as whatever it stringifies to.

            `setTimeout(fn, '1000')` and `setTimeout(fn, 1000)` are the same instruction to the engine, so
            a rule naming `1000` has to catch both — and an object passed as a delay must catch neither.
            Reading it through `Number` gives both of those; `String(args[1] ?? '')` gave the first one
            wrong and the second one `[object Object]`.
          */
          const delay = args[1]
          const delayMatches =
            wantedDelay === '' ||
            ((typeof delay === 'number' || typeof delay === 'string') &&
              Number(delay) === Number(wantedDelay))
          /*
            Returns a plausible timer id rather than nothing. A page that does
            `const id = setTimeout(…); clearTimeout(id)` must not be handed `undefined` — `clearTimeout`
            tolerates it, but code that compares the id or stores it in a map does not.
          */
          if (handlerMatches(source) && delayMatches) return 0
        } catch {
          // Fall through and set the timer.
        }
        return (original as (...values: unknown[]) => unknown).apply(this, args)
      }
    } catch {
      // Leave the page alone.
    }
  }

  const removeAttr = (attributes: string | undefined, selector: string | undefined): void => {
    const names = (attributes ?? '')
      .split('|')
      .map((name) => name.trim())
      .filter((name) => name !== '')
    if (names.length === 0) return
    const scope = (selector ?? '').trim()

    const strip = (): void => {
      const owner = pageDocument()
      const query = owner?.querySelectorAll
      if (owner === undefined || typeof query !== 'function') return
      for (const name of names) {
        // Scoped to the selector when there is one; otherwise every element carrying the attribute,
        // which is what the one-argument form means.
        const selectorText = scope === '' ? `[${name}]` : scope
        let elements: Iterable<PageElement>
        try {
          elements = query.call(owner, selectorText)
        } catch {
          continue
        }
        for (const element of elements) {
          try {
            element.removeAttribute(name)
          } catch {
            // One element failing must not stop the rest.
          }
        }
      }
    }

    /*
      Run now and again on every mutation, because the attribute is usually *added* by the script this
      scriptlet exists to counter — stripping once at document-start would remove nothing at all.

      The observer is not disconnected. That is deliberate rather than a leak: the page keeps re-adding
      the attribute for as long as it lives, and the observer dies with the document.
    */
    const start = (): void => {
      strip()
      const root = pageDocument()?.documentElement
      const Observer = (
        globalThis as unknown as {
          MutationObserver?: new (callback: () => void) => {
            observe: (target: unknown, options: unknown) => void
          }
        }
      ).MutationObserver
      if (root === undefined || root === null || Observer === undefined) return
      try {
        new Observer(strip).observe(root, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: names
        })
      } catch {
        // No way to watch: the single pass above still happened.
      }
    }

    const owner = pageDocument()
    if (owner?.readyState === 'loading' && typeof owner.addEventListener === 'function') {
      try {
        owner.addEventListener('DOMContentLoaded', start, { once: true })
      } catch {
        start()
      }
    } else {
      start()
    }
  }

  for (const call of calls) {
    /*
      One guard per call, not one for the loop.

      A scriptlet that throws must cost only itself. Wrapping the loop instead would let the first
      failure discard every scriptlet after it — and the order in a filter list is arbitrary, so which
      ones survived would depend on nothing the user could see.
    */
    try {
      const [first, second] = call.args
      switch (call.name) {
        case 'abort-on-property-read':
          if (first !== undefined) abortOn(first, 'read')
          break
        case 'abort-on-property-write':
          if (first !== undefined) abortOn(first, 'write')
          break
        case 'abort-current-script':
          if (first !== undefined) abortCurrentScript(first, second)
          break
        case 'set-constant':
          if (first !== undefined) setConstant(first, second)
          break
        case 'addEventListener-defuser':
          defuseEventListener(first, second)
          break
        case 'prevent-setTimeout':
          preventTimer('setTimeout', first, second)
          break
        case 'prevent-setInterval':
          preventTimer('setInterval', first, second)
          break
        case 'remove-attr':
          removeAttr(first, second)
          break
        default:
          // An unimplemented name should never arrive — `lookupScriptlet` refuses it at parse time and
          // counts it. Ignored rather than reported, because there is nowhere to report to from inside
          // a page and the count already exists.
          break
      }
    } catch {
      // See above: this call only.
    }
  }
}
