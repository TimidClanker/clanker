import { Chat } from 'chat'
import { Database } from 'bun:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createMemoryState } from '@chat-adapter/state-memory'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'

import { connectBot } from './bot'
import { Discord, registerDiscordGateway } from './adapter/discord'
import { models } from './auth'
import { modelSelection, selectModel } from './model'

async function main() {
  const { model, thinkingLevel } = selectModel(modelSelection)
  const luna = model.provider === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna'
  const queryModel = selectModel(process.env.QUERY_MODEL ?? (models.getModel(model.provider, luna) ? `${model.provider}/${luna}:low` : modelSelection))
  if (!(await models.getAuth(model)))
    throw new Error(`No credentials for ${model.provider}. Run bun run login ${model.provider} or configure its API key environment variable.`)

  const databasePath = process.env.DATABASE_PATH ?? './workspace/durable.sqlite'
  await mkdir(dirname(databasePath), { recursive: true })
  // Durable allocates IDs in memory: only one bot may own a database at a time.
  // A separate SQLite lock is released by the OS even if the process crashes.
  using databaseLock = new Database(`${databasePath}.lock`)
  try {
    databaseLock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE')
  } catch (cause) {
    throw new Error(`Cannot exclusively open ${databasePath}. Stop any other Clanker process using it.`, { cause })
  }

  await using cleanup = new AsyncDisposableStack()
  const chat = new Chat({
    userName: 'clanker',
    adapters: { discord: new Discord() },
    state: createMemoryState(),
    concurrency: { strategy: 'concurrent', maxConcurrent: 1 },
    logger: 'info'
  })
  cleanup.defer(() => chat.shutdown())
  await chat.initialize()

  // Pi's supplied SQLite adapter works on Bun; no custom storage implementation is needed.
  const storage = await openNodeSqliteStorage(databasePath)
  const harness = await connectBot(chat, storage, models, { provider: model.provider, modelId: model.id }, thinkingLevel, queryModel)
  cleanup.defer(() => harness.close(BACKGROUND_CONTEXT))

  const gateway = new AbortController()
  const stop = () => {
    gateway.abort()
    void harness.close(BACKGROUND_CONTEXT).catch(error => console.error('[clanker] Shutdown failed', error))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await registerDiscordGateway(chat, gateway.signal)
  } catch (error) {
    if (!gateway.signal.aborted) throw error
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (import.meta.main) {
  main().catch(error => {
    console.error('[clanker]', error)
    process.exitCode = 1
  })
}
