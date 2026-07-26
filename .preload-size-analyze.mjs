// Temporary: per-module contribution to the preload bundle.
import { build } from '/Users/m.niksztat/Projects/private/ownbrowser/node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/lib/main.js'
import { resolve } from 'node:path'

const root = process.cwd()
const result = await build({
  entryPoints: [resolve(root, 'src/preload/index.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node24',
  minify: true,
  external: ['electron'],
  metafile: true,
  write: false,
  alias: { '@shared': resolve(root, 'src/shared') }
})
const out = Object.values(result.metafile.outputs)[0]
const rows = Object.entries(out.inputs)
  .map(([file, info]) => [file, info.bytesInOutput])
  .sort((a, b) => b[1] - a[1])
let total = 0
for (const [file, bytes] of rows) {
  total += bytes
  console.log(String(bytes).padStart(7), file)
}
console.log(String(total).padStart(7), 'TOTAL (minified, in output)')
