/**
 * Build constants, replaced by `define` in `electron.vite.config.ts` with values read from
 * `package.json`. Declared here rather than read at runtime because the pages that need them are
 * served without a bridge and have nobody to ask; `tests/architecture.test.ts` checks the built
 * about chunk carries the real values and no leftover identifier.
 */
declare const __TESSERA_VERSION__: string
declare const __TESSERA_LICENSE__: string
