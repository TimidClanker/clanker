import type { Context } from '@earendil-works/chord'
import { MIMEType } from 'node:util'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { Chat } from 'chat'
import { createTransportState } from 'extensions/chat/transport-state'
import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type DocumentReader, type Harness, type TaskId } from '@earendil-works/pi-durable'
import type { selectModel } from 'model'
import { findIdentity, sourceConversation, recordAutomatedInput, recordMessageAuthor, type IdentityAccess } from 'extensions/identity'
import type { createSources } from 'extensions/sources'
import type { createBeeperObserver } from 'extensions/sources/connectors'
import { currentDisclosures, transactionReader } from 'extensions/projects/access'
import type { ProjectDisclosure } from 'extensions/projects/state'
import { Jobs } from 'extensions/jobs/state'
import { checkJob, type JobChat } from 'extensions/jobs/task'
import { accountKey, getBackgroundInputJobs } from 'extensions/identity/state'
import { createAccountLinking, isAccountLinkCommand } from 'extensions/identity/accounts'
import { Discord } from 'extensions/chat/adapters/discord'
import { Beeper } from 'extensions/chat/adapters/beeper'
import { beeperConfig } from 'extensions/chat/adapters/beeper/config'
import { BeeperCheckpoints } from 'extensions/chat/adapters/beeper/state'
import { platformFor, type PlatformAdapter } from 'extensions/chat/adapters'
import { connectChat, prepareConversation, restoreChat } from 'extensions/chat/bridge'
import { createDelivery } from 'extensions/chat/delivery'
import { createMessageConsumer } from 'extensions/chat/consumer'
import { createPost } from 'extensions/chat/post'
import { listSources, threadFor, Messages } from 'extensions/chat/state'
import type { ScheduleChat } from 'extensions/schedules'
import type { SandboxAccess } from 'extensions/sandbox'
import type { MediaDelivery } from 'extensions/media-gen'

export async function createChatIntegration(
  selection: ReturnType<typeof selectModel>,
  getHarness: () => Harness,
  useAgent: <T>(work: (harness: Harness) => Promise<T>) => Promise<T>,
  adapters?: Record<string, PlatformAdapter>,
  observer?: ReturnType<typeof createBeeperObserver>
) {
  if (!adapters) {
    const config = await beeperConfig()
    adapters = {
      discord: new Discord(),
      ...(config.accessToken && (config.accountIDs.length || observer?.accountIDs.length)
        ? {
            beeper: new Beeper(
              config,
              {
                load: (scope, since = Date.now()) =>
                  useAgent(harness =>
                    harness.commit(async tx => {
                      const checkpoints = await tx.doc(BeeperCheckpoints)
                      return { ...(checkpoints[scope] ??= { since, syncedAt: since }) }
                    }, BACKGROUND_CONTEXT)
                  ),
                save: (scope, checkpoint) =>
                  useAgent(harness =>
                    harness.commit(async tx => {
                      ;(await tx.doc(BeeperCheckpoints))[scope] = checkpoint
                    }, BACKGROUND_CONTEXT)
                  )
              },
              observer
            )
          }
        : {})
    }
  }
  const chat = new Chat({
    userName: 'clanker',
    adapters,
    state: await createTransportState(),
    concurrency: { strategy: 'concurrent', maxConcurrent: 1 },
    logger: 'info'
  })
  const shutdown = new AbortController()
  let listening: Promise<unknown> = Promise.resolve()
  let closing: Promise<void> | undefined
  const checkDestination: ScheduleChat['check'] = async (destination, account, ctx, read = getHarness()) => {
    const platform = platformFor(chat, destination.threadId)
    if (!platform.resolveDestination) throw new Error('This platform cannot verify scheduled task destinations')
    const peer = await platform.privateRecipient?.(destination.threadId)
    const owner = await findIdentity(read, account, ctx)
    const linked = peer && owner && (await findIdentity(read, peer, ctx)) === owner
    await platform.resolveDestination(destination.threadId, linked ? peer : account, destination.threadId)
    await chat.thread(destination.threadId).subscribe()
  }
  let checkScope: JobChat['checkScope']
  let supplyJobs: JobChat['supplyJobs']
  let checkDisclosure: ((value: ProjectDisclosure, threadId: string | undefined, ctx: Context) => Promise<void>) | undefined
  const authorizeProject = async (value: ProjectDisclosure, threadId: string, ctx: Context) => {
    if (!checkDisclosure) throw new Error('Project access verification is unavailable')
    await checkDisclosure(value, threadId, ctx)
  }
  const authorizeBackground = async (id: TaskId, threadId: string, ctx: Context) => {
    const job = (await getHarness().snapshot(Jobs, ctx))!.jobs[id]!
    if (job.threadId !== threadId) throw new Error('Background update destination changed')
    await checkJob(
      job,
      getHarness(),
      {
        check: checkDestination,
        checkScope: async (job, ctx, tx) => {
          await checkScope?.(job, ctx, tx)
          for (const value of job.sourceEvidence ?? []) {
            if (!sourceAccess) throw new Error('Source job verification unavailable')
            await sourceAccess.checkEvidence(value, undefined, ctx, tx)
          }
        }
      },
      ctx
    )
  }
  let sourceAccess: ReturnType<typeof createSources> | undefined
  const Post = createPost(
    chat,
    authorizeBackground,
    authorizeProject,
    (value, threadId, ctx) => {
      if (!sourceAccess) throw new Error('Source access unavailable')
      return sourceAccess.checkEvidence(value, threadId, ctx)
    },
    (notice, threadId, ctx) => {
      if (!sourceAccess) throw new Error('Source notification unavailable')
      return sourceAccess.prepareNotice(notice, threadId, ctx)
    },
    (tx, notice, conversationId, text, ctx) => {
      if (!sourceAccess) throw new Error('Source notification receipt unavailable')
      return sourceAccess.recordNotice(tx, notice, conversationId, text, ctx)
    }
  )
  const consumer = createMessageConsumer(Post)
  const Reply = createDelivery(chat, getHarness, Post, consumer, authorizeBackground, (h, c, g, work, ctx) =>
    sourceAccess ? sourceAccess.admit(h, c, g, work, ctx) : work()
  )
  const rename = defineTool({
    name: 'rename_thread',
    description:
      'Set a substantive, specific public title for the current thread. Skip greetings and vague summaries. May be called again when the subject meaningfully changes. Does not modify discovery metadata.',
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }) }),
    replay: 'safe',
    execute: async ({ title }, api, ctx) => {
      ctx.abortSignal?.throwIfAborted()
      const threadId = await threadFor(api, api.conversationId, ctx)
      const platform = platformFor(chat, threadId)
      if (!platform.renameThread) throw new Error('This platform does not support thread renaming')
      return { content: [{ type: 'text', text: JSON.stringify(await platform.renameThread(threadId, title)) }] }
    }
  })
  const agentFor = (threadId: string) => ({
    model: { provider: selection.model.provider, modelId: selection.model.id },
    thinkingLevel: selection.thinkingLevel,
    tools: platformFor(chat, threadId).renameThread ? null : { remove: [rename] }
  })
  const identityAccess: IdentityAccess = {
    async accountLabel(conversationId, account, ctx) {
      const threadId = await threadFor(getHarness(), conversationId, ctx)
      return platformFor(chat, threadId).accountLabel?.(threadId, account)
    },
    async privateAccount(read, conversationId, ctx) {
      conversationId = await sourceConversation(read, conversationId, ctx)
      const source = (await listSources(read, ctx)).find(source => source.id === conversationId)
      return source ? ((await platformFor(chat, source.threadId).privateRecipient?.(source.threadId)) ?? null) : null
    },
    async sendPrivate(conversationId, recipient, text, ctx) {
      ctx.abortSignal?.throwIfAborted()
      const threadId = await threadFor(getHarness(), conversationId, ctx)
      const current = await platformFor(chat, threadId).privateRecipient?.(threadId)
      if (!current || accountKey(current) !== accountKey(recipient)) throw new Error('Private recipient could not be verified')
      await chat.thread(threadId).post(text)
    }
  }
  const accountLinks = createAccountLinking(identityAccess, getHarness)

  return {
    setSourceAccess(access: ReturnType<typeof createSources>) {
      sourceAccess = access
    },
    sources: {
      async notice(tx, conversationId, threadId, sourceNotice) {
        const messages = await tx.doc(Messages, conversationId)
        const post = await tx.createTask(
          Post,
          { threadId, text: '', sourceNotice, previous: messages.lastPost },
          { conversationId, ownership: { kind: 'conversation' } }
        )
        messages.lastPost = post
        return post
      },
      async refreshed(tx, conversationId) {
        const messages = await tx.doc(Messages, conversationId)
        const threadId = await threadFor(transactionReader(tx), conversationId, BACKGROUND_CONTEXT)
        messages.lastPost = await tx.createTask(
          Post,
          {
            threadId,
            text: 'Active model context was refreshed for withdrawn source access. Saved chat was not deleted; I will handle your new message normally.',
            previous: messages.lastPost
          },
          { conversationId, ownership: { kind: 'conversation' } }
        )
      }
    } satisfies Pick<Parameters<typeof createSources>[3], 'notice' | 'refreshed'>,
    setProjectAccess(access: {
      checkScope: NonNullable<JobChat['checkScope']>
      checkDisclosure: NonNullable<typeof checkDisclosure>
      supplyJobs: NonNullable<JobChat['supplyJobs']>
    }) {
      checkScope = access.checkScope
      checkDisclosure = access.checkDisclosure
      supplyJobs = access.supplyJobs
    },
    media: (async (images, api, ctx) => {
      const threadId = await threadFor(api, api.conversationId, ctx)
      const jobs = await getBackgroundInputJobs(api, getHarness(), api.conversationId, ctx)
      const projects = await currentDisclosures(api, api.conversationId, ctx)
      const sources = (await sourceAccess?.evidence(api, api.conversationId, ctx)) ?? []
      const post = await api.commit(async tx => {
        const messages = await tx.doc(Messages, api.conversationId)
        const post = await tx.createTask(
          Post,
          {
            threadId,
            text: '',
            jobs,
            projects,
            sources,
            previous: messages.lastPost,
            files: images.map((image, index) => ({
              data: image.data,
              mimeType: image.mimeType,
              filename: `generated-${index + 1}.${new MIMEType(image.mimeType).subtype.replace('svg+xml', 'svg')}`
            }))
          },
          { ownership: { kind: 'conversation' } }
        )
        messages.lastPost = post
        return post
      }, ctx)
      const task = await api.waitForTask(post, ctx)
      if (task.state.outcome.status !== 'completed') throw new Error('Generated images could not be delivered to chat.')
    }) satisfies MediaDelivery,
    sandbox: {
      async audience(read, conversationId, accounts, ctx) {
        const threadId = await threadFor(read, conversationId, ctx)
        const platform = platformFor(chat, threadId)
        if (!platform.sandboxAudience) throw new Error('This platform cannot verify sandbox membership')
        return platform.sandboxAudience(threadId, accounts)
      }
    } satisfies SandboxAccess,
    schedules: {
      async privateIdentity(read, conversationId, ctx) {
        const account = await identityAccess.privateAccount(read, conversationId, ctx)
        return account ? await findIdentity(read, account, ctx) : undefined
      },
      async resolve(source, account, reference, ctx) {
        const threadId = await threadFor(getHarness(), source, ctx)
        if (reference) {
          const read = getHarness()
          const recipient = await identityAccess.privateAccount(read, source, ctx)
          const owner = await findIdentity(read, account, ctx)
          if (recipient && owner && (await findIdentity(read, recipient, ctx)) === owner) {
            const matches = []
            for (const candidate of await listSources(read, ctx)) {
              const target = platformFor(chat, candidate.threadId)
              const peer = await target.privateRecipient?.(candidate.threadId).catch(() => null)
              if (!peer || (await findIdentity(read, peer, ctx)) !== owner) continue
              const label = await target.accountLabel?.(candidate.threadId, peer)
              if (reference === candidate.threadId || reference === label) matches.push({ threadId: candidate.threadId, title: label ?? candidate.threadId })
            }
            if (matches.length > 1) throw new Error('Ambiguous destination; use the exact thread ID from list_conversations')
            if (matches.length === 1) return matches[0]!
          }
        }
        const platform = platformFor(chat, threadId)
        if (!platform.resolveDestination) throw new Error('This platform does not support directing tasks to other channels')
        return platform.resolveDestination(threadId, account, reference ?? threadId)
      },
      check: checkDestination,
      checkScope: async (job, ctx, tx) => {
        if (job.projectScope?.length && !checkScope) throw new Error('Project access verification is unavailable')
        await checkScope?.(job, ctx, tx)
        for (const value of job.sourceEvidence ?? []) {
          if (!sourceAccess) throw new Error('Source job verification unavailable')
          await sourceAccess.checkEvidence(value, undefined, ctx, tx)
        }
      },
      supplyJobs: async (jobs, api, ctx) => {
        if (jobs.some(job => job.projectScope?.length) && !supplyJobs) throw new Error('Project disclosure verification is unavailable')
        await supplyJobs?.(jobs, api, ctx)
        await sourceAccess?.supplyJobs(jobs, api, ctx)
      },
      captureSources: (tx, api, job, ctx, genuine) => sourceAccess?.captureJob(tx, api, job, ctx, genuine) ?? Promise.resolve(),
      prepare: (tx, destination) => prepareConversation(tx, destination.threadId, agentFor(destination.threadId)),
      async enqueue(tx, conversationId, { schedule, requestId, text, owner, threadId, internal, job }) {
        await recordAutomatedInput(tx, conversationId, requestId, owner, schedule === undefined ? 'background' : 'schedule', job)
        const messages = await tx.doc(Messages, conversationId)
        const reply = await tx.createTask(
          Reply,
          { threadId, messageId: requestId, text, previous: messages.lastTask, schedule, internal, job },
          {
            conversationId,
            ownership: { kind: 'conversation' },
            background: true
          }
        )
        messages.lastTask = reply
        return reply
      }
    } satisfies ScheduleChat & JobChat,
    identity: { ...identityAccess, accounts: accountLinks },
    extension: defineExtension({
      // Keep the stored selection name stable while moving its implementation.
      name: 'clanker',
      tasks: [Reply, Post],
      tools: [rename],
      sections: [
        section('chat', async (input, ctx) => {
          const source = (await listSources(input.read, ctx)).find(source => source.id === input.conversationId)
          return source ? platformFor(chat, source.threadId).renameInstructions : undefined
        })
      ]
    }),
    discovery: {
      list: listSources,
      async scope(read: DocumentReader, threadId: string, ctx: Context) {
        const platform = platformFor(chat, threadId)
        const recipient = await platform.privateRecipient?.(threadId)
        if (recipient) {
          const identity = await findIdentity(read, recipient, ctx)
          return identity ? `identity:${identity}` : null
        }
        const scope = await platform.discoveryScope?.(threadId)
        return scope == null ? null : JSON.stringify([platform.name, scope])
      },
      group(threadId: string) {
        const platform = platformFor(chat, threadId)
        return JSON.stringify([platform.name, platform.discoveryGroup?.(threadId) ?? threadId])
      },
      url: (threadId: string) => platformFor(chat, threadId).sourceUrl?.(threadId) ?? ''
    },
    webhooks: chat.webhooks,
    async restore(harness: Harness) {
      await chat.initialize()
      await consumer.restore(harness)
      await restoreChat(chat, harness, agentFor)
    },
    async connect(onMessage?: Parameters<typeof connectChat>[5]) {
      await chat.initialize()
      await connectChat(chat, useAgent, Reply, selection.model, agentFor, onMessage, async (thread, message) => {
        if (!isAccountLinkCommand(message.text)) return false
        const platform = platformFor(chat, thread.id)
        const sender = platform.identifyAuthor(thread.id, message.author)
        const recipient = await platform.privateRecipient?.(thread.id)
        if (!recipient || accountKey(recipient) !== accountKey(sender)) {
          await thread.post('Account linking is only available in a verified one-to-one chat with Clanker.')
          return true
        }
        try {
          await useAgent(async harness => {
            await harness.commit(async tx => {
              const conversationId = await prepareConversation(tx, thread.id, agentFor(thread.id))
              const author = await recordMessageAuthor(tx, conversationId, message.id, sender, message.author.fullName || message.author.userName)
              await accountLinks.handle(tx, { ...author, conversationId }, message.id, message.text)
            }, BACKGROUND_CONTEXT)
            harness.resume()
          })
        } catch {
          await thread.post('Could not process that linking request. Please try again later, or ask me to start a new link.')
        }
        return true
      })
      listening = Promise.all(Object.values(adapters).map(adapter => adapter.start?.(shutdown.signal)))
      try {
        await listening
      } catch (error) {
        if (!shutdown.signal.aborted) throw error
      }
    },
    close() {
      shutdown.abort()
      return (closing ??= (async () => {
        await consumer.close()
        await chat.shutdown()
        await listening
      })())
    }
  }
}
