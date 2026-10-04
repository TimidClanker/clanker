import { SQL, type ReservedSQL } from 'bun'
import { setTimeout as delay } from 'node:timers/promises'
import { SqliteStorage, type SqliteDatabase, type SqliteExecutor, type SqliteValue } from '@earendil-works/pi-durable/storage/sqlite'

// Adapt only the SQL emitted by Pi's pinned portable storage core. Values remain bound parameters.
// Keeping the core preserves its fork, history, ID, and atomic-commit semantics on both backends.
function postgresSql(sql: string) {
  let parameter = 0
  const ignore = sql.startsWith('INSERT OR IGNORE INTO ')
  return (
    sql
      .replace(/\b(durable_schema|durable_metadata|record_ids|conversations|entries|tasks|submissions|documents|document_revisions)\b/g, 'public.clanker_$1')
      .replace(/\bCREATE INDEX (\w+)/g, 'CREATE INDEX clanker_$1')
      .replace(/\bINTEGER\b/g, 'BIGINT')
      .replace(/\) STRICT\b/g, ')')
      .replace(/json_valid\((\w+)\)/g, '($1::json IS NOT NULL)')
      .replace('INSERT OR IGNORE INTO ', 'INSERT INTO ')
      .replace(/\?/g, () => `$${++parameter}`) + (ignore ? ' ON CONFLICT DO NOTHING' : '')
  )
}

// Only availability failures are retried. Authentication, SQL, and schema errors still surface.
function transient(error: unknown) {
  const { code, errno } = error as { code?: string; errno?: string }
  return [code, errno].some(
    value =>
      value &&
      (/^08/.test(value) ||
        [
          '57P01',
          '57P02',
          '57P03',
          '53300',
          '40001',
          '40P01',
          'ECONNREFUSED',
          'ECONNRESET',
          'ETIMEDOUT',
          'EPIPE',
          'EAI_AGAIN',
          'ENETUNREACH',
          'EHOSTUNREACH',
          'ERR_POSTGRES_CONNECTION_CLOSED',
          'ERR_POSTGRES_CONNECTION_TIMEOUT',
          'ERR_POSTGRES_IDLE_TIMEOUT',
          'ERR_POSTGRES_LIFETIME_TIMEOUT'
        ].includes(value))
  )
}

class PostgresDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>
  private stopped = new AbortController()
  private signal: AbortSignal
  private owner = crypto.randomUUID()
  private initialized = false
  private lost = false
  private session?: { pool: SQL; connection?: ReservedSQL; disconnected: boolean }
  private interrupt = () => {
    void this.session?.pool.close({ timeout: 0 })
  }

  constructor(
    private url: string,
    private options: { signal?: AbortSignal; onOwnershipLost?: () => void }
  ) {
    this.signal = AbortSignal.any([this.stopped.signal, ...(options.signal ? [options.signal] : [])])
    this.signal.addEventListener('abort', this.interrupt, { once: true })
  }

  private async disconnect() {
    const session = this.session
    this.session = undefined
    session?.connection?.release()
    await session?.pool.close({ timeout: 0 })
  }

  private async connect() {
    const session = {
      pool: new SQL(this.url, {
        adapter: 'postgres',
        max: 1,
        idleTimeout: 0,
        maxLifetime: 0,
        connectionTimeout: 5,
        bigint: true,
        connection: { application_name: 'clanker', synchronous_commit: 'on', tcp_keepalives_idle: 15, tcp_keepalives_interval: 5, tcp_keepalives_count: 3 },
        onclose: () => {
          session.disconnected = true
        }
      }),
      connection: undefined as ReservedSQL | undefined,
      disconnected: false
    }
    this.session = session
    const connection = (session.connection = await session.pool.reserve())
    let waiting = false
    while (true) {
      this.signal.throwIfAborted()
      const [lock] = await connection`SELECT pg_try_advisory_lock(1129070926, 1) AS locked`
      if (lock.locked) break
      if (!waiting) console.info('[storage] Waiting for PostgreSQL ownership…')
      waiting = true
      await delay(1000, undefined, { signal: this.signal })
    }
    if (waiting) console.info('[storage] PostgreSQL ownership acquired')
    await connection`CREATE TABLE IF NOT EXISTS public.clanker_storage_state (
      singleton integer PRIMARY KEY CHECK (singleton = 1), owner text NOT NULL, transaction_id text
    )`
    if (!this.initialized) {
      await connection`INSERT INTO public.clanker_storage_state (singleton, owner) VALUES (1, ${this.owner})
        ON CONFLICT (singleton) DO UPDATE SET owner = EXCLUDED.owner, transaction_id = NULL`
      this.initialized = true
    } else {
      const [state] = await connection`SELECT owner FROM public.clanker_storage_state WHERE singleton = 1`
      if (state?.owner !== this.owner) {
        this.lost = true
        this.options.onOwnershipLost?.()
        await this.disconnect()
        throw new Error('PostgreSQL ownership changed; reopening the durable session')
      }
    }
  }

  private enqueue<T>(operation: () => Promise<T>) {
    if (this.closing) return Promise.reject<T>(new Error('PostgreSQL storage is closed'))
    const result = this.tail.then(async () => {
      let attempt = 0
      for (;;) {
        this.signal.throwIfAborted()
        if (this.lost) throw new Error('PostgreSQL ownership changed; reopening the durable session')
        try {
          if (!this.session) await this.connect()
          const value = await operation()
          if (attempt) console.info('[storage] PostgreSQL connection recovered')
          return value
        } catch (error) {
          if (this.signal.aborted || !transient(error)) throw error
          await this.disconnect()
          if (!attempt || attempt % 12 === 0) console.warn('[storage] PostgreSQL temporarily unavailable; retrying', (error as { code?: string }).code)
          await delay(Math.min(250 * 2 ** Math.min(attempt++, 5), 5000), undefined, { signal: this.signal })
        }
      }
    })
    this.tail = result.catch(() => {})
    return result
  }

  private async query<T extends object>(sql: string, params: SqliteValue[] = []): Promise<T[]> {
    this.signal.throwIfAborted()
    if (this.session!.disconnected) throw Object.assign(new Error('PostgreSQL connection closed'), { code: 'ERR_POSTGRES_CONNECTION_CLOSED' })
    const rows = await this.session!.connection!.unsafe<Record<string, unknown>[]>(postgresSql(sql), params)
    // Pi uses safe JS integers for IDs and sequences; PostgreSQL stores them as int8.
    return Array.from(
      rows,
      row =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => {
            if (typeof value !== 'bigint') return [key, value]
            const number = Number(value)
            if (!Number.isSafeInteger(number)) throw new Error(`PostgreSQL ${key} exceeds Pi Durable's safe integer range`)
            return [key, number]
          })
        ) as T
    )
  }

  exec(sql: string) {
    return this.transaction(tx => tx.exec(sql))
  }
  run(sql: string, ...params: SqliteValue[]) {
    return this.transaction(tx => tx.run(sql, ...params))
  }
  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(async () => (await this.query<T>(sql, params))[0])
  }
  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.query<T>(sql, params))
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>) {
    const id = crypto.randomUUID()
    let committing = false
    let result: T
    return this.enqueue(async () => {
      // The receipt and Pi's writes commit together. A lost COMMIT acknowledgment must not replay the writes.
      if (committing) {
        const [state] = await this.query<{ transaction_id: string }>('SELECT transaction_id FROM public.clanker_storage_state WHERE singleton = 1')
        if (state?.transaction_id === id) return result
      }
      committing = false
      await this.query('BEGIN')
      let active = true
      const query = <R extends object>(sql: string, params: SqliteValue[] = []) => {
        if (!active) throw new Error('PostgreSQL transaction handle is no longer active')
        return this.query<R>(sql, params)
      }
      try {
        result = await callback({
          exec: async sql => {
            await query(sql)
          },
          run: async (sql, ...params) => {
            await query(sql, params)
          },
          get: async <R extends object>(sql: string, ...params: SqliteValue[]) => (await query<R>(sql, params))[0],
          all: <R extends object>(sql: string, ...params: SqliteValue[]) => query<R>(sql, params)
        })
        active = false
        await this.query('UPDATE public.clanker_storage_state SET transaction_id = ? WHERE singleton = 1', [id])
        committing = true
        await this.query('COMMIT')
        return result
      } catch (error) {
        active = false
        if (transient(error) || this.signal.aborted) throw error // Reconnect under the lock before resolving or replaying.
        try {
          await this.query('ROLLBACK')
        } catch (rollbackError) {
          if (transient(rollbackError)) throw rollbackError
          throw new AggregateError([error, rollbackError], 'PostgreSQL transaction and rollback failed')
        }
        throw error
      }
    })
  }

  stop() {
    this.stopped.abort(new Error('PostgreSQL storage is closing'))
  }
  close() {
    this.stop()
    return (this.closing ??= this.tail.then(async () => {
      this.signal.removeEventListener('abort', this.interrupt)
      await this.disconnect()
    }))
  }
}

export async function openPostgresStorage(url: string, options: { signal?: AbortSignal; onOwnershipLost?: () => void } = {}) {
  const database = new PostgresDatabase(url, options)
  try {
    const storage = await SqliteStorage.open(database)
    const close = storage.close.bind(storage)
    storage.close = context => {
      database.stop()
      return close(context)
    }
    return storage
  } catch (error) {
    await database.close()
    throw error
  }
}
