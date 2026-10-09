import type { Context } from '@earendil-works/chord'
import type { ConversationId, DocumentReader, EntryRecord, TaskId, Tx } from '@earendil-works/pi-durable'
import { getDelegation, accountKey } from 'extensions/identity'
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
