import { useCallback, useState } from 'react'

/**
 * One call into the core, with its refusal made visible.
 *
 * ## The defect this exists to close
 *
 * Both panel surfaces surfaced a *write* refusal carefully and dropped every other one. Four places,
 * all the same mistake:
 *
 *   - the settings reset button was `void host.reset(key)` — a refused reset produced an unhandled
 *     rejection, no message, and a value left exactly as it was;
 *   - `ExtensionsView.remove` awaited `host.remove(id)` with no guard, so a refused removal re-read the
 *     list unchanged and the extension the user had just tried to delete sat there unexplained;
 *   - `ExtensionsView.load` handled the `{ error }` the core returns for an unreadable folder but not
 *     the call *itself* rejecting;
 *   - and worst, the initial `describe()` / `list()` was `void host.x().then(setState)`, so a failed
 *     first load rendered an empty surface. `SettingsView` shows no empty-state text when there are no
 *     descriptors, which makes "the core refused" and "this browser has no settings" the same picture.
 *
 * Spec 5's rule is that a control which appears to act and does not is a defect. That rule was written
 * about toggles and applies unchanged to a reset button, a delete button and a list that never arrived.
 * Holding the error state and the try/catch in one place is what stops the next call from forgetting.
 */

/** Electron wraps a rejected handler's message; the user should read the reason, not the plumbing. */
function reasonOf(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  return message.replace(/^Error invoking remote method '[^']+':\s*/, '')
}

export interface CoreCall {
  /** The last refusal, or `null`. Rendered by the caller so it can place it in its own layout. */
  error: string | null
  /**
   * Runs one call, clearing any previous message first.
   *
   * Stable across renders, so an effect may depend on it without re-running. That matters: the first
   * load goes through here, and a `run` with a new identity each render would refetch forever.
   */
  run: (action: () => Promise<void>) => Promise<void>
  /**
   * Reports a message the surface composed itself.
   *
   * For a failure the core returns as data rather than as a rejection — a folder it could not read
   * comes back as `{ error }`, and only the surface knows which catalogue entry describes it.
   */
  report: (message: string) => void
}

export function useCoreCall(): CoreCall {
  const [error, setError] = useState<string | null>(null)

  const run = useCallback(async (action: () => Promise<void>): Promise<void> => {
    try {
      setError(null)
      await action()
    } catch (cause) {
      setError(reasonOf(cause))
    }
  }, [])

  return { error, run, report: setError }
}
