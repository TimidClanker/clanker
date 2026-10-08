import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai'
import {
  AssistantEntry,
  defineTask,
  GenerationTask,
  hook,
  InboxDoc,
  LiveDoc,
  type Harness,
  type EntryId,
  type SubmissionId,
  type TaskId,
  type ConversationId,
  type Cursor
} from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import type { Chat } from 'chat'
import { ProjectDisclosures, type ProjectDisclosure } from 'extensions/projects/state'
import { JobAnswerScopes } from 'extensions/jobs/state'
import { Messages, Threads } from 'extensions/chat/state'
import { Delegation } from 'extensions/identity'
import { showTyping } from 'extensions/chat/typing'
import type { createPost } from 'extensions/chat/post'

export function deliveryHooks(getHarness: () => Harness) {
  return [
    hook(GenerationTask, {
      beforeRequest: async (_request, api, ctx) => {
        await getHarness().commit(async tx => {
          const run = (await tx.doc(LiveDoc, api.conversationId)).run
          if (!run || run.taskId !== api.taskId) throw new Error('Assistant request origin unavailable')
          const messages = await tx.doc(Messages, api.conversationId)
          messages.generations ??= {}
          messages.generations[api.taskId] = [...run.inputs]
        }, ctx)
      }
    })
  ]
}

export function createDelivery(
  chat: Chat,
  getHarness: () => Harness,
  Post: ReturnType<typeof createPost>,
  authorize?: (job: TaskId, threadId: string, ctx: Context) => Promise<void>,
  authorizeProject?: (value: ProjectDisclosure, threadId: string, ctx: Context) => Promise<void>
) {
  async function ready(harness: Harness, conversationId: ConversationId, input: { messageId: string; threadId: string }, ctx: Context) {
    let wake = Promise.withResolvers<void>()
    // Notifications only wake the scanner: do not call Session APIs from a commit listener.
    const unsubscribe = harness.subscribeCommits(publication => {
      if (publication.changes.some(change => (change.type === 'entry' || change.type === 'submission') && change.value.conversationId === conversationId))
        wake.resolve()
    })
    const cancelled = () => wake.resolve()
    ctx.abortSignal?.addEventListener('abort', cancelled)
    try {
      for (;;) {
        wake = Promise.withResolvers<void>()
        ctx.abortSignal?.throwIfAborted()
        const { submission, posts } = await harness.commit(async tx => {
          if ((await tx.doc(Threads)).threads[input.threadId] !== conversationId || (await tx.doc(Delegation, conversationId)).jobId !== undefined)
            throw new Error('Only the originating chat coordinator can deliver assistant messages')
          const submission = (await tx.submissionByRequest(conversationId, input.messageId))!
          const messages = await tx.doc(Messages, conversationId)
          const entries = []
          if (submission.type === 'input' && submission.entry !== undefined) {
            let cursor: Cursor | undefined
            do {
              const page = await tx.scanEntries(
                { conversationId, minEntryId: submission.entry, ...(submission.status === 'done' ? { maxEntryId: submission.answer } : {}) },
                256,
                cursor
              )
              entries.push(...page.items)
              cursor = page.next
            } while (cursor !== undefined)
          }
          const scopes = await tx.doc(JobAnswerScopes, conversationId)
          const disclosures = await tx.doc(ProjectDisclosures, conversationId)
          // Finish table reads before creating any tasks (Tx disallows reads after writes).
          const pending = []
          const posts: TaskId<null>[] = []
          for (const entry of entries.reverse()) {
            if (entry.conversationId !== conversationId || !AssistantEntry.is(entry)) continue
            const answer = entry.model?.[0] as AssistantMessage | undefined
            if (!answer || !['stop', 'length', 'toolUse'].includes(answer.stopReason)) continue
            const text = answer.content
              .flatMap(part => (part.type === 'text' ? [part.text] : []))
              .join('\n')
              .trim()
            if (!text || messages.lastAnswer === entry.id) continue
            if (entry.byTaskId === undefined || (await tx.task(entry.byTaskId))?.kind !== 'pi.generation')
              throw new Error('Assistant delivery origin unavailable')
            const inputs = messages.generations?.[entry.byTaskId]
            if (inputs === undefined) throw new Error('Assistant delivery input provenance unavailable')
            // In particular, an unanswered old input must not claim a newer independent run.
            if (!inputs.includes(submission.id)) continue
            const receipt = messages.replies?.[entry.id]
            if (receipt !== undefined) {
              posts.push(receipt)
              continue
            }
            const jobs = scopes.generations[entry.byTaskId]
            const projects = disclosures.generations[entry.byTaskId]
            if (jobs === undefined || projects === undefined) throw new Error('Assistant delivery authorization evidence unavailable')
            pending.push({ entry: entry.id, text, jobs, projects })
          }
          for (const { entry, text, jobs, projects } of pending) {
            const post = await tx.createTask(
              Post,
              { threadId: input.threadId, text, jobs, projects, previous: messages.lastPost },
              // A shared answer belongs to the chat, not whichever coalesced Reply scanned it first.
              { conversationId, ownership: { kind: 'conversation' } }
            )
            messages.replies ??= {}
            messages.replies[entry] = post
            messages.lastPost = post
            posts.push(post)
          }
          return { submission, posts }
        }, ctx)
        if (submission.status === 'done' || submission.status === 'unanswered') {
          // The settlement and final entry were scanned in one transaction, including after reopen.
          const outcomes = await Promise.all(posts.map(post => harness.waitForTask(post, ctx)))
          if (outcomes.some(post => post.state.outcome.status !== 'completed')) throw new Error('Chat delivery failed')
          return submission
        }
        await wake.promise
      }
    } finally {
      unsubscribe()
      ctx.abortSignal?.removeEventListener('abort', cancelled)
    }
  }

  return defineTask<
    {
      threadId: string
      messageId: string
      text: string
      images?: ImageContent[]
      previous: TaskId | null
      schedule?: TaskId
      internal?: boolean
      job?: TaskId
    },
    | { phase: 'queue' }
    | { phase: 'answer'; submission: SubmissionId }
    | { phase: 'withdraw'; submissions: SubmissionId[] }
    | { phase: 'send'; text: string; answer?: EntryId; error?: string; jobs?: TaskId[]; projects?: ProjectDisclosure[] }
    | { phase: 'delivered'; post: TaskId<null>; answer?: EntryId; error?: string },
    null
  >({
    name: 'clanker.reply',
    version: 1,
    initial: () => ({ phase: 'queue' }),
    phases: {
      queue: async (task, runtime, ctx) => {
        const schedule = task.input.schedule
        if (schedule !== undefined) {
          let cancelled = false
          await runtime.commit(async tx => {
            const owner = (await tx.task(schedule))!
            const existing = await tx.submissionByRequest(runtime.conversationId, task.input.messageId)
            cancelled = owner.abortRequested && !existing
          }, ctx)
          if (cancelled) {
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
            return
          }
        }
        if (task.input.job !== undefined && authorize) {
          try {
            await authorize(task.input.job, task.input.threadId, ctx)
          } catch (error) {
            ctx.abortSignal?.throwIfAborted()
            console.error('[jobs] Background update access revoked', error)
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
            return
          }
        }
        // Admit input before waiting for earlier replies, so it can steer an active run.
        const conversation = (await runtime.conversation(runtime.conversationId, ctx))!
        const submission = await conversation.submit(
          {
            type: 'input',
            content: task.input.images?.length ? [{ type: 'text', text: task.input.text }, ...task.input.images] : task.input.text,
            requestId: task.input.messageId,
            whenBusy: schedule === undefined && !task.input.internal ? 'steer' : 'followUp'
          },
          ctx
        )
        // Close the race with cancellation during admission. Already-placed input must still get its response.
        if (schedule !== undefined && (await getHarness().getTask(schedule, ctx))!.abortRequested) await submission.abort(ctx)
        // Only delivery is serialized. requestId makes admission safe to repeat after a restart.
        await runtime.commit(
          () => ({
            status: 'waiting',
            checkpoint: { phase: 'answer', submission: submission.id },
            on: task.input.previous ? [task.input.previous] : [],
            policy: 'allSettled'
          }),
          ctx
        )
      },
      answer: async (task, runtime, ctx) => {
        using typing = task.input.internal ? undefined : showTyping(chat.thread(task.input.threadId))
        const settled = await ready(getHarness(), runtime.conversationId, task.input, ctx)
        if (settled.status === 'unanswered') {
          if (task.input.internal) {
            if (settled.reason !== 'aborted') console.error('[jobs] Internal update unanswered', settled)
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
            return
          }
          if (settled.reason !== 'aborted') console.error('[clanker] Unanswered message', settled)
          if (task.input.schedule !== undefined) {
            if (settled.reason !== 'aborted') {
              const conversation = (await getHarness().conversation(runtime.conversationId, ctx))!
              await conversation.submit({ type: 'write', requestId: `reply-wake:${task.id}`, entry: { kind: 'chat.inbox-wake' } }, ctx)
            }
            await runtime.commit(
              () =>
                settled.reason === 'aborted'
                  ? { status: 'terminal', outcome: { status: 'aborted' } }
                  : { status: 'running', checkpoint: { phase: 'send', text: "Sorry, I couldn't complete this scheduled task.", error: settled.reason } },
              ctx
            )
            return
          }
          await runtime.commit(async tx => {
            if (settled.reason === 'aborted') return { status: 'terminal', outcome: { status: 'completed', result: null } }
            // A newer submission may already have resumed the inbox. Leave that run alone.
            const busy = (await tx.doc(LiveDoc, runtime.conversationId)).run !== undefined
            const inbox = await tx.doc(InboxDoc, runtime.conversationId)
            const submissions = busy ? [] : inbox.items.filter(item => item.mode === 'steer').map(item => item.id)
            // Persist the exact set before withdrawing anything, so recovery cannot cancel newer inputs.
            return { status: 'running', checkpoint: { phase: 'withdraw', submissions } }
          }, ctx)
          return
        }
        await runtime.commit(async tx => {
          let text = 'Sorry, I could not generate a response. Please try again.'
          let jobs: TaskId[] | undefined
          let projects: ProjectDisclosure[] | undefined
          if (settled.status === 'done' && settled.type === 'input') {
            const messages = await tx.doc(Messages, runtime.conversationId)
            // Several steers can share an answer. Deliver each distinct answer once, in order.
            if (messages.lastAnswer === settled.answer || messages.replies?.[settled.answer] !== undefined) {
              messages.lastAnswer = settled.answer
              return { status: 'terminal', outcome: { status: 'completed', result: null } }
            }
            const entry = await tx.entry(AssistantEntry, settled.answer)
            if (entry?.byTaskId !== undefined) {
              jobs = (await tx.doc(JobAnswerScopes, runtime.conversationId)).generations[entry.byTaskId]
              projects = (await tx.doc(ProjectDisclosures, runtime.conversationId)).generations[entry.byTaskId]
            }
            const answer = entry!.model![0] as AssistantMessage
            text = answer.content
              .flatMap(part => (part.type === 'text' ? [part.text] : []))
              .join('\n')
              .trim()
            // A successful turn may have delivered its response through a tool, such as an image upload.
            if (!text) {
              messages.lastAnswer = settled.answer
              return { status: 'terminal', outcome: { status: 'completed', result: null } }
            }
          }
          return {
            status: 'running',
            checkpoint: {
              phase: 'send',
              text,
              ...(jobs?.length ? { jobs } : {}),
              ...(projects?.length ? { projects } : {}),
              ...(settled.status === 'done' && settled.type === 'input' ? { answer: settled.answer } : {})
            }
          }
        }, ctx)
      },
      withdraw: async (task, runtime, ctx) => {
        for (const id of task.state.checkpoint.submissions) {
          // This only withdraws queued inputs; already-placed work is unaffected.
          await getHarness().abortSubmission(id, ctx, runtime.conversationId)
        }
        // A failed run leaves follow-ups queued. A passive write resumes them without inventing another user input.
        const conversation = (await getHarness().conversation(runtime.conversationId, ctx))!
        await conversation.submit({ type: 'write', requestId: `reply-wake:${task.id}`, entry: { kind: 'chat.inbox-wake' } }, ctx)
        await runtime.commit(
          () => ({
            status: 'running',
            checkpoint: { phase: 'send', text: "Sorry, I couldn't complete this request. Please resend any messages that haven't received a reply." }
          }),
          ctx
        )
      },
      send: async (task, runtime, ctx) => {
        const { text, answer, error, jobs, projects } = task.state.checkpoint
        try {
          for (const value of projects ?? []) {
            if (!authorizeProject) throw new Error('Project delivery authorization unavailable')
            await authorizeProject(value, task.input.threadId, ctx)
          }
        } catch (cause) {
          ctx.abortSignal?.throwIfAborted()
          const message = cause instanceof Error ? cause.message : String(cause)
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message } } }), ctx)
          return
        }
        await runtime.commit(async tx => {
          const messages = await tx.doc(Messages, runtime.conversationId)
          const post = await tx.createTask(
            Post,
            { threadId: task.input.threadId, text, job: task.input.job, jobs, projects, previous: messages.lastPost },
            { ownership: { kind: 'task', taskId: task.id } }
          )
          messages.lastPost = post
          if (answer !== undefined) {
            messages.replies ??= {}
            messages.replies[answer] = post
          }
          return {
            status: 'waiting',
            checkpoint: { phase: 'delivered', post, ...(answer === undefined ? {} : { answer }), ...(error ? { error } : {}) },
            on: [post],
            policy: 'allSettled'
          }
        }, ctx)
      },
      delivered: async (task, runtime, ctx) => {
        const [outcome] = await runtime.outcomes([task.state.checkpoint.post], ctx)
        await runtime.commit(async tx => {
          if (outcome!.status !== 'completed') return { status: 'terminal', outcome: { status: 'failed', error: { message: 'Chat delivery failed' } } }
          if (task.state.checkpoint.answer !== undefined) {
            const messages = await tx.doc(Messages, runtime.conversationId)
            messages.lastAnswer = task.state.checkpoint.answer
          }
          if (task.state.checkpoint.error) return { status: 'terminal', outcome: { status: 'failed', error: { message: task.state.checkpoint.error } } }
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      }
    },
    abort: async (_task, runtime, ctx) => {
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
    }
  })
}
