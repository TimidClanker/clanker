import type { Context } from '@earendil-works/chord'
import { AccessDenied } from 'access'
import type { ConversationId, DocumentReader, Harness, Tx, HookApi, TaskId } from '@earendil-works/pi-durable'
import { LiveDoc } from '@earendil-works/pi-durable'
import { getBackgroundInputJobs, getDelegation, findIdentity, getRequestActors, resolveIdentity, identityResolver, type Author } from 'extensions/identity'
import type { ChatAccess } from 'extensions/chat/contracts'
import { Projects, ProjectDisclosures, type ProjectDisclosure, type Project, type Role } from 'extensions/projects/state'
import type { ProjectScope } from 'extensions/projects/schema'

export type ProjectChat = Pick<ChatAccess, 'privateIdentity' | 'check' | 'threadFor'>
export type ProjectJob = { id: TaskId; sourceConversationId: ConversationId; owner: Author; status: string; projectScope?: ProjectScope }
export type ProjectJobs = { readJob(read: DocumentReader | Tx, id: TaskId, ctx: Context): Promise<ProjectJob | undefined> }
export type ProjectActor = { author: Author; conversationId: ConversationId; job?: ProjectJob; report?: boolean }
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
export function role(project: Project, resolve: (id: string) => string, identityId: string): Role | undefined {
  const roles = Object.entries(project.members)
    .filter(([id]) => resolve(id) === identityId)
    .map(([, role]) => role)
  return roles.sort((a, b) => rank[b] - rank[a])[0]
}
export function scopeAllows(scope: ProjectScope, projectId: string, workItemId?: string) {
  const link = scope.find(link => link.projectId === projectId)
  return !!link && (!workItemId || !link.workItemIds || link.workItemIds.includes(workItemId))
}

export function createProjectAccess(chat: ProjectChat, getHarness: () => Harness, jobs: ProjectJobs) {
  async function audience(read: DocumentReader, actor: ProjectActor, ctx: Context) {
    const threadId = await chat.threadFor(read, actor.conversationId, ctx)
    await chat.check({ threadId, title: 'Project access' }, actor.author.account, ctx, read)
    return chat.privateIdentity(read, actor.conversationId, ctx)
  }
  function requireAccess(
    project: Project | undefined,
    resolve: (id: string) => string,
    actor: ProjectActor,
    privateIdentity: string | undefined,
    minimum: Role,
    adminAction = false
  ) {
    const identityId = resolve(actor.author.identityId)
    const member = project && role(project, resolve, identityId)
    if (!project || !member || rank[member] < rank[minimum]) throw new AccessDenied('Project not found or not accessible')
    if (!adminAction && privateIdentity !== identityId && !project.shares.includes(actor.conversationId)) {
      throw new AccessDenied('This audience is not authorized for the project; an admin must deliberately share it with this conversation')
    }
    return identityId
  }
  async function checkScope(job: ProjectJob, ctx: Context, tx?: Tx) {
    if (!job.projectScope?.length) return
    const read = tx ? transactionReader(tx) : getHarness()
    if ((await findIdentity(read, job.owner.account, ctx)) !== (await resolveIdentity(read, job.owner.identityId, ctx)))
      throw new AccessDenied('Project task owner changed')
    const actor = { author: job.owner, conversationId: job.sourceConversationId, job }
    const privateIdentity = await audience(read, actor, ctx)
    const resolve = await identityResolver(read, ctx)
    const directory = (await read.snapshot(Projects, ctx))?.projects ?? {}
    for (const link of job.projectScope) {
      const project = Object.hasOwn(directory, link.projectId) ? directory[link.projectId] : undefined
      requireAccess(project, resolve, actor, privateIdentity, 'reader')
      if (link.workItemIds?.some(id => !Object.hasOwn(project!.workItems, id))) throw new AccessDenied('Delegated work item no longer exists')
    }
  }
  async function actor(read: DocumentReader, conversationId: ConversationId, ctx: Context, administration = false): Promise<ProjectActor> {
    const delegation = await getDelegation(read, conversationId, ctx)
    if (delegation?.jobId) {
      if (administration) throw new AccessDenied('Workers cannot administer projects')
      const job = (await jobs.readJob(read, delegation.jobId, ctx))!
      if (job.status !== 'running') throw new AccessDenied('Worker is not running')
      await checkScope(job, ctx)
      return { author: job.owner, conversationId: job.sourceConversationId, job }
    }
    const actors = await getRequestActors(read, getHarness(), conversationId, ctx, administration ? false : 'schedules')
    if (actors.length) {
      if (new Set(actors.map(author => author.identityId)).size !== 1) throw new AccessDenied('Project access requires one verified requester')
      return { author: actors.at(-1)!, conversationId }
    }
    if (administration) throw new AccessDenied('Project administration requires a genuine verified user request')
    // Reports are evidence, not fresh authority. Never union several originating scopes.
    const ids = await getBackgroundInputJobs(read, getHarness(), conversationId, ctx)
    if (ids.length !== 1) throw new AccessDenied('Project access requires one verified requester or one scoped report origin')
    const job = await jobs.readJob(read, ids[0]!, ctx)
    if (!job?.projectScope?.length || job.sourceConversationId !== conversationId) throw new AccessDenied('Background reports confer no project access here')
    const reports = await getRequestActors(read, getHarness(), conversationId, ctx, true)
    const owner = await resolveIdentity(read, job.owner.identityId, ctx)
    if (!reports.length || reports.some(author => author.identityId !== owner)) throw new AccessDenied('Report owner changed')
    await checkScope(job, ctx)
    return { author: job.owner, conversationId, job, report: true }
  }

  async function readProject(read: DocumentReader, actor: ProjectActor, projectId: string, ctx: Context, workItemId?: string) {
    if (actor.job && !scopeAllows(actor.job.projectScope ?? [], projectId, workItemId))
      throw new AccessDenied('Project or work item is outside delegated scope')
    const privateIdentity = await audience(read, actor, ctx)
    const projects = (await read.snapshot(Projects, ctx))?.projects ?? {}
    const project = Object.hasOwn(projects, projectId) ? projects[projectId] : undefined
    const resolve = await identityResolver(read, ctx)
    if ((await findIdentity(read, actor.author.account, ctx)) !== resolve(actor.author.identityId)) throw new AccessDenied('Requester identity changed')
    requireAccess(project, resolve, actor, privateIdentity, 'reader')
    return project!
  }
  async function mutate(tx: Tx, actor: ProjectActor, projectId: string, ctx: Context, minimum: Role = 'editor', adminAction = false, workItemId?: string) {
    if (actor.job && (!scopeAllows(actor.job.projectScope ?? [], projectId, workItemId) || adminAction))
      throw new AccessDenied('Mutation outside delegated scope')
    const read = transactionReader(tx)
    const privateIdentity = await audience(read, actor, ctx)
    const resolve = await identityResolver(tx, ctx)
    if ((await findIdentity(read, actor.author.account, ctx)) !== resolve(actor.author.identityId)) throw new AccessDenied('Requester identity changed')
    if (actor.job) {
      const job = (await jobs.readJob(tx, actor.job.id, ctx))!
      if (!actor.report && job.status !== 'running') throw new AccessDenied('Worker is not running')
      await checkScope(job, ctx, tx)
    }
    const projects = (await tx.doc(Projects)).projects
    const project = Object.hasOwn(projects, projectId) ? projects[projectId] : undefined
    const identityId = requireAccess(project, resolve, actor, privateIdentity, minimum, adminAction)
    return { project: project!, identityId, resolve }
  }
  async function checkDisclosure(disclosure: ProjectDisclosure, threadId: string | undefined, ctx: Context, tx?: Tx) {
    const read = tx ? transactionReader(tx) : getHarness()
    if (threadId !== undefined && (await chat.threadFor(read, disclosure.conversationId, ctx)) !== threadId)
      throw new AccessDenied('Project disclosure destination changed')
    const job = disclosure.jobId === undefined ? undefined : await jobs.readJob(read, disclosure.jobId, ctx)
    if (disclosure.jobId !== undefined) {
      if (!job || (await resolveIdentity(read, job.owner.identityId, ctx)) !== (await resolveIdentity(read, disclosure.author.identityId, ctx)))
        throw new AccessDenied('Project report origin changed')
      await checkScope(job, ctx, tx)
    }
    const owner: ProjectActor = { author: disclosure.author, conversationId: disclosure.conversationId, ...(job ? { job, report: true } : {}) }
    const project = await readProject(read, owner, disclosure.projectId, ctx)
    const privateIdentity = await audience(read, owner, ctx)
    requireAccess(project, await identityResolver(read, ctx), owner, privateIdentity, disclosure.minimum ?? 'reader')
    if (disclosure.private && privateIdentity !== (await resolveIdentity(read, disclosure.author.identityId, ctx)))
      throw new AccessDenied('Private project administration audience changed')
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
    if (!run?.inputs.length) throw new AccessDenied('Project disclosure requires an active run')
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
      const state = await tx.doc(LiveDoc, conversationId)
      const live = state.run
      if (!live || live.inputs[0] !== run.inputs[0]) throw new AccessDenied('Project disclosure run changed')
      const scopes = await tx.doc(ProjectDisclosures, conversationId)
      scopes.runs[run.inputs[0]!] ??= []
      const grants = scopes.runs[run.inputs[0]!]!
      for (const value of values) if (!grants.some(previous => JSON.stringify(previous) === JSON.stringify(value))) grants.push(value)
      // Tool reads authorize the next generation, not the already committed tool-calling message.
      if (!state.tools) scopes.generations[live.taskId] = grants.map(value => JSON.parse(JSON.stringify(value)))
    }, ctx)
  }
  async function guard(api: HookApi, ctx: Context, generation = false) {
    try {
      const values = await currentDisclosures(api, api.conversationId, ctx)
      for (const value of values) await checkDisclosure(value, undefined, ctx)
      if (generation)
        await getHarness().commit(async tx => {
          // Explicit empty is verified provenance too. Tool guards still recheck cumulative run grants,
          // but must not retag a message which has already committed.
          ;(await tx.doc(ProjectDisclosures, api.conversationId)).generations[api.taskId] = values.map(value => JSON.parse(JSON.stringify(value)))
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

export async function generationDisclosures(tx: Tx, conversationId: ConversationId, generationId: TaskId) {
  const values = (await tx.doc(ProjectDisclosures, conversationId)).generations[generationId]
  return values?.map(value => JSON.parse(JSON.stringify(value)) as ProjectDisclosure)
}
