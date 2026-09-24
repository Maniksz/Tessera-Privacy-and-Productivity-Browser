import { describe, expect, it, vi } from 'vitest'
import type { AutofillParts } from '@main/passwords/install-autofill.js'
import type { MasterPasswordPrompt } from '@main/passwords/MasterPasswordPrompt.js'
import type { PasswordApi } from '@main/passwords/PasswordApi.js'
import type { WindowRegistry } from '@main/browser/WindowRegistry.js'
import { notifyOverlayVacancy } from '@main/permissions/vacancy.js'
import type { AutofillSuggestPresentation } from '@shared/overlay/surface.js'

/**
 * The autofill half of the vault's channels: the picker's two answers and the toolbar key's two
 * requests, joined to the parts that decide them.
 *
 * Each of these is one line, and each is the shape this project has shipped dead before — a surface
 * that draws, walks and reads out perfectly and whose answer reaches nothing. The router is replaced
 * so the handlers can be called as the router would call them, with the event it would pass.
 */

type Handler = (payload: unknown, event: { sender: { id: number } }) => unknown
const handlers = vi.hoisted(() => new Map<string, Handler>())

vi.mock('@main/ipc/router.js', () => ({
  OK: { ok: true },
  handle: (channel: string, handler: Handler) => {
    handlers.set(channel, handler)
  }
}))

const { registerPasswordHandlers } = await import('@main/ipc/password-handlers.js')

const calls: unknown[][] = []
const chromeWindow = { id: 'the sending window' }
const autofill = {
  service: {},
  suggest: {
    choose: (...args: unknown[]) => calls.push(['choose', ...args]),
    unlock: (...args: unknown[]) => calls.push(['unlock', ...args]),
    overlayVacated: (...args: unknown[]) => calls.push(['vacated', ...args])
  },
  keyStateFor: (window: unknown) => {
    calls.push(['keyStateFor', window])
    return { vault: 'open', matches: 1 }
  },
  fillActiveTab: (...args: unknown[]) => calls.push(['fillActiveTab', ...args])
} as unknown as AutofillParts

registerPasswordHandlers({
  passwords: {} as unknown as PasswordApi,
  prompt: {
    overlayVacated: () => undefined,
    key: () => undefined
  } as unknown as MasterPasswordPrompt,
  autofill,
  windows: {
    controllerForWebContents: (id: number) => (id === 3 ? chromeWindow : undefined)
  } as unknown as WindowRegistry
})

function call(channel: string, payload?: unknown): unknown {
  const handler = handlers.get(channel)
  if (handler === undefined) throw new Error(`${channel} is not registered`)
  calls.length = 0
  return handler(payload, { sender: { id: 3 } })
}

describe('the account picker’s answers', () => {
  it('hands a choice and an unlock to the picker, and nothing back', () => {
    expect(
      call('passwords:answerSuggestion', { requestId: 'r1', action: 'choose', entryId: 'e' })
    ).toEqual({ ok: true })
    expect(calls).toEqual([['choose', 'r1', 'e']])

    call('passwords:answerSuggestion', { requestId: 'r1', action: 'unlock' })
    expect(calls).toEqual([['unlock', 'r1']])
  })

  it('tells the picker when its surface leaves the layer', () => {
    const presentation: AutofillSuggestPresentation = {
      kind: 'autofill-suggest',
      requestId: 'r1',
      tileIndex: 0,
      bounds: { x: 0, y: 0, width: 320, height: 100 },
      content: { state: 'empty' }
    }
    calls.length = 0

    notifyOverlayVacancy(presentation, 'dismissed')

    expect(calls).toEqual([['vacated', presentation]])
  })
})

describe('the toolbar key', () => {
  it('answers with the state of the sending window’s active tile', () => {
    expect(call('passwords:autofillState')).toEqual({ vault: 'open', matches: 1 })
    expect(calls).toEqual([['keyStateFor', chromeWindow]])
  })

  it('asks for a fill in the sending window, hanging from the key', () => {
    const anchor = { x: 1, y: 2, width: 3, height: 4 }

    expect(call('passwords:fillFromToolbar', { anchor })).toEqual({ ok: true })
    expect(calls).toEqual([['fillActiveTab', chromeWindow, anchor]])
  })
})
