import { SQL } from 'bun'
import { migrate } from './migrations'

const queues = new WeakMap<SQL, Promise<unknown>>()

// Bun SQLite shares one connection, including while a transaction is awaiting queries.
export function withDatabase<T>(sql: SQL, action: () => Promise<T>): Promise<T> {
  if (sql.options.adapter !== 'sqlite') return action()
  const task = (queues.get(sql) ?? Promise.resolve()).then(action)
  queues.set(
    sql,
    task.catch(() => {})
  )
  return task
}

export async function initializeDatabase(url = process.env.DATABASE_URL ?? 'sqlite://./clanker.sqlite') {
  const sql = new SQL(url)
  try {
    if (sql.options.adapter === 'sqlite') await sql`PRAGMA foreign_keys = ON`
    await migrate(sql)
    return sql
  } catch (error) {
    await sql.close()
    throw error
  }
}
