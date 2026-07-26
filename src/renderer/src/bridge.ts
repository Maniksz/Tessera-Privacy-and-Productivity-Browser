import type { EventChannel, InvokeChannel } from '@shared/ipc/channels.js'
import type { EventPayload, InvokeRequest, InvokeResponse } from '@shared/ipc/contract.js'
import type { SettingsKey, SettingValue } from '@shared/settings/definitions.js'

/**
 * Renderer-side access to the core.
 *
 * Thin wrappers over the preload bridge whose only job is to keep the types from
 * the shared contract in play. `setSetting` in particular is typed per key, so
 * assigning a string to a numeric setting is a compile error rather than a
 * rejected IPC call at runtime.
 */

export function invoke<C extends InvokeChannel>(
  channel: C,
  ...args: InvokeRequest<C> extends void | undefined ? [] : [payload: InvokeRequest<C>]
): Promise<InvokeResponse<C>> {
  return window.tessera.invoke(channel, ...args)
}

export function subscribe<C extends EventChannel>(
  channel: C,
  listener: (payload: EventPayload<C>) => void
): () => void {
  return window.tessera.on(channel, listener)
}

/**
 * Writes one setting.
 *
 * Rejects when the core refuses the key or the value; callers must surface that
 * rather than swallow it, because a switch that flips and does nothing is the
 * failure spec 5 forbids.
 */
export function setSetting<K extends SettingsKey>(
  key: K,
  value: SettingValue<K>
): Promise<InvokeResponse<'settings:set'>> {
  return invoke('settings:set', { key, value })
}
