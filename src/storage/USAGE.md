# Durable storage

Storage selection, in priority order:

1. A nonempty `DATABASE_URL` environment variable.
2. The `url` field in `$SECRETS_DIR/database.json` (`SECRETS_DIR` defaults to `./secrets`).
3. `sqlite://./workspace/durable.sqlite`.

For PostgreSQL, use `postgres://user:password@host:5432/database` or `postgresql://...`. Bun SQL handles the connection; URL connection options such as `sslmode=require` are supported.

Alternatively, put the URL in `secrets/database.json` and restrict its permissions to `600`:

```json
{ "url": "postgres://user:password@host:5432/database" }
```

SQLite accepts `sqlite://./workspace/durable.sqlite`, `sqlite:///absolute/path/durable.sqlite`, `file:///absolute/path/durable.sqlite`, or a plain filename. Relative paths resolve from the process working directory. `sqlite::memory:` selects an ephemeral database. `DATABASE_URL` replaces the old `DATABASE_PATH` setting.

Switching URLs selects a separate store; it does not copy existing data. An invalid configuration or unavailable configured database fails startup rather than silently opening another database.

## PostgreSQL

All durable app data uses these tables in the existing `public` schema:

- `clanker_durable_schema`, `clanker_durable_metadata`, `clanker_record_ids`
- `clanker_conversations`, `clanker_entries`, `clanker_tasks`, `clanker_submissions`
- `clanker_documents`, `clanker_document_revisions`

Indexes also use the `clanker_` prefix. The database user needs permission to create and access these tables. Unrelated tables, including Chat SDK tables, are unaffected. This setting does not change Chat SDK's in-memory transport state or credential files.

Pi Durable requires one harness owner per store. Clanker holds a PostgreSQL session advisory lock on a dedicated connection; use a direct connection or session pooling, not transaction pooling. A second Clanker process fails startup. Losing the connection makes storage operations fail until Clanker restarts and reacquires ownership. SQLite uses an exclusive sidecar lock, released when storage closes.

The PostgreSQL adapter reuses Pi Durable's portable SQLite storage core for IDs, commits, forks, documents, history, and recovery, translating its SQL dialect and binding values through Bun SQL. It is coupled to the pinned Pi version: review SQL changes and run Pi's upstream storage conformance cases against PostgreSQL when upgrading. JSON remains text to preserve Pi's exact JSON and Unicode semantics.
