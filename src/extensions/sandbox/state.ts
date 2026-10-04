import { defineDoc } from '@earendil-works/pi-durable'

export type SandboxOwner = { kind: 'identity' | 'conversation'; id: string; aliases?: string[] }
export const ownerKey = (owner: SandboxOwner) => `${owner.kind}:${owner.id}`

export const Workspaces = defineDoc<Record<string, { id: string; provider: string; established: boolean }>>({
  kind: 'sandbox.workspaces',
  version: 1,
  scope: 'session',
  initial: () => ({})
})
