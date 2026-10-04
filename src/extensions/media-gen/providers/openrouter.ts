import type { Models } from '@earendil-works/pi-ai'
import type { MediaBackend } from 'extensions/media-gen/providers'

export class OpenRouter implements MediaBackend {
  readonly name = 'openrouter'
  readonly description = 'Image models through OpenRouter. Uses the configured OpenRouter account and its credits.'

  constructor(private ai: Models) {}

  get models() {
    return this.ai.getModelsOfType('image', this.name).map(({ id, name }) => ({ id, name }))
  }

  async isAvailable(signal?: AbortSignal) {
    return Boolean((await this.ai.getAuth(this.name, { signal }))?.auth.apiKey)
  }

  async generate({ model: id, prompt }: { model: string; prompt: string }, signal?: AbortSignal) {
    const model = this.ai.getModelOfType('image', this.name, id)
    if (!model) throw new Error(`Unknown OpenRouter image model: ${id}`)
    const result = await this.ai.generateImages(model, { input: [{ type: 'text', text: prompt }] }, { signal, maxRetries: 0 })
    signal?.throwIfAborted()
    if (result.stopReason !== 'stop') throw new Error(result.errorMessage ?? `Image generation ${result.stopReason}`)
    return result
  }
}
