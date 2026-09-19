import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSession,
  type PromptOptions,
  type ToolDefinition
} from '@earendil-works/pi-coding-agent'
import type { Thread } from 'chat'
import type { TSchema } from 'typebox'
import { createMetadataTool } from './tools/metadata'

export interface ClankerSessionMetadata {
  /** An identifier for the session. */
  id: string
  /** A high-level summary of the topic of the session. */
  title?: string
  /** Keywords related to this session which would help with finding related sessions. */
  keywords?: string[]
  /** A bullet list of meaningful actions in this session. */
  summary?: string
  /** The latest accepted user message, including attachment descriptions. */
  lastMessage?: string
  /** The latest assistant response containing user-facing text. */
  lastResponse?: string
  /** ISO timestamp of the latest assistant response containing user-facing text. */
  lastResponseAt?: string
}

interface CreateClankerSession {
  model?: string
  thinkingLevel?: AgentSession['thinkingLevel']
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
  private responseThread?: Thread
  private inputQueue: Promise<void> = Promise.resolve()
  private promptTask?: Promise<void>
  private postQueue: Promise<void> = Promise.resolve()
  private stopped = false
  private metadataSession?: ClankerSession

  private constructor(
    readonly session: AgentSession,
    public id: string,
    private readonly options: CreateClankerSession
  ) {
    this.metadata = { id }
    session.agent.steeringMode = 'one-at-a-time'
    session.subscribe(event => {
      if (event.type !== 'message_end' || event.message.role !== 'assistant') return
      const text = event.message.content
        .filter(content => content.type === 'text')
        .map(content => content.text)
        .join('\n')
      if (text.trim()) {
        this.metadata.lastResponse = text
        this.metadata.lastResponseAt = new Date(event.message.timestamp).toISOString()
      }
    })
  }

  static async create(id: string, options: CreateClankerSession = {}, manager?: SessionManager): Promise<ClankerSession> {
    const { model, thinkingLevel } = await ClankerSession.getModel(options.model)
    if (!model) throw new Error('No available models')

    const resourceLoader = await ClankerSession.getResourceLoader(options.system)

    const { session } = await createAgentSession({
      model,
      thinkingLevel: options.thinkingLevel ?? thinkingLevel ?? 'low',
      resourceLoader,
      tools: options.noTools ? [] : options.tools,
      customTools: options.customTools,
      sessionManager: manager ?? (options.ephemeral ? SessionManager.inMemory() : undefined)
    })

    console.log(`[clanker] ${manager ? 'Reopened existing' : 'Created new'} ${model.provider}/${model.id}:${session.thinkingLevel} session ${id}`)

    return new ClankerSession(session, id, options)
  }

  snapshot() {
    if (this.options.ephemeral) throw new Error('Ephemeral sessions cannot be saved')
    const manager = this.session.sessionManager
    return {
      settings: {
        model: `${this.session.model!.provider}/${this.session.model!.id}`,
        thinkingLevel: this.session.thinkingLevel,
        system: this.options.system,
        noTools: this.options.noTools,
        tools: this.options.tools ?? this.session.getActiveToolNames()
      },
      leafId: manager.getLeafId(),
      jsonl: [manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join('\n') + '\n'
    }
  }

  static async restore(
    id: string,
    metadata: ClankerSessionMetadata,
    snapshot: ReturnType<ClankerSession['snapshot']>,
    customTools?: CreateClankerSession['customTools']
  ) {
    const path = `workspace/sessions/${new Bun.CryptoHasher('sha256').update(id).digest('hex')}.jsonl`
    await Bun.write(path, snapshot.jsonl)
    const manager = SessionManager.open(path, undefined, process.cwd())
    if (snapshot.leafId) manager.branch(snapshot.leafId)
    else manager.resetLeaf()
    // Reattach runtime tools to older allowlists, preserving an explicit empty list.
    const tools = snapshot.settings.tools?.length
      ? [...new Set([...snapshot.settings.tools, ...(customTools ?? []).map(tool => tool.name)])]
      : snapshot.settings.tools
    const session = await ClankerSession.create(id, { ...snapshot.settings, tools, customTools }, manager)
    session.metadata = metadata
    return session
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
      return { model: available[0], thinkingLevel: undefined }
    }

    const model = resolveCliModel({ cliModel: modelName, modelRuntime })
    if (model.error) throw new Error(model.error)
    if (model.warning) console.log(`Model resolution warning: ${model.warning}`)
    return { model: model.model, thinkingLevel: model.thinkingLevel }
  }

  async prompt(text: (string | boolean | null)[] | string, options: Pick<PromptOptions, 'images'> & { onAccepted?: () => void } = {}) {
    const previous = this.inputQueue
    const accepted = Promise.withResolvers<void>()
    this.inputQueue = accepted.promise
    await previous
    const onAccepted = () => {
      options.onAccepted?.()
      accepted.resolve()
    }
    try {
      if (this.stopped) throw new Error('Session is shutting down')
      const prompt = Array.isArray(text) ? text.filter(Boolean).join('\n') : text
      if (this.session.isStreaming) {
        // steer() also accepts messages during retries and automatic compaction.
        const running = this.promptTask
        await this.session.steer(prompt, options.images)
        onAccepted()
        await running
        return
      }

      // The preceding run may still be posting its final response.
      await this.promptTask?.catch(() => {})
      await this.session.waitForIdle()
      if (this.stopped) throw new Error('Session is shutting down')
      this.promptTask = this.runPrompt(prompt, options, onAccepted)
      await this.promptTask
    } finally {
      // Release preflight failures as well as successfully accepted messages.
      accepted.resolve()
    }
  }

  private async runPrompt(prompt: string, options: Pick<PromptOptions, 'images'>, onAccepted: () => void) {
    const thread = this.responseThread
    let typing: Promise<void> | undefined
    const updateTyping = () => {
      if (this.stopped || typing || !thread) return
      typing = thread
        .startTyping()
        .catch(error => console.warn('[clanker] Unable to show typing indicator', error))
        .finally(() => {
          typing = undefined
        })
    }
    const typingTimer = thread ? setInterval(updateTyping, 5000).unref() : undefined
    try {
      updateTyping()
      await this.session.prompt(prompt, {
        images: options.images,
        // Abort can arrive during Pi's async preflight, before an agent run exists.
        preflightResult: success => {
          if (this.stopped) throw new Error('Session is shutting down')
          if (success) onAccepted()
        }
      })
    } finally {
      clearInterval(typingTimer)
      await typing
      await this.postQueue
      await thread?.adapter.endTyping?.(thread.id).catch(error => console.warn('[clanker] Unable to clear typing indicator', error))
    }
  }

  async attach(thread: Thread) {
    if (this.responseThread && this.responseThread.id !== thread.id) throw new Error('A session cannot reply in another thread')
    if (this.responseThread?.id === thread.id) {
      this.responseThread = thread
      console.debug(`[clanker] ${this.id} is already attached to thread ${thread.id}`)
      return
    }

    console.log(`[clanker] Attaching ${thread.id} to session ${this.id}`)
    await thread.subscribe()
    this.responseThread = thread

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
      system: options.system ?? this.options.system,
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

    const { model, thinkingLevel } = options.model
      ? await ClankerSession.getModel(options.model)
      : { model: this.session.model, thinkingLevel: this.session.thinkingLevel }

    const { session } = await createAgentSession({
      model: model!,
      thinkingLevel: options.thinkingLevel ?? thinkingLevel ?? this.session.thinkingLevel,
      // Loaders own extension state, so each session needs its own lifetime.
      resourceLoader: await ClankerSession.getResourceLoader(options.system),
      sessionManager: manager,
      tools: options.noTools ? [] : options.tools,
      customTools: options?.customTools
    })
    console.log(`[clanker] Forked session ${this.id} -> ${this.id}-${forkId}`)

    return new ClankerSession(session, `${this.id}-${forkId}`, options)
  }

  async updateMetadata() {
    if (this.stopped) return
    const child = await this.fork({
      ephemeral: true,
      model: process.env.METADATA_MODEL?.trim() || process.env.ORCHESTRATOR_MODEL?.trim() || undefined,
      noTools: false,
      tools: ['metadata'],
      customTools: [createMetadataTool(this)]
    })
    this.metadataSession = child
    try {
      if (this.stopped) return
      await child.prompt('Analyze this session and use the `metadata` tool to update its metadata.')
    } finally {
      this.metadataSession = undefined
      child.session.dispose()
    }
  }

  async abort() {
    this.stopped = true
    await Promise.all([this.session.abort(), this.metadataSession?.abort()])
    await this.postQueue
  }
}
