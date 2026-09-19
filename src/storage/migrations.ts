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
  },
  async sql => {
    await sql`
      CREATE TABLE memory_boards (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        author_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `
    await sql`
      CREATE TABLE memory_posts (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES memory_boards(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      )
    `
    await sql`
      CREATE TABLE memory_replies (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES memory_posts(id),
        body TEXT NOT NULL,
        author_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `
    await sql`CREATE INDEX memory_posts_board_activity ON memory_posts (board_id, last_active_at, id)`
    await sql`CREATE INDEX memory_posts_activity ON memory_posts (last_active_at, id)`
    await sql`CREATE INDEX memory_replies_thread ON memory_replies (post_id, created_at, id)`
  },
  async sql => {
    await sql`CREATE TABLE users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL)`
    await sql`
      CREATE TABLE user_connections (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        adapter TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (adapter, platform_user_id)
      )
    `
    await sql`CREATE INDEX user_connections_user ON user_connections (user_id)`
    await sql`
      CREATE TABLE user_link_tokens (
        hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT NOT NULL
      )
    `
    await sql`ALTER TABLE sessions ADD COLUMN user_id TEXT REFERENCES users(id)`
    await sql`ALTER TABLE sessions ADD COLUMN adapter TEXT NOT NULL DEFAULT ''`
    const threads = await sql<{ thread_id: string }[]>`SELECT DISTINCT thread_id FROM sessions`
    for (const { thread_id } of threads) {
      await sql`UPDATE sessions SET adapter = ${thread_id.split(':')[0]!} WHERE thread_id = ${thread_id}`
    }
    await sql`CREATE INDEX sessions_user_routing ON sessions (user_id, thread_id, last_active_at)`

    // Rebuild the memory tables to remove the global name constraint on both SQLite and Postgres.
    await sql`
      CREATE TABLE memory_boards_v2 (
        id TEXT PRIMARY KEY,
        user_id TEXT REFERENCES users(id),
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT NOT NULL,
        author_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `
    await sql`
      INSERT INTO memory_boards_v2 (id, name, normalized_name, description, author_session_id, created_at)
      SELECT id, name, normalized_name, description, author_session_id, created_at FROM memory_boards
    `
    await sql`
      CREATE TABLE memory_posts_v2 (
        id TEXT PRIMARY KEY,
        board_id TEXT NOT NULL REFERENCES memory_boards_v2(id),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        author_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      )
    `
    await sql`INSERT INTO memory_posts_v2 SELECT * FROM memory_posts`
    await sql`
      CREATE TABLE memory_replies_v2 (
        id TEXT PRIMARY KEY,
        post_id TEXT NOT NULL REFERENCES memory_posts_v2(id),
        body TEXT NOT NULL,
        author_session_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `
    await sql`INSERT INTO memory_replies_v2 SELECT * FROM memory_replies`
    await sql`DROP TABLE memory_replies`
    await sql`DROP TABLE memory_posts`
    await sql`DROP TABLE memory_boards`
    await sql`ALTER TABLE memory_boards_v2 RENAME TO memory_boards`
    await sql`ALTER TABLE memory_posts_v2 RENAME TO memory_posts`
    await sql`ALTER TABLE memory_replies_v2 RENAME TO memory_replies`
    await sql`CREATE UNIQUE INDEX memory_boards_scope_name ON memory_boards (COALESCE(user_id, ''), normalized_name)`
    await sql`CREATE INDEX memory_posts_board_activity ON memory_posts (board_id, last_active_at, id)`
    await sql`CREATE INDEX memory_posts_activity ON memory_posts (last_active_at, id)`
    await sql`CREATE INDEX memory_replies_thread ON memory_replies (post_id, created_at, id)`
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
