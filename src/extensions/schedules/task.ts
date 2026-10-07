import type { Context } from '@earendil-works/chord'
import { defineTask, type DocumentReader, type ConversationId, type Harness, type TaskId, type Tx } from '@earendil-works/pi-durable'
import type { Author, PlatformAccount } from 'extensions/identity'
import { nextOccurrence, type Timing } from 'extensions/schedules/time'

export type Destination = { threadId: string; title: string }
export type ScheduleChat = {
  privateIdentity(read: DocumentReader, conversationId: ConversationId, ctx: Context): Promise<string | undefined>
  resolve(source: ConversationId, account: PlatformAccount, reference: string | undefined, ctx: Context): Promise<Destination>
  check(destination: Destination, account: PlatformAccount, ctx: Context): Promise<void>
  prepare(tx: Tx, destination: Destination): Promise<ConversationId>
  enqueue(
    tx: Tx,
    conversationId: ConversationId,
    event: { schedule?: TaskId; requestId: string; text: string; owner: Author; threadId: string; internal?: boolean }
  ): Promise<TaskId<null>>
}
export type ScheduleInput = {
  sourceConversationId: ConversationId
  destination: Destination
  ownerIdentityId: string
  ownerName: string
  ownerAccount: PlatformAccount
  title: string
  text: string
  timing: Timing
}
type Occurrence = { at: number; finishedAt: number; status: 'completed' | 'failed'; error?: string }
export type ScheduleState = { phase: 'sleep'; at: number; last?: Occurrence } | { phase: 'settle'; at: number; delivery: TaskId<null> }

export function createScheduleTask(chat: ScheduleChat, getHarness: () => Harness) {
  return defineTask<ScheduleInput, ScheduleState, Occurrence>({
    name: 'schedules.run',
    version: 1,
    initial: input => ({ phase: 'sleep', at: input.timing.firstAt }),
    phases: {
      sleep: async (task, runtime, ctx) => {
        const { at } = task.state.checkpoint
        await runtime.sleep(at, ctx)
        await chat.check(task.input.destination, task.input.ownerAccount, ctx)
        const text = `[Scheduled event]\n${JSON.stringify({
          scheduleId: task.id,
          ownerIdentityId: task.input.ownerIdentityId,
          ownerName: task.input.ownerName,
          scheduledAt: new Date(at).toISOString(),
          raisedAt: new Date(runtime.now()).toISOString(),
          title: task.input.title,
          instructions: task.input.text
        })}`
        await runtime.commit(async tx => {
          const delivery = await chat.enqueue(tx, runtime.conversationId, {
            schedule: task.id,
            requestId: `schedule:${task.id}:${at}`,
            text,
            owner: {
              identityId: task.input.ownerIdentityId,
              account: task.input.ownerAccount,
              displayName: task.input.ownerName
            },
            threadId: task.input.destination.threadId
          })
          return { status: 'waiting', checkpoint: { phase: 'settle', at, delivery }, on: [delivery], policy: 'allSettled' }
        }, ctx)
      },
      settle: async (task, runtime, ctx) => {
        const { at, delivery } = task.state.checkpoint
        const [outcome] = await runtime.outcomes([delivery], ctx)
        const error = outcome!.status === 'completed' ? undefined : `Scheduled event ${outcome!.status}`
        const last: Occurrence = { at, finishedAt: runtime.now(), status: error ? 'failed' : 'completed', ...(error ? { error } : {}) }
        const next = nextOccurrence(task.input.timing, Math.max(at, runtime.now()))
        await runtime.commit(
          () =>
            next === undefined
              ? { status: 'terminal', outcome: error ? { status: 'failed', error: { message: error, detail: last } } : { status: 'completed', result: last } }
              : { status: 'running', checkpoint: { phase: 'sleep', at: next, last } },
          ctx
        )
      }
    },
    abort: async (task, runtime, ctx) => {
      // Once placed, an event belongs to the conversation. Let its response finish rather than suppressing it.
      let submissionId
      await runtime.commit(async tx => {
        submissionId = (await tx.submissionByRequest(runtime.conversationId, `schedule:${task.id}:${task.state.checkpoint.at}`))?.id
      }, ctx)
      if (submissionId !== undefined) await getHarness().abortSubmission(submissionId, ctx, runtime.conversationId)
      await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
    }
  })
}
