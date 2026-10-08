import { Database } from 'bun:sqlite'
import { mkdir, realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Storage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { openPostgresStorage } from 'storage/postgres'
import { databaseUrl, isPostgresUrl } from 'storage/config'

async function openSqliteStorage(path: string, signal?: AbortSignal): Promise<Storage> {
  if (path === ':memory:') return openNodeSqliteStorage(path)
  await mkdir(dirname(path), { recursive: true })
  // Resolve aliases so symlinked paths cannot acquire different locks for the same database.
  path = await realpath(path).catch(error => {
    if (error.code !== 'ENOENT') throw error
    return realpath(dirname(path)).then(directory => join(directory, basename(path)))
  })
  const lock = new Database(`${path}.lock`)
  try {
    lock.exec('PRAGMA busy_timeout = 0')
    let waiting = false
    for (;;) {
      signal?.throwIfAborted()
      try {
        lock.exec('BEGIN EXCLUSIVE')
        break
      } catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error
        if (!waiting) console.info('[storage] Waiting for SQLite ownership…')
        waiting = true
        await delay(1000, undefined, { signal })
      }
    }
    if (waiting) console.info('[storage] SQLite ownership acquired')
  } catch (error) {
    lock.close()
    throw error
  }
  try {
    const storage = await openNodeSqliteStorage(path)
    const close = storage.close.bind(storage)
    let closing: Promise<void> | undefined
    storage.close = context => (closing ??= close(context).finally(() => lock.close()))
    return storage
  } catch (error) {
    lock.close()
    throw error
  }
}

export async function openStorage(url?: string, options: { signal?: AbortSignal; onOwnershipLost?: () => void } = {}): Promise<Storage & AsyncDisposable> {
  options.signal?.throwIfAborted()
  url = url?.trim() || (await databaseUrl())
  let storage: Storage
  if (isPostgresUrl(url)) {
    storage = await openPostgresStorage(url, options)
  } else {
    let path = url
    if (/^sqlite:/i.test(url)) path = decodeURIComponent(url.replace(/^sqlite:(\/\/)?/i, ''))
    else if (/^file:/i.test(url)) path = fileURLToPath(url)
    else if (url !== ':memory:' && /^[a-z][a-z\d+.-]*:/i.test(url)) throw new Error('DATABASE_URL must select PostgreSQL or SQLite')
    if (!path) throw new Error('SQLite DATABASE_URL must include a filename')
    storage = await openSqliteStorage(path === ':memory:' ? path : resolve(path), options.signal)
  }
  return Object.assign(storage, { [Symbol.asyncDispose]: () => storage.close(BACKGROUND_CONTEXT) })
}
