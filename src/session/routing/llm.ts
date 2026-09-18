import { z } from 'zod'
import { ClankerSession } from '..'
import { describeAttachments } from '../attachments'
import { isMostRecentResponse, routingInstructions, type RoutingBackend, type RoutingInput } from '.'

export class LLMRoutingBackend implements RoutingBackend {
  readonly name = 'llm'
  private session?: ClankerSession
  private initializing?: Promise<ClankerSession>

  private static schema = z.discriminatedUnion('action', [z.object({ action: z.literal('new') }), z.object({ action: z.literal('resume'), id: z.string() })])

  async selectSession({ threadId, message, sessions }: RoutingInput, signal: AbortSignal) {
    signal.throwIfAborted()
    const orchestrator =
      this.session ??
      (await (this.initializing ??= ClankerSession.create('orchestrator', {
        model: process.env.ORCHESTRATOR_MODEL?.trim() || 'gpt-5.6-luna',
        thinkingLevel: 'low',
        system: `You are an orchestration layer that routes user input to an appropriate agent session.

${routingInstructions}

You should respond with **ONLY** JSON, matching this schema:
${JSON.stringify(LLMRoutingBackend.schema.toJSONSchema())}`,
        noTools: true,
        ephemeral: true
      })
        .then(session => (this.session = session))
        .finally(() => {
          this.initializing = undefined
        })))
    signal.throwIfAborted()
    const routing = await orchestrator.fork({ ephemeral: true })
    const abort = () => void routing.abort().catch(error => console.error('[routing] Unable to abort LLM', error))
    signal.addEventListener('abort', abort, { once: true })
    try {
      signal.throwIfAborted()
      const existingSessions = sessions.map(
        s =>
          `- ID: ${s.id}\tTitle: ${s.metadata.title?.slice(0, 200)}\tKeywords: ${s.metadata.keywords?.join(', ').slice(0, 300)}\tLast assistant response at: ${s.metadata.lastResponseAt ?? 'unknown'}\tMost recent assistant response: ${isMostRecentResponse(s, sessions) ?? 'unknown'}\tLast assistant response: ${JSON.stringify(s.metadata.lastResponse?.slice(0, 4000) ?? '')}`
      )
      if (existingSessions.length === 0) existingSessions.push('There are no existing sessions.')
      await routing.prompt([
        'Here are some existing sessions that can be resumed:',
        ...existingSessions,
        '\nRoute this incoming event:',
        `Thread ID: ${threadId}`,
        `Sender: ${JSON.stringify(message.author)}`,
        `Message:\n${message.text}`,
        message.attachments.length > 0 && `Attachments: ${JSON.stringify(describeAttachments(message))}`
      ])
      signal.throwIfAborted()
      const decision = routing.session.messages.findLast(m => m.role === 'assistant')
      const result = LLMRoutingBackend.schema.parse(JSON.parse(decision?.content.find(c => c.type === 'text')?.text ?? '{}'))
      return result.action === 'resume' ? result.id : undefined
    } finally {
      signal.removeEventListener('abort', abort)
      routing.session.dispose()
    }
  }

  dispose() {
    this.session?.session.dispose()
  }
}
