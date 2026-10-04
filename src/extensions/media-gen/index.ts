import type { Context } from '@earendil-works/chord'
import { Type, type ImageContent } from '@earendil-works/pi-ai'
import { defineExtension, defineTool, section, type ToolExecutionApi } from '@earendil-works/pi-durable'
import type { MediaBackend } from 'extensions/media-gen/providers'

export type MediaDelivery = (images: ImageContent[], api: ToolExecutionApi, ctx: Context) => Promise<void>

export function createMediaGen(backends: MediaBackend[], deliver: MediaDelivery) {
  const available = async (backend: MediaBackend, signal?: AbortSignal) => {
    try {
      return backend.models.length > 0 && (await backend.isAvailable(signal))
    } catch {
      signal?.throwIfAborted()
      console.warn(`[media-gen] Cannot resolve ${backend.name} authentication; backend unavailable`)
      return false
    }
  }

  return defineExtension({
    name: 'media-gen',
    sections: [
      section(
        'media-gen',
        () =>
          "Use list_media_backends to discover authenticated image backends and their model IDs before calling generate_image. Choose a listed backend and model for the request; honor the user's provider preference. An empty list means image generation is unavailable. Include composition, style, and exact text in the prompt. Success means the images were delivered to this chat; do not invent download links. Do not silently switch backends after a failure. Editing existing images and video are not supported yet."
      )
    ],
    tools: [
      defineTool({
        name: 'list_media_backends',
        description:
          'List currently authenticated media-generation backends and their image models. Missing or unresolvable credentials are excluded. Availability does not guarantee remaining quota or model access.',
        parameters: Type.Object({}),
        replay: 'safe',
        async execute(_args, _api, ctx) {
          const listed = await Promise.all(
            backends.map(async backend =>
              (await available(backend, ctx.abortSignal))
                ? [{ backend: backend.name, description: backend.description, capabilities: ['text-to-image'], models: backend.models }]
                : []
            )
          )
          return { content: [{ type: 'text', text: JSON.stringify({ backends: listed.flat() }) }] }
        }
      }),
      defineTool({
        name: 'generate_image',
        description: 'Generate an image from a text prompt and send it to the current chat. Specify dimensions or aspect ratio in the prompt when needed.',
        parameters: Type.Object({
          backend: Type.String({ description: 'Backend name returned by list_media_backends.' }),
          model: Type.String({ description: 'Image model ID listed for that backend.' }),
          prompt: Type.String({ minLength: 1, description: 'A complete description of the image to create.' })
        }),
        // An interrupted provider request may already have been billed. Do not generate it again automatically.
        replay: 'unsafe',
        async execute({ backend: name, model, prompt }, api, ctx) {
          const backend = backends.find(backend => backend.name === name)
          if (!backend || !(await available(backend, ctx.abortSignal)))
            throw new Error(`Media backend ${name} is unavailable. Call list_media_backends for authenticated backends.`)
          if (!backend.models.some(candidate => candidate.id === model))
            throw new Error(`Unknown image model ${model} for ${name}. Call list_media_backends for model IDs.`)
          const signal = AbortSignal.any([AbortSignal.timeout(300_000), ...(ctx.abortSignal ? [ctx.abortSignal] : [])])
          const result = await backend.generate({ model, prompt }, signal)
          ctx.abortSignal?.throwIfAborted()
          const images = result.output.filter(part => part.type === 'image')
          if (!images.length)
            throw new Error(
              result.output
                .filter(part => part.type === 'text')
                .map(part => part.text)
                .join('\n') || 'The provider returned no images.'
            )
          await deliver(images, api, ctx)
          return {
            content: [
              { type: 'text', text: `Delivered ${images.length} generated image(s) to this chat using ${name}/${model}.` },
              ...result.output.filter(part => part.type === 'text')
            ],
            usage: result.usage
          }
        }
      })
    ]
  })
}
