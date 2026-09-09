import { type Adapter } from 'chat'

export function registerAdapter<Name extends string, T extends Adapter>(adapterName: Name, envName: string, factory: () => T): Record<Name, T> | null {
  return process.env[envName] ? ({ [adapterName]: factory() } as Record<Name, T>) : null
}
