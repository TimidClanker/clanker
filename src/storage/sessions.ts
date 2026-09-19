import type { SQL } from 'bun'
import { withDatabase } from '.'
import type { ClankerSession, ClankerSessionMetadata } from '../session'

export interface SavedSessionSummary {
  id: string
  threadId: string
  ownerId: string
  createdAt: string
  lastActiveAt: string
  metadata: ClankerSessionMetadata
}

type SessionRow = {
  id: string
  thread_id: string
  owner_id: string
  created_at: string
  last_active_at: string
  metadata: string
  settings: string
  leaf_id: string | null
  content: Uint8Array
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
      INSERT INTO sessions (id, thread_id, owner_id, created_at, last_active_at, metadata, settings, leaf_id, content)
      VALUES (${summary.id}, ${summary.threadId}, ${summary.ownerId}, ${summary.createdAt}, ${summary.lastActiveAt},
              ${metadata}, ${settings}, ${snapshot.leafId}, ${content})
      ON CONFLICT (id) DO UPDATE SET
        last_active_at = excluded.last_active_at, metadata = excluded.metadata,
        settings = excluded.settings, leaf_id = excluded.leaf_id, content = excluded.content
    `
    )
  }

  async list(threadId: string, ownerId: string, limit: number): Promise<SavedSessionSummary[]> {
    const rows = await withDatabase(
      this.sql,
      () => this.sql<Omit<SessionRow, 'settings' | 'leaf_id' | 'content'>[]>`
      SELECT id, thread_id, owner_id, created_at, last_active_at, metadata FROM sessions
      WHERE thread_id = ${threadId} AND owner_id = ${ownerId}
      ORDER BY last_active_at DESC, id DESC LIMIT ${limit}
    `
    )
    return rows.map(row => ({
      id: row.id,
      threadId: row.thread_id,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      metadata: JSON.parse(row.metadata)
    }))
  }

  async load(id: string, threadId: string, ownerId: string) {
    const [row] = await withDatabase(
      this.sql,
      () => this.sql<SessionRow[]>`
      SELECT * FROM sessions WHERE id = ${id} AND thread_id = ${threadId} AND owner_id = ${ownerId}
    `
    )
    if (!row) throw new Error(`Session ${id} was not found`)
    return {
      id: row.id,
      threadId: row.thread_id,
      ownerId: row.owner_id,
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
      metadata: JSON.parse(row.metadata) as ClankerSessionMetadata,
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
