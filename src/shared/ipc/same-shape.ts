/**
 * True only when two shapes describe each other — assignable in both directions.
 *
 * ## What it is for
 *
 * Several features keep their model in a zod-free `shared` module, because their pages are renderers and
 * an architecture test follows the value-import graph to keep the validation library out of the bundle.
 * So the wire schema cannot live beside the interface, and without help the two drift silently: a schema
 * that grew a field the interface lacks passes validation and arrives as `unknown` at the page, and the
 * reverse quietly drops a column.
 *
 * Both directions, expressed once. A single assignment would only catch drift one way, and each way has
 * actually happened in this codebase.
 *
 * ## Why it has a file of its own
 *
 * It was declared in `contract.ts`, which is the only place that needed it while every wire schema lived
 * there. The password schemas have since moved to `shared/passwords/schema.ts` — the same `model`/`schema`
 * split `quicklinks`, `media` and `reader` use — and that file cannot import `contract.ts`, because
 * `contract.ts` imports it. A type-only module both can import is the smallest thing that resolves that,
 * and it costs nothing at runtime: there is no value here to bundle.
 */
export type SameShape<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
