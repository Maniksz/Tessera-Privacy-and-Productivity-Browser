import { useEffect, useRef, useState } from 'react'
import { mediaMessage, type MediaMessageKey } from '@shared/media/messages.js'
import type { MediaFinding, MediaVariant } from '@shared/media/model.js'
import type {
  MediaDownloadReport,
  MediaFindingList,
  MediaManifestReport
} from '@shared/media/wire.js'
import { useI18n } from '../i18n.js'

/**
 * What the page is playing, and what can be done about it.
 *
 * ## Why the core is asked rather than the DOM
 *
 * A panel that scraped `<video src>` out of the page would find almost nothing: a modern
 * player hands the element a `blob:` URL it built itself, and the real addresses only ever
 * appear as network requests. So the list comes from the one interception point, which is
 * also the only place that sees the `Content-Type` that identifies an extension-less CDN
 * address as media.
 *
 * ## Why every sentence here comes from `@shared/media/messages.ts`
 *
 * Because a refusal is the point. `DOWNLOAD_REFUSALS` distinguishes "this is encrypted"
 * from "this needs a converter we do not ship" precisely so that the interface can say
 * which — and a panel that rendered `separate-audio-track` would have thrown that away.
 * The sentence is produced by the core, which owns the locale, and arrives on the report.
 * The panel's own labels resolve through the same fragment, so the button and the
 * explanation it provokes are written in one place.
 *
 * ## Why a port instead of `invoke`
 *
 * The four operations arrive as functions. It keeps this component renderable in a test
 * without an IPC bridge — and the panel is where the interesting states live (a refusal, a
 * quality list, a download in flight), which are exactly the ones nobody exercises by hand.
 */

export interface MediaPort {
  list(): Promise<MediaFindingList>
  describe(findingId: string): Promise<MediaManifestReport>
  /** `null` means "decide for me", which resolves to the best variant that can be assembled. */
  download(findingId: string, variantId: string | null): Promise<MediaDownloadReport>
  cancel(findingId: string): Promise<{ stopped: boolean }>
  /** Findings change without being asked: a second stream starts, the page navigates. */
  subscribe(listener: (list: MediaFindingList) => void): () => void
}

/** Value of the "decide for me" option. Empty, because a `<select>` needs a string. */
const AUTOMATIC = ''

/** Megabytes, one decimal, decimal units — the same units the download UI of every browser uses. */
function sizeOf(byteLength: number | null): string | null {
  if (byteLength === null) return null
  return `${(byteLength / 1_000_000).toFixed(1)} MB`
}

function variantLabel(variant: MediaVariant): string {
  const parts = [
    variant.height === null ? null : `${variant.height}p`,
    variant.name,
    variant.language,
    variant.bandwidthBitsPerSecond === null
      ? null
      : `${Math.round(variant.bandwidthBitsPerSecond / 1000)} kbit/s`,
    variant.track === 'muxed' ? null : variant.track
  ].filter((part): part is string => part !== null && part !== '')
  // A variant that stated nothing at all still needs something clickable; its id is what
  // the manifest gave it, which beats an empty option nobody can select.
  return parts.length === 0 ? variant.id : parts.join(' · ')
}

export function MediaPanel({
  port,
  onClose
}: {
  port: MediaPort
  onClose: () => void
}): React.ReactNode {
  const { locale } = useI18n()
  const mt = (key: MediaMessageKey): string => mediaMessage(locale, key)

  const [list, setList] = useState<MediaFindingList | null>(null)
  const [manifests, setManifests] = useState<Record<string, MediaManifestReport>>({})
  const [choices, setChoices] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [reports, setReports] = useState<Record<string, MediaDownloadReport>>({})

  /**
   * The port, read through a ref.
   *
   * The caller builds it inline — four closures over `invoke` — so its identity changes on
   * every render of the window chrome. Naming it in an effect's dependency array would
   * then re-run the subscription on every keystroke elsewhere in the UI; leaving it out
   * would be a lie the lint rule rightly objects to. A ref is neither.
   */
  const portRef = useRef(port)
  useEffect(() => {
    portRef.current = port
  }, [port])

  useEffect(() => {
    let cancelled = false
    // Declared after the ref effect, which is what makes `portRef.current` current: effects
    // run in declaration order.
    void portRef.current.list().then((next) => {
      if (!cancelled) setList(next)
    })

    const unsubscribe = portRef.current.subscribe((next) => {
      // Only the tab this panel was opened for. The core pushes changes for every tab in
      // the window, and a panel that accepted them all would show a background tile's
      // video as if it were this page's.
      setList((current) => (current === null || current.tabId === next.tabId ? next : current))
    })
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const describe = async (finding: MediaFinding): Promise<void> => {
    const report = await portRef.current.describe(finding.id)
    setManifests((current) => ({ ...current, [finding.id]: report }))
  }

  const download = async (finding: MediaFinding): Promise<void> => {
    setBusy((current) => ({ ...current, [finding.id]: true }))
    const chosen = choices[finding.id] ?? AUTOMATIC
    try {
      const report = await portRef.current.download(
        finding.id,
        chosen === AUTOMATIC ? null : chosen
      )
      setReports((current) => ({ ...current, [finding.id]: report }))
    } finally {
      setBusy((current) => ({ ...current, [finding.id]: false }))
    }
  }

  const findings = list?.findings ?? []

  return (
    <div
      className="overlay"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className="panel panel--narrow"
        role="dialog"
        aria-modal="true"
        aria-labelledby="media-heading"
      >
        <header className="panel__header">
          <h2 className="panel__heading" id="media-heading">
            {mt('media.panel.title')}
          </h2>
          <button
            type="button"
            className="iconbutton"
            aria-label={mt('media.panel.close')}
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="panel__body">
          <p className="panel__notice">{mt('media.panel.notice')}</p>

          {findings.length === 0 ? (
            <p className="panel__empty">{mt('media.panel.empty')}</p>
          ) : (
            <ul className="extlist">
              {findings.map((finding) => {
                const manifest = manifests[finding.id]?.manifest ?? finding.manifest
                const failure = manifests[finding.id]?.message ?? null
                const variants = manifest?.status === 'ready' ? manifest.variants : []
                const report = reports[finding.id]
                const running = busy[finding.id] === true
                const size = sizeOf(finding.byteLength)

                return (
                  <li className="extlist__item" key={finding.id}>
                    <div className="extlist__text">
                      <span className="extlist__name">{finding.label}</span>
                      <span className="extlist__meta">
                        {[
                          finding.kind,
                          finding.container === 'unknown' ? null : finding.container,
                          size,
                          manifest?.status === 'ready' && manifest.live
                            ? mt('media.panel.live')
                            : null,
                          manifest?.status === 'ready' && manifest.drm.protected
                            ? mt('media.panel.protected')
                            : null
                        ]
                          .filter((part): part is string => part !== null)
                          .join(' · ')}
                      </span>

                      {variants.length > 0 && (
                        <label className="field__label">
                          {mt('media.panel.quality')}
                          <select
                            className="field__select"
                            value={choices[finding.id] ?? AUTOMATIC}
                            onChange={(event) =>
                              setChoices((current) => ({
                                ...current,
                                [finding.id]: event.target.value
                              }))
                            }
                          >
                            <option value={AUTOMATIC}>{mt('media.panel.qualityAuto')}</option>
                            {variants.map((variant) => (
                              <option key={variant.id} value={variant.id}>
                                {variantLabel(variant)}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}

                      {failure !== null && (
                        <span className="panel__error" role="alert">
                          {failure}
                        </span>
                      )}

                      {report !== undefined &&
                        (report.ok ? (
                          <span className="extlist__meta">
                            {mt('media.panel.saved')} <code>{report.filePath}</code>
                          </span>
                        ) : (
                          <span className="panel__error" role="alert">
                            {report.message}
                          </span>
                        ))}
                    </div>

                    <div className="panel__actions">
                      {manifest?.status === 'not-loaded' && (
                        <button
                          type="button"
                          className="dialog__button"
                          onClick={() => void describe(finding)}
                        >
                          {mt('media.panel.qualities')}
                        </button>
                      )}
                      {running ? (
                        <button
                          type="button"
                          className="dialog__button"
                          onClick={() => void portRef.current.cancel(finding.id)}
                        >
                          {mt('media.panel.cancel')}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="dialog__button dialog__button--primary"
                          onClick={() => void download(finding)}
                        >
                          {mt('media.panel.download')}
                        </button>
                      )}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
