import { createMemoryState } from '@chat-adapter/state-memory'
import { databaseUrl, isPostgresUrl } from 'storage/config'
import { PostgresChatState } from 'extensions/chat/postgres-state'

export async function createTransportState() {
  const url = await databaseUrl()
  return isPostgresUrl(url) ? new PostgresChatState(url) : createMemoryState()
}
