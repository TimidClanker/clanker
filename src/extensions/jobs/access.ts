import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, EntryRecord, TaskId, Tx, ToolExecutionApi, Harness } from '@earendil-works/pi-durable'
import { AccessDenied } from 'access'
import type { JobAccess } from 'extensions/jobs/task'
import { getDelegation, accountKey, getRequestActors, resolveIdentity, getBackgroundInputJobs } from 'extensions/identity'
import { active, Jobs, JobAnswerScopes, WorkspaceJobs, type Job } from 'extensions/jobs/state'
import { JobReported } from 'extensions/jobs/events'

export async function readJob(read: DocumentReader | Tx, id: TaskId, ctx: Context): Promise<Job | undefined> {
  const directory = 'doc' in read ? await read.doc(Jobs) : await read.snapshot(Jobs, ctx)
  const job = directory?.jobs[id]
  return job && JSON.parse(JSON.stringify(job))
}

export async function generationJobs(tx: Tx, conversationId: ConversationId, generationId: TaskId) {
  const jobs = (await tx.doc(JobAnswerScopes, conversationId)).generations[generationId]
  return jobs?.slice()
}

/** Recognize host reports and bind them to their job without reinterpreting their recorded revision or text. */
export async function readJobReport(tx: Tx, entry: EntryRecord, ctx: Context) {
  if (!JobReported.is(entry)) return
  const report = entry.data
  const job = await readJob(tx, report.jobId, ctx)
  const producer = entry.byTaskId === undefined ? undefined : await tx.task(entry.byTaskId)
  const fromWorker =
    producer?.kind === 'pi.tool' &&
    producer.conversationId === job?.conversationId &&
    (await getDelegation(tx, producer.conversationId, ctx))?.jobId === report.jobId
  const fromJob =
    producer &&
    ['jobs.message', 'jobs.cancel'].includes(producer.kind) &&
    producer.conversationId === entry.conversationId &&
    (producer.input as { id: number }).id === report.jobId
  if (
    !job ||
    job.sourceConversationId !== entry.conversationId ||
    job.threadId !== report.threadId ||
    job.owner.identityId !== report.owner.identityId ||
    accountKey(job.owner.account) !== accountKey(report.owner.account) ||
    (!fromWorker && !fromJob)
  )
    throw new Error('Background report origin unavailable')
  return report
}

/** Check and claim on the caller's transaction so job state cannot change between them. */
export async function reserveWorkspace(tx: Tx, workspaceId: string, jobId?: TaskId) {
  const leases = await tx.doc(WorkspaceJobs)
  const jobs = (await tx.doc(Jobs)).jobs
  const holder = jobs[leases[workspaceId]!]
  if (holder && active(holder) && holder.id !== jobId) {
    throw new Error(`Sandbox is reserved by background task “${holder.title}”. Steer or cancel it before using this workspace.`)
  }
  if (jobId !== undefined) {
    if (jobs[jobId]?.status !== 'running') throw new Error('Background task is not running')
    leases[workspaceId] = jobId
  } else delete leases[workspaceId]
}

/** Shared read-only authorization for job lists and operational status. */
export function jobVisibility(chat: Pick<JobAccess, 'privateIdentity' | 'checkScope'>, getHarness: () => Harness) {
  const requester = async (api: ToolExecutionApi, ctx: Context) => {
    // Internal reports can let the coordinator clarify an existing job, but cannot create fresh user-owned work.
    const actors = await getRequestActors(api, getHarness(), api.conversationId, ctx, true)
    if (!actors.length || new Set(actors.map(actor => actor.identityId)).size !== 1) throw new Error('This action requires one verified task owner')
    return actors.at(-1)!
  }
  const scopeVisible = async (job: Job, ctx: Context) => {
    try {
      await chat.checkScope(job, ctx)
      return true
    } catch (error) {
      ctx.abortSignal?.throwIfAborted()
      if (!(error instanceof AccessDenied)) throw error
      return false
    }
  }
  const page = async (api: ToolExecutionApi, ctx: Context, includeRevoked = false, limit = Infinity) => {
    const author = await requester(api, ctx)
    const privateIdentity = await chat.privateIdentity(api, api.conversationId, ctx)
    const jobs = Object.values((await api.snapshot(Jobs, ctx))?.jobs ?? {})
    const authorized = await getRequestActors(api, getHarness(), api.conversationId, ctx, 'schedules')
    const reports = authorized.length ? undefined : await getBackgroundInputJobs(api, getHarness(), api.conversationId, ctx)
    const allowed = await Promise.all(
      jobs.map(
        async job =>
          (!reports || (reports.length === 1 && reports[0] === job.id)) &&
          (await resolveIdentity(api, job.owner.identityId, ctx)) === author.identityId &&
          (privateIdentity === author.identityId || job.sourceConversationId === api.conversationId)
      )
    )
    const candidates = jobs.filter((_, index) => allowed[index])
    const visible = limit === Infinity ? candidates : candidates.toReversed().slice(0, limit)
    const truncated = candidates.length > limit
    if (includeRevoked) return { jobs: visible, truncated }
    const scoped = await Promise.all(visible.map(job => scopeVisible(job, ctx)))
    return { jobs: visible.filter((_, index) => scoped[index]), truncated }
  }
  return { page, visible: async (api: ToolExecutionApi, ctx: Context, includeRevoked = false) => (await page(api, ctx, includeRevoked)).jobs, scopeVisible }
}
