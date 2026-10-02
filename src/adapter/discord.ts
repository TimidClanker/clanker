import type { Chat } from 'chat'
import { DiscordAdapter } from '@chat-adapter/discord'

export class Discord extends DiscordAdapter {
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
}

export async function registerDiscordGateway(instance: Chat, signal: AbortSignal) {
  const discord = instance.getAdapter('discord') as DiscordAdapter
  let gatewayTask: Promise<unknown> | undefined

  while (!signal.aborted) {
    const response = await discord.startGatewayListener(
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
