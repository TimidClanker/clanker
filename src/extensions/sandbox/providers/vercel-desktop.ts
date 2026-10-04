import type { Context } from '@earendil-works/chord'
import type { Sandbox } from '@vercel/sandbox'

const directory = '/tmp/clanker-desktop-runtime'
const statePath = `${directory}/session.json`
type DesktopState = { sessionId: string; commandId: string; viewPassword: string; controlPassword: string }

/** Credentials and command identity live with the sandbox so a host restart can reconnect. */
export class VercelDesktop {
  constructor(private sandbox: Sandbox) {}

  private async current(ctx: Context) {
    const options = { signal: ctx.abortSignal }
    if (!(await this.sandbox.fs.exists(statePath, options))) return
    const state: DesktopState = JSON.parse(await this.sandbox.fs.readFile(statePath, { ...options, encoding: 'utf8' }))
    if (state.sessionId !== this.sandbox.currentSession().sessionId) return
    const command = await this.sandbox.getCommand(state.commandId, options)
    if (command.exitCode === null) return { state, command }
  }

  async open(control: boolean, ctx: Context) {
    const options = { signal: ctx.abortSignal }
    let current = await this.current(ctx)
    if (!current) {
      if (!(await this.sandbox.fs.exists('/usr/local/bin/sandbox-desktop', options))) {
        throw new Error('This workspace image has no browser desktop. The browser image applies to new workspaces; this existing workspace has been preserved.')
      }
      const ports = this.sandbox.routes.map(route => route.port)
      if (!ports.includes(6080)) await this.sandbox.update({ ports: [...ports, 6080] }, options)
      // A restored VM has a new hostname; Chromium otherwise treats its saved lock as another live computer.
      const prepared = await this.sandbox.runCommand({
        cmd: 'bun',
        args: [
          '-e',
          `
          import { readlink, rm } from 'node:fs/promises'
          import { hostname } from 'node:os'
          const profile = '/vercel/desktop/profile'
          const lock = await readlink(profile + '/SingletonLock').catch(error => { if (error.code !== 'ENOENT') throw error })
          if (lock && !lock.startsWith(hostname() + '-')) {
            await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket'].map(name => rm(profile + '/' + name, { force: true })))
          }
        `
        ],
        timeoutMs: 10_000,
        ...options
      })
      if (prepared.exitCode !== 0) throw new Error(await prepared.stderr(options))
      const password = () => Buffer.from(crypto.getRandomValues(new Uint8Array(6))).toString('base64')
      const viewPassword = password()
      let controlPassword = password()
      while (controlPassword === viewPassword) controlPassword = password()
      const command = await this.sandbox.runCommand({
        cmd: 'sandbox-desktop',
        env: { DESKTOP_VIEW_PASSWORD: viewPassword, DESKTOP_CONTROL_PASSWORD: controlPassword },
        detached: true,
        timeoutMs: 5 * 60 * 60_000,
        ...options
      })
      const state = { sessionId: this.sandbox.currentSession().sessionId, commandId: command.cmdId, viewPassword, controlPassword }
      try {
        await this.sandbox.fs.mkdir(directory, { recursive: true, ...options })
        await this.sandbox.fs.chmod(directory, 0o700, options)
        await this.sandbox.fs.writeFile(statePath, JSON.stringify(state), options)
        const ready = await this.sandbox.runCommand({
          cmd: 'bun',
          args: [
            '-e',
            `
            for (let attempt = 0; attempt < 100; attempt++) {
              try {
                const responses = await Promise.all([
                  fetch('http://127.0.0.1:6080/vnc.html', { signal: AbortSignal.timeout(1000) }),
                  fetch('http://127.0.0.1:9222/json/version', { signal: AbortSignal.timeout(1000) })
                ])
                if (responses.every(response => response.ok)) process.exit(0)
              } catch {}
              await Bun.sleep(200)
            }
            process.exit(1)
          `
          ],
          timeoutMs: 30_000,
          ...options
        })
        if (ready.exitCode !== 0) throw new Error('Desktop did not start. Inspect /vercel/desktop/logs with bash or read.')
        if ((await this.sandbox.getCommand(command.cmdId, options)).exitCode !== null) throw new Error('Desktop launcher exited; inspect /vercel/desktop/logs.')
      } catch (error) {
        const signal = AbortSignal.timeout(8_000)
        await command.kill('SIGTERM', { abortSignal: signal })
        await command.wait({ signal })
        await this.sandbox.fs.rm(statePath, { force: true, signal })
        throw error
      }
      current = { state, command }
    }
    const password = control ? current.state.controlPassword : current.state.viewPassword
    return `${this.sandbox.domain(6080)}/vnc.html?autoconnect=true&resize=scale&view_only=${!control}#password=${encodeURIComponent(password)}`
  }

  async stop(ctx: Context) {
    const signal = AbortSignal.any([AbortSignal.timeout(30_000), ...(ctx.abortSignal ? [ctx.abortSignal] : [])])
    const current = await this.current(ctx)
    if (current) {
      // Close Chromium before its display so it can flush the profile and release its locks.
      const closed = await this.sandbox.runCommand({
        cmd: 'bun',
        args: [
          '-e',
          `
          setTimeout(() => process.exit(1), 5000)
          const { webSocketDebuggerUrl } = await (await fetch('http://127.0.0.1:9222/json/version')).json()
          const socket = new WebSocket(webSocketDebuggerUrl)
          socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' }))
          socket.onclose = () => process.exit(0)
          socket.onerror = () => process.exit(1)
        `
        ],
        timeoutMs: 8_000,
        signal
      })
      if (closed.exitCode !== 0) await current.command.kill('SIGTERM', { abortSignal: signal })
      await current.command.wait({ signal })
    }
    await this.sandbox.fs.rm(statePath, { force: true, signal })
  }
}
