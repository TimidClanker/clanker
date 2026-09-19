import type { Chat, Thread, Message } from 'chat'

import { ClankerSession } from '.'
import { SessionStore, type SavedSessionSummary, type SessionIdentity } from '../storage/sessions'
import { MemoryStore } from '../storage/memory'
import { createMemoryTools } from './tools/memory'
import { createUserTools } from './tools/users'
import { UserStore } from '../storage/users'
import { describeAttachments, prepareAttachments } from './attachments'
import type { RoutingBackend, RoutingInput } from './routing'
import { LLMRoutingBackend } from './routing/llm'
import { TypeSafeRoutingBackend } from './routing/typesafe'

type LiveSession = Omit<SavedSessionSummary, 'id' | 'metadata'> & {
  session: ClankerSession
  busy: number
  metadataTask?: Promise<void>
  retire: boolean
  context?: { thread: Thread; message: Message }
}

export class Orchestrator {
  private static readonly sessionLimit = 32
  private sessions = new Map<string, LiveSession>()
  private routingAbort = new AbortController()
  private pending = new Set<Promise<void>>()
  private storageQueue: Promise<void> = Promise.resolve()
  private flushTask?: Promise<void>
  private shutdownTask?: Promise<void>
  private stopping = false
  private cron: Bun.CronJob

  protected constructor(
    private backends: RoutingBackend[],
    private store: SessionStore,
    private memoryStore: MemoryStore,
    private userStore: UserStore,
    chat: Chat
  ) {
    chat.onNewMention(this.handleIncomingMessage)
    chat.onDirectMessage(this.handleIncomingMessage)
    chat.onSubscribedMessage(this.handleIncomingMessage)
    this.cron = Bun.cron('* * * * *', () => this.flush().catch(error => console.error('[storage] Periodic flush failed', error))).unref()
    process.on('memoryPressure', this.handleMemoryPressure)
  }

  static async initialize(chat: Chat, store: SessionStore, memoryStore: MemoryStore, userStore: UserStore) {
    const apiKey = process.env.TYPESAFE_API_KEY?.trim()
    const backends: RoutingBackend[] = [...(apiKey ? [new TypeSafeRoutingBackend(apiKey)] : []), new LLMRoutingBackend()]
    try {
      await chat.initialize()
      for (const threadId of await store.threads()) await chat.thread(threadId).subscribe()
      return new Orchestrator(backends, store, memoryStore, userStore, chat)
    } catch (error) {
      for (const backend of backends) backend.dispose?.()
      throw error
    }
  }

  private async selectSession(input: RoutingInput) {
    const started = performance.now()
    const decide = (id?: string, backend = 'none') => {
      console.log('[orchestrator] Routing decision', {
        threadId: input.threadId,
        messageId: input.message.id,
        backend,
        action: id === undefined ? 'new' : 'resume',
        sessionId: id ?? null,
        durationMs: Math.round(performance.now() - started)
      })
      return id
    }
    const { signal } = this.routingAbort
    signal.throwIfAborted()
    if (input.sessions.length === 0) return decide()
    for (const [index, backend] of this.backends.entries()) {
      try {
        const id = await backend.selectSession(input, signal)
        signal.throwIfAborted()
        if (id !== undefined && !input.sessions.some(session => session.id === id)) throw new Error(`${backend.name} returned an ineligible session`)
        return decide(id, backend.name)
      } catch (error) {
        signal.throwIfAborted()
        if (index === this.backends.length - 1) throw error
        console.warn(`[routing] ${backend.name} failed; trying ${this.backends[index + 1]!.name}`, error)
      }
    }
  }

  // Cache mutations and snapshots share a queue; model calls run outside it.
  private withStorage<T>(action: () => Promise<T>): Promise<T> {
    const task = this.storageQueue.then(action)
    this.storageQueue = task.then(
      () => {},
      () => {}
    )
    return task
  }

  protected handleIncomingMessage = (thread: Thread, message: Message) => {
    if (this.stopping) return Promise.resolve()
    const accepted = Promise.withResolvers<void>()
    const task = this.routeMessage(thread, message, accepted.resolve).finally(() => {
      this.pending.delete(task)
      // Failures before acceptance must also release the next incoming message.
      accepted.resolve()
    })
    this.pending.add(task)
    return accepted.promise
  }

  private async routeMessage(thread: Thread, message: Message, onAccepted: () => void) {
    try {
      const eligibleSessions = await this.withStorage(async () => {
        await this.retireIdleSessions()
        const identity = await this.identity(thread, message)
        const candidates = new Map((await this.store.list(thread.id, identity, Orchestrator.sessionLimit)).map(s => [s.id, s]))
        // The model can select work, but cannot change its owner or audience.
        for (const live of this.sessions.values()) {
          if (live.threadId === thread.id && this.owns(live, identity)) candidates.set(live.session.id, this.summarize(live))
        }
        return [...candidates.values()]
          .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || b.id.localeCompare(a.id))
          .slice(0, Orchestrator.sessionLimit)
      })
      if (this.stopping) return
      const id = await this.selectSession({ threadId: thread.id, message, sessions: eligibleSessions })
      const live = await this.withStorage(() => this.acquireSession(id, thread, message))
      if (live) await this.runSession(live, thread, message, onAccepted)
    } catch (error) {
      console.error(error)
      if (!this.stopping) {
        await thread.post(`☠️ Unable to process message. \`${error}\``).catch(error => console.error('[orchestrator] Unable to report failure', error))
      }
    }
  }

  private async acquireSession(id: string | undefined, thread: Thread, message: Message) {
    if (this.stopping) return
    const identity = await this.identity(thread, message)
    let live = id ? this.sessions.get(id) : undefined
    if (!live) {
      const saved = id ? await this.store.load(id, identity, thread.id) : undefined
      const sessionId = saved?.id ?? `${thread.id}:${Bun.randomUUIDv7()}`
      const customTools = this.createTools(sessionId)
      const session = saved
        ? await ClankerSession.restore(saved.id, saved.metadata, saved.snapshot, customTools)
        : await ClankerSession.create(sessionId, {
            model: process.env.DEFAULT_MODEL?.trim() || 'gpt-5.6-sol',
            customTools
          })
      const now = new Date().toISOString()
      live = {
        session,
        threadId: thread.id,
        adapter: saved?.adapter ?? identity.adapter,
        ownerId: saved?.ownerId ?? identity.platformUserId,
        userId: identity.userId,
        createdAt: saved?.createdAt ?? now,
        lastActiveAt: saved?.lastActiveAt ?? now,
        busy: 0,
        retire: false
      }
      this.sessions.set(session.id, live)
    }
    if (live.threadId !== thread.id || !this.owns(live, identity)) throw new Error('Session belongs to another thread or owner')
    if (this.stopping) return
    live.busy++
    live.lastActiveAt = new Date().toISOString()
    this.sessions.delete(live.session.id)
    this.sessions.set(live.session.id, live)
    return live
  }

  private async runSession(live: LiveSession, thread: Thread, message: Message, onAccepted: () => void) {
    const { session } = live
    try {
      if (this.stopping) return
      await session.attach(thread)
      if (this.stopping) return
      const { files, images } = await prepareAttachments(message, this.routingAbort.signal)
      // Finish an existing metadata snapshot before starting another agent run.
      await live.metadataTask
      if (this.stopping) return
      await session.prompt(
        [
          `You received this message:`,
          `Thread ID: ${thread.id}`,
          `Sender: ${JSON.stringify(message.author)}`,
          `Persistent user ID: ${(await this.identity(thread, message)).userId ?? 'none (registration is optional)'}`,
          `Conversation: ${thread.isDM ? 'private chat' : 'shared conversation'}`,
          `Message:\n${message.text}`,
          files.length > 0 &&
            `Attachments:\n${JSON.stringify(files)}\nImages marked inlineImage are included in the same order. Use your tools to read the saved files at their local paths.`
        ],
        {
          images,
          contextKey: JSON.stringify([thread.adapter.name, message.author.userId]),
          onStart: () => {
            live.context = { thread, message }
          },
          onAccepted: () => {
            session.metadata.lastMessage = [message.text, message.attachments.length > 0 && `Attachments: ${JSON.stringify(describeAttachments(message))}`]
              .filter(Boolean)
              .join('\n')
            onAccepted()
          }
        }
      )
      if (!this.stopping && live.busy === 1) {
        live.metadataTask = session.updateMetadata().catch(error => console.error(`[clanker] Unable to update metadata for ${session.id}`, error))
        await live.metadataTask
        live.metadataTask = undefined
      }
    } finally {
      live.busy--
      if (!this.stopping) await this.withStorage(() => this.retireIdleSessions())
    }
  }

  private async identity(thread: Thread, message: Message): Promise<SessionIdentity> {
    const connection = { adapter: thread.adapter.name, platformUserId: message.author.userId }
    return { ...connection, userId: (await this.userStore.resolve(connection))?.id ?? null }
  }

  private owns(session: Omit<SavedSessionSummary, 'id' | 'metadata'>, identity: SessionIdentity) {
    return identity.userId
      ? session.userId === identity.userId
      : session.userId === null && session.adapter === identity.adapter && session.ownerId === identity.platformUserId
  }

  private createTools(sessionId: string) {
    const context = () => this.sessions.get(sessionId)!.context!
    const identity = () => {
      const { thread, message } = context()
      return this.identity(thread, message)
    }
    const accountIdentity = async () => {
      if (!context().thread.isDM) throw new Error('Account management is only available in private chats')
      return identity()
    }
    const requireUser = async () => {
      const actor = await accountIdentity()
      if (!actor.userId) throw new Error('Create or link an account first')
      return { ...actor, userId: actor.userId }
    }
    const connect = async (code?: string) => {
      const actor = await accountIdentity()
      return this.withStorage(async () => {
        const user = code === undefined ? await this.userStore.enroll(actor) : await this.userStore.redeemLink(actor, code)
        for (const live of this.sessions.values()) {
          if (live.userId === null && live.adapter === actor.adapter && live.ownerId === actor.platformUserId) {
            live.userId = user.id
            await this.save(live)
          }
        }
        return user
      })
    }
    return [
      ...createMemoryTools(async () => this.memoryStore.forUser((await identity()).userId)),
      ...createUserTools({
        enroll: () => connect(),
        redeemLink: code => connect(code),
        connections: async () => {
          const actor = await requireUser()
          return { userId: actor.userId, connections: await this.userStore.connections(actor.userId) }
        },
        issueLink: async () => this.userStore.issueLink((await requireUser()).userId)
      })
    ]
  }

  private summarize({ session, threadId, adapter, ownerId, userId, createdAt, lastActiveAt }: LiveSession): SavedSessionSummary {
    return { id: session.id, threadId, adapter, ownerId, userId, createdAt, lastActiveAt, metadata: session.metadata }
  }

  private save(live: LiveSession) {
    return this.store.save(this.summarize(live), live.session.snapshot())
  }

  private evict(live: LiveSession) {
    live.session.session.dispose()
    this.sessions.delete(live.session.id)
    console.log(`[clanker] Retired session ${live.session.id}`)
  }

  private async retireIdleSessions() {
    for (const live of this.sessions.values()) {
      if (live.busy || !live.session.session.isIdle) continue
      if (!live.retire && this.sessions.size <= Orchestrator.sessionLimit) continue
      await this.save(live)
      this.evict(live)
    }
  }

  flush() {
    return (this.flushTask ??= this.withStorage(async () => {
      const errors: unknown[] = []
      for (const live of this.sessions.values()) {
        // Busy turns may finish while saving; only evict a snapshot taken while idle.
        const retire = live.retire && !live.busy && live.session.session.isIdle
        try {
          await this.save(live)
          if (retire) this.evict(live)
        } catch (error) {
          errors.push(error)
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Unable to save sessions')
    }).finally(() => {
      this.flushTask = undefined
    }))
  }

  private handleMemoryPressure = () => {
    for (const live of this.sessions.values()) live.retire = true
    void this.flush()
      .then(() => this.withStorage(() => this.retireIdleSessions()))
      .catch(error => console.error('[storage] Memory pressure flush failed', error))
  }

  shutdown() {
    if (this.shutdownTask) return this.shutdownTask
    this.stopping = true
    this.routingAbort.abort()
    this.cron.stop()
    process.off('memoryPressure', this.handleMemoryPressure)
    return (this.shutdownTask = (async () => {
      const aborts = await Promise.allSettled(Array.from(this.sessions.values(), s => s.session.abort()))
      for (const result of aborts) if (result.status === 'rejected') console.error('[clanker] Unable to abort session', result.reason)
      await Promise.allSettled(this.pending)
      // An earlier periodic snapshot may predate an aborted turn's final entries.
      await this.flushTask?.catch(() => {})
      await this.storageQueue
      try {
        await this.flush()
      } finally {
        for (const live of this.sessions.values()) live.session.session.dispose()
        this.sessions.clear()
        for (const backend of this.backends) backend.dispose?.()
      }
    })())
  }
}
