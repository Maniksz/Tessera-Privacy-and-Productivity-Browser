import { contextBridge, ipcRenderer } from 'electron'
import {
  COSMETIC_GENERIC_CHANNEL,
  COSMETIC_SPECIFIC_CHANNEL,
  PROCEDURAL_CHANNEL,
  SCRIPTLET_CHANNEL,
  asCosmeticStyles,
  asProceduralSelectors,
  asScriptletCalls,
  sameFeatures,
  surveyFeatures
} from '@shared/filters/injection.js'
import { applyProceduralRules, type MatchableDocument } from '@shared/filters/procedural-match.js'
import type { ProceduralSelector } from '@shared/filters/procedural.js'
import { runScriptlets } from '@shared/filters/scriptlet-runtime.js'
import type { DocumentFeatures } from '@shared/filters/features.js'

/**
 * Puts the blocker's hiding rules into the page.
 *
 * Blocking a request removes an advert; it does not remove the space it occupied. This is what closes
 * the hole — and it is a third of what a filter list contains, so without it fifty thousand rules are
 * parsed on every launch and never used.
 *
 * ## Why the stylesheet goes in directly and the fingerprint masking does not
 *
 * A preload runs in an isolated world: its JavaScript cannot see the page's, which is why masking has
 * to cross over through `executeInMainWorld`. The *DOM* is not isolated — both worlds see one document
 * — so a `<style>` element appended from here styles the page. That makes this the rare case where the
 * boundary costs nothing.
 *
 * ## Why one element, replaced, rather than one per answer
 *
 * The generic rules arrive in instalments as the page grows, and each instalment is only what is new.
 * Appending would leave a page with dozens of `<style>` elements after a busy minute — visible in the
 * inspector, and a hint to a site that something is filtering it. One element whose text grows keeps
 * both the count and the shape constant.
 *
 * ## Why the host-specific rules are a second element, and this one is *replaced*
 *
 * They used to share the growing element, and that was the reason a rule the user had just written did
 * nothing until the page was reloaded. Reported as *"blocked elemente sind nicht blocked"*: the element
 * picker stored the rule and the engine recompiled it, and the document in front of the user — the one
 * they had just pointed at — was never told. Nothing in the browser could tell it, because the only way
 * host-specific rules ever arrived was a synchronous question asked once, before the page existed.
 *
 * So the core can now push them as well, and a push has to *replace* rather than append: the answer is
 * the complete set of host rules for this document, so appending a second copy on every change would
 * grow the sheet without bound and — worse — would make a rule the user *deleted* impossible to undo,
 * because the text that hid the element would still be there. Replacement is what makes deleting a rule
 * — or switching one off — take effect in front of the person doing it.
 */

/** The growing one: generic selectors, in instalments, each only what is new. */
const STYLE_ELEMENT_ID = 'tessera-cosmetic'

/** The replaced one: this host's rules, complete on every answer. See the docblock. */
const SPECIFIC_STYLE_ELEMENT_ID = 'tessera-cosmetic-host'

/** How long a mutation burst is allowed to settle before the page is surveyed again. */
const SURVEY_DEBOUNCE_MS = 250

/**
 * The address of the document this preload is running in.
 *
 * Read once, at install time, and reported with every request. The view's own URL is not usable here:
 * at `document-start` it has already moved to the page being loaded while this code runs for it, and by
 * the time an asynchronous report is answered it may have moved again. What is wanted is "which document
 * am I", and only this side knows that.
 */
function documentUrl(): string {
  try {
    return location.href
  } catch {
    return ''
  }
}

/**
 * The document as it actually is at `document-start`, rather than as the DOM types describe it.
 *
 * `lib.dom` declares `head` and `documentElement` non-nullable, and at every moment a web developer
 * writes code that is true. A preload runs earlier than that: `document-start` is before the parser has
 * produced `<head>`, so both can be null and the type is simply wrong for this timing.
 *
 * Named here rather than guarded with a cast at each use, because the alternative the linter suggests —
 * dropping the checks, since "they cannot be null" — would crash the preload and take the page with it.
 */
// `Omit` and not an intersection: `HTMLElement & (HTMLElement | null)` is still `HTMLElement`, so an
// intersection narrows where this has to widen. The original field has to be removed to be replaced.
const earlyDocument = document as Omit<Document, 'head' | 'documentElement'> & {
  head: HTMLHeadElement | null
  documentElement: HTMLElement | null
}

function styleElement(id: string): HTMLStyleElement | null {
  const existing = document.getElementById(id)
  if (existing instanceof HTMLStyleElement) return existing

  // No `<head>` yet means putting the sheet in `documentElement`, where it applies just as well. The
  // alternative is waiting, which is exactly the flash of visible advert this whole path prevents.
  const parent = earlyDocument.head ?? earlyDocument.documentElement
  if (parent === null) return null

  const created = document.createElement('style')
  created.id = id
  parent.appendChild(created)
  return created
}

function appendStyles(css: string): void {
  const element = styleElement(STYLE_ELEMENT_ID)
  if (element === null) return
  element.textContent = `${element.textContent}\n${css}`
}

/**
 * The host's rules, as the whole of them, replacing whatever was there.
 *
 * Answers whether it managed it, which the caller needs rather than ignores: at `document-start` there
 * may be no `<html>` to put a sheet in, and a silent failure there is the worst kind — the rules were
 * computed, sent, and simply never applied, with nothing anywhere reporting it. See
 * `installSpecificStyles` for what it does with a `false`.
 */
function replaceSpecificStyles(css: string): boolean {
  const element = styleElement(SPECIFIC_STYLE_ELEMENT_ID)
  if (element === null) return false
  element.textContent = css
  return true
}

/**
 * The host-specific rules: asked for before anything else runs, and re-served whenever they change.
 *
 * ## Why the question is synchronous
 *
 * It is the one place in this file that blocks. `document-start` is the last moment before the page's
 * own scripts, and an awaited answer arrives after them — which the user sees as the advert appearing
 * and then vanishing. The cost is one round trip on a channel the core answers from an in-memory index.
 *
 * ## Why there is also a listener on the same channel
 *
 * Because the answer can change while the document is open, and until it could be re-served it did not:
 * a rule written by the element picker took effect on the *next* page load, which reads as the picker
 * not working. The core pushes the complete set on the same channel; `replaceSpecificStyles` is what
 * makes a re-send safe, and the file docblock argues why replacement rather than appending.
 *
 * ## Why a failed first write is retried
 *
 * `styleElement` needs somewhere to put the sheet, and at `document-start` there may be no `<html>`
 * yet. That is a real timing on a slow first byte, and the failure is invisible — the rules arrive and
 * are dropped. One retry when the DOM exists costs a listener that is never installed on the common
 * path, and turns "sometimes this site is not filtered and nobody can say why" into a flicker.
 */
function installSpecificStyles(): void {
  /*
    The rules as last heard, written through one function.

    Held rather than passed to the retry below, and that is the whole reason this is a variable: a
    retry that closed over the *first* answer would undo a rule the user wrote in the meantime, which
    is the one thing this change exists to make impossible.
  */
  let latest = ''
  const write = (): boolean => replaceSpecificStyles(latest)

  ipcRenderer.on(COSMETIC_SPECIFIC_CHANNEL, (_event, payload: unknown) => {
    // Not `asCosmeticStyles`: that reads the empty string as "nothing to add", and here it is the
    // opposite — it is the core saying this document has no host rules *any more*, which is how a
    // rule the user deleted stops applying to the page they deleted it on.
    if (typeof payload !== 'string') return
    latest = payload
    write()
  })

  let answer: unknown
  try {
    answer = ipcRenderer.sendSync(COSMETIC_SPECIFIC_CHANNEL, documentUrl())
  } catch {
    // No responder — an old build, or a view created outside a hardened session. Hiding nothing is the
    // only safe reading; there is nothing to guess at.
    return
  }
  const css = asCosmeticStyles(answer)
  if (css === null) return
  latest = css
  if (write()) return

  document.addEventListener('DOMContentLoaded', write, { once: true })
}

/**
 * The generic rules, in instalments, as the page turns out to contain things.
 *
 * There are tens of thousands of selectors that apply to every site. Sending them all would be
 * megabytes of CSS per document, so the page says which class, id and tag names it actually uses and
 * gets back only what could match. A single-page application keeps building itself, so this repeats —
 * but only when the survey has genuinely changed, which on a busy page is a small fraction of the
 * mutation bursts.
 */
function installGenericStyles(): void {
  let reported: DocumentFeatures | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  ipcRenderer.on(COSMETIC_GENERIC_CHANNEL, (_event, payload: unknown) => {
    const css = asCosmeticStyles(payload)
    if (css !== null) appendStyles(css)
  })

  const survey = (): void => {
    timer = null
    let features: DocumentFeatures
    try {
      features = surveyFeatures(document.querySelectorAll('*'))
    } catch {
      // A document torn down mid-survey. Nothing to report and nothing to fix.
      return
    }
    // Almost every burst introduces no new name. Comparing here turns a channel call per burst into one
    // per genuinely new class — the difference between a few calls and thousands on a chat page.
    if (reported !== null && sameFeatures(reported, features)) return
    reported = features
    try {
      ipcRenderer.send(COSMETIC_GENERIC_CHANNEL, documentUrl(), features)
    } catch {
      // Same reading as above: no responder means nothing is hidden.
    }
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(survey, SURVEY_DEBOUNCE_MS)
  }

  const observe = (): void => {
    survey()
    const root = earlyDocument.documentElement
    if (root === null) return
    try {
      new MutationObserver(schedule).observe(root, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'id']
      })
    } catch {
      // The document was torn down between the check and the call. The one survey above still happened.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe, { once: true })
  } else {
    observe()
  }
}

/**
 * The scriptlets, in the page's own world, before the page's own scripts.
 *
 * ## Why this is the only part that crosses the isolation boundary
 *
 * The stylesheet above goes in through the DOM, which both worlds share — the rare case where context
 * isolation costs nothing. A scriptlet is the opposite: it has to redefine a property that the *page's*
 * script will read, and a property defined in this isolated world is invisible over there. So
 * `contextBridge.executeInMainWorld` is the only route, exactly as for fingerprint masking.
 *
 * ## Why synchronous, and why it runs first
 *
 * `sendSync`, for a harder reason than the stylesheet has. A late stylesheet shows an advert for a
 * moment. A late scriptlet does nothing at all: `abort-current-script` has to have redefined the property
 * before the inline script that reads it runs, and there is no second chance at it.
 *
 * One `executeInMainWorld` call for the whole library rather than one per scriptlet, which is what makes
 * `runScriptlets` a single function with its helpers nested inside — see the docblock there. The
 * alternative was eight serialisations of eight functions that would each have needed their own copy of
 * the dotted-path walker.
 */
function installScriptlets(): void {
  let answer: unknown
  try {
    answer = ipcRenderer.sendSync(SCRIPTLET_CHANNEL, documentUrl())
  } catch {
    // No responder — an old build, or a view created outside a hardened session. Running nothing is the
    // only safe reading: these change what a page's own script observes, and guessing is not available.
    return
  }

  const calls = asScriptletCalls(answer)
  if (calls.length === 0) return

  try {
    // The function is serialised and re-compiled in the page's world, so it may reference nothing from
    // this file. See `shared/filters/scriptlet-runtime.ts`.
    contextBridge.executeInMainWorld({ func: runScriptlets, args: [calls] })
  } catch (error) {
    console.warn('[cosmetic] scriptlets could not be installed:', error)
  }
}

/**
 * The rules no CSS engine can evaluate — `:has-text()`, `:upward()`, `:style()`.
 *
 * ## Why this one needs no `executeInMainWorld`
 *
 * The scriptlets have to cross into the page's world because they redefine properties the *page's* script
 * reads. These do not: matching needs the DOM, and the docblock at the top of this file already states the
 * fact that makes the difference — the DOM is not isolated, both worlds see one document. So the matcher
 * runs here, in the isolated world, where a page can neither observe it nor patch the methods it uses.
 *
 * ## Why it re-runs, and what bounds the cost
 *
 * A procedural rule matches on text, computed style and ancestry, so it cannot be evaluated before the DOM
 * exists and it cannot be evaluated once: the element a rule is about frequently arrives with a later
 * script. So it runs on `DOMContentLoaded` and again after each mutation burst — the same debounce the
 * generic-selector survey uses, and for the same reason.
 *
 * Three things keep that from being a tax on every page. Nothing is requested until the DOM is ready, so
 * the load path is untouched. The core answers with nothing at all unless a rule *names this host* — which
 * is why `parse.ts` refuses a generic procedural rule — so the observer below is only ever installed on
 * sites the user's or the lists' rules actually mention. And a re-run only re-applies what it finds; the
 * actions are idempotent (a `display: none` set twice is set once, a removed element is gone).
 */
function installProceduralFiltering(): void {
  let selectors: readonly ProceduralSelector[] = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let observing = false

  const apply = (): void => {
    timer = null
    if (selectors.length === 0) return
    try {
      /*
        One cast, at the boundary, for the same reason `earlyDocument` above needs one.

        `MatchableDocument` is a deliberately narrow view — it exists so that "what can a procedural rule do
        to my page" is answerable by reading one type in `procedural-match.ts`. A narrow view is not
        *assignable from* the real `Document`: `querySelectorAll` returns a `NodeListOf<Element>` whose
        members carry the whole DOM surface, which is wider than the view and therefore not the same type.
        Widening the view to satisfy the compiler would give the matcher back everything the view was
        written to withhold.
      */
      applyProceduralRules(selectors, document as unknown as MatchableDocument)
    } catch {
      // A document torn down mid-pass. Nothing to fix and nothing to report.
    }
  }

  const schedule = (): void => {
    if (timer !== null) return
    timer = setTimeout(apply, SURVEY_DEBOUNCE_MS)
  }

  const observe = (): void => {
    if (observing) return
    observing = true
    apply()
    const root = earlyDocument.documentElement
    if (root === null) return
    try {
      /*
        `attributes` is watched as well as the tree, and that is what makes `:matches-css()` and
        `:has-text()` keep working on a page that changes: a class or a style attribute arriving later is
        exactly how an advert becomes visible after the first pass. uBO's `:watch-attr()` exists to ask for
        this explicitly; watching always means that operator costs nothing to leave unimplemented.
      */
      new MutationObserver(schedule).observe(root, {
        childList: true,
        subtree: true,
        attributes: true
      })
    } catch {
      // The document went between the check and the call. The single pass above still happened.
    }
  }

  ipcRenderer.on(PROCEDURAL_CHANNEL, (_event, payload: unknown) => {
    const answered = asProceduralSelectors(payload)
    if (answered.length === 0) return
    selectors = answered
    observe()
  })

  const request = (): void => {
    try {
      ipcRenderer.send(PROCEDURAL_CHANNEL, documentUrl())
    } catch {
      // No responder — an old build, or a view outside a hardened session. Nothing is filtered.
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', request, { once: true })
  } else {
    request()
  }
}

/**
 * Installs all four parts. Called from the content preload only.
 *
 * Guarded as a whole as well as in parts: a failure here must cost the page its filtering and nothing
 * else. A preload that throws takes the document with it.
 *
 * Scriptlets first, and the order is the requirement rather than a preference. They are the only part
 * with a deadline — the page's first inline script — while a stylesheet arriving a millisecond later
 * costs a flicker. Guarded separately for the same reason: a page whose scriptlets failed must still get
 * its hiding rules.
 */
export function installCosmeticFiltering(): void {
  try {
    installScriptlets()
  } catch (error) {
    console.warn('[cosmetic] scriptlets could not be installed:', error)
  }
  try {
    installSpecificStyles()
    installGenericStyles()
  } catch (error) {
    console.warn('[cosmetic] filtering could not be installed:', error)
  }
  /*
    Guarded separately again: a page whose declarative rules failed should still get the procedural ones,
    and the other way round. They are three independent features that happen to share a document.
  */
  try {
    installProceduralFiltering()
  } catch (error) {
    console.warn('[cosmetic] procedural filtering could not be installed:', error)
  }
}
