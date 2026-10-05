import { join } from 'node:path'
import type { Context } from '@earendil-works/chord'
import { APIError, Drive, Sandbox, type NetworkPolicy } from '@vercel/sandbox'
import type { SandboxProvider } from 'extensions/sandbox/providers'
import { VercelEnv } from 'extensions/sandbox/providers/vercel-env'

export class Vercel implements SandboxProvider {
  readonly name = 'vercel'
  readonly desktop = true
  readonly instructions = [
    "The Vercel sandbox is Linux with Bun. Paths are remote. ~ refers to the image's home directory (/vercel in the default image); leave HOME unchanged.",
    'Private workspaces have a dedicated 20 GiB persistent Drive at /data and use /data/workspace as their working directory. Shared workspaces have no Drive and use /vercel/sandbox.',
    '/data/workspace/: projects, downloads, and generated files.',
    '/data/config/: persistent user/tool configuration. Configure tools to use it or symlink individual configuration directories; recreate those symlinks after an image replacement.',
    '/data/browser/profile/: managed Chromium profile. The desktop manages this automatically; do not modify it while Chromium is running.',
    'Files under /data survive sandbox replacement and snapshot expiration; files elsewhere only persist with the sandbox snapshot. Keep installed system tools in the image and temporary files, sockets, process IDs, and desktop credentials under /tmp. Never put bot-host credentials on the Drive.',
    'File reads are limited to 16 MiB; use bash to select portions of larger files. Command output capture is limited to 128 MiB.'
  ].join('\n')

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
    const privateWorkspace = workspace.scope === 'identity'
    const driveName = `${workspace.id}-data`
    const snapshotExpiration = (workspace.scope === 'identity' ? 365 : 90) * 24 * 60 * 60_000
    const retention = { snapshotExpiration, keepLastSnapshots: { count: 1, expiration: snapshotExpiration, deleteEvicted: true } }
    const sandbox = await Sandbox.get({ ...base, resume: true }).catch(async error => {
      if (error instanceof APIError && error.response.status === 410 && error.json?.error?.code === 'snapshot_not_found') {
        const expired = await Sandbox.get(base)
        await expired.delete({ deleteOrphanSnapshots: true, signal: ctx.abortSignal })
        throw new Error(
          'snapshot_not_found: Terminal condition. The saved sandbox filesystem is unavailable and the unusable sandbox has been retired. Call a sandbox tool again to recreate it from the configured image. An existing private Drive is preserved and will be reattached at /data; inspect it before reporting data loss. Files outside the Drive cannot be restored; rebuild the required setup and inform the user.'
        )
      }
      if (!(error instanceof APIError) || error.response.status !== 404 || error.json?.error?.code !== 'not_found') throw error
      const drive = privateWorkspace
        ? await Drive.getOrCreate({ ...credentials, name: driveName, maxSize: 20 * 1024 ** 3, signal: ctx.abortSignal })
        : undefined
      return Sandbox.create({
        ...base,
        ...(drive ? { mounts: { '/data': drive }, region: drive.region } : {}),
        image: this.options.image ?? process.env.SANDBOX_IMAGE ?? 'vcr.vercel.com/timid-clanker/sandboxes/clanker-sandbox:latest',
        persistent: true,
        ...retention,
        resources: { vcpus: 2 },
        networkPolicy: this.options.networkPolicy ?? 'allow-all',
        timeout: 20 * 60_000
      })
    })
    try {
      if (privateWorkspace) {
        const mount = sandbox.mounts?.['/data']
        if (mount?.drive !== driveName || mount.mode !== 'read-write') throw new Error('Private workspace /data must mount its own writable Drive')
        const prepared = await sandbox.runCommand({
          cmd: 'bun',
          args: [
            '-e',
            `
            import { mkdir, symlink } from 'node:fs/promises'
            for (const path of ['/data/workspace', '/data/config', '/data/browser/profile', '/vercel/desktop']) await mkdir(path, { recursive: true })
            await symlink('/data/browser/profile', '/vercel/desktop/profile').catch(error => { if (error.code !== 'EEXIST') throw error })
          `
          ],
          timeoutMs: 120_000,
          signal: ctx.abortSignal
        })
        if (prepared.exitCode !== 0) throw new Error(await prepared.stderr({ signal: ctx.abortSignal }))
      }
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
      const env = new VercelEnv(sandbox, (await home.stdout({ signal: ctx.abortSignal })).trimEnd(), privateWorkspace ? '/data/workspace' : '/vercel/sandbox')
      await sandbox.fs.mkdir(env.cwd, { recursive: true, signal: ctx.abortSignal })
      // Leave time for a maximum-length command plus the idle window, even in a reused session.
      if (sandbox.expiresAt && sandbox.expiresAt.getTime() - Date.now() < 15 * 60_000) await sandbox.extendTimeout(20 * 60_000, { signal: ctx.abortSignal })
      return {
        env,
        stop: async (context: Context) => {
          try {
            await env.desktop.stop(context)
          } finally {
            await sandbox.stop({ signal: context.abortSignal ?? AbortSignal.timeout(30_000) })
          }
        }
      }
    } catch (error) {
      await sandbox.stop({ signal: AbortSignal.timeout(5_000) }).catch(stopError => console.error('[sandbox] Setup cleanup failed', stopError))
      throw error
    }
  }
}
