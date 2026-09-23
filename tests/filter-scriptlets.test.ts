import { afterEach, describe, expect, it, vi } from 'vitest'
import { createContext, Script } from 'node:vm'
import {
  IMPLEMENTED_SCRIPTLETS,
  buildScriptletIndex,
  canonicalScriptletName,
  lookupScriptlet,
  parseScriptletArgs,
  scriptletsFor,
  type ScriptletCall
} from '@shared/filters/scriptlets.js'
import { runScriptlets } from '@shared/filters/scriptlet-runtime.js'
import { parseFilterList } from '@shared/filters/parse.js'
import { asScriptletCalls } from '@shared/filters/injection.js'

/**
 * `##+js(…)` — the half of a filter list that runs code, from list text to a page.
 *
 * ## What was missing
 *
 * A network rule stops a request and a cosmetic rule hides an element. Neither touches a page whose own
 * script decides what to show: a wall that reads `window.canRunAds` and blanks the article, an overlay
 * installed by `setTimeout`, a redirect fired from a click handler on the document. Scriptlets are what
 * defeat those, and the three lists this browser ships carry **2 123** of them. Almost all are in uAssets'
 * annoyances list, which is on by default and aimed at exactly those walls — there they outnumber hiding
 * rules four to one. This build honours 1 720 of the 2 123; the rest are counted by name.
 *
 * They were not simply unimplemented. `##` was read as "a selector follows", so
 * `+js(set-constant, canRunAds, true)` was stored as a CSS selector and written into the page's
 * stylesheet, where it invalidated the entire rule it was joined into and took every real hiding rule in
 * that batch with it.
 *
 * ## How this is tested
 *
 * The runtime is compiled from its own source in an **empty `node:vm` context**, which is what
 * `executeInMainWorld` does to it: serialise the function, re-compile it in the page's world, where this
 * module does not exist. `fingerprint-masking.test.ts` established the pattern and the reason — a call to
 * a shared helper or a module constant passes every other kind of test and throws `ReferenceError` in a
 * real page.
 *
 * So the tests below build a fabricated page, run the compiled copy against it, and ask what the *page*
 * can now observe. Nothing here reaches into the runtime's internals, because a page cannot either.
 *
 * Every one of those tests then runs a second time against the imported function itself, on this realm's
 * global with the page's globals stubbed in. `IN_PLACE` below says why that is needed and why it is not a
 * weaker copy of the first.
 */

/** The runtime as the page gets it: source text, re-compiled with no scope to fall back on. */
function compiled(context: object): (calls: readonly ScriptletCall[]) => void {
  return new Script(`(${runScriptlets.toString()})`).runInContext(createContext(context)) as (
    calls: readonly ScriptletCall[]
  ) => void
}

type Runner = (calls: readonly ScriptletCall[]) => void

/**
 * One way of putting the runtime in front of a page. Every behaviour below is asked of both.
 *
 * `page` builds the page with the globals a test gives it, and `runnerFor` hands back the runtime that will
 * act on that page.
 */
interface Harness {
  readonly name: string
  readonly page: (extra?: Record<string, unknown>) => Record<string, unknown>
  readonly runnerFor: (world: Record<string, unknown>) => Runner
}

/**
 * The runtime as the page gets it: compiled from its source in an empty context whose global object *is*
 * the fabricated page. This is the copy that proves self-containment.
 */
const COMPILED: Harness = {
  name: 'compiled into an empty context',
  page: (extra = {}) => ({ ...extra }),
  runnerFor: compiled
}

/**
 * Everything a fresh `node:vm` context lacks and Node's own global has.
 *
 * Stubbed away before each in-place run, so the two harnesses start from the same page: without it the
 * in-place copy would find Node's real `EventTarget` and `setTimeout` and patch those instead of the page's.
 */
const HOST_GLOBALS = ['document', 'EventTarget', 'MutationObserver', 'setTimeout', 'setInterval']

/**
 * The runtime as it is imported: this realm's `globalThis`, with the page's globals stubbed onto it.
 *
 * Needed for a reason that is about the tools and not about the runtime. The compiled copy is a new script
 * with no source file behind it, so coverage never sees a line of it run and the file reports as untested
 * however thoroughly it is. Running the same assertions in place is what lets the measurement agree with the
 * suite. It is not the weaker test of the two: this module is strict mode where the compiled copy is not, so
 * a write the runtime makes to something read-only throws here and is silently dropped there — and the
 * guards have to hold in both.
 */
const IN_PLACE: Harness = {
  name: 'run in place',
  page: (extra = {}) => {
    for (const key of HOST_GLOBALS) vi.stubGlobal(key, undefined)
    for (const [key, value] of Object.entries(extra)) vi.stubGlobal(key, value)
    return globalThis
  },
  runnerFor: () => runScriptlets
}

/**
 * Global names that existed before a test, so what a scriptlet defined on the real global can be taken off
 * again. `vi.unstubAllGlobals` restores what was stubbed; a property the runtime *created* — `canRunAds`,
 * `adBlockDetector` — was never stubbed, and would otherwise be there for the next test to read.
 */
let globalsBefore: ReadonlySet<PropertyKey> = new Set(Reflect.ownKeys(globalThis))

afterEach(() => {
  vi.unstubAllGlobals()
  for (const key of Reflect.ownKeys(globalThis)) {
    if (!globalsBefore.has(key)) Reflect.deleteProperty(globalThis, key)
  }
  globalsBefore = new Set(Reflect.ownKeys(globalThis))
})

/**
 * The error a property access threw, reduced to its name and message.
 *
 * Returns it rather than asserting on it, so the `expect` stays in the test that cares — and because the
 * obvious assertion does not work here. `toThrow(ReferenceError)` fails: the scriptlet runs inside a
 * `node:vm` context, which is its own realm with its own `ReferenceError` constructor, so what is thrown
 * is not an `instanceof` the one this file can see.
 *
 * That is not an artefact of the test. It is what happens in a page — the error has to be native to the
 * *page's* realm for a script's own `catch` to treat it as one — so the name is the thing worth checking
 * and `instanceof` is the thing that would have been checking the test harness.
 *
 * `undefined` when nothing was thrown, which reads as a failed assertion at the call site rather than as
 * a passing one.
 */
function abortOf(read: () => unknown): { name: unknown; message: unknown } | undefined {
  try {
    read()
    return undefined
  } catch (error) {
    return {
      name: (error as { name?: unknown }).name,
      message: (error as { message?: unknown }).message
    }
  }
}

describe('the runtime compiled from its own source', () => {
  it('compiles from its own source with no scope, and runs', () => {
    /*
      The claim that cannot be checked any other way. `runScriptlets` is one function with its helpers
      nested inside precisely so this holds; a helper factored out to file scope would compile, bundle,
      pass review, and throw in every page.
    */
    const world: Record<string, unknown> = {}
    expect(() => compiled(world)([{ name: 'set-constant', args: ['ok', 'true'] }])).not.toThrow()
    expect(world.ok).toBe(true)
  })
})

describe.each([COMPILED, IN_PLACE])('the runtime, $name', ({ page, runnerFor }) => {
  describe('the library as a whole', () => {
    it('has an implementation for every name it advertises', () => {
      // `IMPLEMENTED_SCRIPTLETS` is what the alias table promises. A name in there that the runtime's switch
      // does not handle is a rule the parser accepts, stores, sends to the page and silently ignores.
      for (const name of IMPLEMENTED_SCRIPTLETS) {
        const world = page({ probe: 1 })
        const run = runnerFor(world)
        // Arguments that are plausible for any of them: a property path and a value.
        expect(() => run([{ name, args: ['probe', 'true'] }]), name).not.toThrow()
      }
    })

    it('lets one failing scriptlet cost only itself', () => {
      /*
        One guard per call rather than one for the loop. List order is arbitrary, so a single guard would
        make "which scriptlets ran" depend on where the broken one happened to sit.

        `abort-on-property-read` on a frozen object is the failure used here because it is real: the page
        may have sealed the object first.
      */
      const world = page({ frozen: Object.freeze({ locked: 1 }) })
      const run = runnerFor(world)
      run([
        { name: 'abort-on-property-read', args: ['frozen.locked'] },
        { name: 'set-constant', args: ['after', 'true'] }
      ])
      expect(world.after, 'a later scriptlet was lost to an earlier failure').toBe(true)
    })

    it('ignores a name it has no implementation for', () => {
      // `lookupScriptlet` refuses one at parse time, so this can only be a call from a build that differs
      // from the preload's. Doing nothing is the one answer that cannot break the page.
      const world = page({ untouched: 'original' })
      expect(() =>
        runnerFor(world)([{ name: 'no-such-scriptlet', args: ['untouched', 'true'] }])
      ).not.toThrow()
      expect(world.untouched).toBe('original')
    })

    it('does nothing for a property scriptlet that names no property', () => {
      const world = page({ untouched: 'original' })
      const run = runnerFor(world)
      for (const name of [
        'abort-on-property-read',
        'abort-on-property-write',
        'abort-current-script',
        'set-constant'
      ]) {
        expect(() => run([{ name, args: [] }]), name).not.toThrow()
      }
      expect(world.untouched).toBe('original')
    })

    it('lets a path whose owner throws on being read cost only its own call', () => {
      // The page's own getter throwing while the chain is followed is the page's error, surfacing inside a
      // scriptlet. It must stop that one call and not the ones after it.
      const trap = Object.defineProperty({}, 'inner', {
        get: () => {
          throw new Error("the page's own getter")
        }
      })
      const world = page({ trap })
      runnerFor(world)([
        { name: 'set-constant', args: ['trap.inner.flag', 'true'] },
        { name: 'set-constant', args: ['after', 'true'] }
      ])
      expect(world.after).toBe(true)
    })
  })

  describe('set-constant', () => {
    it('answers with the value the list asked for', () => {
      const world = page()
      runnerFor(world)([{ name: 'set-constant', args: ['canRunAds', 'true'] }])
      expect(world.canRunAds).toBe(true)
    })

    it('ignores the page writing over it, rather than throwing', () => {
      /*
        The page is *expected* to assign here — that is why the wall reads the property — so a throw on
        assignment would break the script instead of lying to it. `set-constant` means the answer does not
        change, not that writing is an error.
      */
      const world = page()
      runnerFor(world)([{ name: 'set-constant', args: ['canRunAds', 'true'] }])
      expect(() => {
        ;(world as { canRunAds?: unknown }).canRunAds = false
      }).not.toThrow()
      expect(world.canRunAds).toBe(true)
    })

    it('understands the vocabulary the lists use', () => {
      const cases: Array<[string, unknown]> = [
        ['true', true],
        ['false', false],
        ['null', null],
        ['undefined', undefined],
        ['0', 0],
        ['-1.5', -1.5],
        ["''", '']
      ]
      for (const [argument, expected] of cases) {
        const world = page()
        runnerFor(world)([{ name: 'set-constant', args: ['value', argument] }])
        expect(world.value, argument).toBe(expected)
      }
    })

    it('installs the callable forms as functions', () => {
      const world = page()
      const run = runnerFor(world)
      run([{ name: 'set-constant', args: ['noop', 'noopFunc'] }])
      run([{ name: 'set-constant', args: ['yes', 'trueFunc'] }])
      expect(typeof world.noop).toBe('function')
      expect((world.yes as () => boolean)()).toBe(true)
    })

    it('declines a value it does not recognise instead of guessing', () => {
      /*
        uBO also accepts a bare string here. This deliberately does not: a page reading an unexpected string
        is harder to reason about than a scriptlet that declined, and declining leaves the page as it was.
      */
      const world = page({ untouched: 'original' })
      runnerFor(world)([{ name: 'set-constant', args: ['untouched', 'someString'] }])
      expect(world.untouched).toBe('original')
    })

    it('reaches a property the page has not created yet', () => {
      /*
        The case that makes this feature work at all. The wall commonly sits behind an object built by the
        very script being defused, so the property does not exist at `document-start` — a scriptlet that
        needed the chain to be there already would apply to almost nothing.
      */
      const world = page()
      runnerFor(world)([{ name: 'set-constant', args: ['adBlockDetector.enabled', 'false'] }])
      ;(world as { adBlockDetector?: unknown }).adBlockDetector = {}
      expect((world.adBlockDetector as { enabled?: unknown }).enabled).toBe(false)
    })

    it("leaves the page's own assignment of the intermediate object intact", () => {
      // The chain watcher must not swallow what the page put there: the object the page assigned has to be
      // the object the page then reads back, or every property on it disappears.
      const world = page()
      runnerFor(world)([{ name: 'set-constant', args: ['config.ads', 'true'] }])
      const own = { other: 'kept' }
      ;(world as { config?: unknown }).config = own
      expect((world.config as { other?: unknown }).other).toBe('kept')
      expect((world.config as { ads?: unknown }).ads).toBe(true)
    })

    it('installs the rest of the vocabulary as the values it names', () => {
      const world = page()
      runnerFor(world)([
        { name: 'set-constant', args: ['noop', 'noopFunc'] },
        { name: 'set-constant', args: ['no', 'falseFunc'] },
        { name: 'set-constant', args: ['list', 'emptyArr'] },
        { name: 'set-constant', args: ['bag', 'emptyObj'] }
      ])
      expect((world.noop as () => unknown)()).toBeUndefined()
      expect((world.no as () => boolean)()).toBe(false)
      expect(world.list).toEqual([])
      expect(world.bag).toEqual({})
    })

    it('declines a call that names no value', () => {
      // `+js(set, foo)` says which property and not what to answer. Guessing `undefined` would be a
      // value the list never asked for.
      const world = page({ untouched: 'original' })
      runnerFor(world)([{ name: 'set-constant', args: ['untouched'] }])
      expect(world.untouched).toBe('original')
    })

    it('reads a path with no names in it as no path at all', () => {
      const world = page()
      expect(() => runnerFor(world)([{ name: 'set-constant', args: ['.', 'true'] }])).not.toThrow()
      expect(Reflect.has(world, '')).toBe(false)
    })

    it('carries on down the chain when the page supplies a function as the intermediate', () => {
      // Functions carry properties too, and a page commonly hangs its configuration on one.
      const world = page()
      runnerFor(world)([{ name: 'set-constant', args: ['api.enabled', 'false'] }])
      ;(world as { api?: unknown }).api = function api(): void {}
      expect((world.api as { enabled?: unknown }).enabled).toBe(false)
    })

    it('lets the page put a plain value where the chain expected an object', () => {
      // Nothing to install a property on, so nothing is installed — and the page's own assignment stands.
      const world = page()
      runnerFor(world)([{ name: 'set-constant', args: ['config.ads', 'true'] }])
      expect(() => {
        ;(world as { config?: unknown }).config = 5
      }).not.toThrow()
      expect(world.config).toBe(5)
    })
  })

  describe('abort-on-property-read and -write', () => {
    it('throws a ReferenceError when the page reads the property', () => {
      // A `ReferenceError` because that is what the page's own code would have produced had the variable
      // never existed — which is the state the wall is being told it is in.
      const world = page()
      runnerFor(world)([{ name: 'abort-on-property-read', args: ['adsBlocked'] }])
      expect(abortOf(() => (world as { adsBlocked?: unknown }).adsBlocked)).toEqual({
        name: 'ReferenceError',
        message: 'adsBlocked'
      })
    })

    it('leaves writing alone in the read variant, and reading alone in the write variant', () => {
      const reading = page()
      runnerFor(reading)([{ name: 'abort-on-property-read', args: ['flag'] }])
      expect(() => {
        ;(reading as { flag?: unknown }).flag = 1
      }).not.toThrow()

      const writing = page()
      runnerFor(writing)([{ name: 'abort-on-property-write', args: ['detector'] }])
      expect(() => (writing as { detector?: unknown }).detector).not.toThrow()
      expect(
        abortOf(() => {
          ;(writing as { detector?: unknown }).detector = () => undefined
        })
      ).toEqual({ name: 'ReferenceError', message: 'detector' })
    })
  })

  describe('abort-current-script', () => {
    /**
     * The most-used scriptlet of the eight (411 rules), and the only one that needs the page's execution
     * state: it aborts the script *currently running* if that script's text matches, while every other
     * reader of the same property gets the real value. `document.currentScript` is what makes that possible.
     */
    it('throws only while the matching inline script is the one reading', () => {
      const world = page({
        document: { currentScript: { textContent: 'if (!window.canRunAds) showWall()' } },
        canRunAds: 'real'
      })
      runnerFor(world)([{ name: 'abort-current-script', args: ['canRunAds', 'showWall'] }])
      expect(abortOf(() => (world as { canRunAds?: unknown }).canRunAds)).toEqual({
        name: 'ReferenceError',
        message: 'canRunAds'
      })
    })

    it('gives the real value to a script whose text does not match', () => {
      const document = { currentScript: { textContent: 'analytics.init()' } }
      const world = page({ document, canRunAds: 'real' })
      runnerFor(world)([{ name: 'abort-current-script', args: ['canRunAds', 'showWall'] }])
      expect(world.canRunAds).toBe('real')
    })

    it('gives the real value when no inline script is running at all', () => {
      /*
        An external script, or a call from a later event handler: `currentScript` is null or has no text.
        The pattern is about inline text, so with none there is nothing to abort — and throwing here would
        break every unrelated reader on the page.
      */
      const world = page({ document: { currentScript: null }, canRunAds: 'real' })
      runnerFor(world)([{ name: 'abort-current-script', args: ['canRunAds', 'showWall'] }])
      expect(world.canRunAds).toBe('real')
    })

    it('aborts every reader when the pattern is absent', () => {
      // `+js(acs, prop)` with no pattern means "any script", which is what an empty matcher has to mean.
      const world = page({ document: { currentScript: { textContent: 'anything at all' } } })
      runnerFor(world)([{ name: 'abort-current-script', args: ['prop'] }])
      expect(abortOf(() => (world as { prop?: unknown }).prop)).toEqual({
        name: 'ReferenceError',
        message: 'prop'
      })
    })

    it('gives the real value when the document cannot say which script is running', () => {
      // A document mid-teardown can throw on `currentScript`. Not knowing is not a match.
      const document = Object.defineProperty({}, 'currentScript', {
        get: () => {
          throw new Error('document is gone')
        }
      })
      const world = page({ document, canRunAds: 'real' })
      runnerFor(world)([{ name: 'abort-current-script', args: ['canRunAds', 'showWall'] }])
      expect(world.canRunAds).toBe('real')
    })

    it('keeps what the page writes, and hands it back to the scripts it does not abort', () => {
      const world = page({ document: { currentScript: null }, canRunAds: 'real' })
      runnerFor(world)([{ name: 'abort-current-script', args: ['canRunAds', 'showWall'] }])
      ;(world as { canRunAds?: unknown }).canRunAds = 'written'
      expect(world.canRunAds).toBe('written')
    })
  })

  describe('addEventListener-defuser', () => {
    /** A minimal `EventTarget`, because the scriptlet patches its prototype rather than an instance. */
    function targetWorld(): {
      world: Record<string, unknown>
      attached: Array<[string, string]>
    } {
      const attached: Array<[string, string]> = []
      class FakeTarget {
        addEventListener(type: string, handler: unknown): void {
          attached.push([type, String(handler)])
        }
      }
      return { world: page({ EventTarget: FakeTarget }), attached }
    }

    it('drops a listener whose type and handler both match', () => {
      const { world, attached } = targetWorld()
      runnerFor(world)([{ name: 'addEventListener-defuser', args: ['click', 'openPopup'] }])
      const target = new (
        world.EventTarget as new () => { addEventListener: (...args: unknown[]) => void }
      )()
      target.addEventListener('click', () => 'openPopup')
      expect(attached, 'the listener was attached anyway').toEqual([])
    })

    it('attaches a listener whose handler does not match', () => {
      const { world, attached } = targetWorld()
      runnerFor(world)([{ name: 'addEventListener-defuser', args: ['click', 'openPopup'] }])
      const target = new (
        world.EventTarget as new () => { addEventListener: (...args: unknown[]) => void }
      )()
      target.addEventListener('click', () => 'submitForm')
      expect(attached).toHaveLength(1)
    })

    it('attaches a listener of another type', () => {
      const { world, attached } = targetWorld()
      runnerFor(world)([{ name: 'addEventListener-defuser', args: ['click', ''] }])
      const target = new (
        world.EventTarget as new () => { addEventListener: (...args: unknown[]) => void }
      )()
      target.addEventListener('keydown', function () {
        return 1
      })
      expect(attached).toHaveLength(1)
    })

    it('does nothing on a page with no EventTarget rather than throwing', () => {
      const world = page()
      expect(() =>
        runnerFor(world)([{ name: 'addEventListener-defuser', args: ['click'] }])
      ).not.toThrow()
    })

    it('leaves a page alone whose EventTarget has no addEventListener', () => {
      const prototype: Record<string, unknown> = {}
      const world = page({ EventTarget: { prototype } })
      expect(() =>
        runnerFor(world)([{ name: 'addEventListener-defuser', args: ['click'] }])
      ).not.toThrow()
      expect(prototype.addEventListener).toBeUndefined()
    })

    it('attaches a listener registered without a type name', () => {
      // No type is no match for a rule that names one. Dropping it would be defusing on a guess.
      const { world, attached } = targetWorld()
      runnerFor(world)([{ name: 'addEventListener-defuser', args: ['click', 'openPopup'] }])
      const target = new (
        world.EventTarget as new () => { addEventListener: (...args: unknown[]) => void }
      )()
      target.addEventListener(undefined, () => 'openPopup')
      expect(attached).toHaveLength(1)
    })

    it('does not read an object listener as its [object Object] text', () => {
      // `{ handleEvent }` is a legal listener. Stringified it is `[object Object]`, which a loose pattern can
      // match — and defusing it for that would be defusing an arbitrary listener.
      const { world, attached } = targetWorld()
      runnerFor(world)([{ name: 'addEventListener-defuser', args: ['click', 'object'] }])
      const target = new (
        world.EventTarget as new () => { addEventListener: (...args: unknown[]) => void }
      )()
      target.addEventListener('click', { handleEvent: () => undefined })
      expect(attached).toHaveLength(1)
    })
  })

  describe('prevent-setTimeout and prevent-setInterval', () => {
    it('drops a timer whose handler matches, and returns a usable id', () => {
      /*
        The id matters. A page that does `const id = setTimeout(…); clearTimeout(id)` must not be handed
        `undefined` — `clearTimeout` tolerates it, but code that compares the id or keeps it in a map does
        not, and breaking that would be breaking the page to defeat an overlay.
      */
      const calls: unknown[] = []
      const world = page({
        setTimeout: (handler: unknown, delay: unknown) => {
          calls.push([String(handler), delay])
          return 99
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['showOverlay'] }])
      const id = (world.setTimeout as (handler: unknown, delay?: unknown) => unknown)(
        () => 'showOverlay',
        500
      )
      expect(calls).toEqual([])
      expect(typeof id).toBe('number')
    })

    it('sets a timer whose handler does not match', () => {
      const calls: unknown[] = []
      const world = page({
        setTimeout: (handler: unknown) => {
          calls.push(String(handler))
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['showOverlay'] }])
      ;(world.setTimeout as (handler: unknown) => unknown)(() => 'loadArticle')
      expect(calls).toHaveLength(1)
    })

    it('honours the delay argument as an exact match', () => {
      // `+js(nostif, handler, 1000)` means that handler *at that delay*. Matching any delay would defuse a
      // timer the list did not name.
      const calls: unknown[] = []
      const world = page({
        setTimeout: (_handler: unknown, delay: unknown) => {
          calls.push(delay)
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['wall', '1000'] }])
      const set = world.setTimeout as (handler: unknown, delay?: unknown) => unknown
      const handler = () => 'wall'
      set(handler, 1000)
      set(handler, 250)
      expect(calls).toEqual([250])
    })

    it('patches setInterval independently of setTimeout', () => {
      const intervals: unknown[] = []
      const timeouts: unknown[] = []
      const world = page({
        setInterval: (handler: unknown) => {
          intervals.push(String(handler))
          return 1
        },
        setTimeout: (handler: unknown) => {
          timeouts.push(String(handler))
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setInterval', args: ['poll'] }])
      const poller = () => 'poll'
      ;(world.setInterval as (handler: unknown) => unknown)(poller)
      ;(world.setTimeout as (handler: unknown) => unknown)(poller)
      expect(intervals, 'the interval was not defused').toEqual([])
      expect(timeouts, 'setTimeout was defused by a setInterval rule').toHaveLength(1)
    })

    it('treats a regular-expression argument as one', () => {
      const calls: unknown[] = []
      const world = page({
        setTimeout: (handler: unknown) => {
          calls.push(String(handler))
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['/show(Wall|Overlay)/'] }])
      const set = world.setTimeout as (handler: unknown) => unknown
      set(() => 'showOverlay')
      set(() => 'showArticle')
      expect(calls).toHaveLength(1)
    })

    it('inverts a pattern that begins with an exclamation mark', () => {
      // uBO's negation: defuse everything *except* what matches.
      const calls: unknown[] = []
      const world = page({
        setTimeout: (handler: unknown) => {
          calls.push(String(handler))
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['!keepMe'] }])
      const set = world.setTimeout as (handler: unknown) => unknown
      set(() => 'keepMe')
      set(() => 'dropMe')
      expect(calls).toHaveLength(1)
      expect(calls[0]).toContain('keepMe')
    })

    it('matches a handler given as a string of code', () => {
      // `setTimeout('showOverlay()', 10)` is legal and still written. The string is the code, so it is the
      // text the pattern is about.
      const calls: unknown[] = []
      const world = page({
        setTimeout: (handler: unknown) => {
          calls.push(handler)
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['showOverlay'] }])
      const set = world.setTimeout as (handler: unknown, delay?: unknown) => unknown
      set('showOverlay()', 10)
      set('loadArticle()', 10)
      expect(calls).toEqual(['loadArticle()'])
    })

    it('does not read an object handler as its [object Object] text', () => {
      const calls: unknown[] = []
      const world = page({
        setTimeout: (handler: unknown) => {
          calls.push(handler)
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['object'] }])
      ;(world.setTimeout as (handler: unknown) => unknown)({})
      expect(calls).toHaveLength(1)
    })

    it('reads a delay written as a string as the number it is, and an object as no delay', () => {
      // `setTimeout(fn, '1000')` is the same instruction to the engine as `1000`. An object is neither,
      // whatever it stringifies to.
      const calls: unknown[] = []
      const world = page({
        setTimeout: (_handler: unknown, delay: unknown) => {
          calls.push(delay)
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['wall', '1000'] }])
      const set = world.setTimeout as (handler: unknown, delay?: unknown) => unknown
      const handler = (): string => 'wall'
      const disguised = { toString: () => '1000' }
      set(handler, '1000')
      set(handler, disguised)
      expect(calls).toEqual([disguised])
    })

    it('defuses nothing for a pattern that cannot compile', () => {
      // A malformed expression matches nothing rather than throwing, so a bad rule costs its own rule.
      const calls: unknown[] = []
      const world = page({
        setTimeout: (handler: unknown) => {
          calls.push(handler)
          return 1
        }
      })
      runnerFor(world)([{ name: 'prevent-setTimeout', args: ['/([/'] }])
      ;(world.setTimeout as (handler: unknown) => unknown)(() => 'anything')
      expect(calls).toHaveLength(1)
    })
  })

  describe('remove-attr', () => {
    it('strips the attribute from every element carrying it', () => {
      const removed: string[] = []
      const element = {
        removeAttribute: (name: string): void => {
          removed.push(name)
        }
      }
      const world = page({
        document: {
          readyState: 'complete',
          documentElement: {},
          querySelectorAll: () => [element]
        }
      })
      runnerFor(world)([{ name: 'remove-attr', args: ['onclick'] }])
      expect(removed).toEqual(['onclick'])
    })

    it('takes several attribute names separated by a pipe', () => {
      const removed: string[] = []
      const element = {
        removeAttribute: (name: string): void => {
          removed.push(name)
        }
      }
      const world = page({
        document: { readyState: 'complete', documentElement: {}, querySelectorAll: () => [element] }
      })
      runnerFor(world)([{ name: 'remove-attr', args: ['onclick|target'] }])
      expect(removed).toEqual(['onclick', 'target'])
    })

    it('does nothing without an attribute name', () => {
      const world = page({ document: { readyState: 'complete' } })
      expect(() => runnerFor(world)([{ name: 'remove-attr', args: [] }])).not.toThrow()
    })

    it('survives a page with no document at all', () => {
      // A worker-like context, or a document torn down between the answer and the injection.
      const world = page()
      expect(() => runnerFor(world)([{ name: 'remove-attr', args: ['onclick'] }])).not.toThrow()
    })

    it('confines itself to the elements the selector names', () => {
      const removed: string[] = []
      const element = {
        removeAttribute: (name: string): void => {
          removed.push(name)
        }
      }
      const asked: string[] = []
      const world = page({
        document: {
          readyState: 'complete',
          querySelectorAll: (selector: string) => {
            asked.push(selector)
            return selector === '.ad' ? [element] : []
          }
        }
      })
      runnerFor(world)([{ name: 'remove-attr', args: ['onclick', '.ad'] }])
      expect(asked).toEqual(['.ad'])
      expect(removed).toEqual(['onclick'])
    })

    it('carries on past a query the page refuses and an element that refuses', () => {
      // One attribute whose selector the page cannot parse, and one element that throws, must not stop
      // the attributes and elements after them.
      const removed: string[] = []
      const stubborn = {
        removeAttribute: (): void => {
          throw new Error('detached')
        }
      }
      const willing = {
        removeAttribute: (name: string): void => {
          removed.push(name)
        }
      }
      const world = page({
        document: {
          readyState: 'complete',
          querySelectorAll: (selector: string) => {
            if (selector === '[bad]') throw new Error('not a selector')
            return [stubborn, willing]
          }
        }
      })
      runnerFor(world)([{ name: 'remove-attr', args: ['bad|onclick'] }])
      expect(removed).toEqual(['onclick'])
    })

    it('waits for the document to be parsed when it runs before it', () => {
      // At `document-start` there is nothing to strip yet. Stripping once then would remove nothing.
      const removed: string[] = []
      const listeners: Array<[string, () => void, unknown]> = []
      const world = page({
        document: {
          readyState: 'loading',
          querySelectorAll: () => [
            {
              removeAttribute: (name: string): void => {
                removed.push(name)
              }
            }
          ],
          addEventListener: (type: string, listener: () => void, options: unknown) => {
            listeners.push([type, listener, options])
          }
        }
      })
      runnerFor(world)([{ name: 'remove-attr', args: ['onclick'] }])
      expect(removed).toEqual([])
      expect(listeners.map(([type, , options]) => [type, options])).toEqual([
        ['DOMContentLoaded', { once: true }]
      ])

      listeners[0]![1]()
      expect(removed).toEqual(['onclick'])
    })

    it('strips at once when it cannot wait for the document', () => {
      const removed: string[] = []
      const world = page({
        document: {
          readyState: 'loading',
          querySelectorAll: () => [
            {
              removeAttribute: (name: string): void => {
                removed.push(name)
              }
            }
          ],
          addEventListener: () => {
            throw new Error('document is gone')
          }
        }
      })
      runnerFor(world)([{ name: 'remove-attr', args: ['onclick'] }])
      expect(removed).toEqual(['onclick'])
    })

    it('strips again whenever the page puts the attribute back', () => {
      // The attribute is usually *added* by the script this exists to counter, so one pass is not enough.
      const removed: string[] = []
      const observed: Array<[unknown, unknown]> = []
      let onMutation: (() => void) | null = null
      class Observer {
        constructor(callback: () => void) {
          onMutation = callback
        }
        observe(target: unknown, options: unknown): void {
          observed.push([target, options])
        }
      }
      const root = {}
      const world = page({
        MutationObserver: Observer,
        document: {
          readyState: 'complete',
          documentElement: root,
          querySelectorAll: () => [
            {
              removeAttribute: (name: string): void => {
                removed.push(name)
              }
            }
          ]
        }
      })
      runnerFor(world)([{ name: 'remove-attr', args: ['onclick'] }])
      expect(removed).toEqual(['onclick'])
      expect(observed).toHaveLength(1)
      expect(observed[0]![0]).toBe(root)
      expect(observed[0]![1]).toMatchObject({ attributes: true, attributeFilter: ['onclick'] })

      onMutation!()
      expect(removed).toEqual(['onclick', 'onclick'])
    })

    it('still makes its first pass when the page cannot be watched', () => {
      const removed: string[] = []
      function Refusing(): never {
        throw new Error('no observers here')
      }
      const world = page({
        MutationObserver: Refusing,
        document: {
          readyState: 'complete',
          documentElement: {},
          querySelectorAll: () => [
            {
              removeAttribute: (name: string): void => {
                removed.push(name)
              }
            }
          ]
        }
      })
      expect(() => runnerFor(world)([{ name: 'remove-attr', args: ['onclick'] }])).not.toThrow()
      expect(removed).toEqual(['onclick'])
    })
  })
})

// --- parsing ----------------------------------------------------------------

describe('reading a scriptlet out of a filter line', () => {
  it('takes the short names the lists actually use', () => {
    /*
      This is what decides whether the feature works at all. `acs` outnumbers `abort-current-script` by a
      wide margin in the real lists, so an implementation keyed on the long name alone would match almost
      nothing while testing perfectly.
    */
    expect(canonicalScriptletName('acs')).toBe('abort-current-script')
    expect(canonicalScriptletName('aeld')).toBe('addEventListener-defuser')
    expect(canonicalScriptletName('aopr')).toBe('abort-on-property-read')
    expect(canonicalScriptletName('set')).toBe('set-constant')
    expect(canonicalScriptletName('nostif')).toBe('prevent-setTimeout')
  })

  it('ignores a trailing .js and the case, as uBO does', () => {
    expect(canonicalScriptletName('set-constant.js')).toBe('set-constant')
    expect(canonicalScriptletName('  AOPR  ')).toBe('abort-on-property-read')
  })

  it('refuses a name it has no implementation for', () => {
    expect(canonicalScriptletName('nowebrtc')).toBeNull()
    expect(canonicalScriptletName('trusted-set-cookie')).toBeNull()
  })

  it('never resolves a trusted-* scriptlet', () => {
    /*
      Deliberate and worth a test of its own. That family exists to inject list-author-supplied *values*
      into a page — cookies, storage entries, replaced XHR responses — and there is no version of it this
      browser should offer. The three default lists ask for it 47 times.
    */
    for (const name of [
      'trusted-set-cookie',
      'trusted-set-local-storage-item',
      'trusted-click-element',
      'trusted-replace-xhr-response'
    ]) {
      expect(canonicalScriptletName(name), name).toBeNull()
    }
  })

  it('splits arguments on commas and keeps an escaped one', () => {
    expect(parseScriptletArgs('set-constant, foo.bar, true')).toEqual([
      'set-constant',
      'foo.bar',
      'true'
    ])
    expect(parseScriptletArgs('nostif, a\\,b')).toEqual(['nostif', 'a,b'])
  })

  it('keeps a backslash that is not escaping a comma, because arguments are regular expressions', () => {
    // `\d` has to survive. Treating every backslash as an escape would quietly change the pattern.
    expect(parseScriptletArgs('nostif, /\\d+/')).toEqual(['nostif', '/\\d+/'])
  })

  it('strips one matching pair of quotes, which is how a leading space is passed', () => {
    expect(parseScriptletArgs("set, x, ' '")).toEqual(['set', 'x', ' '])
    expect(parseScriptletArgs('set, x, "y"')).toEqual(['set', 'x', 'y'])
  })

  it('keeps an empty argument rather than dropping it', () => {
    // `+js(set-constant, foo, '')` means the empty string, which is not the same instruction as nothing.
    expect(parseScriptletArgs('set, foo, ')).toEqual(['set', 'foo', ''])
  })

  it('recognises a payload, and refuses one that is not closed', () => {
    expect(lookupScriptlet('+js(set, a, true)').kind).toBe('call')
    expect(lookupScriptlet('+js(set, a, true').kind).toBe('none')
    expect(lookupScriptlet('.ad-slot').kind).toBe('none')
  })

  it('reports an unimplemented scriptlet with its name', () => {
    const lookup = lookupScriptlet('+js(nowebrtc)')
    expect(lookup).toEqual({ kind: 'unimplemented', name: 'nowebrtc' })
  })

  it('refuses a payload that names no scriptlet, and counts it under a name somebody can read', () => {
    // `+js()` is a scriptlet line with nothing in it. It is still not a selector, and an empty name in the
    // diagnostics key would read as a formatting bug rather than as a rule the list got wrong.
    expect(lookupScriptlet('+js()')).toEqual({ kind: 'unimplemented', name: '' })
    expect(lookupScriptlet('+js(, canRunAds, true)')).toEqual({ kind: 'unimplemented', name: '' })
    expect(parseFilterList('example.com##+js()').diagnostics.unsupportedByReason).toEqual({
      'scriptlet-unimplemented:unnamed': 1
    })
  })
})

describe('which scriptlets a host gets', () => {
  const index = (text: string): ReturnType<typeof buildScriptletIndex> =>
    buildScriptletIndex(parseFilterList(text).scriptlet)

  it("gives a host its own rules and its parent domain's", () => {
    const built = index(
      ['shop.example.com##+js(set, a, true)', 'example.com##+js(set, b, true)'].join('\n')
    )
    expect(scriptletsFor(built, 'shop.example.com').map((call) => call.args[0])).toEqual(['a', 'b'])
  })

  it("does not give a parent a subdomain's rules", () => {
    const built = index('shop.example.com##+js(set, a, true)')
    expect(scriptletsFor(built, 'example.com')).toEqual([])
  })

  it('applies a rule that names no host everywhere', () => {
    const built = index('##+js(set, everywhere, true)')
    expect(scriptletsFor(built, 'anything.test')).toHaveLength(1)
  })

  it('honours a ~host exclusion', () => {
    const built = index('##+js(set, a, true)\nexample.com##+js(set, b, true)')
    expect(scriptletsFor(built, 'example.com')).toHaveLength(2)
    const excluded = index('~example.com##+js(set, a, true)')
    expect(scriptletsFor(excluded, 'example.com')).toEqual([])
    expect(scriptletsFor(excluded, 'other.test')).toHaveLength(1)
  })

  it('drops a duplicate two lists both asked for', () => {
    // The same call from two lists is one call. Running `set-constant` twice on one property is harmless
    // and running `remove-attr` twice installs two observers, which is not.
    const built = index('example.com##+js(set, a, true)\nexample.com##+js(set, a, true)')
    expect(scriptletsFor(built, 'example.com')).toHaveLength(1)
  })

  it('lets an exception cancel exactly the call it names', () => {
    const built = index(
      ['##+js(set, a, true)', '##+js(set, b, true)', 'example.com#@#+js(set, a, true)'].join('\n')
    )
    expect(scriptletsFor(built, 'example.com').map((call) => call.args[0])).toEqual(['b'])
    expect(scriptletsFor(built, 'other.test')).toHaveLength(2)
  })

  it('lets a bare exception cancel every call of that scriptlet on the host', () => {
    /*
      uBO compares the token text, which makes this form match nothing. The broader reading is chosen here
      because the bare form is what a list author writes to withdraw a scriptlet from a site it breaks —
      and honouring only the exact form would leave this browser running something the list took back. It
      errs towards running *less* code in a page, which is the right direction for the one feature that
      executes anything.
    */
    const built = index(
      ['##+js(set, a, true)', '##+js(set, b, false)', 'example.com#@#+js(set-constant)'].join('\n')
    )
    expect(scriptletsFor(built, 'example.com')).toEqual([])
    expect(scriptletsFor(built, 'other.test')).toHaveLength(2)
  })

  it('lets an exception that names no host cancel its call everywhere', () => {
    // `#@#+js(…)` with nothing in front is a list withdrawing the scriptlet outright. Applying it only to
    // the hosts some other rule named would leave it running on the rest.
    const built = index(
      ['##+js(set, a, true)', 'example.com##+js(set, a, true)', '#@#+js(set, a, true)'].join('\n')
    )
    expect(scriptletsFor(built, 'example.com')).toEqual([])
    expect(scriptletsFor(built, 'other.test')).toEqual([])
  })

  it('keeps every exception a host collects, not only the first', () => {
    const built = index(
      [
        '##+js(set, a, true)',
        '##+js(set, b, true)',
        '##+js(set, c, true)',
        'example.com#@#+js(set, a, true)',
        'example.com#@#+js(set, b, true)'
      ].join('\n')
    )
    expect(scriptletsFor(built, 'example.com').map((call) => call.args[0])).toEqual(['c'])
  })

  it('reads a stray ~ as excluding nothing rather than every host', () => {
    // `example.com,~` leaves an empty exclusion behind. It names no host, so it can exclude none — least
    // of all the site the same line names.
    const built = index('example.com,~##+js(set, a, true)')
    expect(scriptletsFor(built, 'example.com')).toHaveLength(1)
  })

  it('answers nothing for a host it has no rules for, and for no host at all', () => {
    const built = index('example.com##+js(set, a, true)')
    expect(scriptletsFor(built, 'other.test')).toEqual([])
    expect(scriptletsFor(built, '')).toEqual([])
  })
})

describe('what crosses into the preload', () => {
  /**
   * The answer arrives over `sendSync` from a build that may differ from the preload's, and each entry is
   * handed to a function that runs in the page's world. So the shape is re-established rather than
   * trusted: a name that is not a string would be interpolated into a property path, and an argument that
   * is not a string into a regular expression.
   */
  it('keeps a well-formed call', () => {
    expect(asScriptletCalls([{ name: 'set-constant', args: ['a', 'true'] }])).toEqual([
      { name: 'set-constant', args: ['a', 'true'] }
    ])
  })

  it('drops anything malformed rather than repairing it', () => {
    expect(
      asScriptletCalls([
        { name: 'set-constant', args: ['ok'] },
        { name: '', args: [] },
        { name: 'set-constant' },
        { name: 'set-constant', args: 'not-an-array' },
        { name: 'set-constant', args: [1, 2] },
        { name: 42, args: [] },
        null,
        'nonsense'
      ])
    ).toEqual([{ name: 'set-constant', args: ['ok'] }])
  })

  it('answers with nothing for a reply that is not a list', () => {
    expect(asScriptletCalls(undefined)).toEqual([])
    expect(asScriptletCalls({ name: 'set-constant', args: [] })).toEqual([])
  })
})
