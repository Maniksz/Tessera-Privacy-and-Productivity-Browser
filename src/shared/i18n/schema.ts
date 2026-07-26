import { z } from 'zod'
import { LOCALES } from './catalog.js'

/**
 * Runtime validation for locales.
 *
 * Split out of `catalog.ts` for the same reason as the quick-link schemas: every
 * renderer imports the catalogue to render text, and a zod import there would put
 * the whole validation library in the UI bundle. Only the core and the IPC contract
 * need this file.
 */
export const localeSchema = z.enum(LOCALES)
