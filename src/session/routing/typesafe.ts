import { choice, TypeSafeClient } from '@typesafe-ai/sdk'
import { isMostRecentResponse, routingInstructions, type RoutingBackend, type RoutingInput } from '.'

export class TypeSafeRoutingBackend implements RoutingBackend {
  readonly name = 'typesafe'
  private client: TypeSafeClient

  constructor(apiKey: string) {
    this.client = new TypeSafeClient({ apiKey, timeout: 5000, retry: { maxRetries: 0 } })
  }

  async selectSession({ message, sessions }: RoutingInput, signal: AbortSignal) {
    const candidates = Object.fromEntries(
      sessions.map((session, index) => [
        `session_${index}`,
        {
          title: session.metadata.title?.slice(0, 200) ?? '',
          summary: session.metadata.summary?.slice(0, 600) ?? '',
          lastResponse: session.metadata.lastResponse?.slice(-1200) ?? '',
          lastResponseAt: session.metadata.lastResponseAt ?? null,
          mostRecentResponse: isMostRecentResponse(session, sessions)
        }
      ])
    )
    const response = await this.client.systemOne(
      {
        state: { message: message.text, sessions: candidates },
        questions: {
          session: choice(`Which session does the incoming message clearly continue? ${routingInstructions}`, {
            new: 'Start a new session when the message does not clearly continue any listed session.',
            ...Object.fromEntries(Object.keys(candidates).map(key => [key, `Continue the work in sessions.${key}.`]))
          })
        }
      },
      { signal }
    )
    const selected = response.answers.session.choice
    if (selected === 'new') return undefined
    const index = Object.keys(candidates).indexOf(selected)
    if (index < 0) throw new Error(`TypeSafe returned an unknown session: ${selected}`)
    return sessions[index]!.id
  }
}
