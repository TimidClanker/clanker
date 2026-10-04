import type { AssistantImages } from '@earendil-works/pi-ai'

/** Backends own authentication and generation; the extension owns tool behavior and delivery. */
export type MediaBackend = {
  name: string
  description: string
  models: readonly { id: string; name: string }[]
  isAvailable(signal?: AbortSignal): Promise<boolean>
  generate(input: { model: string; prompt: string }, signal?: AbortSignal): Promise<Pick<AssistantImages, 'output' | 'usage'>>
}
