import type { Context } from '@earendil-works/chord'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { AssistantEntry, defineTask, type EntryId, type Harness, type TaskId, type Tx } from '@earendil-works/pi-durable'
import { findIdentity, recordAutomatedInput, resolveIdentity } from 'extensions/identity'
import type { ScheduleChat } from 'extensions/schedules'
import { JobInputs, Jobs, type Job } from 'extensions/jobs/state'

export type JobChat = Pick<ScheduleChat, 'privateIdentity' | 'check' | 'enqueue'> & { checkScope?(job: Job, ctx: Context, tx?: Tx): Promise<void> }

export async function checkJob(job: Job, harness: Harness, chat: Pick<JobChat, 'check' | 'checkScope'>, ctx: Context) {
  if ((await findIdentity(harness, job.owner.account, ctx)) !== (await resolveIdentity(harness, job.owner.identityId, ctx))) {
    throw new Error('The account that delegated this task no longer belongs to its owner')
  }
  await chat.check({ threadId: job.threadId, title: job.title }, job.owner.account, ctx)
  if (job.projectScope?.length && !chat.checkScope) throw new Error('Project access verification is unavailable')
  await chat.checkScope?.(job, ctx)
}

export async function notifyJob(tx: Tx, chat: JobChat, job: Job, requestId: string, kind: string, text: string) {
  await chat.enqueue(tx, job.sourceConversationId, {
    requestId,
    threadId: job.threadId,
    owner: job.owner,
    internal: true,
    job: job.id,
    text: `[Background task update]\n${JSON.stringify({ id: job.id, title: job.title, revision: job.revision, kind, text })}`
  })
}

export function createJobTasks(chat: JobChat, getHarness: () => Harness) {
  // A permanent background ownership boundary, independent of the spawning tool's lifetime.
  const Anchor = defineTask<null, { phase: 'done' }, null>({
    name: 'jobs.anchor',
    version: 1,
    initial: () => ({ phase: 'done' }),
    phases: { done: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx) },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  })

  const Message = defineTask<{ id: TaskId; revision: number; text: string }, { phase: 'deliver' }, null>({
    name: 'jobs.message',
    version: 1,
    initial: () => ({ phase: 'deliver' }),
    phases: {
      deliver: async (task, runtime, ctx) => {
        const job = (await runtime.snapshot(Jobs, ctx))!.jobs[task.input.id]!
        let answer: AssistantMessage | undefined, answerId: EntryId | undefined, error: string | undefined
        let permitted = false
        try {
          await checkJob(job, getHarness(), chat, ctx)
          permitted = true
          if (job.revision !== task.input.revision || ['cancelling', 'cancelled'].includes(job.status)) {
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
            return
          }
          const child = (await runtime.conversation(job.conversationId, ctx))!
          const requestId = `job-input:${task.id}`
          await runtime.commit(async tx => {
            await recordAutomatedInput(tx, job.conversationId, requestId, job.owner, 'background')
            ;(await tx.doc(JobInputs, job.conversationId))[requestId] = task.input.revision
          }, ctx)
          const submitted = await child.submit(
            {
              type: 'input',
              content: `Task revision ${task.input.revision} (higher revisions supersede earlier directions):\n${task.input.text}`,
              requestId,
              whenBusy: 'steer'
            },
            ctx
          )
          const latest = (await runtime.snapshot(Jobs, ctx))!.jobs[job.id]!
          if (['cancelling', 'cancelled'].includes(latest.status)) await child.abort(ctx, { background: true })
          const settled = await submitted.wait(ctx)
          if (settled.status === 'done' && settled.type === 'input') {
            answerId = settled.answer
            await runtime.commit(async tx => {
              answer = (await tx.entry(AssistantEntry, settled.answer))!.model![0] as AssistantMessage
            }, ctx)
          } else if (settled.status === 'unanswered') error = settled.reason
          await checkJob(job, getHarness(), chat, ctx)
        } catch (cause) {
          ctx.abortSignal?.throwIfAborted()
          error = cause instanceof Error ? cause.message : String(cause)
          // Don't publish after the source's access was revoked.
          permitted = await checkJob(job, getHarness(), chat, ctx).then(
            () => true,
            () => false
          )
        }
        await runtime.commit(async tx => {
          const current = (await tx.doc(Jobs)).jobs[task.input.id]!
          if (current.revision === task.input.revision && current.status === 'running' && (answerId === undefined || current.reported !== answerId)) {
            const text = answer?.content
              .flatMap(part => (part.type === 'text' ? [part.text] : []))
              .join('\n')
              .trim()
            current.status = error ? 'failed' : 'completed'
            current.result = text || error || 'Finished without a text result.'
            if (answerId !== undefined) current.reported = answerId
            current.updatedAt = new Date(runtime.now()).toISOString()
            if (
              permitted &&
              (await (chat.checkScope?.(current, ctx, tx).then(
                () => true,
                () => false
              ) ?? true))
            )
              await notifyJob(tx, chat, current, `job-result:${task.id}`, current.status, current.result)
          }
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      }
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  })

  const Cancel = defineTask<{ id: TaskId }, { phase: 'cancel' }, null>({
    name: 'jobs.cancel',
    version: 1,
    initial: () => ({ phase: 'cancel' }),
    phases: {
      cancel: async (task, runtime, ctx) => {
        const job = (await runtime.snapshot(Jobs, ctx))!.jobs[task.input.id]!
        await (await runtime.conversation(job.conversationId, ctx))!.abort(ctx, { background: true })
        const permitted = await checkJob(job, getHarness(), chat, ctx).then(
          () => true,
          () => false
        )
        await runtime.commit(async tx => {
          const current = (await tx.doc(Jobs)).jobs[task.input.id]!
          current.status = 'cancelled'
          current.updatedAt = new Date(runtime.now()).toISOString()
          if (
            permitted &&
            (await (chat.checkScope?.(current, ctx, tx).then(
              () => true,
              () => false
            ) ?? true))
          )
            await notifyJob(tx, chat, current, `job-cancelled:${task.id}`, 'cancelled', 'Execution stopped. Completed external actions are not rolled back.')
          return { status: 'terminal', outcome: { status: 'completed', result: null } }
        }, ctx)
      }
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  })
  return { Anchor, Message, Cancel }
}
