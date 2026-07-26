import { onOverlayVacancy } from '../permissions/vacancy.js'
import { FindController } from './FindController.js'

/**
 * The one find controller, and the one place it is subscribed to the overlay layer.
 *
 * ## Why a lazily created singleton rather than a constructed dependency
 *
 * There is exactly one of these for the application, like the permission arbiter, and for the same
 * reason: the state it holds is per window but the thing it has to listen to — a surface leaving the
 * overlay layer — is announced globally, with no window attached. See `permissions/vacancy.ts` for
 * why that announcement is a module-level registry and not a constructor option.
 *
 * Created on first use rather than at startup so that the subscription is made exactly once and only
 * if the feature is reachable at all, and so that nothing has to be threaded through two option bags
 * that have no other reason to mention find in page.
 *
 * ## Why the subscription is here and not in the controller's constructor
 *
 * A constructor that subscribes to a module-level registry cannot be constructed twice in one
 * process without leaking a listener, which makes it awkward to test. The controller stays inert and
 * this function owns the wiring — so a test builds its own controller and drives `overlayVacated`
 * directly, which is the same call the registry would have made.
 */

let controller: FindController | null = null

export function findService(): FindController {
  const existing = controller
  if (existing !== null) return existing

  const created = new FindController()
  controller = created
  /*
    Every departure of a find bar, whatever caused it. This is what clears the page's highlight when
    the layer is taken down by something that knows nothing about find in page — a window resize, a
    focus change, a layout change, a permission prompt, a crashed surface, the window closing.
  */
  onOverlayVacancy((presentation) => {
    created.overlayVacated(presentation)
  })
  return created
}
