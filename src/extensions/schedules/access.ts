import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, TaskRecord } from '@earendil-works/pi-durable'
import type { ChatAccess } from 'extensions/chat/contracts'
import { resolveIdentity } from 'extensions/identity'
import type { ScheduleInput } from 'extensions/schedules/task'

/** Same linked-private-owner / source-or-destination audience as list_schedules. No writes. */
export async function visibleSchedules(
  records: readonly TaskRecord<unknown, unknown, unknown>[],
  read: DocumentReader,
  conversationId: ConversationId,
  chat: Pick<ChatAccess, 'privateIdentity'>,
  ctx: Context
) {
  const identity = await chat.privateIdentity(read, conversationId, ctx)
  const visible = await Promise.all(
    records.map(async task => {
      const input = task.input as ScheduleInput
      return identity
        ? (await resolveIdentity(read, input.ownerIdentityId, ctx)) === identity
        : task.conversationId === conversationId || input.sourceConversationId === conversationId
    })
  )
  return records.filter((_, index) => visible[index])
}
