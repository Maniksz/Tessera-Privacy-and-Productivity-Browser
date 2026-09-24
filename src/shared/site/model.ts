import type { SecurityState } from '../model.js'
import { INTERNAL_SCHEME } from '../product.js'

/**
 * What the lock in front of the address says about the connection (U19).
 *
 * Moved out of `Tab.ts`, which cannot load outside a browser process, so that the three answers the site
 * menu opens with — `https:`, `http:` and the browser's own pages — can be asked for in a test. The tab
 * still decides *when* to ask; this decides what the answer is.
 *
 * The order is the rule. An internal page is internal whatever happened to a certificate on the way, and
 * a rejected certificate outranks the scheme, because an `https:` address whose certificate was refused
 * is the one case where "encrypted" would be the wrong thing to say.
 *
 * Zod-free and platform-free, like everything a renderer may import at runtime.
 */
export function securityStateOf(url: string, certificateRejected: boolean): SecurityState {
  if (url === '' || url.startsWith(INTERNAL_SCHEME) || url.startsWith('about:')) return 'internal'
  if (certificateRejected) return 'invalid-certificate'
  return url.startsWith('https:') ? 'secure' : 'insecure'
}
