import { EventEmitter } from 'node:events'
import { expect } from 'vitest'
import { Given, Then, When } from 'quickpickle'
import type { CloseContract, UnloadPrompt } from '@main/browser/unload-guard.js'
import { scope } from './world.js'

/**
 * Steps for `closing.feature`.
 *
 * The real `CloseContract` over pages made of an `EventEmitter`. `BrowserWindowController` cannot be here — it
 * needs a browser process — but everything it decides about closing is the contract's, and what it does once a
 * tab has gone is the closed-tab stack and the tab leaving the strip, which the window below keeps the same way.
 *
 * A page answers the core only when a step lets it (`answerAll`), because the order is the point: a close is a
 * request to the page, and nothing may be finished on the page's behalf before it has answered.
 *
 * The module is imported when a scenario needs it rather than at the top. This file is a setup file for the whole
 * unit project, and `unload-guard.ts` imports Electron: loaded here, it would be in every test file's module graph
 * before that file's own `vi.mock('electron')` — and `tests/unload-guard.test.ts` would test the unmocked copy.
 */

/** One page, as Chromium runs it: `beforeunload` first, and only then the close or the navigation. */
class Page extends EventEmitter {
  url: string
  asks = false
  gone = false
  #queue: Array<() => void> = []

  constructor(url: string) {
    super()
    this.url = url
  }

  isDestroyed(): boolean {
    return this.gone
  }

  getURL(): string {
    return this.url
  }

  close(options?: { waitForBeforeUnload: boolean }): void {
    if (options?.waitForBeforeUnload !== true) {
      this.#destroy()
      return
    }
    this.#queue.push(() => this.#beforeUnload(() => this.#destroy()))
  }

  follow(target: string): void {
    this.#queue.push(() =>
      this.#beforeUnload(() => {
        this.url = target
      })
    )
  }

  answer(): boolean {
    const queue = this.#queue
    this.#queue = []
    for (const run of queue) run()
    return queue.length > 0
  }

  #beforeUnload(proceed: () => void): void {
    if (!this.asks) {
      proceed()
      return
    }
    let allowed = false
    this.emit('will-prevent-unload', { preventDefault: () => (allowed = true) })
    if (allowed) proceed()
  }

  #destroy(): void {
    if (this.gone) return
    this.gone = true
    this.emit('destroyed')
  }
}

interface ClosingWindow {
  pages: Map<string, Page>
  order: string[]
  closedStack: string[]
  prompts: UnloadPrompt[]
  answers: string[]
  active: string | null
  closed: boolean
  quit: EventEmitter
  contract: CloseContract
  requestClose(): void
}

/** Kept in `scratch`: the shape is this file's alone, as `tab-groups.steps.ts` argues for its own. */
const KEY = 'closingWindow'

function closingWindow(state: unknown): ClosingWindow {
  const held = scope(state).scratch[KEY]
  if (held === undefined) throw new Error('this scenario has no window; add a Given for it')
  return held as ClosingWindow
}

function nameList(list: string): string[] {
  return list
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
}

/** Lets every page answer what it was asked, until none has anything left to answer. */
function answerAll(window: ClosingWindow): void {
  for (;;) {
    const answered = [...window.pages.values()].map((page) => page.answer())
    if (!answered.includes(true)) return
  }
}

Given('a window whose tabs are {string}', async (state: unknown, list: string) => {
  const { CloseContract, ShutdownSilence } = await import('@main/browser/unload-guard.js')
  const quit = new EventEmitter()
  const closeHandlers: Array<(...args: unknown[]) => void> = []
  const window: ClosingWindow = {
    pages: new Map(),
    order: nameList(list),
    closedStack: [],
    prompts: [],
    answers: [],
    active: null,
    closed: false,
    quit,
    contract: undefined as unknown as CloseContract,
    requestClose: () => {
      let prevented = false
      for (const handler of closeHandlers) handler({ preventDefault: () => (prevented = true) })
      if (prevented) return
      // `closed`: every page silently, and nothing finished one by one.
      window.closed = true
      window.contract.dispose()
      for (const page of window.pages.values()) page.close()
    }
  }
  for (const name of window.order) window.pages.set(name, new Page(`https://${name}.example/`))

  window.contract = new CloseContract({
    on: (_event, handler) => closeHandlers.push(handler),
    tab: (tabId) => {
      const page = window.pages.get(tabId)
      if (page === undefined || !window.order.includes(tabId)) return undefined
      return {
        ephemeral: false,
        view: { webContents: page },
        toState: () => ({ url: page.gone ? '' : page.url, unloaded: false })
      }
    },
    groups: { displayOrder: () => window.order, groups: () => [], setCollapsed: () => undefined },
    activateTab: (tabId) => {
      window.active = tabId
    },
    confirm: (prompt) => {
      window.prompts.push(prompt)
      return (window.answers.shift() ?? 'Stay') === 'Leave'
    },
    finish: (tabId, closed) => {
      if (closed.url !== '') window.closedStack.push(tabId)
      window.order = window.order.filter((id) => id !== tabId)
    },
    closeWindow: () => window.requestClose(),
    shutdown: new ShutdownSilence({ app: quit, updater: new EventEmitter() })
  })
  for (const name of window.order) window.contract.track(name)
  scope(state).scratch[KEY] = window
})

Given('the page in {string} asks before it is left', (state: unknown, name: string) => {
  const page = closingWindow(state).pages.get(name)
  if (page === undefined) throw new Error(`no tab ${name}`)
  page.asks = true
})

When(
  'I close the tab {string} and answer {string}',
  (state: unknown, name: string, answer: string) => {
    const window = closingWindow(state)
    window.answers = [answer]
    window.contract.closeTab(name)
    answerAll(window)
  }
)

When('I close that window and answer {string}', (state: unknown, answers: string) => {
  const window = closingWindow(state)
  window.answers = nameList(answers)
  window.requestClose()
  answerAll(window)
})

When(
  'I follow a link in {string} to {string} and answer {string}',
  (state: unknown, name: string, target: string, answer: string) => {
    const window = closingWindow(state)
    window.answers = [answer]
    window.pages.get(name)?.follow(target)
    answerAll(window)
  }
)

When('the browser quits', (state: unknown) => {
  const window = closingWindow(state)
  // `before-quit`, which seals the session and silences every question, then Electron closing the window.
  window.quit.emit('before-quit')
  window.requestClose()
  answerAll(window)
})

Then('the question named {string}', (state: unknown, site: string) => {
  expect(closingWindow(state).prompts.map((prompt) => prompt.site)).toEqual([site])
})

Then('no question was asked', (state: unknown) => {
  expect(closingWindow(state).prompts).toEqual([])
})

Then('exactly one question was asked', (state: unknown) => {
  expect(closingWindow(state).prompts).toHaveLength(1)
})

Then('the tab {string} is still open', (state: unknown, name: string) => {
  const window = closingWindow(state)
  expect(window.order).toContain(name)
  expect(window.pages.get(name)?.gone).toBe(false)
})

Then('the tab {string} is gone', (state: unknown, name: string) => {
  expect(closingWindow(state).order).not.toContain(name)
})

Then('the tab {string} is in front', (state: unknown, name: string) => {
  expect(closingWindow(state).active).toBe(name)
})

Then('the recently closed tabs are {string}', (state: unknown, list: string) => {
  expect(closingWindow(state).closedStack).toEqual(nameList(list))
})

Then('the window is still open', (state: unknown) => {
  expect(closingWindow(state).closed).toBe(false)
})

Then('the window has closed', (state: unknown) => {
  expect(closingWindow(state).closed).toBe(true)
})

Then('{string} shows {string}', (state: unknown, name: string, url: string) => {
  expect(closingWindow(state).pages.get(name)?.url).toBe(url)
})
