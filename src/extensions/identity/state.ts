import type { Context } from '@earendil-works/chord'
import { AccessDenied } from 'access'
import {
  defineDoc,
  LiveDoc,
  type ConversationId,
  type TaskId,
  type DocumentReader,
  type Harness,
  type ToolExecutionApi,
  type Tx
} from '@earendil-works/pi-durable'

// Scope is the platform's account namespace, e.g. a Slack workspace or "global" for Discord.
export type PlatformAccount = { platform: string; scope: string; userId: string }
export type Author = { identityId: string; account: PlatformAccount; displayName: string }

export const Directory = defineDoc<{
  identities: Record<string, { name: string; linkedTo?: string }>
  accounts: Record<string, string>
  accountNames?: Record<string, string>
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

/** Host-only origin of a delegated conversation. Never accept this from model arguments. */
const Delegation = defineDoc<{ sourceConversationId?: ConversationId; jobId?: TaskId }>({
  kind: 'identity.delegation',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({})
})

export async function sourceConversation(read: DocumentReader, conversationId: ConversationId, ctx: Context) {
  return (await getDelegation(read, conversationId, ctx))?.sourceConversationId ?? conversationId
}

export async function getDelegation(read: DocumentReader | Tx, conversationId: ConversationId, ctx: Context) {
  const delegation = await ('doc' in read ? read.doc(Delegation, conversationId) : read.snapshot(Delegation, conversationId, ctx))
  return delegation && { ...delegation }
}

export async function delegateConversation(tx: Tx, conversationId: ConversationId, sourceConversationId: ConversationId, jobId?: TaskId) {
  Object.assign(await tx.doc(Delegation, conversationId), { sourceConversationId, jobId })
}

export const accountKey = ({ platform, scope, userId }: PlatformAccount) => JSON.stringify([platform, scope, userId])

const AutomatedInputs = defineDoc<Record<string, true | (Author & { kind?: 'schedule' | 'background'; jobId?: TaskId })>>({
  kind: 'identity.automated-inputs',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({})
})

/** Host-only provenance: automated input is not a new user authorization, even when it names an owner. */
export async function recordAutomatedInput(
  tx: Tx,
  conversationId: ConversationId,
  requestId: string,
  owner?: Author,
  kind?: 'schedule' | 'background',
  jobId?: TaskId
) {
  ;(await tx.doc(AutomatedInputs, conversationId))[JSON.stringify(requestId)] = owner
    ? { ...owner, ...(kind ? { kind } : {}), ...(jobId !== undefined ? { jobId } : {}) }
    : true
}

export function canonicalId(identities: Record<string, { linkedTo?: string }>, id: string): string {
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
  ;(directory.accountNames ??= {})[accountId] = displayName
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
export async function resolveIdentity(read: DocumentReader, identityId: string, ctx: Context) {
  return (await identityResolver(read, ctx))(identityId)
}

/** Resolve several saved IDs against one current snapshot without exposing the directory. */
export async function identityResolver(read: DocumentReader | Tx, ctx: Context) {
  const directory = 'doc' in read ? await read.doc(Directory) : await read.snapshot(Directory, ctx)
  const identities = directory?.identities ?? {}
  return (id: string) => canonicalId(identities, id)
}

/** Include aliases only when reading state saved under previously linked identities. */
export async function getIdentity(read: DocumentReader, identityId: string, ctx: Context) {
  const directory = await read.snapshot(Directory, ctx)
  if (!directory) throw new Error('Identity not found')
  const id = canonicalId(directory.identities, identityId)
  const aliases = Object.keys(directory.identities).filter(other => other !== id && canonicalId(directory.identities, other) === id)
  return { id, aliases }
}

/** Resolve a platform account without creating it. Names and email claims are never identity keys. */
export async function findIdentity(read: DocumentReader, account: PlatformAccount, ctx: Context) {
  const directory = await read.snapshot(Directory, ctx)
  const id = directory?.accounts[accountKey(account)]
  return id ? canonicalId(directory!.identities, id) : undefined
}

/** Observed senders only. This is neither the channel's member list nor an access-control decision. */
export async function getParticipants(read: DocumentReader, conversationId: ConversationId, ctx: Context): Promise<Author[]> {
  const conversation = await read.snapshot(ConversationIdentities, await sourceConversation(read, conversationId, ctx), ctx)
  if (!conversation) return []
  const directory = (await read.snapshot(Directory, ctx))!
  return Object.values(conversation.participants).map(author => ({
    ...author,
    identityId: canonicalId(directory.identities, directory.accounts[accountKey(author.account)]!)
  }))
}

/** Authority for user-owned actions comes from admitted input, never a model-supplied identity ID. */
export async function getRequestAuthor(api: ToolExecutionApi, harness: Pick<Harness, 'submission'>, ctx: Context, allowSchedules = false): Promise<Author> {
  const authors = await getRequestActors(api, harness, api.conversationId, ctx, allowSchedules ? 'schedules' : false)
  if (!authors.length || new Set(authors.map(author => author.identityId)).size !== 1) {
    throw new AccessDenied(
      'This action needs a request from one verified user. If several people contributed to this run, ask the owner to repeat the request separately.'
    )
  }
  return authors.at(-1)!
}

/** Host provenance for admitted inputs. Automated owners are opt-in; only explicitly tagged schedules can delegate existing authorized work. */
export async function getRequestActors(
  read: DocumentReader,
  harness: Pick<Harness, 'submission'>,
  conversationId: ConversationId,
  ctx: Context,
  includeAutomated: boolean | 'schedules' = false
): Promise<Author[]> {
  const inputs = (await read.snapshot(LiveDoc, conversationId, ctx))?.run?.inputs ?? []
  const automated = await read.snapshot(AutomatedInputs, conversationId, ctx)
  const conversation = await read.snapshot(ConversationIdentities, conversationId, ctx)
  const directory = await read.snapshot(Directory, ctx)
  const authors: Author[] = []
  for (const id of inputs) {
    const submission = await harness.submission(id, ctx)
    const record = await submission?.status(ctx)
    const key = JSON.stringify(record?.requestId)
    const owner = key ? automated?.[key] : undefined
    if (owner && (!includeAutomated || (includeAutomated === 'schedules' && (owner === true || owner.kind !== 'schedule')))) continue
    const author = owner ?? (key ? conversation?.messages[key] : undefined)
    if (!author) throw new Error('An admitted input has no verified author')
    if (author === true) throw new AccessDenied('An admitted input has no verified author')
    const identityId = canonicalId(directory!.identities, author.identityId)
    if (canonicalId(directory!.identities, directory!.accounts[accountKey(author.account)]!) !== identityId) {
      throw new AccessDenied('This account’s identity changed after that message. Please send a new request.')
    }
    authors.push({ identityId, account: author.account, displayName: author.displayName })
  }
  return authors
}

/** Background provenance is host-recorded, never parsed from report text. */
export async function getBackgroundInputJobs(read: DocumentReader, harness: Pick<Harness, 'submission'>, conversationId: ConversationId, ctx: Context) {
  const inputs = (await read.snapshot(LiveDoc, conversationId, ctx))?.run?.inputs ?? []
  const automated = await read.snapshot(AutomatedInputs, conversationId, ctx)
  const jobs: TaskId[] = []
  for (const id of inputs) {
    const submission = await harness.submission(id, ctx)
    const owner = automated?.[JSON.stringify((await submission?.status(ctx))?.requestId)]
    if (owner && owner !== true && owner.jobId !== undefined) jobs.push(owner.jobId)
  }
  return [...new Set(jobs)]
}
