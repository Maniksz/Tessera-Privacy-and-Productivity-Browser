/**
 * The application's own checks, run from inside its main process.
 *
 * Every assertion here is about the *running* browser: that the UI/core boundary carried data, that a
 * synthesized mouse can reach what a real one can, that a page landed where the indicator promised.
 * Between them they have caught defects nothing else did — a tile badge the interface deliberately
 * never draws, eighteen of twenty-four drop zones losing a page, a middle tile that could not be
 * dragged onto.
 *
 * ## Not loaded by the application it checks
 *
 * This module is imported at runtime by `--run-checks=<path>`, from outside `src/`, so none of it is
 * in the main bundle: the core is parsed once per launch by every user, and a thousand lines of
 * assertions must not be part of that. `scripts/smoke.mjs` is the way to run it.
 *
 * ## Why from the inside
 *
 * It used to drive the built application from outside, over the DevTools protocol. A Chromium process
 * started with a debugging port open and driven over CDP is the standard technique for reading cookies
 * and saved passwords out of a browser, so endpoint protection flags that shape wherever it appears —
 * the checks were the collateral of a *driver* that looked like an attack. The four operations they
 * need have first-class equivalents inside the process; see `smoke-driver.mjs`.
 *
 * Returns the number of failed checks, which the core turns into its exit status.
 */

import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createDriver, mouse } from './smoke-driver.mjs'

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
async function declaredLayoutIds() {
  const source = await readFile('src/shared/split/layout.ts', 'utf8')
  const block = /export const LAYOUT_IDS = \[([\s\S]*?)\] as const/.exec(source)
  if (!block) throw new Error('could not find LAYOUT_IDS in layout.ts')
  const code = block[1].replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
  return (code.match(/'([^']+)'/g) ?? []).map((quoted) => quoted.slice(1, -1))
}

async function declaredLayoutCount() {
  return (await declaredLayoutIds()).length
}

/** How many checks were made, so the run reports what it covered and not only what broke. */
let checked = 0

function check(label, actual, expected) {
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  checked += 1
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label} -> ${JSON.stringify(actual)}`)
  if (!ok) failures.push(label)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Reads until the answer is the one being waited for, then returns it.
 *
 * The alternative — and what most of this file still does — is `await sleep(n)` with `n` chosen by
 * trying it. That is a stopwatch pretending to be a synchronisation primitive: it passes on a quiet
 * machine, fails on a busy one, and fails on a *different* check each time, which is what makes such a
 * test get ignored rather than fixed.
 *
 * Returns the last value read rather than throwing on timeout, on purpose: the caller's own assertion
 * is the better error message. "exactly one zone highlights -> 0" says what was wrong; "waitFor timed
 * out" says only that this helper gave up.
 */
const waitFor = async (read, isReady, { attempts = 25, every = 100 } = {}) => {
  let last = await read()
  for (let attempt = 1; attempt < attempts && !isReady(last); attempt += 1) {
    await sleep(every)
    last = await read()
  }
  return last
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
 * renderer, be positioned inside that layer, and a click on one of its items must actually
 * change the split layout in the core.
 */
async function runOverlayChecks(driver) {
  const { chromeEvaluate, overlayEvaluate: evaluate, overlayPresent } = driver
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

  /*
    The layer is created on first use, so this asks a real question rather than a timing one — and
    asks it without waiting: it is an object in this very process, where before it was an entry in a
    target list that had to be fetched and polled for.
  */
  if (!overlayPresent()) {
    check('overlay layer present once a surface is presented', false, true)
    return
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
  if (menu.present !== true) return

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
    `window.tessera.invoke('window:getState').then(() => document.querySelectorAll('.divider').length)`
  )
  check('choosing a layout changed the split in the core', layoutChanged, (v) => v !== 2)
}

/**
 * Dragging a tab into a tile, with synthesized mouse input.
 *
 * `sendInputEvent` goes through Chromium's own input pipeline, so this exercises the real
 * path: the pointer handlers in the tab strip, the threshold that separates a click from a
 * drag, the core's zone decision, and the drop reported by the overlay layer. A test that
 * called the IPC channels directly would prove the core works and say nothing about whether a
 * mouse can reach it — the mistake that let a dead dropdown ship.
 *
 * The gesture is split across two renderers on purpose, because that is how it really happens:
 * the tab strip sees the press, and the overlay sees the release once the pointer is over the
 * tiles.
 */
async function runTabDragChecks(driver) {
  const { chromeEvaluate, chromeSend, overlayEvaluate, overlaySend, overlayPresent } = driver

  // A single tile, so the drag has an edge zone to create a split with — which is how
  // someone first gets into split view.
  await chromeEvaluate(`window.tessera.invoke('split:setLayout', { layout: '1x1' })`)
  await chromeEvaluate(`window.tessera.invoke('tabs:create', { url: 'tessera://start' })`)
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

  /*
    Press, then move past the threshold — still inside the strip, so no tile is targeted yet.

    Not awaited, and there is nothing to await: `sendInputEvent` hands the event to the input pipeline
    and returns. Ordering is the pipeline's, and what the check below waits for is the state the
    events produced rather than their delivery.
  */
  chromeSend(mouse('down', setup.x, setup.y))
  chromeSend(mouse('move', setup.x + 24, setup.y))
  await sleep(700)

  const dragging = await chromeEvaluate(`document.querySelectorAll('.tab--dragging').length`)
  check('the tab strip reports a drag in progress', dragging, 1)

  if (!overlayPresent()) {
    check('overlay layer present during a drag', false, true)
    return
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
  check(
    'the indicator names the tab being moved',
    zones.status,
    (v) => typeof v === 'string' && v.length > 0
  )

  /*
    The promise the feature makes, asserted on the drawn rectangles: one preview covering the
    whole tile area, and two halves with the real gutter between them that together span it.
    Checked across all three zones rather than on whichever one is highlighted, because a
    synthesized event cannot move the operating system's cursor — the physical pointer is
    wherever the developer left it and legitimately highlights a zone of its own.
  */
  check('one preview covers the whole tile area', zones.rects, (rects) =>
    rects.some((r) => r.left === 0 && r.width === zones.viewportWidth)
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
  overlaySend(mouse('move', dropX, dropY))
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
  check(
    'the indicator says where it will open',
    highlighted.status,
    (v) => typeof v === 'string' && v.length > 0
  )
  // Whichever side the highlight is on, it is a real half rather than an approximate marker.
  // Which side it lands on is settled deterministically by the release below.
  check(
    'the highlight is one of the halves the page can occupy',
    highlighted,
    (h) => h.width > h.viewportWidth * 0.4 && h.width < h.viewportWidth * 0.6
  )

  overlaySend(mouse('up', dropX, dropY))
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
}

/**
 * Every drag possibility, in every layout, with a real mouse.
 *
 * The report this answers was "dragging onto the middle tile does not work", and the reason it
 * survived a green smoke test is that the drag checks only ever exercised `1x1`, `1+2` and `2x2` —
 * three layouts with no middle tile between them, aimed at one point each, chosen as a fraction of
 * the window. So the sweep is exhaustive instead: every layout, every zone it offers, aimed at the
 * *centre of that zone's own hit region*, which is the only way to be sure which zone was tested.
 *
 * ## Where the zones come from
 *
 * From the core, over the same `overlay:presented` event the chrome UI listens to. The rectangles the
 * indicator draws are the `preview`s, and the region that selects a zone is its `hit` — a different
 * rectangle, on purpose, and not in the DOM at all. Recomputing the geometry here would be a second
 * implementation of the thing the whole feature shares one implementation of.
 *
 * ## What is asserted, and why the second one is the interesting one
 *
 * That the page lands where the indicator promised — and that no page already on screen leaves it.
 * Eighteen of the twenty-four split zones used to fail the second: the layout change filled the tile
 * it had just created with the first loaded tab it found, so the page the drop displaced had nowhere
 * to go, and the user lost a page and gained an empty pane in one gesture. Both of the middle
 * column's zones were among them, which is what the report came down to.
 *
 * Five tabs are held open throughout, so that in every layout at least one is loaded but *not* in a
 * tile. Dropping that one is the case that used to fail; with a tab that already has a tile, the
 * tile it leaves behind absorbs the displacement and hides the defect.
 */
async function runEveryDragCheck(driver) {
  const { chromeEvaluate, chromeSend, overlayEvaluate, overlaySend, overlayPresent } = driver

  /*
    Two subscriptions in the chrome renderer, held for the whole sweep.

    The core is the only place that knows the hit regions and the tile assignment, and both travel as
    events it already sends. Reading them here is reading what the application actually decided,
    rather than a second opinion about it.
  */
  await chromeEvaluate(`(() => {
    window.__smokeStop?.forEach((off) => off())
    window.__smokeZones = null
    window.__smokeSplit = null
    window.__smokeStop = [
      window.tessera.on('overlay:presented', ({ presentation }) => {
        if (presentation !== null && presentation.kind === 'tab-drop') window.__smokeZones = presentation
      }),
      window.tessera.on('split:changed', (split) => {
        window.__smokeSplit = split
      })
    ]
    return 'ok'
  })()`)

  const strip = async () =>
    JSON.parse(
      await chromeEvaluate(`(() => {
        const tabs = [...document.querySelectorAll('[data-tab-id]')]
        return JSON.stringify(tabs.map((element) => {
          const box = element.getBoundingClientRect()
          return {
            id: element.getAttribute('data-tab-id'),
            tile: element.querySelector('.tab__tile')?.textContent ?? null,
            x: Math.round(box.x + box.width / 2),
            y: Math.round(box.y + box.height / 2)
          }
        }))
      })()`)
    )

  const splitState = async () =>
    JSON.parse(
      await chromeEvaluate(
        `window.tessera.invoke('window:getState').then(() => JSON.stringify(window.__smokeSplit))`
      )
    )

  const setLayout = async (layout) => {
    await chromeEvaluate(`window.tessera.invoke('split:setLayout', { layout: '${layout}' })`)
    await sleep(1100)
  }

  /** Back to the arrangement under test, skipping the round trip when it is already that one. */
  const ensureLayout = async (layout) => {
    const state = await splitState()
    if (state?.layout === layout) return
    await setLayout(layout)
  }

  // Enough tabs that no layout can hold all of them, so there is always one loaded and out of view.
  while ((await strip()).length < 5) {
    await chromeEvaluate(`window.tessera.invoke('tabs:create', { url: 'tessera://start' })`)
    await sleep(700)
  }

  /**
   * One drag, from the strip into one named zone.
   *
   * `zoneId` is null on the first pass, which is how the zone list is obtained in the first place:
   * the drag has to be live before the core has anything to report.
   */
  const dragInto = async (layout, zoneId) => {
    const tabs = await strip()
    // A tab that is loaded and has no tile. See the note above for why that is the one to drag.
    const dragged = tabs.find((tab) => tab.tile === null) ?? tabs[tabs.length - 1]
    if (dragged === undefined) {
      check(`${layout}: a tab exists to drag`, false, true)
      return null
    }

    chromeSend(mouse('down', dragged.x, dragged.y))
    chromeSend(mouse('move', dragged.x + 24, dragged.y))

    /*
      The layer, which the first press of the sweep is what creates.

      Asked on every pass rather than once, because it costs a lookup now instead of a WebSocket: the
      old version connected lazily and kept the connection, and a layer that had gone away between
      drags would have been read through a dead socket.
    */
    if (!overlayPresent()) {
      check(`${layout}: overlay layer present during a drag`, false, true)
      return null
    }

    /*
      Waited for, not slept through.

      A fixed 600 ms after the mouse moved was the whole of this sweep's flakiness. The drag has to
      travel to the core, be turned into zones and come back over `overlay:presented` before there is
      anything to read, and on a loaded machine that took longer than the guess — so a different zone
      failed on every run with "the core reports the zones for a live drag", which reads as a product
      fault and was a stopwatch. If they genuinely never arrive, the last read is still what the check
      below sees.
    */
    const presented = await waitFor(
      async () => JSON.parse(await chromeEvaluate(`JSON.stringify(window.__smokeZones)`)),
      (zones) => zones !== null
    )
    if (presented === null) {
      check(`${layout}: the core reports the zones for a live drag`, false, true)
      return null
    }

    const zone =
      zoneId === null ? null : presented.zones.find((candidate) => candidate.id === zoneId)
    if (zoneId !== null && zone === undefined) {
      check(`${layout}: zone ${zoneId} is still offered`, false, true)
      // Let go somewhere harmless rather than leaving the drag live for the next check.
      chromeSend(mouse('up', dragged.x, dragged.y))
      await sleep(600)
      return null
    }

    if (zone === null) {
      // Reconnaissance pass: nothing dropped, so release over the strip, which cancels the tile drag.
      chromeSend(mouse('up', dragged.x, dragged.y))
      await sleep(700)
      return presented.zones
    }

    const dropX = Math.round(zone.hit.x + zone.hit.width / 2)
    const dropY = Math.round(zone.hit.y + zone.hit.height / 2)
    overlaySend(mouse('move', dropX, dropY))

    /*
      The highlight, checked here and not only after the drop, and checked as a *rectangle*.

      Two zones leading to one tile drew two identical previews one over the other, so the active
      rectangle was painted underneath its own twin and the pointer produced no visible feedback at
      all. A count of one cannot see that, because both elements are really there and only one of
      them carries the class. So: one highlight, its box is the rectangle the page will occupy, and
      nothing else is drawn in the same place.
    */
    const readHighlight = async () =>
      JSON.parse(
        await overlayEvaluate(`(() => {
        const all = [...document.querySelectorAll('.dropzone')]
        const box = (element) => {
          const b = element.getBoundingClientRect()
          return { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
        }
        const active = all.filter((element) => element.classList.contains('dropzone--active'))
        const rect = active.length === 0 ? null : box(active[0])
        const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
        return JSON.stringify({
          active: active.length,
          rect,
          drawnThere: rect === null ? 0 : all.filter((element) => same(box(element), rect)).length
        })
      })()`)
      )

    /*
      Same reason as above: the overlay has to re-render before the class is on an element. Waiting for
      the highlight to appear rather than for 350 ms — and if it never appears, the last read is what
      the assertions below see, so the failure still says what actually happened.
    */
    const highlighted = await waitFor(readHighlight, (state) => state.active > 0)

    const promised = {
      x: Math.round(zone.preview.x),
      y: Math.round(zone.preview.y),
      width: Math.round(zone.preview.width),
      height: Math.round(zone.preview.height)
    }
    check(
      `${layout} ${zone.id}: exactly one zone highlights under the pointer`,
      highlighted.active,
      1
    )
    check(
      `${layout} ${zone.id}: the highlight is the rectangle the page will occupy`,
      highlighted.rect,
      (rect) => rect !== null && JSON.stringify(rect) === JSON.stringify(promised)
    )
    check(
      `${layout} ${zone.id}: nothing identical is drawn over the highlight`,
      highlighted.drawnThere,
      1
    )

    overlaySend(mouse('up', dropX, dropY))
    await sleep(1000)

    const after = await splitState()
    const stillDragging = await chromeEvaluate(`document.querySelectorAll('.tab--dragging').length`)
    const shown = after.tileTabIds.filter((id) => id !== null)
    const tabCount = tabs.length

    check(
      `${layout} ${zone.id}: the layout is the one the zone named`,
      after.layout,
      zone.layout ?? layout
    )
    check(
      `${layout} ${zone.id}: the page landed in the tile the indicator promised`,
      after.tileTabIds[zone.tileIndex],
      dragged.id
    )
    // A shortfall here is a page pushed off the screen while a pane stood empty, which is both
    // halves of the reported bug in one number.
    check(
      `${layout} ${zone.id}: every pane that could hold a page holds one`,
      shown.length,
      Math.min(tabCount, after.tileTabIds.length)
    )
    check(`${layout} ${zone.id}: the drag is over`, stillDragging, 0)
    return null
  }

  for (const layout of await declaredLayoutIds()) {
    await setLayout(layout)
    /*
      Read before the reconnaissance drag, not after.

      That drag presses and releases on a tab, and a press and release on a tab is also a *click* —
      which activates it, and activating a tab that has no tile now gives it the whole window. So by
      the time the drag is over the layout is a single tile again, which is correct behaviour and the
      wrong moment to count tiles.
    */
    const tiles = (await splitState()).tileTabIds.length
    const zones = await dragInto(layout, null)
    if (zones === null) continue

    check(
      `${layout}: every tile offers a plain drop`,
      zones.filter((zone) => zone.layout === null).length,
      tiles
    )
    check(
      `${layout}: no two zones lead to the same tile`,
      new Set(zones.map((zone) => `${zone.layout}#${zone.tileIndex}`)).size,
      zones.length
    )

    for (const zone of zones) {
      // Back to the arrangement under test: the last drop may well have changed it.
      await ensureLayout(layout)
      await dragInto(layout, zone.id)
    }
  }
}

/**
 * The layout follows the tabs in it.
 *
 * Two complaints, one idea. Choosing a four-tile layout with one tab left three panes reading
 * "drag a tab here" — an instruction rather than a browser. And closing a tab left its pane
 * behind, empty, waiting. Growing fills; closing takes the tile away again.
 *
 * The third was separate: a new tab in a split layout replaced whatever was in front of the user,
 * because it took the *active* tile while empty panes sat beside it. Giving it an empty pane fixed
 * that, and has since been reversed on purpose — a new tab now takes the whole window. The last
 * three checks here are the ones that say the reversal did not bring the first complaint back with
 * it: no pane is left empty, and nothing the user was looking at is closed.
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
    await chromeEvaluate(`window.tessera.invoke('split:setLayout', { layout: '${layout}' })`)
    await sleep(1800)
  }
  const setAdapt = async (value) => {
    await chromeEvaluate(
      `window.tessera.invoke('settings:set', { key: 'splitView.adaptLayoutToTabs', value: ${value} })`
    )
    await sleep(400)
  }
  const closeAllButFirst = async () => {
    await chromeEvaluate(
      `(async () => {
         const ids = [...document.querySelectorAll('[data-tab-id]')].map((e) => e.getAttribute('data-tab-id'))
         for (const id of ids.slice(1)) await window.tessera.invoke('tabs:close', { tabId: id })
         return 'done'
       })()`
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
     })()`
  )
  await sleep(1800)
  const afterClose = await probe()
  check('closing the last tab of a pane takes the pane away', afterClose.dividers, 0)
  check('the other tab is still there', afterClose.tabs, 1)

  /*
    A new tab is a new tab: it gets the window, not a pane.

    Two things have to hold at once, and they are the two the earlier decision bought. The split goes
    away — otherwise a tab that lands in a quarter of the window is not what anybody means by "new
    tab" — and it must take nothing with it: no pane left empty behind it, and every page that was on
    screen still open in the strip.
  */
  /*
    Three tabs the *user* opened, filling three panes.

    Not the fillers a layout change would have opened: an untouched filler that loses its tile is
    closed on purpose, and with fillers in the panes "nothing was closed" would be checking the
    exception rather than the rule.
  */
  for (let opened = 0; opened < 2; opened++) {
    await chromeEvaluate(`window.tessera.invoke('tabs:create', { url: 'tessera://start' })`)
    await sleep(800)
  }
  await setLayout('1x3')
  const beforeNew = await probe()
  check(
    'three panes hold three pages before the new tab',
    beforeNew.badges.filter((b) => b !== null).length,
    3
  )
  check('and none of them is a filler', beforeNew.tabs, 3)

  await chromeEvaluate(`window.tessera.invoke('tabs:create', {})`)
  await sleep(1600)
  const withNew = await probe()
  check('a new tab collapses the split to a single pane', withNew.dividers, 0)
  check('nothing was closed to make room for it', withNew.tabs, beforeNew.tabs + 1)

  /*
    And the way back, which is the half that makes the collapse acceptable.

    Putting the panes away loses nothing only if the arrangement can be returned to, and the thing that
    carries it is the tab group the displaced pages were put into. So this is the loop a person
    actually performs — look at something in a fresh tab, then go back to what you had — and it is
    asserted three times over, because the interesting failure is not the first restore but the second.

    The state this starts from is the one the collapse above produced: three pages that were in `1x3`
    are now grouped and tile-less, and the new tab holds the single pane.
  */
  const activate = async (tabId) => {
    await chromeEvaluate(`window.tessera.invoke('tabs:activate', { tabId: '${tabId}' })`)
    await sleep(1400)
  }
  /*
    Which tab sits in which tile, from the core's own `split:changed` rather than from the strip.

    Not the `.tab__tile` badge: the strip draws it only while `tileCount > 1`, deliberately, because a
    "tile 1" chip on the one tab of a single pane names a mapping there is nothing to map. So in exactly
    the state this section is about — the window collapsed to one pane — the badge is absent for a tab
    that *does* have a tile, and a check reading it concludes the opposite of the truth.
  */
  const tiles = async () => {
    const state = JSON.parse(await chromeEvaluate(`JSON.stringify(window.__smokeSplit ?? null)`))
    if (state === null) return null
    return state.tileTabIds
  }
  const seated = async () => (await tiles())?.filter((id) => id !== null) ?? []

  const inTiles = await seated()
  check('the collapse left the new tab in the one pane', inTiles.length, 1)

  const strip0 = await chromeEvaluate(`(() => JSON.stringify(
    [...document.querySelectorAll('[data-tab-id]')].map((e) => e.getAttribute('data-tab-id'))
  ))()`)
  const [ungrouped] = inTiles
  const member = JSON.parse(strip0).find((id) => id !== ungrouped)
  if (member === undefined || ungrouped === undefined) {
    check('the collapse left a group member and a loose tab to click', false, true)
  } else {
    await activate(member)
    const restored = await probe()
    check('going back to a displaced page brings its arrangement back', restored.dividers, 2)
    check('with every page of it seated again', (await seated()).length, 3)
    check('and nothing opened or closed on the way', restored.tabs, withNew.tabs)

    /*
      The tab that was never part of the arrangement still gets the window. Same click, opposite
      answer — which is the whole reason the recording sits on the group rather than on the window: a
      window-wide "last layout" would restore it for this tab too.
    */
    await activate(ungrouped)
    const alone = await probe()
    check('a tab with no arrangement behind it still gets the window', alone.dividers, 0)

    /*
      And again. The recording is spent by the restore above, so the second return can only work if
      *this* displacement was recorded too — on the group that already existed, rather than on a
      second one. A version that recorded once would pass every check up to here.
    */
    await activate(member)
    const again = await probe()
    check('the arrangement survives being displaced a second time', again.dividers, 2)
    check('with its pages seated once more', (await seated()).length, 3)
  }

  /*
    With adaptation off the arrangement is the user's to keep, and there the earlier rule stands
    unchanged: a new tab takes an empty pane rather than the one in use. Adaptation is switched off to
    *create* an empty pane, which is the only state where the choice is observable.

    Back to one tab first. The checks below count panes and tabs against each other, and the section
    above deliberately leaves four tabs and a restored arrangement behind — reading those numbers as
    "an empty pane was filled" would be reading the previous block's leftovers.
  */
  await closeAllButFirst()
  await setAdapt(false)
  await setLayout('2x2')
  const emptyPanes = await probe()
  check('with adaptation off, panes stay empty', emptyPanes.tabs, 1)

  const occupied = emptyPanes.badges.find((badge) => badge !== null)
  await chromeEvaluate(`window.tessera.invoke('tabs:create', {})`)
  await sleep(1600)
  const added = await probe()
  check('the new tab was added, not swapped in', added.tabs, 2)
  check(
    'the new tab took an empty pane instead of the one in use',
    added.badges.filter((badge) => badge !== null).length,
    2
  )
  check('the pane that was already in use kept its tab', added.badges.includes(occupied), true)

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
    await chromeEvaluate(`window.tessera.invoke('history:query', {}).then((v) => v.length)`)
  )

  // The built chrome page itself: a real address, reachable without a network.
  const target = `file://${process.cwd()}/out/renderer/index.html`
  await chromeEvaluate(
    `window.tessera.invoke('nav:navigate', { input: ${JSON.stringify(target)} })`
  )
  await sleep(2000)

  const entries = JSON.parse(
    await chromeEvaluate(
      `window.tessera.invoke('history:query', {}).then((v) => JSON.stringify(v))`
    )
  )
  check('a visit was recorded', entries.length, (n) => n > before)

  const recorded = entries.find((entry) => entry.url.startsWith('file://'))
  check('the recorded entry keeps its address', recorded !== undefined, true)
  if (recorded !== undefined) {
    check('the entry carries a visit count', recorded.visitCount, (n) => n >= 1)
    check(
      'the entry carries a first and last time',
      recorded,
      (e) => typeof e.firstVisitedAt === 'number' && typeof e.lastVisitedAt === 'number'
    )
  }

  // Searching is what the address bar will use; an entry that cannot be found is not useful.
  const found = Number(
    await chromeEvaluate(
      `window.tessera.invoke('history:query', { text: 'renderer' }).then((v) => v.length)`
    )
  )
  check('the entry can be found by searching its address', found, (n) => n >= 1)

  const removed = Number(
    await chromeEvaluate(
      `window.tessera.invoke('history:removeVisit', { url: ${JSON.stringify(target)} }).then((r) => r.removed)`
    )
  )
  check('removing an entry reports how many went', removed, (n) => n >= 1)

  const after = Number(
    await chromeEvaluate(`window.tessera.invoke('history:query', {}).then((v) => v.length)`)
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
async function runTileFocusChecks(driver) {
  const { chromeEvaluate } = driver
  // Establish the precondition rather than assume it: earlier checks leave the active tile
  // wherever they happened to leave it, and a test that depends on that is a test that fails
  // for the wrong reason the next time one is added.
  await chromeEvaluate(`window.tessera.invoke('split:setActiveTile', { tileIndex: 0 })`)
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

  // Given its own address so this tile's view can be told from the other's; both were showing
  // the start page.
  await chromeEvaluate(
    `window.tessera.invoke('nav:navigate', { input: 'about:blank', tabId: '${inSecondTile.id}' })`
  )
  await sleep(1200)

  const tile = driver.page((url) => url === 'about:blank')
  if (tile === null) {
    check('the second tile has a view of its own', false, true)
    return
  }

  // Into the *page*, not into the chrome: the whole point is that a click landing on a native view
  // is one the chrome renderer never sees, and that the core notices it anyway.
  tile.send(mouse('down', 60, 60))
  tile.send(mouse('up', 60, 60))
  await sleep(1000)

  const nowActive = await chromeEvaluate(
    `document.querySelector('[data-tab-id="${inSecondTile.id}"]')?.getAttribute('aria-selected')`
  )
  check('clicking into a tile makes its tab the active one', nowActive, 'true')

  // And therefore the toolbar addresses that tab: the core resolves "no tabId given" to the
  // active tile, which is the whole chain the back button depends on.
  const resolved = await chromeEvaluate(
    `window.tessera.invoke('nav:getBackForwardList', {}).then((list) => list.length >= 1)`
  )
  check('the toolbar resolves navigation against the focused tile', resolved, true)

  /*
    Put the tab back where it was found.

    This check navigates a tile to `about:blank` so its view can be told apart from the other, and for a
    long time it left it there. Two checks further down then failed intermittently — the start-page checks
    look for a tab still on `tessera://start`, and between this one and the history check, which also
    navigates a tab away, sometimes none was left. The failure showed up as "start page present -> false",
    which points at the start page and not at the check that consumed it.
  */
  await chromeEvaluate(
    `window.tessera.invoke('nav:navigate', { input: 'tessera://start', tabId: '${inSecondTile.id}' })`
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
async function runHistoryPageChecks(driver) {
  const { chromeEvaluate } = driver
  await chromeEvaluate(`window.tessera.invoke('tabs:create', { url: 'tessera://history' })`)
  await sleep(2500)

  const page = driver.page((url) => url.startsWith('tessera://history'))
  if (page === null) {
    check('the history page is served', false, true)
    return
  }
  const evaluate = page.evaluate

  check(
    'the history page renders its own heading',
    await evaluate(`document.querySelector('.history__title')?.textContent ?? null`),
    (v) => typeof v === 'string' && v.length > 0
  )

  const bridge = await evaluate(`typeof window.tesseraInternal === 'object'`)
  check('the history page has the internal bridge', bridge, true)

  const fullBridgeAbsent = await evaluate(`typeof window.tessera === 'undefined'`)
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
  for (const channel of [
    'quicklinks:list',
    'settings:set',
    'settings:getAll',
    'tabs:close',
    'overlay:present'
  ]) {
    const outcome = await evaluate(
      `window.tesseraInternal.invoke('${channel}', {}).then(() => 'RESOLVED').catch(() => 'REJECTED')`
    )
    check(`the history page may not call ${channel}`, outcome, 'REJECTED')
  }

  const eventRefused = await evaluate(
    `(() => { try { window.tesseraInternal.on('settings:changed', () => {}); return 'ALLOWED' }
              catch { return 'REJECTED' } })()`
  )
  check("the history page may not subscribe to another page's events", eventRefused, 'REJECTED')
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
      response.writeHead(200, {
        'content-type': 'image/png',
        'content-length': ONE_PIXEL_PNG.length
      })
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
      `window.tessera.invoke('tabs:create', { url: ${JSON.stringify(site.origin + '/')} })`
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
    })`)
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
  await chromeEvaluate(`window.tessera.invoke('split:setLayout', { layout: '1x2' })`)
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
       .then((g) => JSON.stringify(g)).catch((e) => 'ERROR: ' + e.message)`
  )
  check(
    'a group can be created through the contract',
    created,
    (v) => !String(v).startsWith('ERROR')
  )
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
    `window.tessera.invoke('tabgroups:setCollapsed', { id: ${JSON.stringify(group.id)}, collapsed: true })`
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
  check(
    'the folded tabs are no longer drawn',
    folded.drawn,
    (drawn) => !drawn.includes(first) && !drawn.includes(second)
  )
  check(
    'a folded tab no longer holds a tile',
    folded.tileBadges,
    (n) => n <= Math.max(0, folded.drawn.length)
  )

  // Unfold, then dissolve: the tabs must still be there and still be open.
  await chromeEvaluate(
    `window.tessera.invoke('tabgroups:setCollapsed', { id: ${JSON.stringify(group.id)}, collapsed: false })`
  )
  await sleep(700)
  await chromeEvaluate(
    `window.tessera.invoke('tabgroups:dissolve', { id: ${JSON.stringify(group.id)} })`
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
  check(
    'dissolving keeps every tab open',
    after.drawn,
    (drawn) => drawn.includes(first) && drawn.includes(second)
  )

  // An internal page must not reach any of this: a group decides which tabs are visible.
  const refused = await chromeEvaluate(
    `window.tessera.invoke('tabgroups:create', { tabIds: ['nope'] })
       .then(() => 'RESOLVED').catch(() => 'REJECTED')`
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
      `window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s)).catch((e) => JSON.stringify({ error: e.message }))`
    )
  )

  check('the blocker reports its status through the contract', status.error, undefined)
  if (status.error !== undefined) {
    console.error('   ', status.error)
    return
  }

  // Four lists on a fresh profile: adverts, trackers, cookie banners, anti-adblock.
  check('every configured list is counted', status.configured, (n) => n >= 4)
  check(
    'the diagnostics carry the parser counters',
    status.diagnostics,
    (d) => d !== undefined && typeof d.lines === 'number' && typeof d.unsupported === 'number'
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
    `window.tessera.invoke('settings:set', { key: 'privacy.blockerEnabled', value: false })`
  )
  await sleep(900)
  const off = JSON.parse(
    await chromeEvaluate(
      `window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s))`
    )
  )
  check('switching the blocker off leaves no rules compiled', off.networkRules, 0)
  check('switching the blocker off configures no lists', off.configured, 0)

  await chromeEvaluate(
    `window.tessera.invoke('settings:set', { key: 'privacy.blockerEnabled', value: true })`
  )
  await sleep(900)
  const backOn = JSON.parse(
    await chromeEvaluate(
      `window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s))`
    )
  )
  check('switching it back on restores the configured lists', backOn.configured, (n) => n >= 4)

  // An internal page must not be able to reach the blocker's controls.
  const refused = await chromeEvaluate(
    `window.tessera.invoke('filters:notARealChannel').then(() => 'RESOLVED').catch(() => 'REJECTED')`
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
async function runInternalPageChecks(driver) {
  const { chromeEvaluate } = driver
  for (const page of ['settings', 'extensions']) {
    await chromeEvaluate(`window.tessera.invoke('tabs:create', { url: 'tessera://${page}' })`)
  }
  // Long enough for two documents to load and for each to fetch its catalogue and its data.
  await sleep(2500)

  for (const page of ['settings', 'extensions']) {
    const target = driver.page((url) => url.startsWith(`tessera://${page}`))
    check(`tessera://${page} is served`, target !== null, true)
    if (target === null) continue
    const evaluate = target.evaluate

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
    const modal = await evaluate(
      `document.querySelector('.panel')?.getAttribute('aria-modal') ?? 'absent'`
    )
    check(`the ${page} page does not claim to be a modal dialogue`, modal, 'absent')

    // And no backdrop, which on a page would be an invisible layer swallowing clicks.
    const backdrop = await evaluate(`document.querySelectorAll('.overlay').length`)
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
  }
}

/** Opens a tab on the start page, through the chrome UI's own channel. */
async function openStartTab(chromeEvaluate) {
  await chromeEvaluate(`window.tessera.invoke('tabs:create', { url: 'tessera://start' })`)
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
      `window.tessera.invoke('filters:getStatus').then((s) => JSON.stringify(s))`
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

async function runStartPageChecks(driver, visitedOrigin) {
  /*
    The start page specifically, not the first internal page that turns up.

    This used to match any `tessera://` page, which was fine while there was only one. Adding
    the history page made it pick that instead — and the checks below then asked the *history* page
    to create a quick link, which the per-page allowlist correctly refused. A latent bug that only
    a second internal page could reveal, and the refusal it produced was the model working.
  */
  const isStart = (url) => url.startsWith('tessera://start')
  let start = driver.page(isStart)
  if (start === null) {
    /*
      Open one rather than fail.

      These checks are about what an internal page may and may not do, not about whether an earlier
      check happened to leave a start tab open. Depending on that made this report a missing start page
      when the real cause was a different check navigating one away — a failure that names the wrong
      thing is worse than no failure at all.
    */
    await openStartTab(driver.chromeEvaluate)
    start = driver.page(isStart)
  }
  if (start === null) {
    check('start page present', false, true)
    return
  }
  const evaluate = start.evaluate

  const bridgePresent = await evaluate(`typeof window.tesseraInternal === 'object'`)
  check('internal bridge is exposed to an tessera:// page', bridgePresent, true)

  const fullBridgeAbsent = await evaluate(`typeof window.tessera === 'undefined'`)
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
  const tiles = await evaluate(`document.querySelectorAll('.tile').length`)
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
    })()`)
  )

  check('a visited page gets a screenshot on its card', cardPicture.present, true)
  if (cardPicture.present) {
    check('the screenshot address is versioned', cardPicture.src, (v) => /[?&]v=/.test(v))
    check(
      'the screenshot bytes reached the start page and decoded',
      cardPicture.width,
      (n) => n > 0
    )
    // 8:5, from `THUMBNAIL_TARGET`. A picture stored at another ratio would be cropped twice.
    check(
      'the screenshot has card proportions',
      cardPicture,
      (shot) => Math.abs(shot.width / shot.height - 8 / 5) < 0.02
    )
    check('the screenshot is styled as a screenshot, not as an icon', cardPicture.className, (v) =>
      v.includes('tile__picture--thumbnail')
    )
  } else {
    console.error(
      '    no screenshot on any card; sources were:',
      JSON.stringify(cardPicture.sources)
    )
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
              catch { return 'REJECTED' } })()`
  )
  check('an internal page may not subscribe to chrome events', eventRefused, 'REJECTED')

  // Clean up so repeated runs start from the same place.
  await evaluate(
    `window.tesseraInternal.invoke('quicklinks:list')
       .then((links) => Promise.all(links.map((l) =>
         window.tesseraInternal.invoke('quicklinks:remove', { id: l.id }))))
       .then(() => 'done')`
  )
}

/**
 * Every check, in the order they have to run in.
 *
 * The order is not incidental: each section leaves the window in a state the next one relies on, and
 * the comments at the seams say which. `handles` is what the core passes in — see `smoke-driver.mjs`
 * for the four operations built from it.
 */
export async function run(handles) {
  const driver = createDriver(handles)
  const { chromeEvaluate: evaluate } = driver

  /*
    One throwaway site for the whole run, started before anything is driven.

    Held at this level rather than inside a single check because two of them need it: the tab strip's
    icon comes from visiting it, and the start-page card's screenshot is a picture of that same visit —
    taken a second and a half later, by which time a server owned by the earlier check would be shut.
  */
  const iconSite = await startIconSite()

  try {
    /*
      The first tab's address, waited for rather than read once.

      A view's web contents exists before its navigation has committed, and `getURL` answers with what
      has committed — so read immediately this is empty for a page that is on its way. Waiting for the
      address is waiting for the state the check is about; the last read is what the check sees either
      way, so a page that never arrives still fails here rather than somewhere later.
    */
    const startPage = await waitFor(
      () => driver.urls().find((url) => url.startsWith('tessera://')) ?? null,
      (url) => url !== null
    )
    check(
      'internal tessera:// scheme serves the start page',
      startPage,
      (v) => typeof v === 'string' && v.startsWith('tessera://start')
    )

    /*
      A renderer exists as soon as its web contents does, which is before React has rendered anything
      into it. Without this wait the first probe measures an empty document and reports a dozen failures
      that say nothing about the build.

      The first tab is waited for as well as the chrome, because it arrives separately: the chrome
      renders as soon as its bundle runs, and the tab only once the core has broadcast its state. Waiting
      for the frame alone left "a tab is rendered" failing whenever the machine was busy.
    */
    await waitFor(
      () =>
        evaluate(
          `document.querySelector('.chrome') !== null && document.querySelectorAll('.tab').length > 0`
        ),
      (ready) => ready === true,
      { attempts: 40, every: 250 }
    )

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
    await evaluate(`window.tessera.invoke('split:setLayout', { layout: '2x2' })`)
    await sleep(1200)
    const after = JSON.parse(await evaluate(PROBE))
    check('2x2 layout produces two dividers', after.dividerCount, 2)
    check('the chrome DOM still holds no menu', after.menusInChrome, 0)

    await runOverlayChecks(driver)
    await runTabDragChecks(driver)
    await runEveryDragCheck(driver)
    await runLayoutAdaptationChecks(evaluate)
    await runTileFocusChecks(driver)
    await runHistoryChecks(evaluate)
    await runHistoryPageChecks(driver)
    await runFaviconChecks(evaluate, iconSite.origin)
    await runTabGroupChecks(evaluate)
    await runFilterChecks(evaluate)
    await runInternalPageChecks(driver)

    // Spec 5: an unknown key must fail visibly rather than being dropped.
    const unknownKey = await evaluate(
      `window.tessera.invoke('settings:set', { key: 'appearance.definitelyNotAKey', value: 1 })
       .then(() => 'RESOLVED').catch((e) => 'REJECTED')`
    )
    check('unknown settings key is rejected, not swallowed', unknownKey, 'REJECTED')

    // Spec 5: an out-of-range value must fail too.
    const badValue = await evaluate(
      `window.tessera.invoke('settings:set', { key: 'appearance.defaultZoom', value: 9999 })
       .then(() => 'RESOLVED').catch((e) => 'REJECTED')`
    )
    check('out-of-range setting value is rejected', badValue, 'REJECTED')

    // A valid write must take effect and be readable back.
    await evaluate(
      `window.tessera.invoke('settings:set', { key: 'appearance.theme', value: 'dark' })`
    )
    const readBack = await evaluate(
      `window.tessera.invoke('settings:getAll').then((s) => s['appearance.theme'])`
    )
    check('valid setting is stored and readable', readBack, 'dark')

    // Channel names outside the allowlist must not reach the core.
    const rejectedChannel = await evaluate(
      `window.tessera.invoke('settings:notARealChannel')
       .then(() => 'RESOLVED').catch(() => 'REJECTED')`
    )
    check('unknown channel is refused by the preload allowlist', rejectedChannel, 'REJECTED')

    // --- the start page, driven through its own narrow bridge -------------------
    await runStartPageChecks(driver, iconSite.origin)
  } catch (error) {
    /*
      Recorded as a failure rather than rethrown, and that is the difference between a verdict and a
      stack trace. An expression that throws inside a renderer now rejects here — the debugging
      protocol answered `undefined` instead — so this is also where a genuine defect in the checks
      themselves surfaces, and it has to be counted.
    */
    console.error('check run error:', error)
    failures.push(String(error))
  } finally {
    iconSite.server.close()
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} of ${checked} check(s) failed:`)
    for (const failure of failures) console.error(`  - ${failure}`)
  } else {
    console.log(`\nAll ${checked} checks passed.`)
  }
  return failures.length
}
