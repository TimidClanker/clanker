import { type Chat } from 'chat'
import { type DiscordAdapter } from '@chat-adapter/discord'

export async function registerDiscordGateway(instance: Chat, signal: AbortSignal) {
  const discord = instance.getAdapter('discord') as DiscordAdapter
  if (!discord) return

  let gatewayTask: Promise<unknown> | undefined

  while (!signal.aborted) {
    const response = await discord.startGatewayListener(
      {
        waitUntil(task) {
          gatewayTask = task
        }
      },
      60 * 60 * 1000,
      signal
    )

    if (!response.ok) {
      throw new Error(await response.text())
    }

    await gatewayTask
  }
}
