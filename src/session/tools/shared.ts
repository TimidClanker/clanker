import { defineTool, type ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Type, type Static, type TSchema } from 'typebox'

export const text = (description: string) => Type.String({ description, minLength: 1, pattern: '\\S' })
export const pagination = {
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, description: 'Page size; defaults to 20.' })),
  offset: Type.Optional(Type.Integer({ minimum: 0, description: 'Number of results to skip; defaults to 0.' }))
}

export function createTool<T extends TSchema>(
  name: string,
  description: string,
  parameters: T,
  execute: (params: Static<T>, ctx: ExtensionContext) => Promise<unknown>
) {
  return defineTool({
    name,
    label: name,
    description,
    promptSnippet: description,
    parameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted()
      const data = await execute(params, ctx)
      return { content: [{ type: 'text', text: JSON.stringify(data) }], details: { data } }
    }
  })
}
