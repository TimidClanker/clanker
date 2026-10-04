import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { ExecutionEnv } from '@earendil-works/pi-durable/env'
import type { SandboxProvider } from 'extensions/sandbox/providers'

/** Serialize whole tools, including read/modify/write, while allowing unrelated workspaces to run concurrently. */
export function createWorkspaces(provider: SandboxProvider, idleMs: number) {
  const slots = new Map<
    string,
    {
      tail: Promise<unknown>
      session?: Awaited<ReturnType<SandboxProvider['open']>>
      timer?: ReturnType<typeof setTimeout>
    }
  >()
  let closing = false
  let closed: Promise<void> | undefined
  return {
    async use<T>(workspace: Parameters<SandboxProvider['open']>[0], ctx: Context, work: (env: ExecutionEnv) => Promise<T>) {
      if (closing) throw new Error('Sandbox extension is shutting down')
      let slot = slots.get(workspace.id)
      if (!slot) slots.set(workspace.id, (slot = { tail: Promise.resolve() }))
      clearTimeout(slot.timer)
      const current = slot
      const job = current.tail
        .catch(() => {})
        .then(async () => {
          ctx.abortSignal?.throwIfAborted()
          if (closing) throw new Error('Sandbox extension is shutting down')
          current.session = undefined
          current.session = await provider.open(workspace, ctx)
          try {
            return await work(current.session.env)
          } finally {
            await current.session.env.cleanup(BACKGROUND_CONTEXT)
          }
        })
      current.tail = job
      try {
        return await job
      } finally {
        if (!closing && current.tail === job) {
          current.timer = setTimeout(() => {
            current.tail = current.tail
              .catch(() => {})
              .then(async () => {
                await current.session?.stop(BACKGROUND_CONTEXT)
                current.session = undefined
              })
            void current.tail.catch(error => console.error('[sandbox] Idle stop failed', error))
          }, idleMs)
          current.timer.unref()
        }
      }
    },
    close() {
      closing = true
      return (closed ??= (async () => {
        await Promise.all(
          [...slots.values()].map(async slot => {
            clearTimeout(slot.timer)
            await slot.tail.catch(() => {})
            await slot.session?.stop(BACKGROUND_CONTEXT)
          })
        )
      })())
    }
  }
}
