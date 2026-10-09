import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import type { Context } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import {
  ExecutionError,
  FileError,
  getOrThrow,
  type ExecutionEnv,
  type FileErrorCode,
  type FileInfo,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLine,
  type TextLineReader
} from '@earendil-works/pi-durable/env'
import type { Sandbox, Command } from '@vercel/sandbox'
import { VercelDesktop } from 'extensions/sandbox/providers/vercel-desktop'
import { cleanupScript, execHelperPath } from 'extensions/sandbox/providers/vercel-exec'

const codes: Record<string, FileErrorCode> = {
  ENOENT: 'not_found',
  EACCES: 'permission_denied',
  EPERM: 'permission_denied',
  ENOTDIR: 'not_directory',
  EISDIR: 'is_directory',
  EINVAL: 'invalid',
  ENOTSUP: 'not_supported'
}

export class VercelEnv implements ExecutionEnv {
  readonly id: string
  readonly desktop: VercelDesktop
  private active = new Map<string, { command?: Command; output: string; spilled: boolean }>()

  constructor(
    private sandbox: Sandbox,
    private home: string,
    readonly cwd = '/vercel/sandbox'
  ) {
    this.id = `vercel:${sandbox.name}`
    this.desktop = new VercelDesktop(sandbox)
  }

  private path(path: string) {
    return posix.resolve(this.cwd, path === '~' ? this.home : path.startsWith('~/') ? posix.join(this.home, path.slice(2)) : path)
  }

  private async file<T>(path: string, ctx: Context, operation: () => Promise<T> | T): Promise<Result<T, FileError>> {
    try {
      ctx.abortSignal?.throwIfAborted()
      return { ok: true, value: await operation() }
    } catch (cause) {
      if (cause instanceof FileError) return { ok: false, error: cause }
      const error = cause instanceof Error ? cause : new Error(String(cause))
      return {
        ok: false,
        error: new FileError(
          ctx.abortSignal?.aborted ? 'aborted' : (codes[(error as NodeJS.ErrnoException).code ?? ''] ?? 'unknown'),
          error.message,
          path,
          error
        )
      }
    }
  }

  private async command(cmd: string, args: string[], ctx: Context) {
    const result = await this.sandbox.runCommand({ cmd, args, signal: ctx.abortSignal, timeoutMs: 30_000 })
    if (result.exitCode !== 0) throw new Error(await result.stderr({ signal: ctx.abortSignal }))
    return (await result.stdout({ signal: ctx.abortSignal })).trimEnd()
  }

  absolutePath(path: string, ctx: Context) {
    return this.file(path, ctx, () => this.path(path))
  }
  joinPath(parts: string[], ctx: Context) {
    return this.file(parts.join('/'), ctx, () => posix.join(...parts))
  }
  readTextFile(path: string, ctx: Context) {
    return this.file(path, ctx, async () => new TextDecoder().decode(getOrThrow(await this.readBinaryFile(path, ctx))))
  }
  readBinaryFile(path: string, ctx: Context) {
    return this.file(path, ctx, async () => {
      const stream = (await this.sandbox.readFile({ path: this.path(path) }, { signal: ctx.abortSignal })) as Readable | null
      if (!stream) throw new FileError('not_found', 'File not found', path)
      const chunks: Buffer[] = []
      let size = 0
      try {
        for await (const chunk of stream) {
          size += chunk.length
          if (size > 16 * 1024 * 1024) throw new FileError('invalid', 'File exceeds the 16 MiB read limit; use bash to select a smaller portion', path)
          chunks.push(chunk)
        }
        return Buffer.concat(chunks, size)
      } finally {
        stream.destroy()
      }
    })
  }
  writeFile(path: string, content: string | Uint8Array, ctx: Context) {
    return this.file(path, ctx, () => this.sandbox.fs.writeFile(this.path(path), content, { signal: ctx.abortSignal }))
  }
  appendFile(path: string, content: string | Uint8Array, ctx: Context) {
    return this.file(path, ctx, () => this.sandbox.fs.appendFile(this.path(path), content, { signal: ctx.abortSignal }))
  }
  truncateFile(path: string, size: number, ctx: Context) {
    return this.file(path, ctx, () => this.sandbox.fs.truncate(this.path(path), size, { signal: ctx.abortSignal }))
  }
  flushFile(path: string, ctx: Context) {
    return this.file(path, ctx, async () => {
      await this.command('sync', ['-f', '--', this.path(path)], ctx)
    })
  }
  renameFile(source: string, destination: string, ctx: Context) {
    return this.file(source, ctx, () => this.sandbox.fs.rename(this.path(source), this.path(destination), { signal: ctx.abortSignal }))
  }
  canonicalPath(path: string, ctx: Context) {
    return this.file(path, ctx, () => this.sandbox.fs.realpath(this.path(path), { signal: ctx.abortSignal }))
  }
  exists(path: string, ctx: Context) {
    return this.file(path, ctx, () => this.sandbox.fs.exists(this.path(path), { signal: ctx.abortSignal }))
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, ctx: Context) {
    return this.file(path, ctx, async () => {
      await this.sandbox.fs.mkdir(this.path(path), { ...options, signal: ctx.abortSignal })
    })
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, ctx: Context) {
    return this.file(path, ctx, () => this.sandbox.fs.rm(this.path(path), { ...options, signal: ctx.abortSignal }))
  }
  createTempDir(prefix: string | undefined, ctx: Context) {
    return this.file('/tmp', ctx, () => this.sandbox.fs.mkdtemp(`/tmp/${posix.basename(prefix ?? 'clanker-')}`, { signal: ctx.abortSignal }))
  }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, ctx: Context) {
    return this.file('/tmp', ctx, () =>
      this.command('mktemp', [`--suffix=${posix.basename(options?.suffix ?? '')}`, `/tmp/${posix.basename(options?.prefix ?? 'clanker-')}XXXXXX`], ctx)
    )
  }

  fileInfo(path: string, ctx: Context): Promise<Result<FileInfo, FileError>> {
    return this.file(path, ctx, async () => {
      const absolute = this.path(path)
      const stat = await this.sandbox.fs.lstat(absolute, { signal: ctx.abortSignal })
      return {
        name: posix.basename(absolute),
        path: absolute,
        kind: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        mtimeMs: stat.mtimeMs
      }
    })
  }

  listDir(path: string, ctx: Context) {
    return this.file(path, ctx, async () => {
      const names = await this.sandbox.fs.readdir(this.path(path), { signal: ctx.abortSignal })
      return Promise.all(names.map(async name => getOrThrow(await this.fileInfo(posix.join(this.path(path), name), ctx))))
    })
  }

  openTextLineReader(path: string, ctx: Context): Promise<Result<TextLineReader, FileError>> {
    return this.file(path, ctx, async () => {
      const stream = (await this.sandbox.readFile({ path: this.path(path) }, { signal: ctx.abortSignal })) as Readable | null
      if (!stream) throw new FileError('not_found', 'File not found', path)
      async function* lines(): AsyncGenerator<TextLine> {
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          for await (const chunk of stream!) {
            buffer += decoder.decode(chunk, { stream: true })
            let end
            while ((end = buffer.indexOf('\n')) !== -1) {
              yield { text: buffer.slice(0, end).replace(/\r$/, ''), terminated: true }
              buffer = buffer.slice(end + 1)
            }
          }
          buffer += decoder.decode()
          if (buffer) yield { text: buffer, terminated: false }
        } finally {
          stream!.destroy()
        }
      }
      const reader = lines()
      return {
        readLine: (context: Context) =>
          this.file(path, context, async () => {
            const next = await reader.next()
            return next.done ? undefined : next.value
          }),
        close: async () => {
          stream.destroy()
          await reader.return(undefined)
        }
      }
    })
  }

  readTextLines(path: string, options: { maxLines?: number } | undefined, ctx: Context) {
    return this.file(path, ctx, async () => {
      const reader = getOrThrow(await this.openTextLineReader(path, ctx))
      const lines: string[] = []
      try {
        while (lines.length < (options?.maxLines ?? Infinity)) {
          const line = getOrThrow(await reader.readLine(ctx))
          if (!line) break
          lines.push(line.text)
        }
        return lines
      } finally {
        await reader.close(ctx)
      }
    })
  }

  // A separate process group allows cancellation to stop pipelines and child processes too.
  private async cleanupCommand(pidFile: string, state: { command?: Command; output: string; spilled: boolean }) {
    const signal = AbortSignal.timeout(5_000)
    try {
      // Cleanup must not depend on a /tmp helper the user command may have removed or changed.
      const cleaned = await this.sandbox.runCommand({
        cmd: '/bin/bash',
        args: ['-c', cleanupScript, 'cleanup', pidFile, state.output, state.spilled ? 'keep' : 'remove'],
        signal,
        timeoutMs: 5_000
      })
      if (cleaned.exitCode !== 0) throw new Error('Sandbox command cleanup failed')
    } finally {
      // A failed start may not have written the group PID yet. Native kill is a fallback,
      // not a replacement for killing the process group (including orphaned children).
      if (state.command && state.command.exitCode === null) await state.command.kill('SIGKILL', { abortSignal: AbortSignal.timeout(5_000) })
    }
    this.active.delete(pidFile)
  }

  async exec(command: string, options: ShellExecOptions = {}, ctx: Context): Promise<Result<ShellExecResult, ExecutionError>> {
    const timeoutMs = Math.min(options.timeout ?? 120, 600) * 1000
    const deadline = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([deadline, ...(ctx.abortSignal ? [ctx.abortSignal] : [])])
    const prefix = `/tmp/clanker-${crypto.randomUUID()}`
    const pidFile = `${prefix}.pid`,
      output = `${prefix}.log`
    let bytes = 0,
      newlines = 0,
      partial = false,
      callbackFailed = false
    const state = { output, spilled: false, command: undefined as Command | undefined }
    this.active.set(pidFile, state)
    try {
      signal.throwIfAborted()
      const args = ['/usr/bin/setsid', '/bin/bash', execHelperPath, pidFile, output, command]
      const env = options.env ?? {}
      const running = await this.sandbox.runCommand({
        cmd: options.inheritEnv === false ? '/usr/bin/env' : args[0]!,
        args: options.inheritEnv === false ? ['-i', ...Object.entries(env).map(([key, value]) => `${key}=${value}`), ...args] : args.slice(1),
        cwd: this.path(options.cwd ?? this.cwd),
        env,
        detached: true,
        timeoutMs,
        signal
      })
      state.command = running
      for await (const chunk of running.logs({ signal })) {
        bytes += Buffer.byteLength(chunk.data)
        newlines += chunk.data.match(/\n/g)?.length ?? 0
        if (chunk.data) partial = !chunk.data.endsWith('\n')
        state.spilled ||= !!options.spill && (bytes > options.spill.afterBytes || newlines + Number(partial) > options.spill.afterLines)
        try {
          options.onOutput?.(chunk.data, ctx)
        } catch (error) {
          callbackFailed = true
          throw error
        }
      }
      const finished = await running.wait({ signal })
      state.command = finished
      signal.throwIfAborted()
      return { ok: true, value: { exitCode: finished.exitCode, ...(state.spilled ? { spillPath: output } : {}) } }
    } catch (cause) {
      const error = new ExecutionError(
        ctx.abortSignal?.aborted ? 'aborted' : deadline.aborted ? 'timeout' : callbackFailed ? 'callback_error' : 'unknown',
        cause instanceof Error ? cause.message : String(cause)
      )
      if (state.spilled) error.spillPath = output
      return { ok: false, error }
    } finally {
      // Also reap background children after a successful shell exits.
      try {
        await this.cleanupCommand(pidFile, state)
      } catch (error) {
        console.error('[sandbox] Command cleanup failed', error)
      }
    }
  }

  async cleanup(_ctx: Context = BACKGROUND_CONTEXT) {
    for (const [pid, state] of this.active) await this.cleanupCommand(pid, state)
  }
}
