import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, Harness, Tx, HookApi } from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import { getBackgroundInputJobs } from 'extensions/identity/state'
import { Delegation, findIdentity, getRequestActors, resolveIdentity, type Author } from 'extensions/identity'
import { accountKey, canonicalId, Directory } from 'extensions/identity/state'
import { threadFor } from 'extensions/chat/state'
import { Jobs, type Job } from 'extensions/jobs/state'
import type { JobChat } from 'extensions/jobs/task'
import { Projects, ProjectDisclosures, type ProjectDisclosure, type Project, type ProjectScope, type Role } from 'extensions/projects/state'

export type ProjectChat = Pick<JobChat, 'privateIdentity' | 'check'>
export type ProjectActor = { author: Author; conversationId: ConversationId; job?: Job; report?: boolean }
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
    await chat.check({ threadId, title: 'Project access' }, actor.author.account, ctx, read)
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
      const project = Object.hasOwn(directory, link.projectId) ? directory[link.projectId] : undefined
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
    const actors = await getRequestActors(read, getHarness(), conversationId, ctx, administration ? false : 'schedules')
    if (actors.length) {
      if (new Set(actors.map(author => author.identityId)).size !== 1) throw new Error('Project access requires one verified requester')
      return { author: actors.at(-1)!, conversationId }
    }
    if (administration) throw new Error('Project administration requires a genuine verified user request')
    // Reports are evidence, not fresh authority. Never union several originating scopes.
    const ids = await getBackgroundInputJobs(read, getHarness(), conversationId, ctx)
    if (ids.length !== 1) throw new Error('Project access requires one verified requester or one scoped report origin')
    const job = (await read.snapshot(Jobs, ctx))?.jobs[ids[0]!]
    if (!job?.projectScope?.length || job.sourceConversationId !== conversationId) throw new Error('Background reports confer no project access here')
    const reports = await getRequestActors(read, getHarness(), conversationId, ctx, true)
    const owner = await resolveIdentity(read, job.owner.identityId, ctx)
    if (!reports.length || reports.some(author => author.identityId !== owner)) throw new Error('Report owner changed')
    await checkScope(job, ctx)
    return { author: job.owner, conversationId, job, report: true }
  }

  async function readProject(read: DocumentReader, actor: ProjectActor, projectId: string, ctx: Context, workItemId?: string) {
    if (actor.job && !scopeAllows(actor.job.projectScope ?? [], projectId, workItemId)) throw new Error('Project or work item is outside delegated scope')
    const privateIdentity = await audience(read, actor, ctx)
    const projects = (await read.snapshot(Projects, ctx))?.projects ?? {}
    const project = Object.hasOwn(projects, projectId) ? projects[projectId] : undefined
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
      if (!actor.report && job.status !== 'running') throw new Error('Worker is not running')
      await checkScope(job, ctx, tx)
    }
    const projects = (await tx.doc(Projects)).projects
    const project = Object.hasOwn(projects, projectId) ? projects[projectId] : undefined
    const identityId = requireAccess(project, directory.identities, actor, privateIdentity, minimum, adminAction)
    return { project: project!, identityId, identities: directory.identities }
  }
  async function checkDisclosure(disclosure: ProjectDisclosure, threadId: string | undefined, ctx: Context, tx?: Tx) {
    const read = tx ? transactionReader(tx) : getHarness()
    if (threadId !== undefined && (await threadFor(read, disclosure.conversationId, ctx)) !== threadId)
      throw new Error('Project disclosure destination changed')
    const job = disclosure.jobId === undefined ? undefined : (await read.snapshot(Jobs, ctx))?.jobs[disclosure.jobId]
    if (disclosure.jobId !== undefined) {
      if (!job || (await resolveIdentity(read, job.owner.identityId, ctx)) !== (await resolveIdentity(read, disclosure.author.identityId, ctx)))
        throw new Error('Project report origin changed')
      await checkScope(job, ctx, tx)
    }
    const owner: ProjectActor = { author: disclosure.author, conversationId: disclosure.conversationId, ...(job ? { job, report: true } : {}) }
    const project = await readProject(read, owner, disclosure.projectId, ctx)
    const privateIdentity = await audience(read, owner, ctx)
    requireAccess(project, (await read.snapshot(Directory, ctx))!.identities, owner, privateIdentity, disclosure.minimum ?? 'reader')
    if (disclosure.private && privateIdentity !== (await resolveIdentity(read, disclosure.author.identityId, ctx)))
      throw new Error('Private project administration audience changed')
  }
  async function supply(
    read: DocumentReader,
    conversationId: ConversationId,
    owner: ProjectActor,
    projectIds: string[],
    ctx: Context,
    administrative = false,
    originJob = owner.job
  ) {
    if (!projectIds.length) return
    const run = (await read.snapshot(LiveDoc, conversationId, ctx))?.run
    if (!run?.inputs.length) throw new Error('Project disclosure requires an active run')
    const values: ProjectDisclosure[] = [...new Set(projectIds)].map(projectId => ({
      author: owner.author,
      conversationId: owner.conversationId,
      projectId,
      ...(originJob ? { jobId: originJob.id } : {}),
      ...(administrative ? { minimum: 'admin', private: true } : {})
    }))
    await getHarness().commit(async tx => {
      // Recheck slow read/list/section completion before supplying any content.
      for (const value of values) await checkDisclosure(value, undefined, ctx, tx)
      if (owner.job && !owner.report) return // Worker output already carries immutable Jobs scope.
      const live = (await tx.doc(LiveDoc, conversationId)).run
      if (!live || live.inputs[0] !== run.inputs[0]) throw new Error('Project disclosure run changed')
      const scopes = await tx.doc(ProjectDisclosures, conversationId)
      scopes.runs[run.inputs[0]!] ??= []
      const grants = scopes.runs[run.inputs[0]!]!
      for (const value of values) if (!grants.some(previous => JSON.stringify(previous) === JSON.stringify(value))) grants.push(value)
      scopes.generations[live.taskId] = grants.map(value => JSON.parse(JSON.stringify(value)))
    }, ctx)
  }
  async function guard(api: HookApi, ctx: Context) {
    try {
      const values = await currentDisclosures(api, api.conversationId, ctx)
      for (const value of values) await checkDisclosure(value, undefined, ctx)
      if (values.length)
        await getHarness().commit(async tx => {
          const run = (await tx.doc(LiveDoc, api.conversationId)).run
          if (run) (await tx.doc(ProjectDisclosures, api.conversationId)).generations[run.taskId] = values.map(value => JSON.parse(JSON.stringify(value)))
        }, ctx)
    } catch (error) {
      await getHarness().abortTask(api.taskId, ctx)
      throw error
    }
  }
  return { actor, audience, readProject, mutate, checkScope, checkDisclosure, supply, guard }
}

export async function currentDisclosures(read: DocumentReader, conversationId: ConversationId, ctx: Context) {
  const first = (await read.snapshot(LiveDoc, conversationId, ctx))?.run?.inputs[0]
  return first === undefined ? [] : ((await read.snapshot(ProjectDisclosures, conversationId, ctx))?.runs[first] ?? [])
}
