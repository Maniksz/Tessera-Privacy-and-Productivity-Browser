import { describe, expect, it } from 'vitest'
import {
  navigationAbortReason,
  pickableDocument,
  vacancyAbortReason
} from '@main/privacy/picker-entry.js'
import { pickerBarText } from '@main/privacy/picker-bar-text.js'
import { pickerBarPresentation } from '@main/privacy/picker-presentation.js'
import {
  PICKER_OUTCOMES,
  pickerStep,
  type PickerCandidate,
  type PickerOutcome,
  type PickerSession
} from '@shared/filters/picker-session.js'
import { catalogs } from '@shared/i18n/catalog.js'
import { PICKER_BAR_HEIGHT, PICKER_BAR_WIDTH } from '@shared/overlay/picker-bar.js'
import { defaultSettings, type SettingsSnapshot } from '@shared/settings/definitions.js'

/**
 * The two halves of the picker's wiring that a test can reach.
 *
 * `ElementPicker.ts` is on `vitest.config.ts`'s coverage exclude list and the entry there says why:
 * it speaks to `app.on('web-contents-created')` and a live `WebContents`, so nothing it decides can
 * be asserted. It is admitted on the understanding that its decisions live elsewhere. The session
 * itself went to `shared/filters/picker-session.ts`; these are the ones that could not, because each
 * is about something only the core can see — a browsing session's settings, an Electron navigation
 * event, the overlay layer's announcement, and what the confirmation bar is told.
 *
 * Every one of them can be wrong while producing a perfectly ordinary-looking bar, which is the exact
 * failure mode this whole feature is being rebuilt around.
 */

const PLACE = {
  tabId: 'tab-1',
  tileIndex: 0,
  tileRect: { x: 0, y: 0, width: 1200, height: 800 }
}

function candidate(overrides: Partial<PickerCandidate> = {}): PickerCandidate {
  return {
    tag: 'div',
    proposal: {
      selector: '.ad-slot',
      estimatedMatches: 1,
      strategy: 'class',
      warnings: [],
      refused: []
    },
    matches: 3,
    ...overrides
  }
}

/** A session in `showing`, which is the only state a caller can reach without going through one. */
function showing(): PickerSession {
  const started = pickerStep(null, {
    ask: 'start',
    sessionId: 'picker-1',
    viewId: 7,
    windowId: 3,
    host: 'example.com',
    filterable: true
  })
  if (started.did !== 'started') throw new Error('the fixture could not start a session')
  return started.session
}

function frozen(chain: readonly PickerCandidate[] = [candidate(), candidate({ tag: 'section' })]) {
  const result = pickerStep(showing(), { ask: 'freeze', at: { of: 'view', viewId: 7 }, chain })
  if (result.did !== 'changed') throw new Error('the fixture could not freeze')
  return result.session
}

describe('what the confirmation bar is told', () => {
  it('shows the selector under the pointer while nothing is chosen yet', () => {
    /*
      The hovered selector is deliberately not session state — it changes many times a second and no
      transition depends on it — so it reaches the bar as presentation. A bar that showed nothing at
      all until the click would give a person no reason to believe the picker was running.
    */
    const bar = pickerBarPresentation({
      session: showing(),
      sessionId: 'picker-1',
      hovered: '.banner',
      outcome: null,
      canUndo: false,
      locale: 'en',
      place: PLACE
    })
    expect(bar?.mode).toBe('showing')
    expect(bar?.selector).toBe('.banner')
    // Nothing measured yet, and `null` is not `0`: zero is the finding "this rule changes nothing
    // here", which is a real answer and must not be announced before it has been reached.
    expect(bar?.matches).toBeNull()
    expect(bar?.canWiden).toBe(false)
    expect(bar?.canNarrow).toBe(false)
  })

  it('shows the chosen rung and its measured count once frozen', () => {
    const bar = pickerBarPresentation({
      session: frozen(),
      sessionId: 'picker-1',
      hovered: '.banner',
      outcome: null,
      canUndo: false,
      locale: 'en',
      place: PLACE
    })
    expect(bar?.mode).toBe('frozen')
    // The rung's own selector, not the last thing hovered: the pointer keeps moving after the click.
    expect(bar?.selector).toBe('.ad-slot')
    expect(bar?.matches).toBe(3)
    expect(bar?.canWiden).toBe(true)
    expect(bar?.canNarrow).toBe(false)
  })

  it('agrees with the session about which corrections exist', () => {
    /*
      Carried rather than left for the surface to guess, and asserted against the session's own
      answer rather than against a literal — a control that silently does nothing at the end of the
      chain is the defect this feature is being rebuilt to remove, reproduced in miniature.
    */
    const widened = pickerStep(frozen(), { ask: 'widen', at: { of: 'window', windowId: 3 } })
    if (widened.did !== 'changed') throw new Error('widening should have moved the selection')
    const bar = pickerBarPresentation({
      session: widened.session,
      sessionId: 'picker-1',
      hovered: '',
      outcome: null,
      canUndo: false,
      locale: 'en',
      place: PLACE
    })
    expect(bar?.canWiden).toBe(false)
    expect(bar?.canNarrow).toBe(true)
  })

  it('names the two waiting states rather than pretending the attempt is over', () => {
    const writing = pickerStep(frozen(), { ask: 'confirm', at: { of: 'window', windowId: 3 } })
    if (writing.did !== 'changed') throw new Error('confirm should have moved to writing')
    expect(
      pickerBarPresentation({
        session: writing.session,
        sessionId: 'picker-1',
        hovered: '',
        outcome: null,
        canUndo: false,
        locale: 'en',
        place: PLACE
      })?.mode
    ).toBe('writing')

    const measuring = pickerStep(writing.session, {
      ask: 'written',
      at: { of: 'program' },
      outcome: 'added'
    })
    if (measuring.did !== 'changed') throw new Error('a stored rule should lead to measuring')
    expect(
      pickerBarPresentation({
        session: measuring.session,
        sessionId: 'picker-1',
        hovered: '',
        outcome: null,
        canUndo: true,
        locale: 'en',
        place: PLACE
      })?.mode
    ).toBe('measuring')
  })

  it('renders every one of the eight named answers, and none of them silently', () => {
    // R1 from the presentation's side: eight outcomes, eight bars. A ninth added to the session
    // arrives here as an outcome this loop covers rather than as a bar nobody notices is empty.
    for (const outcome of PICKER_OUTCOMES) {
      const bar = pickerBarPresentation({
        session: null,
        sessionId: 'picker-1',
        hovered: '',
        outcome,
        canUndo: false,
        locale: 'en',
        place: PLACE
      })
      expect(bar?.mode, outcome).toBe('outcome')
      expect(bar?.outcome, outcome).toBe(outcome)
    }
  })

  it('shows a refusal although no session was ever created', () => {
    /*
      F5. `no-host` and `not-filterable` are decided at the start — which is precisely why they are
      decided there — so there is no session to describe them with. A bar that could only describe a
      running session would say nothing on exactly the documents where the refusal is the only thing
      worth saying.
    */
    const bar = pickerBarPresentation({
      session: null,
      sessionId: 'picker-9',
      hovered: '',
      outcome: 'not-filterable',
      canUndo: false,
      locale: 'en',
      place: PLACE
    })
    expect(bar).not.toBeNull()
    expect(bar?.sessionId).toBe('picker-9')
    expect(bar?.canUndo).toBe(false)
  })

  it('offers no bar at all for an attempt that was abandoned rather than answered', () => {
    // Cancelled, navigated away from, displaced: there is nothing to report, and the layer expresses
    // that by holding nothing rather than by a mode meaning "not on screen".
    const ended = pickerStep(frozen(), {
      ask: 'abort',
      at: { of: 'window', windowId: 3 },
      reason: 'cancelled'
    })
    if (ended.did !== 'ended') throw new Error('an abort should have ended the session')
    expect(
      pickerBarPresentation({
        session: ended.ended,
        sessionId: 'picker-1',
        hovered: '',
        outcome: null,
        canUndo: false,
        locale: 'en',
        place: PLACE
      })
    ).toBeNull()
  })

  it('offers no bar in a tile too small to draw one in', () => {
    // An invisible surface would be worse than none: it would hold the layer against everything else
    // while showing nobody anything.
    expect(
      pickerBarPresentation({
        session: showing(),
        sessionId: 'picker-1',
        hovered: '.x',
        outcome: null,
        canUndo: false,
        locale: 'en',
        place: { ...PLACE, tileRect: { x: 0, y: 0, width: 8, height: 8 } }
      })
    ).toBeNull()
  })

  it('puts the bar inside the tile that is being picked in, not over the window', () => {
    // The layer swallows every pointer event inside its own bounds. Sized to the window, a bar over
    // one tile of a split would make the other live pages unclickable.
    const bar = pickerBarPresentation({
      session: showing(),
      sessionId: 'picker-1',
      hovered: '.x',
      outcome: null,
      canUndo: false,
      locale: 'en',
      place: { ...PLACE, tileIndex: 2, tileRect: { x: 600, y: 40, width: 600, height: 760 } }
    })
    expect(bar?.tileIndex).toBe(2)
    expect(bar?.bounds.width).toBe(PICKER_BAR_WIDTH)
    expect(bar?.bounds.height).toBe(PICKER_BAR_HEIGHT)
    expect(bar?.bounds.x ?? 0).toBeGreaterThanOrEqual(600)
    expect((bar?.bounds.x ?? 0) + (bar?.bounds.width ?? 0)).toBeLessThanOrEqual(1200)
  })
})

describe('whether a document can carry a picked rule', () => {
  function settingsWith(overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot {
    return { ...defaultSettings(), ...overrides }
  }

  it('accepts an ordinary site and keys the rule on its registrable domain', () => {
    expect(pickableDocument('https://www.example.com/news', settingsWith())).toEqual({
      host: 'example.com',
      filterable: true
    })
  })

  it('refuses a document the injector cannot reach at all', () => {
    /*
      AE2. A `file:` document, an internal page and `about:blank` are all hostless *and* unreachable,
      and `filterable: false` is what makes the session answer "there can be no rule on this kind of
      document" rather than "this page has no host" — which for `tessera://settings` is nonsense.
    */
    for (const url of ['file:///home/me/notes.html', 'tessera://settings', 'about:blank', '']) {
      expect(pickableDocument(url, settingsWith()), url).toEqual({ host: null, filterable: false })
    }
  })

  it('refuses while either blocker switch is off', () => {
    // A rule written now would be delivered by nothing: `CosmeticInjector` returns before an addition
    // is composed on both of these. The picker would highlight, promise, save a line and then report
    // that nothing changed — every time.
    expect(
      pickableDocument('https://example.com/', settingsWith({ 'privacy.blockerEnabled': false }))
        .filterable
    ).toBe(false)
    expect(
      pickableDocument('https://example.com/', settingsWith({ 'privacy.cosmeticFiltering': false }))
        .filterable
    ).toBe(false)
  })

  it('refuses on a site the user has exempted, and still says which site it is', () => {
    /*
      The blocker menu argues the other way for *offering* the item, and that argument survives: the
      rule would apply again the moment filtering came back. It ends here, where the promise would
      have to be kept — nothing would be delivered while the exemption stands, so the honest answer is
      at the entry rather than three steps later dressed as a failure of the rule.
    */
    const document = pickableDocument(
      'https://example.com/',
      settingsWith({ 'privacy.blockerOffForSites': ['example.com'] })
    )
    expect(document).toEqual({ host: 'example.com', filterable: false })
  })

  it('keys a rule on a single-label host rather than refusing it', () => {
    /*
      `localhost` has no registrable domain to derive and is its own answer, which is the right one:
      somebody blocking an element on a development server is writing a rule about that server.

      It is also the closest this entry comes to producing `no-host`, and it does not produce it.
      `injectableDocumentUrl` admits only `http:` and `https:`, and a URL of either scheme always
      parses with a hostname — so every hostless document is refused as `not-filterable` first, which
      is the wording the session deliberately puts ahead of the other. `no-host` survives as the
      model's answer rather than as a case this path reaches, and that is worth knowing before
      somebody deletes it as unused.
    */
    expect(pickableDocument('https://localhost:3000/', settingsWith())).toEqual({
      host: 'localhost',
      filterable: true
    })
  })
})

describe('what ends a session, as the core hears it', () => {
  it('reads a same-document navigation as one of R11’s events', () => {
    // AE10, and the one that used to be missed: a single-page application changing route produced no
    // event the old picker cared about, so the selection stayed frozen over an element that had gone.
    expect(
      navigationAbortReason(
        { isMainFrame: true, isSameDocument: true, url: 'https://example.com/b' },
        'https://example.com/a'
      )
    ).toBe('navigated')
  })

  it('tells a reload from a move to another page', () => {
    expect(
      navigationAbortReason(
        { isMainFrame: true, isSameDocument: false, url: 'https://example.com/a' },
        'https://example.com/a'
      )
    ).toBe('reloaded')
    expect(
      navigationAbortReason(
        { isMainFrame: true, isSameDocument: false, url: 'https://elsewhere.test/' },
        'https://example.com/a'
      )
    ).toBe('document-changed')
  })

  it('ignores a subframe navigation', () => {
    // An advert refreshing itself inside its own iframe would otherwise end a session somebody is in
    // the middle of, and adverts do that on a timer.
    expect(
      navigationAbortReason(
        { isMainFrame: false, isSameDocument: false, url: 'https://ads.test/' },
        'https://example.com/a'
      )
    ).toBeNull()
  })

  it('ignores a payload that is not a navigation at all', () => {
    for (const payload of [null, undefined, 'navigated', {}, { isMainFrame: 'yes' }]) {
      expect(
        navigationAbortReason(payload, 'https://example.com/'),
        JSON.stringify(payload)
      ).toBeNull()
    }
  })

  it('turns each of the layer’s three announcements into a reason the session knows', () => {
    expect(vacancyAbortReason('dismissed')).toBe('cancelled')
    // AE11: a consent dialogue taking the layer ends the picking session and lifts its preview.
    expect(vacancyAbortReason('replaced')).toBe('displaced')
    expect(vacancyAbortReason('gone')).toBe('window-closed')
  })
})

describe('the words the bar is said in', () => {
  /*
    The words come from the core and travel on the presentation, for the reason
    `main/privacy/picker-bar-text.ts` gives at length: the renderer's catalogue is one measured chunk
    holding both locales, and a surface only one feature ever raises should not be paying into it.

    What that move makes it possible to get wrong is asserted here rather than in the component test,
    because it is all on this side: which language the words are in, whether every outcome has one,
    and whether a translation still carries the placeholders the bar fills in.
  */
  const LOCALES = ['en', 'de'] as const

  function barIn(locale: 'en' | 'de', outcome: PickerOutcome | null = null) {
    return pickerBarPresentation({
      session: outcome === null ? frozen() : null,
      sessionId: 'picker-1',
      hovered: '',
      outcome,
      canUndo: false,
      locale,
      place: PLACE
    })
  }

  it('carries the words for the language the interface is in', () => {
    // The same bar, twice, differing only in the setting. If the locale were dropped anywhere between
    // the setting and the surface, both would come out English — and English is what a test would read.
    const english = barIn('en')
    const german = barIn('de')
    expect(english?.text).toEqual(pickerBarText('en'))
    expect(german?.text).toEqual(pickerBarText('de'))
    expect(german?.text.confirm).not.toBe(english?.text.confirm)
  })

  it('carries the words on a refusal that never had a session', () => {
    // `no-host` and `not-filterable` are the answers with no session behind them, and they are the ones
    // where the sentence is the only thing on the bar worth reading.
    const bar = barIn('de', 'no-host')
    expect(bar?.text['outcome.no-host']).toBe(pickerBarText('de')['outcome.no-host'])
  })

  it('words every outcome in both languages, keyed by the outcome itself', () => {
    /*
      R1 and R3 from the wording's side. The bar receives an outcome as a key and resolves
      `outcome.${outcome}` in these words, so the key here is the outcome's own name with no table in
      between. The compiler already holds the table to `PICKER_OUTCOMES`; what it cannot hold is a
      translation to being a translation, and a blank German string would render as a bar with buttons
      and no sentence — in the one place this feature exists to put a sentence.
    */
    for (const locale of LOCALES) {
      const text: Record<string, string> = pickerBarText(locale)
      for (const outcome of PICKER_OUTCOMES) {
        expect(text[`outcome.${outcome}`]?.trim(), `${locale} ${outcome}`).toBeTruthy()
      }
      for (const [key, words] of Object.entries(text)) {
        expect(words.trim(), `${locale} ${key}`).not.toBe('')
      }
    }
  })

  it('keeps every placeholder the bar fills in, in both languages', () => {
    // `{index}` names the tile and `{count}` the matches. A German sentence that lost one would render
    // the tile's label without its number — readable, plausible, and wrong.
    const placeholders = (words: string): string[] => (words.match(/\{\w+\}/g) ?? []).sort()
    const en: Record<string, string> = pickerBarText('en')
    const de: Record<string, string> = pickerBarText('de')
    expect(Object.keys(de).sort()).toEqual(Object.keys(en).sort())
    for (const key of Object.keys(en)) {
      expect(placeholders(de[key] ?? ''), key).toEqual(placeholders(en[key] ?? ''))
    }
    expect(en.label).toContain('{index}')
    expect(en.matches).toContain('{count}')
  })

  it('names a next step wherever the user has one to take', () => {
    // A refusal a person can do nothing about is half an answer. Which of the eight has a next step
    // is the difference between a list that is full and a list they chose to leave as it is.
    expect(pickerBarText('en')['outcome.limit-reached']).toMatch(/delete/i)
    expect(pickerBarText('en')['outcome.duplicate-disabled']).toMatch(/rules/i)
  })

  it('has left the renderer catalogue', () => {
    // The point of the move. A key left behind would be paid for twice: once in the chunk every
    // renderer parses, and once on the wire where the bar actually reads it.
    for (const locale of LOCALES) {
      const stray = Object.keys(catalogs[locale]).filter((key) => key.startsWith('picker.'))
      expect(stray, locale).toEqual([])
    }
  })
})
