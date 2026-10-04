import { SQL, type ReservedSQL } from 'bun'
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

class PostgresDatabase implements SqliteDatabase {
  private tail: Promise<unknown> = Promise.resolve()
  private closing?: Promise<void>

  constructor(
    private pool: SQL,
    private connection: ReservedSQL,
    private checkConnection: () => void
  ) {}

  private enqueue<T>(operation: () => Promise<T>) {
    if (this.closing) return Promise.reject<T>(new Error('PostgreSQL storage is closed'))
    const result = this.tail.then(() => {
      this.checkConnection()
      return operation()
    })
    this.tail = result.catch(() => {})
    return result
  }

  private async query<T extends object>(sql: string, params: SqliteValue[] = []): Promise<T[]> {
    this.checkConnection()
    const rows = await this.connection.unsafe<Record<string, unknown>[]>(postgresSql(sql), params)
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

  async exec(sql: string) {
    await this.enqueue(() => this.query(sql))
  }

  async run(sql: string, ...params: SqliteValue[]) {
    await this.enqueue(() => this.query(sql, params))
  }

  get<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(async () => (await this.query<T>(sql, params))[0])
  }

  all<T extends object>(sql: string, ...params: SqliteValue[]) {
    return this.enqueue(() => this.query<T>(sql, params))
  }

  transaction<T>(callback: (transaction: SqliteExecutor) => Promise<T>) {
    return this.enqueue(async () => {
      await this.connection`BEGIN`
      let active = true
      const query = <R extends object>(sql: string, params: SqliteValue[] = []) => {
        if (!active) throw new Error('PostgreSQL transaction handle is no longer active')
        return this.query<R>(sql, params)
      }
      try {
        const result = await callback({
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
        await this.connection`COMMIT`
        return result
      } catch (error) {
        active = false
        try {
          await this.connection`ROLLBACK`
        } catch (rollbackError) {
          // An uncertain rollback must never be reported as Pi's safely retryable StorageRejected.
          throw new AggregateError([error, rollbackError], 'PostgreSQL transaction and rollback failed')
        }
        throw error
      }
    })
  }

  close() {
    return (this.closing ??= this.tail.then(async () => {
      this.connection.release()
      await this.pool.close()
    }))
  }
}

export async function openPostgresStorage(url: string) {
  let disconnected = false
  const pool = new SQL(url, {
    adapter: 'postgres',
    max: 1,
    idleTimeout: 0,
    maxLifetime: 0,
    bigint: true,
    connection: { application_name: 'clanker', synchronous_commit: 'on' },
    onclose: () => {
      disconnected = true
    }
  })
  try {
    const connection = await pool.reserve()
    const database = new PostgresDatabase(pool, connection, () => {
      if (disconnected) throw new Error('PostgreSQL storage connection was lost. Restart Clanker to reacquire database ownership.')
    })
    try {
      // One owner per database, without blocking unrelated chat-sdk tables or connections.
      const [lock] = await connection`SELECT pg_try_advisory_lock(1129070926, 1) AS locked`
      if (!lock.locked) throw new Error('Another Clanker process owns this PostgreSQL database. Stop it before starting this process.')
      return await SqliteStorage.open(database)
    } catch (error) {
      await database.close()
      throw error
    }
  } catch (error) {
    await pool.close()
    throw error
  }
}
