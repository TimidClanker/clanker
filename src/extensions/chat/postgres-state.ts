import { SQL, type TransactionSQL } from 'bun'
import type { Lock, QueueEntry, StateAdapter } from 'chat'

// Separate from the durable harness tables. JSON stays text so Bun does not decode it twice.
const schema = [
  `CREATE TABLE IF NOT EXISTS public.chat_sdk_subscriptions (thread_id text PRIMARY KEY)`,
  `CREATE TABLE IF NOT EXISTS public.chat_sdk_locks (thread_id text PRIMARY KEY, token text NOT NULL, expires_at timestamptz NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS public.chat_sdk_cache (key text PRIMARY KEY, value text NOT NULL, expires_at timestamptz)`,
  `CREATE TABLE IF NOT EXISTS public.chat_sdk_lists (key text NOT NULL, seq bigserial PRIMARY KEY, value text NOT NULL, expires_at timestamptz)`,
  `CREATE INDEX IF NOT EXISTS chat_sdk_lists_key_seq ON public.chat_sdk_lists (key, seq)`,
  `CREATE TABLE IF NOT EXISTS public.chat_sdk_queues (thread_id text NOT NULL, seq bigserial PRIMARY KEY, value text NOT NULL, expires_at timestamptz NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS chat_sdk_queues_thread_seq ON public.chat_sdk_queues (thread_id, seq)`
]

export class PostgresChatState implements StateAdapter {
  private pool?: SQL
  private transition: Promise<void> = Promise.resolve()

  constructor(private url: string) {}

  // Serialize lifecycle changes, including disconnect during startup and reconnect after shutdown.
  private lifecycle(work: () => Promise<void>) {
    const result = this.transition.then(work)
    this.transition = result.catch(() => {})
    return result
  }

  connect() {
    return this.lifecycle(async () => {
      if (this.pool) return
      const pool = new SQL(this.url, { max: 5, connectionTimeout: 10, idleTimeout: 20 })
      try {
        await pool.begin(async sql => {
          // IF NOT EXISTS alone does not protect concurrent first-time catalog creation.
          await sql`SELECT pg_advisory_xact_lock(hashtextextended('chat_sdk_schema', 0))`
          for (const statement of schema) await sql.unsafe(statement)
        })
        this.pool = pool
      } catch (error) {
        await pool.close({ timeout: 0 })
        throw error
      }
    })
  }

  disconnect() {
    return this.lifecycle(async () => {
      const pool = this.pool
      this.pool = undefined
      await pool?.close({ timeout: 5 })
    })
  }

  private get sql() {
    if (!this.pool) throw new Error('PostgresChatState is not connected')
    return this.pool
  }

  async subscribe(threadId: string) {
    await this.sql`INSERT INTO public.chat_sdk_subscriptions VALUES (${threadId}) ON CONFLICT DO NOTHING`
  }

  async unsubscribe(threadId: string) {
    await this.sql`DELETE FROM public.chat_sdk_subscriptions WHERE thread_id = ${threadId}`
  }

  async isSubscribed(threadId: string) {
    const rows = await this.sql`SELECT 1 FROM public.chat_sdk_subscriptions WHERE thread_id = ${threadId}`
    return rows.length > 0
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const token = crypto.randomUUID()
    const rows = await this.sql`INSERT INTO public.chat_sdk_locks (thread_id, token, expires_at)
      VALUES (${threadId}, ${token}, clock_timestamp() + ${ttlMs} * interval '1 millisecond')
      ON CONFLICT (thread_id) DO UPDATE SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
      WHERE chat_sdk_locks.expires_at <= clock_timestamp()
      RETURNING expires_at`
    return rows.length ? { threadId, token, expiresAt: rows[0].expires_at.getTime() } : null
  }

  async releaseLock(lock: Lock) {
    await this.sql`DELETE FROM public.chat_sdk_locks WHERE thread_id = ${lock.threadId} AND token = ${lock.token}`
  }

  async forceReleaseLock(threadId: string) {
    await this.sql`DELETE FROM public.chat_sdk_locks WHERE thread_id = ${threadId}`
  }

  async extendLock(lock: Lock, ttlMs: number) {
    const rows = await this.sql`UPDATE public.chat_sdk_locks
      SET expires_at = clock_timestamp() + ${ttlMs} * interval '1 millisecond'
      WHERE thread_id = ${lock.threadId} AND token = ${lock.token} AND expires_at > clock_timestamp()
      RETURNING thread_id`
    return rows.length > 0
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const rows = await this.sql`SELECT value FROM public.chat_sdk_cache
      WHERE key = ${key} AND (expires_at IS NULL OR expires_at > clock_timestamp())`
    return rows.length ? JSON.parse(rows[0].value) : null
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number) {
    await this.sql`INSERT INTO public.chat_sdk_cache (key, value, expires_at)
      VALUES (${key}, ${JSON.stringify(value)}, ${ttlMs ? new Date(Date.now() + ttlMs) : null})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at`
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number) {
    const rows = await this.sql`INSERT INTO public.chat_sdk_cache (key, value, expires_at)
      VALUES (${key}, ${JSON.stringify(value)}, ${ttlMs ? new Date(Date.now() + ttlMs) : null})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, expires_at = EXCLUDED.expires_at
      WHERE chat_sdk_cache.expires_at <= clock_timestamp()
      RETURNING key`
    return rows.length > 0
  }

  async delete(key: string) {
    await this.sql`DELETE FROM public.chat_sdk_cache WHERE key = ${key}`
  }

  // Hold a transaction-scoped per-key lock across append, trim and TTL refresh. Unlike
  // row locks this also serializes independent clients when the list/queue is empty.
  private atomic<T>(kind: 'list' | 'queue', key: string, work: (sql: TransactionSQL) => Promise<T>) {
    return this.sql.begin(async sql => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['chat_sdk', kind, key])}, 0))`
      return work(sql)
    })
  }

  async appendToList(key: string, value: unknown, options?: { maxLength?: number; ttlMs?: number }) {
    await this.atomic('list', key, async sql => {
      await sql`DELETE FROM public.chat_sdk_lists WHERE key = ${key} AND expires_at <= clock_timestamp()`
      const expiresAt = options?.ttlMs ? new Date(Date.now() + options.ttlMs) : null
      await sql`INSERT INTO public.chat_sdk_lists (key, value, expires_at) VALUES (${key}, ${JSON.stringify(value)}, ${expiresAt})`
      if (options?.maxLength && options.maxLength > 0) {
        await sql`DELETE FROM public.chat_sdk_lists WHERE key = ${key} AND seq IN (
          SELECT seq FROM public.chat_sdk_lists WHERE key = ${key} ORDER BY seq DESC OFFSET ${options.maxLength})`
      }
      // TTL belongs to the whole list and is refreshed on append, like the memory adapter.
      await sql`UPDATE public.chat_sdk_lists SET expires_at = ${expiresAt} WHERE key = ${key}`
    })
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const rows = await this.sql`SELECT value FROM public.chat_sdk_lists
      WHERE key = ${key} AND (expires_at IS NULL OR expires_at > clock_timestamp()) ORDER BY seq`
    return rows.map((row: { value: string }) => JSON.parse(row.value))
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number) {
    return this.atomic('queue', threadId, async sql => {
      await sql`DELETE FROM public.chat_sdk_queues WHERE thread_id = ${threadId} AND expires_at <= clock_timestamp()`
      const expiresAt = new Date(entry.expiresAt)
      await sql`INSERT INTO public.chat_sdk_queues (thread_id, value, expires_at)
        SELECT ${threadId}, ${JSON.stringify(entry)}, ${expiresAt} WHERE ${expiresAt} > clock_timestamp()`
      if (maxSize > 0) {
        await sql`DELETE FROM public.chat_sdk_queues WHERE thread_id = ${threadId} AND seq IN (
          SELECT seq FROM public.chat_sdk_queues WHERE thread_id = ${threadId} AND expires_at > statement_timestamp()
          ORDER BY seq DESC OFFSET ${maxSize})`
      }
      const rows = await sql`SELECT count(*) AS depth FROM public.chat_sdk_queues
        WHERE thread_id = ${threadId} AND expires_at > clock_timestamp()`
      return Number(rows[0].depth)
    })
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    return this.atomic('queue', threadId, async sql => {
      await sql`DELETE FROM public.chat_sdk_queues WHERE thread_id = ${threadId} AND expires_at <= clock_timestamp()`
      const rows = await sql`DELETE FROM public.chat_sdk_queues WHERE thread_id = ${threadId} AND seq = (
        SELECT seq FROM public.chat_sdk_queues WHERE thread_id = ${threadId} AND expires_at > clock_timestamp() ORDER BY seq LIMIT 1) RETURNING value`
      return rows.length ? JSON.parse(rows[0].value) : null
    })
  }

  async queueDepth(threadId: string) {
    const rows = await this.sql`SELECT count(*) AS depth FROM public.chat_sdk_queues
      WHERE thread_id = ${threadId} AND expires_at > clock_timestamp()`
    return Number(rows[0].depth)
  }
}
