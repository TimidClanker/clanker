import type { Harness, Storage } from '@earendil-works/pi-durable'

/** Process-local evidence, not a durable failure history or a storage health probe. */
export function createRuntimeStatus() {
  let phase: 'starting' | 'recovering' | 'ready' | 'failed' | 'closing' | 'stopped' = 'starting'
  let epoch = 0
  let current: { harness: Harness; scanTasks: Storage['scanTasks'] } | undefined
  let changedAt = new Date().toISOString()
  const events: { at: string; code: 'ownership_lost' | 'runtime_failed' | 'shutdown_failed' | 'runtime_report' }[] = []
  const event = (code: (typeof events)[number]['code']) => {
    events.push({ at: new Date().toISOString(), code })
    if (events.length > 20) events.shift()
  }
  const set = (next: typeof phase) => {
    phase = next
    changedAt = new Date().toISOString()
    if (next !== 'ready') current = undefined
  }
  return {
    event,
    set,
    ready(harness: Harness, storage: Storage) {
      epoch++
      current = { harness, scanTasks: storage.scanTasks.bind(storage) }
      set('ready')
    },
    capture: () => ({ phase, epoch, changedAt, current, events: events.map(value => ({ ...value })) })
  }
}
export type RuntimeStatus = ReturnType<typeof createRuntimeStatus>
