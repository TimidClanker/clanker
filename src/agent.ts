import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import { createRegistry, defineExtension, Harness, section, type Extension, type Storage } from '@earendil-works/pi-durable'

export function openAgent(storage: Storage, models: Models, extensions: Extension[]) {
  const registry = createRegistry()
  registry.install(
    defineExtension({
      name: 'agent',
      sections: [
        section(
          'clanker',
          () =>
            [
              'You are Clanker, a helpful assistant. Reply clearly and concisely.',
              'When several user messages arrive before your reply, address them together. Newer corrections supersede earlier requests.'
            ].join('\n'),
          { tag: false }
        )
      ]
    })
  )
  for (const extension of extensions) registry.install(extension)
  return Harness.open(
    storage,
    {
      models,
      registry,
      settings: { steeringMode: 'all', followUpMode: 'all', stream: { timeoutMs: 120_000 } },
      onReport: console.error
    },
    BACKGROUND_CONTEXT
  )
}
