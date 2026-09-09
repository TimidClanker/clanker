import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSession,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { Thread, Message } from 'chat'
import type { TSchema } from 'typebox'
import { createMetadataTool } from './tools/metadata'

interface ClankerSessionMetadata {
  /** An identifier for the session. */
  id: string
  /** A high-level summary of the topic of the session. */
  title?: string
  /** Keywords related to this session which would help with finding related sessions. */
  keywords?: string[]
  /** A bullet list of meaningful actions in this session. */
  summary?: string
}

interface CreateClankerSession {
  model?: string
  thinkingLevel?: 'low' | 'medium' | 'high' | 'xhigh'
  system?: string
  noTools?: boolean
  customTools?: ToolDefinition<TSchema, unknown, any>[]
  ephemeral?: boolean
}

export class ClankerSession {
  public metadata: ClankerSessionMetadata
  public subscriptions: Set<string> = new Set()

  private constructor(
    readonly session: AgentSession,
    public id: string
  ) {
    this.metadata = { id }
  }

  static async create(id: string, options?: CreateClankerSession): Promise<ClankerSession> {
    const model = await ClankerSession.getModel(options?.model)
    if (!model) throw new Error('No available models')

    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      systemPromptOverride: original => options?.system || original
    })
    await resourceLoader.reload()

    const { session } = await createAgentSession({
      model,
      thinkingLevel: options?.thinkingLevel,
      resourceLoader,
      noTools: options?.noTools ? 'all' : undefined,
      sessionManager: options?.ephemeral ? SessionManager.inMemory() : undefined
    })

    console.log(`[clanker] Created new ${model.provider}/${model.id}:${session.thinkingLevel} session ${id}`)

    return new ClankerSession(session, id)
  }

  static async getModel(modelName?: string) {
    const modelRuntime = await ModelRuntime.create({ allowModelNetwork: true, modelRefreshTimeoutMs: 15 * 1000 })
    if (!modelName) {
      const available = await modelRuntime.getAvailable()
      return available[0] ?? null
    }

    const model = resolveCliModel({ cliModel: modelName, modelRuntime })
    if (model.error) throw new Error(model.error)
    if (model.warning) console.log(`Model resolution warning: ${model.warning}`)
    return model.model
  }

  async prompt(text: (string | boolean | null)[] | string) {
    const prompt = Array.isArray(text) ? text.filter(Boolean).join('\n') : text
    return this.session.prompt(prompt)
  }

  async attach(thread: Thread, message: Message) {
    if (this.subscriptions.has(thread.id)) {
      console.debug(`[clanker] ${this.id} is already attached to thread ${thread.id}`)
      return
    }

    console.log(`[clanker] Attaching ${thread.id} to session ${this.id}`)
    thread.subscribe()
    this.subscriptions.add(thread.id)

    this.session.subscribe(async event => {
      // Send assistant responses back to the thread
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        for (const message of event.message.content.filter(c => c.type === 'text')) await thread.post(message.text)
      }

      if (event.type === 'agent_end') this.updateMetadata()
    })
  }

  async fork(options?: CreateClankerSession) {
    // If forking an unused session, write out the session file since Pi defers writing until something happens
    const existing = this.session.sessionManager
    const file = Bun.file(existing.getSessionFile()!)
    if (!(await file.exists())) await file.write(`${JSON.stringify(existing.getHeader())}\n`)

    const manager = options?.ephemeral
      ? SessionManager.inMemory(existing.getCwd(), undefined, structuredClone(existing.getBranch()))
      : SessionManager.open(file.name!, existing.getSessionDir())
    const forkId = new Date().getTime()

    const model = options?.model ? await ClankerSession.getModel(options?.model) : this.session.model

    const { session } = await createAgentSession({
      model: model!,
      thinkingLevel: options?.thinkingLevel ?? this.session.thinkingLevel,
      resourceLoader: this.session.resourceLoader,
      sessionManager: manager,
      customTools: options?.customTools
    })
    console.log(`[clanker] Forked session ${this.id} -> ${this.id}-${forkId}`)

    return new ClankerSession(session, `${this.id}-${forkId}`)
  }

  async updateMetadata() {
    const child = await this.fork({ ephemeral: true, model: 'gpt-5.6-luna', thinkingLevel: 'low', customTools: [createMetadataTool(this)] })
    try {
      await child.prompt('Analyze this session and use the `metadata` tool to update its metadata.')
    } finally {
      child.session.dispose()
    }
  }
}
