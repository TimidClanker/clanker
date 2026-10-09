import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Harness } from '@earendil-works/pi-durable'
import type { PlatformAdapter } from 'extensions/chat/adapters'
import { Discord } from 'extensions/chat/adapters/discord'
import { Beeper } from 'extensions/chat/adapters/beeper'
import { beeperConfig } from 'extensions/chat/adapters/beeper/config'
import { BeeperCheckpoints } from 'extensions/chat/adapters/beeper/state'

export async function createAdapters(useAgent: <T>(work: (harness: Harness) => Promise<T>) => Promise<T>): Promise<Record<string, PlatformAdapter>> {
  const config = await beeperConfig()
  return {
    discord: new Discord(),
    ...(config.accessToken && config.accountIDs.length
      ? {
          beeper: new Beeper(config, {
            load: scope =>
              useAgent(harness =>
                harness.commit(async tx => {
                  const checkpoints = await tx.doc(BeeperCheckpoints)
                  const now = Date.now()
                  return { ...(checkpoints[scope] ??= { since: now, syncedAt: now }) }
                }, BACKGROUND_CONTEXT)
              ),
            save: (scope, checkpoint) =>
              useAgent(harness =>
                harness.commit(async tx => {
                  ;(await tx.doc(BeeperCheckpoints))[scope] = checkpoint
                }, BACKGROUND_CONTEXT)
              )
          })
        }
      : {})
  }
}
