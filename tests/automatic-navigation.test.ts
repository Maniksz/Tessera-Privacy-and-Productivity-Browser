import { describe, expect, it, vi } from 'vitest'
import {
  GESTURE_WINDOW_MS,
  decideAutomaticNavigation,
  withinGestureWindow,
  type AutomaticNavigationRequest
} from '@main/browser/automatic-navigation.js'
import { AutomaticNavigationPrompt } from '@main/browser/AutomaticNavigationPrompt.js'
import type { OverlayPresentation } from '@shared/overlay/surface.js'
import { isFillGestureInput } from '@shared/passwords/gesture.js'

/**
 * Popups and redirects a page performed by itself.
 *
 * ## What was reported
 *
 * *"Ich möchte von webseiten getriggertes webseiten wechseln blocken. Neue Seiten sollen nur vom echten
 * user geöffnet werden können oder zumindest muss dieser das bestätigen"* and *"Redirects sollen aus js
 * geblockt werden oder nur vom user bestätigt werden, sonst bleiben wir auf der seite."*
 *
 * Both were unconditional before: `setWindowOpenHandler` turned every `window.open` into a tab, so a
 * popup on a timer and a link the user middle-clicked were one event, and no navigation was gated at all.
 *
 * ## What is asserted, and the two directions of failure
 *
 * These are not symmetrical, and every test below is placed by which one it guards.
 *
 * Letting an unprompted popup through is the defect the feature exists for. But **prompting for something
 * the user did ask for is worse**, because it happens on sites that are behaving perfectly and it teaches
 * people to click the allowing button without reading. So the gesture is checked before the gate, and
 * same-site navigation is never gated — and both of those have tests here saying so rather than being
 * left as properties somebody could tidy away.
 */

function request(overrides: Partial<AutomaticNavigationRequest> = {}): AutomaticNavigationRequest {
  return {
    kind: 'popup',
    url: 'https://ads.example/landing',
    documentUrl: 'https://news.example/article',
    sinceGestureMs: null,
    gate: 'ask',
    ...overrides
  }
}

describe('the gesture window', () => {
  it('counts a recent input event and not an old one', () => {
    expect(withinGestureWindow(0)).toBe(true)
    expect(withinGestureWindow(GESTURE_WINDOW_MS)).toBe(true)
    expect(withinGestureWindow(GESTURE_WINDOW_MS + 1)).toBe(false)
  })

  it('does not count a view nobody has touched', () => {
    // `null` is "never", which is the clearest case the feature exists for: a page that opens a popup
    // before the user has interacted with it at all.
    expect(withinGestureWindow(null)).toBe(false)
  })

  it('does not count a negative age as a gesture', () => {
    // Clocks disagreeing is not evidence of a click, and reading it as one would be a gesture a page
    // could obtain by waiting for a clock adjustment.
    expect(withinGestureWindow(-50)).toBe(false)
  })
})

describe('a popup', () => {
  it('is allowed when the user just clicked, whatever the setting says', () => {
    /*
      The order that matters most in this file. A setting called "never open" that swallowed the window a
      person opened deliberately would be reported as a bug, and rightly — so the gesture is checked
      before the gate, and this asserts it for the strictest gate there is.
    */
    for (const gate of ['allow', 'ask', 'block'] as const) {
      expect(decideAutomaticNavigation(request({ gate, sinceGestureMs: 40 })).action, gate).toBe(
        'allow'
      )
    }
  })

  it('is refused with no gesture behind it when the setting blocks', () => {
    expect(decideAutomaticNavigation(request({ gate: 'block' })).action).toBe('block')
  })

  it('asks with no gesture behind it when the setting asks', () => {
    expect(decideAutomaticNavigation(request({ gate: 'ask' })).action).toBe('ask')
  })

  it('is allowed unconditionally when the setting allows', () => {
    expect(decideAutomaticNavigation(request({ gate: 'allow' })).action).toBe('allow')
  })

  it('is gated even within the same site', () => {
    /*
      The one place popups and navigation are judged differently. A same-site window nobody asked for is
      still a window nobody asked for, and this is also what every browser's own popup blocker does —
      Chromium does not exempt same-origin `window.open` from the gesture requirement either.
    */
    const decision = decideAutomaticNavigation(
      request({ url: 'https://news.example/other', documentUrl: 'https://news.example/article' })
    )
    expect(decision.action).toBe('ask')
  })

  it('says why, for the log', () => {
    // Not shown to a page; a refusal nobody can tell from a bug is the thing `navigation-policy.ts`
    // already refuses to ship.
    expect(decideAutomaticNavigation(request({ gate: 'block' })).reason).toContain('no user gesture')
  })
})

describe('a page sending itself somewhere', () => {
  const navigation = (overrides: Partial<AutomaticNavigationRequest> = {}) =>
    decideAutomaticNavigation(request({ kind: 'navigation', ...overrides }))

  it('is gated across sites with no gesture', () => {
    expect(navigation({ gate: 'ask' }).action).toBe('ask')
    expect(navigation({ gate: 'block' }).action).toBe('block')
  })

  it('is allowed within the same site, however strict the setting', () => {
    /*
      The guard against the failure that would matter most in practice.

      `will-frame-navigate` fires for a page moving *itself*, and a site sending `/` to `/home`, or
      replacing the address after an asynchronous sign-in check, is ordinary and constant. Gating it would
      produce dialogues on sites doing nothing wrong — which is how a user learns to click through
      everything this feature ever asks.
    */
    for (const gate of ['ask', 'block'] as const) {
      const decision = navigation({
        gate,
        documentUrl: 'https://shop.example/cart',
        url: 'https://shop.example/checkout'
      })
      expect(decision.action, gate).toBe('allow')
    }
  })

  it('counts a subdomain as the same site', () => {
    // By registrable domain: `docs.example.com` to `shop.example.com` is not a redirect anybody needs
    // warning about, and treating it as one would prompt on half the large sites there are.
    expect(
      navigation({
        gate: 'block',
        documentUrl: 'https://docs.example.com/a',
        url: 'https://shop.example.com/b'
      }).action
    ).toBe('allow')
  })

  it('does not count a lookalike host as the same site', () => {
    // The direction that must not be loose. `example.com.evil.test` is not `example.com`.
    expect(
      navigation({
        gate: 'block',
        documentUrl: 'https://example.com/a',
        url: 'https://example.com.evil.test/b'
      }).action
    ).toBe('block')
  })

  it('gates a target it cannot read as a site', () => {
    /*
      `javascript:`, `data:`, and anything unparseable. "I could not tell" must not become "same site,
      allow it" — that would turn every address this cannot read into an exemption.
    */
    for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'not a url']) {
      expect(navigation({ gate: 'block', url }).action, url).toBe('block')
    }
  })

  it('is allowed when the user just clicked', () => {
    expect(navigation({ gate: 'block', sinceGestureMs: 10 }).action).toBe('allow')
  })
})

/**
 * One click authorises one thing.
 *
 * ## What was reported
 *
 * *"Wenn die webseite weiterleiten will, dann kommt die anzeige zwar, dass ich sagen kann, nicht
 * redirecten, aber es wird teilweise dennoch ein neuer tab geöffnet."*
 *
 * The gesture used to be a timestamp that was only ever *read*, so a single click vouched for everything
 * a page did in the second that followed. The pattern this feature exists for — a click handler hung on
 * the whole document, opening a tab and then sending the page somewhere — therefore got its tab through
 * on the click while the slower half of the same script arrived after the second was up and was put to
 * the user. Asked about one, not asked about the other, which is exactly how it reads from outside.
 *
 * This is Chromium's transient user activation, which `window.open` consumes for the same reason. The
 * direction that must not break is the other one: spending must be reported only when the gesture is
 * genuinely what let the request through, or a click would be consumed by a navigation that was going to
 * be allowed anyway and the next honest popup would be questioned.
 */
describe('spending the gesture', () => {
  it('is reported when the gesture is what allowed it', () => {
    for (const kind of ['popup', 'navigation'] as const) {
      const decision = decideAutomaticNavigation(request({ kind, gate: 'ask', sinceGestureMs: 40 }))
      expect(decision.spendsGesture, kind).toBe(true)
    }
  })

  it('is not reported when the setting allowed it outright', () => {
    // Nothing was spent, because nothing was asked of the click: with the gate open the request never
    // reaches the gesture at all, and consuming it here would question the next real popup.
    const decision = decideAutomaticNavigation(request({ gate: 'allow', sinceGestureMs: 40 }))
    expect(decision.action).toBe('allow')
    expect(decision.spendsGesture).toBe(false)
  })

  it('is not reported for a page moving within its own site', () => {
    // Ordinary navigation, allowed on its own merits. A site sending `/` to `/home` must not spend the
    // click the user is about to open a tab with.
    const decision = decideAutomaticNavigation(
      request({
        kind: 'navigation',
        gate: 'ask',
        documentUrl: 'https://shop.example/cart',
        url: 'https://shop.example/checkout'
      })
    )
    expect(decision.action).toBe('allow')
    expect(decision.spendsGesture).toBe(false)
  })

  it('is not reported when there was nothing to spend', () => {
    for (const gate of ['ask', 'block'] as const) {
      expect(decideAutomaticNavigation(request({ gate })).spendsGesture, gate).toBe(false)
    }
  })
})

describe('what counts as a gesture at all', () => {
  /**
   * Shared with password filling on purpose, and the reason it is worth an assertion here too: the whole
   * feature rests on `input-event` being a signal a page cannot produce. `isFillGestureInput` already
   * encodes which event types mean a person acted, and re-deriving that list for this feature would be a
   * second answer to one question.
   */
  it('takes a press and not a drifting pointer', () => {
    expect(isFillGestureInput({ type: 'mouseDown' })).toBe(true)
    expect(isFillGestureInput({ type: 'keyDown' })).toBe(true)
    /*
      The exclusion that matters here as much as it does for a fill: a pointer crossing a page while
      somebody reads is not consent to a popup, and counting it would leave the gesture window
      permanently open on any page the mouse happens to be over.
    */
    expect(isFillGestureInput({ type: 'mouseMove' })).toBe(false)
    expect(isFillGestureInput({ type: 'mouseWheel' })).toBe(false)
  })
})

describe('the dialogue', () => {
  function harness(): {
    prompt: AutomaticNavigationPrompt
    presented: OverlayPresentation[]
    dismissals: number
  } {
    const presented: OverlayPresentation[] = []
    let dismissals = 0
    const prompt = new AutomaticNavigationPrompt({
      host: {
        presentOverlay: (presentation) => presented.push(presentation),
        dismissOverlay: () => {
          dismissals += 1
        }
      },
      newRequestId: (() => {
        let counter = 0
        return () => `n${++counter}`
      })()
    })
    return {
      prompt,
      presented,
      get dismissals() {
        return dismissals
      }
    }
  }

  it('puts the question up with everything the dialogue has to say', () => {
    const { prompt, presented } = harness()
    prompt.ask({ kind: 'popup', url: 'https://ads.example/x', host: 'ads.example' }, vi.fn())
    expect(presented).toEqual([
      {
        kind: 'navigation-request',
        requestId: 'n1',
        navigationKind: 'popup',
        url: 'https://ads.example/x',
        host: 'ads.example'
      }
    ])
  })

  it('settles with the answer a person gave', () => {
    const { prompt } = harness()
    const settle = vi.fn()
    prompt.ask({ kind: 'popup', url: 'https://ads.example/x', host: 'ads.example' }, settle)
    prompt.answer('n1', true)
    expect(settle).toHaveBeenCalledWith(true)
  })

  it('takes the dialogue down when it is answered', () => {
    const harnessed = harness()
    harnessed.prompt.ask({ kind: 'popup', url: 'https://a.test/', host: 'a.test' }, vi.fn())
    harnessed.prompt.answer('n1', false)
    expect(harnessed.dismissals).toBe(1)
  })

  it('refuses when the dialogue leaves without an answer', () => {
    /*
      A dismissal, a window resize, something else claiming the layer. "The user made it go away" cannot
      be read as consent — and refusing is also the behaviour the feature was asked for: the page stays
      where it is.
    */
    const { prompt } = harness()
    const settle = vi.fn()
    prompt.ask({ kind: 'navigation', url: 'https://ads.example/x', host: 'ads.example' }, settle)
    prompt.cancel('n1')
    expect(settle).toHaveBeenCalledWith(false)
  })

  it('ignores an answer to a question it is not asking', () => {
    /*
      The stale-reply guard every prompt on this layer has. Without it, a click that landed while the
      surface was being replaced would settle the *current* request with an answer given to a different
      one.
    */
    const { prompt } = harness()
    const settle = vi.fn()
    prompt.ask({ kind: 'popup', url: 'https://a.test/', host: 'a.test' }, settle)
    prompt.answer('some-other-id', true)
    expect(settle).not.toHaveBeenCalled()
    expect(prompt.isAsking).toBe(true)
  })

  it('ignores a cancellation belonging to another window', () => {
    /*
      Not defensive politeness. The overlay layer announces a departure to the whole application rather
      than to one window, so without the id check a prompt vanishing in one window would refuse the
      question a second window still has on screen.
    */
    const { prompt } = harness()
    const settle = vi.fn()
    prompt.ask({ kind: 'popup', url: 'https://a.test/', host: 'a.test' }, settle)
    prompt.cancel('n-from-another-window')
    expect(settle).not.toHaveBeenCalled()
    expect(prompt.isAsking).toBe(true)
  })

  it('answers a repeated question once, for every caller waiting on it', () => {
    /*
      A page calling `window.open(sameUrl)` from a loop, or two frames of one site asking together. One
      dialogue, one answer, and every caller settled — asking the user to answer the same address twice
      is how a prompt becomes something to click away.
    */
    const { prompt, presented } = harness()
    const first = vi.fn()
    const second = vi.fn()
    const target = { kind: 'popup' as const, url: 'https://ads.example/x', host: 'ads.example' }
    prompt.ask(target, first)
    prompt.ask(target, second)
    expect(presented, 'the same question was put up twice').toHaveLength(1)

    prompt.answer('n1', true)
    expect(first).toHaveBeenCalledWith(true)
    expect(second).toHaveBeenCalledWith(true)
  })

  it('refuses a different question while one is on screen', () => {
    /*
      Refused rather than queued, which is the design decision this class exists to make — see its
      docblock. Nothing in the page is holding a promise, so there is no request to keep alive, and a page
      firing popups in a loop is exactly the case the feature is for: the right answer to the second is
      no, not "get in line" behind nine dialogues the user has to dismiss.
    */
    const { prompt, presented } = harness()
    const second = vi.fn()
    prompt.ask({ kind: 'popup', url: 'https://a.test/', host: 'a.test' }, vi.fn())
    prompt.ask({ kind: 'popup', url: 'https://b.test/', host: 'b.test' }, second)
    expect(second).toHaveBeenCalledWith(false)
    expect(presented).toHaveLength(1)
  })

  it('is free again once answered', () => {
    const { prompt, presented } = harness()
    prompt.ask({ kind: 'popup', url: 'https://a.test/', host: 'a.test' }, vi.fn())
    prompt.answer('n1', false)
    expect(prompt.isAsking).toBe(false)

    prompt.ask({ kind: 'popup', url: 'https://b.test/', host: 'b.test' }, vi.fn())
    expect(presented).toHaveLength(2)
  })

  it('settles every caller exactly once, on every path', () => {
    /*
      The invariant the whole class is written around, and the one that cannot be checked by reading: a
      caller whose callback never runs is a navigation that neither happens nor visibly fails, and one
      called twice would re-issue a navigation the user allowed once.
    */
    const { prompt } = harness()
    const answered = vi.fn()
    const cancelled = vi.fn()
    const refused = vi.fn()

    prompt.ask({ kind: 'popup', url: 'https://a.test/', host: 'a.test' }, answered)
    prompt.ask({ kind: 'popup', url: 'https://b.test/', host: 'b.test' }, refused)
    prompt.answer('n1', true)
    prompt.answer('n1', false)

    prompt.ask({ kind: 'popup', url: 'https://c.test/', host: 'c.test' }, cancelled)
    prompt.cancel('n2')
    prompt.cancel('n2')

    expect(answered).toHaveBeenCalledTimes(1)
    expect(refused).toHaveBeenCalledTimes(1)
    expect(cancelled).toHaveBeenCalledTimes(1)
  })
})
