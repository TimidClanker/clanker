import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import type { Extension, Harness } from '@earendil-works/pi-durable'
import { openAgent } from 'agent'
import { openStorage } from 'storage'

/** Keep chat intake alive while replacing a harness whose database was owned by another process. */
export function createRuntime(models: Models, extensions: Extension[], signal: AbortSignal, onReady: (harness: Harness) => Promise<void>) {
  let current: Harness
  let changing = false
  let ready = Promise.withResolvers<Harness>()
  void ready.promise.catch(() => {})
  const stopped = Promise.withResolvers<void>()
  const stop = () => stopped.resolve()
  signal.addEventListener('abort', stop, { once: true })
  const finished = (async () => {
    try {
      while (!signal.aborted) {
        const lost = Promise.withResolvers<void>()
        let ownershipChanged = false
        let active: Harness | undefined
        try {
          await using storage = await openStorage(undefined, {
            signal,
            onOwnershipLost() {
              ownershipChanged = changing = true
              const previous = ready
              ready = Promise.withResolvers<Harness>()
              void ready.promise.catch(() => {})
              previous.resolve(ready.promise)
              lost.resolve()
              console.info('[storage] Another process owned the database; reloading durable state')
            }
          })
          try {
            active = await openAgent(storage, models, extensions)
            current = active
            await onReady(active)
            changing = false
            ready.resolve(active)
            active.resume()
            await Promise.race([lost.promise, stopped.promise])
          } finally {
            await active?.close(BACKGROUND_CONTEXT)
          }
        } catch (error) {
          if (!ownershipChanged) throw error
        }
      }
    } catch (error) {
      ready.reject(error)
      if (!signal.aborted) throw error
    } finally {
      signal.removeEventListener('abort', stop)
      ready.reject(signal.reason ?? new Error('Agent runtime stopped'))
    }
  })()
  return {
    get: () => current,
    finished,
    async use<T>(work: (harness: Harness) => Promise<T>): Promise<T> {
      for (;;) {
        signal.throwIfAborted()
        const harness = await ready.promise
        try {
          return await work(harness)
        } catch (error) {
          // Re-run only intake against a replaced harness. The message-ID receipt deduplicates admission.
          if (!changing && harness === current) throw error
        }
      }
    }
  }
}
