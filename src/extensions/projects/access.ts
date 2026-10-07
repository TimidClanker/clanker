import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, Harness, Tx } from '@earendil-works/pi-durable'
import { Delegation, findIdentity, getRequestActors, resolveIdentity, type Author } from 'extensions/identity'
import { accountKey, canonicalId, Directory } from 'extensions/identity/state'
import { threadFor } from 'extensions/chat/state'
import { Jobs, type Job } from 'extensions/jobs/state'
import type { JobChat } from 'extensions/jobs/task'
import { Projects, type Project, type ProjectScope, type Role } from 'extensions/projects/state'

export type ProjectChat = Pick<JobChat, 'privateIdentity' | 'check'>
export type ProjectActor = { author: Author; conversationId: ConversationId; job?: Job }
// Host access callbacks need committed reads outside a transaction and the transaction's
// own documents inside it. Never enqueue a cold Harness.snapshot while holding its commit line.
export function transactionReader(tx: Tx): DocumentReader {
  return {
    snapshot: (token: unknown, ...args: unknown[]) => Reflect.apply(tx.doc, tx, [token, ...args.slice(0, -1)]),
    snapshotAsOf: async () => {
      throw new Error('Historical project authority is not supported')
    }
  }
}
const rank = { reader: 1, editor: 2, admin: 3 }
export function role(project: Project, identities: Record<string, { linkedTo?: string }>, identityId: string): Role | undefined {
  const roles = Object.entries(project.members)
    .filter(([id]) => canonicalId(identities, id) === identityId)
    .map(([, role]) => role)
  return roles.sort((a, b) => rank[b] - rank[a])[0]
}
export function scopeAllows(scope: ProjectScope, projectId: string, workItemId?: string) {
  const link = scope.find(link => link.projectId === projectId)
  return !!link && (!workItemId || !link.workItemIds || link.workItemIds.includes(workItemId))
}

export function createProjectAccess(chat: ProjectChat, getHarness: () => Harness) {
  async function audience(read: DocumentReader, actor: ProjectActor, ctx: Context) {
    const threadId = await threadFor(read, actor.conversationId, ctx)
    await chat.check({ threadId, title: 'Project access' }, actor.author.account, ctx)
    return chat.privateIdentity(read, actor.conversationId, ctx)
  }
  function requireAccess(
    project: Project | undefined,
    identities: Record<string, { linkedTo?: string }>,
    actor: ProjectActor,
    privateIdentity: string | undefined,
    minimum: Role,
    adminAction = false
  ) {
    const identityId = canonicalId(identities, actor.author.identityId)
    const member = project && role(project, identities, identityId)
    if (!project || !member || rank[member] < rank[minimum]) throw new Error('Project not found or not accessible')
    if (!adminAction && privateIdentity !== identityId && !project.shares.includes(actor.conversationId)) {
      throw new Error('This audience is not authorized for the project; an admin must deliberately share it with this conversation')
    }
    return identityId
  }
  async function checkScope(job: Job, ctx: Context, tx?: Tx) {
    if (!job.projectScope?.length) return
    const read = tx ? transactionReader(tx) : getHarness()
    if ((await findIdentity(read, job.owner.account, ctx)) !== (await resolveIdentity(read, job.owner.identityId, ctx)))
      throw new Error('Project task owner changed')
    const actor = { author: job.owner, conversationId: job.sourceConversationId, job }
    const privateIdentity = await audience(read, actor, ctx)
    const identities = (await read.snapshot(Directory, ctx))!.identities
    const directory = (await read.snapshot(Projects, ctx))?.projects ?? {}
    for (const link of job.projectScope) {
      const project = directory[link.projectId]
      requireAccess(project, identities, actor, privateIdentity, 'reader')
      if (link.workItemIds?.some(id => !Object.hasOwn(project!.workItems, id))) throw new Error('Delegated work item no longer exists')
    }
  }
  async function actor(read: DocumentReader, conversationId: ConversationId, ctx: Context, administration = false): Promise<ProjectActor> {
    const delegation = await read.snapshot(Delegation, conversationId, ctx)
    if (delegation?.jobId) {
      if (administration) throw new Error('Workers cannot administer projects')
      const job = (await read.snapshot(Jobs, ctx))!.jobs[delegation.jobId]!
      if (job.status !== 'running') throw new Error('Worker is not running')
      await checkScope(job, ctx)
      return { author: job.owner, conversationId: job.sourceConversationId, job }
    }
    const actors = await getRequestActors(read, getHarness(), conversationId, ctx, administration ? false : true)
    if (!actors.length || new Set(actors.map(author => author.identityId)).size !== 1) throw new Error('Project access requires one verified requester')
    return { author: actors.at(-1)!, conversationId }
  }
  async function readProject(read: DocumentReader, actor: ProjectActor, projectId: string, ctx: Context, workItemId?: string) {
    if (actor.job && !scopeAllows(actor.job.projectScope ?? [], projectId, workItemId)) throw new Error('Project or work item is outside delegated scope')
    const privateIdentity = await audience(read, actor, ctx)
    const project = (await read.snapshot(Projects, ctx))?.projects[projectId]
    const directory = (await read.snapshot(Directory, ctx))!
    if (canonicalId(directory.identities, directory.accounts[accountKey(actor.author.account)]!) !== canonicalId(directory.identities, actor.author.identityId))
      throw new Error('Requester identity changed')
    requireAccess(project, directory.identities, actor, privateIdentity, 'reader')
    return project!
  }
  async function mutate(tx: Tx, actor: ProjectActor, projectId: string, ctx: Context, minimum: Role = 'editor', adminAction = false, workItemId?: string) {
    if (actor.job && (!scopeAllows(actor.job.projectScope ?? [], projectId, workItemId) || adminAction)) throw new Error('Mutation outside delegated scope')
    const privateIdentity = await audience(transactionReader(tx), actor, ctx)
    const directory = await tx.doc(Directory)
    if (canonicalId(directory.identities, directory.accounts[accountKey(actor.author.account)]!) !== canonicalId(directory.identities, actor.author.identityId))
      throw new Error('Requester identity changed')
    if (actor.job) {
      const job = (await tx.doc(Jobs)).jobs[actor.job.id]!
      if (job.status !== 'running') throw new Error('Worker is not running')
      // Check every delegated project, not only the mutation target.
      for (const link of job.projectScope ?? [])
        requireAccess((await tx.doc(Projects)).projects[link.projectId], directory.identities, actor, privateIdentity, 'reader')
    }
    const project = (await tx.doc(Projects)).projects[projectId]
    const identityId = requireAccess(project, directory.identities, actor, privateIdentity, minimum, adminAction)
    return { project: project!, identityId, identities: directory.identities }
  }
  return { actor, audience, readProject, mutate, checkScope }
}
