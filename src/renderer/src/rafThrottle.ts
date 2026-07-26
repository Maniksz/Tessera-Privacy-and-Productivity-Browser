/**
 * Coalesces rapid calls down to one per animation frame, keeping the latest argument.
 *
 * Pointer moves arrive faster than they can usefully be acted on — a high-rate mouse or
 * trackpad produces several samples per frame, and each one here would be an IPC round trip
 * that changes nothing visible. Dropping the intermediate samples costs nothing, because
 * only the newest position matters, and it keeps a drag smooth on the older laptops this
 * browser is meant to stay usable on.
 */
export function rafThrottle<T>(send: (value: T) => void): {
  post(value: T): void
  cancel(): void
} {
  let pending: { value: T } | null = null
  let frame: number | null = null

  return {
    post(value: T): void {
      pending = { value }
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        const next = pending
        pending = null
        if (next !== null) send(next.value)
      })
    },
    cancel(): void {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      pending = null
    }
  }
}
