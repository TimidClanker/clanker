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
import type { Thread } from 'chat'
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
  /** Disable all tools, including custom tools. Takes precedence over tools. */
  noTools?: boolean
  /** Allow only these tool names; an empty list disables all tools. */
  tools?: string[]
  customTools?: ToolDefinition<TSchema, unknown, any>[]
  ephemeral?: boolean
}

export class ClankerSession {
  public metadata: ClankerSessionMetadata
  private responseThreadId?: string
  private prompting = false
  private postQueue: Promise<void> = Promise.resolve()

  private constructor(
    readonly session: AgentSession,
    public id: string,
    private readonly options: CreateClankerSession
  ) {
    this.metadata = { id }
  }

  static async create(id: string, options: CreateClankerSession = {}): Promise<ClankerSession> {
    const model = await ClankerSession.getModel(options?.model)
    if (!model) throw new Error('No available models')

    const resourceLoader = await ClankerSession.getResourceLoader(options.system)

    const { session } = await createAgentSession({
      model,
      thinkingLevel: options?.thinkingLevel,
      resourceLoader,
      tools: options.noTools ? [] : options.tools,
      customTools: options.customTools,
      sessionManager: options?.ephemeral ? SessionManager.inMemory() : undefined
    })

    console.log(`[clanker] Created new ${model.provider}/${model.id}:${session.thinkingLevel} session ${id}`)

    return new ClankerSession(session, id, options)
  }

  private static async getResourceLoader(system?: string) {
    const resourceLoader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: getAgentDir(),
      systemPromptOverride: original => system ?? original
    })
    await resourceLoader.reload()
    return resourceLoader
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
    // Reserve the session before Pi's async preflight starts.
    if (this.prompting || !this.session.isIdle) throw new Error('Session is busy. Please retry after the current response finishes.')
    const prompt = Array.isArray(text) ? text.filter(Boolean).join('\n') : text
    this.prompting = true
    try {
      await this.session.prompt(prompt)
    } finally {
      await this.postQueue
      this.prompting = false
    }
  }

  async attach(thread: Thread) {
    if (this.responseThreadId && this.responseThreadId !== thread.id) throw new Error('A session cannot reply in another thread')
    if (this.responseThreadId === thread.id) {
      console.debug(`[clanker] ${this.id} is already attached to thread ${thread.id}`)
      return
    }

    console.log(`[clanker] Attaching ${thread.id} to session ${this.id}`)
    await thread.subscribe()
    this.responseThreadId = thread.id

    this.session.subscribe(event => {
      if (event.type !== 'message_end' || event.message.role !== 'assistant') return
      const response = event.message
      // Pi does not await listeners; drain ordered posts before releasing the prompt.
      this.postQueue = this.postQueue
        .then(async () => {
          for (const content of response.content.filter(c => c.type === 'text')) await thread.post(content.text)
        })
        .catch(error => console.error(`[clanker] Unable to post response for ${this.id} to ${thread.id}`, error))
    })
  }

  async fork(options: CreateClankerSession = {}) {
    options = {
      ...options,
      noTools: options.noTools ?? this.options.noTools,
      tools: options.tools ?? this.options.tools,
      customTools: options.customTools ?? this.options.customTools
    }
    const existing = this.session.sessionManager
    const sourcePath = existing.getSessionFile()
    let manager: SessionManager
    if (options.ephemeral) {
      manager = SessionManager.inMemory(existing.getCwd(), undefined, structuredClone(existing.getBranch()))
    } else if (sourcePath && (await Bun.file(sourcePath).exists())) {
      manager = SessionManager.forkFrom(sourcePath, existing.getCwd(), existing.getSessionDir())
      const leafId = existing.getLeafId()
      if (leafId) manager.branch(leafId)
      else manager.resetLeaf()
    } else {
      manager = SessionManager.create(existing.getCwd(), existing.getSessionDir())
      // Pi can seed memory sessions from entries; persistent imports require a child file.
      const entries = existing.getBranch()
      if (entries.length) {
        const path = manager.getSessionFile()!
        await Bun.write(path, [manager.getHeader(), ...entries].map(entry => JSON.stringify(entry)).join('\n') + '\n')
        manager = SessionManager.open(path, manager.getSessionDir())
      }
    }
    const forkId = manager.getSessionId()

    const model = options?.model ? await ClankerSession.getModel(options?.model) : this.session.model

    const { session } = await createAgentSession({
      model: model!,
      thinkingLevel: options?.thinkingLevel ?? this.session.thinkingLevel,
      resourceLoader: options.system === undefined ? this.session.resourceLoader : await ClankerSession.getResourceLoader(options.system),
      sessionManager: manager,
      tools: options.noTools ? [] : options.tools,
      customTools: options?.customTools
    })
    console.log(`[clanker] Forked session ${this.id} -> ${this.id}-${forkId}`)

    return new ClankerSession(session, `${this.id}-${forkId}`, options)
  }

  async updateMetadata() {
    const child = await this.fork({
      ephemeral: true,
      model: 'gpt-5.6-luna',
      thinkingLevel: 'low',
      noTools: false,
      tools: ['metadata'],
      customTools: [createMetadataTool(this)]
    })
    try {
      await child.prompt('Analyze this session and use the `metadata` tool to update its metadata.')
    } finally {
      child.session.dispose()
    }
  }
}
