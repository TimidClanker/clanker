import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { Type } from '@earendil-works/pi-ai'
import { defineDoc, defineTask, defineTool, type ConversationId, type Harness, type TaskId, type ToolExecutionApi, type Tx } from '@earendil-works/pi-durable'
import type { Context } from '@earendil-works/chord'
import {
  accountKey,
  canonicalId,
  Directory,
  findIdentity,
  getRequestAuthor,
  linkIdentities,
  type Author,
  type PlatformAccount
} from 'extensions/identity/state'
import type { IdentityAccess } from 'extensions/identity/notes'

type Party = Author & { conversationId: ConversationId }
type LinkRequest = {
  id: string
  source: Party
  candidate?: Party
  offerHash: string
  confirmationHash?: string
  expiresAt: number
  status: 'offered' | 'claimed' | 'linked' | 'cancelled'
}
const Links = defineDoc<{
  requests: Record<string, LinkRequest>
  contacts: Record<string, Party>
  starts: Record<string, number[]>
  attempts: Record<string, number[]>
}>({ kind: 'identity.links', version: 1, scope: 'session', initial: () => ({ requests: {}, contacts: {}, starts: {}, attempts: {} }) })
const Audit = defineDoc<{
  events: Record<string, { action: 'link' | 'unlink'; actor: PlatformAccount; account: PlatformAccount; identityId: string; at: number }>
}>({
  kind: 'identity.account-audit',
  version: 1,
  scope: 'session',
  initial: () => ({ events: {} })
})
const Started = defineDoc<{ requestId?: string; noticeId?: TaskId<null> }>({ kind: 'identity.link-start', version: 1, scope: 'task', initial: () => ({}) })
const Unlinked = defineDoc<{ accountId?: string }>({ kind: 'identity.unlink', version: 1, scope: 'task', initial: () => ({}) })
const Commands = defineDoc<{ messages: Record<string, true> }>({
  kind: 'identity.link-commands',
  version: 1,
  scope: 'conversation',
  history: 'latest',
  fork: 'initial',
  initial: () => ({ messages: {} })
})
const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] })
const hash = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex')
const lifetime = 5 * 60_000

// Reconstruct delivery codes after a restart without storing them in tasks, transcripts, or tool results.
let secret: Promise<Buffer> | undefined
async function code(id: string, stage: string) {
  secret ??= (async () => {
    const path = resolve(process.env.SECRETS_DIR ?? './secrets', 'identity-link.key')
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    try {
      await writeFile(path, crypto.getRandomValues(new Uint8Array(32)), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    return readFile(path)
  })()
  return new Bun.CryptoHasher('sha256', await secret)
    .update(JSON.stringify([id, stage]))
    .digest('hex')
    .slice(0, 32)
}

function currentIdentity(directory: { identities: Record<string, { linkedTo?: string }>; accounts: Record<string, string> }, account: PlatformAccount) {
  return canonicalId(directory.identities, directory.accounts[accountKey(account)]!)
}

function linkedAccounts(
  directory: {
    identities: Record<string, { name: string; linkedTo?: string }>
    accounts: Record<string, string>
    accountNames?: Record<string, string>
  },
  identityId: string
) {
  return Object.entries(directory.accounts)
    .filter(([, id]) => canonicalId(directory.identities, id) === identityId)
    .map(([key, id]) => {
      const [platform, scope, userId] = JSON.parse(key) as [string, string, string]
      return {
        id: Buffer.from(key).toString('base64url'),
        account: { platform, scope, userId },
        displayName: directory.accountNames?.[key] ?? directory.identities[id]!.name
      }
    })
}

function allowAttempt(buckets: Record<string, number[]>, key: string, limit: number, duration: number) {
  const recent = (buckets[key] ?? []).filter(time => time > Date.now() - duration)
  buckets[key] = recent
  if (recent.length >= limit) return false
  recent.push(Date.now())
  return true
}

export const isAccountLinkCommand = (text: string) => /^\/?link(?:\s|$)/i.test(text.trim())

export function createAccountLinking(access: IdentityAccess, getHarness: () => Harness) {
  async function describe(party: Party, ctx: Context) {
    const label = await access.accountLabel(party.conversationId, party.account, ctx).catch(() => undefined)
    ctx.abortSignal?.throwIfAborted()
    return `${label ?? party.account.platform}: ${JSON.stringify(party.displayName)}`
  }

  const Notice = defineTask<
    { recipient: Party; text?: string; requestId?: string; kind?: 'offer' | 'challenge' | 'review' | 'linked' },
    { phase: 'send'; attempt: number; retryAt?: number },
    null
  >({
    name: 'identity.notify',
    version: 1,
    initial: () => ({ phase: 'send', attempt: 0 }),
    phases: {
      send: async (task, runtime, ctx) => {
        const { recipient, requestId, kind } = task.input
        const { attempt, retryAt } = task.state.checkpoint
        if (retryAt) await runtime.sleep(retryAt, ctx)
        let text = task.input.text
        if (requestId) {
          const request = (await runtime.snapshot(Links, ctx))?.requests[requestId]
          const expected = kind === 'offer' ? 'offered' : kind === 'linked' ? 'linked' : 'claimed'
          const detached =
            request?.status === 'linked' &&
            (await findIdentity(runtime, request.source.account, ctx)) !== (await findIdentity(runtime, request.candidate!.account, ctx))
          if (!request || request.status !== expected || detached || (kind !== 'linked' && request.expiresAt <= Date.now())) {
            await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
            return
          }
          if (kind === 'offer')
            text = `To link another account, send this command to Clanker in a private chat from that account:\nlink ${await code(request.id, 'offer')}\nExpires in five minutes. Only use this for an account you control. Linked accounts have access to your private information.`
          if (kind === 'challenge')
            text = `To link this account with ${await describe(request.source, ctx)}, return to the original private chat and send:\nlink confirm ${await code(request.id, accountKey(request.candidate!.account))}\nThis links both accounts and shares their private information. Do not share this code with anyone else.`
          if (kind === 'review')
            text = `Link requested from ${await describe(request.candidate!, ctx)}. If that is your account, enter the confirmation command sent there. This will share private notes across both accounts. Otherwise send: link cancel`
          if (kind === 'linked')
            text = `Accounts linked: ${await describe(request.source, ctx)} and ${await describe(request.candidate!, ctx)}. Private notes are now shared automatically in your one-to-one chats. You can ask me to list or unlink your accounts.`
        }
        try {
          await access.sendPrivate(recipient.conversationId, recipient.account, text!, ctx)
        } catch {
          ctx.abortSignal?.throwIfAborted()
          await runtime.commit(
            () =>
              attempt >= 3
                ? { status: 'terminal', outcome: { status: 'failed', error: { message: 'Could not deliver the private account-management message.' } } }
                : { status: 'running', checkpoint: { phase: 'send', attempt: attempt + 1, retryAt: runtime.now() + 1000 * 2 ** attempt } },
            ctx
          )
          return
        }
        await runtime.commit(() => ({ status: 'terminal', outcome: { status: 'completed', result: null } }), ctx)
      }
    },
    abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: 'terminal', outcome: { status: 'aborted' } }), ctx)
  })
  const notify = (tx: Tx, recipient: Party, message: { text?: string; requestId?: string; kind?: 'offer' | 'challenge' | 'review' | 'linked' }) =>
    tx.createTask(Notice, { recipient, ...message }, { conversationId: recipient.conversationId, ownership: { kind: 'conversation' }, background: true })

  async function requester(api: ToolExecutionApi, ctx: Context): Promise<Party> {
    const author = await getRequestAuthor(api, getHarness(), ctx)
    const recipient = await access.privateAccount(api, api.conversationId, ctx)
    if (!recipient || accountKey(recipient) !== accountKey(author.account))
      throw new Error('Account management requires a private chat with the requesting user.')
    return { ...author, conversationId: api.conversationId }
  }

  async function begin(tx: Tx, source: Party) {
    const links = await tx.doc(Links)
    const directory = await tx.doc(Directory)
    if (currentIdentity(directory, source.account) !== source.identityId) throw new Error('Your account changed; please request linking again.')
    if (!allowAttempt(links.starts, accountKey(source.account), 5, 60 * 60_000)) throw new Error('Too many linking requests. Please try again in an hour.')
    for (const request of Object.values(links.requests)) {
      if (accountKey(request.source.account) === accountKey(source.account) && request.status !== 'linked') request.status = 'cancelled'
    }
    const id = crypto.randomUUID()
    links.requests[id] = { id, source, offerHash: hash(await code(id, 'offer')), expiresAt: Date.now() + lifetime, status: 'offered' }
    links.contacts[accountKey(source.account)] = source
    return { requestId: id, noticeId: await notify(tx, source, { requestId: id, kind: 'offer' }) }
  }

  return {
    tasks: [Notice],
    tools: [
      defineTool({
        name: 'begin_account_link',
        description:
          'Start linking another account only when the user asks. Requires a private, authenticated user request. The application sends the secret code directly; you only receive delivery status. Never ask for or process confirmation codes yourself.',
        parameters: Type.Object({}),
        replay: 'safe',
        executionMode: 'sequential',
        execute: async (_args, api, ctx) => {
          let receipt = await api.snapshot(Started, api.taskId, ctx)
          if (!receipt?.requestId) {
            const source = await requester(api, ctx)
            receipt = await api.commit(async tx => {
              const saved = await tx.doc(Started, api.taskId)
              if (!saved.requestId) Object.assign(saved, await begin(tx, source))
              return { ...saved }
            }, ctx)
          }
          const delivery = await api.waitForTask(receipt.noticeId!, ctx)
          if (delivery.state.outcome.status !== 'completed') throw new Error('The linking code could not be delivered. Please try again.')
          const request = (await api.snapshot(Links, ctx))!.requests[receipt.requestId!]!
          return result({
            status:
              request.status === 'linked'
                ? 'linked'
                : request.expiresAt <= Date.now()
                  ? 'expired'
                  : request.status === 'offered'
                    ? 'code_sent'
                    : request.status,
            expiresAt: new Date(request.expiresAt).toISOString(),
            instructions: 'Follow the application messages in the two private chats. Codes and confirmation are handled by the application.'
          })
        }
      }),
      defineTool({
        name: 'list_linked_accounts',
        description:
          'Show the verified requesting user the accounts linked to their identity. Private chats only. Never enumerate another person’s accounts. Show label to the user; accountId is an internal reference for unlink_account, not a display ID. current identifies the account used for this conversation.',
        parameters: Type.Object({}),
        replay: 'safe',
        execute: async (_args, api, ctx) => {
          const source = await requester(api, ctx)
          const directory = (await api.snapshot(Directory, ctx))!
          if (currentIdentity(directory, source.account) !== source.identityId) throw new Error('Your account changed; please ask again.')
          const contacts = (await api.snapshot(Links, ctx))?.contacts ?? {}
          return result({
            accounts: await Promise.all(
              linkedAccounts(directory, source.identityId).map(async ({ id, account, displayName }) => ({
                accountId: id,
                label: await describe(
                  { ...source, conversationId: contacts[accountKey(account)]?.conversationId ?? source.conversationId, account, displayName },
                  ctx
                ),
                current: accountKey(account) === accountKey(source.account)
              }))
            )
          })
        }
      }),
      defineTool({
        name: 'unlink_account',
        description:
          'Unlink one account only when the user explicitly asks to remove it. Use an exact accountId from list_linked_accounts; ask which account if ambiguous. Requires a private request from the same identity. The detached account gets a new identity with no shared notes; notes stay with the remaining identity. Existing chat messages are not erased. Cannot remove the last account.',
        parameters: Type.Object({ accountId: Type.String({ minLength: 1 }) }),
        replay: 'safe',
        executionMode: 'sequential',
        execute: async ({ accountId }, api, ctx) => {
          const receipt = await api.snapshot(Unlinked, api.taskId, ctx)
          if (receipt?.accountId) return result({ unlinked: true, accountId: receipt.accountId })
          const source = await requester(api, ctx)
          const directory = (await api.snapshot(Directory, ctx))!
          const target = linkedAccounts(directory, source.identityId).find(account => account.id === accountId)
          if (!target) throw new Error('That account is not linked to your identity.')
          const contact = (await api.snapshot(Links, ctx))?.contacts[accountKey(target.account)]
          const label = await describe({ ...source, ...contact, account: target.account, displayName: target.displayName }, ctx)
          await api.commit(async tx => {
            const receipt = await tx.doc(Unlinked, api.taskId)
            if (receipt.accountId) return
            const directory = await tx.doc(Directory)
            if (currentIdentity(directory, source.account) !== source.identityId) throw new Error('Your account changed; please ask again.')
            const accounts = linkedAccounts(directory, source.identityId)
            const target = accounts.find(account => account.id === accountId)
            if (!target) throw new Error('That account is not linked to your identity.')
            if (accounts.length === 1) throw new Error('This is the only account on your identity; there is no link to remove.')
            const key = accountKey(target.account)
            const id = crypto.randomUUID()
            directory.identities[id] = { name: target.displayName }
            directory.accounts[key] = id
            const links = await tx.doc(Links)
            for (const request of Object.values(links.requests)) {
              if (
                request.status !== 'linked' &&
                (accountKey(request.source.account) === key || (request.candidate && accountKey(request.candidate.account) === key))
              )
                request.status = 'cancelled'
            }
            ;(await tx.doc(Audit)).events[crypto.randomUUID()] = {
              action: 'unlink',
              actor: source.account,
              account: target.account,
              identityId: source.identityId,
              at: Date.now()
            }
            const text = `Account unlinked: ${label}. It now has a separate identity. Shared notes stay with the remaining identity; past chat messages are unchanged.`
            await notify(tx, source, { text })
            const contact = links.contacts[key]
            if (contact && key !== accountKey(source.account)) await notify(tx, contact, { text })
            receipt.accountId = accountId
          }, ctx)
          return result({ unlinked: true, accountId })
        }
      })
    ],
    // Only authenticated message intake calls this. No model tool can supply a code or complete a link.
    async handle(tx: Tx, party: Party, messageId: string, text: string) {
      const commands = await tx.doc(Commands, party.conversationId)
      const messageKey = JSON.stringify([accountKey(party.account), messageId])
      if (commands.messages[messageKey]) return
      commands.messages[messageKey] = true
      const links = await tx.doc(Links)
      const reply = (text: string) => notify(tx, party, { text })
      if (!allowAttempt(links.attempts, accountKey(party.account), 10, lifetime)) {
        await reply('Too many linking attempts. Please wait five minutes.')
        return
      }
      const input = text.trim().replace(/^\//, '').split(/\s+/)
      const action = input[1]?.toLowerCase()
      if (action === 'start' && input.length === 2) {
        await begin(tx, party)
        return
      }
      if (action === 'cancel' && input.length === 2) {
        for (const request of Object.values(links.requests)) {
          if (
            request.status !== 'linked' &&
            (accountKey(request.source.account) === accountKey(party.account) ||
              (request.candidate && accountKey(request.candidate.account) === accountKey(party.account)))
          )
            request.status = 'cancelled'
        }
        await reply('Pending account-link requests cancelled.')
        return
      }
      const confirming = action === 'confirm'
      const token = confirming ? input[2] : input[1]
      const digest = hash(token ?? '')
      const request = Object.values(links.requests).find(
        request =>
          request.expiresAt > Date.now() &&
          (confirming
            ? request.status === 'claimed' &&
              request.confirmationHash === digest &&
              accountKey(request.source.account) === accountKey(party.account) &&
              request.source.conversationId === party.conversationId
            : request.status === 'offered' && request.offerHash === digest)
      )
      if (!request || input.length !== (confirming ? 3 : 2)) {
        await reply('That linking command is invalid, expired, or already used. Ask me to start a new link, or send: link start')
        return
      }
      const directory = await tx.doc(Directory)
      if (currentIdentity(directory, request.source.account) !== request.source.identityId) {
        request.status = 'cancelled'
        await reply('The originating account changed. Please start a new link.')
        return
      }
      if (!confirming) {
        if (party.identityId === request.source.identityId) {
          await reply('These accounts already belong to the same identity.')
          return
        }
        if (linkedAccounts(directory, party.identityId).length !== 1) {
          await reply('This account is already linked elsewhere. Unlink it from that identity before adding it here.')
          return
        }
        request.candidate = party
        request.confirmationHash = hash(await code(request.id, accountKey(party.account)))
        request.status = 'claimed'
        links.contacts[accountKey(party.account)] = party
        await notify(tx, party, { requestId: request.id, kind: 'challenge' })
        await notify(tx, request.source, { requestId: request.id, kind: 'review' })
        return
      }
      const candidate = request.candidate!
      if (currentIdentity(directory, candidate.account) !== candidate.identityId || linkedAccounts(directory, candidate.identityId).length !== 1) {
        request.status = 'cancelled'
        await reply('The other account changed. Please start a new link.')
        return
      }
      await linkIdentities(tx, request.source.identityId, candidate.identityId)
      request.status = 'linked'
      ;(await tx.doc(Audit)).events[request.id] = {
        action: 'link',
        actor: party.account,
        account: candidate.account,
        identityId: request.source.identityId,
        at: Date.now()
      }
      await notify(tx, request.source, { requestId: request.id, kind: 'linked' })
      await notify(tx, candidate, { requestId: request.id, kind: 'linked' })
    }
  }
}
