import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { INVOKE_CHANNELS, type InvokeChannel } from '@shared/ipc/channels.js'
import { invokeContract, type InvokeHandlerArg, type InvokeResponse } from '@shared/ipc/contract.js'
import { decideAccess } from './sender-policy.js'

/**
 * Typed, validated IPC registration.
 *
 * Two guarantees, both mechanical rather than reviewed:
 *
 *   - **Static**: the handler's argument and return types come from the shared
 *     contract, so renaming a field breaks the build in the main process and in
 *     the renderer at the same time (spec 6).
 *   - **Runtime**: every request is parsed against its schema before the handler
 *     sees it. The main process must not trust the renderer, even our own — a
 *     compromised content process is exactly the threat the sandbox exists for.
 *
 * `assertAllChannelsRegistered` closes the last gap: a channel declared in the
 * contract but never wired up would otherwise fail only when a user clicks the
 * thing that needs it.
 */

const registered = new Set<InvokeChannel>()

/**
 * Tells the router which renderers are the trusted chrome UI.
 *
 * Supplied by `WindowRegistry` rather than inferred from a URL: in development
 * the chrome UI is served over http, and any URL rule loose enough to accept that
 * would accept a web page too.
 */
let isChromeRenderer: (event: IpcMainInvokeEvent) => boolean = () => false

export function configureSenderPolicy(check: (event: IpcMainInvokeEvent) => boolean): void {
  isChromeRenderer = check
}

export type InvokeHandler<C extends InvokeChannel> = (
  payload: InvokeHandlerArg<C>,
  event: IpcMainInvokeEvent
) => Promise<InvokeResponse<C>> | InvokeResponse<C>

export function handle<C extends InvokeChannel>(channel: C, handler: InvokeHandler<C>): void {
  if (registered.has(channel)) {
    throw new Error(`IPC channel registered twice: ${channel}`)
  }
  registered.add(channel)

  ipcMain.handle(channel, async (event, rawPayload: unknown) => {
    const definition = invokeContract[channel]

    // Who is calling, before what they are asking for. The preload keeps its own
    // allowlist, but a compromised renderer is exactly the case where the
    // preload's copy cannot be trusted — so the decision is made again here.
    const access = decideAccess(channel, {
      frameUrl: event.senderFrame?.url ?? null,
      isChromeRenderer: isChromeRenderer(event)
    })
    if (!access.allowed) {
      throw new Error(`Refused: ${access.reason}`)
    }

    const parsedRequest = definition.request.safeParse(rawPayload)
    if (!parsedRequest.success) {
      const detail = parsedRequest.error.issues
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new Error(`Invalid request on ${channel}: ${detail}`)
    }

    const result = await handler(parsedRequest.data as InvokeHandlerArg<C>, event)

    // Response validation in development only: it catches a handler drifting
    // from the contract during work, without paying the cost on every call in
    // a shipped build.
    if (process.env['NODE_ENV'] !== 'production') {
      const parsedResponse = definition.response.safeParse(result)
      if (!parsedResponse.success) {
        const detail = parsedResponse.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')
        throw new Error(`Handler for ${channel} returned an invalid response: ${detail}`)
      }
    }

    return result
  })
}

/** Throws at startup if any contract channel has no handler. */
export function assertAllChannelsRegistered(): void {
  const missing = INVOKE_CHANNELS.filter((channel) => !registered.has(channel))
  if (missing.length > 0) {
    throw new Error(`IPC channels declared but never handled: ${missing.join(', ')}`)
  }
}

export const OK = { ok: true } as const
