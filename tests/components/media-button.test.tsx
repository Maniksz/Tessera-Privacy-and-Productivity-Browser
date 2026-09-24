import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MediaButton,
  mediaPortFor,
  useMediaFindingCount
} from '@renderer/components/MediaButton.js'
import { Toolbar } from '@renderer/components/Toolbar.js'
import type { MediaFinding } from '@shared/media/model.js'
import type { MediaFindingList } from '@shared/media/wire.js'
import { shortcutTitles } from '@shared/shortcuts/format.js'

/**
 * The toolbar's way to the media panel (media plan R2, R3; roadmap U16).
 *
 * What would go wrong without these: a count that belongs to the tab you just left, a count that
 * never moves because nobody listened for `media:changed`, and a button that draws attention when
 * the page is playing nothing.
 */

const calls: Array<{ channel: string; payload?: unknown }> = []
const listeners = new Map<string, (payload: unknown) => void>()

function finding(id: string, tabId: string): MediaFinding {
  return {
    id,
    tabId,
    url: `https://example.com/${id}.mp4`,
    documentUrl: 'https://example.com/watch',
    kind: 'progressive',
    container: 'mp4',
    contentType: 'video/mp4',
    byteLength: null,
    label: `${id}.mp4`,
    discoveredAt: 1,
    manifest: null
  }
}

function installBridge(byTab: Record<string, readonly MediaFinding[]>): void {
  calls.length = 0
  listeners.clear()
  const bridge = {
    invoke: (channel: string, payload?: unknown): Promise<unknown> => {
      calls.push({ channel, payload })
      const tabId = (payload as { tabId?: string } | undefined)?.tabId ?? ''
      if (channel === 'media:list') return Promise.resolve({ tabId, findings: byTab[tabId] ?? [] })
      return Promise.resolve({ stopped: true })
    },
    on: (channel: string, listener: (payload: unknown) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    },
    channels: { invoke: [], event: [] }
  }
  Object.defineProperty(window, 'tessera', { value: bridge, configurable: true, writable: true })
}

function push(list: MediaFindingList): void {
  act(() => listeners.get('media:changed')?.(list))
}

function Counted({ tabId }: { tabId: string | undefined }): React.ReactNode {
  return <MediaButton count={useMediaFindingCount(tabId)} open={false} onOpen={() => {}} />
}

afterEach(cleanup)

describe('the media button', () => {
  it('shows how many finds the active tab has, and follows the tab', async () => {
    installBridge({ 'tab-1': [finding('a', 'tab-1'), finding('b', 'tab-1')], 'tab-2': [] })
    const { rerender } = render(<Counted tabId="tab-1" />)

    await waitFor(() =>
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Media on this page (2)')
    )
    expect(screen.getByRole('button').textContent).toContain('2')

    rerender(<Counted tabId="tab-2" />)
    await waitFor(() =>
      expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Media on this page (0)')
    )
    expect(
      calls.filter((call) => call.channel === 'media:list').map((call) => call.payload)
    ).toEqual([{ tabId: 'tab-1' }, { tabId: 'tab-2' }])
  })

  it('counts what the core pushes for the active tab and nothing pushed for another', async () => {
    installBridge({ 'tab-1': [] })
    render(<Counted tabId="tab-1" />)
    await waitFor(() => expect(calls).toHaveLength(1))

    push({ tabId: 'tab-2', findings: [finding('x', 'tab-2')] })
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Media on this page (0)')

    push({ tabId: 'tab-1', findings: [finding('y', 'tab-1')] })
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Media on this page (1)')
  })

  it('stays quiet while the page plays nothing', async () => {
    installBridge({})
    render(<Counted tabId="tab-1" />)
    await waitFor(() => expect(calls).toHaveLength(1))

    const button = screen.getByRole('button')
    expect(button.querySelector('[data-part="count"]')).toBeNull()
    expect(button.dataset.found).toBeUndefined()
  })

  it('counts nothing when there is no tab to ask about', () => {
    installBridge({})
    render(<Counted tabId={undefined} />)
    expect(calls).toEqual([])
    expect(screen.getByRole('button').getAttribute('aria-label')).toBe('Media on this page (0)')
  })

  it('opens the panel when pressed', () => {
    installBridge({})
    const onOpen = vi.fn()
    render(<MediaButton count={3} open={false} onOpen={onOpen} />)
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('sits in the toolbar when the chrome hands it a count', () => {
    installBridge({})
    const onOpenMedia = vi.fn()
    render(
      <Toolbar
        tab={undefined}
        split={null}
        settings={null}
        privateMode={false}
        layoutMenuOpen={false}
        media={4}
        onOpenMedia={onOpenMedia}
        onOpenSettings={() => {}}
        onOpenExtensions={() => {}}
        focusRequest={0}
        titleWithShortcut={shortcutTitles('win32')}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Media on this page (4)' }))
    expect(onOpenMedia).toHaveBeenCalledTimes(1)
  })
})

describe('the port the panel talks through', () => {
  it('names the tab on every call, so the panel and the core mean the same page', async () => {
    installBridge({ 'tab-3': [finding('a', 'tab-3')] })
    const port = mediaPortFor('tab-3')

    expect(await port.list()).toMatchObject({ tabId: 'tab-3' })
    await port.describe('a')
    await port.download('a', null)
    await port.download('a', 'v1')
    await port.cancel('a')

    expect(calls).toEqual([
      { channel: 'media:list', payload: { tabId: 'tab-3' } },
      { channel: 'media:describe', payload: { tabId: 'tab-3', findingId: 'a' } },
      { channel: 'media:download', payload: { tabId: 'tab-3', findingId: 'a', variantId: null } },
      { channel: 'media:download', payload: { tabId: 'tab-3', findingId: 'a', variantId: 'v1' } },
      { channel: 'media:cancel', payload: { tabId: 'tab-3', findingId: 'a' } }
    ])
  })

  it('hears what the core pushes', () => {
    installBridge({})
    const heard: MediaFindingList[] = []
    const stop = mediaPortFor('tab-1').subscribe((list) => heard.push(list))
    listeners.get('media:changed')?.({ tabId: 'tab-1', findings: [] })
    stop()
    expect(heard).toEqual([{ tabId: 'tab-1', findings: [] }])
  })
})
