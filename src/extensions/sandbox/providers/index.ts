import type { Context } from '@earendil-works/chord'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'

export type SandboxEnv = ExecutionEnv & {
  desktop?: {
    open(control: boolean, ctx: Context): Promise<string>
    stop(ctx: Context): Promise<void>
  }
}

/** A persistent, isolated filesystem. Report lost snapshots as terminal before allowing a fresh workspace. */
export type SandboxProvider = {
  name: string
  instructions: string
  desktop?: boolean
  /** Open or resume the same workspace; renew its lifetime for at least one full tool call. */
  open(
    workspace: { id: string; scope: 'identity' | 'conversation' },
    ctx: Context
  ): Promise<{
    env: SandboxEnv
    stop(ctx: Context): Promise<void>
  }>
}
