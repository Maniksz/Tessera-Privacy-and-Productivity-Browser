import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { UserRuleStore } from '@main/data/UserRuleStore.js'
import { CosmeticInjector } from '@main/privacy/CosmeticInjector.js'
import { FilterEngine } from '@main/privacy/FilterEngine.js'
import type { DocumentFeatures } from '@shared/filters/features.js'
import { COSMETIC_SPECIFIC_CHANNEL } from '@shared/filters/injection.js'
import { cosmeticRuleFor } from '@shared/filters/picker.js'
import { viewStylesheet } from '@shared/filters/preview-styles.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The one Electron symbol `CosmeticInjector` imports as a value, replaced so the class can be
 * constructed here at all.
 *
 * The file is on `vitest.config.ts`'s coverage exclude list and stays there: nothing below moves it
 * off, because what is asserted is the *wiring* — which view is told what, and which view is not —
 * and every judgement about the text itself is asserted against `viewStylesheet` above. But wiring
 * that can send a preview into the wrong tab is worth a fake application object, and `app.on` is the
 * whole of what has to be faked to get one.
 */
const electronApp = vi.hoisted(() => {
  const created: Array<(event: unknown, contents: unknown) => void> = []
  return {
    on(_event: string, handler: (event: unknown, contents: unknown) => void): void {
      created.push(handler)
    },
    /** Dropped between tests, so a previous test's injector cannot answer this test's view. */
    reset(): void {
      created.length = 0
    },
    open(contents: unknown): void {
      for (const handler of [...created]) handler({}, contents)
    }
  }
})

vi.mock('electron', () => ({ app: electronApp }))

/**
 * The engine's cosmetic half as the injector sees it: a per-document feed of generic
 * selectors, and the user's own rules alongside the downloaded ones.
 *
 * What is worth asserting here is the seam rather than the matching — the matching is
 * `filter-features.test.ts` and `filter-cosmetic.test.ts`. Three things can only go
 * wrong at this level: the setting has to be honoured live, the user's own rules have to
 * reach a page without a full recompile, and a user exception has to be able to cancel a
 * selector a *list* contributed, because that is the escape hatch for the day a filter
 * list breaks a site.
 */

const LIST = [
  '[Adblock Plus 2.0]',
  '##.ad-banner',
  '###AC_ad',
  '##.promo-rail',
  '##[data-ad-slot]',
  'example.com##.host-specific'
].join('\n')

function features(overrides: Partial<DocumentFeatures>): DocumentFeatures {
  return { classes: [], ids: [], tags: [], ...overrides }
}

function engineFor(
  options: { userRules?: string; settings?: Partial<SettingsSnapshot> } = {}
): FilterEngine {
  const settings = { ...defaultSettings(), ...options.settings }
  return new FilterEngine({
    lists: [LIST],
    getSettings: () => settings,
    ...(options.userRules === undefined ? {} : { userRules: options.userRules })
  })
}

describe('openCosmeticFeed', () => {
  it('sends only the selectors the document called for', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    const css = feed.take(features({ classes: ['ad-banner', 'headline'] }))
    expect(css).toContain('.ad-banner')
    expect(css).not.toContain('.promo-rail')
    // The residue rides along with the first answer; it cannot be narrowed by anything
    // a survey reports.
    expect(css).toContain('[data-ad-slot]')
    expect(css).toContain('display: none !important')
  })

  it('says nothing when a later survey brings nothing new', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    feed.take(features({ classes: ['ad-banner'] }))
    expect(feed.take(features({ classes: ['ad-banner'] }))).toBeNull()
  })

  it('answers again for a feature that appeared as the page grew', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    feed.take(features({ classes: ['ad-banner'] }))
    expect(feed.take(features({ ids: ['AC_ad'] }))).toBe('#AC_ad { display: none !important; }')
  })

  it('withholds the host-specific selectors, which are injected wholesale', () => {
    const engine = engineFor()
    const feed = engine.openCosmeticFeed('https://example.com/')
    expect(feed.take(features({ classes: ['host-specific'] }))).not.toContain('.host-specific')
    expect(engine.cosmeticStylesFor('https://example.com/')).toContain('.host-specific')
  })

  it('counts the bytes that actually reached the page', () => {
    const feed = engineFor().openCosmeticFeed('https://news.example.org/article')
    const css = feed.take(features({ classes: ['ad-banner'] }))!
    expect(feed.servedByteCount).toBe(css.length)
    expect(feed.servedSelectorCount).toBe(2)
  })

  it('stops injecting into an open document when the setting is switched off', () => {
    // Checked on every `take` rather than only when the feed opens, so a user turning
    // cosmetic filtering off is not told to reload every tab first.
    const live = { ...defaultSettings() }
    const engine = new FilterEngine({ lists: [LIST], getSettings: () => live })
    const feed = engine.openCosmeticFeed('https://news.example.org/article')
    expect(feed.take(features({ classes: ['ad-banner'] }))).not.toBeNull()
    live['privacy.cosmeticFiltering'] = false
    expect(feed.take(features({ ids: ['AC_ad'] }))).toBeNull()
  })

  it('has nothing to inject into a document with no host', () => {
    const feed = engineFor().openCosmeticFeed('about:blank')
    expect(feed.take(features({ classes: ['ad-banner'] }))).toBeNull()
    expect(feed.servedSelectorCount).toBe(0)
    expect(feed.servedByteCount).toBe(0)
  })

  it('reports what the generic set costs, and how much of it no survey can narrow', () => {
    const engine = engineFor()
    expect(engine.genericSelectorBytes).toBe(
      ['.ad-banner', '#AC_ad', '.promo-rail', '[data-ad-slot]'].reduce(
        (sum, selector) => sum + selector.length + 2,
        0
      )
    )
    expect(engine.unkeyedSelectorBytes).toBe('[data-ad-slot]'.length + 2)
  })
})

describe('the user’s own rules', () => {
  it('hides what a picker rule names, on the host it names', () => {
    const engine = engineFor({ userRules: cosmeticRuleFor('example.com', '.sponsored-row') })
    expect(engine.cosmeticStylesFor('https://example.com/')).toContain('.sponsored-row')
    expect(engine.cosmeticStylesFor('https://other.test/')).toBeNull()
    expect(engine.userRuleCount).toBe(1)
  })

  it('applies a change without recompiling the downloaded lists', () => {
    const engine = engineFor()
    const before = engine.networkRuleCount
    engine.replaceUserRules('example.com##.sponsored-row')
    expect(engine.cosmeticStylesFor('https://example.com/')).toContain('.sponsored-row')
    expect(engine.networkRuleCount).toBe(before)
    expect(engine.cosmeticRuleCount).toBe(5)
  })

  it('lets a user exception cancel a selector a list contributed', () => {
    // The escape hatch. A list hides something the site needs; without this the user's
    // only recourse is switching the whole blocker off.
    const engine = engineFor({ userRules: 'example.com#@#.host-specific' })
    expect(engine.cosmeticStylesFor('https://example.com/')).toBeNull()
    // And only on the host the exception names.
    expect(engine.cosmeticSelectorsFor('https://elsewhere.test/').generic).toContain('.ad-banner')
  })

  it('lets a user exception cancel a generic selector the feed would have sent', () => {
    const engine = engineFor({ userRules: 'news.example.org#@#.ad-banner' })
    const feed = engine.openCosmeticFeed('https://news.example.org/article')
    expect(feed.take(features({ classes: ['ad-banner'] }))).not.toContain('.ad-banner')
    const elsewhere = engine.openCosmeticFeed('https://other.test/')
    expect(elsewhere.take(features({ classes: ['ad-banner'] }))).toContain('.ad-banner')
  })

  it('sends a generic rule the user wrote by hand through the feed as well', () => {
    const engine = engineFor({ userRules: '##.user-generic' })
    const feed = engine.openCosmeticFeed('https://news.example.org/article')
    expect(feed.take(features({ classes: ['user-generic'] }))).toContain('.user-generic')
  })

  it('leaves the lists alone when the user has no rules at all', () => {
    const engine = engineFor()
    expect(engine.userRuleCount).toBe(0)
    expect(engine.cosmeticSelectorsFor('https://example.com/').specific).toEqual(['.host-specific'])
  })

  it('is silent when cosmetic filtering is switched off', () => {
    const engine = engineFor({
      userRules: 'example.com##.sponsored-row',
      settings: { 'privacy.cosmeticFiltering': false }
    })
    expect(engine.cosmeticStylesFor('https://example.com/')).toBeNull()
    expect(engine.cosmeticSelectorsFor('https://example.com/')).toEqual({
      specific: [],
      generic: []
    })
  })
})

/**
 * The stylesheet one *view* is served: the engine's host-specific answer, plus whatever that
 * single view — and no other — is currently being shown on top of it.
 *
 * ## Why there is an addition at all
 *
 * `FilterEngine.replaceUserRules` is one slot for the whole program, fed from the rule store on
 * disk. Two things need a rule to reach exactly one place and cannot use it: the element picker's
 * **preview**, which must show in the tab being picked in and nowhere else, and the **session
 * rules** of a private window, which must not leak into the normal windows sharing the same engine.
 * Put either into the global slot and it applies everywhere; leave either out and it applies
 * nowhere. So the host-specific delivery gained a per-view addition, and this is the arithmetic
 * behind it (KTD3, R4, R20).
 *
 * ## Why the arithmetic is here rather than in `CosmeticInjector.ts`
 *
 * That file is on the coverage exclude list, because it speaks to `app.on('web-contents-created')`
 * and a live `WebContents`. Every decision it holds is a decision no test can reach. What is left
 * over there is the map from view to addition text and the send; everything that can be *wrong* —
 * which lines are honoured, in what order they are appended, what a revocation restores — is
 * asserted against the pure module below.
 */
const HOST_STYLES = '.host-specific { display: none !important; }'
const DOCUMENT = 'https://example.com/article'

describe('the stylesheet a single view is served', () => {
  it('is the engine’s own answer, unchanged, when nothing is added to it', () => {
    /*
      The identity case, and it is the one everything else is measured against: a view with no
      preview and no session rules is served exactly what every other view on this host is served.
      Asserted against the engine's real output rather than a literal, so this cannot drift from
      what the injector actually has in hand.
    */
    const engine = engineFor()
    const hostStyles = engine.cosmeticStylesFor('https://example.com/')
    const result = viewStylesheet({ documentUrl: DOCUMENT, hostStyles })
    expect(result.css).toBe(hostStyles)
    expect(result.preview).toBeNull()
    expect(result.session).toBeNull()
  })

  it('appends the preview as a rule of its own rather than mixing it in', () => {
    /*
      Appended, not merged into the host rule's selector list. Merging would mean re-reading a
      string this module did not write — a second selector parser — and it would put a provisional
      selector inside the same all-or-nothing CSS rule as the site's working ones, where a selector
      the browser cannot read takes every one of them down with it.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: cosmeticRuleFor('example.com', '.sponsored-row')
    })
    expect(result.css).toBe(`${HOST_STYLES}\n.sponsored-row { display: none !important; }`)
    expect(result.preview?.refused).toEqual([])
  })

  it('serves both additions, session first and preview last', () => {
    // Stable order, and this is the order: the session's rules are the standing ones, the preview
    // is the thing being tried on top of them.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'example.com##.preview-target',
      session: 'example.com##.session-rule'
    })
    expect(result.css).toBe(
      [
        HOST_STYLES,
        '.session-rule { display: none !important; }',
        '.preview-target { display: none !important; }'
      ].join('\n')
    )
  })

  it('restores exactly the engine’s answer when the addition is taken away', () => {
    // Revoking is the same call with no addition text — there is deliberately no second route
    // back, because a second route is a second thing that can be forgotten.
    const withPreview = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'example.com##.sponsored-row'
    })
    const revoked = viewStylesheet({ documentUrl: DOCUMENT, hostStyles: HOST_STYLES })
    expect(withPreview.css).not.toBe(HOST_STYLES)
    expect(revoked.css).toBe(HOST_STYLES)
  })

  it('is the addition alone when the host has no rules of its own', () => {
    // The common case for a picker: nothing on this site is filtered yet, which is why somebody is
    // pointing at a banner. `null` must not become the string "null", and must not leave a blank
    // line the next addition is appended after.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: null,
      preview: 'example.com##.sponsored-row'
    })
    expect(result.css).toBe('.sponsored-row { display: none !important; }')
  })

  it('treats an empty host stylesheet as no host stylesheet', () => {
    // `CosmeticInjector.refresh` sends `''` to mean "stop hiding", so an empty string reaches this
    // path as readily as a null does and has to compose the same way.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: '',
      preview: 'example.com##.sponsored-row'
    })
    expect(result.css).toBe('.sponsored-row { display: none !important; }')
  })

  it('computes the same text twice from the same host stylesheet', () => {
    /*
      Idempotence, stated as what it actually has to be: the function is pure and always takes the
      *engine's* stylesheet, never its own last answer. A caller that fed the previous result back
      in would grow the addition on every refresh, so the property worth pinning is that two
      identical calls produce two identical strings and the input is never the output.
    */
    const call = (): string | null =>
      viewStylesheet({
        documentUrl: DOCUMENT,
        hostStyles: HOST_STYLES,
        preview: 'example.com##.sponsored-row'
      }).css
    expect(call()).toBe(call())
  })
})

describe('what a view’s addition is not allowed to be', () => {
  it('refuses a line the rule store would refuse, and says so', () => {
    /*
      The preview runs the real injection path, so it must not also be a way around the rules that
      govern a *written* rule. Network syntax belongs to a blocking list rather than to an element
      picker, and `##+js(…)` is code to run in the page — neither becomes a selector because it was
      called provisional.
    */
    for (const line of [
      '||ads.example.com^',
      'example.com##+js(set-constant, x, true)',
      'nonsense'
    ]) {
      const result = viewStylesheet({
        documentUrl: DOCUMENT,
        hostStyles: HOST_STYLES,
        preview: line
      })
      expect(result.css, line).toBe(HOST_STYLES)
      expect(result.preview, line).toEqual({
        css: null,
        refused: [{ text: line, reason: 'unreadable' }]
      })
    }
  })

  it('refuses an exception, which appending cannot honour', () => {
    /*
      `#@#` cancels a selector somebody else contributed. The host stylesheet is finished text by the
      time it arrives here, so there is nothing to cancel — and taking the selector at face value
      would *hide* the very element the line asks to bring back. Refused rather than approximated.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      session: 'example.com#@#.host-specific'
    })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.session?.refused).toEqual([
      { text: 'example.com#@#.host-specific', reason: 'exception' }
    ])
  })

  it('refuses a procedural rule, whose CSS prefix is not the rule', () => {
    // `.box:has-text(Anzeige)` reaches the page as a chain the procedural engine evaluates. The CSS
    // it starts from — `.box` — is a strictly broader selector, so writing that into a stylesheet
    // would hide every box on the page rather than the one with the word in it.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'example.com##.box:has-text(Anzeige)'
    })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.preview?.refused).toEqual([
      { text: 'example.com##.box:has-text(Anzeige)', reason: 'procedural' }
    ])
  })

  it('refuses a rule that is perfectly good somewhere else', () => {
    /*
      R20 from the other side. A preview cannot follow the page: the view navigates, the injector
      re-serves, and the rule the picker was holding is suddenly scoped to a host that is no longer
      open. It contributes nothing here, and it is reported rather than dropped in silence.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      preview: 'other.test##.sponsored-row'
    })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.preview?.refused).toEqual([
      { text: 'other.test##.sponsored-row', reason: 'other-host' }
    ])
  })

  it('has no host to match a scoped rule against on a document that has none', () => {
    const result = viewStylesheet({
      documentUrl: 'about:blank',
      hostStyles: null,
      preview: 'example.com##.sponsored-row'
    })
    expect(result.css).toBeNull()
    expect(result.preview?.refused).toEqual([
      { text: 'example.com##.sponsored-row', reason: 'other-host' }
    ])
  })

  it('lets one unreadable line cost itself and not the rest of the addition', () => {
    /*
      The session editor's text is a list, and a list is where this matters: the rule somebody typed
      wrong sits between two that are right, and losing all three would look exactly like the
      browser ignoring them.
    */
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      session: ['example.com##.first', '||ads.example.com^', 'example.com##.second'].join('\n')
    })
    expect(result.css).toBe(`${HOST_STYLES}\n.first,\n.second { display: none !important; }`)
    expect(result.session?.refused).toEqual([{ text: '||ads.example.com^', reason: 'unreadable' }])
  })

  it('takes a rule the user scoped to nothing at all', () => {
    // A generic line is one the writer chose to write generically — this module is not the place to
    // second-guess it, and the session editor is a text box in which `##.x` is a legal thing to say.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: null,
      session: '##.everywhere'
    })
    expect(result.css).toBe('.everywhere { display: none !important; }')
  })

  it('reports nothing for the blank lines a rule list is joined with', () => {
    // `enabledUserRuleText` joins with newlines and produces `''` for an empty list, so both a blank
    // line and an empty text arrive here in ordinary use. Neither is a refusal.
    const result = viewStylesheet({
      documentUrl: DOCUMENT,
      hostStyles: HOST_STYLES,
      session: '\n  \nexample.com##.kept\n'
    })
    expect(result.css).toBe(`${HOST_STYLES}\n.kept { display: none !important; }`)
    expect(result.session).toEqual({
      css: '.kept { display: none !important; }',
      refused: []
    })
  })

  it('adds nothing for an empty addition text, and does not call it a refusal', () => {
    const result = viewStylesheet({ documentUrl: DOCUMENT, hostStyles: HOST_STYLES, session: '' })
    expect(result.css).toBe(HOST_STYLES)
    expect(result.session).toEqual({ css: null, refused: [] })
  })
})

/**
 * A view, reduced to what the injector actually speaks to.
 *
 * Four members and a listener table. The injector holds the object itself rather than an id
 * (`webContents.fromId` can answer a *different* view once an id has been reused), so a fake that is
 * merely the id would not exercise the path that matters.
 */
class FakeView {
  readonly id: number
  url: string
  readonly sent: Array<{ readonly channel: string; readonly payload: unknown }> = []
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  #destroyed = false

  constructor(id: number, url: string) {
    this.id = id
    this.url = url
  }

  on(event: string, handler: (...args: unknown[]) => void): this {
    const existing = this.#listeners.get(event) ?? []
    existing.push(handler)
    this.#listeners.set(event, existing)
    return this
  }

  once(event: string, handler: (...args: unknown[]) => void): this {
    return this.on(event, handler)
  }

  getURL(): string {
    return this.url
  }

  isDestroyed(): boolean {
    return this.#destroyed
  }

  send(channel: string, payload: unknown): void {
    this.sent.push({ channel, payload })
  }

  /** The `document-start` question, answered synchronously — the path a page really takes. */
  ask(url = this.url): unknown {
    const event: { returnValue: unknown } = { returnValue: undefined }
    this.#emit('ipc-message-sync', event, COSMETIC_SPECIFIC_CHANNEL, url)
    return event.returnValue
  }

  destroy(): void {
    this.#destroyed = true
    this.#emit('destroyed')
  }

  /** The last host-specific stylesheet pushed at this view, or `undefined` for none. */
  lastStyles(): unknown {
    const pushes = this.sent.filter((entry) => entry.channel === COSMETIC_SPECIFIC_CHANNEL)
    return pushes.at(-1)?.payload
  }

  #emit(event: string, ...args: unknown[]): void {
    for (const handler of this.#listeners.get(event) ?? []) handler(...args)
  }
}

function injectorFor(
  options: {
    settings?: Partial<SettingsSnapshot>
    sessionStyles?: (id: number) => string | null
  } = {}
): CosmeticInjector {
  const engine = engineFor()
  const settings = { ...defaultSettings(), ...options.settings }
  const sessionStyles = options.sessionStyles
  const injector = new CosmeticInjector({
    getSettings: () => settings,
    stylesFor: (documentUrl) => engine.cosmeticStylesFor(documentUrl),
    openFeed: (documentUrl) => engine.openCosmeticFeed(documentUrl),
    scriptletsFor: () => [],
    proceduralFor: () => [],
    ...(sessionStyles === undefined
      ? {}
      : { sessionStylesFor: (contents: WebContents) => sessionStyles(contents.id) })
  })
  injector.install()
  return injector
}

function viewOn(url = DOCUMENT, id = 1): FakeView {
  const view = new FakeView(id, url)
  electronApp.open(view)
  return view
}

/**
 * The other half of the view-bound delivery: which view is told, and which view is not.
 *
 * Everything the addition *is* — which lines survive, in what order, what a revocation restores —
 * is asserted against `viewStylesheet` above, and nothing here repeats it. What is left in
 * `CosmeticInjector` is a map from view to addition and a send, and both can be wrong in a way no
 * pure test can see: a preview that reaches the tab beside the one being picked in is R20 broken,
 * and a re-serve of every view that drops the additions is the picker's preview vanishing because
 * somebody edited a rule in another window.
 */
describe('the injector’s view-bound delivery', () => {
  beforeEach(() => {
    electronApp.reset()
  })

  it('serves a view’s preview to that view', () => {
    const injector = injectorFor()
    const view = viewOn()
    view.ask()
    injector.setPreview(view.id, cosmeticRuleFor('example.com', '.sponsored-row'))
    expect(view.lastStyles()).toBe(`${HOST_STYLES}\n.sponsored-row { display: none !important; }`)
  })

  it('leaves a second view on the same host untouched', () => {
    // AE9, and the reason the delivery became view-bound at all: the global engine slot would have
    // hidden this element in every window that happened to be on the same site.
    const injector = injectorFor()
    const picking = viewOn(DOCUMENT, 1)
    const bystander = viewOn(DOCUMENT, 2)
    picking.ask()
    bystander.ask()
    injector.setPreview(picking.id, 'example.com##.sponsored-row')
    expect(bystander.lastStyles()).toBeUndefined()
    expect(bystander.ask()).toBe(HOST_STYLES)
  })

  it('keeps every view’s addition when all of them are re-served', () => {
    // `refresh` runs whenever the user's own rules change, which is a thing that happens *while* a
    // preview is up — the picker's own commit does it. Losing the addition here would look like the
    // preview flickering out for no reason anybody could connect to what they just did.
    const injector = injectorFor()
    const view = viewOn()
    view.ask()
    injector.setPreview(view.id, 'example.com##.sponsored-row')
    injector.refresh()
    expect(view.lastStyles()).toBe(`${HOST_STYLES}\n.sponsored-row { display: none !important; }`)
  })

  it('takes a preview back and leaves exactly what the engine said', () => {
    // R5: revoked before the commit is measured, and revoking is the same call with no text.
    const injector = injectorFor()
    const view = viewOn()
    view.ask()
    injector.setPreview(view.id, 'example.com##.sponsored-row')
    injector.setPreview(view.id, null)
    expect(view.lastStyles()).toBe(HOST_STYLES)
  })

  it('says nothing to a view that has never asked for styles', () => {
    // A view enters the map only by asking, and a picker can be pointed at a window whose page never
    // did — an internal page, or any page at all while the blocker was off. Nothing to send to, and
    // nothing to throw about.
    const injector = injectorFor()
    const silent = viewOn()
    expect(() => {
      injector.setPreview(silent.id, 'example.com##.sponsored-row')
      injector.refreshView(999)
    }).not.toThrow()
    expect(silent.sent).toEqual([])
  })

  it('serves a window’s session rules to a view that opened after they were written', () => {
    /*
      Pulled per serve rather than pushed per view, and this is the case that decides it: a private
      window's second tab is created, loads, and asks — all after the rule was written. Anything that
      had to be told about the new view would have to be told by somebody, and R20 would hold only for
      as long as nobody forgot.
    */
    injectorFor({ sessionStyles: (id) => (id === 1 ? 'example.com##.private' : null) })
    const inPrivateWindow = viewOn(DOCUMENT, 1)
    const inNormalWindow = viewOn(DOCUMENT, 2)
    expect(inPrivateWindow.ask()).toBe(`${HOST_STYLES}\n.private { display: none !important; }`)
    expect(inNormalWindow.ask()).toBe(HOST_STYLES)
  })

  it('lets no addition past a blocker the user switched off', () => {
    // The gates come first and the addition is composed after them, so this is structural rather
    // than a second check — but it is the one that would be a security-shaped bug if it inverted.
    const injector = injectorFor({
      settings: { 'privacy.blockerEnabled': false },
      sessionStyles: () => 'example.com##.private'
    })
    const view = viewOn()
    injector.setPreview(view.id, 'example.com##.sponsored-row')
    expect(view.ask()).toBeNull()
  })

  it('lets no addition past a site the user exempted', () => {
    const injector = injectorFor({ settings: { 'privacy.blockerOffForSites': ['example.com'] } })
    const view = viewOn()
    injector.setPreview(view.id, 'example.com##.sponsored-row')
    expect(view.ask()).toBeNull()
  })

  it('re-serves only the views it is asked about when the session’s rules change', () => {
    /*
      The half of the wiring `src/main/index.ts` performs on the held editor's `onChange`: the views of
      the windows of *that mode*, one at a time, and no `refresh()` — a full re-serve would be harmless
      here but would be the moment a private window's rule reached a normal window's view if
      `sessionStylesFor` ever answered by mode rather than by window.
    */
    let sessionText: string | null = null
    const injector = injectorFor({ sessionStyles: (id) => (id === 1 ? sessionText : null) })
    const inPrivateWindow = viewOn(DOCUMENT, 1)
    const inNormalWindow = viewOn(DOCUMENT, 2)
    inPrivateWindow.ask()
    inNormalWindow.ask()

    sessionText = 'example.com##.private'
    injector.refreshView(inPrivateWindow.id)
    expect(inPrivateWindow.lastStyles()).toBe(
      `${HOST_STYLES}\n.private { display: none !important; }`
    )
    expect(inNormalWindow.lastStyles()).toBeUndefined()
  })

  it('drops a view’s preview when the view goes', () => {
    // The map is keyed by a number and cleaned up on `destroyed` rather than left to be collected;
    // an addition held by id has to be dropped at the same moment, or a long session accumulates
    // rule text for every tab that ever previewed anything.
    const injector = injectorFor()
    const view = viewOn()
    view.ask()
    injector.setPreview(view.id, 'example.com##.sponsored-row')
    view.destroy()
    const reused = viewOn(DOCUMENT, view.id)
    expect(reused.ask()).toBe(HOST_STYLES)
  })
})

/**
 * AE8, with the real rule store in the loop rather than a lambda standing in for it.
 *
 * Everything above holds the injector against a `sessionStyles` function somebody wrote for the test;
 * what is left unproven by that is the join — that the object `UserRuleStore.editorFor('private')`
 * hands back is the same one on the next call, that what it holds is what a view is served, and that
 * the same write reaches neither the file nor the text `FilterSubscription.reloadUserRules` feeds into
 * the engine's one global slot. Those three are the defect this unit exists for, and they are only
 * visible together.
 *
 * The wiring below is copied from `src/main/index.ts` on purpose, down to the shape of the callback:
 * that file cannot be tested — it builds Electron — so the closest a test gets is holding the same
 * arrangement of the same objects.
 */
describe('a private window’s own rules, through the store the core uses', () => {
  beforeEach(() => {
    electronApp.reset()
  })

  async function storeInTemp(): Promise<{ path: string; store: UserRuleStore }> {
    const directory = await mkdtemp(join(tmpdir(), 'tessera-session-rules-'))
    const path = join(directory, 'user-rules.json')
    return { path, store: await UserRuleStore.open({ filePath: path, debounceMs: 0 }) }
  }

  /** `index.ts`'s injector, with its `sessionStylesFor` and a set standing in for "is this window private". */
  function injectorOver(
    engine: FilterEngine,
    store: UserRuleStore,
    privateViews: ReadonlySet<number>
  ): CosmeticInjector {
    const settings = defaultSettings()
    const injector = new CosmeticInjector({
      getSettings: () => settings,
      stylesFor: (documentUrl) => engine.cosmeticStylesFor(documentUrl),
      openFeed: (documentUrl) => engine.openCosmeticFeed(documentUrl),
      scriptletsFor: () => [],
      proceduralFor: () => [],
      sessionStylesFor: (contents) =>
        privateViews.has(contents.id) ? store.editorFor('private').enabledText() : null
    })
    injector.install()
    return injector
  }

  it('hides the element where it was blocked, in no other window, and on no disk', async () => {
    const { path, store } = await storeInTemp()
    const engine = engineFor()
    const injector = injectorOver(engine, store, new Set([1]))
    const inPrivateWindow = viewOn(DOCUMENT, 1)
    const inNormalWindow = viewOn(DOCUMENT, 2)
    inPrivateWindow.ask()
    inNormalWindow.ask()

    expect(
      store.editorFor('private').add({ text: 'example.com##.sponsored-row', origin: 'picker' })
        .outcome
    ).toBe('added')
    // What `index.ts` does on the held editor's `onChange`, for this window's views only.
    injector.refreshView(inPrivateWindow.id)

    expect(inPrivateWindow.lastStyles()).toBe(
      `${HOST_STYLES}\n.sponsored-row { display: none !important; }`
    )
    // The normal window is not merely un-pushed: it asks again — a reload — and still gets the list's
    // answer and nothing else.
    expect(inNormalWindow.lastStyles()).toBeUndefined()
    expect(inNormalWindow.ask()).toBe(HOST_STYLES)

    // And the two places a session rule must never turn up: the global slot's source text, and the file.
    expect(store.enabledText()).toBe('')
    engine.replaceUserRules(store.enabledText())
    expect(engine.cosmeticStylesFor('https://example.com/')).toBe(HOST_STYLES)
    expect(engine.userRuleCount).toBe(0)
    await store.flush()
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, rules: [] })
  })

  it('serves them to a tab opened later, and takes them back when the session ends', async () => {
    const { store } = await storeInTemp()
    const injector = injectorOver(engineFor(), store, new Set([1, 3]))
    const firstTab = viewOn(DOCUMENT, 1)
    firstTab.ask()
    store.editorFor('private').add({ text: 'example.com##.sponsored-row', origin: 'picker' })

    // The tab that did not exist when the rule was written, asking for the first time.
    const laterTab = viewOn(DOCUMENT, 3)
    expect(laterTab.ask()).toBe(`${HOST_STYLES}\n.sponsored-row { display: none !important; }`)

    // R5: the last private window closes, and what it held goes with it.
    store.endPrivateSession()
    injector.refreshView(firstTab.id)
    injector.refreshView(laterTab.id)
    expect(firstTab.lastStyles()).toBe(HOST_STYLES)
    expect(laterTab.lastStyles()).toBe(HOST_STYLES)
    expect(laterTab.ask()).toBe(HOST_STYLES)
  })
})
