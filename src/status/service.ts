import type { Context } from '@earendil-works/chord'
import { awaitWithContext, withAbortSignal } from '@earendil-works/chord/context'
import type { ToolExecutionApi, TaskRecord } from '@earendil-works/pi-durable'
import { AccessDenied } from 'access'
import { getDelegation, getRequestAuthor } from 'extensions/identity'
import { active, Jobs, WorkspaceJobs, type Job } from 'extensions/jobs/state'
import { jobVisibility } from 'extensions/jobs/access'
import type { JobAccess } from 'extensions/jobs/task'
import { visibleSchedules } from 'extensions/schedules/access'
import type { ScheduleInput, ScheduleState } from 'extensions/schedules/task'
import { build } from 'status/build'
import type { RuntimeStatus } from 'status/runtime'

export const statusReadMs = 1500
const limit = 50
const jobSummary = (job: Job, reservations: Readonly<Record<string, number>>, model: boolean) => ({
  id: job.id,
  // No project content/disclosure grants are introduced by this read-only route.
  title: model && job.projectScope?.length ? 'Project task (title redacted)' : job.title.slice(0, 100),
  status: job.status,
  revision: job.revision,
  createdAt: job.createdAt,
  updatedAt: job.updatedAt,
  // An old timestamp is not evidence of a stuck job. Questions/progress/results are deliberately excluded.
  waitingForCoordinator: job.status === 'waiting',
  reservesWorkspace: active(job) && Object.values(reservations).includes(job.id)
})
function scheduleSummary(record: TaskRecord<unknown, unknown, unknown>) {
  const task = record as TaskRecord<ScheduleInput, ScheduleState, unknown>
  const state = task.state
  const terminal = state.status === 'terminal' || state.status === 'completing'
  return {
    id: task.id,
    title: task.input.title.slice(0, 100),
    status: state.status,
    abortRequested: task.abortRequested,
    startedAt: task.startedAt ?? null,
    endedAt: task.endedAt ?? null,
    ...(terminal
      ? { outcome: state.outcome.status }
      : {
          phase: state.checkpoint.phase,
          nextAt: new Date(state.checkpoint.at).toISOString(),
          ...(state.checkpoint.phase === 'sleep' && state.checkpoint.last
            ? { last: { at: state.checkpoint.last.at, finishedAt: state.checkpoint.last.finishedAt, status: state.checkpoint.last.status } }
            : {})
        })
  }
}

/** One service for model and local operator views. Operator authority is transport-only, never a tool argument. */
export function createStatusService(runtime: RuntimeStatus, sandboxConfigured: boolean) {
  let pending = false
  const startedAt = new Date(Date.now() - process.uptime() * 1000).toISOString()
  async function collect(ctx: Context, scope?: { api: ToolExecutionApi; chat: Pick<JobAccess, 'privateIdentity' | 'checkScope'> }) {
    const before = runtime.capture()
    const readStartedAt = new Date().toISOString()
    const base = () => {
      const now = runtime.capture()
      return {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        build,
        process: { startedAt, uptimeSeconds: Math.floor(process.uptime()) },
        runtime: { phase: now.phase, epoch: now.epoch, changedAt: now.changedAt, recentEvents: now.events },
        sandbox: { configured: sandboxConfigured, availability: 'unknown', cleanupHistory: 'not_recorded' },
        limits: { recordsPerSection: limit, history: 'bounded schedule scan and recorded job state; no causal diagnosis, heartbeat or stuck detection' }
      }
    }
    if (scope && !before.current) throw new AccessDenied('Status runtime is not ready for authorization')
    if (!before.current) return { ...base(), evidence: { status: 'unavailable', readStartedAt, readFinishedAt: new Date().toISOString() } }
    const { harness, scanTasks } = before.current
    const signal = AbortSignal.any([AbortSignal.timeout(statusReadMs), ...(ctx.abortSignal ? [ctx.abortSignal] : [])])
    const readCtx = withAbortSignal(signal, ctx)
    if (pending) {
      if (scope) throw new AccessDenied('Status reader is busy; try again later')
      return { ...base(), evidence: { status: 'unknown', reason: 'reader_busy', readStartedAt, readFinishedAt: new Date().toISOString() } }
    }
    pending = true
    let accessChecked = !scope
    try {
      const work = async () => {
        // Check delegation/provenance before ANY global or private return, including degraded results.
        if (scope) {
          if ((await getDelegation(scope.api, scope.api.conversationId, readCtx))?.jobId)
            throw new AccessDenied('Status is not available to background workers')
          await getRequestAuthor(scope.api, harness, readCtx, true)
          accessChecked = true
        }
        const [directory, reservations, page, inspection] = await Promise.all([
          harness.snapshot(Jobs, readCtx),
          harness.snapshot(WorkspaceJobs, readCtx),
          scanTasks({ kind: 'schedules.run', order: 'descending' }, limit, undefined, readCtx),
          harness.inspect(readCtx)
        ])
        const jobPage = scope
          ? await jobVisibility(scope.chat, () => harness).page(scope.api, readCtx, false, limit)
          : {
              jobs: Object.values(directory?.jobs ?? {})
                .toReversed()
                .slice(0, limit),
              truncated: Object.keys(directory?.jobs ?? {}).length > limit
            }
        const schedules = scope ? await visibleSchedules(page.items, scope.api, scope.api.conversationId, scope.chat, readCtx) : page.items
        return {
          jobs: {
            items: jobPage.jobs.map(job => jobSummary(job, reservations ?? {}, !!scope)),
            truncated: jobPage.truncated
          },
          // Do not leak even a global schedule-count threshold to a model audience.
          schedules: { items: schedules.map(scheduleSummary), truncated: scope ? 'unknown' : !!page.next },
          scheduling: inspection.scheduling
        }
      }
      const data = await awaitWithContext(
        work().finally(() => {
          pending = false
        }),
        readCtx
      )
      const after = runtime.capture()
      if (before.current !== after.current || after.phase !== 'ready')
        return { ...base(), evidence: { status: 'unknown', reason: 'runtime_changed', readStartedAt, readFinishedAt: new Date().toISOString() } }
      return { ...base(), evidence: { status: 'available', readStartedAt, readFinishedAt: new Date().toISOString(), storageHealth: 'not_probed' }, ...data }
    } catch (error) {
      if (error instanceof AccessDenied) throw new AccessDenied('Status is not accessible to this requester or audience')
      // Never expose a raw error, including a reader/provider/auth exception.
      if (!accessChecked) throw new AccessDenied('Status authorization could not be verified')
      return {
        ...base(),
        evidence: {
          status: 'unknown',
          reason: signal.aborted ? 'read_timeout_or_cancelled' : 'read_failed',
          readStartedAt,
          readFinishedAt: new Date().toISOString()
        }
      }
    }
  }
  return {
    operator: (ctx: Context) => collect(ctx),
    model: (api: ToolExecutionApi, chat: Pick<JobAccess, 'privateIdentity' | 'checkScope'>, ctx: Context) => collect(ctx, { api, chat })
  }
}
export type StatusService = ReturnType<typeof createStatusService>
