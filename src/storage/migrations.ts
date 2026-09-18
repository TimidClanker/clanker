import type { SQL, TransactionSQL } from 'bun'

// Append migrations; never change the order of migrations already deployed.
export const migrations: ((sql: TransactionSQL) => Promise<void>)[] = [
  async sql => {
    await sql`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        metadata TEXT NOT NULL,
        settings TEXT NOT NULL,
        leaf_id TEXT,
        content BYTEA NOT NULL
      )
    `
    await sql`CREATE INDEX IF NOT EXISTS sessions_routing ON sessions (thread_id, owner_id, last_active_at)`
  }
]

export async function migrate(sql: SQL) {
  await sql`CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)`
  const applied = new Set((await sql<{ version: number }[]>`SELECT version FROM schema_migrations`).map(row => row.version))
  for (const [index, migration] of migrations.entries()) {
    const version = index + 1
    if (applied.has(version)) continue
    await sql.begin(async transaction => {
      await migration(transaction)
      await transaction`INSERT INTO schema_migrations (version) VALUES (${version})`
    })
  }
}
