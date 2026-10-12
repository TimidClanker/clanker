import type { Context } from '@earendil-works/chord'
import { FileError, type FileInfo, type LineScan } from '@earendil-works/pi-durable/env'
import type { Command, Sandbox } from '@vercel/sandbox'

// One process/descriptor per reader, never a VM-global service. Both programs are embedded for dist builds.
// No provider credentials reach the helper. The random private Unix socket is only reachable inside this VM.
const helper = String.raw`
const { open, opendir, lstat, chmod, rm, writeFile } = await import('node:fs/promises');
const { constants } = await import('node:fs');
const { createServer } = await import('node:net');
const { basename, join } = await import('node:path');
const { createHmac, timingSafeEqual } = await import('node:crypto');
const sign = text => createHmac('sha256', token).update(text).digest('hex');
const [root, kind, path, noFollow] = process.argv.slice(1);
const token = crypto.randomUUID();
await writeFile(root + '/token', token, { mode: 0o600, flag: 'wx' });
let handle, directory, failure, busy = false, returned = 0, scanned = 0, visited = 0;
const info = (stat, path) => ({ name: basename(path), path, kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', size: stat.size, mtimeMs: stat.mtimeMs });
const fail = (code, message) => Object.assign(new Error(message), { code });
try {
  if (kind === 'file') {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (noFollow === 'yes' ? constants.O_NOFOLLOW : 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw fail(stat.isDirectory() ? 'EISDIR' : 'EINVAL', 'Not a regular file');
  } else { directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NONBLOCK); handle = await opendir('/proc/self/fd/' + directory.fd); }
} catch (error) { failure = { code: error.code, message: error.message }; }
// Same line/UTF-8/BOM semantics as BinaryReader.scanLines; never accumulates file or line contents.
async function scan(startLine, endLine = Infinity, maxBytes = 16777216) {
  const budget = Math.min(16777216 - scanned, maxBytes);
  if ((await handle.stat()).size > budget) throw fail('EINVAL', 'File scan exceeds the 16 MiB budget; use bash to select a portion');
  if (!Number.isSafeInteger(startLine) || startLine < 0 || !(endLine > startLine) || (endLine !== Infinity && !Number.isSafeInteger(endLine))) throw fail('EINVAL', 'Invalid line range');
  const buffer = Buffer.alloc(65536);
  let bom = false;
  const selection = new TextDecoder('utf-8', { ignoreBOM: true }), first = new TextDecoder('utf-8', { ignoreBOM: true });
  let position = 0, newlines = 0, start, end, firstLineEnd, lastLineStart = 0, selectedBytes = 0, firstLineBytes = 0;
  const count = (bytes) => {
    if (newlines < startLine || newlines >= endLine) return;
    selectedBytes += Buffer.byteLength(selection.decode(bytes, { stream: true }));
    if (newlines === startLine && firstLineEnd === undefined) firstLineBytes += Buffer.byteLength(first.decode(bytes, { stream: true }));
  };
  if (startLine === 0) start = 0;
  for (;;) {
    // At the exact budget boundary, stat the opened descriptor instead of reading an out-of-budget probe.
    if (position === budget) {
      if ((await handle.stat()).size > position) throw fail('EINVAL', 'File grew beyond the 16 MiB scan budget');
      break;
    }
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, budget - position), position);
    if (!bytesRead) break;
    const chunk = buffer.subarray(0, bytesRead);
    if (position === 0) bom = bytesRead >= 3 && chunk[0] === 239 && chunk[1] === 187 && chunk[2] === 191;
    scanned += bytesRead;
    let from = bom && position === 0 ? 3 : 0;
    for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) {
      count(chunk.subarray(from, i));
      if (newlines === startLine) { firstLineEnd = position + i; firstLineBytes += Buffer.byteLength(first.decode()); }
      if (newlines === endLine - 1) { end = position + i; selectedBytes += Buffer.byteLength(selection.decode()); }
      else count(chunk.subarray(i, i + 1));
      newlines++; from = i + 1;
      if (newlines === startLine) start = position + from;
      if (newlines < endLine) lastLineStart = position + from;
    }
    count(chunk.subarray(from)); position += bytesRead;
  }
  if (start === undefined) return { newlines, start: position, end: position, firstLineEnd: position, lastLineStart: position, selectedBytes: 0, firstLineBytes: 0 };
  if (firstLineEnd === undefined) { firstLineEnd = position; firstLineBytes += Buffer.byteLength(first.decode()); }
  if (end === undefined) { end = position; selectedBytes += Buffer.byteLength(selection.decode()); }
  return { newlines, start, end, firstLineEnd, lastLineStart, selectedBytes, firstLineBytes };
}
async function operation(request) {
  if (failure) return { error: failure };
  if (request.op === 'init') return {};
  if (request.op === 'info') return info(await handle.stat(), path);
  if (request.op === 'read') {
    const { offset, length } = request;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > 16777216 || !Number.isSafeInteger(offset + length)) throw fail('EINVAL', 'Invalid read range (maximum 16 MiB)');
    const size = Math.min(length, Math.max(0, (await handle.stat()).size - offset));
    if (size > 16777216 - returned) throw fail('EINVAL', 'Reader payload exceeds the cumulative 16 MiB budget');
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, offset + read);
      if (!bytesRead) break;
      read += bytesRead;
    }
    returned += read;
    return buffer.subarray(0, read).toString('base64');
  }
  if (request.op === 'scan') { const before = scanned; const value = await scan(request.startLine, request.endLine, request.maxBytes); return { value, bytes: scanned - before }; }
  if (request.op === 'next') {
    if (!Number.isSafeInteger(request.maxEntries) || request.maxEntries < 1 || request.maxEntries > 1024) throw fail('EINVAL', 'Directory page must contain 1–1024 entries');
    const entries = [];
    let pageBytes = 32;
    while (entries.length < request.maxEntries) {
      const entry = await handle.read();
      if (!entry) return { entries, done: true };
      if (visited >= 65536) throw fail('EINVAL', 'Directory enumeration exceeds 65536 entries');
      visited++;
      const entryPath = join(path, entry.name);
      try {
        const stat = await lstat('/proc/self/fd/' + directory.fd + '/' + entry.name);
        if (stat.isFile() || stat.isDirectory() || stat.isSymbolicLink()) {
          const value = info(stat, entryPath);
          pageBytes += Buffer.byteLength(JSON.stringify(value)) + 1;
          if (pageBytes > 23000000 - 65) throw fail('EINVAL', 'Directory page exceeds response budget');
          entries.push(value);
        }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { entries, done: false };
  }
  throw fail('EINVAL', 'Unknown operation');
}
let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => { server.close(); await handle?.close().catch(() => {}); await directory?.close().catch(() => {}); await rm(root, { recursive: true, force: true }); process.exit(); })();
  return stopping;
}
const server = createServer(socket => {
  let text = '';
  socket.setTimeout(30000, () => socket.destroy());
  socket.on('error', () => {});
  socket.on('data', async chunk => {
    if (chunk.length > 4096 - Buffer.byteLength(text)) { socket.destroy(); return; }
    text += chunk.toString();
    if (!text.endsWith('\n')) return;
    socket.pause();
    let request;
    try { request = JSON.parse(text); } catch { socket.destroy(); return; }
    if (!request || typeof request !== 'object' || Array.isArray(request)) { socket.destroy(); return; }
    const { nonce, json, mac } = request;
    if (typeof nonce !== 'string' || typeof json !== 'string' || typeof mac !== 'string' || mac.length !== 64 || !/^[a-f0-9]+$/.test(mac) || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(sign(nonce + '\n' + json), 'hex')) || busy) { socket.destroy(); return; }
    try { request = JSON.parse(json); } catch { socket.destroy(); return; }
    busy = true;
    let response;
    try { response = await operation(request); } catch (error) { response = { error: { code: error.code, message: error.message } }; }
    busy = false;
    const jsonResponse = JSON.stringify(response);
    if (Buffer.byteLength(jsonResponse) > 23000000 - 65) { socket.destroy(); return; }
    socket.end(sign(nonce + '\n' + jsonResponse) + '\n' + jsonResponse);
  });
});
server.maxConnections = 1;
server.listen(root + '/socket', () => void chmod(root + '/socket', 0o600));
setTimeout(() => void stop(), 600000);
process.on('SIGTERM', () => void stop());
`

const client = String.raw`
const { createConnection } = await import('node:net');
const { open } = await import('node:fs/promises');
const { constants } = await import('node:fs');
const { createHmac, timingSafeEqual } = await import('node:crypto');
const [root, json, pidName] = process.argv.slice(1);
const { rmSync } = await import('node:fs');
process.on('exit', () => { try { rmSync(root + '/' + pidName, { force: true }); } catch {} });
let key;
for (let i = 0; ; i++) {
  try { key = await open(root + '/token', constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); break; }
  catch (error) { if (i >= (JSON.parse(json).op === 'init' ? 100 : 0) || error.code !== 'ENOENT') throw new Error('Reader capability unavailable'); await Bun.sleep(20); }
}
let token;
try {
  let stat = await key.stat();
  for (let i = 0; JSON.parse(json).op === 'init' && stat.isFile() && stat.size === 0 && i < 100; i++) { await Bun.sleep(20); stat = await key.stat(); }
  if (!stat.isFile() || stat.size !== 36) throw new Error('Invalid reader capability');
  const buffer = Buffer.alloc(36); const read = await key.read(buffer, 0, 36, 0);
  token = buffer.toString();
  if (read.bytesRead !== 36 || !/^[a-f0-9-]{36}$/.test(token)) throw new Error('Invalid reader capability');
} finally { await key.close(); }
const sign = text => createHmac('sha256', token).update(text).digest('hex');
const nonce = crypto.randomUUID();
const request = JSON.stringify({ nonce, json, mac: sign(nonce + '\n' + json) });
if (Buffer.byteLength(request) > 4096) throw new Error('Reader request exceeds limit');
let socket;
for (let i = 0; ; i++) {
  try {
    socket = await new Promise((resolve, reject) => {
      const connection = createConnection(root + '/socket');
      connection.once('connect', () => { connection.removeListener('error', reject); resolve(connection); });
      connection.once('error', reject);
    });
    break;
  } catch (error) { if (i >= (JSON.parse(json).op === 'init' ? 100 : 0) || !['ENOENT','ECONNREFUSED'].includes(error.code)) throw new Error('Reader connection unavailable'); await Bun.sleep(20); }
}
// Retry only connecting before the initial request, never an operation. No unauthenticated data reaches SDK stdout.
let size = 0, chunks = [];
const die = () => { console.error('Invalid or unavailable reader response'); process.exit(1); };
socket.setTimeout(30000, () => socket.destroy(new Error('Reader request timed out')));
socket.on('error', die);
socket.on('data', chunk => {
  if (chunk.length > 23000000 - size) { socket.destroy(new Error('Reader response exceeds limit')); return; }
  if (chunks.length >= 65536) { socket.destroy(new Error('Reader response has too many chunks')); return; }
  size += chunk.length; chunks.push(chunk);
});
socket.on('end', () => {
  const buffer = Buffer.concat(chunks, size); chunks = [];
  if (size < 65 || buffer[64] !== 10) return die();
  const mac = buffer.subarray(0, 64).toString();
  const jsonResponse = buffer.subarray(65).toString();
  if (!/^[a-f0-9]{64}$/.test(mac) || !timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(sign(nonce + '\n' + jsonResponse), 'hex'))) return die();
  process.stdout.write(jsonResponse);
});
socket.write(request + '\n');
`

// Numeric PID files are not authority: a stale PID must still belong to this invocation's process group.
const cleanup = String.raw`
const { open, opendir, rm } = await import('node:fs/promises');
const { constants } = await import('node:fs');
const [root, owner] = process.argv.slice(1);
async function bounded(path, max) {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try { if (!(await file.stat()).isFile()) return ''; const buffer = Buffer.alloc(max + 1); const read = await file.read(buffer, 0, buffer.length, 0); return read.bytesRead <= max ? buffer.subarray(0, read.bytesRead).toString() : ''; }
  finally { await file.close(); }
}
const names = [];
const directory = await opendir(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (directory) {
  for await (const entry of directory) { if (names.length >= 1024) throw new Error('Reader cleanup directory exceeds limit'); names.push(entry.name); }
}
for (const name of names) {
  if (name !== 'pid' && !/^client-[a-f0-9-]+$/.test(name)) continue;
  const text = await bounded(root + '/' + name, 32).catch(() => '');
  if (!/^[1-9][0-9]*\n$/.test(text)) continue;
  const pid = Number(text);
  const environment = await bounded('/proc/' + pid + '/environ', 65536).catch(() => '');
  if (!environment.split('\0').includes('CLANKER_READER_ID=' + owner)) continue;
  // Every launched helper/client is its own process-group leader; never kill some other group.
  const stat = await bounded('/proc/' + pid + '/stat', 4096).catch(() => '');
  if (Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) !== pid) continue;
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}
await rm(root, { recursive: true, force: true });
`
const launch =
  'bun=$(command -v bun) || exit 1; echo $$ > "$1/$3" || exit 1; owner=$2; shift 3; exec /usr/bin/env -i HOME="$HOME" PATH="$PATH" CLANKER_READER_ID="$owner" "$bun" "$@"'
const cleanLaunch = 'bun=$(command -v bun) || exit 1; exec /usr/bin/env -i HOME="$HOME" PATH="$PATH" "$bun" "$@"'

const codes: Record<string, ConstructorParameters<typeof FileError>[0]> = {
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  EISDIR: 'is_directory',
  ENOTDIR: 'not_directory',
  EINVAL: 'invalid',
  ELOOP: 'invalid',
  EMLINK: 'invalid',
  ENAMETOOLONG: 'invalid'
}

type Request = {
  op: 'init' | 'info' | 'read' | 'scan' | 'next'
  offset?: number
  length?: number
  startLine?: number
  endLine?: number
  maxEntries?: number
  maxBytes?: number
}
const responseLimit = (request: Request) =>
  request.op === 'read'
    ? Math.max(64000, Math.ceil((request.length ?? 0) / 3) * 4 + 2)
    : request.op === 'next'
      ? Math.min(23_000_000, 64000 + (request.maxEntries ?? 0) * 30000)
      : 64000
function parseResponse(text: string, request: Request) {
  const invalid = () => new FileError('invalid', 'Invalid reader response')
  if (
    (request.op === 'read' && text[0] === '{' && Buffer.byteLength(text) > 64000) ||
    Buffer.byteLength(text) > responseLimit(request) ||
    (text[0] !== '{' && !(request.op === 'read' && text[0] === '"'))
  )
    throw invalid()
  // Reject deep/large container structures before JSON allocates them; content strings have their own byte cap.
  let depth = 0,
    tokens = 0,
    quoted = false,
    escaped = false
  const maxTokens = request.op === 'next' ? (request.maxEntries ?? 0) * 20 + 100 : 100
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (quoted) {
      if (escaped) escaped = false
      else if (code === 92) escaped = true
      else if (code === 34) quoted = false
      continue
    }
    if (code === 34) {
      quoted = true
      continue
    }
    if (code === 123 || code === 91) depth++
    if (code === 125 || code === 93) depth--
    if (depth > 4 || depth < 0) throw invalid()
    if ((code === 123 || code === 125 || code === 91 || code === 93 || code === 44 || code === 58) && ++tokens > maxTokens) throw invalid()
  }
  const value = JSON.parse(text)
  if (value?.error) {
    if (
      typeof value.error.message !== 'string' ||
      Buffer.byteLength(value.error.message) > 8192 ||
      (value.error.code !== undefined && (typeof value.error.code !== 'string' || value.error.code.length > 64))
    )
      throw invalid()
    throw new FileError(codes[value.error.code] ?? 'unknown', value.error.message)
  }
  const info = (entry: FileInfo) =>
    !!entry &&
    typeof entry.name === 'string' &&
    Buffer.byteLength(entry.name) <= 255 &&
    typeof entry.path === 'string' &&
    Buffer.byteLength(entry.path) <= 4352 &&
    ['file', 'directory', 'symlink'].includes(entry.kind) &&
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0 &&
    typeof entry.mtimeMs === 'number' &&
    Number.isFinite(entry.mtimeMs)
  if (
    request.op === 'read' &&
    (typeof value !== 'string' ||
      value.length > Math.ceil((request.length ?? 0) / 3) * 4 ||
      value.length % 4 !== 0 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(value) ||
      (value.length / 4) * 3 - (value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0) > (request.length ?? 0))
  )
    throw invalid()
  if (request.op === 'info' && !info(value)) throw invalid()
  if (request.op === 'init' && (!value || typeof value !== 'object' || Object.keys(value).length)) throw invalid()
  if (
    request.op === 'next' &&
    (!value ||
      typeof value.done !== 'boolean' ||
      !Array.isArray(value.entries) ||
      value.entries.length > (request.maxEntries ?? 0) ||
      !value.entries.every(info))
  )
    throw invalid()
  if (
    request.op === 'scan' &&
    (!value ||
      !Number.isSafeInteger(value.bytes) ||
      value.bytes < 0 ||
      value.bytes > (request.maxBytes ?? 0) ||
      !value.value ||
      !['newlines', 'start', 'end', 'firstLineEnd', 'lastLineStart', 'selectedBytes', 'firstLineBytes'].every(
        key => Number.isSafeInteger(value.value[key]) && value.value[key] >= 0 && value.value[key] <= 3 * 16777216
      ))
  )
    throw invalid()
  return value
}

export class VercelReaders {
  private tail: Promise<unknown> = Promise.resolve()
  private responseBudget = 23_000_000
  private requests = 0
  private returnedBudget = 16 * 1024 * 1024
  private scanBudget = 16 * 1024 * 1024
  private handles = new Set<{ close(): Promise<void> }>()
  constructor(private sandbox: Sandbox) {}

  async open(path: string, kind: 'file' | 'directory', noFollow: boolean, ctx: Context) {
    ctx.abortSignal?.throwIfAborted()
    if (Buffer.byteLength(path) > 4096) throw new FileError('invalid', 'Reader path exceeds 4096 bytes')
    if (this.handles.size >= 16) throw new FileError('invalid', 'Too many opened readers (maximum 16)', path)
    const owner = crypto.randomUUID()
    const clients = new Set<Command>()
    let root: string | undefined, command: Command | undefined
    let closed = false,
      closing: Promise<void> | undefined
    const close = () =>
      (closing ??= (async () => {
        closed = true
        // Fixed host cleanup works even if start acknowledgment or helper files were lost.
        try {
          if (root) {
            const result = await this.sandbox.runCommand({
              cmd: '/bin/bash',
              args: ['-c', cleanLaunch, 'reader-cleanup', '-e', cleanup, root, owner],
              signal: AbortSignal.timeout(5000),
              timeoutMs: 5000
            })
            if (result.exitCode !== 0) throw new Error('Reader cleanup failed')
          }
        } finally {
          await Promise.all(
            [...clients, ...(command ? [command] : [])]
              .filter(command => command.exitCode === null)
              .map(async command => {
                const signal = AbortSignal.timeout(5000)
                await command.kill('SIGKILL', { abortSignal: signal })
                await command.wait({ signal })
              })
          )
        }
        this.handles.delete(handle)
      })().catch(error => {
        closing = undefined
        throw error
      }))
    const handle = { close }
    this.handles.add(handle)
    const call = <T>(request: Request, context: Context): Promise<T> => {
      const result = this.tail.then(async () => {
        if (closed) throw new FileError('invalid', 'Reader is closed', path)
        context.abortSignal?.throwIfAborted()
        if (++this.requests > 1024) throw new FileError('invalid', 'Reader tool exceeds 1024 requests', path)
        if (request.op === 'scan') {
          request = { ...request, maxBytes: this.scanBudget }
          this.scanBudget = 0
        }
        const signal = AbortSignal.any([AbortSignal.timeout(30000), ...(context.abortSignal ? [context.abortSignal] : [])])
        let running: Command | undefined,
          completed = false
        const pidName = `client-${crypto.randomUUID()}`
        try {
          running = await this.sandbox.runCommand({
            cmd: '/usr/bin/setsid',
            args: ['/bin/bash', '-c', launch, 'reader-client', root!, owner, pidName, '-e', client, root!, JSON.stringify(request), pidName],
            detached: true,
            signal,
            timeoutMs: 30000
          })
          clients.add(running)
          const chunks: string[] = []
          let size = 0
          for await (const chunk of running.logs({ signal })) {
            const bytes = Buffer.byteLength(chunk.data)
            if (bytes > responseLimit(request) - size || bytes > this.responseBudget || chunks.length >= 65536)
              throw new FileError('invalid', 'Reader SDK response exceeds limit', path)
            size += bytes
            this.responseBudget -= bytes
            if (chunk.stream === 'stdout') chunks.push(chunk.data) // Never reflect unauthenticated stderr bytes.
          }
          const finished = await running.wait({ signal })
          completed = true
          clients.delete(running)
          if (finished.exitCode !== 0) throw new FileError('unknown', 'Reader request failed', path)
          const text = chunks.join('')
          const value = parseResponse(text, request)
          if (request.op === 'scan') this.scanBudget += request.maxBytes! - value.bytes
          context.abortSignal?.throwIfAborted()
          return value
        } finally {
          if (running) {
            if (!completed) {
              const signal = AbortSignal.timeout(5000)
              await running.kill('SIGKILL', { abortSignal: signal })
              await running.wait({ signal })
            }
            clients.delete(running)
          }
        }
      })
      this.tail = result.catch(() => {})
      return result.catch(async error => {
        await close()
        throw error
      })
    }
    try {
      root = await this.sandbox.fs.mkdtemp('/tmp/clanker-reader-', { signal: ctx.abortSignal })
      await this.sandbox.fs.chmod(root, 0o700, { signal: ctx.abortSignal })
      command = await this.sandbox.runCommand({
        cmd: '/usr/bin/setsid',
        args: ['/bin/bash', '-c', launch, 'reader', root, owner, 'pid', '-e', helper, root, kind, path, noFollow ? 'yes' : 'no'],
        detached: true,
        signal: ctx.abortSignal,
        timeoutMs: 600000
      })
      await call({ op: 'init' }, ctx)
      return {
        binary: {
          info: (context: Context) => call<FileInfo>({ op: 'info' }, context),
          read: async (offset: number, length: number, context: Context) => {
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(length) ||
              length < 0 ||
              !Number.isSafeInteger(offset + length) ||
              length > this.returnedBudget
            )
              throw new FileError('invalid', 'Read exceeds the 16 MiB tool payload budget or has an invalid range', path)
            this.returnedBudget -= length // Reserve before allocating, including concurrent readers.
            const data = Buffer.from(await call<string>({ op: 'read', offset, length }, context), 'base64')
            this.returnedBudget += length - data.length
            return data
          },
          scanLines: async (options: { startLine: number; endLine?: number }, context: Context) => {
            const scan = await call<{ value: LineScan; bytes: number }>({ op: 'scan', ...options }, context)
            return scan.value
          }
        },
        next: (maxEntries: number, context: Context) => {
          if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 1024)
            throw new FileError('invalid', 'Directory page must contain 1–1024 entries', path)
          return call<{ entries: FileInfo[]; done: boolean }>({ op: 'next', maxEntries }, context)
        },
        close
      }
    } catch (error) {
      await close()
      throw error
    }
  }
  async cleanup() {
    const results = await Promise.allSettled([...this.handles].map(handle => handle.close()))
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, `Reader cleanup failed: ${errors.map(String).join('; ')}`)
  }
}
