import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'

import { openAgent } from 'agent'
import { createChatIntegration } from 'extensions/chat'
import { createDiscovery } from 'extensions/discovery'
import { createWeb } from 'extensions/web'
import { createIdentity } from 'extensions/identity'
import { createSchedules } from 'extensions/schedules'
import { createSandbox } from 'extensions/sandbox'
import { Vercel } from 'extensions/sandbox/providers/vercel'
import { models } from 'auth/store'
import { modelSelection, selectModel } from 'model'
import { openStorage } from 'storage'

async function main() {
  const { model, thinkingLevel } = selectModel(modelSelection)
  const luna = model.provider === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna'
  const queryModel = selectModel(process.env.QUERY_MODEL ?? (models.getModel(model.provider, luna) ? `${model.provider}/${luna}:low` : modelSelection))
  if (!(await models.getAuth(model)))
    throw new Error(`No credentials for ${model.provider}. Run bun run login ${model.provider} or configure its API key environment variable.`)

  const cleanup = new AsyncDisposableStack()
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      // Bound every shutdown path so a stuck operation cannot retain database ownership.
      const timeout = setTimeout(() => {
        console.error('[clanker] Shutdown timed out; exiting to release the database lock.')
        process.exit(1)
      }, 10_000)
      timeout.unref()
      try {
        await cleanup.disposeAsync()
      } finally {
        clearTimeout(timeout)
      }
    })())
  const stop = () => {
    void close().catch(error => console.error('[clanker] Shutdown failed', error))
  }
  try {
    const storage = await openStorage()
    cleanup.defer(() => storage.close(BACKGROUND_CONTEXT))
    const chat = createChatIntegration({ model, thinkingLevel })
    cleanup.defer(() => chat.close())
    const discovery = createDiscovery(chat.discovery, queryModel)
    let harness: Harness
    const sandboxProvider = new Vercel()
    const sandbox = (await sandboxProvider.isConfigured()) ? createSandbox(chat.sandbox, () => harness, sandboxProvider) : undefined
    cleanup.defer(() => sandbox?.close())
    harness = await openAgent(storage, models, [
      createIdentity(chat.identity),
      chat.extension,
      createSchedules(chat.schedules, () => harness),
      discovery.extension,
      createWeb(models, selectModel(process.env.SEARCH_MODEL ?? modelSelection)),
      ...(sandbox ? [sandbox.extension] : [])
    ])
    cleanup.defer(() => harness.close(BACKGROUND_CONTEXT))
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
    await chat.connect(harness, discovery.record)
  } finally {
    process.off('SIGINT', stop)
    process.off('SIGTERM', stop)
    await close()
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
