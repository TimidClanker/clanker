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

Switching URLs selects a separate store; it does not copy existing data. Invalid configuration, authentication, and schema errors fail startup. Temporary PostgreSQL availability errors are retried, including during startup; Clanker never silently opens another database.

## Chat SDK transport state

Chat SDK uses the same URL selection above, separately from the durable harness. A PostgreSQL URL selects Bun-native PostgreSQL transport state; the SQLite default and deliberately configured SQLite stores keep `@chat-adapter/state-memory`. No additional transport URL setting or fallback precedence is introduced. Configured PostgreSQL connection/schema failures propagate; they never select memory instead.

Transport state uses `public.chat_sdk_subscriptions`, `public.chat_sdk_locks`, `public.chat_sdk_cache`, `public.chat_sdk_lists`, and `public.chat_sdk_queues`, with `chat_sdk_` indexes/sequences. These are separate from the harness's `clanker_` tables. The runtime database user needs create/access privileges. Tables are created on Chat initialization, serialized across concurrent clients. Chat shutdown closes its own Bun SQL pool; it does not close the harness's connections.

Subscriptions, JSON cache, bounded lists, and pending queues survive reconnect/restart. Locks use expiring ownership tokens; stale holders cannot renew or release a replacement lock. List appends and queue append/trim/dequeue operations are atomic across independent clients. Expired cache/list/queue values are excluded on reads; expired list/queue rows are cleaned when that key is next modified. TTL is not a background garbage collector.

This adapter follows the installed Chat SDK 4.41.1 contract, using the official `@chat-adapter/state-pg` 4.41.1 as reference, without its node `pg` dependency. Unlike durable harness storage, transport operations do not retry ambiguous SQL failures. Transport persistence does **not** make chat sends exactly-once or guarantee replay of pending queues after restart: dequeue removes an entry before its handler finishes, and SDK processing must trigger to drain a persisted queue.

## PostgreSQL

All durable app data uses these tables in the existing `public` schema:

- `clanker_durable_schema`, `clanker_durable_metadata`, `clanker_record_ids`
- `clanker_conversations`, `clanker_entries`, `clanker_tasks`, `clanker_submissions`
- `clanker_documents`, `clanker_document_revisions`
- `clanker_storage_state` (ownership and the last committed transaction receipt)

Indexes also use the `clanker_` prefix. The database user needs permission to create and access these tables. Unrelated tables are unaffected. Credential files are not stored in the database.

Pi Durable requires one harness owner per store. Clanker holds a PostgreSQL session advisory lock on a dedicated connection; use a direct connection or session pooling, not transaction pooling. For Neon, use the direct URL without `-pooler` in the hostname. Another Clanker process waits for ownership, checking once per second. PostgreSQL releases ownership when the connection ends, including after detecting a dead process. SQLite also waits for its exclusive sidecar lock, which the OS releases when the process exits.

Temporary SQL errors reconnect with backoff from 250 milliseconds up to five seconds, continuing until recovery or shutdown. No heartbeat keeps an idle Neon compute awake. Pending storage operations wait through the outage, and the connection must reacquire ownership before proceeding. Transactions record a receipt alongside their writes, so a lost commit acknowledgment can be resolved without applying the transaction twice.

If another process owned the database during a disconnection, Clanker closes its stale harness and opens a new one from durable state. It restores chat subscriptions and resumes durable work. Pending incoming message admission retries against the new harness, using its existing message-ID receipt to avoid duplicates. This protects database commits; it does not make external side effects such as chat posts exactly-once.

Shutdown interrupts database retries and lock waiting. Only one process does durable work at a time; waiting processes are standbys, not additional workers. Lock acquisition is not ordered or prioritized.

The PostgreSQL adapter reuses Pi Durable's portable SQLite storage core for IDs, commits, forks, documents, history, and recovery, translating its SQL dialect and binding values through Bun SQL. It is coupled to the pinned Pi version: review SQL changes and run Pi's upstream storage conformance cases against PostgreSQL when upgrading. JSON remains text to preserve Pi's exact JSON and Unicode semantics.
