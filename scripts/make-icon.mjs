/**
 * Application icon generator.
 *
 *   node scripts/make-icon.mjs
 *
 * Writes `build/icon.png` (1024x1024 master), `build/icons/<n>x<n>.png` (the Linux
 * set electron-builder installs into hicolor) and `build/icon.svg` (a readable copy
 * of the same motif, for a human who wants to redraw it in a vector editor).
 *
 * ## Why a generator instead of a drawn file
 *
 * The product name is not decided yet — `src/shared/product.ts` says so — and the
 * icon is a placeholder that exists so the application stops shipping Electron's
 * default. A checked-in bitmap from an image editor cannot be re-derived: when the
 * name and the palette are settled, someone has to open the editor again and repeat
 * whatever they did, at seven sizes. A script is the change history plus the
 * regeneration, in one file: edit the constants below, run one command, every size
 * is consistent again.
 *
 * ## Why no dependency
 *
 * `scripts/metrics.mjs` caps runtime dependencies at 8 and treats every one as
 * shipped code plus supply-chain surface. An icon is not worth `sharp` or `canvas`,
 * and neither is a devDependency that only exists so a placeholder can be drawn.
 * Node alone is enough: `node:zlib` does the only hard part of PNG (deflate), and a
 * PNG file is otherwise a signature plus three length/type/CRC-framed chunks.
 *
 * ## Why the split view is the motif
 *
 * A rounded badge with one wide pane on the left and two stacked panes on the right
 * is the `1+2` layout from `src/shared/split/layout.ts`, in the same proportions the
 * in-app `LayoutIcon` component draws it. It says what this browser does differently
 * in one glance, and it survives being 16 pixels wide, which a wordmark would not —
 * conveniently, since there is no settled word to mark it with.
 *
 * ## How the rasteriser works
 *
 * There is no path filler here, only an inside/outside test. Every shape is a
 * rounded rectangle, and a point is inside one when its distance to the nearest
 * point of the rectangle's corner-inset core is at most the corner radius — six
 * lines, no curve flattening.
 *
 * Each output pixel is probed on a regular ss x ss grid of sample points. Each
 * sample resolves to exactly one colour by asking the shapes in painter's order
 * (panes, then badge fill, then badge edge, then nothing). A pixel's colour is the
 * mean of the samples that hit something and its alpha is the fraction that did.
 * That is antialiasing and alpha in the same step, and it is why the result is a
 * true cut-out: a pixel on the badge's corner is genuinely half transparent rather
 * than half-blended into an assumed background colour, so the icon sits correctly on
 * a light dock and on a dark taskbar. Sample counts are deterministic grid points,
 * never random, so two runs produce byte-identical files.
 *
 * Small sizes are rasterised from the geometry at their own resolution rather than
 * downscaled from 1024, and get a denser sample grid to make up for having fewer
 * pixels to spend on the corners.
 *
 * ## What to change when the name and the colours are settled
 *
 * - Colours: they are read from `src/renderer/src/tokens.css`, so changing `--bg`,
 *   `--accent` or `--fg` there and re-running is the whole edit. `ROLES` below maps
 *   which token paints which part.
 * - Motif: `PANES` and the `BADGE_*` constants. `PANES` is deliberately the same
 *   16-unit box `LayoutIcon.tsx` uses, so the two stay recognisably the same drawing.
 * - Nothing here spells the product name, on purpose. If the settled brand wants a
 *   letter or a wordmark, that is a new shape, not a tweak — hand `build/icon.svg`
 *   to whoever draws it.
 */

import { deflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TOKENS_FILE = join(ROOT, 'src/renderer/src/tokens.css')

/** electron-builder reads `build/` as buildResources; these are the names it looks for. */
const MASTER_FILE = join(ROOT, 'build/icon.png')
const SVG_FILE = join(ROOT, 'build/icon.svg')
const SET_DIR = join(ROOT, 'build/icons')

/**
 * 1024 because macOS asks for it and electron-builder derives .icns and .ico from
 * this one file; anything smaller makes the Retina slot of the .icns upscaled.
 */
const MASTER_SIZE = 1024

/** The freedesktop icon sizes; each becomes hicolor/<n>x<n>/apps/<app>.png. */
const SET_SIZES = [16, 32, 48, 64, 128, 256, 512]

// --- palette ----------------------------------------------------------------

/**
 * Which design token paints which part of the icon.
 *
 * Read from the stylesheet rather than copied, because a placeholder icon that
 * disagrees with the running application's palette is worse than no icon: it looks
 * like a bug in the theme rather than a deliberate stand-in.
 */
const ROLES = {
  /** Badge fill, top edge of its gradient. */
  badgeTop: 'bg-elevated',
  /** Badge fill, bottom edge of its gradient. */
  badgeBottom: 'bg',
  /** Hairline around the badge, so a dark icon still has an outline on a dark dock. */
  badgeEdge: 'border',
  /** The wide pane: the focused one, hence the accent. */
  primaryPane: 'accent',
  /** The two stacked panes. */
  secondaryPane: 'fg'
}

/**
 * Reads `--name: #rrggbb` declarations.
 *
 * Fails loudly on a missing token instead of falling back to a hard-coded colour: a
 * silent fallback is how the icon would end up the only thing still wearing last
 * season's palette.
 */
function readPalette(file, roles) {
  let css
  try {
    css = readFileSync(file, 'utf8')
  } catch {
    throw new Error(
      `cannot read design tokens at ${relative(ROOT, file)} — if the file moved, update TOKENS_FILE`
    )
  }
  const palette = {}
  for (const [role, token] of Object.entries(roles)) {
    const match = new RegExp(`--${token}:\\s*#([0-9a-fA-F]{6})\\b`).exec(css)
    if (match === null) {
      throw new Error(`token --${token} (for ${role}) not found in ${relative(ROOT, file)}`)
    }
    palette[role] = {
      hex: `#${match[1].toLowerCase()}`,
      rgb: [
        Number.parseInt(match[1].slice(0, 2), 16),
        Number.parseInt(match[1].slice(2, 4), 16),
        Number.parseInt(match[1].slice(4, 6), 16)
      ]
    }
  }
  return palette
}

// --- geometry ---------------------------------------------------------------

/**
 * Fractions of the canvas edge, so every size is the same drawing.
 *
 * The inset keeps the badge off the canvas edge the way platform icon grids expect,
 * and the radius ratio is the macOS rounded-square proportion (185.4/824), which
 * reads as "an application" on Windows and Linux too.
 */
const BADGE_INSET = 0.082
const BADGE_RADIUS = 0.225
const BADGE_EDGE = 0.008
/** Margin between badge and panes: the panes are content inside a window, not the window. */
const PANE_INSET = 0.14

/**
 * The optical correction small icons need.
 *
 * At 1024 the margin is 84 pixels of breathing room; at 16 the same fraction is two
 * and a half pixels off every side, which is a sixth of the icon spent on nothing
 * while the panes it surrounds are three pixels wide. Below 128 the margin is halved
 * so the drawing keeps the pixels instead — the same reason hand-made icon sets are
 * redrawn at small sizes rather than scaled.
 */
function badgeInset(size) {
  return size >= 128 ? BADGE_INSET : BADGE_INSET / 2
}

/**
 * The `1+2` layout, copied from `LayoutIcon.tsx`'s 16-unit preview box: one wide
 * pane left, two stacked right, with a 1-unit gutter so they read as separate panes
 * rather than one divided rectangle.
 */
const PANE_BOX = 16
const PANE_UNIT_RADIUS = 1.5
const PANES = [
  { role: 'primaryPane', rect: [0, 0, 9.5, 16] },
  { role: 'secondaryPane', rect: [10.5, 0, 5.5, 7.5] },
  { role: 'secondaryPane', rect: [10.5, 8.5, 5.5, 7.5] }
]

function roundRect(x, y, width, height, radius) {
  // Radius is clamped so a pane narrower than 2r degenerates to a stadium rather
  // than inverting the corner test.
  const r = Math.min(radius, width / 2, height / 2)
  return { x0: x, y0: y, x1: x + width, y1: y + height, r }
}

/** Sizes at or below this are snapped to whole pixels; see `snapToPixels`. */
const PIXEL_SNAP_BELOW = 64

/** The shapes for one output size, in pixel coordinates. */
function buildScene(size) {
  const inset = size * badgeInset(size)
  const badgeSize = size - inset * 2
  const edge = badgeSize * BADGE_EDGE
  const badge = roundRect(inset, inset, badgeSize, badgeSize, badgeSize * BADGE_RADIUS)
  // The fill sits inside the hairline, so the hairline is the band between the two.
  const fill = roundRect(
    badge.x0 + edge,
    badge.y0 + edge,
    badgeSize - edge * 2,
    badgeSize - edge * 2,
    badge.r - edge
  )
  const paneArea = badgeSize * (1 - PANE_INSET * 2)
  const paneOrigin = inset + badgeSize * PANE_INSET
  const unit = paneArea / PANE_BOX
  const panes = PANES.map(({ role, rect: [x, y, width, height] }) => ({
    role,
    box: roundRect(
      paneOrigin + x * unit,
      paneOrigin + y * unit,
      width * unit,
      height * unit,
      PANE_UNIT_RADIUS * unit
    )
  }))
  const scene = { size, badge, fill, panes }
  return size <= PIXEL_SNAP_BELOW ? snapToPixels(scene) : scene
}

/**
 * Pulls edges onto whole pixels.
 *
 * The gutter between panes is one sixteenth of the drawing: 64 pixels at 1024, but
 * 1.3 at 32, and a 1.3-pixel dark line lands as two grey half-lit ones. Antialiasing
 * is correct and still looks like a smudge, which is exactly where a small icon loses
 * its shape. Snapping trades sub-pixel accuracy for a gutter that is one crisp pixel.
 *
 * Rounding can close a gutter completely — two edges 0.6 apart can round to the same
 * integer — so any gap that existed in the ideal geometry is forced back open to a
 * whole pixel afterwards.
 */
function snapToPixels(scene) {
  const snap = (shape) => ({
    x0: Math.round(shape.x0),
    y0: Math.round(shape.y0),
    x1: Math.round(shape.x1),
    y1: Math.round(shape.y1),
    r: shape.r
  })
  const panes = scene.panes.map((pane) => ({
    role: pane.role,
    box: snap(pane.box),
    ideal: pane.box
  }))
  for (const a of panes) {
    for (const b of panes) {
      if (a === b) continue
      if (a.ideal.x1 <= b.ideal.x0 && b.box.x0 - a.box.x1 < 1) b.box.x0 = a.box.x1 + 1
      if (a.ideal.y1 <= b.ideal.y0 && b.box.y0 - a.box.y1 < 1) b.box.y0 = a.box.y1 + 1
    }
  }
  const badge = snap(scene.badge)
  return {
    size: scene.size,
    badge,
    // The hairline is a fifth of a pixel down here. Dropping it — fill and badge being
    // the same shape — is more honest than letting a rounding difference between the
    // two tint just the corners with it.
    fill: badge,
    // A pane that lost width to the gutter repair must not keep a radius wider than
    // half of what is left, or the corner test inverts and the pane bulges.
    panes: panes.map(({ role, box }) => ({
      role,
      box: roundRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0, box.r)
    }))
  }
}

/** True when the point lies in the rounded rectangle. */
function inside(x, y, shape) {
  // Clamp the point into the rectangle shrunk by r: for points in that core the
  // distance is zero (inside), and for every other point the clamped position is
  // exactly the centre of the nearest corner arc or the nearest edge.
  const cx = Math.min(Math.max(x, shape.x0 + shape.r), shape.x1 - shape.r)
  const cy = Math.min(Math.max(y, shape.y0 + shape.r), shape.y1 - shape.r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= shape.r * shape.r
}

// --- rasteriser -------------------------------------------------------------

/**
 * Samples per pixel axis.
 *
 * A 16px icon spends its whole corner on two pixels, so it needs more probes per
 * pixel than the 1024 master, where one pixel of a 200px corner arc barely curves.
 */
function sampleGrid(size) {
  if (size >= 512) return 4
  if (size >= 128) return 8
  return 16
}

const scratch = [0, 0, 0]

/**
 * Resolves one sample point to a colour, painter's order, or reports a miss.
 *
 * Writing into a shared array rather than returning one keeps the inner loop free of
 * allocation; at 1024x1024 with a 4x4 grid this runs sixteen million times.
 */
function sampleColour(x, y, scene, palette, out) {
  if (!inside(x, y, scene.badge)) return false
  for (const pane of scene.panes) {
    if (inside(x, y, pane.box)) {
      const rgb = palette[pane.role].rgb
      out[0] = rgb[0]
      out[1] = rgb[1]
      out[2] = rgb[2]
      return true
    }
  }
  if (inside(x, y, scene.fill)) {
    // A flat dark square looks like a hole; the gradient gives it a lit top edge.
    const t = (y - scene.badge.y0) / (scene.badge.y1 - scene.badge.y0)
    const top = palette.badgeTop.rgb
    const bottom = palette.badgeBottom.rgb
    out[0] = top[0] + (bottom[0] - top[0]) * t
    out[1] = top[1] + (bottom[1] - top[1]) * t
    out[2] = top[2] + (bottom[2] - top[2]) * t
    return true
  }
  const edge = palette.badgeEdge.rgb
  out[0] = edge[0]
  out[1] = edge[1]
  out[2] = edge[2]
  return true
}

/** Straight (non-premultiplied) RGBA, top row first, as PNG stores it. */
function rasterise(size, palette) {
  const scene = buildScene(size)
  const grid = sampleGrid(size)
  const step = 1 / grid
  const total = grid * grid
  const pixels = new Uint8Array(size * size * 4)
  for (let py = 0; py < size; py++) {
    // Rows entirely above or below the badge cannot contain anything.
    if (py + 1 < scene.badge.y0 || py > scene.badge.y1) continue
    for (let px = 0; px < size; px++) {
      if (px + 1 < scene.badge.x0 || px > scene.badge.x1) continue
      let hits = 0
      let r = 0
      let g = 0
      let b = 0
      for (let sy = 0; sy < grid; sy++) {
        const y = py + (sy + 0.5) * step
        for (let sx = 0; sx < grid; sx++) {
          const x = px + (sx + 0.5) * step
          if (!sampleColour(x, y, scene, palette, scratch)) continue
          hits++
          r += scratch[0]
          g += scratch[1]
          b += scratch[2]
        }
      }
      if (hits === 0) continue
      const at = (py * size + px) * 4
      // Colour is the mean over covered samples only. Averaging in the misses would
      // darken every edge towards black, which is the classic muddy halo.
      pixels[at] = Math.round(r / hits)
      pixels[at + 1] = Math.round(g / hits)
      pixels[at + 2] = Math.round(b / hits)
      pixels[at + 3] = Math.round((hits / total) * 255)
    }
  }
  return pixels
}

// --- PNG --------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32 as PNG specifies it: every chunk carries one, and a wrong one is a corrupt file. */
function crc32(bytes) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** length, type, data, CRC over type+data — the whole of PNG's container format. */
function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  // The CRC covers the type and the data but not the length field.
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bits per channel
  header[9] = 6 // colour type 6: truecolour with alpha
  header[10] = 0 // deflate, the only defined compression
  header[11] = 0 // adaptive filtering, the only defined method
  header[12] = 0 // no interlace

  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y++) {
    const row = y * (stride + 1)
    // Filter 2 (Up) stores each byte as its difference from the pixel above. The
    // badge is flat colour in most rows and a slow vertical gradient in the rest, so
    // nearly every difference is zero and deflate has almost nothing left to do.
    raw[row] = 2
    for (let x = 0; x < stride; x++) {
      const above = y === 0 ? 0 : pixels[(y - 1) * stride + x]
      raw[row + 1 + x] = (pixels[y * stride + x] - above) & 0xff
    }
  }

  // No tIME chunk and a fixed compression level: the output has to be reproducible.
  const compressed = deflateSync(raw, { level: 9 })
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- SVG --------------------------------------------------------------------

/** Two decimals: enough to be exact at 1024, few enough for a human to read. */
function round(value) {
  return Number(value.toFixed(2))
}

/**
 * The same scene as a vector file.
 *
 * Not used by the build — electron-builder gets the PNGs — but it is the version a
 * designer can open, and it documents the motif in a form that does not need this
 * script to be understood.
 */
function buildSvg(palette) {
  const scene = buildScene(MASTER_SIZE)
  // SVG strokes straddle the path, so the hairline is drawn on a rect half a stroke
  // inside the badge. That places it over exactly the band the rasteriser fills.
  const edge = (scene.badge.x1 - scene.badge.x0) * BADGE_EDGE
  const hairline = roundRect(
    scene.badge.x0 + edge / 2,
    scene.badge.y0 + edge / 2,
    scene.badge.x1 - scene.badge.x0 - edge,
    scene.badge.y1 - scene.badge.y0 - edge,
    scene.badge.r - edge / 2
  )
  const panes = scene.panes
    .map(
      (pane) =>
        `  <rect x="${round(pane.box.x0)}" y="${round(pane.box.y0)}" width="${round(pane.box.x1 - pane.box.x0)}" height="${round(pane.box.y1 - pane.box.y0)}" rx="${round(pane.box.r)}" fill="${palette[pane.role].hex}" />`
    )
    .join('\n')
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MASTER_SIZE} ${MASTER_SIZE}" width="${MASTER_SIZE}" height="${MASTER_SIZE}">
  <!--
    Placeholder application icon: the 1+2 split layout, one wide pane and two
    stacked ones, in the same proportions as the in-app LayoutIcon.

    Generated by scripts/make-icon.mjs — edit that, not this, or the PNGs drift.
    Colours come from src/renderer/src/tokens.css.
  -->
  <defs>
    <linearGradient id="badge" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${palette.badgeTop.hex}" />
      <stop offset="1" stop-color="${palette.badgeBottom.hex}" />
    </linearGradient>
  </defs>
  <rect x="${round(scene.badge.x0)}" y="${round(scene.badge.y0)}" width="${round(scene.badge.x1 - scene.badge.x0)}" height="${round(scene.badge.y1 - scene.badge.y0)}" rx="${round(scene.badge.r)}" fill="url(#badge)" />
  <rect x="${round(hairline.x0)}" y="${round(hairline.y0)}" width="${round(hairline.x1 - hairline.x0)}" height="${round(hairline.y1 - hairline.y0)}" rx="${round(hairline.r)}" fill="none" stroke="${palette.badgeEdge.hex}" stroke-width="${round(edge)}" />
${panes}
</svg>
`
}

// --- main -------------------------------------------------------------------

const palette = readPalette(TOKENS_FILE, ROLES)

mkdirSync(dirname(MASTER_FILE), { recursive: true })
mkdirSync(SET_DIR, { recursive: true })

const written = []

function writePng(file, size) {
  const png = encodePng(size, rasterise(size, palette))
  writeFileSync(file, png)
  written.push({ file: relative(ROOT, file), size, bytes: png.length })
}

writePng(MASTER_FILE, MASTER_SIZE)
for (const size of SET_SIZES) writePng(join(SET_DIR, `${size}x${size}.png`), size)

writeFileSync(SVG_FILE, buildSvg(palette))
written.push({ file: relative(ROOT, SVG_FILE), size: MASTER_SIZE, bytes: null })

const width = Math.max(...written.map((entry) => entry.file.length))
console.log('\nIcon written from src/renderer/src/tokens.css\n')
for (const entry of written) {
  const bytes =
    entry.bytes === null ? '' : `${String(Math.round(entry.bytes / 1024)).padStart(5)} kB`
  console.log(`  ${entry.file.padEnd(width)}  ${String(entry.size).padStart(4)}px ${bytes}`)
}
console.log('')
