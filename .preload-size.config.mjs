// Temporary: builds only the preload so its size can be measured without a full build.
import { resolve } from 'node:path'
import { defineConfig } from 'vite'

const projectRoot = process.cwd()
const shared = resolve(projectRoot, 'src/shared')

export default defineConfig({
  build: {
    target: 'node24',
    minify: 'esbuild',
    outDir: 'out/preload',
    emptyOutDir: false,
    ssr: true,
    rollupOptions: {
      input: { index: resolve(projectRoot, 'src/preload/index.ts') },
      external: ['electron'],
      output: { format: 'cjs', entryFileNames: '[name].cjs', inlineDynamicImports: true }
    }
  },
  resolve: { alias: { '@shared': shared } }
})
