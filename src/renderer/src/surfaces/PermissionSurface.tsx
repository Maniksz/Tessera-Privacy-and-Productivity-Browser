import { useCallback, useEffect, useRef } from 'react'
import type { PermissionRequestPresentation } from '@shared/overlay/surface.js'
import type {
  PermissionAnswer,
  PermissionDevice,
  PermissionSubject
} from '@shared/overlay/permission.js'
import type { MessageKey } from '@shared/i18n/catalog.js'
import { invoke } from '../bridge.js'
import { useI18n } from '../i18n.js'

/**
 * The dialogue a page's request for the camera, the microphone or the location produces (spec 4).
 *
 * It lives on the overlay surface rather than in the toolbar's renderer for the reason every
 * over-content surface here does: tab content is drawn by native views stacked above the chrome
 * UI, so a dialogue rendered there is painted *behind* the page and receives no clicks. It would
 * look perfectly correct in a DOM snapshot and be impossible to answer — which for a consent
 * dialogue means a page hanging on a promise nobody can settle.
 *
 * ## What must be true of this component and not merely look true
 *
 * - **Escape refuses.** Not "closes": the answer sent is `block`. A dialogue that vanished without
 *   answering would leave the page waiting forever, and the safe reading of "the user made it go
 *   away" is no.
 * - **Focus starts on Block and cannot leave.** A stray Return refuses rather than grants, and Tab
 *   cycles among the three buttons instead of walking off into a surface the user cannot see. Spec
 *   7 requires full keyboard operation; for this dialogue it also decides which answer an
 *   accidental keystroke gives.
 * - **The site is named before any button is offered.** Everything rendered comes from the
 *   presentation, so there is no state in which a button exists and the text it agrees to does
 *   not.
 */

const SUBJECT_LABELS: Readonly<Record<PermissionSubject, MessageKey>> = {
  camera: 'permission.subject.camera',
  microphone: 'permission.subject.microphone',
  'camera-and-microphone': 'permission.subject.cameraAndMicrophone',
  geolocation: 'permission.subject.geolocation',
  notifications: 'permission.subject.notifications',
  'clipboard-read': 'permission.subject.clipboardRead',
  'clipboard-write': 'permission.subject.clipboardWrite',
  'display-capture': 'permission.subject.displayCapture',
  midi: 'permission.subject.midi',
  'midi-sysex': 'permission.subject.midiSysex',
  'storage-access': 'permission.subject.storageAccess',
  'top-level-storage-access': 'permission.subject.topLevelStorageAccess'
}

const DEVICE_LABELS: Readonly<Record<PermissionDevice, MessageKey>> = {
  camera: 'permission.device.camera',
  microphone: 'permission.device.microphone'
}

export function PermissionSurface({
  presentation
}: {
  presentation: PermissionRequestPresentation
}): React.ReactNode {
  const { t } = useI18n()
  const dialogRef = useRef<HTMLDivElement>(null)
  const blockRef = useRef<HTMLButtonElement>(null)

  const answer = useCallback(
    (choice: PermissionAnswer): void => {
      void invoke('permissions:answer', { requestId: presentation.requestId, answer: choice })
    },
    [presentation.requestId]
  )

  /*
    Focus lands on the refusing button, and lands there again for each queued request.

    Keyed on the request id rather than run once: the core replaces the presentation in place when
    the next queued prompt comes up, so without this the second dialogue would inherit whatever
    button the first was answered with — and the user would be one Return away from granting
    something they have not read.
  */
  useEffect(() => {
    blockRef.current?.focus()
  }, [presentation.requestId])

  const focusables = (): HTMLButtonElement[] => [
    ...(dialogRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  ]

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      /*
        Stopped here, deliberately. `OverlaySurface` has a window-level Escape handler that dismisses
        whatever is up, and for this surface dismissal without an answer is the failure — so this one
        answers and the generic one must not also fire.
      */
      event.stopPropagation()
      answer('block')
      return
    }

    if (event.key !== 'Tab') return
    // Trapped rather than merely ordered: past the last button the browser would move focus into
    // the transparent remainder of a layer with nothing else on it, leaving a keyboard user with a
    // modal dialogue they can no longer reach.
    event.preventDefault()
    const items = focusables()
    if (items.length === 0) return
    const index = items.findIndex((item) => item === document.activeElement)
    const delta = event.shiftKey ? -1 : 1
    const position = (index + delta + items.length) % items.length
    const [next] = items.slice(position, position + 1)
    next?.focus()
  }

  const site = presentation.origin
  const request = t('permission.asking', {
    site,
    permission: t(SUBJECT_LABELS[presentation.subject])
  })

  return (
    <div
      className="surface surface--modal"
      /*
        Swallows the click without answering. An outside click dismisses a menu because a menu costs
        nothing to reopen; here it would refuse a request the user is in the middle of reading, and
        a mis-aimed click is not consent's opposite any more than it is consent.
      */
      onPointerDown={(event) => {
        event.stopPropagation()
      }}
    >
      <div
        ref={dialogRef}
        className="prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="permission-title"
        aria-describedby="permission-request"
        onKeyDown={onKeyDown}
      >
        <h2 className="prompt__title" id="permission-title">
          {t('permission.title')}
        </h2>

        {/* The site, on its own line and not truncated by prose around it: it is the one fact the
            answer depends on. */}
        <p className="prompt__site">{site}</p>

        <p className="prompt__request" id="permission-request">
          {request}
        </p>

        {presentation.devices.length > 0 && (
          <ul className="prompt__devices">
            {presentation.devices.map((device) => (
              <li key={device} className="prompt__device">
                {t(DEVICE_LABELS[device])}
              </li>
            ))}
          </ul>
        )}

        {presentation.waiting > 0 && (
          <p className="prompt__waiting" role="status">
            {presentation.waiting === 1
              ? t('permission.waitingOne')
              : t('permission.waitingMany', { count: presentation.waiting })}
          </p>
        )}

        <div className="prompt__actions">
          <button
            ref={blockRef}
            type="button"
            className="prompt__button prompt__button--block"
            onClick={() => answer('block')}
          >
            {t('permission.block')}
          </button>
          <button
            type="button"
            className="prompt__button"
            onClick={() => answer('allow-once')}
          >
            {t('permission.allowOnce')}
          </button>
          <button
            type="button"
            className="prompt__button prompt__button--always"
            onClick={() => answer('allow-always')}
          >
            {t('permission.allowAlways')}
          </button>
        </div>

        <p className="prompt__hint">{t('permission.keyboardHint')}</p>
      </div>
    </div>
  )
}
