import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MediaPanel, type MediaPort } from '@renderer/components/MediaPanel.js'
import { mediaMessage, refusalSentence } from '@shared/media/messages.js'
import type { MediaFinding } from '@shared/media/model.js'
import type {
  MediaDownloadReport,
  MediaFindingList,
  MediaManifestReport
} from '@shared/media/wire.js'

/**
 * The media panel, rendered.
 *
 * One behaviour is worth a DOM for, and it is the one the whole refusal vocabulary exists
 * to serve: what the user actually reads when a stream cannot be saved. `DOWNLOAD_REFUSALS`
 * distinguishes eleven reasons so the interface can say which — and every one of them
 * arrives here as an enumeration value beside a sentence, so a panel that rendered the
 * wrong field would look perfectly correct to a type checker and show
 * `separate-audio-track` to a person.
 *
 * The panel is driven through a port rather than an IPC bridge, so these are ordinary
 * function calls: no channel names, no preload, no main process.
 */

afterEach(cleanup)

function finding(overrides: Partial<MediaFinding> = {}): MediaFinding {
  return {
    id: 'media-1',
    tabId: 'tab-1',
    url: 'https://example.com/clip.mp4',
    documentUrl: 'https://example.com/watch',
    kind: 'progressive',
    container: 'mp4',
    contentType: 'video/mp4',
    byteLength: 12_400_000,
    label: 'clip.mp4',
    discoveredAt: 1,
    manifest: null,
    ...overrides
  }
}

interface Harness {
  port: MediaPort
  downloads: Array<{ findingId: string; variantId: string | null }>
  cancelled: string[]
  publish(list: MediaFindingList): void
}

function harness(options: {
  findings?: readonly MediaFinding[]
  describe?: MediaManifestReport
  download?: MediaDownloadReport | Promise<MediaDownloadReport>
}): Harness {
  const downloads: Array<{ findingId: string; variantId: string | null }> = []
  const cancelled: string[] = []
  let publish: (list: MediaFindingList) => void = () => {}

  const port: MediaPort = {
    list: () => Promise.resolve({ tabId: 'tab-1', findings: options.findings ?? [] }),
    describe: () =>
      Promise.resolve(options.describe ?? { manifest: null, message: null }),
    download: (findingId, variantId) => {
      downloads.push({ findingId, variantId })
      return Promise.resolve(options.download ?? { ok: true, filePath: '/d/clip.mp4', byteLength: 1 })
    },
    cancel: (findingId) => {
      cancelled.push(findingId)
      return Promise.resolve({ stopped: true })
    },
    subscribe: (listener) => {
      publish = listener
      return () => {
        publish = () => {}
      }
    }
  }

  return { port, downloads, cancelled, publish: (list) => publish(list) }
}

const READY: MediaManifestReport = {
  manifest: {
    status: 'ready',
    variants: [
      {
        id: 'v0',
        url: 'https://example.com/1080p.m3u8',
        track: 'video',
        bandwidthBitsPerSecond: 7_680_000,
        width: 1920,
        height: 1080,
        codecs: 'avc1.640028',
        container: 'unknown',
        language: null,
        name: null
      }
    ],
    durationSeconds: 120,
    live: false,
    drm: { protected: false }
  },
  message: null
}

describe('the media panel', () => {
  it('says the page is playing nothing rather than showing an empty box', async () => {
    render(<MediaPanel port={harness({}).port} onClose={vi.fn()} />)
    expect(await screen.findByText(mediaMessage('en', 'media.panel.empty'))).toBeTruthy()
  })

  it('shows a refusal as a sentence, never as its code', async () => {
    const world = harness({
      findings: [finding()],
      download: {
        ok: false,
        refusal: 'separate-audio-track',
        message: refusalSentence('en', 'separate-audio-track'),
        detail: 'the variant carries video only'
      }
    })
    render(<MediaPanel port={world.port} onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText(mediaMessage('en', 'media.panel.download')))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(refusalSentence('en', 'separate-audio-track'))
    // The failure this test exists for: the enumeration value reaching the screen.
    expect(document.body.textContent).not.toContain('separate-audio-track')
  })

  it('shows where a saved file went', async () => {
    const world = harness({
      findings: [finding()],
      download: { ok: true, filePath: '/home/x/Downloads/clip.mp4', byteLength: 4 }
    })
    render(<MediaPanel port={world.port} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText(mediaMessage('en', 'media.panel.download')))
    expect(await screen.findByText('/home/x/Downloads/clip.mp4')).toBeTruthy()
  })

  it('explains a manifest it could not read', async () => {
    const world = harness({
      findings: [finding({ kind: 'hls', manifest: { status: 'not-loaded' } })],
      describe: {
        manifest: { status: 'failed', reason: 'unreachable', detail: 'HTTP 503' },
        message: mediaMessage('en', 'media.manifest.unreachable')
      }
    })
    render(<MediaPanel port={world.port} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText(mediaMessage('en', 'media.panel.qualities')))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toBe(mediaMessage('en', 'media.manifest.unreachable'))
  })

  it('sends the chosen quality, and null when the user chose nothing', async () => {
    const world = harness({
      findings: [finding({ kind: 'hls', manifest: { status: 'not-loaded' } })],
      describe: READY
    })
    render(<MediaPanel port={world.port} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText(mediaMessage('en', 'media.panel.qualities')))

    // Null rather than a guess: the core resolves it to the best variant that can actually
    // be assembled, which is a decision no renderer should be making.
    fireEvent.click(screen.getByText(mediaMessage('en', 'media.panel.download')))
    await waitFor(() => expect(world.downloads).toHaveLength(1))
    expect(world.downloads[0]).toEqual({ findingId: 'media-1', variantId: null })

    const select = await screen.findByRole('combobox')
    fireEvent.change(select, { target: { value: 'v0' } })
    fireEvent.click(screen.getByText(mediaMessage('en', 'media.panel.download')))
    await waitFor(() => expect(world.downloads).toHaveLength(2))
    expect(world.downloads[1]).toEqual({ findingId: 'media-1', variantId: 'v0' })
  })

  it('offers to stop a download while it is running', async () => {
    let finish: (report: MediaDownloadReport) => void = () => {}
    const world = harness({
      findings: [finding()],
      download: new Promise<MediaDownloadReport>((resolve) => {
        finish = resolve
      })
    })
    render(<MediaPanel port={world.port} onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText(mediaMessage('en', 'media.panel.download')))

    const stop = await screen.findByText(mediaMessage('en', 'media.panel.cancel'))
    fireEvent.click(stop)
    expect(world.cancelled).toEqual(['media-1'])
    finish({ ok: false, refusal: 'cancelled', message: refusalSentence('en', 'cancelled'), detail: 'stopped' })
    expect(await screen.findByText(refusalSentence('en', 'cancelled'))).toBeTruthy()
  })

  it('takes a change notification for the tab it is showing', async () => {
    const world = harness({ findings: [finding()] })
    render(<MediaPanel port={world.port} onClose={vi.fn()} />)
    await screen.findByText('clip.mp4')

    world.publish({ tabId: 'tab-1', findings: [finding({ id: 'media-2', label: 'second.mp4' })] })
    expect(await screen.findByText('second.mp4')).toBeTruthy()
  })

  it('ignores a change notification for another tile’s tab', async () => {
    // The core pushes changes for every tab in the window. A panel that accepted them all
    // would show a background tile's video as if it were this page's.
    const world = harness({ findings: [finding()] })
    render(<MediaPanel port={world.port} onClose={vi.fn()} />)
    await screen.findByText('clip.mp4')

    world.publish({ tabId: 'tab-2', findings: [finding({ id: 'media-3', label: 'other.mp4' })] })
    expect(screen.queryByText('other.mp4')).toBeNull()
    expect(screen.getByText('clip.mp4')).toBeTruthy()
  })

  it('closes on Escape and on a click outside the panel', async () => {
    const onClose = vi.fn()
    render(<MediaPanel port={harness({}).port} onClose={onClose} />)
    await screen.findByRole('dialog')

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)

    const overlay = document.querySelector('.overlay')
    if (overlay === null) throw new Error('expected an overlay')
    fireEvent.mouseDown(overlay)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
