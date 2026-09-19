import type { SQL } from 'bun'
import { withDatabase } from '.'
import type { ClankerSession, ClankerSessionMetadata } from '../session'
import type { ConnectionIdentity } from './users'

export type SessionIdentity = ConnectionIdentity & { userId: string | null }

export interface SavedSessionSummary {
  id: string
  threadId: string
  adapter: string
  ownerId: string
  userId: string | null
  createdAt: string
  lastActiveAt: string
  metadata: ClankerSessionMetadata
}

type SessionRow = {
  id: string
  thread_id: string
  adapter: string
  owner_id: string
  user_id: string | null
  created_at: string
  last_active_at: string
  metadata: string
  settings: string
  leaf_id: string | null
  content: Uint8Array
}

function summarize(row: Omit<SessionRow, 'settings' | 'leaf_id' | 'content'>): SavedSessionSummary {
  return {
    id: row.id,
    threadId: row.thread_id,
    adapter: row.adapter,
    ownerId: row.owner_id,
    userId: row.user_id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
    metadata: JSON.parse(row.metadata)
  }
}

export class SessionStore {
  constructor(private sql: SQL) {}

  async save(summary: SavedSessionSummary, snapshot: ReturnType<ClankerSession['snapshot']>) {
    const metadata = JSON.stringify(summary.metadata)
    const settings = JSON.stringify(snapshot.settings)
    const content = await Bun.zstdCompress(snapshot.jsonl)
    await withDatabase(
      this.sql,
      () => this.sql`
      INSERT INTO sessions (id, thread_id, adapter, owner_id, user_id, created_at, last_active_at, metadata, settings, leaf_id, content)
      VALUES (${summary.id}, ${summary.threadId}, ${summary.adapter}, ${summary.ownerId}, ${summary.userId},
              ${summary.createdAt}, ${summary.lastActiveAt}, ${metadata}, ${settings}, ${snapshot.leafId}, ${content})
      ON CONFLICT (id) DO UPDATE SET
        user_id = COALESCE(sessions.user_id, excluded.user_id),
        last_active_at = excluded.last_active_at, metadata = excluded.metadata,
        settings = excluded.settings, leaf_id = excluded.leaf_id, content = excluded.content
    `
    )
  }

  async list(threadId: string, identity: SessionIdentity, limit: number) {
    const rows = await withDatabase(
      this.sql,
      () => this.sql<Omit<SessionRow, 'settings' | 'leaf_id' | 'content'>[]>`
      SELECT id, thread_id, adapter, owner_id, user_id, created_at, last_active_at, metadata FROM sessions
      WHERE thread_id = ${threadId}
        AND ((${identity.userId !== null} AND user_id = ${identity.userId})
          OR (${identity.userId === null} AND user_id IS NULL AND adapter = ${identity.adapter} AND owner_id = ${identity.platformUserId}))
      ORDER BY last_active_at DESC, id DESC LIMIT ${limit}
    `
    )
    return rows.map(summarize)
  }

  async load(id: string, identity: SessionIdentity, threadId: string) {
    const [row] = await withDatabase(
      this.sql,
      () => this.sql<SessionRow[]>`
      SELECT * FROM sessions WHERE id = ${id} AND thread_id = ${threadId}
        AND ((${identity.userId !== null} AND user_id = ${identity.userId})
          OR (${identity.userId === null} AND user_id IS NULL AND adapter = ${identity.adapter} AND owner_id = ${identity.platformUserId}))
    `
    )
    if (!row) throw new Error(`Session ${id} was not found`)
    return {
      ...summarize(row),
      snapshot: {
        settings: JSON.parse(row.settings) as ReturnType<ClankerSession['snapshot']>['settings'],
        leafId: row.leaf_id,
        jsonl: (await Bun.zstdDecompress(row.content)).toString()
      }
    }
  }

  async threads() {
    return (await withDatabase(this.sql, () => this.sql<{ thread_id: string }[]>`SELECT DISTINCT thread_id FROM sessions`)).map(row => row.thread_id)
  }
}
