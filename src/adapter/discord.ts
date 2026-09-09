import { type Chat } from 'chat'
import { type DiscordAdapter } from '@chat-adapter/discord'

export async function registerDiscordGateway(instance: Chat) {
  const discord = instance.getAdapter('discord') as DiscordAdapter
  if (!discord) return

  const abortController = new AbortController()
  let gatewayTask: Promise<unknown> | undefined

  const shutdown = () => abortController.abort()
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  while (!abortController.signal.aborted) {
    const response = await discord.startGatewayListener(
      {
        waitUntil(task) {
          gatewayTask = task
        }
      },
      60 * 60 * 1000,
      abortController.signal
    )

    if (!response.ok) {
      throw new Error(await response.text())
    }

    await gatewayTask
  }
}
