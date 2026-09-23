import type { SwipeIndicator } from '@shared/gestures/wheel-swipe.js'

/**
 * The arrow that slides in from the edge while a two-finger swipe is under way.
 *
 * What it shows is decided in `swipeIndicatorOf`; this is only the drawing, and two properties of it
 * are not decoration.
 *
 * ## Why every style is inline
 *
 * A `<style>` element is what a page's Content Security Policy can refuse, and on a site with a
 * strict `style-src` the arrow would silently never appear. Declarations set through the CSSOM are
 * not subject to it. The same inline `!important` on the host that `autofill.ts` relies on keeps the
 * page's own rules from moving it.
 *
 * ## Why it is removed rather than hidden
 *
 * It lives in a document that is not ours. An element left behind after the gesture is one more
 * thing a page's `body > div` rule can restyle, a `MutationObserver` can count, and the
 * back-forward cache can freeze into a snapshot — so it exists only while there is something to see.
 */

const HOST_ID = 'tessera-swipe'
const SIZE_PX = 44
/** How far in from the edge the arrow comes to rest at the threshold. */
const INSET_PX = 16
/** Long enough for the slide-out to be seen, short enough that nothing waits on it. */
const EXIT_MS = 160

const COLORS = {
  light: { bubble: '#ffffff', arrow: '#1b1b1f', armed: '#2563eb', armedArrow: '#ffffff' },
  dark: { bubble: '#202024', arrow: '#e6e6ea', armed: '#6da8ff', armedArrow: '#17171a' }
} as const

export interface SwipeIndicatorView {
  /** Moves the arrow to a state, or slides it out for `null`. */
  show(indicator: SwipeIndicator | null): void
  /** Takes it down at once, without the slide — the page is going away. */
  dispose(): void
}

interface Mounted {
  readonly host: HTMLElement
  readonly bubble: HTMLElement
  readonly arrow: SVGSVGElement
}

export function createSwipeIndicator(): SwipeIndicatorView {
  let mounted: Mounted | null = null
  let removal: ReturnType<typeof setTimeout> | undefined

  const dispose = (): void => {
    clearTimeout(removal)
    mounted?.host.remove()
    mounted = null
  }

  return {
    dispose,
    show(indicator) {
      if (indicator === null) {
        if (mounted === null || removal !== undefined) return
        mounted.bubble.style.opacity = '0'
        mounted.bubble.style.transform = offscreen(mounted.host.style.left === '0px' ? -1 : 1)
        removal = setTimeout(() => {
          removal = undefined
          dispose()
        }, EXIT_MS)
        return
      }
      clearTimeout(removal)
      removal = undefined
      mounted ??= mount()
      if (mounted !== null) draw(mounted, indicator)
    }
  }
}

function mount(): Mounted | null {
  // `documentElement` rather than `body`: a gesture can outlive a `<body>` a page replaced.
  const parent = (
    document as Omit<Document, 'documentElement'> & { documentElement: HTMLElement | null }
  ).documentElement
  if (parent === null) return null
  document.getElementById(HOST_ID)?.remove()

  const host = document.createElement('div')
  host.id = HOST_ID
  for (const [property, value] of [
    ['all', 'initial'],
    ['position', 'fixed'],
    ['top', '50%'],
    ['width', '0'],
    ['height', '0'],
    ['pointer-events', 'none'],
    ['z-index', '2147483647']
  ] as const) {
    host.style.setProperty(property, value, 'important')
  }
  // `closed`, like autofill: nothing in here is the page's to read or restyle.
  const root = host.attachShadow({ mode: 'closed' })

  const bubble = document.createElement('div')
  Object.assign(bubble.style, {
    position: 'absolute',
    top: `${-SIZE_PX / 2}px`,
    width: `${SIZE_PX}px`,
    height: `${SIZE_PX}px`,
    borderRadius: '50%',
    display: 'grid',
    placeItems: 'center',
    boxShadow: '0 2px 10px rgb(0 0 0 / 0.28)',
    opacity: '0',
    transition: reducedMotion()
      ? 'opacity 120ms linear, background-color 120ms linear'
      : 'transform 90ms ease-out, opacity 90ms linear, background-color 120ms linear'
  })

  // Built node by node rather than from markup: a page that enforces Trusted Types refuses `innerHTML`.
  const svgNs = 'http://www.w3.org/2000/svg'
  const arrow = document.createElementNS(svgNs, 'svg')
  arrow.setAttribute('viewBox', '0 0 24 24')
  arrow.setAttribute('width', '22')
  arrow.setAttribute('height', '22')
  const path = document.createElementNS(svgNs, 'path')
  path.setAttribute('d', 'M20 12H5M11 5l-7 7 7 7')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '2.4')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  arrow.appendChild(path)

  bubble.appendChild(arrow)
  root.appendChild(bubble)
  parent.appendChild(host)
  return { host, bubble, arrow }
}

function draw({ host, bubble, arrow }: Mounted, indicator: SwipeIndicator): void {
  const left = indicator.side === 'left'
  host.style.setProperty('left', left ? '0px' : 'auto', 'important')
  host.style.setProperty('right', left ? 'auto' : '0px', 'important')
  bubble.style.left = left ? '0' : ''
  bubble.style.right = left ? '' : '0'
  arrow.style.transform = left ? '' : 'scaleX(-1)'

  const palette = matchMedia('(prefers-color-scheme: dark)').matches ? COLORS.dark : COLORS.light
  bubble.style.backgroundColor = indicator.armed ? palette.armed : palette.bubble
  bubble.style.color = indicator.armed ? palette.armedArrow : palette.arrow

  const { progress } = indicator
  bubble.style.opacity = String(Math.min(1, 0.25 + progress))
  if (reducedMotion()) {
    // Where it would come to rest, and only fading: the arrow still says how far, without moving.
    bubble.style.transform = `translateX(${left ? INSET_PX : -INSET_PX}px)`
    return
  }
  // From just behind the edge to its resting place, growing on the way; a small pop once armed.
  const travel = -SIZE_PX + progress * (SIZE_PX + INSET_PX)
  const scale = indicator.armed ? 1.12 : 0.7 + 0.3 * progress
  bubble.style.transform = `translateX(${left ? travel : -travel}px) scale(${scale})`
}

function offscreen(side: -1 | 1): string {
  return `translateX(${side * SIZE_PX}px) scale(0.7)`
}

function reducedMotion(): boolean {
  return matchMedia('(prefers-reduced-motion: reduce)').matches
}
