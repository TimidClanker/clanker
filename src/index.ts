import { Chat } from 'chat'
import { createDiscordAdapter } from '@chat-adapter/discord'
import { createMemoryState } from '@chat-adapter/state-memory'

import { registerAdapter } from './adapter'
import { registerDiscordGateway } from './adapter/discord'
import { Orchestrator } from './session/orchestrator'

// The Chat instance is the I/O for the Clanker. All user inputs and outputs happen via the adapters
const io = new Chat({
  userName: 'clanker',
  adapters: {
    ...registerAdapter('discord', 'DISCORD_BOT_TOKEN', createDiscordAdapter)
  },
  state: createMemoryState(),
  logger: 'info'
})

// The Orchestrator is a meta agent that coordinates all sessions for the chat instance
await Orchestrator.initialize(io)

// Discord needs a gateway to receive incoming messages
registerDiscordGateway(io)
