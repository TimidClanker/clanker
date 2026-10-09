import type { Context } from '@earendil-works/chord'
import { defineTask, type ConversationId, type TaskId, type TaskOptions, type Tx } from '@earendil-works/pi-durable'
import type { Chat } from 'chat'
import type { ProjectDisclosure } from 'extensions/projects'
import { platformFor } from 'extensions/chat/adapters'
import { Messages } from 'extensions/chat/state'

export const createPostQueue =
  (Post: ReturnType<typeof createPost>) =>
  async (tx: Tx, conversationId: ConversationId, input: Omit<Parameters<typeof Post.definition.initial>[0], 'previous'>, options: TaskOptions) => {
    const messages = await tx.doc(Messages, conversationId)
    const post = await tx.createTask(Post, { ...input, previous: messages.lastPost }, options)
    messages.lastPost = post
    return post
  }

export function createPost(
  chat: Chat,
  authorize: (job: TaskId, threadId: string, ctx: Context) => Promise<void>,
  authorizeProject: (value: ProjectDisclosure, threadId: string, ctx: Context) => Promise<void>
) {
  return defineTask<
    {
      threadId: string
      text: string
      files?: { data: string; filename: string; mimeType: string }[]
      job?: TaskId
      jobs?: TaskId[]
      projects?: ProjectDisclosure[]
      previous?: TaskId<null>
    },
    { phase: 'queue' } | { phase: 'send'; text: string; attempt?: number; retryAt?: number },
    null
  >({
    name: 'chat.post',
    version: 1,
    initial: () => ({ phase: 'queue' }),
    phases: {
      queue: (task, runtime, ctx) =>
        runtime.commit(
          () => ({
            status: 'waiting',
            checkpoint: { phase: 'send', text: task.input.text },
            on: task.input.previous === undefined ? [] : [task.input.previous],
            policy: 'allSettled'
          }),
          ctx
        ),
      send: async (task, runtime, ctx) => {
        const { text, attempt = 0, retryAt } = task.state.checkpoint
        if (retryAt !== undefined) await runtime.sleep(retryAt, ctx)
        for (const job of new Set([...(task.input.jobs ?? []), ...(task.input.job === undefined ? [] : [task.input.job])])) {
          try {
            await authorize(job, task.input.threadId, ctx)
          } catch (error) {
            ctx.abortSignal?.throwIfAborted()
            const message = error instanceof Error ? error.message : String(error)
            console.error('[jobs] Background post access revoked', message)
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message } } }), ctx)
            return
          }
        }
        for (const value of task.input.projects ?? []) {
          try {
            await authorizeProject(value, task.input.threadId, ctx)
          } catch (error) {
            ctx.abortSignal?.throwIfAborted()
            const message = error instanceof Error ? error.message : String(error)
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message } } }), ctx)
            return
          }
        }
        const thread = chat.thread(task.input.threadId)
        const chunk = platformFor(chat, thread.id).replyChunk?.(text) ?? text
        ctx.abortSignal?.throwIfAborted()
        // A platform accepting a post before this checkpoint remains the unavoidable duplicate-delivery window.
        try {
          await thread.post({
            raw: chunk,
            // Attach files to the first chunk only. Retries reuse the persisted bytes.
            files: text === task.input.text ? task.input.files?.map(file => ({ ...file, data: Buffer.from(file.data, 'base64') })) : undefined
          })
        } catch (error) {
          ctx.abortSignal?.throwIfAborted()
          const message = error instanceof Error ? error.message : String(error)
          console.error('[clanker] Chat delivery failed', { threadId: task.input.threadId, taskId: runtime.taskId, attempt: attempt + 1, message })
          await runtime.commit(
            () =>
              attempt >= 4
                ? { status: 'terminal', outcome: { status: 'failed', error: { message, detail: { remainingText: text } } } }
                : { status: 'running', checkpoint: { phase: 'send', text, attempt: attempt + 1, retryAt: runtime.now() + 1000 * 2 ** attempt } },
            ctx
          )
          return
        }
        await runtime.commit(() => {
          return text.length > chunk.length
            ? { status: 'running', checkpoint: { phase: 'send', text: text.slice(chunk.length) } }
            : { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      }
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  })
}
