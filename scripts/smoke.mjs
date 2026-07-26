/**
 * Repeatable smoke test against the built application.
 *
 * Launches tessera, then drives it over the DevTools protocol and asserts
 * that the UI/core boundary actually carried data — not merely that the process
 * started. Spec 7 asks for end-to-end coverage of the split layout; this is the
 * seed of that harness and the check to run before trusting a build.
 *
 *   node scripts/smoke.mjs
 *
 * Exits non-zero on the first failed assertion.
 */

import { spawn } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = 9333
const PROFILE = join(tmpdir(), 'tessera-smoke-profile')
const failures = []

/**
 * Counts the declared invoke channels by reading the source of truth.
 *
 * An earlier version hard-coded the number, which meant adding a feature broke the
 * smoke test for no reason — a check that has to be edited whenever the code grows
 * teaches people to edit it without thinking.
 */
async function declaredInvokeChannelCount() {
  const source = await readFile('src/shared/ipc/channels.ts', 'utf8')
  const block = /export const INVOKE_CHANNELS = \[([\s\S]*?)\] as const/.exec(source)
  if (!block) throw new Error('could not find INVOKE_CHANNELS in channels.ts')
  // Comments first: an apostrophe in prose ("the window's topmost layer") pairs with the
  // next channel name's opening quote and eats it, so the count silently comes out short.
  const code = block[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
  return (code.match(/'[^']+'/g) ?? []).length
}

/** Reads the layout list from the one place that defines it. */
async function declaredLayoutCount() {
  const source = await readFile('src/shared/split/layout.ts', 'utf8')
  const block = /export const LAYOUT_IDS = \[([\s\S]*?)\] as const/.exec(source)
  if (!block) throw new Error('could not find LAYOUT_IDS in layout.ts')
  const code = block[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
  return (code.match(/'[^']+'/g) ?? []).length
}

function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label} -> ${JSON.stringify(actual)}`)
  if (!ok) failures.push(label)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

await rm(PROFILE, { recursive: true, force: true })

const env = { ...process.env }
// An editor-hosted shell may export this, which makes the Electron binary run as
// plain Node and never start a browser process.
delete env.ELECTRON_RUN_AS_NODE

const electron = process.platform === 'win32' ? 'node_modules/.bin/electron.cmd' : 'node_modules/.bin/electron'
const child = spawn(
  electron,
  ['out/main/index.js', `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`],
  { env, stdio: ['ignore', 'pipe', 'pipe'] }
)

let mainLog = ''
child.stdout.on('data', (chunk) => (mainLog += chunk))
child.stderr.on('data', (chunk) => (mainLog += chunk))

/** Waits for the debugging endpoint rather than guessing at a fixed delay. */
async function waitForTargets(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/json`)
      const targets = await response.json()
      if (targets.some((t) => t.url.includes('renderer/index.html'))) return targets
    } catch {
      // Not listening yet.
    }
    await sleep(400)
  }
  throw new Error('tessera did not expose a chrome UI target in time')
}

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let id = 0
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message)
      pending.delete(message.id)
    }
  })
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const send = (method, params) =>
    new Promise((resolve) => {
      const messageId = ++id
      pending.set(messageId, resolve)
      ws.send(JSON.stringify({ id: messageId, method, params }))
    })
  return { ws, ready, send }
}

/**
 * Elements in the chrome DOM that may legitimately extend past the chrome inset.
 *
 * Everything else down there is unreachable, so the list is deliberately short and each
 * entry names the mechanism that makes it an exception. Adding a third one should require
 * explaining which mechanism keeps it clickable.
 *
 *  - `.overlay`  — full-window panels; the core suspends the content views while one is
 *                  open (`window:setOverlay`), so nothing is covering them.
 *  - `.divider`  — split-view resize handles; tiles are laid out with a gutter between
 *                  them precisely so these stay exposed.
 */
const REACHABILITY_EXCEPTIONS = '.overlay, .divider'

/**
 * Interactive chrome elements that no user could click.
 *
 * The chrome renderer is the window's *bottom* layer: tab content is drawn by native views
 * stacked on top of it, and a native view is opaque to hit testing as well as to the eye.
 * So anything interactive that sticks out below the chrome inset is invisible and inert —
 * which is exactly how a 190-pixel layout dropdown shipped looking fine in a DOM snapshot.
 *
 * A programmatic `.click()` fires regardless of what is painted above the element, which is
 * why every earlier assertion in this file passed while the menu was unusable. This check
 * asks the question those could not: is it *reachable*?
 */
const REACHABILITY = `(() => {
  const chrome = document.querySelector('.chrome')?.getBoundingClientRect()
  if (chrome === undefined) return ['no .chrome element']
  const selector = 'button, input, select, textarea, a[href], [role="menuitem"], [role="menuitemradio"], [tabindex]:not([tabindex="-1"])'
  return [...document.querySelectorAll(selector)]
    .filter((element) => {
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) return false
      if (element.closest(${JSON.stringify(REACHABILITY_EXCEPTIONS)}) !== null) return false
      return box.bottom > chrome.bottom + 0.5
    })
    .map((element) => (element.className || element.tagName) + ' extends to y=' + Math.round(element.getBoundingClientRect().bottom))
})()`

const PROBE = `JSON.stringify({
  bridgePresent: typeof window.tessera === 'object',
  invokeChannels: window.tessera?.channels?.invoke?.length ?? -1,
  tabsRendered: document.querySelectorAll('.tab').length,
  omniboxValue: document.querySelector('.omnibox__input')?.value ?? null,
  layoutButton: document.querySelectorAll('.iconbutton[aria-haspopup="menu"]').length,
  layoutMenuExpanded: document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').length,
  /* A menu rendered in this DOM would sit under the page; menus belong to the overlay layer. */
  menusInChrome: document.querySelectorAll('.menu').length,
  chromeHeight: Math.round(document.querySelector('.chrome')?.getBoundingClientRect().height ?? -1),
  dividerCount: document.querySelectorAll('.divider').length,
  unreachable: ${REACHABILITY}
})`

/**
 * The layout menu, end to end across two renderers.
 *
 * This is the check that the previous round of assertions could not make. A toolbar dropdown
 * drawn in the chrome DOM looked correct in every DOM query and was completely unusable,
 * because the native tab views are stacked above that DOM. So the menu now lives on the
 * overlay layer, and the assertions follow it there: the menu must exist in the *overlay*
 * target, be positioned inside that layer, and a click on one of its items must actually
 * change the split layout in the core.
 *
 * @param chromeEvaluate evaluator bound to the chrome renderer
 */
async function runOverlayChecks(chromeEvaluate) {
  const anchor = JSON.parse(
    await chromeEvaluate(`(() => {
      const button = document.querySelector('.iconbutton[aria-haspopup="menu"]')
      if (button === null) return 'null'
      const box = button.getBoundingClientRect()
      button.click()
      return JSON.stringify({ x: box.x, y: box.y, width: box.width, height: box.height, bottom: box.bottom })
    })()`)
  )
  if (anchor === null) {
    check('layout menu button found', false, true)
    return
  }

  await sleep(900)

  const expanded = await chromeEvaluate(
    `document.querySelectorAll('[aria-haspopup="menu"][aria-expanded="true"]').length`
  )
  check('the button reports its menu as expanded', expanded, 1)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const overlay = targets.find((t) => t.url.includes('overlay.html'))
  if (!overlay) {
    check('overlay layer target present once a surface is presented', false, true)
    return
  }

  const { ws, ready, send } = connect(overlay.webSocketDebuggerUrl)
  await ready
  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    return result.result?.result?.value
  }

  const menu = JSON.parse(
    await evaluate(`(() => {
      const element = document.querySelector('.menu')
      if (element === null) return JSON.stringify({ present: false })
      const box = element.getBoundingClientRect()
      return JSON.stringify({
        present: true,
        items: element.querySelectorAll('[role="menuitemradio"]').length,
        checked: element.querySelectorAll('[role="menuitemradio"][aria-checked="true"]').length,
        top: Math.round(box.top),
        left: Math.round(box.left),
        right: Math.round(box.right),
        bottom: Math.round(box.bottom),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
    })()`)
  )

  check('the menu is rendered on the overlay layer', menu.present, true)
  if (menu.present !== true) {
    ws.close()
    return
  }

  // Counted from the source rather than written down, so adding a layout does not break a check
  // that has nothing to do with it — the same reasoning as the channel count above.
  check('every declared layout is offered', menu.items, await declaredLayoutCount())
  check('exactly one layout is marked current', menu.checked, 1)

  // Anchored to the button rather than parked somewhere plausible.
  check(
    'the menu opens just below its button',
    menu.top,
    (v) => v >= Math.round(anchor.bottom) && v <= Math.round(anchor.bottom) + 16
  )
  check(
    'the menu is fully inside the overlay layer',
    menu,
    (m) => m.left >= 0 && m.top >= 0 && m.right <= m.viewportWidth && m.bottom <= m.viewportHeight
  )

  // The real point: a click on a menu item has to reach the core and change the window.
  const chosen = await evaluate(
    `(() => {
      const items = [...document.querySelectorAll('[role="menuitemradio"]')]
      const target = items.find((item) => item.getAttribute('aria-checked') !== 'true')
      if (target === undefined) return 'none'
      const label = target.querySelector('.menu__label')?.textContent ?? ''
      target.click()
      return label
    })()`
  )
  check('a not-yet-active layout was clickable in the menu', chosen, (v) => v !== 'none')

  await sleep(1000)
  const dismissed = await evaluate(`document.querySelectorAll('.menu').length`)
  check('choosing a layout dismisses the menu', dismissed, 0)

  const layoutChanged = await chromeEvaluate(
    `window.tessera.invoke('window:getState').then(() => document.querySelectorAll('.divider').length)`,
    true
  )
  check('choosing a layout changed the split in the core', layoutChanged, (v) => v !== 2)

  ws.close()
}

/**
 * Dragging a tab into a tile, with synthesized mouse input.
 *
 * `Input.dispatchMouseEvent` goes through Chromium's own input pipeline, so this exercises
 * the real path: the pointer handlers in the tab strip, the threshold that separates a click
 * from a drag, the core's zone decision, and the drop reported by the overlay layer. A test
 * that called the IPC channels directly would prove the core works and say nothing about
 * whether a mouse can reach it — the mistake that let a dead dropdown ship.
 *
 * The gesture is split across two targets on purpose, because that is how it really happens:
 * the tab strip sees the press, and the overlay sees the release once the pointer is over the
 * tiles.
 */
async function runTabDragChecks(chromeEvaluate, chromeSend) {
  const mouse = (send, type, x, y) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1
    })

  // A single tile, so the drag has an edge zone to create a split with — which is how
  // someone first gets into split view.
  await chromeEvaluate(`window.tessera.invoke('split:setLayout', { layout: '1x1' })`, true)
  await chromeEvaluate(`window.tessera.invoke('tabs:create', { url: 'tessera://start' })`, true)
  await sleep(900)

  const setup = JSON.parse(
    await chromeEvaluate(`(() => {
      const tabs = [...document.querySelectorAll('[data-tab-id]')]
      const last = tabs[tabs.length - 1]
      if (last === undefined) return JSON.stringify({ ok: false })
      const box = last.getBoundingClientRect()
      return JSON.stringify({
        ok: true,
        tabId: last.getAttribute('data-tab-id'),
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2),
        tabCount: tabs.length,
        dividers: document.querySelectorAll('.divider').length
      })
    })()`)
  )

  check('a second tab exists to drag', setup.ok === true && setup.tabCount >= 2, true)
  check('single layout starts with no dividers', setup.dividers, 0)
  if (setup.ok !== true) return

  // Press, then move past the threshold — still inside the strip, so no tile is targeted yet.
  await mouse(chromeSend, 'mousePressed', setup.x, setup.y)
  await mouse(chromeSend, 'mouseMoved', setup.x + 24, setup.y)
  await sleep(700)

  const dragging = await chromeEvaluate(`document.querySelectorAll('.tab--dragging').length`)
  check('the tab strip reports a drag in progress', dragging, 1)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const overlay = targets.find((t) => t.url.includes('overlay.html'))
  if (!overlay) {
    check('overlay layer target present during a drag', false, true)
    return
  }

  const overlayConnection = connect(overlay.webSocketDebuggerUrl)
  await overlayConnection.ready
  const overlayEvaluate = async (expression, awaitPromise = false) => {
    const result = await overlayConnection.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise
    })
    return result.result?.result?.value
  }

  const zones = JSON.parse(
    await overlayEvaluate(`(() => {
      const rects = [...document.querySelectorAll('.dropzone')].map((element) => {
        const box = element.getBoundingClientRect()
        return { left: Math.round(box.left), width: Math.round(box.width) }
      })
      return JSON.stringify({
        count: rects.length,
        rects,
        status: document.querySelector('.dropzone__status')?.textContent ?? null,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      })
    })()`)
  )

  // Four splits — left, right, top, bottom — plus the plain drop in the middle.
  check('a single tile offers a zone for every split plus the tile itself', zones.count, 5)
  check('the indicator names the tab being moved', zones.status, (v) => typeof v === 'string' && v.length > 0)

  /*
    The promise the feature makes, asserted on the drawn rectangles: one preview covering the
    whole tile area, and two halves with the real gutter between them that together span it.
    Checked across all three zones rather than on whichever one is highlighted, because
    `Input.dispatchMouseEvent` cannot move the operating system's cursor — the physical pointer
    is wherever the developer left it and legitimately highlights a zone of its own.
  */
  check(
    'one preview covers the whole tile area',
    zones.rects,
    (rects) => rects.some((r) => r.left === 0 && r.width === zones.viewportWidth)
  )
  check('two previews are the halves the split will produce', zones.rects, (rects) => {
    const halves = rects
      .filter((r) => r.width > zones.viewportWidth * 0.4 && r.width < zones.viewportWidth * 0.6)
      .sort((a, b) => a.left - b.left)
    if (halves.length !== 2) return false
    const [first, second] = halves
    // Flush to both edges, with a gap between them: exactly what `computeTileRects` produces.
    return (
      first.left === 0 &&
      second.left + second.width === zones.viewportWidth &&
      second.left > first.left + first.width
    )
  })

  // Into the left edge of the tile area: the zone that turns one view into a split.
  const dropX = Math.round(zones.viewportWidth * 0.08)
  const dropY = Math.round(zones.viewportHeight / 2)
  await mouse(overlayConnection.send, 'mouseMoved', dropX, dropY)
  await sleep(500)

  const highlighted = JSON.parse(
    await overlayEvaluate(`(() => {
      const active = document.querySelector('.dropzone--active')
      const box = active === null ? null : active.getBoundingClientRect()
      return JSON.stringify({
        active: document.querySelectorAll('.dropzone--active').length,
        status: document.querySelector('.dropzone__status')?.textContent ?? null,
        left: box === null ? null : Math.round(box.left),
        width: box === null ? null : Math.round(box.width),
        viewportWidth: window.innerWidth
      })
    })()`)
  )
  check('exactly one zone highlights under the pointer', highlighted.active, 1)
  check('the indicator says where it will open', highlighted.status, (v) => typeof v === 'string' && v.length > 0)
  // Whichever side the highlight is on, it is a real half rather than an approximate marker.
  // Which side it lands on is settled deterministically by the release below.
  check(
    'the highlight is one of the halves the page can occupy',
    highlighted,
    (h) => h.width > h.viewportWidth * 0.4 && h.width < h.viewportWidth * 0.6
  )

  await mouse(overlayConnection.send, 'mouseReleased', dropX, dropY)
  await sleep(1100)

  const after = JSON.parse(
    await chromeEvaluate(`(() => {
      const tab = document.querySelector('[data-tab-id="${setup.tabId}"]')
      return JSON.stringify({
        dividers: document.querySelectorAll('.divider').length,
        stillDragging: document.querySelectorAll('.tab--dragging').length,
        tileBadge: tab?.querySelector('.tab__tile')?.textContent ?? null
      })
    })()`)
  )

  check('dropping on the left edge created a split', after.dividers, 1)
  check('the drag is over', after.stillDragging, 0)
  check('the dropped tab landed in the first tile', after.tileBadge, '1')

  const cleared = await overlayEvaluate(`document.querySelectorAll('.dropzone').length`)
  check('the indicator is gone after the drop', cleared, 0)

  overlayConnection.ws.close()
}

/**
 * The same drag, into a layout that already has several tiles.
 *
 * A single tile is the special case — it offers edge zones that *create* a split. Three and
 * four tiles take the ordinary path, one zone per existing tile, and that path had no test at
 * all: the first drag check only ever exercised `1x1`.
 */
async function runMultiTileDragChecks(chromeEvaluate, chromeSend, layout, expectedZones, expectedTile) {
  const mouse = (send, type, x, y) =>
    send('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1
    })

  await chromeEvaluate(
    `window.tessera.invoke('split:setLayout', { layout: '${layout}' })`,
    true
  )
  await sleep(1400)

  const setup = JSON.parse(
    await chromeEvaluate(`(() => {
      const tabs = [...document.querySelectorAll('[data-tab-id]')]
      const first = tabs[0]
      if (first === undefined) return JSON.stringify({ ok: false })
      const box = first.getBoundingClientRect()
      return JSON.stringify({
        ok: true,
        tabId: first.getAttribute('data-tab-id'),
        tileBefore: first.querySelector('.tab__tile')?.textContent ?? null,
        x: Math.round(box.x + box.width / 2),
        y: Math.round(box.y + box.height / 2)
      })
    })()`)
  )
  if (setup.ok !== true) {
    check(`${layout}: a tab exists to drag`, false, true)
    return
  }

  await mouse(chromeSend, 'mousePressed', setup.x, setup.y)
  await mouse(chromeSend, 'mouseMoved', setup.x + 24, setup.y)
  await sleep(700)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const overlay = targets.find((t) => t.url.includes('overlay.html'))
  if (!overlay) {
    check(`${layout}: overlay layer present during a drag`, false, true)
    return
  }

  const overlayConnection = connect(overlay.webSocketDebuggerUrl)
  await overlayConnection.ready
  const overlayEvaluate = async (expression) => {
    const result = await overlayConnection.send('Runtime.evaluate', {
      expression,
      returnByValue: true
    })
    return result.result?.result?.value
  }

  const zoneCount = await overlayEvaluate(`document.querySelectorAll('.dropzone').length`)
  check(`${layout}: offers the expected drop zones`, zoneCount, expectedZones)

  const size = JSON.parse(
    await overlayEvaluate(`JSON.stringify({ width: window.innerWidth, height: window.innerHeight })`)
  )
  // Bottom right of the tile area: the last tile in every layout with more than two.
  const dropX = Math.round(size.width * 0.85)
  const dropY = Math.round(size.height * 0.85)
  await mouse(overlayConnection.send, 'mouseMoved', dropX, dropY)
  await sleep(500)

  const active = await overlayEvaluate(`document.querySelectorAll('.dropzone--active').length`)
  check(`${layout}: a zone highlights under the pointer`, active, 1)

  await mouse(overlayConnection.send, 'mouseReleased', dropX, dropY)
  await sleep(1300)

  const after = JSON.parse(
    await chromeEvaluate(`(() => {
      const tab = document.querySelector('[data-tab-id="${setup.tabId}"]')
      return JSON.stringify({
        tile: tab?.querySelector('.tab__tile')?.textContent ?? null,
        stillDragging: document.querySelectorAll('.tab--dragging').length
      })
    })()`)
  )

  check(`${layout}: the dragged tab moved to the tile it was dropped on`, after.tile, expectedTile)
  check(`${layout}: the drag is over`, after.stillDragging, 0)

  overlayConnection.ws.close()
}

/**
 * The layout follows the tabs in it.
 *
 * Two complaints, one idea. Choosing a four-tile layout with one tab left three panes reading
 * "drag a tab here" — an instruction rather than a browser. And closing a tab left its pane
 * behind, empty, waiting. Growing fills; closing takes the tile away again.
 *
 * The third complaint was separate and worse: a new tab in a split layout replaced whatever was
 * in front of the user, because it took the *active* tile while empty panes sat beside it.
 */
async function runLayoutAdaptationChecks(chromeEvaluate) {
  const probe = async () =>
    JSON.parse(
      await chromeEvaluate(`(() => {
        const tabs = [...document.querySelectorAll('[data-tab-id]')]
        return JSON.stringify({
          tabs: tabs.length,
          dividers: document.querySelectorAll('.divider').length,
          badges: tabs.map((e) => e.querySelector('.tab__tile')?.textContent ?? null)
        })
      })()`)
    )
  const setLayout = async (layout) => {
    await chromeEvaluate(`window.tessera.invoke('split:setLayout', { layout: '${layout}' })`, true)
    await sleep(1800)
  }
  const setAdapt = async (value) => {
    await chromeEvaluate(
      `window.tessera.invoke('settings:set', { key: 'splitView.adaptLayoutToTabs', value: ${value} })`,
      true
    )
    await sleep(400)
  }
  const closeAllButFirst = async () => {
    await chromeEvaluate(
      `(async () => {
         const ids = [...document.querySelectorAll('[data-tab-id]')].map((e) => e.getAttribute('data-tab-id'))
         for (const id of ids.slice(1)) await window.tessera.invoke('tabs:close', { tabId: id })
         return 'done'
       })()`,
      true
    )
    await sleep(1500)
  }

  await setAdapt(true)
  await setLayout('1x1')
  await closeAllButFirst()
  check('a single tab remains before the layout grows', (await probe()).tabs, 1)

  // Growing gives every pane it just created something to show.
  await setLayout('2x2')
  const grown = await probe()
  check('a four-tile layout has four tiles', grown.dividers, 2)
  check('growing the layout opened a tab for every empty pane', grown.tabs, 4)
  check('every pane holds a tab', grown.badges.filter((b) => b !== null).length, 4)

  // Shrinking closes the fillers again rather than leaving them in the strip forever.
  await setLayout('1x2')
  const shrunk = await probe()
  check('shrinking leaves two panes', shrunk.dividers, 1)
  check('the untouched fillers were closed, not stranded', shrunk.tabs, 2)

  // Closing the tab in a pane, with nothing left to show there, takes the pane away.
  await chromeEvaluate(
    `(async () => {
       const first = document.querySelector('[data-tab-id]')
       await window.tessera.invoke('tabs:close', { tabId: first.getAttribute('data-tab-id') })
       return 'closed'
     })()`,
    true
  )
  await sleep(1800)
  const afterClose = await probe()
  check('closing the last tab of a pane takes the pane away', afterClose.dividers, 0)
  check('the other tab is still there', afterClose.tabs, 1)

  /*
    And the separate complaint: a new tab must take an empty pane rather than replace what the
    user is looking at. Adaptation is switched off to *create* an empty pane, which is the only
    state where the choice is observable.
  */
  await setAdapt(false)
  await setLayout('2x2')
  const emptyPanes = await probe()
  check('with adaptation off, panes stay empty', emptyPanes.tabs, 1)

  const occupied = emptyPanes.badges.find((badge) => badge !== null)
  await chromeEvaluate(`window.tessera.invoke('tabs:create', {})`, true)
  await sleep(1600)
  const added = await probe()
  check('the new tab was added, not swapped in', added.tabs, 2)
  check(
    'the new tab took an empty pane instead of the one in use',
    added.badges.filter((badge) => badge !== null).length,
    2
  )
  check(
    'the pane that was already in use kept its tab',
    added.badges.includes(occupied),
    true
  )

  await setAdapt(true)
}

/**
 * The history actually records, and the page can read it back.
 *
 * Not provable by the checks above: they only ever visit `tessera://` addresses and
 * `about:blank`, both of which the store refuses on purpose. So an empty history file is the
 * *expected* outcome there and says nothing about whether recording works. This navigates to a
 * `file://` address instead — no network needed, and an address the store does keep.
 */
async function runHistoryChecks(chromeEvaluate) {
  const before = Number(
    await chromeEvaluate(`window.tessera.invoke('history:query', {}).then((v) => v.length)`, true)
  )

  // The built chrome page itself: a real address, reachable without a network.
  const target = `file://${process.cwd()}/out/renderer/index.html`
  await chromeEvaluate(
    `window.tessera.invoke('nav:navigate', { input: ${JSON.stringify(target)} })`,
    true
  )
  await sleep(2000)

  const entries = JSON.parse(
    await chromeEvaluate(
      `window.tessera.invoke('history:query', {}).then((v) => JSON.stringify(v))`,
      true
    )
  )
  check('a visit was recorded', entries.length, (n) => n > before)

  const recorded = entries.find((entry) => entry.url.startsWith('file://'))
  check('the recorded entry keeps its address', recorded !== undefined, true)
  if (recorded !== undefined) {
    check('the entry carries a visit count', recorded.visitCount, (n) => n >= 1)
    check('the entry carries a first and last time', recorded, (e) =>
      typeof e.firstVisitedAt === 'number' && typeof e.lastVisitedAt === 'number'
    )
  }

  // Searching is what the address bar will use; an entry that cannot be found is not useful.
  const found = Number(
    await chromeEvaluate(
      `window.tessera.invoke('history:query', { text: 'renderer' }).then((v) => v.length)`,
      true
    )
  )
  check('the entry can be found by searching its address', found, (n) => n >= 1)

  const removed = Number(
    await chromeEvaluate(
      `window.tessera.invoke('history:removeVisit', { url: ${JSON.stringify(target)} }).then((r) => r.removed)`,
      true
    )
  )
  check('removing an entry reports how many went', removed, (n) => n >= 1)

  const after = Number(
    await chromeEvaluate(`window.tessera.invoke('history:query', {}).then((v) => v.length)`, true)
  )
  check('the removed entry is gone', after, entries.length - removed)

  /*
    Deliberately not asserted here: that the chrome UI reaches these channels.

    An earlier version called `settings:set`, `quicklinks:list` and `tabs:close` with `{}` and
    expected them to be allowed. All three were refused — by *schema validation*, because `{}` is
    not a valid request for any of them. The check conflated "refused by policy" with "refused by
    shape" and would have failed however the privileges were set. The per-page refusals are
    asserted from the start page below, and by 1400 unit tests against `decideAccess`.
  */
}

/**
 * Clicking into a tile makes it the active one.
 *
 * This is what "back only worked on the main page" came down to: the toolbar acts on the
 * active tile's tab, a click into a tile lands on a native view that the chrome UI cannot
 * see, and nothing told the core about it. So the active tile only ever moved through a
 * keyboard shortcut, and every toolbar command kept addressing whichever tile was activated
 * last.
 *
 * Driven with a real click into the view rather than through `split:setActiveTile`, because
 * the channel always worked — it was the absence of anything calling it that was the bug.
 */
async function runTileFocusChecks(chromeEvaluate) {
  // Establish the precondition rather than assume it: earlier checks leave the active tile
  // wherever they happened to leave it, and a test that depends on that is a test that fails
  // for the wrong reason the next time one is added.
  await chromeEvaluate(`window.tessera.invoke('split:setActiveTile', { tileIndex: 0 })`, true)
  await sleep(600)

  const tabs = JSON.parse(
    await chromeEvaluate(`JSON.stringify([...document.querySelectorAll('[data-tab-id]')].map((element) => ({
      id: element.getAttribute('data-tab-id'),
      tile: element.querySelector('.tab__tile')?.textContent ?? null,
      active: element.getAttribute('aria-selected') === 'true'
    })))`)
  )

  const inSecondTile = tabs.find((tab) => tab.tile === '2')
  if (inSecondTile === undefined) {
    check('a second tile holds a tab to click into', false, true)
    return
  }
  check('the tab in the second tile is not the active one yet', inSecondTile.active, false)

  // Given its own address so the right debugger target can be identified; both tiles were
  // showing the start page.
  await chromeEvaluate(
    `window.tessera.invoke('nav:navigate', { input: 'about:blank', tabId: '${inSecondTile.id}' })`,
    true
  )
  await sleep(1200)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const tile = targets.find((t) => t.url === 'about:blank')
  if (!tile) {
    check('the second tile has a debugger target', false, true)
    return
  }

  const connection = connect(tile.webSocketDebuggerUrl)
  await connection.ready
  for (const type of ['mousePressed', 'mouseReleased']) {
    await connection.send('Input.dispatchMouseEvent', {
      type,
      x: 60,
      y: 60,
      button: 'left',
      buttons: type === 'mousePressed' ? 1 : 0,
      clickCount: 1
    })
  }
  await sleep(1000)
  connection.ws.close()

  const nowActive = await chromeEvaluate(
    `document.querySelector('[data-tab-id="${inSecondTile.id}"]')?.getAttribute('aria-selected')`
  )
  check('clicking into a tile makes its tab the active one', nowActive, 'true')

  // And therefore the toolbar addresses that tab: the core resolves "no tabId given" to the
  // active tile, which is the whole chain the back button depends on.
  const resolved = await chromeEvaluate(
    `window.tessera.invoke('nav:getBackForwardList', {}).then((list) => list.length >= 1)`,
    true
  )
  check('the toolbar resolves navigation against the focused tile', resolved, true)

  /*
    Put the tab back where it was found.

    This check navigates a tile to `about:blank` so it has its own debugger target, and for a long time
    it left it there. Two checks further down then failed intermittently — the start-page checks look for
    a tab still on `tessera://start`, and between this one and the history check, which also navigates a
    tab away, sometimes none was left. The failure showed up as "start page target present -> false",
    which points at the start page and not at the check that consumed it.
  */
  await chromeEvaluate(
    `window.tessera.invoke('nav:navigate', { input: 'tessera://start', tabId: '${inSecondTile.id}' })`,
    true
  )
  await sleep(800)
}

/**
 * The history page, and the per-page privilege model in the running application.
 *
 * Two things only this can show. That `tessera://history` is served and renders at all — the
 * address was reserved long before anything answered it. And that the page gets *its own* channels
 * and not another page's: the unit tests assert the policy function, this asserts the policy that
 * is actually in force, through the bridge the preload really built.
 */
async function runHistoryPageChecks(chromeEvaluate) {
  await chromeEvaluate(
    `window.tessera.invoke('tabs:create', { url: 'tessera://history' })`,
    true
  )
  await sleep(2500)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find((t) => t.url.startsWith('tessera://history'))
  if (!page) {
    check('the history page is served', false, true)
    return
  }

  const { ws, ready, send } = connect(page.webSocketDebuggerUrl)
  await ready
  const evaluate = async (expression, awaitPromise = true) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    return result.result?.result?.value
  }

  check('the history page renders its own heading', await evaluate(
    `document.querySelector('.history__title')?.textContent ?? null`, false
  ), (v) => typeof v === 'string' && v.length > 0)

  const bridge = await evaluate(`typeof window.tesseraInternal === 'object'`, false)
  check('the history page has the internal bridge', bridge, true)

  const fullBridgeAbsent = await evaluate(`typeof window.tessera === 'undefined'`, false)
  check('the history page does NOT have the chrome bridge', fullBridgeAbsent, true)

  // Its own channels work.
  const queried = await evaluate(
    `window.tesseraInternal.invoke('history:query', {}).then((v) => Array.isArray(v)).catch((e) => 'ERROR: ' + e.message)`
  )
  check('the history page may read the history', queried, true)

  /*
    And nothing else. These are the channels other internal pages have — the whole reason the
    allowlist is per page rather than shared. Under the previous model `quicklinks:list` would have
    been allowed here, and `settings:set` would have been allowed on the start page.
  */
  for (const channel of ['quicklinks:list', 'settings:set', 'settings:getAll', 'tabs:close', 'overlay:present']) {
    const outcome = await evaluate(
      `window.tesseraInternal.invoke('${channel}', {}).then(() => 'RESOLVED').catch(() => 'REJECTED')`
    )
    check(`the history page may not call ${channel}`, outcome, 'REJECTED')
  }

  const eventRefused = await evaluate(
    `(() => { try { window.tesseraInternal.on('settings:changed', () => {}); return 'ALLOWED' }
              catch { return 'REJECTED' } })()`,
    false
  )
  check("the history page may not subscribe to another page's events", eventRefused, "REJECTED")

  ws.close()
}

/**
 * Drives the start page through the bridge it actually has.
 *
 * Two things are only checkable here: that an `tessera://` page can manage quick
 * links at all, and that the same page is refused everything outside its narrow
 * allowlist. The second is the security boundary — a unit test can check the policy
 * function, but only this can check that the policy is the one in force.
 */
/**
 * A 1x1 transparent PNG, as bytes.
 *
 * Hard-coded rather than generated, so this file needs no image library, and a real PNG rather than
 * a placeholder because the cache sniffs the format from the bytes and refuses anything it cannot
 * recognise — an invented byte string would be rejected and the test would pass for the wrong
 * reason, proving only that a refusal is handled.
 */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64'
)

/**
 * A throwaway site on the loopback interface: one page that declares an icon, and the icon.
 *
 * A local server rather than a real site, because the smoke test has to work with no network and
 * must not depend on somebody else's uptime — and because `file://` documents have no host, so the
 * favicon path cannot be exercised with the built pages the other checks use.
 */
async function startIconSite() {
  const server = createServer((request, response) => {
    if (request.url === '/icon.png') {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': ONE_PIXEL_PNG.length })
      response.end(ONE_PIXEL_PNG)
      return
    }
    /*
      The page carries two well-known generic advert class names.

      `adsbygoogle` and `ad-slot` appear in EasyList's *generic* cosmetic section, which applies to every
      host — including this one on the loopback interface. So a page containing them is enough to prove
      the whole hiding path end to end without needing a real advertising site: the page reports its
      classes, the core answers with the selectors that could match, and the preload injects them.
    */
    const body =
      `<!doctype html><meta charset="utf-8">` +
      `<link rel="icon" href="/icon.png" sizes="32x32"><title>Icon site</title>` +
      `<p>icon site<div class="adsbygoogle"></div><div class="ad-slot"></div>`
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, origin: `http://127.0.0.1:${port}` }
}

/**
 * Favicons, end to end: the site declares one, the core fetches and caches it, the chrome UI draws
 * it from `tessera://favicon`.
 *
 * The last step is the one that cannot be reasoned about from the source. The chrome UI is loaded
 * from `file://`, the icon comes from `tessera://favicon?site=…`, and whether Chromium permits
 * that image across those two schemes — with this page's CSP — is a question only the running
 * browser answers. `naturalWidth` is the assertion because it is non-zero only if the bytes actually
 * arrived and decoded: a blocked request, a 204 and a wrong content type all leave it at 0.
 */
async function runFaviconChecks(chromeEvaluate, origin) {
  {
    const site = { origin }
    /*
      The layout is deliberately left as the previous checks left it.

      Setting it to `1x1` here looked harmless and broke a start-page check further down that
      measures the halves a page may occupy — it read the full window width instead. The tab strip
      shows an icon whatever the layout is, so there was nothing to gain.
    */

    /*
      A new tab rather than navigating the one that is there.

      The start-page checks that run after this one look for a tab still sitting on
      `tessera://start`; navigating the only tab away would take that with it, and the failure
      would show up several checks later as something unrelated.
    */
    await chromeEvaluate(
      `window.tessera.invoke('tabs:create', { url: ${JSON.stringify(site.origin + '/')} })`,
      true
    )
    // Long enough for the page to load, declare its icon, and for one loopback request to finish.
    await sleep(3500)

    /*
      Read from the DOM rather than from a state channel, and that is the stronger assertion anyway.

      There is no `tabs:list`; tab state reaches the chrome UI as a `tabs:changed` event. So the
      rendered `src` *is* the evidence that the state arrived — and `naturalWidth` is evidence the
      bytes did. The latter is the part no amount of source reading settles: the chrome UI is a
      `file://` document, the icon is an `tessera://` address, and whether Chromium carries an
      image across those two schemes under this page's CSP is a question only the running browser
      answers. A blocked request, a 204 and a wrong content type all leave it at 0.
    */
    const drawn = JSON.parse(
      await chromeEvaluate(`(() => {
        const images = [...document.querySelectorAll('.tab__faviconImage')]
        const image = images.find((candidate) => (candidate.getAttribute('src') ?? '').includes('127.0.0.1'))
        if (image === undefined) {
          return JSON.stringify({
            present: false,
            imageCount: images.length,
            tabs: [...document.querySelectorAll('[data-tab-id]')].map((element) => element.textContent)
          })
        }
        return JSON.stringify({
          present: true,
          complete: image.complete,
          width: image.naturalWidth,
          hidden: image.hidden,
          src: image.getAttribute('src')
        })
      })()`)
    )

    check('the chrome UI drew an icon element for the visited site', drawn.present, true)
    if (!drawn.present) {
      console.error('    no icon element; strip contained:', JSON.stringify(drawn))
      return
    }

    check(
      'the icon address points at the internal cache, not at the site',
      drawn.src,
      (value) => typeof value === 'string' && value.startsWith('tessera://favicon?site=127.0.0.1')
    )
    // Versioned, so a refreshed icon is a new address rather than whatever Chromium already holds.
    check('the icon address carries a version', drawn.src, (value) => /[?&]v=/.test(value))
    check('the icon bytes reached the chrome UI and decoded', drawn.width, (n) => n > 0)
    check('the icon element was not hidden by a load error', drawn.hidden, false)

    /*
      An unknown site must leave the placeholder rather than a broken-image glyph.

      Checked through an `<img>`, which is the path the interface actually takes. An earlier version
      used `fetch` and was refused — correctly — by this page's `connect-src 'self'`: the chrome UI
      may *draw* from the internal scheme and may not *read* from it, and relaxing that to make a
      test possible would be the wrong way round. What is observable from here is what the interface
      depends on: the load fails, so `onError` hides the element and the placeholder shows.
    */
    const miss = await chromeEvaluate(`new Promise((resolve) => {
      const probe = new Image()
      probe.onload = () => resolve('LOADED')
      probe.onerror = () => resolve('ERRORED')
      probe.src = 'tessera://favicon?site=nothing.invalid&v=1'
    })`, true)
    check('an unknown site yields no drawable image', miss, 'ERRORED')

    await runBlockerChecks(chromeEvaluate)
  }
}

/**
 * Tab groups, end to end.
 *
 * The parts a unit test cannot reach: that the chip is actually drawn in the strip, that folding one
 * hides its tabs *and* releases their tiles, and that the whole thing survives the trip through the
 * IPC contract. The tile release is the one worth driving in a real window — a hidden tab that kept
 * its tile leaves a page on screen with nothing in the strip to close it.
 */
async function runTabGroupChecks(chromeEvaluate) {
  // Three tabs and a two-tile layout, so there is a tile to release.
  await chromeEvaluate(`window.tessera.invoke('split:setLayout', { layout: '1x2' })`, true)
  await sleep(900)

  const ids = JSON.parse(
    await chromeEvaluate(
      `JSON.stringify([...document.querySelectorAll('[data-tab-id]')].map((e) => e.getAttribute('data-tab-id')))`
    )
  )
  check('there are at least two tabs to group', ids.length, (n) => n >= 2)
  if (ids.length < 2) return

  const [first, second] = ids
  const created = await chromeEvaluate(
    `window.tessera.invoke('tabgroups:create', { tabIds: ${JSON.stringify([first, second])}, name: 'Work', color: 'green' })
       .then((g) => JSON.stringify(g)).catch((e) => 'ERROR: ' + e.message)`,
    true
  )
  check('a group can be created through the contract', created, (v) => !String(v).startsWith('ERROR'))
  if (String(created).startsWith('ERROR')) {
    console.error('   ', created)
    return
  }
  const group = JSON.parse(created)
  await sleep(600)

  const strip = JSON.parse(
    await chromeEvaluate(`(() => {
      const chip = document.querySelector('[data-tab-group-id="' + ${JSON.stringify(group.id)} + '"]')
      return JSON.stringify({
        chipPresent: chip !== null,
        chipLabel: chip?.getAttribute('aria-label') ?? null,
        expanded: chip?.getAttribute('aria-expanded') ?? null,
        // The dot's colour comes from the palette token; an undeclared token paints nothing.
        dotColour: chip === null ? null : getComputedStyle(chip.querySelector('.tabgroup__dot')).backgroundColor,
        bandedTabs: document.querySelectorAll('.tab--grouped').length,
        visibleTabs: document.querySelectorAll('[data-tab-id]').length
      })
    })()`)
  )

  check('the group is drawn as a chip in the strip', strip.chipPresent, true)
  check('the chip reports itself as expanded', strip.expanded, 'true')
  check('both members carry the group band', strip.bandedTabs, 2)
  check(
    'the palette token resolved to a real colour',
    strip.dotColour,
    (value) => typeof value === 'string' && value !== '' && !value.includes('rgba(0, 0, 0, 0)')
  )

  // Fold it: the tabs go from the strip, and their tiles are released.
  await chromeEvaluate(
    `window.tessera.invoke('tabgroups:setCollapsed', { id: ${JSON.stringify(group.id)}, collapsed: true })`,
    true
  )
  await sleep(900)

  const folded = JSON.parse(
    await chromeEvaluate(`(() => {
      const chip = document.querySelector('[data-tab-group-id="' + ${JSON.stringify(group.id)} + '"]')
      const drawn = [...document.querySelectorAll('[data-tab-id]')].map((e) => e.getAttribute('data-tab-id'))
      return JSON.stringify({
        expanded: chip?.getAttribute('aria-expanded') ?? null,
        count: chip?.querySelector('.tabgroup__count')?.textContent ?? null,
        drawn,
        // A tile badge on a folded tab would mean it still holds one.
        tileBadges: [...document.querySelectorAll('.tab__tile')].length
      })
    })()`)
  )

  check('the chip reports itself as collapsed', folded.expanded, 'false')
  check('the chip says how many tabs are folded away', folded.count, '2')
  check('the folded tabs are no longer drawn', folded.drawn, (drawn) => !drawn.includes(first) && !drawn.includes(second))
  check(
    'a folded tab no longer holds a tile',
    folded.tileBadges,
    (n) => n <= Math.max(0, folded.drawn.length)
  )

  // Unfold, then dissolve: the tabs must still be there and still be open.
  await chromeEvaluate(
    `window.tessera.invoke('tabgroups:setCollapsed', { id: ${JSON.stringify(group.id)}, collapsed: false })`,
    true
  )
  await sleep(700)
  await chromeEvaluate(
    `window.tessera.invoke('tabgroups:dissolve', { id: ${JSON.stringify(group.id)} })`,
    true
  )
  await sleep(700)

  const after = JSON.parse(
    await chromeEvaluate(`JSON.stringify({
      chips: document.querySelectorAll('[data-tab-group-id]').length,
      banded: document.querySelectorAll('.tab--grouped').length,
      drawn: [...document.querySelectorAll('[data-tab-id]')].map((e) => e.getAttribute('data-tab-id'))
    })`)
  )
  check('dissolving removes the chip', after.chips, 0)
  check('dissolving removes the band', after.banded, 0)
  // The distinction that makes "ungroup" a different verb from "close".
  check('dissolving keeps every tab open', after.drawn, (drawn) =>
    drawn.includes(first) && drawn.includes(second)
  )

  // An internal page must not reach any of this: a group decides which tabs are visible.
  const refused = await chromeEvaluate(
    `window.tessera.invoke('tabgroups:create', { tabIds: ['nope'] })
       .then(() => 'RESOLVED').catch(() => 'REJECTED')`,
    true
  )
  check('grouping a tab that does not exist is refused, not silently ignored', refused, 'REJECTED')
}

/**
 * The content blocker, as far as an offline run can see it.
 *
 * Deliberately modest about what it proves. The lists are downloaded from the internet, so a smoke test
 * that must work with no network cannot assert that adverts are blocked. What it *can* assert is the
 * part that was missing until now and would fail silently: that the engine exists, that it is the one
 * the request pipeline holds, and that the counters reach the interface — so "the blocker does not work"
 * has an answer other than a shrug.
 */
async function runFilterChecks(chromeEvaluate) {
  const status = JSON.parse(
    await chromeEvaluate(
      `window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s)).catch((e) => JSON.stringify({ error: e.message }))`,
      true
    )
  )

  check('the blocker reports its status through the contract', status.error, undefined)
  if (status.error !== undefined) {
    console.error('   ', status.error)
    return
  }

  // Four lists on a fresh profile: adverts, trackers, cookie banners, anti-adblock.
  check('every configured list is counted', status.configured, (n) => n >= 4)
  check('the diagnostics carry the parser counters', status.diagnostics, (d) =>
    d !== undefined && typeof d.lines === 'number' && typeof d.unsupported === 'number'
  )
  check(
    'the counters are consistent with each other',
    status.diagnostics,
    (d) => d.blank + d.comments + d.network + d.cosmetic + d.unsupported === d.lines
  )

  /*
    Whether rules are loaded depends on the network, so both answers are acceptable — but they must be
    *consistent*: rules without a loaded list, or a loaded list with no rules at all, is a wiring fault
    rather than an offline run.
  */
  if (status.loaded === 0) {
    check('with no list cached, no rules are compiled', status.networkRules, 0)
  } else {
    check('a cached list produced network rules', status.networkRules, (n) => n > 0)
  }

  // The blocker being switched off must mean the engine holds nothing, not that a check elsewhere skips
  // it — a distinction that decides whether one forgotten branch leaves it blocking after the user
  // turned it off.
  await chromeEvaluate(
    `window.tessera.invoke('settings:set', { key: 'privacy.blockerEnabled', value: false })`,
    true
  )
  await sleep(900)
  const off = JSON.parse(
    await chromeEvaluate(`window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s))`, true)
  )
  check('switching the blocker off leaves no rules compiled', off.networkRules, 0)
  check('switching the blocker off configures no lists', off.configured, 0)

  await chromeEvaluate(
    `window.tessera.invoke('settings:set', { key: 'privacy.blockerEnabled', value: true })`,
    true
  )
  await sleep(900)
  const backOn = JSON.parse(
    await chromeEvaluate(`window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s))`, true)
  )
  check('switching it back on restores the configured lists', backOn.configured, (n) => n >= 4)

  // An internal page must not be able to reach the blocker's controls.
  const refused = await chromeEvaluate(
    `window.tessera.invoke('filters:notARealChannel').then(() => 'RESOLVED').catch(() => 'REJECTED')`,
    true
  )
  check('an unknown filters channel is refused by the allowlist', refused, 'REJECTED')
}

/**
 * Settings and extensions as real pages.
 *
 * The user asked to keep the in-window panels *and* have tabs, and the promise made in return was that
 * both would render one component rather than two. This is the half of that a unit test cannot check:
 * that the addresses are actually served, that the page's *narrower* bridge is enough for it to work,
 * and that being a page has not quietly given it powers a page should not have.
 */
async function runInternalPageChecks(chromeEvaluate) {
  for (const page of ['settings', 'extensions']) {
    await chromeEvaluate(
      `window.tessera.invoke('tabs:create', { url: 'tessera://${page}' })`,
      true
    )
  }
  // Long enough for two documents to load and for each to fetch its catalogue and its data.
  await sleep(2500)

  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()

  for (const page of ['settings', 'extensions']) {
    const target = targets.find((t) => t.url.startsWith(`tessera://${page}`))
    check(`tessera://${page} is served`, target !== undefined, true)
    if (target === undefined) continue

    const connection = connect(target.webSocketDebuggerUrl)
    await connection.ready
    const evaluate = async (expression, awaitPromise = true) => {
      const result = await connection.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise
      })
      return result.result?.result?.value
    }

    // The page rendered its own surface, from its own narrower bridge.
    const rendered = await evaluate(
      `(async () => {
        for (let attempt = 0; attempt < 30; attempt++) {
          if (document.querySelector('.panel') !== null) return document.querySelectorAll('.field, .extlist, .panel__empty').length
          await new Promise((r) => setTimeout(r, 200))
        }
        return -1
      })()`
    )
    check(`the ${page} page rendered its surface`, rendered, (n) => n > 0)

    // A page is not a modal dialogue: claiming so would tell a screen reader the browser is unavailable.
    const modal = await evaluate(`document.querySelector('.panel')?.getAttribute('aria-modal') ?? 'absent'`, false)
    check(`the ${page} page does not claim to be a modal dialogue`, modal, 'absent')

    // And no backdrop, which on a page would be an invisible layer swallowing clicks.
    const backdrop = await evaluate(`document.querySelectorAll('.overlay').length`, false)
    check(`the ${page} page has no dismiss backdrop`, backdrop, 0)

    // The privilege boundary: this page may reach its own channels and nothing else.
    const forbidden = page === 'settings' ? 'extensions:list' : 'settings:getAll'
    const refused = await evaluate(
      `window.tesseraInternal.invoke('${forbidden}').then(() => 'RESOLVED').catch(() => 'REJECTED')`
    )
    check(`the ${page} page may not call ${forbidden}`, refused, 'REJECTED')

    const tabsRefused = await evaluate(
      `window.tesseraInternal.invoke('tabs:close', {}).then(() => 'RESOLVED').catch(() => 'REJECTED')`
    )
    check(`the ${page} page may not touch tabs`, tabsRefused, 'REJECTED')

    connection.ws.close()
  }
}

/** Opens a tab on the start page, through the chrome UI's own channel. */
async function openStartTab() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const chrome = targets.find((t) => t.url.includes('renderer/index.html'))
  if (!chrome) return
  const connection = connect(chrome.webSocketDebuggerUrl)
  await connection.ready
  await connection.send('Runtime.evaluate', {
    expression: `window.tessera.invoke('tabs:create', { url: 'tessera://start' })`,
    returnByValue: true,
    awaitPromise: true
  })
  connection.ws.close()
  await sleep(1200)
}

/**
 * The content blocker, end to end.
 *
 * Two halves that fail in completely different ways, so both are checked.
 *
 * The *network* half is checked through the diagnostics channel rather than by watching a request
 * disappear: what matters is that four published lists were downloaded, parsed and compiled, and the
 * counters say so in a way a missing list cannot fake. A test that merely watched one request vanish
 * would pass with a single hand-written rule.
 *
 * The *hiding* half can only be proved in the running browser. It crosses two process boundaries — the
 * page reports its class names, the core answers with the selectors that could match, the preload injects
 * them — and none of that is visible from a unit test. The page loaded above carries two class names from
 * EasyList's generic section, which applies to every host including this one.
 */
async function runBlockerChecks(chromeEvaluate) {
  const status = JSON.parse(
    await chromeEvaluate(
      `window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s))`,
      true
    )
  )

  check('every configured filter list was downloaded', status, (s) => s.loaded === s.configured)
  check('more than one list is configured', status.configured, (n) => n >= 4)
  check('the lists compiled into network rules', status.networkRules, (n) => n > 10_000)
  check('the lists compiled into hiding rules', status.cosmeticRules, (n) => n > 1_000)
  /*
    The honest counter. A hand-written engine implements a subset of the Adblock Plus syntax, and this is
    how much of the user's own lists it declines to act on. Asserted as a *proportion* rather than an
    absolute: it must be a minority of what was understood, or the blocker understands less than the user
    believes and nothing says so.
  */
  check(
    'the engine understood far more than it declined',
    status.diagnostics,
    (d) => d.unsupported < d.network / 4
  )

  const injected = JSON.parse(
    await chromeEvaluate(`(() => {
      const view = document.querySelector('.tab--active')
      return JSON.stringify({ ok: view !== null })
    })()`)
  )
  check('the chrome UI is still responsive after compiling the lists', injected.ok, true)
}

async function runStartPageChecks(visitedOrigin) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  /*
    The start page specifically, not the first internal page that turns up.

    This used to match any `tessera://` target, which was fine while there was only one. Adding
    the history page made it pick that instead — and the checks below then asked the *history* page
    to create a quick link, which the per-page allowlist correctly refused. A latent bug that only
    a second internal page could reveal, and the refusal it produced was the model working.
  */
  let start = targets.find((t) => t.url.startsWith('tessera://start'))
  if (!start) {
    /*
      Open one rather than fail.

      These checks are about what an internal page may and may not do, not about whether an earlier
      check happened to leave a start tab open. Depending on that made this report a missing start page
      when the real cause was a different check navigating one away — a failure that names the wrong
      thing is worse than no failure at all.
    */
    await openStartTab()
    const retried = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
    start = retried.find((t) => t.url.startsWith('tessera://start'))
  }
  if (!start) {
    check('start page target present', false, true)
    return
  }

  const { ws, ready, send } = connect(start.webSocketDebuggerUrl)
  await ready
  const evaluate = async (expression, awaitPromise = true) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    return result.result?.result?.value
  }

  const bridgePresent = await evaluate(`typeof window.tesseraInternal === 'object'`, false)
  check('internal bridge is exposed to an tessera:// page', bridgePresent, true)

  const fullBridgeAbsent = await evaluate(`typeof window.tessera === 'undefined'`, false)
  check('the chrome bridge is NOT exposed to a content page', fullBridgeAbsent, true)

  // Creating, listing and removing through the real channels.
  const created = await evaluate(
    `window.tesseraInternal.invoke('quicklinks:create', { kind: 'link', title: 'Smoke', url: 'example.com' })
       .then((l) => l.url).catch((e) => 'ERROR: ' + e.message)`
  )
  check('a quick link is created with a normalised URL', created, 'https://example.com')

  const listed = await evaluate(
    `window.tesseraInternal.invoke('quicklinks:list').then((l) => l.length)`
  )
  check('the new quick link is listed', listed, (v) => v >= 1)

  // A search term must be refused rather than turned into a search.
  const refusedUrl = await evaluate(
    `window.tesseraInternal.invoke('quicklinks:create', { kind: 'link', title: 'Bad', url: 'how tall is everest' })
       .then(() => 'RESOLVED').catch(() => 'REJECTED')`
  )
  check('a search term is refused as a quick link address', refusedUrl, 'REJECTED')

  // The start page renders what the core returned.
  await sleep(600)
  const tiles = await evaluate(`document.querySelectorAll('.tile').length`, false)
  check('the start page renders the tile', tiles, (v) => v >= 1)

  /*
    The card's picture, end to end: a page was visited, photographed after it settled, and the shot is
    drawn on the card.

    A tile for the site the favicon checks visited a moment ago, so its screenshot already exists. The
    interesting assertion is `naturalWidth` again — a card whose `src` is set but whose bytes never
    arrived looks identical in the DOM to one that worked.
  */
  const cardUrl = `${visitedOrigin}/`
  await evaluate(
    `window.tesseraInternal.invoke('quicklinks:create',
       { kind: 'link', title: 'Shot', url: ${JSON.stringify(cardUrl)} }).catch((e) => e.message)`
  )
  // The list refreshes through `quicklinks:changed`, and the image then has to load.
  await sleep(1500)

  const cardPicture = JSON.parse(
    await evaluate(`(() => {
      const image = [...document.querySelectorAll('.tile__picture')]
        .find((candidate) => (candidate.getAttribute('src') ?? '').includes('thumbnail'))
      if (image === undefined) {
        return JSON.stringify({
          present: false,
          sources: [...document.querySelectorAll('.tile__picture')].map((element) => element.getAttribute('src'))
        })
      }
      return JSON.stringify({
        present: true,
        width: image.naturalWidth,
        height: image.naturalHeight,
        className: image.className,
        src: image.getAttribute('src')
      })
    })()`, false)
  )

  check('a visited page gets a screenshot on its card', cardPicture.present, true)
  if (cardPicture.present) {
    check('the screenshot address is versioned', cardPicture.src, (v) => /[?&]v=/.test(v))
    check('the screenshot bytes reached the start page and decoded', cardPicture.width, (n) => n > 0)
    // 8:5, from `THUMBNAIL_TARGET`. A picture stored at another ratio would be cropped twice.
    check(
      'the screenshot has card proportions',
      cardPicture,
      (shot) => Math.abs(shot.width / shot.height - 8 / 5) < 0.02
    )
    check(
      'the screenshot is styled as a screenshot, not as an icon',
      cardPicture.className,
      (v) => v.includes('tile__picture--thumbnail')
    )
  } else {
    console.error('    no screenshot on any card; sources were:', JSON.stringify(cardPicture.sources))
  }

  // --- the boundary that matters ---------------------------------------------
  for (const channel of ['settings:set', 'tabs:close', 'split:setLayout', 'window:close']) {
    const outcome = await evaluate(
      `window.tesseraInternal.invoke('${channel}', {})
         .then(() => 'RESOLVED').catch(() => 'REJECTED')`
    )
    check(`an internal page may not call ${channel}`, outcome, 'REJECTED')
  }

  const eventRefused = await evaluate(
    `(() => { try { window.tesseraInternal.on('tabs:changed', () => {}); return 'ALLOWED' }
              catch { return 'REJECTED' } })()`,
    false
  )
  check('an internal page may not subscribe to chrome events', eventRefused, 'REJECTED')

  // Clean up so repeated runs start from the same place.
  await evaluate(
    `window.tesseraInternal.invoke('quicklinks:list')
       .then((links) => Promise.all(links.map((l) =>
         window.tesseraInternal.invoke('quicklinks:remove', { id: l.id }))))
       .then(() => 'done')`
  )

  ws.close()
}

/*
  One throwaway site for the whole run, started before anything connects.

  Held at this level rather than inside a single check because two of them need it: the tab strip's
  icon comes from visiting it, and the start-page card's screenshot is a picture of that same visit —
  taken a second and a half later, by which time a server owned by the earlier check would be shut.
*/
const iconSite = await startIconSite()

try {
  const targets = await waitForTargets()

  const startPage = targets.find((t) => t.url.startsWith('tessera://'))
  check('internal tessera:// scheme serves the start page', startPage?.url ?? null, (v) =>
    typeof v === 'string' && v.startsWith('tessera://start')
  )

  const chromeTarget = targets.find((t) => t.url.includes('renderer/index.html'))
  const { ws, ready, send } = connect(chromeTarget.webSocketDebuggerUrl)
  await ready

  const evaluate = async (expression, awaitPromise = false) => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    return result.result?.result?.value
  }

  // A debugger target exists as soon as the web contents does, which is before React has
  // rendered anything into it. Without this wait the first probe measures an empty document
  // and reports a dozen failures that say nothing about the build.
  for (let attempt = 0; attempt < 40; attempt++) {
    if ((await evaluate(`document.querySelector('.chrome') !== null`)) === true) break
    await sleep(250)
  }

  const before = JSON.parse(await evaluate(PROBE))
  check('preload bridge is exposed', before.bridgePresent, true)
  check(
    'every contract channel reached the renderer',
    before.invokeChannels,
    await declaredInvokeChannelCount()
  )
  check('a tab is rendered', before.tabsRendered, (v) => v >= 1)
  // The address bar is deliberately empty on the start page: `tessera://start` is an
  // implementation detail, and showing it invites the user to edit an internal address.
  // Its non-home behaviour is covered by unit tests for `omniboxDisplayValue`.
  check('address bar is empty at home', before.omniboxValue, '')
  check('the layout menu button is present', before.layoutButton, 1)
  check('no menu is rendered in the chrome DOM', before.menusInChrome, 0)
  check('the layout button starts collapsed', before.layoutMenuExpanded, 0)
  check(
    'every interactive chrome element is reachable',
    before.unreachable,
    (v) => Array.isArray(v) && v.length === 0
  )
  check('chrome insets were measured', before.chromeHeight, (v) => v > 0)
  check('single layout has no dividers', before.dividerCount, 0)

  // Round-trip through the real boundary: request a 2x2 grid and confirm the
  // core pushed the new state back and the UI grew the matching dividers.
  await evaluate(`window.tessera.invoke('split:setLayout', { layout: '2x2' })`, true)
  await sleep(1200)
  const after = JSON.parse(await evaluate(PROBE))
  check('2x2 layout produces two dividers', after.dividerCount, 2)
  check('the chrome DOM still holds no menu', after.menusInChrome, 0)

  await runOverlayChecks(evaluate)
  await runTabDragChecks(evaluate, send)
  // 1+2: the wide left tile can still be halved, the two right tiles cannot — five zones.
  await runMultiTileDragChecks(evaluate, send, '1+2', 5, '3')
  // A four-tile grid cannot be split further, so each tile offers only a plain drop.
  await runMultiTileDragChecks(evaluate, send, '2x2', 4, '4')
  await runLayoutAdaptationChecks(evaluate)
  await runTileFocusChecks(evaluate)
  await runHistoryChecks(evaluate)
  await runHistoryPageChecks(evaluate)
  await runFaviconChecks(evaluate, iconSite.origin)
  await runTabGroupChecks(evaluate)
  await runFilterChecks(evaluate)
  await runInternalPageChecks(evaluate)

  // Spec 5: an unknown key must fail visibly rather than being dropped.
  const unknownKey = await evaluate(
    `window.tessera.invoke('settings:set', { key: 'appearance.definitelyNotAKey', value: 1 })
       .then(() => 'RESOLVED').catch((e) => 'REJECTED')`,
    true
  )
  check('unknown settings key is rejected, not swallowed', unknownKey, 'REJECTED')

  // Spec 5: an out-of-range value must fail too.
  const badValue = await evaluate(
    `window.tessera.invoke('settings:set', { key: 'appearance.defaultZoom', value: 9999 })
       .then(() => 'RESOLVED').catch((e) => 'REJECTED')`,
    true
  )
  check('out-of-range setting value is rejected', badValue, 'REJECTED')

  // A valid write must take effect and be readable back.
  await evaluate(`window.tessera.invoke('settings:set', { key: 'appearance.theme', value: 'dark' })`, true)
  const readBack = await evaluate(
    `window.tessera.invoke('settings:getAll').then((s) => s['appearance.theme'])`,
    true
  )
  check('valid setting is stored and readable', readBack, 'dark')

  // Channel names outside the allowlist must not reach the core.
  const rejectedChannel = await evaluate(
    `window.tessera.invoke('settings:notARealChannel')
       .then(() => 'RESOLVED').catch(() => 'REJECTED')`,
    true
  )
  check('unknown channel is refused by the preload allowlist', rejectedChannel, 'REJECTED')

  ws.close()

  // --- the start page, driven through its own narrow bridge -------------------
  await runStartPageChecks(iconSite.origin)
} catch (error) {
  console.error('smoke test error:', error)
  failures.push(String(error))
} finally {
  iconSite.server.close()
  child.kill()
  await sleep(1500)
  child.kill('SIGKILL')
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`)
  for (const failure of failures) console.error(`  - ${failure}`)
  console.error('\n--- application log ---')
  console.error(mainLog.slice(-4000))
  process.exit(1)
}

console.log(`\nAll checks passed.`)
