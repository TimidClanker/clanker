import type { Context } from '@earendil-works/chord'
import { defineTask, type TaskId } from '@earendil-works/pi-durable'
import type { Chat } from 'chat'
import type { SourceEvidence } from 'extensions/sources/state'
import type { SourceNotice } from 'extensions/sources'
import type { ProjectDisclosure } from 'extensions/projects/state'
import { platformFor } from 'extensions/chat/adapters'

export function createPost(
  chat: Chat,
  authorize?: (job: TaskId, threadId: string, ctx: Context) => Promise<void>,
  authorizeProject?: (value: ProjectDisclosure, threadId: string, ctx: Context) => Promise<void>,
  authorizeSource?: (value: SourceEvidence, threadId: string, ctx: Context) => Promise<void>,
  sourceNotice?: (notice: SourceNotice, threadId: string, ctx: Context) => Promise<string>,
  recordNotice?: (
    tx: import('@earendil-works/pi-durable').Tx,
    notice: SourceNotice,
    conversationId: import('@earendil-works/pi-durable').ConversationId,
    text: string,
    ctx: Context
  ) => Promise<void>
) {
  return defineTask<
    {
      threadId: string
      text: string
      files?: { data: string; filename: string; mimeType: string }[]
      job?: TaskId
      jobs?: TaskId[]
      projects?: ProjectDisclosure[]
      sources?: SourceEvidence[]
      sourceNotice?: SourceNotice
      previous?: TaskId<null>
    },
    { phase: 'queue' } | { phase: 'send'; text: string; attempt?: number; retryAt?: number; offset?: number },
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
        const { attempt = 0, retryAt, offset = 0 } = task.state.checkpoint
        let text = task.state.checkpoint.text,
          fullNotice: string | undefined
        if (retryAt !== undefined) await runtime.sleep(retryAt, ctx)
        for (const job of new Set([...(task.input.jobs ?? []), ...(task.input.job === undefined ? [] : [task.input.job])])) {
          if (!authorize) throw new Error('Background post authorization unavailable')
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
          if (!authorizeProject) throw new Error('Project post authorization unavailable')
          try {
            await authorizeProject(value, task.input.threadId, ctx)
          } catch (error) {
            ctx.abortSignal?.throwIfAborted()
            const message = error instanceof Error ? error.message : String(error)
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message } } }), ctx)
            return
          }
        }
        try {
          for (const value of task.input.sources ?? []) {
            if (!authorizeSource) throw new Error('Source delivery authorization unavailable')
            await authorizeSource(value, task.input.threadId, ctx)
          }
          if (task.input.sourceNotice) {
            if (!sourceNotice) throw new Error('Source notification unavailable')
            fullNotice = await sourceNotice(task.input.sourceNotice, task.input.threadId, ctx)
            text = fullNotice.slice(offset)
          }
        } catch {
          ctx.abortSignal?.throwIfAborted()
          await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'failed', error: { message: 'Source delivery withdrawn' } } }), ctx)
          return
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
          const message = task.input.sourceNotice ? 'Source notification delivery failed' : error instanceof Error ? error.message : String(error)
          console.error('[clanker] Chat delivery failed', { threadId: task.input.threadId, taskId: runtime.taskId, attempt: attempt + 1, message })
          await runtime.commit(
            () =>
              attempt >= 4
                ? { status: 'terminal', outcome: { status: 'failed', error: { message, detail: task.input.sourceNotice ? null : { remainingText: text } } } }
                : {
                    status: 'running',
                    checkpoint: {
                      phase: 'send',
                      text: task.input.sourceNotice ? '' : text,
                      offset,
                      attempt: attempt + 1,
                      retryAt: runtime.now() + 1000 * 2 ** attempt
                    }
                  },
            ctx
          )
          return
        }
        await runtime.commit(async tx => {
          if (text.length <= chunk.length && task.input.sourceNotice && fullNotice !== undefined) {
            if (!recordNotice) throw new Error('Source notification receipt unavailable')
            await recordNotice(tx, task.input.sourceNotice, runtime.conversationId, fullNotice, ctx)
          }
          return text.length > chunk.length
            ? { status: 'running', checkpoint: { phase: 'send', text: task.input.sourceNotice ? '' : text.slice(chunk.length), offset: offset + chunk.length } }
            : { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      }
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  })
}
