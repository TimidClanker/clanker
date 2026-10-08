import { createHmac, timingSafeEqual } from 'node:crypto'
import type BeeperDesktop from '@beeper/desktop-api'
import { bindingFingerprint, fingerprint, neutral, type Binding, type Observation } from 'extensions/sources/state'

export type Intake = Omit<Observation, 'receivedAt' | 'expiresAt'> & { bodyHash?: string }
export type Ingest = (binding: Binding, event: Intake) => Promise<{ status: 'admitted' | 'duplicate' | 'excluded' | 'inactive' }>
const string = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
const time = (value: unknown) => {
  const at = typeof value === 'number' ? value : Date.parse(string(value))
  if (!Number.isFinite(at)) throw new Error('Missing event timestamp')
  return at
}

/** GH: docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
 * Jira: developer.atlassian.com/cloud/jira/platform/webhooks/#secure-admin-webhooks
 * Only secret-signed secure-admin Jira Cloud hooks, NOT Connect/OAuth JWT hooks. */
export function createWebhookAdapter(bindings: Binding[], ingest: Ingest, secret: (name: string) => string | undefined = name => process.env[name]) {
  return async (request: Request, bindingId: string) => {
    const binding = bindings.find(binding => binding.id === bindingId && binding.provider !== 'beeper')
    if (!binding || binding.provider === 'beeper') return new Response('Not found', { status: 404 })
    if (request.method !== 'POST') return new Response('POST required', { status: 405 })
    const key = secret(binding.secretEnv)
    if (!key) return new Response('Unavailable', { status: 503 })
    const header = request.headers.get(binding.provider === 'github' ? 'x-hub-signature-256' : 'x-hub-signature')
    if (!header || !/^sha256=[a-f0-9]{64}$/.test(header)) return new Response('Unauthorized', { status: 401 })
    if (Number(request.headers.get('content-length')) > 262144) return new Response('Payload too large', { status: 413 })
    const reader = request.body?.getReader()
    if (!reader) return new Response('Invalid body', { status: 400 })
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 262144) {
        await reader.cancel()
        return new Response('Payload too large', { status: 413 })
      }
      chunks.push(value)
    }
    const bytes = Buffer.concat(chunks)
    const expected = createHmac('sha256', key).update(bytes).digest()
    if (!timingSafeEqual(expected, Buffer.from(header.slice(7), 'hex'))) return new Response('Unauthorized', { status: 401 })
    let event: Intake | undefined
    try {
      const payload = object(JSON.parse(bytes.toString('utf8')))
      if (binding.provider === 'github') {
        const repository = object(payload.repository)
        if (string(repository.id) !== binding.repositoryId) return new Response('Resource mismatch', { status: 403 })
        const kind = request.headers.get('x-github-event')
        if (kind !== 'issues' && kind !== 'pull_request') return Response.json({ status: 'excluded', reason: 'unsupported event' })
        const issue = object(kind === 'issues' ? payload.issue : payload.pull_request)
        const action = string(payload.action)
        if (
          ![
            'opened',
            'edited',
            'closed',
            'reopened',
            'assigned',
            'unassigned',
            'labeled',
            'unlabeled',
            'synchronize',
            'ready_for_review',
            'converted_to_draft'
          ].includes(action)
        )
          return Response.json({ status: 'excluded', reason: 'unsupported action' })
        const number = string(issue.number)
        if (!/^\d+$/.test(number) || !/^\d{1,30}$/.test(string(issue.id))) throw new Error('Missing issue')
        const at = time(issue.updated_at)
        const resource = `${kind}:${string(issue.id)}`
        // Never fetch or trust payload URLs. Build a safe GitHub reference from validated repository coordinates.
        const fullName = string(repository.full_name)
        if (fullName.length > 141 || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fullName)) throw new Error('Invalid repository')
        event = {
          id: fingerprint([kind, resource, action, at, issue]),
          resource,
          at,
          kind: `${kind}.${action}`,
          actor: neutral(string(object(payload.sender).login)).slice(0, 200),
          text: neutral(`${string(issue.title)} — ${string(issue.state)}${issue.merged ? ' (merged)' : ''}\n${string(issue.body)}`),
          reference: `https://github.com/${fullName}/${kind === 'issues' ? 'issues' : 'pull'}/${number}`
        }
      } else {
        const kind = string(payload.webhookEvent)
        if (!['jira:issue_created', 'jira:issue_updated', 'jira:issue_deleted'].includes(kind))
          return Response.json({ status: 'excluded', reason: 'unsupported event' })
        const issue = object(payload.issue),
          fields = object(issue.fields)
        const self = new URL(string(issue.self))
        if (self.origin !== binding.origin || string(object(fields.project).id) !== binding.projectId) return new Response('Resource mismatch', { status: 403 })
        const key = string(issue.key),
          resource = string(issue.id)
        if (!/^[A-Z][A-Z0-9_]*-\d+$/.test(key) || !/^\d{1,30}$/.test(resource)) throw new Error('Invalid issue')
        const at = time(payload.timestamp)
        event = {
          id: fingerprint([kind, resource, at, payload.changelog, fields]),
          resource,
          at,
          kind,
          actor: neutral(string(object(payload.user).displayName)).slice(0, 200),
          text: neutral(
            `${key}: ${string(fields.summary)} — ${kind === 'jira:issue_deleted' ? 'deleted' : string(object(fields.status).name)}\n${string(fields.description)}`
          ),
          reference: `${binding.origin}/browse/${key}`
        }
      }
      event.bodyHash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    } catch {
      return new Response('Invalid payload', { status: 400 })
    }
    try {
      // Unsigned delivery IDs are never the sole dedup key. Admission commits before ACK.
      return Response.json(await ingest(binding, event))
    } catch {
      return new Response('Intake unavailable; retry', { status: 503 })
    }
  }
}

export function createBeeperObserver(bindings: Binding[], ingest: Ingest, active?: () => Promise<Array<string | { id: string; since: number }>>) {
  const selected = bindings.filter((binding): binding is Binding & { provider: 'beeper' } => binding.provider === 'beeper')
  return {
    accountIDs: [...new Set(selected.map(binding => binding.accountId))],
    async selections() {
      const ids = active ? await active() : selected.map(binding => binding.id)
      return selected.filter(binding => ids.some(value => (typeof value === 'string' ? value : value.id) === binding.id))
    },
    async since(bindingId: string) {
      const value = (await active?.())?.find(value => (typeof value === 'string' ? value : value.id) === bindingId)
      return typeof value === 'object' ? value.since : 0
    },
    async activeAccountIDs() {
      return [...new Set((await this.selections()).map(binding => binding.accountId))]
    },
    async receive(message: BeeperDesktop.Message) {
      for (const binding of await this.selections()) {
        if (binding.accountId !== message.accountID || (binding.chatIds && !binding.chatIds.includes(message.chatID))) continue
        if (message.isDeleted || message.isHidden || ['REACTION', 'NOTICE'].includes(message.type ?? '')) continue
        await ingest(binding, {
          id: fingerprint([bindingFingerprint(binding), message.chatID, message.id, message.editedTimestamp ?? message.timestamp]),
          resource: message.chatID,
          at: time(message.editedTimestamp ?? message.timestamp),
          originAt: time(message.timestamp),
          kind: message.isSender ? 'message.outgoing' : 'message.incoming',
          outgoing: !!message.isSender,
          actor: neutral(message.isSender ? 'Owner' : (message.senderName ?? message.senderID)).slice(0, 200),
          text: neutral(message.text ?? ''),
          reference: `Beeper message ${neutral(message.id).slice(0, 500)}`
        })
      }
    }
  }
}

export async function sourceBindings(path = process.env.SOURCES_CONFIG): Promise<Binding[]> {
  if (!path) return []
  const values = (await Bun.file(path).json()) as Binding[]
  if (!Array.isArray(values) || values.length > 50) throw new Error('SOURCES_CONFIG must contain at most 50 explicit bindings')
  const ids = new Set<string>()
  for (const binding of values) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(binding.id) ||
      ids.has(binding.id) ||
      !binding.principal ||
      !binding.owner ||
      !('identityId' in binding.owner ? binding.owner.identityId : binding.owner.projectId)
    )
      throw new Error('Invalid source binding')
    ids.add(binding.id)
    if (binding.provider === 'jira' && new URL(binding.origin).origin !== binding.origin) throw new Error('Jira origin must be an exact HTTPS origin')
    if (binding.provider === 'jira' && !binding.origin.startsWith('https://')) throw new Error('Jira requires HTTPS')
    if (binding.provider !== 'github' && binding.provider !== 'jira' && binding.provider !== 'beeper') throw new Error('Unsupported source provider')
    if (binding.provider === 'beeper' && 'projectId' in binding.owner) throw new Error('Personal Beeper observers require an identity owner, not a project')
    if (binding.provider === 'beeper' && (!binding.accountId || (binding.chatIds && (!binding.chatIds.length || binding.chatIds.length > 50))))
      throw new Error('Invalid observer selection')
    if (binding.provider !== 'beeper' && !/^[A-Z][A-Z0-9_]*$/.test(binding.secretEnv)) throw new Error('Use a host ENV secret reference')
  }
  return values
}
