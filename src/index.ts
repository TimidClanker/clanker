import { Chat } from 'chat'
import { createDiscordAdapter } from '@chat-adapter/discord'
import { createMemoryState } from '@chat-adapter/state-memory'

import { registerAdapter } from './adapter'
import { registerDiscordGateway } from './adapter/discord'
import { Orchestrator } from './session/orchestrator'
import { initializeDatabase } from './storage'
import { SessionStore } from './storage/sessions'
import { MemoryStore } from './storage/memory'

async function main() {
  await using sql = await initializeDatabase()
  await using cleanup = new AsyncDisposableStack()

  const io = new Chat({
    userName: 'clanker',
    adapters: {
      ...registerAdapter('discord', 'DISCORD_BOT_TOKEN', createDiscordAdapter)
    },
    state: createMemoryState(),
    logger: 'info'
  })
  cleanup.defer(() => io.shutdown())

  const gateway = new AbortController()
  for (const event of ['SIGINT', 'SIGTERM', 'beforeExit'] as const) process.once(event, () => gateway.abort())

  // Restore subscriptions before accepting gateway events.
  const orchestrator = await Orchestrator.initialize(io, new SessionStore(sql), new MemoryStore(sql))
  cleanup.defer(() => orchestrator.shutdown())
  gateway.signal.addEventListener(
    'abort',
    () => {
      // Start saving immediately; cleanup awaits this same task and reports failures.
      void orchestrator.shutdown().catch(() => {})
    },
    { once: true }
  )

  await registerDiscordGateway(io, gateway.signal).catch(error => {
    if (!gateway.signal.aborted) throw error
  })
}

main().catch(error => {
  console.error('[clanker] Application failed', error)
  process.exitCode = 1
})
