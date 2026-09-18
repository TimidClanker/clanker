import { SQL } from 'bun'
import { migrate } from './migrations'

export async function initializeDatabase(url = process.env.DATABASE_URL ?? 'sqlite://./clanker.sqlite') {
  const sql = new SQL(url)
  try {
    await migrate(sql)
    return sql
  } catch (error) {
    await sql.close()
    throw error
  }
}
