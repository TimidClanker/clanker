import { defineDoc } from '@earendil-works/pi-durable'

export type BeeperCheckpoint = { since: number; syncedAt: number }

export const BeeperCheckpoints = defineDoc<Record<string, BeeperCheckpoint>>({
  kind: 'beeper.checkpoints',
  version: 1,
  scope: 'session',
  initial: () => ({})
})
