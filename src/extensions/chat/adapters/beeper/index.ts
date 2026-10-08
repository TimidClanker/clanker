import BeeperDesktop from '@beeper/desktop-api'
import {
  BaseFormatConverter,
  EmojiResolver,
  Message,
  parseMarkdown,
  stringifyMarkdown,
  type AdapterPostableMessage,
  type Author,
  type ChatInstance,
  type EmojiValue,
  type FetchOptions,
  type FormattedContent
} from 'chat'
import type { PlatformAdapter } from 'extensions/chat/adapters'
import type { PlatformAccount } from 'extensions/identity'
import type { beeperConfig } from 'extensions/chat/adapters/beeper/config'
import type { createBeeperObserver } from 'extensions/sources/connectors'
import { bindingFingerprint } from 'extensions/sources/state'
import type { BeeperCheckpoint } from 'extensions/chat/adapters/beeper/state'

const format = new (class extends BaseFormatConverter {
  toAst = parseMarkdown
  fromAst = stringifyMarkdown
})()
const emoji = new EmojiResolver()

export class Beeper implements PlatformAdapter {
  readonly name = 'beeper'
  readonly userName = 'clanker'
  private chat!: ChatInstance
  private client!: BeeperDesktop
  private chats = new Map<string, BeeperDesktop.Chat>()
  private networks = new Map<string, string>()
  private seen = new Set<string>()
  private socket?: WebSocket
  private shutdown = new AbortController()
  private pending: Promise<unknown> = Promise.resolve()
  private checkpoint!: BeeperCheckpoint
  private checkpointScope!: string

  constructor(
    private config: Awaited<ReturnType<typeof beeperConfig>>,
    private checkpoints: {
      load(scope: string, since?: number): Promise<BeeperCheckpoint>
      save(scope: string, checkpoint: BeeperCheckpoint): Promise<void>
    },
    private observer?: ReturnType<typeof createBeeperObserver>
  ) {}

  async initialize(chat: ChatInstance) {
    this.chat = chat
    if (!this.config.accessToken) throw new Error('Beeper needs authentication. Run bun run beeper login.')
    if (!this.config.accountIDs.length && !this.observer?.accountIDs.length) throw new Error('Select Beeper accounts with bun run beeper use <account-id>.')
    if (this.observer?.accountIDs.some(id => this.config.accountIDs.includes(id)))
      throw new Error('Passive observer accounts must be separate from bot accounts')
    this.client = new BeeperDesktop({ ...this.config, maxRetries: 0, timeout: 15_000 })
    // A separate cursor per endpoint/account selection prevents replaying another account's history.
    this.checkpointScope = JSON.stringify([this.config.baseURL, [...this.config.accountIDs].sort()])
  }

  encodeThreadId(data: { accountID: string; chatID: string }) {
    return `beeper:${Buffer.from(JSON.stringify([data.accountID, data.chatID])).toString('base64url')}`
  }

  decodeThreadId(threadId: string) {
    if (!threadId.startsWith('beeper:')) throw new Error('Invalid Beeper thread ID')
    const [accountID, chatID] = JSON.parse(Buffer.from(threadId.slice(7), 'base64url').toString()) as [string, string]
    if (!this.config.accountIDs.includes(accountID)) throw new Error('This Beeper account is not enabled for Clanker')
    return { accountID, chatID }
  }

  channelIdFromThreadId(threadId: string) {
    return threadId
  }

  acceptsThread(threadId: string) {
    const [accountID] = JSON.parse(Buffer.from(threadId.slice(7), 'base64url').toString()) as [string, string]
    return this.config.accountIDs.includes(accountID)
  }

  identifyAuthor(threadId: string, author: Author) {
    return { platform: 'beeper', scope: this.decodeThreadId(threadId).accountID, userId: author.userId }
  }

  async accountLabel(threadId: string, account: PlatformAccount) {
    const chat = await this.conversation(threadId)
    if (account.platform !== this.name || account.scope !== chat.accountID) throw new Error('Account does not belong to this Beeper conversation')
    const user = chat.participants.items.find(user => user.id === account.userId)
    const handle = user?.phoneNumber || user?.username || user?.email
    let network = this.networks.get(chat.accountID)
    if (!network) {
      network = (await this.client.accounts.retrieve(chat.accountID)).network || 'Beeper'
      this.networks.set(chat.accountID, network)
    }
    const label = network === 'Google Voice' ? 'Phone Number' : network
    return handle && handle !== account.userId ? `${label} (${handle})` : label
  }

  discoveryGroup(threadId: string) {
    return this.decodeThreadId(threadId).accountID
  }

  private async conversation(threadId: string, fresh = false) {
    const { accountID, chatID } = this.decodeThreadId(threadId)
    const chat = (!fresh && this.chats.get(chatID)) || (await this.client.chats.retrieve(chatID, { maxParticipantCount: -1 }))
    if (chat.accountID !== accountID) throw new Error('Beeper chat does not belong to the selected account')
    if (chat.merge) throw new Error('Use an individual network conversation, not a merged Beeper chat')
    this.chats.set(chatID, chat)
    return chat
  }

  isDM(threadId: string) {
    return this.chats.get(this.decodeThreadId(threadId).chatID)?.type === 'single'
  }

  async privateRecipient(threadId: string) {
    const chat = await this.conversation(threadId, true)
    const recipients = chat.participants.items.filter(user => !user.isSelf && !user.isPending)
    if (chat.type !== 'single' || chat.participants.hasMore || recipients.length !== 1 || recipients[0]!.isNetworkBot) return null
    return { platform: 'beeper', scope: chat.accountID, userId: recipients[0]!.id }
  }

  async resolveDestination(threadId: string, account: PlatformAccount, reference: string) {
    const { accountID } = this.decodeThreadId(threadId)
    const destination = reference.startsWith('beeper:') ? reference : this.encodeThreadId({ accountID, chatID: reference })
    const chat = await this.conversation(destination, true)
    if (
      account.platform !== 'beeper' ||
      account.scope !== chat.accountID ||
      !chat.participants.items.some(user => user.id === account.userId && !user.isPending)
    )
      throw new Error('The sender is not a member of that Beeper conversation')
    return { threadId: this.encodeThreadId({ accountID: chat.accountID, chatID: chat.id }), title: chat.title }
  }

  async fetchThread(threadId: string) {
    const chat = await this.conversation(threadId)
    return { id: threadId, channelId: threadId, channelName: chat.title, isDM: chat.type === 'single', metadata: { accountID: chat.accountID } }
  }

  async fetchMessages(threadId: string, options: FetchOptions = {}) {
    const chat = await this.conversation(threadId)
    // Search supports a page limit; message-list does not. Both use Beeper's opaque cursors.
    const forward = options.direction === 'forward'
    let page = await this.client.messages.search({
      accountIDs: [chat.accountID],
      chatIDs: [chat.id],
      cursor: options.cursor,
      direction: forward && options.cursor ? 'after' : 'before',
      limit: Math.min(options.limit ?? 20, 20),
      excludeLowPriority: false,
      includeMuted: true
    })
    const hasMore = page.hasMore
    // Beeper starts at the newest page without a cursor, even with direction=after.
    if (forward && !options.cursor) {
      while (page.hasNextPage()) page = await page.getNextPage()
    }
    return {
      messages: page.items.map(message => this.parseMessage(message)).sort((a, b) => a.metadata.dateSent.getTime() - b.metadata.dateSent.getTime()),
      nextCursor: hasMore ? ((forward ? page.newestCursor : page.oldestCursor) ?? undefined) : undefined
    }
  }

  async fetchMessage(threadId: string, messageId: string) {
    const chat = await this.conversation(threadId)
    return this.parseMessage(await this.client.messages.retrieve(messageId, { chatID: chat.id }))
  }

  parseMessage(raw: BeeperDesktop.Message) {
    const threadId = this.encodeThreadId({ accountID: raw.accountID, chatID: raw.chatID })
    return new Message({
      id: raw.id,
      threadId,
      text: raw.text ?? '',
      formatted: parseMarkdown(raw.text ?? ''),
      raw,
      // This is a user-owned account; isSender does not mean the message was authored by Clanker.
      author: { userId: raw.senderID, userName: raw.senderName ?? raw.senderID, fullName: raw.senderName ?? '', isBot: false, isMe: false },
      metadata: { dateSent: new Date(raw.timestamp), edited: !!raw.editedTimestamp, editedAt: raw.editedTimestamp ? new Date(raw.editedTimestamp) : undefined },
      attachments: (raw.attachments ?? []).map(attachment => ({
        type: attachment.type === 'img' ? ('image' as const) : attachment.type === 'unknown' ? ('file' as const) : attachment.type,
        mimeType: attachment.mimeType,
        name: attachment.fileName,
        size: attachment.fileSize,
        width: attachment.size?.width,
        height: attachment.size?.height,
        fetchData: async () => {
          const response = await this.client.assets.serve({ url: attachment.id ?? attachment.srcURL! })
          return response.arrayBuffer()
        }
      }))
    })
  }

  renderFormatted(content: FormattedContent) {
    return stringifyMarkdown(content)
  }

  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const chat = await this.conversation(threadId)
    const text = format.renderPostable(message)
    const files = typeof message !== 'string' && 'files' in message ? (message.files ?? []) : []
    let sent: BeeperDesktop.MessageSendResponse
    if (!files.length) sent = await this.client.messages.send(chat.id, { text })
    else {
      for (const [index, file] of files.entries()) {
        const data = file.data instanceof Blob ? await file.data.arrayBuffer() : file.data
        const uploaded = await this.client.assets.upload({ file: new File([new Uint8Array(data)], file.filename, { type: file.mimeType }) })
        if (!uploaded.uploadID) throw new Error(uploaded.error ?? 'Beeper did not accept the attachment')
        sent = await this.client.messages.send(chat.id, { text: index === 0 ? text : undefined, attachment: { uploadID: uploaded.uploadID } })
      }
    }
    return { id: sent!.pendingMessageID, threadId, raw: sent! }
  }

  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage) {
    const chat = await this.conversation(threadId)
    const raw = await this.client.messages.update(messageId, { chatID: chat.id, text: format.renderPostable(message) })
    return { id: raw.messageID, threadId, raw }
  }

  async deleteMessage(threadId: string, messageId: string) {
    const chat = await this.conversation(threadId)
    await this.client.messages.delete(messageId, { chatID: chat.id })
  }

  async addReaction(threadId: string, messageId: string, reaction: EmojiValue | string) {
    const chat = await this.conversation(threadId)
    await this.client.chats.messages.reactions.add(messageId, { chatID: chat.id, reactionKey: emoji.toGChat(reaction) })
  }

  async removeReaction(threadId: string, messageId: string, reaction: EmojiValue | string) {
    const chat = await this.conversation(threadId)
    await this.client.chats.messages.reactions.delete(emoji.toGChat(reaction), { chatID: chat.id, messageID: messageId })
  }

  // The public Client API currently has no typing endpoint.
  async startTyping() {}

  async handleWebhook() {
    return new Response('Beeper uses its WebSocket event stream', { status: 405 })
  }

  private async receive(raw: BeeperDesktop.Message) {
    // Passive personal-account observations never enter assistant admission or identity authorship.
    if (this.observer?.accountIDs.includes(raw.accountID)) {
      await this.observer.receive(raw)
      return
    }
    if (!this.config.accountIDs.includes(raw.accountID)) return
    // Only incoming messages trigger the agent. This also suppresses pending and confirmed reply echoes.
    if (raw.isSender || raw.isDeleted || raw.isHidden || raw.type === 'REACTION' || raw.type === 'NOTICE') return
    if (new Date(raw.timestamp).getTime() < this.checkpoint.since) return
    const key = JSON.stringify([raw.chatID, raw.id])
    if (this.seen.has(key)) return
    const message = this.parseMessage(raw)
    await this.conversation(message.threadId)
    await this.chat.processMessage(this, message.threadId, message)
    this.seen.add(key)
    if (this.seen.size > 10_000) this.seen.delete(this.seen.values().next().value!)
  }

  private enqueue(work: () => Promise<void>) {
    const task = this.pending.then(work)
    this.pending = task.catch(error => console.error('[beeper] Message intake failed', error))
    return task
  }

  private async reconcile(signal: AbortSignal) {
    const observers = (await this.observer?.selections()) ?? []
    if (!this.config.accountIDs.length && !observers.length) return
    const until = Date.now()
    // Preserve the existing bot cursor; each observer has its own resource-scoped checkpoint.
    const selections = [
      ...(this.config.accountIDs.length
        ? [
            {
              scope: this.checkpointScope,
              checkpoint: this.checkpoint,
              since: this.checkpoint.since,
              accountIDs: this.config.accountIDs,
              chatIDs: undefined,
              sender: 'others'
            }
          ]
        : []),
      ...(await Promise.all(
        observers.map(async binding => {
          const scope = JSON.stringify(['source', this.config.baseURL, bindingFingerprint(binding)])
          const since = await this.observer!.since(binding.id)
          return {
            scope,
            checkpoint: await this.checkpoints.load(scope, since || until),
            since,
            accountIDs: [binding.accountId],
            chatIDs: binding.chatIds,
            sender: undefined
          }
        })
      ))
    ]
    for (const { scope, checkpoint, since, ...selection } of selections) {
      const after = Math.max(since, checkpoint.since, checkpoint.syncedAt - 60_000)
      if (until <= after) continue
      const messages: BeeperDesktop.Message[] = []
      for await (const message of this.client.messages.search(
        { ...selection, dateAfter: new Date(after).toISOString(), dateBefore: new Date(until).toISOString(), excludeLowPriority: false, includeMuted: true },
        { signal }
      ))
        messages.push(message)
      messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
      await this.enqueue(async () => {
        for (const message of messages) {
          signal.throwIfAborted()
          await this.receive(message)
        }
      })
      const next = { ...checkpoint, syncedAt: until }
      await this.checkpoints.save(scope, next)
      if (scope === this.checkpointScope) this.checkpoint = next
    }
  }

  private async listen(signal: AbortSignal) {
    if (!this.config.accountIDs.length && !(await this.observer?.activeAccountIDs())?.length) return
    const info = await this.client.info.retrieve({ signal })
    const url = new URL(info.endpoints.ws_events, this.config.baseURL)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = (this.socket = new WebSocket(url, { headers: { Authorization: `Bearer ${this.config.accessToken}` } }))
    await new Promise<void>((done, reject) => {
      const stop = () => socket.close()
      signal.addEventListener('abort', stop, { once: true })
      socket.onopen = () => {
        if (signal.aborted) return stop()
        socket.send(JSON.stringify({ type: 'subscriptions.set', chatIDs: ['*'] }))
        console.info('[beeper] Connected; filtering to configured accounts', this.config.accountIDs)
      }
      socket.onmessage = event => {
        void this.enqueue(async () => {
          if (signal.aborted) return
          const payload = JSON.parse(String(event.data)) as { type: string; chatID?: string; entries?: BeeperDesktop.Message[]; message?: string }
          if (payload.type === 'error') throw new Error(payload.message ?? 'Beeper subscription failed')
          if (payload.type === 'chat.upserted' || payload.type === 'chat.deleted') this.chats.delete(payload.chatID!)
          if (payload.type === 'message.upserted') for (const message of payload.entries ?? []) await this.receive(message)
        }).catch(() => {})
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        signal.removeEventListener('abort', stop)
        if (signal.aborted) done()
        else reject(new Error('Beeper event stream disconnected'))
      }
      if (signal.aborted) stop()
    })
  }

  async start(signal: AbortSignal) {
    signal = AbortSignal.any([signal, this.shutdown.signal])
    this.checkpoint = await this.checkpoints.load(this.checkpointScope)
    const repeat = async (work: () => Promise<void>, delay: number) => {
      while (!signal.aborted) {
        try {
          await work()
        } catch (error) {
          if (!signal.aborted) console.warn('[beeper] Connection or recovery failed; retrying', (error as Error).message)
        }
        if (!signal.aborted)
          await new Promise<void>(done => {
            const stop = () => {
              clearTimeout(timer)
              signal.removeEventListener('abort', stop)
              done()
            }
            const timer = setTimeout(stop, delay)
            signal.addEventListener('abort', stop, { once: true })
          })
      }
    }
    await Promise.all([repeat(() => this.listen(signal), 5000), repeat(() => this.reconcile(signal), 30_000)])
    await this.pending
  }

  async disconnect() {
    this.shutdown.abort()
    this.socket?.close()
    await this.pending
  }
}
