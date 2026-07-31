import { describe, expect, it } from 'vitest'
import { wireWindowEvents, type WindowEventHost } from '@main/browser/window-events.js'
import { OVERLAY_AWAITS_ANSWER, OVERLAY_KINDS } from '@shared/overlay/surface.js'

/**
 * What the OS tells a window, and what the window does about it.
 *
 * These nine handlers spent their whole life inside `BrowserWindowController`, where nothing could reach them
 * without an Electron window — so the only check on them was reading. That is a poor guard for this
 * particular code, because every mistake available here is an *omission or a reordering* rather than a wrong
 * expression: a subscription quietly dropped, `applyPolicy` moved after the relayout, `blur` learning to
 * relayout when it never did. All three compile, all three look right in review, and none of them is visible
 * until someone is dragging a tab or leaving fullscreen.
 *
 * So what is asserted here is order and completeness, not arithmetic. The registration list is written out in
 * full — that is the test for "the macOS half of the navigation gesture was added and the Windows half was
 * not" — and each handler is checked as a sequence of consequences rather than as a set.
 */

interface Harness {
  /** Every event subscribed to, in the order `wireWindowEvents` asked for it. */
  registered: string[]
  /** Fires everything listening for an event, the way Electron would. */
  emit(event: string, ...args: unknown[]): void
  /** Every consequence a handler produced, in the order it produced them. */
  calls: string[]
}

/**
 * A window made of nothing.
 *
 * The point of the extraction, and the reason this file exists at all: `WindowEventHost` is satisfied by
 * object literals, so there is no `BrowserWindow`, no `SplitController` and no seam construction here.
 */
function harness(): Harness {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const registered: string[] = []
  const calls: string[] = []

  const host: WindowEventHost = {
    on: (event, handler) => {
      registered.push(event)
      const existing = listeners.get(event)
      if (existing === undefined) listeners.set(event, [handler])
      else existing.push(handler)
    },
    drag: { cancel: () => calls.push('drag.cancel') },
    overlay: {
      dismissKind: (kind) => {
        calls.push(`overlay.dismissKind(${kind})`)
        // The layer answers "it was not that one" for every kind but the one it is showing. Nothing
        // here reads the answer, so a constant false is the honest stand-in for an empty layer.
        return false
      }
    },
    split: {
      setWindowFullscreen: (fullscreen) => calls.push(`setWindowFullscreen(${fullscreen})`)
    },
    fullscreen: { applyPolicy: () => calls.push('fullscreen.applyPolicy') },
    tileInput: {
      navigateByGesture: (source, name) => calls.push(`navigate(${source}, ${name})`)
    },
    relayout: () => calls.push('relayout'),
    broadcastWindowState: () => calls.push('broadcastWindowState'),
    scheduleBroadcast: () => calls.push('scheduleBroadcast')
  }

  wireWindowEvents(host)
  return {
    registered,
    calls,
    emit: (event, ...args) => {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    }
  }
}

describe('window event wiring', () => {
  it('subscribes to exactly the nine events, and to each one once', () => {
    /*
      Written out rather than counted. A count passes while the list is wrong, and the failure this
      guards against is a specific one: `app-command` and `swipe` are the same feature on two platforms,
      and adding one without the other leaves the gesture working for half the users.
    */
    expect(harness().registered).toEqual([
      'resize',
      'maximize',
      'unmaximize',
      'focus',
      'blur',
      'enter-full-screen',
      'leave-full-screen',
      'app-command',
      'swipe'
    ])
  })

  it('cancels the drag before it relayouts a resized window', () => {
    // The drop zones were computed when the drag began. Relaying out first would leave the drag
    // alive for one moment with zones that no longer describe the window.
    const window = harness()
    window.emit('resize')
    expect(window.calls).toEqual([
      'drag.cancel',
      'overlay.dismissKind(layout-menu)',
      'overlay.dismissKind(tab-drop)',
      'overlay.dismissKind(tile-bar)',
      'overlay.dismissKind(find-bar)',
      'relayout'
    ])
  })

  it('cancels the drag on blur, because a pointer released outside leaves no pointerup', () => {
    // Deliberately no relayout: nothing moved, the window merely stopped being the focused one.
    const window = harness()
    window.emit('blur')
    expect(window.calls).toEqual([
      'drag.cancel',
      'overlay.dismissKind(layout-menu)',
      'overlay.dismissKind(tab-drop)',
      'overlay.dismissKind(tile-bar)',
      'overlay.dismissKind(find-bar)',
      'broadcastWindowState'
    ])
  })

  it('never answers a dialogue somebody is waiting on, on either interruption', () => {
    /*
      The defect, stated as the thing that must not happen rather than as the code that avoids it.

      A wholesale `dismiss()` here took down whatever was up, and a departure of these two is settled
      the safe way: `PermissionArbiter.overlayVacated` refuses the page's request, and
      `MasterPasswordPrompt.overlayVacated` throws away what has been typed. So a system notification
      taking focus for a moment, or the user dragging the window wider, replied "Blockieren" to a
      consent dialogue nobody had read — and lost a half-typed master password without a word.

      Derived from `OVERLAY_AWAITS_ANSWER` rather than naming the two kinds, so a seventh surface that
      somebody waits on is protected by the act of declaring it rather than by somebody remembering
      this test exists.
    */
    const waiting = OVERLAY_KINDS.filter((kind) => OVERLAY_AWAITS_ANSWER[kind])
    /*
      A floor rather than an exact count, and the change is deliberate.

      This asserted `toBe(2)` so that the test could not silently end up guarding nothing. But it also
      failed the moment a *third* awaiting surface was declared — `navigation-request` — which is the
      opposite of what it is for: the protection is derived from the table precisely so a new surface is
      covered by declaring it. A floor keeps the guard against an empty set and stops the test from having
      an opinion about how many kinds ask questions.
    */
    expect(
      waiting.length,
      'no surface awaits an answer; this test has nothing to guard'
    ).toBeGreaterThanOrEqual(2)

    for (const event of ['resize', 'blur']) {
      const window = harness()
      window.emit(event)
      for (const kind of waiting) {
        expect(window.calls, `${event} dismissed ${kind}`).not.toContain(
          `overlay.dismissKind(${kind})`
        )
      }
    }
  })

  it('still takes down every surface nobody is waiting on', () => {
    /*
      The other half, and the reason the fix is a filter rather than an exemption for two kinds: the
      protection must not spread. A menu left hanging over a window the user has resized is the
      original complaint, and both tile surfaces carry the rectangle of a tile that a resize has just
      moved — kept, they would sit over a neighbour's page.
    */
    const window = harness()
    window.emit('resize')
    const dismissed = window.calls
      .filter((call) => call.startsWith('overlay.dismissKind('))
      .map((call) => call.slice('overlay.dismissKind('.length, -1))
    expect(dismissed).toEqual(['layout-menu', 'tab-drop', 'tile-bar', 'find-bar'])
  })

  it('tells the chrome UI about maximise, unmaximise and focus, and nothing else', () => {
    for (const event of ['maximize', 'unmaximize', 'focus']) {
      const window = harness()
      window.emit(event)
      expect(window.calls, event).toEqual(['broadcastWindowState'])
    }
  })

  it('records window fullscreen on the way in without touching the tile policy', () => {
    /*
      `applyPolicy` on entry would restore `fullScreenable` while the user is *in* fullscreen, which is
      how the window becomes one they cannot leave. Its absence here is the assertion.
    */
    const window = harness()
    window.emit('enter-full-screen')
    expect(window.calls).toEqual(['setWindowFullscreen(true)', 'relayout', 'scheduleBroadcast'])
  })

  it('restores the tile confinement on the way out, before anything else redraws', () => {
    // Spec 2: `fullScreenable` was lifted so the user's key could take the window, and leaving is the
    // only moment it can safely come back. Ordered ahead of the relayout so nothing is drawn against a
    // window that is still marked freely fullscreenable.
    const window = harness()
    window.emit('leave-full-screen')
    expect(window.calls).toEqual([
      'setWindowFullscreen(false)',
      'fullscreen.applyPolicy',
      'relayout',
      'scheduleBroadcast'
    ])
  })

  it('routes a mouse button and a trackpad swipe to the same decision', () => {
    // Electron passes the event first and the gesture second; reading argument zero would hand
    // `decideNavigationGesture` an event object and navigate nothing, silently.
    const window = harness()
    window.emit('app-command', {}, 'browser-backward')
    window.emit('swipe', {}, 'right')
    expect(window.calls).toEqual([
      'navigate(app-command, browser-backward)',
      'navigate(swipe, right)'
    ])
  })

  it('ignores a gesture that arrives without a name', () => {
    // Both events are typed as `unknown[]` because that is what a Node emitter promises. A missing
    // second argument must be dropped here rather than reaching the tile decision as `undefined`.
    const window = harness()
    window.emit('app-command', {})
    window.emit('swipe', {}, 42)
    expect(window.calls).toEqual([])
  })
})
