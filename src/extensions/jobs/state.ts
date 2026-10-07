import { defineDoc, type ConversationId, type EntryId, type TaskId } from '@earendil-works/pi-durable'
import type { Author } from 'extensions/identity'

export type Job = {
  id: TaskId
  conversationId: ConversationId
  sourceConversationId: ConversationId
  threadId: string
  owner: Author
  title: string
  instructions: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelling' | 'cancelled'
  revision: number
  createdAt: string
  updatedAt: string
  progress?: string
  question?: string
  result?: string
  reported?: EntryId
}

export const Jobs = defineDoc<{ jobs: Record<string, Job> }>({
  kind: 'jobs.directory',
  version: 1,
  scope: 'session',
  initial: () => ({ jobs: {} })
})
export const JobInputs = defineDoc<Record<string, number>>({
  kind: 'jobs.inputs',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({})
})
export const JobCall = defineDoc<{ id?: TaskId; revision?: number }>({
  kind: 'jobs.call',
  version: 1,
  scope: 'task',
  initial: () => ({})
})
export const active = (job: Job) => ['running', 'waiting', 'cancelling'].includes(job.status)
export const describeJob = ({ owner: _owner, conversationId: _child, reported: _answer, threadId: _thread, instructions: _instructions, ...job }: Job) => job

/** A background worker is the sole driver of a shared shell/browser until it finishes or is cancelled. */
export const WorkspaceJobs = defineDoc<Record<string, TaskId>>({
  kind: 'jobs.workspaces',
  version: 1,
  scope: 'session',
  initial: () => ({})
})
