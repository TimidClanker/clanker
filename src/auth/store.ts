import { chmod, mkdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { builtinModels } from '@earendil-works/pi-ai/providers/all'
import type { AuthOperationOptions, Credential, CredentialStore } from '@earendil-works/pi-ai'

export class FileCredentials implements CredentialStore {
  readonly directory = resolve(process.env.SECRETS_DIR ?? './secrets')
  readonly path = resolve(this.directory, 'auth.json')

  private async load(): Promise<Record<string, Credential>> {
    try {
      return await Bun.file(this.path).json()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  async read(providerId: string, options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted()
    return (await this.load())[providerId]
  }

  async list(options?: AuthOperationOptions) {
    options?.signal?.throwIfAborted()
    return Object.entries(await this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }))
  }

  // Hold the lock across Pi's refresh callback, including its network request.
  private async update<T>(fn: (credentials: Record<string, Credential>) => Promise<T>, options?: AuthOperationOptions) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await chmod(this.directory, 0o700)
    const lock = `${this.path}.lock`
    const deadline = Date.now() + 60_000
    while (true) {
      options?.signal?.throwIfAborted()
      try {
        await mkdir(lock, { mode: 0o700 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline) {
          throw new Error(`Credential store is locked: ${lock}. If a process crashed, stop the bot and login commands, then remove this lock directory.`)
        }
        await Bun.sleep(100)
      }
    }
    const temporary = `${this.path}.${crypto.randomUUID()}.tmp`
    try {
      options?.signal?.throwIfAborted()
      const credentials = await this.load()
      const result = await fn(credentials)
      options?.signal?.throwIfAborted()
      await writeFile(temporary, JSON.stringify(credentials, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
      await rename(temporary, this.path)
      return result
    } finally {
      try {
        await unlink(temporary)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      } finally {
        await rmdir(lock)
      }
    }
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions) {
    return this.update(async credentials => {
      const next = await fn(credentials[providerId])
      if (next !== undefined) credentials[providerId] = next
      return credentials[providerId]
    }, options)
  }

  delete(providerId: string, options?: AuthOperationOptions) {
    return this.update(async credentials => {
      delete credentials[providerId]
    }, options)
  }

  // Sign in with ChatGPT needs a stable installation ID across logins.
  getDeviceId = () => {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const path = resolve(this.directory, 'device-id')
    try {
      writeFileSync(path, crypto.randomUUID(), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return readFileSync(path, 'utf8').trim()
  }
}

export const credentials = new FileCredentials()
export const models = builtinModels({ credentials })
