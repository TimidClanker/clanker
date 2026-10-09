import type { PlatformAccount } from 'extensions/identity'
import { AccessDenied } from 'access'

type Channel = {
  id: string
  type: number
  name?: string
  guild_id?: string
  parent_id?: string
  recipients?: { id: string }[]
  thread_metadata?: { archived: boolean; locked: boolean }
  permission_overwrites?: { id: string; type: number; allow: string; deny: string }[]
}

// Use the adapter's authenticated API client; sending still goes through Chat SDK's Thread.post.
export async function discordDestination(
  api: (path: string) => Promise<Response>,
  sourceGuild: string,
  account: PlatformAccount,
  reference: string,
  botId: string
) {
  if (account.platform !== 'discord' || account.scope !== 'global') throw new AccessDenied('A verified Discord account is required')
  const value = reference.trim()
  const id =
    /^(?:<#)?(\d+)>?$/.exec(value)?.[1] ??
    /^https:\/\/(?:www\.)?discord(?:app)?\.com\/channels\/[^/]+\/(\d+)(?:\/\d+)?\/?$/.exec(value)?.[1] ??
    /^discord:[^:]+:(\d+)(?::(\d+))?$/.exec(value)?.slice(1).filter(Boolean).at(-1)
  let channel: Channel
  if (id) channel = (await (await api(`/channels/${id}`)).json()) as Channel
  else {
    if (sourceGuild === '@me') throw new Error('Use a channel mention, link, or ID when scheduling from a DM')
    const channels = (await (await api(`/guilds/${sourceGuild}/channels`)).json()) as Channel[]
    const matches = channels.filter(channel => [0, 5].includes(channel.type) && channel.name === value.replace(/^#/, ''))
    if (matches.length !== 1) throw new Error('Channel name was not found or is ambiguous; use its mention, link, or ID')
    channel = matches[0]!
  }
  if ([1, 3].includes(channel.type)) {
    if (!channel.recipients?.some(recipient => recipient.id === account.userId)) throw new AccessDenied('The requester is not a recipient of this DM')
    return { guildId: '@me', channelId: channel.id, title: channel.name ?? 'Direct message' }
  }
  if (![0, 5, 10, 11, 12].includes(channel.type) || !channel.guild_id) throw new Error('Choose a text channel or a thread, not a forum or category')
  const guildId = channel.guild_id
  const thread = [10, 11, 12].includes(channel.type)
  const parent = thread ? ((await (await api(`/channels/${channel.parent_id}`)).json()) as Channel) : channel
  const [guild, roles, requester, bot] = await Promise.all([
    api(`/guilds/${guildId}`).then(response => response.json()) as Promise<{ owner_id: string }>,
    api(`/guilds/${guildId}/roles`).then(response => response.json()) as Promise<{ id: string; permissions: string }[]>,
    api(`/guilds/${guildId}/members/${account.userId}`).then(response => response.json()) as Promise<{
      roles: string[]
      communication_disabled_until?: string | null
    }>,
    api(`/guilds/${guildId}/members/${botId}`).then(response => response.json()) as Promise<{ roles: string[]; communication_disabled_until?: string | null }>
  ])
  for (const [userId, member] of [
    [account.userId, requester],
    [botId, bot]
  ] as const) {
    let permissions = roles.filter(role => role.id === guildId || member.roles.includes(role.id)).reduce((bits, role) => bits | BigInt(role.permissions), 0n)
    if (userId === guild.owner_id || permissions & 8n) permissions = ~0n
    else {
      const overwrites = parent.permission_overwrites ?? []
      const apply = (items: typeof overwrites) => {
        permissions = (permissions & ~items.reduce((bits, item) => bits | BigInt(item.deny), 0n)) | items.reduce((bits, item) => bits | BigInt(item.allow), 0n)
      }
      apply(overwrites.filter(item => item.type === 0 && item.id === guildId))
      apply(overwrites.filter(item => item.type === 0 && item.id !== guildId && member.roles.includes(item.id)))
      apply(overwrites.filter(item => item.type === 1 && item.id === userId))
    }
    const required = (1n << 10n) | (1n << 16n) | (1n << (thread ? 38n : 11n))
    if ((permissions & required) !== required || Date.parse(member.communication_disabled_until ?? '') > Date.now()) {
      throw new AccessDenied('Both the requester and the bot need permission to view, read history, and send in the destination')
    }
    const manageThreads = (permissions & (1n << 34n)) !== 0n
    if (channel.type === 12 && !manageThreads) await api(`/channels/${channel.id}/thread-members/${userId}`)
    if (channel.thread_metadata?.archived && channel.thread_metadata.locked && !manageThreads) throw new AccessDenied('The destination thread is locked')
  }
  return {
    guildId,
    channelId: thread ? channel.parent_id! : channel.id,
    ...(thread ? { threadId: channel.id } : {}),
    title: `#${channel.name}`
  }
}
