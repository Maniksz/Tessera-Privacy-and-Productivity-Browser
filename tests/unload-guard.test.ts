import { EventEmitter } from 'node:events'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseWindow } from 'electron'
import { SessionStore } from '@main/data/SessionStore.js'
import type { CapturedWindow, SessionDocument } from '@shared/session/model.js'
import { HOME_URL } from '@shared/url/omnibox.js'
import {
  CloseContract,
  ShutdownSilence,
  UNLOAD_HANG_MS,
  SITE_MAX,
  UnloadGuard,
  askToLeave,
  closesAtOnce,
  hostOf,
  preventDefaultOf,
  shutdownSilence,
  siteOf,
  unloadDialog,
  type ClosedTab,
  type ClosingTab,
  type UnloadPrompt
} from '@main/browser/unload-guard.js'

/*
  The Electron half, as little of it as the module touches: the app and the updater as the two things that
  announce a quit, the desktop's language, and the native dialog. Hoisted, so the fakes exist before the module
  under test imports them.
*/
const electron = await vi.hoisted(async () => {
  // Imported here rather than above: a hoisted block runs before the file's own imports.
  const { EventEmitter: Emitter } = await import('node:events')
  const app = Object.assign(new Emitter(), { getLocale: () => 'de-DE' })
  return {
    app,
    autoUpdater: new Emitter(),
    dialog: { showMessageBoxSync: vi.fn<(...args: unknown[]) => number>(() => 1) }
  }
})

vi.mock('electron', () => electron)

/**
 * The close contract (KTD5): what asks before a page goes, what never does, and what follows either answer.
 *
 * Everything here runs against a `webContents` made of an `EventEmitter`, because the rule this file exists for
 * is an *ordering* one — Chromium answers a close with `waitForBeforeUnload` later, on its own schedule, and the
 * window's bookkeeping must wait for that answer rather than assume it. So the fake renderer answers only when
 * a test says `answer()`, and a renderer that never answers is a flag rather than a missing call.
 *
 * The window around the tabs is `WindowHarness`: a closed-tab stack, `afterTabClosed` and the one-tab rule, all
 * written the way `BrowserWindowController.#finishClose` does them, so "nothing went on the stack" is read off
 * the same kind of state the real window keeps.
 */

// --- fakes -------------------------------------------------------------------------------------------------

/** What Electron hands a `will-prevent-unload` listener: an event whose `preventDefault` lets the page go. */
interface UnloadEvent {
  defaultPrevented: boolean
  preventDefault(): void
}

/**
 * One page, as Chromium runs it.
 *
 * `objects` is a page with a `beforeunload` handler that asks to stay; `hung` is a renderer that stopped
 * answering. Nothing the core asks of the renderer happens until `answer()`, which is the gap the whole
 * contract is about.
 */
class FakeContents extends EventEmitter {
  url: string
  objects = false
  hung = false
  destroyed = false
  readonly closeCalls: Array<{ waitForBeforeUnload: boolean } | undefined> = []
  #queue: Array<() => void> = []

  constructor(url: string) {
    super()
    this.url = url
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  getURL(): string {
    return this.url
  }

  close(options?: { waitForBeforeUnload: boolean }): void {
    this.closeCalls.push(options)
    // Without `waitForBeforeUnload` the page is not asked: the view goes at once.
    if (options?.waitForBeforeUnload !== true) {
      this.#destroy()
      return
    }
    this.#queue.push(() => this.#beforeUnload(() => this.#destroy()))
  }

  /** A link click in the page: Chromium runs `beforeunload` first, and only then leaves. */
  clickLink(target: string): void {
    this.#queue.push(() =>
      this.#beforeUnload(() => {
        this.url = target
      })
    )
  }

  /** The renderer answers everything it was asked, in order. A hung one answers nothing. */
  answer(): void {
    if (this.hung) return
    const queue = this.#queue
    this.#queue = []
    for (const run of queue) run()
  }

  #beforeUnload(proceed: () => void): void {
    if (!this.objects) {
      proceed()
      return
    }
    const event: UnloadEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    this.emit('will-prevent-unload', event)
    if (event.defaultPrevented) proceed()
  }

  #destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('destroyed')
  }
}

/** A clock the test moves by hand; `after` is the shape `shutdown.ts` hands its timers in. */
class FakeClock {
  now = 0
  #timers: Array<{ at: number; run: () => void; live: boolean }> = []

  readonly after = (ms: number, run: () => void): (() => void) => {
    const timer = { at: this.now + ms, run, live: true }
    this.#timers.push(timer)
    return () => {
      timer.live = false
    }
  }

  advance(ms: number): void {
    this.now += ms
    for (const timer of [...this.#timers]) {
      if (timer.live && timer.at <= this.now) {
        timer.live = false
        timer.run()
      }
    }
  }

  get pending(): number {
    return this.#timers.filter((timer) => timer.live).length
  }
}

interface FakeTab extends ClosingTab {
  readonly id: string
  readonly contents: FakeContents
  unloaded: boolean
}

function fakeTab(
  id: string,
  url: string,
  options: { objects?: boolean; ephemeral?: boolean } = {}
): FakeTab {
  const contents = new FakeContents(url)
  contents.objects = options.objects ?? false
  const tab: FakeTab = {
    id,
    contents,
    unloaded: false,
    ephemeral: options.ephemeral ?? false,
    view: { webContents: contents },
    toState: () => ({ url: contents.destroyed ? '' : contents.url, unloaded: tab.unloaded })
  }
  return tab
}

interface Group {
  id: string
  collapsed: boolean
  tabIds: string[]
}

/**
 * A window as `BrowserWindowController` keeps one, reduced to what closing touches.
 *
 * `finish` is `#finishClose` written out: the closed-tab stack, `afterTabClosed`, and the one-tab rule, which
 * opens a fresh start page when the last tab went and the close was one tab's rather than the window's.
 */
class WindowHarness {
  readonly clock = new FakeClock()
  readonly tabs = new Map<string, FakeTab>()
  order: string[] = []
  readonly groups: Group[] = []
  readonly closedStack: string[] = []
  readonly afterTabClosed: string[] = []
  readonly calls: string[] = []
  readonly prompts: UnloadPrompt[] = []
  /** What the user answers, in order; `stay` once they run out, which is the safe answer. */
  answers: Array<'leave' | 'stay'> = []
  oneTabRuleFired = 0
  windowClosed = false
  readonly shutdown: { begun: boolean }
  /** Whatever the window does after a tab has finished closing; the session's broadcast, in one test. */
  onFinish: () => void = () => undefined
  readonly contract: CloseContract
  #closeHandlers: Array<(...args: unknown[]) => void> = []
  #opened = 0

  constructor(tabs: FakeTab[] = [], shutdown: { begun: boolean } = { begun: false }) {
    this.shutdown = shutdown
    this.contract = new CloseContract({
      on: (event, handler) => {
        this.calls.push(`on(${event})`)
        this.#closeHandlers.push(handler)
      },
      tab: (tabId) => this.tabs.get(tabId),
      groups: {
        displayOrder: () => this.order,
        groups: () => this.groups,
        setCollapsed: (id, collapsed) => {
          this.calls.push(`setCollapsed(${id}, ${String(collapsed)})`)
          const group = this.groups.find((candidate) => candidate.id === id)
          if (group !== undefined) group.collapsed = collapsed
        }
      },
      activateTab: (tabId) => this.calls.push(`activate(${tabId})`),
      confirm: (prompt) => {
        this.calls.push(`confirm(${prompt.mode}, ${prompt.site})`)
        this.prompts.push(prompt)
        return (this.answers.shift() ?? 'stay') === 'leave'
      },
      finish: (tabId, closed) => this.#finish(tabId, closed),
      closeWindow: () => {
        this.calls.push('closeWindow')
        // Electron asks again, and this time the contract must let it through.
        if (!this.requestWindowClose().defaultPrevented) this.#teardown()
      },
      shutdown: this.shutdown,
      after: this.clock.after
    })
    for (const tab of tabs) this.add(tab)
  }

  add(tab: FakeTab): FakeTab {
    this.tabs.set(tab.id, tab)
    this.order.push(tab.id)
    this.contract.track(tab.id)
    return tab
  }

  tab(tabId: string): FakeTab {
    const tab = this.tabs.get(tabId)
    if (tab === undefined) throw new Error(`no tab ${tabId}`)
    return tab
  }

  /** The window's × or `Cmd+Shift+W`: Electron's `close`, which a listener may cancel. */
  requestWindowClose(): UnloadEvent {
    const event: UnloadEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    for (const handler of this.#closeHandlers) handler(event)
    return event
  }

  /** The OS closing the window with nothing left to ask: `closed`, the silent half. */
  #teardown(): void {
    this.windowClosed = true
    this.contract.dispose()
    for (const tab of this.tabs.values()) tab.contents.close()
    this.tabs.clear()
  }

  /** `BrowserWindowController.destroy()` and every quit: straight to `closed`, no `close` first. */
  destroyWindow(): void {
    this.#teardown()
  }

  #finish(tabId: string, closed: ClosedTab): void {
    this.calls.push(`finish(${tabId})`)
    if (closed.url !== '') this.closedStack.push(closed.url)
    this.tabs.delete(tabId)
    this.order = this.order.filter((id) => id !== tabId)
    this.afterTabClosed.push(tabId)
    if (this.tabs.size === 0 && closed.keepOneTab) {
      this.oneTabRuleFired += 1
      this.#opened += 1
      this.add(fakeTab(`fresh-${String(this.#opened)}`, HOME_URL))
    }
    this.onFinish()
  }
}

beforeEach(() => {
  electron.dialog.showMessageBoxSync.mockClear()
})

// --- closing one tab -------------------------------------------------------------------------------------

describe('closing a tab whose page objects', () => {
  it('keeps the tab, the stack and afterTabClosed as they were when the user stays (AE3)', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/compose', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    window.answers = ['stay']

    window.contract.closeTab('mail')
    window.tab('mail').contents.answer()

    expect(window.prompts).toEqual([{ mode: 'close', site: 'mail.example' }])
    expect(window.tabs.has('mail')).toBe(true)
    expect(window.tab('mail').contents.destroyed).toBe(false)
    expect(window.closedStack).toEqual([])
    expect(window.afterTabClosed).toEqual([])
    // Asked the page, which is the only way Electron has to find out whether it objects.
    expect(window.tab('mail').contents.closeCalls).toEqual([{ waitForBeforeUnload: true }])
  })

  it('finishes the close exactly once when the user leaves', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/compose', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    window.answers = ['leave']
    const mail = window.tab('mail')

    window.contract.closeTab('mail')
    mail.contents.answer()
    // A late `destroyed` from somewhere else must not finish it a second time.
    mail.contents.emit('destroyed')

    expect(window.calls.filter((call) => call === 'finish(mail)')).toHaveLength(1)
    expect(window.closedStack).toEqual(['https://mail.example/compose'])
    expect(window.afterTabClosed).toEqual(['mail'])
  })

  it('shows the page before it asks, unfolding a collapsed group first', () => {
    const window = new WindowHarness([
      fakeTab('news', 'https://news.example/'),
      fakeTab('draft', 'https://docs.example/draft', { objects: true })
    ])
    window.groups.push({ id: 'g1', collapsed: true, tabIds: ['draft'] })
    window.answers = ['stay']

    window.contract.closeTab('draft')
    window.tab('draft').contents.answer()

    const asked = window.calls.indexOf('confirm(close, docs.example)')
    expect(window.calls.slice(asked - 2, asked + 1)).toEqual([
      'setCollapsed(g1, false)',
      'activate(draft)',
      'confirm(close, docs.example)'
    ])
    expect(window.groups[0]?.collapsed).toBe(false)
  })

  it('leaves an open group alone and only brings the tab forward', () => {
    const window = new WindowHarness([fakeTab('draft', 'https://docs.example/', { objects: true })])
    window.groups.push({ id: 'g1', collapsed: false, tabIds: ['draft'] })
    window.groups.push({ id: 'g2', collapsed: true, tabIds: ['other'] })

    window.contract.closeTab('draft')
    window.tab('draft').contents.answer()

    expect(window.calls.filter((call) => call.startsWith('setCollapsed'))).toEqual([])
    expect(window.calls).toContain('activate(draft)')
  })

  it('does nothing on a second click while the first is still waiting on the page', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    window.answers = ['leave']
    const mail = window.tab('mail')

    window.contract.closeTab('mail')
    window.contract.closeTab('mail')
    mail.contents.answer()

    expect(mail.contents.closeCalls).toHaveLength(1)
    expect(window.prompts).toHaveLength(1)
    expect(window.calls.filter((call) => call === 'finish(mail)')).toHaveLength(1)
  })

  it('can be asked again after the user stayed', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    window.answers = ['stay', 'leave']
    const mail = window.tab('mail')

    window.contract.closeTab('mail')
    mail.contents.answer()
    window.contract.closeTab('mail')
    mail.contents.answer()

    expect(window.prompts).toHaveLength(2)
    expect(window.tabs.has('mail')).toBe(false)
  })

  it('does not fire the one-tab rule for the last tab when the user stays', () => {
    const window = new WindowHarness([fakeTab('only', 'https://mail.example/', { objects: true })])
    window.answers = ['stay']

    window.contract.closeTab('only')
    window.tab('only').contents.answer()

    expect(window.oneTabRuleFired).toBe(0)
    expect([...window.tabs.keys()]).toEqual(['only'])
  })

  it('fires the one-tab rule for the last tab once it has really gone', () => {
    const window = new WindowHarness([fakeTab('only', 'https://mail.example/', { objects: true })])
    window.answers = ['leave']

    window.contract.closeTab('only')
    window.tab('only').contents.answer()

    expect(window.oneTabRuleFired).toBe(1)
    expect([...window.tabs.keys()]).toEqual(['fresh-1'])
  })
})

describe('closing a tab whose page does not object', () => {
  it('closes without a dialog, and only once the renderer has answered', () => {
    const window = new WindowHarness([
      fakeTab('news', 'https://news.example/'),
      fakeTab('mail', 'https://mail.example/')
    ])
    const news = window.tab('news')

    window.contract.closeTab('news')
    // Still here: the page has not been asked yet, so nothing may be finished on its behalf.
    expect(window.tabs.has('news')).toBe(true)
    expect(window.closedStack).toEqual([])

    news.contents.answer()

    expect(window.prompts).toEqual([])
    expect(window.tabs.has('news')).toBe(false)
    expect(window.closedStack).toEqual(['https://news.example/'])
  })

  it('ignores a request for a tab this window does not have', () => {
    const window = new WindowHarness([fakeTab('news', 'https://news.example/')])

    window.contract.closeTab('elsewhere')
    window.contract.track('elsewhere')

    expect(window.calls.filter((call) => call.startsWith('finish'))).toEqual([])
  })
})

describe('closing what has nothing to ask', () => {
  it('closes a filler at once, in the same call, without asking its page', () => {
    const window = new WindowHarness([
      fakeTab('filler', HOME_URL, { ephemeral: true }),
      fakeTab('news', 'https://news.example/')
    ])
    const filler = window.tab('filler')

    window.contract.closeTab('filler')

    expect(window.tabs.has('filler')).toBe(false)
    expect(filler.contents.closeCalls).toEqual([])
    expect(window.afterTabClosed).toEqual(['filler'])
  })

  it('closes an internal page, an unloaded tab and a gone view at once', () => {
    const settings = fakeTab('settings', 'tessera://settings')
    const unloaded = fakeTab('unloaded', 'https://news.example/')
    unloaded.unloaded = true
    const gone = fakeTab('gone', 'https://mail.example/', { objects: true })
    const blank = fakeTab('blank', '')
    const window = new WindowHarness([settings, unloaded, gone, blank, fakeTab('keep', HOME_URL)])
    gone.contents.destroyed = true

    for (const id of ['settings', 'unloaded', 'gone', 'blank']) window.contract.closeTab(id)

    expect([...window.tabs.keys()]).toEqual(['keep'])
    expect(window.prompts).toEqual([])
  })

  it('names which tabs close at once', () => {
    expect(closesAtOnce(fakeTab('a', 'https://news.example/'))).toBe(false)
    expect(closesAtOnce(fakeTab('b', 'https://news.example/', { ephemeral: true }))).toBe(true)
    expect(closesAtOnce(fakeTab('c', HOME_URL))).toBe(true)
    expect(closesAtOnce(fakeTab('d', ''))).toBe(true)
  })
})

describe('a renderer that does not answer', () => {
  it('is closed without asking once five seconds have passed', () => {
    const window = new WindowHarness([
      fakeTab('stuck', 'https://slow.example/', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    const stuck = window.tab('stuck')
    stuck.contents.hung = true

    window.contract.closeTab('stuck')
    stuck.contents.answer()
    window.clock.advance(UNLOAD_HANG_MS - 1)
    expect(window.tabs.has('stuck')).toBe(true)

    window.clock.advance(1)

    expect(stuck.contents.closeCalls).toEqual([{ waitForBeforeUnload: true }, undefined])
    expect(window.tabs.has('stuck')).toBe(false)
    expect(window.prompts).toEqual([])
  })

  it('does not count the time the user spends on the question', () => {
    const contents = new FakeContents('https://mail.example/')
    contents.objects = true
    const clock = new FakeClock()
    const settled: boolean[] = []
    // The user takes far longer than the deadline to answer, and then stays.
    const confirm = (): boolean => {
      clock.advance(UNLOAD_HANG_MS * 4)
      return false
    }
    const guard = new UnloadGuard({ contents, confirm, after: clock.after })

    guard.request('close', (gone) => settled.push(gone))
    clock.advance(UNLOAD_HANG_MS - 1)
    contents.answer()
    clock.advance(UNLOAD_HANG_MS * 4)

    expect(settled).toEqual([false])
    expect(contents.destroyed).toBe(false)
    expect(contents.closeCalls).toEqual([{ waitForBeforeUnload: true }])
  })

  it('forces the close again if the page agreed and then never went', () => {
    const contents = new FakeContents('https://slow.example/')
    const clock = new FakeClock()
    const settled: boolean[] = []
    const guard = new UnloadGuard({ contents, confirm: () => true, after: clock.after })
    // A page that says "go ahead" and whose view then stays: the objection is let through, nothing follows.
    contents.close = (options) => {
      contents.closeCalls.push(options)
      if (options === undefined) contents.emit('destroyed')
    }

    guard.request('close', (gone) => settled.push(gone))
    const event: UnloadEvent = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      }
    }
    contents.emit('will-prevent-unload', event)
    expect(event.defaultPrevented).toBe(true)
    clock.advance(UNLOAD_HANG_MS)

    expect(contents.closeCalls).toEqual([{ waitForBeforeUnload: true }, undefined])
    expect(settled).toEqual([true])
  })

  it('settles at once when the forced close finds the view already gone', () => {
    const contents = new FakeContents('https://slow.example/')
    const clock = new FakeClock()
    const settled: boolean[] = []
    const guard = new UnloadGuard({ contents, confirm: () => true, after: clock.after })
    // Gone without telling anybody, which a view whose process died can be.
    contents.close = (options) => {
      contents.closeCalls.push(options)
    }

    guard.request('close', (gone) => settled.push(gone))
    contents.destroyed = true
    clock.advance(UNLOAD_HANG_MS)

    expect(contents.closeCalls).toEqual([{ waitForBeforeUnload: true }])
    expect(settled).toEqual([true])
  })
})

// --- navigating away ---------------------------------------------------------------------------------------

describe('navigating away from a page that objects', () => {
  it('loads the link target when the user leaves', () => {
    const window = new WindowHarness([fakeTab('mail', 'https://mail.example/', { objects: true })])
    window.answers = ['leave']
    const mail = window.tab('mail')

    mail.contents.clickLink('https://elsewhere.example/')
    mail.contents.answer()

    expect(mail.contents.url).toBe('https://elsewhere.example/')
    expect(window.prompts).toEqual([{ mode: 'navigate', site: 'mail.example' }])
  })

  it('stays on the page when the user stays, and asks exactly once', () => {
    const window = new WindowHarness([fakeTab('mail', 'https://mail.example/', { objects: true })])
    window.answers = ['stay']
    const mail = window.tab('mail')

    mail.contents.clickLink('https://elsewhere.example/')
    mail.contents.answer()

    expect(mail.contents.url).toBe('https://mail.example/')
    expect(window.prompts).toHaveLength(1)
    expect(mail.contents.closeCalls).toEqual([])
    expect(window.calls.filter((call) => call.startsWith('finish'))).toEqual([])
  })

  it('does not ask for a page that does not object', () => {
    const window = new WindowHarness([fakeTab('news', 'https://news.example/')])
    const news = window.tab('news')

    news.contents.clickLink('https://elsewhere.example/')
    news.contents.answer()

    expect(news.contents.url).toBe('https://elsewhere.example/')
    expect(window.prompts).toEqual([])
  })
})

// --- discarding --------------------------------------------------------------------------------------------

describe('discarding a tab', () => {
  it('never asks, and reports "not discarded" when the page objects', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    const outcomes: boolean[] = []

    window.contract.discard('mail', (discarded) => outcomes.push(discarded))
    window.tab('mail').contents.answer()

    expect(outcomes).toEqual([false])
    expect(window.prompts).toEqual([])
    expect(window.tab('mail').contents.destroyed).toBe(false)
  })

  it('puts nothing on the stack and fires no one-tab rule when it succeeds', () => {
    const window = new WindowHarness([fakeTab('only', 'https://news.example/')])
    const outcomes: boolean[] = []

    window.contract.discard('only', (discarded) => outcomes.push(discarded))
    window.tab('only').contents.answer()

    expect(outcomes).toEqual([true])
    expect(window.closedStack).toEqual([])
    expect(window.oneTabRuleFired).toBe(0)
    expect(window.calls.filter((call) => call.startsWith('finish'))).toEqual([])
  })

  it('closes a discarded tab at once afterwards, since its page is gone', () => {
    const window = new WindowHarness([
      fakeTab('news', 'https://news.example/'),
      fakeTab('mail', 'https://mail.example/')
    ])
    window.contract.discard('news', () => undefined)
    window.tab('news').contents.answer()

    window.contract.closeTab('news')

    expect(window.tabs.has('news')).toBe(false)
    expect(window.afterTabClosed).toEqual(['news'])
  })

  it('keeps a second discard a discard: it waits on the same answer and asks nobody', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    const outcomes: boolean[] = []
    const mail = window.tab('mail')

    window.contract.discard('mail', (discarded) => outcomes.push(discarded))
    window.contract.discard('mail', (discarded) => outcomes.push(discarded))
    mail.contents.answer()

    expect(mail.contents.closeCalls).toEqual([{ waitForBeforeUnload: true }])
    expect(outcomes).toEqual([false, false])
    expect(window.prompts).toEqual([])
  })

  it('puts the question to the user when a close joins a pending discard', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/compose', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    window.answers = ['leave']
    const outcomes: boolean[] = []
    const mail = window.tab('mail')

    window.contract.discard('mail', (discarded) => outcomes.push(discarded))
    window.contract.closeTab('mail')
    mail.contents.answer()

    // Asked once, as a close: the user's × is not swallowed as a refused discard.
    expect(mail.contents.closeCalls).toEqual([{ waitForBeforeUnload: true }])
    expect(window.prompts).toEqual([{ mode: 'close', site: 'mail.example' }])
    expect(window.tabs.has('mail')).toBe(false)
    expect(window.closedStack).toEqual(['https://mail.example/compose'])
    expect(outcomes).toEqual([true])
  })

  it('stays loaded when the renderer does not answer, and is not forced after five seconds', () => {
    const contents = new FakeContents('https://mail.example/')
    contents.objects = true
    contents.hung = true
    const clock = new FakeClock()
    const settled: boolean[] = []
    const asked: string[] = []
    const guard = new UnloadGuard({
      contents,
      confirm: (mode) => {
        asked.push(mode)
        return true
      },
      after: clock.after
    })

    guard.request('discard', (gone) => settled.push(gone))
    clock.advance(UNLOAD_HANG_MS)

    expect(settled).toEqual([false])
    expect(guard.pending).toBe(false)
    expect(contents.closeCalls).toEqual([{ waitForBeforeUnload: true }])
    expect(contents.destroyed).toBe(false)

    // The renderer comes back and objects to the close it still owed an answer: refused, and nobody is asked.
    contents.hung = false
    contents.answer()

    expect(asked).toEqual([])
    expect(contents.destroyed).toBe(false)
    expect(clock.pending).toBe(0)
  })

  it('still asks about a navigation once the late answer to a given-up discard is in', () => {
    const contents = new FakeContents('https://mail.example/')
    contents.objects = true
    contents.hung = true
    const clock = new FakeClock()
    const asked: string[] = []
    const guard = new UnloadGuard({
      contents,
      confirm: (mode) => {
        asked.push(mode)
        return false
      },
      after: clock.after
    })

    guard.request('discard', () => undefined)
    clock.advance(UNLOAD_HANG_MS)
    contents.hung = false
    contents.answer()
    contents.clickLink('https://elsewhere.example/')
    contents.answer()

    expect(asked).toEqual(['navigate'])
    expect(contents.url).toBe('https://mail.example/')
  })

  it('forces a discard a close has joined, as it would the close alone', () => {
    const contents = new FakeContents('https://slow.example/')
    contents.hung = true
    const clock = new FakeClock()
    const settled: Array<[string, boolean]> = []
    const guard = new UnloadGuard({ contents, confirm: () => true, after: clock.after })

    guard.request('discard', (gone) => settled.push(['discard', gone]))
    guard.request('close', (gone) => settled.push(['close', gone]))
    clock.advance(UNLOAD_HANG_MS)

    expect(contents.closeCalls).toEqual([{ waitForBeforeUnload: true }, undefined])
    expect(settled).toEqual([
      ['discard', true],
      ['close', true]
    ])
  })

  it('answers "not discarded" for a tab this window does not have', () => {
    const window = new WindowHarness()
    const outcomes: boolean[] = []

    window.contract.discard('elsewhere', (discarded) => outcomes.push(discarded))

    expect(outcomes).toEqual([false])
  })
})

// --- closing the window ------------------------------------------------------------------------------------

describe('closing a window', () => {
  it('asks tab by tab, and a "stay" keeps the window with that tab in front', () => {
    const window = new WindowHarness([
      fakeTab('first', 'https://news.example/'),
      fakeTab('second', 'https://mail.example/', { objects: true }),
      fakeTab('third', 'https://docs.example/', { objects: true })
    ])
    window.answers = ['leave', 'stay']

    const event = window.requestWindowClose()
    expect(event.defaultPrevented).toBe(true)

    // One at a time, in strip order: the next is asked only when the one before has gone.
    expect(window.tab('second').contents.closeCalls).toEqual([])
    window.tab('first').contents.answer()
    window.tab('second').contents.answer()
    window.tab('third').contents.answer()

    expect(window.closedStack).toEqual(['https://news.example/', 'https://mail.example/'])
    expect(window.prompts).toEqual([
      { mode: 'close', site: 'mail.example' },
      { mode: 'close', site: 'docs.example' }
    ])
    expect([...window.tabs.keys()]).toEqual(['third'])
    expect(window.calls.at(-2)).toBe('activate(third)')
    expect(window.windowClosed).toBe(false)
    expect(window.calls).not.toContain('closeWindow')
  })

  it('closes the window once every tab has gone, without the one-tab rule', () => {
    const window = new WindowHarness([
      fakeTab('first', 'https://news.example/'),
      fakeTab('second', 'https://mail.example/', { objects: true }),
      fakeTab('start', HOME_URL)
    ])
    window.answers = ['leave']

    window.requestWindowClose()
    window.tab('first').contents.answer()
    window.tab('second').contents.answer()

    expect(window.oneTabRuleFired).toBe(0)
    expect(window.calls).toContain('closeWindow')
    expect(window.windowClosed).toBe(true)
    // The start page was never asked; it went with the window, not through the tab's own close.
    expect(window.afterTabClosed).toEqual(['first', 'second'])
  })

  it('closes a window of pages that have nothing to ask without waiting on any of them', () => {
    const window = new WindowHarness([fakeTab('start', HOME_URL)])

    const event = window.requestWindowClose()

    expect(event.defaultPrevented).toBe(true)
    expect(window.windowClosed).toBe(true)
    expect(window.closedStack).toEqual([])
  })

  it('ignores a second click on the window while it is still asking', () => {
    const window = new WindowHarness([
      fakeTab('first', 'https://news.example/'),
      fakeTab('second', 'https://mail.example/')
    ])

    window.requestWindowClose()
    const again = window.requestWindowClose()
    window.tab('first').contents.answer()

    expect(again.defaultPrevented).toBe(true)
    expect(window.tab('second').contents.closeCalls).toHaveLength(1)
  })

  it('waits on a tab whose own close was already under way', () => {
    const window = new WindowHarness([
      fakeTab('first', 'https://news.example/'),
      fakeTab('second', 'https://mail.example/')
    ])

    window.contract.closeTab('first')
    window.requestWindowClose()
    window.tab('first').contents.answer()
    window.tab('second').contents.answer()

    expect(window.windowClosed).toBe(true)
    expect(window.calls.filter((call) => call === 'finish(first)')).toHaveLength(1)
  })

  it('can be tried again after the user stayed', () => {
    const window = new WindowHarness([fakeTab('mail', 'https://mail.example/', { objects: true })])
    window.answers = ['stay', 'leave']

    window.requestWindowClose()
    window.tab('mail').contents.answer()
    expect(window.windowClosed).toBe(false)

    window.requestWindowClose()
    window.tab('mail').contents.answer()

    expect(window.windowClosed).toBe(true)
    expect(window.oneTabRuleFired).toBe(0)
  })

  it('puts nothing on the stack and fires no one-tab rule when the window is simply torn down', () => {
    const window = new WindowHarness([
      fakeTab('first', 'https://news.example/'),
      fakeTab('mail', 'https://mail.example/', { objects: true })
    ])
    const mail = window.tab('mail')
    window.contract.closeTab('mail')

    window.destroyWindow()
    // The renderer's answer to the close that was pending arrives into a window that is gone.
    mail.contents.answer()

    expect(window.closedStack).toEqual([])
    expect(window.oneTabRuleFired).toBe(0)
    expect(window.calls.filter((call) => call.startsWith('finish'))).toEqual([])
    expect(window.prompts).toEqual([])
    expect(window.clock.pending).toBe(0)
  })

  it('subscribes to the window close and to nothing else of the window', () => {
    const window = new WindowHarness()
    expect(window.calls).toEqual(['on(close)'])
  })
})

// --- quitting ----------------------------------------------------------------------------------------------

describe('quitting', () => {
  it('shows no dialog and lets every window close at once', () => {
    const window = new WindowHarness([
      fakeTab('mail', 'https://mail.example/', { objects: true }),
      fakeTab('news', 'https://news.example/')
    ])
    window.shutdown.begun = true

    const event = window.requestWindowClose()

    expect(event.defaultPrevented).toBe(false)
    expect(window.tab('mail').contents.closeCalls).toEqual([])
    expect(window.prompts).toEqual([])
    expect(electron.dialog.showMessageBoxSync).not.toHaveBeenCalled()
  })

  it('keeps all five tabs in the sealed session although they close silently afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tessera-unload-'))
    const filePath = join(dir, 'session.json')
    const store = await SessionStore.open({ filePath, debounceMs: 0, generateId: () => 'slot1' })
    const recorder = store.recorderFor('normal')
    const ids = ['a', 'b', 'c', 'd', 'e']
    // The quit as the entry point runs it: `beginShutdown` seals on the first `before-quit`, before anything closes.
    const app = new EventEmitter()
    app.on('before-quit', () => store.seal())
    const silence = new ShutdownSilence({ app, updater: new EventEmitter() })
    const window = new WindowHarness(
      ids.map((id) => fakeTab(id, `https://example.com/${id}`, { objects: id === 'c' })),
      silence
    )
    const captured = (): CapturedWindow => ({
      layout: '1x1',
      fractions: {},
      activeTile: 0,
      tabs: window.order.map((id) => ({
        id,
        url: `https://example.com/${id}`,
        pendingInput: null,
        title: id,
        pinned: false,
        tileIndex: null,
        zoomPercent: null
      }))
    })
    // Every change the window makes is recorded, as its broadcast round does.
    window.onFinish = () => recorder.record(captured())
    recorder.record(captured())

    app.emit('before-quit')
    const event = window.requestWindowClose()
    expect(event.defaultPrevented).toBe(false)
    // What `closed` does in a quit: every tab silently, then the window's slot.
    window.destroyWindow()
    recorder.record({ ...captured(), tabs: [] })
    recorder.close()
    await store.flush()

    const saved = JSON.parse(await readFile(filePath, 'utf8')) as SessionDocument
    expect(saved.windows[0]?.tabs.map((tab) => tab.id)).toEqual(ids)
    expect(window.calls.filter((call) => call.startsWith('finish'))).toEqual([])
    expect(window.prompts).toEqual([])
  })

  it('knows a quit has begun from the app, and an update install from the updater', () => {
    const app = new EventEmitter()
    const updater = new EventEmitter()
    const byApp = new ShutdownSilence({ app, updater })
    const byUpdater = new ShutdownSilence({ app: new EventEmitter(), updater })

    expect(byApp.begun).toBe(false)
    app.emit('before-quit')
    expect(byApp.begun).toBe(true)

    expect(byUpdater.begun).toBe(false)
    updater.emit('before-quit-for-update')
    expect(byUpdater.begun).toBe(true)
  })

  it("listens to Electron's own app and updater, once per process", () => {
    const first = shutdownSilence()
    expect(shutdownSilence()).toBe(first)
    expect(first.begun).toBe(false)
    electron.autoUpdater.emit('before-quit-for-update')
    expect(first.begun).toBe(true)
    expect(electron.app.listenerCount('before-quit')).toBe(1)
  })
})

// --- the guard alone ---------------------------------------------------------------------------------------

describe('the guard on one page', () => {
  it('settles a request for a view that is already gone at once', () => {
    const contents = new FakeContents('https://news.example/')
    contents.destroyed = true
    const settled: boolean[] = []
    const guard = new UnloadGuard({ contents, confirm: () => true })

    guard.request('close', (gone) => settled.push(gone))

    expect(settled).toEqual([true])
    expect(guard.pending).toBe(false)
    expect(contents.closeCalls).toEqual([])
  })

  it('is pending from the request until the answer', () => {
    const contents = new FakeContents('https://news.example/')
    const guard = new UnloadGuard({ contents, confirm: () => true, after: new FakeClock().after })

    guard.request('close', () => undefined)
    expect(guard.pending).toBe(true)
    contents.answer()
    expect(guard.pending).toBe(false)
  })

  it('ignores a view going away that nobody asked to close', () => {
    const contents = new FakeContents('https://news.example/')
    const guard = new UnloadGuard({ contents, confirm: () => true })

    contents.close()

    expect(guard.pending).toBe(false)
  })

  it('stops listening and calls off its deadline when disposed', () => {
    const contents = new FakeContents('https://news.example/')
    const clock = new FakeClock()
    const settled: boolean[] = []
    const guard = new UnloadGuard({ contents, confirm: () => true, after: clock.after })

    guard.request('close', (gone) => settled.push(gone))
    guard.dispose()
    clock.advance(UNLOAD_HANG_MS)
    contents.answer()

    expect(settled).toEqual([])
    expect(contents.listenerCount('will-prevent-unload')).toBe(0)
    expect(contents.listenerCount('destroyed')).toBe(0)
    guard.dispose()
  })

  it('gives a window without a clock of its own the real five seconds', () => {
    vi.useFakeTimers()
    try {
      const stuck = fakeTab('stuck', 'https://slow.example/')
      stuck.contents.hung = true
      const finished: string[] = []
      const contract = new CloseContract({
        on: () => undefined,
        tab: (tabId) => (tabId === 'stuck' ? stuck : undefined),
        groups: { displayOrder: () => ['stuck'], groups: () => [], setCollapsed: () => undefined },
        activateTab: () => undefined,
        confirm: () => true,
        finish: (tabId) => finished.push(tabId),
        closeWindow: () => undefined
      })
      contract.track('stuck')

      contract.closeTab('stuck')
      vi.advanceTimersByTime(UNLOAD_HANG_MS - 1)
      expect(finished).toEqual([])
      vi.advanceTimersByTime(1)

      expect(finished).toEqual(['stuck'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses real timers when none are handed in', () => {
    vi.useFakeTimers()
    try {
      const contents = new FakeContents('https://slow.example/')
      contents.hung = true
      const settled: boolean[] = []
      const guard = new UnloadGuard({ contents, confirm: () => true })

      guard.request('close', (gone) => settled.push(gone))
      vi.advanceTimersByTime(UNLOAD_HANG_MS)

      expect(settled).toEqual([true])
      guard.request('close', () => undefined)
      guard.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

// --- the helpers and the dialog ----------------------------------------------------------------------------

describe('the site a question names', () => {
  it('is the host, or nothing for an address that does not parse', () => {
    expect(hostOf('https://mail.example:8443/compose')).toBe('mail.example:8443')
    expect(hostOf('not a url')).toBe('')
  })

  it('falls back to the whole address when there is no host to name', () => {
    const window = new WindowHarness([
      fakeTab('file', 'file:///home/me/notes.html', { objects: true })
    ])

    window.contract.closeTab('file')
    window.tab('file').contents.answer()

    expect(window.prompts).toEqual([{ mode: 'close', site: 'file:///home/me/notes.html' }])
  })

  it('cuts a long address without a host in the middle, keeping its start and its end', () => {
    const long = `file:///home/me/${'deep/'.repeat(40)}notes.html?${'q=1&'.repeat(40)}end`
    const site = siteOf(long)

    expect(site).toHaveLength(SITE_MAX)
    expect(site.startsWith('file:///home/me/deep/')).toBe(true)
    expect(site.endsWith(long.slice(-24))).toBe(true)
    expect(site).toContain('…')
    // At the limit nothing is cut, and a host is never cut however long its address is.
    expect(siteOf('file:///'.padEnd(SITE_MAX, 'x'))).toBe('file:///'.padEnd(SITE_MAX, 'x'))
    expect(siteOf(`https://mail.example/?${'q=1&'.repeat(100)}`)).toBe('mail.example')
  })

  it('names the cut address in the question a closing tab puts', () => {
    const long = `file:///home/me/notes.html?${'q=1&'.repeat(100)}`
    const window = new WindowHarness([fakeTab('file', long, { objects: true })])

    window.contract.closeTab('file')
    window.tab('file').contents.answer()

    expect(window.prompts).toEqual([{ mode: 'close', site: siteOf(long) }])
  })
})

describe('preventDefaultOf', () => {
  it('cancels an event that can be cancelled and ignores anything else', () => {
    const event = { preventDefault: vi.fn() }
    preventDefaultOf(event)
    preventDefaultOf(null)
    preventDefaultOf('close')
    preventDefaultOf({})
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
  })
})

describe('the dialog', () => {
  it('says which site asks, offers leave and stay, and makes stay the safe default', () => {
    const options = unloadDialog({ mode: 'close', site: 'mail.example' }, 'en')
    expect(options).toMatchObject({
      type: 'question',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'Close this tab?',
      detail: 'Changes you made on mail.example may not be saved.'
    })
    expect(unloadDialog({ mode: 'navigate', site: 'mail.example' }, 'de')).toMatchObject({
      buttons: ['Verlassen', 'Bleiben'],
      message: 'Seite verlassen?',
      detail: 'Änderungen auf mail.example werden möglicherweise nicht gespeichert.'
    })
  })

  it('stays short enough for its buttons when the page has no host to name', () => {
    const site = siteOf(`data:text/html,${'<p>x</p>'.repeat(500)}`)
    const { detail } = unloadDialog({ mode: 'navigate', site }, 'en')

    expect(detail).toBe(`Changes you made on ${site} may not be saved.`)
    expect(detail?.length).toBeLessThan(SITE_MAX + 50)
  })

  it('is modal to the window and answers leave only for the first button', () => {
    // Only its identity is read: the dialog must be handed this window and no other.
    const window = new EventEmitter() as unknown as BaseWindow
    electron.dialog.showMessageBoxSync.mockReturnValueOnce(0).mockReturnValueOnce(1)

    expect(askToLeave(window, { mode: 'close', site: 'a.example' }, 'en')).toBe(true)
    expect(askToLeave(window, { mode: 'navigate', site: 'a.example' }, 'system')).toBe(false)

    const calls = electron.dialog.showMessageBoxSync.mock.calls
    expect(calls[0]?.[0]).toBe(window)
    // `system` is the desktop's language, which the fake app reports as German.
    expect(calls[1]?.[1]).toMatchObject({ message: 'Seite verlassen?' })
  })
})
