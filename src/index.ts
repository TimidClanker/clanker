import { createRuntime } from 'runtime'
import { createChatIntegration } from 'extensions/chat'
import { createDiscovery } from 'extensions/discovery'
import { createWeb } from 'extensions/web'
import { createMediaGen } from 'extensions/media-gen'
import { OpenAICodex } from 'extensions/media-gen/providers/openai-codex'
import { OpenRouter } from 'extensions/media-gen/providers/openrouter'
import { createIdentity } from 'extensions/identity'
import { createSchedules } from 'extensions/schedules'
import { createProjects } from 'extensions/projects'
import { createJobs } from 'extensions/jobs'
import { createSources } from 'extensions/sources'
import { sourceBindings, createWebhookAdapter, createBeeperObserver } from 'extensions/sources/connectors'
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
    const bindings = await sourceBindings()
    let sources: ReturnType<typeof createSources>
    let runtime: ReturnType<typeof createRuntime>
    const observer = createBeeperObserver(
      bindings,
      (binding, event) => sources.ingest(binding, event),
      () => runtime.use(() => sources.observerBindings())
    )
    const chat = await createChatIntegration(
      { model, thinkingLevel },
      () => runtime.get(),
      work => runtime.use(work),
      undefined,
      observer
    )
    cleanup.defer(() => chat.close())
    const projects = createProjects(chat.schedules, () => runtime.get())
    chat.setProjectAccess(projects)
    sources = createSources(
      bindings,
      models,
      process.env.SOURCES_CLASSIFIER,
      { ...chat.schedules, ...chat.sources },
      projects.access,
      () => runtime.get(),
      work => runtime.use(work)
    )
    chat.setSourceAccess(sources)
    cleanup.defer(() => sources.close())
    const discovery = createDiscovery(chat.discovery, queryModel, sources)
    const sandboxProvider = new Vercel()
    const sandbox = (await sandboxProvider.isConfigured()) ? createSandbox(chat.sandbox, () => runtime.get(), sandboxProvider) : undefined
    cleanup.defer(() => sandbox?.close())
    runtime = createRuntime(
      models,
      [
        createIdentity(chat.identity),
        chat.extension,
        createSchedules(chat.schedules, () => runtime.get()),
        createJobs(chat.schedules, () => runtime.get()),
        projects.extension,
        sources.extension,
        discovery.extension,
        createWeb(models, selectModel(process.env.SEARCH_MODEL ?? modelSelection)),
        createMediaGen([new OpenAICodex(models), new OpenRouter(models)], chat.media),
        ...(sandbox ? [sandbox.extension] : [])
      ],
      shutdown.signal,
      async harness => {
        await sources.restore(harness)
        await chat.restore(harness)
      }
    )
    cleanup.defer(() => runtime.finished)
    if (process.env.SOURCES_PORT) {
      if (!bindings.some(binding => binding.provider !== 'beeper')) throw new Error('SOURCES_PORT requires explicit webhook bindings')
      const webhook = createWebhookAdapter(bindings, sources.ingest)
      const server = Bun.serve({
        hostname: process.env.SOURCES_HOST ?? '127.0.0.1',
        port: Number(process.env.SOURCES_PORT),
        maxRequestBodySize: 262144,
        fetch: request => {
          const match = /^\/sources\/([A-Za-z0-9_-]+)$/.exec(new URL(request.url).pathname)
          return match ? webhook(request, match[1]!) : new Response('Not found', { status: 404 })
        }
      })
      cleanup.defer(() => server.stop(true))
    }
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
