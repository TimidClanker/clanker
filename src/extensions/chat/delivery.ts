import type { AssistantMessage, ImageContent } from '@earendil-works/pi-ai'
import { AssistantEntry, defineTask, InboxDoc, LiveDoc, type Harness, type EntryId, type SubmissionId, type TaskId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import type { Chat } from 'chat'
import { JobAnswerScopes } from 'extensions/jobs/state'
import { Messages } from 'extensions/chat/state'
import { showTyping } from 'extensions/chat/typing'
import type { createPost } from 'extensions/chat/post'

export function createDelivery(
  chat: Chat,
  getHarness: () => Harness,
  Post: ReturnType<typeof createPost>,
  authorize?: (job: TaskId, threadId: string, ctx: Context) => Promise<void>
) {
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
    | { phase: 'send'; text: string; answer?: EntryId; error?: string; jobs?: TaskId[] }
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
        const submission = (await getHarness().submission(task.state.checkpoint.submission, ctx))!
        const settled = await submission.wait(ctx)
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
          if (settled.status === 'done' && settled.type === 'input') {
            const messages = await tx.doc(Messages, runtime.conversationId)
            // Several steers can share an answer. Deliver each distinct answer once, in order.
            if (messages.lastAnswer === settled.answer) {
              return { status: 'terminal', outcome: { status: 'completed', result: null } }
            }
            const entry = await tx.entry(AssistantEntry, settled.answer)
            if (entry?.byTaskId !== undefined) jobs = (await tx.doc(JobAnswerScopes, runtime.conversationId)).generations[entry.byTaskId]
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
        const { text, answer, error, jobs } = task.state.checkpoint
        await runtime.commit(async tx => {
          const post = await tx.createTask(
            Post,
            { threadId: task.input.threadId, text, job: task.input.job, jobs },
            { ownership: { kind: 'task', taskId: task.id } }
          )
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
