import { defineTask } from '@earendil-works/pi-durable'
import type { Chat } from 'chat'
import { platformFor } from 'extensions/chat/adapters'

export function createPost(chat: Chat) {
  return defineTask<{ threadId: string; text: string }, { phase: 'send'; text: string; attempt?: number; retryAt?: number }, null>({
    name: 'chat.post',
    version: 1,
    initial: input => ({ phase: 'send', text: input.text }),
    phases: {
      send: async (task, runtime, ctx) => {
        const { text, attempt = 0, retryAt } = task.state.checkpoint
        if (retryAt !== undefined) await runtime.sleep(retryAt, ctx)
        const thread = chat.thread(task.input.threadId)
        const chunk = platformFor(chat, thread.id).replyChunk?.(text) ?? text
        ctx.abortSignal?.throwIfAborted()
        // A platform accepting a post before this checkpoint remains the unavoidable duplicate-delivery window.
        try {
          await thread.post({ raw: chunk })
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
