import { defineTool } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

import { type ClankerSession } from '../index'

export const createMetadataTool = (session: ClankerSession) =>
  defineTool({
    name: 'metadata',
    label: 'Metadata',
    description: 'Updates the metadata around a given session. Used for identification and cross-referencing sessions.',
    parameters: Type.Object({
      title: Type.String({ description: 'A one-sentence high-level title of this session.' }),
      keywords: Type.Array(Type.String(), { description: 'An array of keywords related to the session topic.' }),
      summary: Type.String({ description: 'A short bullet list of actionable details of this session. Remove all fluff.' })
    }),

    async execute(toolCallId, { title, keywords, summary }: { title: string; keywords: string[]; summary: string }, signal, onUpdate, ctx) {
      // Check for cancellation
      if (signal?.aborted) return { content: [{ type: 'text', text: 'Cancelled' }], details: {} }

      session.metadata.title = title
      session.metadata.keywords = keywords
      session.metadata.summary = summary
      console.debug(`[metadata] Metadata updated for ${session.id}: ${JSON.stringify({ title, keywords, summary })}`)

      // Return result
      return {
        content: [{ type: 'text', text: 'Done' }],
        details: { data: { title, keywords, summary } },
        terminate: true
      }
    }
  })
