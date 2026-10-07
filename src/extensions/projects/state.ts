import { defineDoc, type ConversationId } from '@earendil-works/pi-durable'

export type ProjectScope = { projectId: string; workItemIds?: string[] }[]
export type Role = 'admin' | 'editor' | 'reader'
type Provenance = { actor: string; conversationId: ConversationId; jobId?: number; createdAt: string; updatedAt: string; revision: number }
export type Knowledge = Provenance & { text: string; kind: 'fact' | 'decision' | 'proposal'; source?: string }
export type WorkItem = Provenance & {
  goal: string
  scope: string
  responsibleIdentityId?: string
  status: 'backlog' | 'active' | 'blocked' | 'review' | 'done' | 'cancelled'
  nextSteps: string
  blockers: string
  result: string
  references: string[]
}
export type Project = Provenance & {
  name: string
  overview: string
  resources: string[]
  members: Record<string, Role>
  shares: ConversationId[]
  knowledge: Record<string, Knowledge>
  workItems: Record<string, WorkItem>
}
export const Projects = defineDoc<{ projects: Record<string, Project> }>({
  kind: 'projects.directory',
  version: 1,
  scope: 'session',
  initial: () => ({ projects: {} })
})
export const ProjectContext = defineDoc<{ links: ProjectScope }>({
  kind: 'projects.context',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ links: [] })
})
export const ProjectCall = defineDoc<{
  value?: { projectId?: string; recordId?: string; revision?: number; changed?: boolean; deleted?: string; associated?: ProjectScope }
}>({ kind: 'projects.call', version: 1, scope: 'task', initial: () => ({}) })
