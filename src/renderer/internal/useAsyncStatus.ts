import { useState } from 'react'
import type { Translate } from '@renderer-shared/SettingsView.js'

/**
 * The busy flag and the one line of outcome a settings section shows under its buttons.
 *
 * `run` clears the line, marks the section busy and does the work; the work answers with the line to
 * show, or `null` for none. A rejected work shows the generic failure. Either way the section stops being
 * busy and `onSettled` runs — the backup section uses it to ask for its status again.
 */
export function useAsyncStatus(
  t: Translate,
  onSettled?: () => void
): {
  busy: boolean
  message: string | null
  setMessage: (message: string | null) => void
  run: (work: () => Promise<string | null>) => void
} {
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = (work: () => Promise<string | null>): void => {
    setBusy(true)
    setMessage(null)
    void work()
      .then(setMessage, () => setMessage(t('backup.failed')))
      .finally(() => {
        setBusy(false)
        onSettled?.()
      })
  }

  return { busy, message, setMessage, run }
}
