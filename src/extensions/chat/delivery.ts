import type { ImageContent } from '@earendil-works/pi-ai'
import { defineTask, InboxDoc, LiveDoc, type Harness, type EntryId, type SubmissionId, type TaskId } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import type { Chat } from 'chat'
import type { ProjectDisclosure } from 'extensions/projects'
import { Messages } from 'extensions/chat/state'
import { showTyping } from 'extensions/chat/typing'
import { createPostQueue, type createPost } from 'extensions/chat/post'
import type { createMessageConsumer } from 'extensions/chat/consumer'

export function createDelivery(
  chat: Chat,
  getHarness: () => Harness,
  Post: ReturnType<typeof createPost>,
  consumer: ReturnType<typeof createMessageConsumer>,
  authorize: (job: TaskId, threadId: string, ctx: Context) => Promise<void>
) {
  const enqueuePost = createPostQueue(Post)
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
        if (task.input.job !== undefined) {
          try {
            await authorize(task.input.job, task.input.threadId, ctx)
          } catch (error) {
            ctx.abortSignal?.throwIfAborted()
            console.error('[jobs] Background update access revoked', error)
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
            return
          }
        }
        await consumer.attach(getHarness(), runtime.conversationId, task.input.threadId)
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
        // Settlement/error handling is serialized, not admission or completed-message delivery.
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
        const harness = getHarness()
        const settled = await (await harness.submission(task.state.checkpoint.submission, ctx))!.wait(ctx)
        if (settled.status === 'done') {
          if (settled.type !== 'input') throw new Error('Reply submission is not an input')
          await (await consumer.attach(harness, runtime.conversationId, task.input.threadId)).through(settled.answer, ctx)
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
          return
        }
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
      // New sends are error fallbacks; retain answer/envelope fields for stored version-1 checkpoints.
      send: async (task, runtime, ctx) => {
        const { text, answer, error, jobs, projects } = task.state.checkpoint
        await runtime.commit(async tx => {
          const messages = await tx.doc(Messages, runtime.conversationId)
          const existing = answer === undefined ? undefined : messages.replies?.[answer]
          const post =
            existing ??
            (await enqueuePost(
              tx,
              runtime.conversationId,
              { threadId: task.input.threadId, text, job: task.input.job, jobs, projects },
              { ownership: { kind: 'task', taskId: task.id } }
            ))
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
