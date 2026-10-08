import { BACKGROUND_CONTEXT as context } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { AssistantEntry, watchEvents, type ConversationId, type Cursor, type EntryId, type EntryRecord, type Harness } from '@earendil-works/pi-durable'
import { Messages, Threads, listSources } from 'extensions/chat/state'
import { Delegation } from 'extensions/identity'
import { SourceDisclosures } from 'extensions/sources/state'
import { ProjectDisclosures } from 'extensions/projects/state'
import { JobAnswerScopes } from 'extensions/jobs/state'
import type { createPost } from 'extensions/chat/post'

/** One committed-message consumer per foreground chat, independent of submission/task cancellation. */
export function createMessageConsumer(Post: ReturnType<typeof createPost>) {
  let active: Harness | undefined
  const consumers = new Map<ConversationId, Promise<Awaited<ReturnType<typeof open>>>>()

  async function open(harness: Harness, conversationId: ConversationId, threadId: string) {
    const stream = await watchEvents(harness, conversationId, context)
    let stopped = false
    let working: Promise<unknown> = Promise.resolve()
    // Session commits serialize event delivery and settlement recovery against the durable cursor.
    const consume = (entries: readonly EntryRecord[], recovery?: true | EntryId) => {
      const result = harness.commit(async tx => {
        if (stopped) throw new Error('Chat message consumer stopped')
        if ((await tx.doc(Threads)).threads[threadId] !== conversationId || (await tx.doc(Delegation, conversationId)).jobId !== undefined)
          throw new Error('Only the mapped chat coordinator can deliver assistant messages')
        const messages = await tx.doc(Messages, conversationId)
        const examined = messages.cursor ?? messages.lastAnswer
        let pending = entries
        // Snapshots contain active context only. Durable suffix lookup also finds compacted-away messages.
        if (recovery === true || (recovery !== undefined && (examined === undefined || examined < recovery))) {
          const found: EntryRecord[] = []
          let cursor: Cursor | undefined
          do {
            const page = await tx.scanEntries({ conversationId, minEntryId: examined, ...(recovery === true ? {} : { maxEntryId: recovery }) }, 256, cursor)
            found.push(...page.items)
            cursor = page.next
          } while (cursor !== undefined)
          pending = found
        }
        const scopes = await tx.doc(JobAnswerScopes, conversationId)
        const disclosures = await tx.doc(ProjectDisclosures, conversationId)
        const sourceDisclosures = await tx.doc(SourceDisclosures, conversationId)
        const ready = []
        let next = examined
        for (const entry of [...pending].sort((a, b) => a.id - b.id)) {
          if (entry.conversationId !== conversationId || (examined !== undefined && entry.id <= examined)) continue
          next = entry.id
          if (!AssistantEntry.is(entry)) continue
          const answer = entry.model?.[0] as AssistantMessage | undefined
          if (!answer || answer.role !== 'assistant' || !['stop', 'length', 'toolUse'].includes(answer.stopReason)) continue
          const text = answer.content
            .flatMap(part => (part.type === 'text' ? [part.text] : []))
            .join('\n')
            .trim()
          // lastAnswer also respects the terminal receipt from the older, terminal-only implementation.
          if (!text || messages.lastAnswer === entry.id || messages.replies?.[entry.id] !== undefined) continue
          const generation = entry.byTaskId === undefined ? undefined : await tx.task(entry.byTaskId)
          if (generation?.kind !== 'pi.generation') throw new Error('Assistant delivery origin unavailable')
          // Cancellation can win the enqueue race; don't create a new Post for withdrawn work.
          if (generation.abortRequested) continue
          const jobs = scopes.generations[generation.id]
          const projects = disclosures.generations[generation.id]
          if (jobs === undefined || projects === undefined) throw new Error('Assistant delivery authorization evidence unavailable')
          const sources = sourceDisclosures.generations[generation.id] ?? []
          ready.push({ entry: entry.id, text, jobs, projects, sources })
        }
        // All reads precede task writes; receipts, immutable envelopes and the cursor commit together.
        for (const { entry, text, jobs, projects, sources } of ready) {
          const post = await tx.createTask(
            Post,
            { threadId, text, jobs, projects, sources, previous: messages.lastPost },
            { conversationId, ownership: { kind: 'conversation' } }
          )
          messages.replies ??= {}
          messages.replies[entry] = post
          messages.lastPost = post
        }
        messages.cursor = next
        return messages.lastPost
      }, context)
      working = result.catch(() => {})
      return result
    }
    try {
      // Atomic attach happens before recovery. Events arriving during recovery remain queued.
      await consume([], true)
      stream.start(async events => {
        if (stopped || !events.some(event => event.type === 'message_end' || event.type === 'snapshot')) return
        await consume(
          events.flatMap(event => (event.type === 'message_end' ? [event.entry] : [])),
          events.some(event => event.type === 'snapshot') ? true : undefined
        )
      })
    } catch (error) {
      await stream.stop()
      throw error
    }
    void stream.closed.then(end => {
      if (end.reason === 'listener_error') console.error('[clanker] Chat message consumer failed; durable cursor retained for reattachment', end.error)
      if (!stopped) consumers.delete(conversationId)
      stopped = true
    })
    return {
      async through(answer: EntryId, ctx: Context) {
        // Normally already consumed; only a genuine settlement/event gap needs a durable lookup.
        const post = await consume([], answer)
        if (post !== undefined && (await harness.waitForTask(post, ctx)).state.outcome.status !== 'completed') throw new Error('Chat delivery failed')
      },
      async close() {
        stopped = true
        await stream.stop()
        await working
      }
    }
  }

  return {
    attach(harness: Harness, conversationId: ConversationId, threadId: string) {
      active ??= harness
      if (active !== harness) throw new Error('Chat message consumer harness changed without restore')
      let consumer = consumers.get(conversationId)
      if (!consumer) {
        consumer = open(harness, conversationId, threadId)
        consumers.set(conversationId, consumer)
        void consumer.catch(error => {
          consumers.delete(conversationId)
          console.error('[clanker] Could not attach chat message consumer', error)
        })
      }
      return consumer
    },
    async restore(harness: Harness) {
      await this.close()
      active = harness
      for (const { id, threadId } of await listSources(harness, context)) await this.attach(harness, id, threadId).catch(() => {})
    },
    async close() {
      const current = [...consumers.values()]
      consumers.clear()
      await Promise.all(current.map(async consumer => (await consumer.catch(() => undefined))?.close()))
      active = undefined
    }
  }
}
