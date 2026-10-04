import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { APIError, Sandbox, type NetworkPolicy } from '@vercel/sandbox'
import type { SandboxProvider } from 'extensions/sandbox/providers'
import { VercelEnv } from 'extensions/sandbox/providers/vercel-env'

export class Vercel implements SandboxProvider {
  readonly name = 'vercel'
  readonly desktop = true
  readonly instructions =
    "The Vercel sandbox is Linux with Bun. Paths are remote; the working directory is /vercel/sandbox. ~ refers to the image's home directory (/vercel in the default image). File reads are limited to 16 MiB; use bash to select portions of larger files. Command output capture is limited to 128 MiB."

  constructor(private options: { image?: string; networkPolicy?: NetworkPolicy } = {}) {}

  async isConfigured() {
    return !!(await this.credentials())
  }

  private async credentials() {
    const file = Bun.file(join(process.env.SECRETS_DIR ?? './secrets', 'sandbox.json'))
    const saved: { token?: string; teamId?: string; projectId?: string } = (await file.exists()) ? await file.json() : {}
    const token = process.env.VERCEL_TOKEN || saved.token
    const teamId = process.env.VERCEL_TEAM_ID || saved.teamId
    const projectId = process.env.VERCEL_PROJECT_ID || saved.projectId
    return token && teamId && projectId ? { token, teamId, projectId } : undefined
  }

  async open(workspace: Parameters<SandboxProvider['open']>[0], ctx: Context) {
    const credentials = await this.credentials()
    if (!credentials)
      throw new Error(
        'Configure Vercel Sandbox with token, teamId, and projectId in secrets/sandbox.json, or VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID'
      )
    const base = { ...credentials, name: workspace.id, signal: ctx.abortSignal }
    const snapshotExpiration = (workspace.scope === 'identity' ? 365 : 90) * 24 * 60 * 60_000
    const retention = { snapshotExpiration, keepLastSnapshots: { count: 1, expiration: snapshotExpiration, deleteEvicted: true } }
    const sandbox = await Sandbox.get({ ...base, resume: true }).catch(async error => {
      if (error instanceof APIError && error.response.status === 410 && error.json?.error?.code === 'snapshot_not_found') {
        const expired = await Sandbox.get(base)
        await expired.delete({ deleteOrphanSnapshots: true, signal: ctx.abortSignal })
        throw new Error(
          'snapshot_not_found: Terminal condition. The saved filesystem is unavailable and the unusable sandbox has been retired. Call a sandbox tool again to recreate a fresh workspace from the configured image. Previous files and the browser profile cannot be restored; rebuild any required setup and inform the user.'
        )
      }
      if (!(error instanceof APIError) || error.response.status !== 404 || error.json?.error?.code !== 'not_found') throw error
      return Sandbox.create({
        ...base,
        image: this.options.image ?? process.env.SANDBOX_IMAGE ?? 'vcr.vercel.com/timid-clanker/sandboxes/clanker-sandbox:latest',
        persistent: true,
        ...retention,
        resources: { vcpus: 2 },
        networkPolicy: this.options.networkPolicy ?? 'allow-all',
        timeout: 20 * 60_000
      })
    })
    try {
      if (
        sandbox.snapshotExpiration !== snapshotExpiration ||
        sandbox.keepLastSnapshots?.expiration !== snapshotExpiration ||
        sandbox.keepLastSnapshots?.count !== 1 ||
        sandbox.keepLastSnapshots?.deleteEvicted !== true
      )
        await sandbox.update(retention, { signal: ctx.abortSignal })
      // Managed images keep tool configuration in their own HOME; do not replace it with our working directory.
      const home = await sandbox.runCommand({ cmd: 'printenv', args: ['HOME'], timeoutMs: 30_000, signal: ctx.abortSignal })
      if (home.exitCode !== 0) throw new Error('Sandbox image must define HOME')
      const env = new VercelEnv(sandbox, (await home.stdout({ signal: ctx.abortSignal })).trimEnd())
      await sandbox.fs.mkdir(env.cwd, { recursive: true, signal: ctx.abortSignal })
      // Leave time for a maximum-length command plus the idle window, even in a reused session.
      if (sandbox.expiresAt && sandbox.expiresAt.getTime() - Date.now() < 15 * 60_000) await sandbox.extendTimeout(20 * 60_000, { signal: ctx.abortSignal })
      return {
        env,
        stop: async (context: Context) => {
          try {
            await env.desktop.stop(context)
          } finally {
            await sandbox.stop({ signal: context.abortSignal ?? AbortSignal.timeout(8_000) })
          }
        }
      }
    } catch (error) {
      await sandbox.stop({ signal: AbortSignal.timeout(5_000) }).catch(stopError => console.error('[sandbox] Setup cleanup failed', stopError))
      throw error
    }
  }
}
