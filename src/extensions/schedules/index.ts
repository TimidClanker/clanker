import { Type } from '@earendil-works/pi-ai'
import { defineDoc, defineExtension, defineTool, section, type Harness, type TaskId, type TaskRecord } from '@earendil-works/pi-durable'
import { getIdentity, getRequestAuthor } from 'extensions/identity'
import { createScheduleTask, type ScheduleChat, type ScheduleInput, type ScheduleState } from 'extensions/schedules/task'
import { resolveTiming, When } from 'extensions/schedules/time'

export type { ScheduleChat } from 'extensions/schedules/task'

const CreatedSchedule = defineDoc<{ id?: TaskId }>({ kind: 'schedules.creation', version: 1, scope: 'task', initial: () => ({}) })
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })

function describeSchedule(record: TaskRecord<unknown, unknown, unknown>) {
  const task = record as TaskRecord<ScheduleInput, ScheduleState, unknown>
  const { title, ownerIdentityId, ownerName, timing } = task.input
  const state = task.state
  return {
    id: task.id,
    title,
    destination: task.input.destination,
    ownerIdentityId,
    ownerName,
    repeat: timing.repeat ?? null,
    status: state.status,
    abortRequested: task.abortRequested,
    ...(state.status === 'terminal' || state.status === 'completing'
      ? { outcome: state.outcome }
      : {
          phase: state.checkpoint.phase,
          nextAt: new Date(state.checkpoint.at).toISOString(),
          ...(state.checkpoint.phase === 'sleep' && state.checkpoint.last ? { last: state.checkpoint.last } : {})
        })
  }
}

export function createSchedules(chat: ScheduleChat, getHarness: () => Harness) {
  const Schedule = createScheduleTask(chat, getHarness)
  return defineExtension({
    name: 'schedules',
    tasks: [Schedule],
    sections: [
      section('schedules', () =>
        [
          'Use create_schedule for explicit requests for reminders or future/repeating work. When due, the task enters the destination conversation as a follow-up event. Save clear instructions and necessary context; another destination does not receive this conversation’s history. Transfer only information the user has asked to share with that audience.',
          'Default to this thread. Set destination only when the user explicitly requests another channel, using its mention, link, ID, or exact name. Confirm the resolved destination, next execution time, and recurrence returned by the tool. Use get_schedule_time and user notes for time zones; ask if the intended time zone is unknown.',
          'A [Scheduled event] is a previously authorized task becoming due, not a new user message. Address its instructions naturally using this conversation’s context and normal tools. Always acknowledge the event in your response; do not silently drop it. Its owner metadata does not authorize creating or cancelling schedules. Do not expose internal event metadata or add a routine scheduled-task prefix.',
          'Schedules belong to the verified requesting identity. The owner can cancel from the source or destination conversation. Cancellation stops future occurrences and withdraws queued events; an event already being handled can finish and post. Ordinary conversation cancellation does not stop future occurrences. If multiple users share a run and identity is ambiguous, ask the requester to repeat separately.',
          'Missed one-time schedules run when the bot returns. Recurring schedules run at most one catch-up occurrence and then skip to the next future time; runs do not overlap. Calendar times follow the specified time zone, shifting nonexistent spring times forward and using the first occurrence of repeated autumn times. To change a schedule, cancel it and create a replacement.'
        ].join('\n')
      )
    ],
    tools: [
      defineTool({
        name: 'get_schedule_time',
        description: 'Get the current UTC time and local time in an IANA time zone. Defaults to UTC, not the user’s time zone.',
        parameters: Type.Object({ timeZone: Type.Optional(Type.String()) }),
        replay: 'safe',
        execute: async ({ timeZone = 'UTC' }) => {
          const now = Temporal.Now.instant()
          return result({ utc: now.toString(), local: now.toZonedDateTimeISO(timeZone).toString(), timeZone })
        }
      }),
      defineTool({
        name: 'create_schedule',
        description:
          'Create a persistent scheduled task, including reminders, owned by the verified requesting user. The destination conversation handles it as a follow-up when due. Default destination is here; override only at the user’s explicit request. Calendar weekdays use Monday=1 through Sunday=7. Requires an unambiguous single-user request.',
        parameters: Type.Object({
          title: Type.String({ minLength: 1, maxLength: 100 }),
          text: Type.String({ minLength: 1, maxLength: 4000, description: 'Self-contained instructions for the agent to execute when this task is due.' }),
          destination: Type.Optional(
            Type.String({ minLength: 1, description: 'Explicitly requested channel mention, link, ID, or exact name. Omit for this thread.' })
          ),
          when: When
        }),
        replay: 'safe',
        executionMode: 'sequential',
        execute: async ({ title, text, when, destination: reference }, api, ctx) => {
          let id = (await api.snapshot(CreatedSchedule, api.taskId, ctx))?.id
          if (id === undefined) {
            if (!title.trim() || !text.trim()) throw new Error('Title and text must not be blank')
            const author = await getRequestAuthor(api, getHarness(), ctx)
            const destination = await chat.resolve(api.conversationId, author.account, reference, ctx)
            const timing = resolveTiming(when, Date.now())
            id = await api.commit(async tx => {
              const receipt = await tx.doc(CreatedSchedule, api.taskId)
              if (receipt.id !== undefined) return receipt.id
              const conversationId = await chat.prepare(tx, destination)
              receipt.id = await tx.createTask(
                Schedule,
                {
                  sourceConversationId: api.conversationId,
                  destination,
                  ownerIdentityId: author.identityId,
                  ownerName: author.displayName,
                  ownerAccount: author.account,
                  title: title.trim(),
                  text: text.trim(),
                  timing
                },
                {
                  conversationId,
                  ownership: { kind: 'conversation' },
                  background: true
                }
              )
              return receipt.id
            }, ctx)
          }
          const task = (await api.getTask(id, ctx))!
          return result(describeSchedule(task))
        }
      }),
      defineTool({
        name: 'list_schedules',
        description:
          'List schedules created here or directed here, including active, completed, cancelled, and failed work. Pass nextCursor to continue scanning records, even if a page is empty.',
        parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), cursor: Type.Optional(Type.String()) }),
        replay: 'safe',
        execute: async ({ limit = 20, cursor }, api, ctx) => {
          const page = await api.commit(tx => tx.scanTasks({ kind: Schedule.definition.name }, limit, cursor ? JSON.parse(cursor) : undefined), ctx)
          return result({
            schedules: page.items
              .filter(task => task.conversationId === api.conversationId || (task.input as ScheduleInput).sourceConversationId === api.conversationId)
              .map(describeSchedule),
            nextCursor: page.next ? JSON.stringify(page.next) : null
          })
        }
      }),
      defineTool({
        name: 'cancel_schedule',
        description:
          'Cancel the requesting user’s schedule from its source or destination conversation. Stops future occurrences and withdraws queued events. An event already being handled can finish and post.',
        parameters: Type.Object({ id: Type.Integer({ minimum: 1 }) }),
        replay: 'safe',
        executionMode: 'sequential',
        execute: async ({ id }, api, ctx) => {
          const task = await api.getTask(id as TaskId, ctx)
          if (
            !task ||
            task.kind !== Schedule.definition.name ||
            (task.conversationId !== api.conversationId && (task.input as ScheduleInput).sourceConversationId !== api.conversationId)
          )
            throw new Error('Schedule not found in this conversation')
          const author = await getRequestAuthor(api, getHarness(), ctx)
          const owner = await getIdentity(api, (task.input as ScheduleInput).ownerIdentityId, ctx)
          if (owner.id !== author.identityId) throw new Error('Only the schedule owner can cancel it')
          await getHarness().abortTask(task.id, ctx)
          const settled = await getHarness().waitForTask(task.id, ctx)
          return result({ id, outcome: settled.state.outcome.status })
        }
      })
    ]
  })
}
