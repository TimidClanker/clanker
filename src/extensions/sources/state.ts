import { defineDoc, type ConversationId, type TaskId } from '@earendil-works/pi-durable'
import type { Author } from 'extensions/identity'

export type Binding = {
  id: string
  owner: { identityId: string } | { projectId: string }
  principal: string
} & (
  | { provider: 'github'; repositoryId: string; secretEnv: string }
  | { provider: 'jira'; origin: string; projectId: string; secretEnv: string }
  | { provider: 'beeper'; accountId: string; chatIds?: string[] }
)
export type Observation = {
  id: string
  resource: string
  at: number
  receivedAt: number
  expiresAt: number
  kind: string
  actor: string
  text: string
  reference: string
  outgoing?: boolean
  originAt?: number
}
/** Historical transcript obligations, NOT source query capabilities or live event authority. */
export type SourceEvidence = { sourceId: string; binding: string; epoch: number; author: Author; conversationId: ConversationId }
export type Source = {
  name: string
  bindingId: string
  binding: string
  owner: Binding['owner']
  administrator: Author
  epoch: number
  revision: number
  active: boolean
  since: number
  context: boolean
  notify: boolean
  classifier?: string
  threshold: number
  highThreshold: number
  retentionDays: number
  audiences: ConversationId[]
  destination?: { conversationId: ConversationId; threadId: string; author: Author }
  quiet?: { timeZone: string; start: number; end: number; highBypass: boolean }
  recent: Observation[]
  latest: Record<string, Observation>
  pending: Record<string, { observation: Observation; task: TaskId; revision: number }>
  receipts: Record<string, number>
  outgoing: Record<string, number>
  versions: Record<string, number>
  floor: number
}
export const Sources = defineDoc<{ sources: Record<string, Source> }>({
  kind: 'sources.directory',
  version: 1,
  scope: 'session',
  checkpointWhen: () => true,
  initial: () => ({ sources: {} })
})
export const SourceCall = defineDoc<{ value?: { sourceId: string; revision: number } }>({
  kind: 'sources.call',
  version: 1,
  scope: 'task',
  initial: () => ({})
})
export const SourceDisclosures = defineDoc<{
  carry: SourceEvidence[]
  generations: Record<string, SourceEvidence[]>
  tools: Record<string, SourceEvidence[]>
  notifications: Record<string, SourceEvidence[]>
  reset?: number
}>({
  kind: 'sources.disclosures',
  version: 1,
  scope: 'conversation',
  // Forks of older model context must keep its obligations, including before a later reset.
  history: 'rewindable',
  fork: 'asOf',
  initial: () => ({ carry: [], generations: {}, tools: {}, notifications: {} })
})
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, value]) => [key, canonical(value)])
        )
      : value
export const fingerprint = (value: unknown) => new Bun.CryptoHasher('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export const bindingFingerprint = (binding: Binding) => fingerprint(binding)
export const neutral = (text: string) =>
  Buffer.from(text.replace(/@/g, '@\u200b').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''))
    .subarray(0, 3997)
    .toString('utf8')

export function prune(source: Source, now: number) {
  source.recent = source.recent.filter(event => event.expiresAt > now).slice(-50)
  for (const [key, event] of Object.entries(source.latest)) if (event.expiresAt <= now) delete source.latest[key]
  for (const [key, pending] of Object.entries(source.pending)) if (pending.observation.expiresAt <= now) delete source.pending[key]
  for (const [key, at] of Object.entries(source.receipts))
    if (at <= now - 7 * 86400_000) {
      source.floor = Math.max(source.floor, at)
      delete source.receipts[key]
    }
  const trim = <T>(values: Record<string, T>, limit: number, time: (value: T) => number) => {
    const entries = Object.entries(values).sort((a, b) => time(b[1]) - time(a[1]))
    for (const [key, value] of entries.slice(limit)) {
      source.floor = Math.max(source.floor, time(value))
      delete values[key]
    }
  }
  trim(source.latest, 50, event => event.at)
  trim(source.versions, 50, at => at)
  trim(source.receipts, 1000, at => at)
  trim(source.outgoing, 50, at => at)
}
