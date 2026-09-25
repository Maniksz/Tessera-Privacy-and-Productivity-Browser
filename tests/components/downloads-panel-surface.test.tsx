import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DownloadsPanelSurface } from '@renderer/surfaces/DownloadsPanelSurface.js'
import { OverlaySurface } from '@renderer/surfaces/OverlaySurface.js'
import type { DownloadEntry } from '@shared/downloads/model.js'
import { DEFAULT_LOCALE, catalogs, interpolate } from '@shared/i18n/catalog.js'
import type { DownloadsPanelPresentation, OverlayPresentation } from '@shared/overlay/surface.js'
import { internalUrl } from '@shared/product.js'

/**
 * The toolbar's downloads panel, drawn on the overlay layer.
 *
 * What is pinned here is what the panel adds to rows the core already chose: the newest few in the
 * core's order, each with the actions its state allows and the page's own words for them (R5, R6); the
 * way to the full page (R7); and a keyboard that stays where the user put it while the core re-presents
 * the panel four times a second (R8, KTD8). The rows themselves are never this component's to pick —
 * which list, how many, and when an update is sent are decided in the core and tested there
 * (`tests/overlay-surface.test.ts`, `tests/download-ipc.test.ts`).
 *
 * The bridge is replaced rather than mocked at module level, for the find bar's reason: `bridge.ts`
 * reads `window.tessera` on every call, which is the seam a sandboxed renderer actually has.
 */

interface Call {
  channel: string
  payload: unknown
}

/** What the core answers, per channel, unless a test says otherwise. */
interface Answers {
  opened?: boolean
  revealed?: boolean
  resumed?: boolean
  /** Holds `downloads:open` unanswered until the test calls `answerOpen`, for what happens meanwhile. */
  holdOpen?: boolean
}

function installBridge(answers: Answers = {}): {
  calls: Call[]
  present: (next: OverlayPresentation | null) => void
  answerOpen: (opened: boolean) => void
} {
  const calls: Call[] = []
  let answerOpen: ((opened: boolean) => void) | null = null
  let deliver: ((payload: { presentation: OverlayPresentation | null }) => void) | null = null
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      if (channel === 'window:getState') return Promise.resolve({ platform: 'linux' })
      if (channel === 'settings:getAll') return Promise.resolve({ 'advanced.customShortcuts': {} })
      if (channel === 'downloads:open' && answers.holdOpen === true) {
        return new Promise((resolve) => {
          answerOpen = (opened) => resolve({ opened })
        })
      }
      if (channel === 'downloads:open') return Promise.resolve({ opened: answers.opened ?? true })
      if (channel === 'downloads:reveal')
        return Promise.resolve({ revealed: answers.revealed ?? true })
      if (channel === 'downloads:resume')
        return Promise.resolve({ changed: answers.resumed ?? true })
      if (channel === 'downloads:remove') return Promise.resolve({ removed: true })
      if (channel.startsWith('downloads:')) return Promise.resolve({ changed: true })
      if (channel === 'tabs:create') return Promise.resolve({ tabId: 't9' })
      return Promise.resolve({ ok: true })
    },
    on: (channel: string, listener: (payload: never) => void): (() => void) => {
      if (channel === 'overlay:presented') {
        deliver = listener as (payload: { presentation: OverlayPresentation | null }) => void
      }
      return () => {}
    },
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
  return {
    calls,
    present: (next) => {
      if (deliver === null) throw new Error('the layer never subscribed')
      deliver({ presentation: next })
    },
    answerOpen: (opened) => {
      if (answerOpen === null) throw new Error('nothing asked to open a file')
      answerOpen(opened)
    }
  }
}

const messages = catalogs[DEFAULT_LOCALE] as Record<string, string>

/** The component's own lookup, so what is pinned is the key and its parameters rather than a wording. */
function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(messages[key] ?? key, params)
}

const T0 = 1_700_000_000_000

function download(id: string, overrides: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    id,
    url: `https://files.example/${id}`,
    fileName: `${id}.zip`,
    savePath: `/downloads/${id}.zip`,
    mimeType: 'application/zip',
    totalBytes: 5_000_000,
    receivedBytes: 1_200_000,
    state: 'progressing',
    startedAt: T0,
    endedAt: null,
    interruptReason: '',
    onDisk: false,
    canPause: true,
    ...overrides
  }
}

const ANCHOR = { x: 1300, y: 44, width: 32, height: 28 }

function panel(downloads: DownloadEntry[]): DownloadsPanelPresentation {
  return { kind: 'downloads-panel', anchor: ANCHOR, downloads }
}

function renderPanel(downloads: DownloadEntry[], answers: Answers = {}) {
  const bridge = installBridge(answers)
  const view = render(<DownloadsPanelSurface presentation={panel(downloads)} />)
  return {
    ...bridge,
    /** The core re-presenting the panel with fresh rows: same surface, new props. */
    update: (next: DownloadEntry[]): void => {
      view.rerender(<DownloadsPanelSurface presentation={panel(next)} />)
    },
    /** The layer taking the panel down: Escape, a click outside, the window losing focus. */
    unmount: view.unmount
  }
}

const theRow = (fileName: string): HTMLElement => {
  const name = screen.getByText(fileName)
  const row = name.closest<HTMLElement>('[data-download-id]')
  if (row === null) throw new Error(`no row for ${fileName}`)
  return row
}

/** The accessible names of a row's buttons, in the order they are drawn. */
const actionsOf = (fileName: string): string[] =>
  within(theRow(fileName))
    .queryAllByRole('button')
    .map((button) => button.getAttribute('aria-label') ?? '')

afterEach(cleanup)

describe('what the panel lists', () => {
  it('shows the rows it was given in their order, each with its name, size and state (R5)', () => {
    renderPanel([
      download('newest'),
      download('done', { state: 'completed', receivedBytes: 5_000_000, onDisk: true }),
      download('failed', { state: 'interrupted' })
    ])

    const names = [...document.querySelectorAll('[data-download-id]')].map(
      (row) => row.getAttribute('data-download-id') ?? ''
    )
    expect(names).toEqual(['newest', 'done', 'failed'])

    // A running row: its state and how far it has got, in the page's own words.
    const running = theRow('newest.zip')
    expect(running.textContent).toContain(t('downloads.state.progressing'))
    expect(running.textContent).toContain(
      t('downloads.progress', {
        received: t('downloads.byteSize', { value: '1.2', unit: 'MB' }),
        total: t('downloads.byteSize', { value: '5', unit: 'MB' })
      })
    )
    expect(running.querySelector('progress')?.getAttribute('value')).toBe('0.24')

    // A finished row: its size, and no bar.
    const done = theRow('done.zip')
    expect(done.textContent).toContain(t('downloads.state.completed'))
    expect(done.textContent).toContain(t('downloads.byteSize', { value: '5', unit: 'MB' }))
    expect(done.querySelector('progress')).toBeNull()

    expect(theRow('failed.zip').textContent).toContain(t('downloads.state.interrupted'))
  })

  it('never shows more than six, even if handed more', () => {
    renderPanel(Array.from({ length: 8 }, (_, index) => download(`d${String(index)}`)))
    expect(document.querySelectorAll('[data-download-id]')).toHaveLength(6)
  })

  it('draws a size nobody declared as activity, not as nought', () => {
    renderPanel([download('stream', { totalBytes: 0, receivedBytes: 300_000 })])
    const row = theRow('stream.zip')
    expect(row.querySelector('progress')?.hasAttribute('value')).toBe(false)
    expect(row.textContent).toContain(
      t('downloads.progressUnknown', {
        received: t('downloads.byteSize', { value: '300', unit: 'kB' })
      })
    )
  })

  it('says so when the list is empty, and still offers the page', () => {
    renderPanel([])
    expect(screen.getByText(t('downloads.empty'))).toBeTruthy()
    expect(screen.getByRole('button', { name: t('menu.tools.downloads') })).toBeTruthy()
  })

  it('is a dialogue named for what it lists', () => {
    renderPanel([download('a')])
    expect(screen.getByRole('dialog', { name: t('downloads.title') })).toBeTruthy()
  })
})

describe('what each row offers (R6)', () => {
  const name = (key: string, fileName: string): string => t(key, { name: fileName })

  it('offers pause, cancel and remove while a download runs', () => {
    renderPanel([download('run')])
    expect(actionsOf('run.zip')).toEqual([
      name('downloads.pause', 'run.zip'),
      name('downloads.cancel', 'run.zip'),
      name('downloads.remove', 'run.zip')
    ])
  })

  it('offers resume, cancel and remove once it is paused', () => {
    renderPanel([download('held', { state: 'paused' })])
    expect(actionsOf('held.zip')).toEqual([
      name('downloads.resume', 'held.zip'),
      name('downloads.cancel', 'held.zip'),
      name('downloads.remove', 'held.zip')
    ])
  })

  it('leaves pause and resume out for a transfer that cannot pause', () => {
    renderPanel([
      download('media', { canPause: false }),
      download('stuck', { state: 'paused', canPause: false })
    ])
    expect(actionsOf('media.zip')).toEqual([
      name('downloads.cancel', 'media.zip'),
      name('downloads.remove', 'media.zip')
    ])
    expect(actionsOf('stuck.zip')).toEqual([
      name('downloads.cancel', 'stuck.zip'),
      name('downloads.remove', 'stuck.zip')
    ])
  })

  it('offers open and show-in-folder for a finished file that is there', () => {
    renderPanel([download('done', { state: 'completed', onDisk: true })])
    expect(actionsOf('done.zip')).toEqual([
      name('downloads.open', 'done.zip'),
      name('downloads.reveal', 'done.zip'),
      name('downloads.remove', 'done.zip')
    ])
  })

  it('offers only remove for a failed one, a cancelled one and a finished one whose file is gone', () => {
    renderPanel([
      download('failed', { state: 'interrupted' }),
      download('stopped', { state: 'cancelled' }),
      download('gone', { state: 'completed', onDisk: false })
    ])
    expect(actionsOf('failed.zip')).toEqual([name('downloads.remove', 'failed.zip')])
    expect(actionsOf('stopped.zip')).toEqual([name('downloads.remove', 'stopped.zip')])
    expect(actionsOf('gone.zip')).toEqual([name('downloads.remove', 'gone.zip')])
    expect(theRow('gone.zip').textContent).toContain(t('downloads.fileMissing'))
  })

  it('acts on the download by its id, over the channels the page uses', async () => {
    const { calls } = renderPanel([
      download('run'),
      download('held', { state: 'paused' }),
      download('done', { state: 'completed', onDisk: true })
    ])
    const click = (label: string): void => {
      fireEvent.click(screen.getByRole('button', { name: label }))
    }
    click(name('downloads.pause', 'run.zip'))
    click(name('downloads.cancel', 'run.zip'))
    click(name('downloads.resume', 'held.zip'))
    click(name('downloads.remove', 'held.zip'))
    click(name('downloads.open', 'done.zip'))
    click(name('downloads.reveal', 'done.zip'))
    await act(async () => {})

    expect(calls.filter(({ channel }) => channel.startsWith('downloads:'))).toEqual([
      { channel: 'downloads:pause', payload: { id: 'run' } },
      { channel: 'downloads:cancel', payload: { id: 'run' } },
      { channel: 'downloads:resume', payload: { id: 'held' } },
      { channel: 'downloads:remove', payload: { id: 'held' } },
      { channel: 'downloads:open', payload: { id: 'done' } },
      { channel: 'downloads:reveal', payload: { id: 'done' } }
    ])
  })

  it('says a file is gone when opening it finds nothing, and asks the core for fresh rows', async () => {
    const { calls } = renderPanel([download('done', { state: 'completed', onDisk: true })], {
      opened: false
    })
    fireEvent.click(screen.getByRole('button', { name: name('downloads.open', 'done.zip') }))

    expect(await screen.findByText(t('downloads.openFailed'))).toBeTruthy()
    /*
      The rows are the core's, so the panel does not patch its own: it asks for itself again, by kind and
      anchor, and the core answers with the list freshly probed — the row then offers nothing to open.
    */
    expect(calls.at(-1)).toEqual({
      channel: 'overlay:present',
      payload: { kind: 'downloads-panel', anchor: ANCHOR }
    })
  })

  it('does not ask for itself again when it was closed while an open was still being answered', async () => {
    const { calls, answerOpen, unmount } = renderPanel(
      [download('done', { state: 'completed', onDisk: true })],
      { holdOpen: true }
    )
    fireEvent.click(screen.getByRole('button', { name: name('downloads.open', 'done.zip') }))
    unmount()

    answerOpen(false)
    await act(async () => {})

    /*
      Asking for fresh rows is presenting the panel: after a dismissal that would put back, and give the
      keyboard to, the panel the user has just closed.
    */
    expect(calls.filter(({ channel }) => channel === 'overlay:present')).toEqual([])
  })

  it('says when a paused download cannot be resumed, as the page does', async () => {
    renderPanel([download('held', { state: 'paused' })], { resumed: false })
    fireEvent.click(screen.getByRole('button', { name: name('downloads.resume', 'held.zip') }))
    expect(await screen.findByText(t('downloads.cannotResume'))).toBeTruthy()
  })

  it('keeps its notice across the next re-presentation', async () => {
    const { update } = renderPanel([download('done', { state: 'completed', onDisk: true })], {
      opened: false
    })
    fireEvent.click(screen.getByRole('button', { name: name('downloads.open', 'done.zip') }))
    await screen.findByText(t('downloads.openFailed'))
    update([download('done', { state: 'completed', onDisk: false })])
    expect(screen.getByText(t('downloads.openFailed'))).toBeTruthy()
  })

  it('opens the downloads page the way the menu does, and closes itself (R7, KTD9)', async () => {
    const { calls } = renderPanel([download('a')])
    fireEvent.click(screen.getByRole('button', { name: t('menu.tools.downloads') }))
    await act(async () => {})
    expect(calls).toEqual([
      { channel: 'overlay:dismiss', payload: undefined },
      { channel: 'tabs:create', payload: { url: internalUrl('downloads') } }
    ])
  })
})

describe('where the keyboard is (R8, KTD8)', () => {
  it('starts on the newest row', () => {
    renderPanel([download('newest'), download('older')])
    expect(document.activeElement).toBe(theRow('newest.zip'))
  })

  it('starts on the way to the page when there is no row', () => {
    renderPanel([])
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: t('menu.tools.downloads') })
    )
  })

  it('stays on the same download when a new one arrives above it', () => {
    const { update } = renderPanel([download('b'), download('a')])
    const second = theRow('a.zip')
    second.focus()

    update([download('c'), download('b'), download('a', { receivedBytes: 2_000_000 })])

    expect(document.activeElement).toBe(theRow('a.zip'))
    expect(document.activeElement?.getAttribute('data-download-id')).toBe('a')
  })

  it('stays on the same button while the download it belongs to advances', () => {
    const { update } = renderPanel([download('a')])
    const cancel = screen.getByRole('button', { name: t('downloads.cancel', { name: 'a.zip' }) })
    cancel.focus()
    update([download('a', { receivedBytes: 3_000_000 })])
    expect(document.activeElement).toBe(cancel)
  })

  it('moves to the row when the focused cancel button goes because the download ended', () => {
    const { update } = renderPanel([download('b'), download('a')])
    screen.getByRole('button', { name: t('downloads.cancel', { name: 'a.zip' }) }).focus()

    update([download('b'), download('a', { state: 'completed', onDisk: true, endedAt: T0 + 5 })])

    expect(document.activeElement).toBe(theRow('a.zip'))
  })

  it('moves to a neighbour when the focused row itself goes', () => {
    const { update } = renderPanel([download('c'), download('b'), download('a')])
    theRow('b.zip').focus()
    update([download('c'), download('a')])
    expect(document.activeElement).toBe(theRow('a.zip'))
  })

  it('moves to the row now in the last place when the focused last row is pushed off the end', () => {
    const six = ['f', 'e', 'd', 'c', 'b', 'a'].map((id) => download(id))
    const { update } = renderPanel(six)
    theRow('a.zip').focus()

    // A seventh arrives on top; the panel draws six, so the oldest — the focused one — is no longer drawn.
    update([download('g'), ...six])

    expect(screen.queryByText('a.zip')).toBeNull()
    expect(document.activeElement).toBe(theRow('b.zip'))
  })

  it('wraps from the last element to the first on Tab, and back on Shift+Tab', () => {
    renderPanel([download('b'), download('a')])
    const all = screen.getByRole('button', { name: t('menu.tools.downloads') })
    all.focus()
    fireEvent.keyDown(all, { key: 'Tab' })
    expect(document.activeElement).toBe(theRow('b.zip'))
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(all)
  })

  it('walks the rows with the arrow keys', () => {
    renderPanel([download('b'), download('a')])
    fireEvent.keyDown(theRow('b.zip'), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(theRow('a.zip'))
    fireEvent.keyDown(theRow('a.zip'), { key: 'ArrowUp' })
    expect(document.activeElement).toBe(theRow('b.zip'))
  })
})

describe('how tall it is', () => {
  /*
    jsdom lays nothing out, so the panel's box is modelled here: as tall as its rows and its notice need,
    unless an inline max-height holds it shorter — as a browser would draw it, with the rest scrolled.
  */
  const ROW_HEIGHT = 50
  const NOTICE_HEIGHT = 30
  const CHROME_HEIGHT = 40

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ) {
      if (!this.classList.contains('downloads-panel')) return new DOMRect()
      const natural =
        CHROME_HEIGHT +
        this.querySelectorAll('[data-download-id]').length * ROW_HEIGHT +
        (this.querySelector('.downloads-panel__notice') === null ? 0 : NOTICE_HEIGHT)
      const cap = Number.parseFloat(this.style.maxHeight)
      return new DOMRect(0, 0, 340, Number.isNaN(cap) ? natural : Math.min(natural, cap))
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const heightOf = (): number => {
    const dialog = screen.getByRole('dialog', { name: t('downloads.title') })
    return Number.parseFloat(dialog.style.maxHeight)
  }

  it('grows when a download arrives while it is open', () => {
    const { update } = renderPanel([download('a')])
    expect(heightOf()).toBe(CHROME_HEIGHT + ROW_HEIGHT)

    update([download('c'), download('b'), download('a')])

    expect(heightOf()).toBe(CHROME_HEIGHT + 3 * ROW_HEIGHT)
  })

  it('grows when a notice appears', async () => {
    renderPanel([download('done', { state: 'completed', onDisk: true })], { opened: false })
    expect(heightOf()).toBe(CHROME_HEIGHT + ROW_HEIGHT)

    fireEvent.click(screen.getByRole('button', { name: t('downloads.open', { name: 'done.zip' }) }))
    await screen.findByText(t('downloads.openFailed'))

    expect(heightOf()).toBe(CHROME_HEIGHT + ROW_HEIGHT + NOTICE_HEIGHT)
  })

  it('still shrinks when rows go', () => {
    const { update } = renderPanel([download('c'), download('b'), download('a')])
    update([download('a')])
    expect(heightOf()).toBe(CHROME_HEIGHT + ROW_HEIGHT)
  })
})

describe('the panel on the layer', () => {
  it('is fetched the first time it is presented, then closes on Escape', async () => {
    const { calls, present } = installBridge()
    render(<OverlaySurface />)
    void act(() => present(panel([download('a')])))

    expect(await screen.findByRole('dialog', { name: t('downloads.title') })).toBeTruthy()
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(calls.filter(({ channel }) => channel === 'overlay:dismiss')).toHaveLength(1)
  })

  it('closes on a click outside it, and not on a click inside it', async () => {
    const { calls, present } = installBridge()
    const { container } = render(<OverlaySurface />)
    void act(() => present(panel([download('a')])))
    const dialog = await screen.findByRole('dialog', { name: t('downloads.title') })

    fireEvent.pointerDown(dialog)
    expect(calls.filter(({ channel }) => channel === 'overlay:dismiss')).toHaveLength(0)
    const outside = container.querySelector('.surface')
    if (outside === null) throw new Error('the layer has no outside to click')
    fireEvent.pointerDown(outside)
    expect(calls.filter(({ channel }) => channel === 'overlay:dismiss')).toHaveLength(1)
  })

  it('keeps the master-password prompt working behind the same boundary', async () => {
    const { present } = installBridge()
    render(<OverlaySurface />)
    void act(() =>
      present({
        kind: 'master-password',
        requestId: 'p1',
        purpose: 'unlock',
        step: 'current',
        filled: 3,
        problem: null,
        minLength: 8
      })
    )
    await waitFor(() => expect(screen.getByText(t('passwords.lockedTitle'))).toBeTruthy())
  })
})

describe('the source', () => {
  it('carries no text literal and no literal accessible name', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/renderer/src/surfaces/DownloadsPanelSurface.tsx'),
      'utf8'
    )
    expect(source).not.toMatch(/aria-label=\{?"/)
    // Text between tags on one line that is not an expression — past an arrow, which is a type, not a tag.
    expect(source).not.toMatch(/(?<!=)>[ \t]*[A-Za-z][^<>{}\n]*</)
  })
})
