import { chmod, link, lstat, mkdir, realpath, rmdir, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { StatusService } from 'status/service'

import { maxStatusBytes, statusSocket } from 'status/transport'
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'

/** Private directory + exclusive guard; stale sockets/guards require explicit operator removal. Never replace them. */
export async function serveStatus(service: StatusService, path = statusSocket()) {
  if (!isAbsolute(path) || resolve(path) !== path || Buffer.byteLength(path) > 85) throw new Error('Invalid status socket path')
  const directory = dirname(path)
  await mkdir(directory, { mode: 0o700 }).catch(error => {
    if (error.code !== 'EEXIST') throw error
  })
  const parent = await lstat(directory)
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid!() ||
    (parent.mode & 0o777) !== 0o700 ||
    (await realpath(directory)) !== directory
  )
    throw new Error('Status socket requires a private, owned, non-symlink directory (0700)')
  const guard = `${path}.lock`
  await mkdir(guard, { mode: 0o700 })
  // Bun unconditionally unlinks its listen path on stop. Bind inside our own guard,
  // then publish a hard link atomically: cleanup must never delete a replaced operator path.
  const listenPath = `${guard}/s`
  const guardInode = (await lstat(guard)).ino
  let server: ReturnType<typeof Bun.serve> | undefined
  let inode: number | undefined
  let closing = false
  const removeSocket = async () => {
    const stat = await lstat(path).catch(error => {
      if (!missing(error)) throw error
    })
    if (stat?.isSocket() && stat.ino === inode) await unlink(path)
  }
  try {
    const exists = await lstat(path).catch(error => {
      if (!missing(error)) throw error
    })
    if (exists) throw new Error('Status socket already exists; inspect and remove it explicitly if stale')
    server = Bun.serve({
      unix: listenPath,
      maxRequestBodySize: 1,
      async fetch(request) {
        if (closing) return new Response(null, { status: 503 })
        const url = new URL(request.url)
        if (url.pathname !== '/status' || url.search) return new Response(null, { status: 404 })
        if (request.method !== 'GET' || request.headers.has('transfer-encoding') || Number(request.headers.get('content-length') ?? 0) !== 0)
          return new Response(null, { status: 405 })
        try {
          const status = await service.operator(BACKGROUND_CONTEXT)
          if (closing) return new Response(null, { status: 503 })
          const json = JSON.stringify(status)
          if (Buffer.byteLength(json) > maxStatusBytes) return new Response(null, { status: 503 })
          return new Response(json, { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
        } catch {
          return new Response(null, { status: 503 })
        }
      }
    })
    inode = (await lstat(listenPath)).ino
    await chmod(listenPath, 0o600)
    await link(listenPath, path)
    let closed: Promise<void> | undefined
    const removeGuard = async () => {
      const stat = await lstat(guard)
      if (stat.isDirectory() && stat.ino === guardInode) await rmdir(guard)
    }
    return {
      close() {
        return (closed ??= (async () => {
          closing = true
          await server!.stop(true)
          await removeSocket()
          await removeGuard()
        })())
      }
    }
  } catch (error) {
    await server?.stop(true)
    if (inode !== undefined) await removeSocket()
    await rmdir(guard)
    throw error
  }
}
