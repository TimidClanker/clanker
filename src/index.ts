import { Database } from 'bun:sqlite'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import type { Harness } from '@earendil-works/pi-durable'

import { openAgent } from 'agent'
import { createChatIntegration } from 'extensions/chat'
import { createDiscovery } from 'extensions/discovery'
import { createWeb } from 'extensions/web'
import { createIdentity } from 'extensions/identity'
import { createSchedules } from 'extensions/schedules'
import { models } from 'auth/store'
import { modelSelection, selectModel } from 'model'

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
  const chat = createChatIntegration({ model, thinkingLevel })
  cleanup.defer(() => chat.close())

  // Pi's supplied SQLite adapter works on Bun; no custom storage implementation is needed.
  const storage = await openNodeSqliteStorage(databasePath)
  let harness: Harness
  harness = await openAgent(storage, models, [
    createIdentity(chat.identity),
    chat.extension,
    createSchedules(chat.schedules, () => harness),
    createDiscovery(chat.discovery, queryModel),
    createWeb(models, selectModel(process.env.SEARCH_MODEL ?? modelSelection))
  ])
  cleanup.defer(() => harness.close(BACKGROUND_CONTEXT))

  const stop = () => {
    // A stuck SDK/network operation must not keep the process and database lock alive forever.
    setTimeout(() => {
      console.error('[clanker] Shutdown timed out; exiting to release the database lock.')
      process.exit(1)
    }, 10_000).unref()
    void Promise.all([chat.close(), harness.close(BACKGROUND_CONTEXT)]).catch(error => console.error('[clanker] Shutdown failed', error))
  }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    await chat.connect(harness)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
  }
}

if (import.meta.main) {
  main().then(
    () => process.exit(0),
    error => {
      console.error('[clanker]', error)
      process.exit(1)
    }
  )
}
