import { defineEntry, type TaskId } from '@earendil-works/pi-durable'
import type { Author } from 'extensions/identity'

/** Immutable report for the source conversation's coordinator; never a fresh user request. */
export const JobReported = defineEntry<{
  requestId: string
  jobId: TaskId
  threadId: string
  owner: Author
  title: string
  revision: number
  kind: string
  text: string
}>('jobs.reported')
