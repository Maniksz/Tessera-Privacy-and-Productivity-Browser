/**
 * The two shapes the masking works through, in one place.
 *
 * Types only, and that is what makes this module legal here: `import type` is
 * erased before the source `contextBridge.executeInMainWorld` serialises ever
 * exists, so a measure importing from here still references nothing at runtime.
 * A *value* import would break every measure in the file that made it — see the
 * rule in `apply.ts`.
 *
 * Shared rather than copied into each part, because two spellings of "anything
 * callable" drift apart the moment one of them is tightened.
 */

/** Anything callable, invoked through `Reflect.apply` with unknown arguments. */
export type Callable = (...args: unknown[]) => unknown

/** Indexable view of a prototype, namespace or instance being patched. */
export type Slots = Record<string, unknown>
