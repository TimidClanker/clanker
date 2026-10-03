import type { Context } from '@earendil-works/chord'
import { defineDoc, type ConversationId, type DocumentReader, type Tx } from '@earendil-works/pi-durable'

// Scope is the platform's account namespace, e.g. a Slack workspace or "global" for Discord.
export type PlatformAccount = { platform: string; scope: string; userId: string }
type Author = { identityId: string; account: PlatformAccount; displayName: string }

const Directory = defineDoc<{
  identities: Record<string, { name: string; linkedTo?: string }>
  accounts: Record<string, string>
}>({ kind: 'identity.directory', version: 1, scope: 'session', initial: () => ({ identities: {}, accounts: {} }) })

const ConversationIdentities = defineDoc<{
  participants: Record<string, Author>
  messages: Record<string, Author>
}>({
  kind: 'identity.conversation',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ participants: {}, messages: {} })
})

const accountKey = ({ platform, scope, userId }: PlatformAccount) => JSON.stringify([platform, scope, userId])

function canonicalId(identities: Record<string, { linkedTo?: string }>, id: string): string {
  if (!Object.hasOwn(identities, id)) throw new Error('Identity not found')
  const linkedTo = identities[id]!.linkedTo
  return linkedTo ? canonicalId(identities, linkedTo) : id
}

/** Called by authenticated message intake, in the same commit that admits the message. */
export async function recordMessageAuthor(tx: Tx, conversationId: ConversationId, messageId: string, account: PlatformAccount, displayName: string) {
  const conversation = await tx.doc(ConversationIdentities, conversationId)
  const key = JSON.stringify(messageId)
  const existing = conversation.messages[key]
  if (existing) return { ...existing, account: { ...existing.account } }
  const directory = await tx.doc(Directory)
  const accountId = accountKey(account)
  let identityId = directory.accounts[accountId]
  if (!identityId) {
    identityId = crypto.randomUUID()
    directory.identities[identityId] = { name: displayName }
    directory.accounts[accountId] = identityId
  }
  const author = { identityId: canonicalId(directory.identities, identityId), account, displayName }
  conversation.participants[accountId] = author
  conversation.messages[key] = author
  return author
}

/** Host-only: link identities after verifying control of both accounts. Never expose this as a model tool. */
export async function linkIdentities(tx: Tx, keepId: string, otherId: string) {
  const directory = await tx.doc(Directory)
  const keep = canonicalId(directory.identities, keepId)
  const other = canonicalId(directory.identities, otherId)
  if (keep !== other) directory.identities[other]!.linkedTo = keep
  return keep
}

/** Resolve saved IDs after account linking; old references remain valid. For trusted application code. */
export async function getIdentity(read: DocumentReader, identityId: string, ctx: Context) {
  const directory = await read.snapshot(Directory, ctx)
  if (!directory) throw new Error('Identity not found')
  const id = canonicalId(directory.identities, identityId)
  const aliases = Object.keys(directory.identities).filter(other => other !== id && canonicalId(directory.identities, other) === id)
  const accounts = Object.entries(directory.accounts)
    .filter(([, owner]) => canonicalId(directory.identities, owner) === id)
    .map(([key]) => {
      const [platform, scope, userId] = JSON.parse(key) as [string, string, string]
      return { platform, scope, userId }
    })
  return { id, name: directory.identities[id]!.name, accounts, aliases }
}

/** Resolve a platform account without creating it. Names and email claims are never identity keys. */
export async function findIdentity(read: DocumentReader, account: PlatformAccount, ctx: Context) {
  const directory = await read.snapshot(Directory, ctx)
  const id = directory?.accounts[accountKey(account)]
  return id ? canonicalId(directory!.identities, id) : undefined
}

/** Observed senders only. This is neither the channel's member list nor an access-control decision. */
export async function getParticipants(read: DocumentReader, conversationId: ConversationId, ctx: Context): Promise<Author[]> {
  const conversation = await read.snapshot(ConversationIdentities, conversationId, ctx)
  if (!conversation) return []
  const directory = (await read.snapshot(Directory, ctx))!
  return Object.values(conversation.participants).map(author => ({ ...author, identityId: canonicalId(directory.identities, author.identityId) }))
}

/** Resolve one specific message's sender; there is deliberately no conversation-wide "current user". */
export async function getMessageAuthor(read: DocumentReader, conversationId: ConversationId, messageId: string, ctx: Context): Promise<Author | undefined> {
  const author = (await read.snapshot(ConversationIdentities, conversationId, ctx))?.messages[JSON.stringify(messageId)]
  if (!author) return undefined
  const directory = (await read.snapshot(Directory, ctx))!
  return { ...author, identityId: canonicalId(directory.identities, author.identityId) }
}
