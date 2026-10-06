import { createRuntime } from 'runtime'
import { createChatIntegration } from 'extensions/chat'
import { createDiscovery } from 'extensions/discovery'
import { createWeb } from 'extensions/web'
import { createMediaGen } from 'extensions/media-gen'
import { OpenAICodex } from 'extensions/media-gen/providers/openai-codex'
import { OpenRouter } from 'extensions/media-gen/providers/openrouter'
import { createIdentity } from 'extensions/identity'
import { createSchedules } from 'extensions/schedules'
import { createSandbox } from 'extensions/sandbox'
import { Vercel } from 'extensions/sandbox/providers/vercel'
import { models } from 'auth/store'
import { modelSelection, selectModel } from 'model'

async function main() {
  const { model, thinkingLevel } = selectModel(modelSelection)
  const luna = model.provider === 'openrouter' ? 'openai/gpt-6-luna' : 'gpt-6-luna'
  const queryModel = selectModel(process.env.QUERY_MODEL ?? (models.getModel(model.provider, luna) ? `${model.provider}/${luna}:low` : modelSelection))
  if (!(await models.getAuth(model)))
    throw new Error(`No credentials for ${model.provider}. Run bun run login ${model.provider} or configure its API key environment variable.`)

  const cleanup = new AsyncDisposableStack()
  const shutdown = new AbortController()
  let closing: Promise<void> | undefined
  const close = () =>
    (closing ??= (async () => {
      shutdown.abort(new Error('Clanker is shutting down'))
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
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  try {
    let runtime: ReturnType<typeof createRuntime>
    const chat = await createChatIntegration(
      { model, thinkingLevel },
      () => runtime.get(),
      work => runtime.use(work)
    )
    cleanup.defer(() => chat.close())
    const discovery = createDiscovery(chat.discovery, queryModel)
    const sandboxProvider = new Vercel()
    const sandbox = (await sandboxProvider.isConfigured()) ? createSandbox(chat.sandbox, () => runtime.get(), sandboxProvider) : undefined
    cleanup.defer(() => sandbox?.close())
    runtime = createRuntime(
      models,
      [
        createIdentity(chat.identity),
        chat.extension,
        createSchedules(chat.schedules, () => runtime.get()),
        discovery.extension,
        createWeb(models, selectModel(process.env.SEARCH_MODEL ?? modelSelection)),
        createMediaGen([new OpenAICodex(models), new OpenRouter(models)], chat.media),
        ...(sandbox ? [sandbox.extension] : [])
      ],
      shutdown.signal,
      chat.restore
    )
    cleanup.defer(() => runtime.finished)
    await Promise.race([runtime.finished, chat.connect(discovery.record)])
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
