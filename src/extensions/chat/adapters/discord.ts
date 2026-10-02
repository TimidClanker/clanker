import { DiscordAdapter } from '@chat-adapter/discord'

export class Discord extends DiscordAdapter {
  readonly renameInstructions = [
    'Use rename_thread to give the current Discord thread a useful public-facing title only once a substantive topic, project, question, or decision emerges. Keep the existing title for greetings or small talk; never use generic labels like "Friendly Greeting", "General Chat", or "Conversation".',
    'Name the concrete subject, such as "Codex OAuth in Docker". You may rename again as the topic develops, but only when it meaningfully improves the title, not for minor wording changes. This is independent of the internal discovery summary. Do not announce routine renames. The tool only works in actual Discord threads, not DMs or ordinary channels.'
  ].join('\n')

  replyChunk(text: string) {
    // Discord limits content to 2,000 UTF-16 units. Keep surrogate pairs intact.
    return text.slice(0, /[\uD800-\uDBFF]/.test(text[1999] ?? '') ? 1999 : 2000)
  }

  discoveryGroup(threadId: string) {
    return this.decodeThreadId(threadId).guildId
  }

  sourceUrl(threadId: string) {
    const { guildId, channelId, threadId: childId } = this.decodeThreadId(threadId)
    return `https://discord.com/channels/${guildId}/${childId ?? channelId}`
  }

  async renameThread(threadId: string, title: string) {
    const { guildId, channelId, threadId: childId } = this.decodeThreadId(threadId)
    if (guildId === '@me') throw new Error('Direct messages do not have a thread title to rename.')
    const id = childId ?? channelId
    const channel = (await (await this.discordFetch(`/channels/${id}`, 'GET')).json()) as { type: number; guild_id: string; name: string }
    if (![10, 11, 12].includes(channel.type) || channel.guild_id !== guildId)
      throw new Error('Only the current Discord thread can be renamed, not its parent channel.')
    const name = title.trim()
    if (!name || name.length > 100) throw new Error('Thread titles must contain 1–100 characters.')
    if (channel.name !== name) await this.discordFetch(`/channels/${id}`, 'PATCH', { name })
    return { title: name, changed: channel.name !== name }
  }

  async discoveryScope(threadId: string): Promise<string | null> {
    const { guildId, channelId, threadId: childId } = this.decodeThreadId(threadId)
    if (guildId === '@me') return null
    const getChannel = async (id: string) =>
      (await this.discordFetch(`/channels/${id}`, 'GET')).json() as Promise<{
        type: number
        guild_id?: string
        parent_id?: string
        nsfw?: boolean
        permission_overwrites?: { id: string; type: number; allow: string; deny: string }[]
      }>
    let channel = await getChannel(childId ?? channelId)
    if ([10, 11].includes(channel.type) && channel.parent_id) channel = await getChannel(channel.parent_id)
    // Private threads have membership rules beyond their parent's permissions.
    if (![0, 5, 15, 16].includes(channel.type) || channel.guild_id !== guildId || !channel.permission_overwrites) return null

    const roles = (await (await this.discordFetch(`/guilds/${guildId}/roles`, 'GET')).json()) as { id: string; permissions: string }[]
    const everyone = roles.find(role => role.id === guildId)
    if (!everyone) return null
    const history = 1n << 16n
    const visibility = (1n << 10n) | history
    const overwrites = channel.permission_overwrites
    const base = overwrites.find(overwrite => overwrite.id === guildId)
    const permissions = (BigInt(everyone.permissions) & ~BigInt(base?.deny ?? '0')) | BigInt(base?.allow ?? '0')
    // Equal audiences alone are insufficient if some readers cannot access old messages.
    if (!(permissions & history) || overwrites.some(overwrite => BigInt(overwrite.deny) & history)) return null
    const audience = overwrites
      .map(overwrite => [overwrite.id, overwrite.type, String(BigInt(overwrite.allow) & visibility), String(BigInt(overwrite.deny) & visibility)])
      .filter(([, , allow, deny]) => allow !== '0' || deny !== '0')
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    return JSON.stringify([guildId, !!channel.nsfw, audience])
  }

  async start(signal: AbortSignal) {
    let gatewayTask: Promise<unknown> | undefined

    while (!signal.aborted) {
      const response = await this.startGatewayListener(
        {
          waitUntil(task) {
            gatewayTask = task
          }
        },
        60 * 60 * 1000,
        signal
      )

      if (!response.ok) {
        throw new Error(await response.text())
      }

      await gatewayTask
      if (!signal.aborted) await Bun.sleep(5000)
    }
  }
}
