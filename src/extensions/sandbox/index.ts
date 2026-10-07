import type { Context } from '@earendil-works/chord'
import {
  defineExtension,
  GenerationTask,
  hook,
  section,
  type ConversationId,
  type DocumentReader,
  type Harness,
  type ToolRegistration
} from '@earendil-works/pi-durable'
import { createBashTool, createEditTool, createReadTool, createWriteTool } from '@earendil-works/pi-durable/tools'
import { Delegation, sourceConversation, findIdentity, getIdentity, getRequestActors, type PlatformAccount } from 'extensions/identity'
import { active, Jobs, WorkspaceJobs } from 'extensions/jobs/state'
import { createWorkspaces } from 'extensions/sandbox/workspaces'
import { ownerKey, Workspaces, type SandboxOwner } from 'extensions/sandbox/state'
import type { SandboxProvider } from 'extensions/sandbox/providers'
import { DesktopTool } from 'extensions/sandbox/desktop'
import { ImageTool } from 'extensions/sandbox/image'

export type SandboxAccess = {
  /** Verify every requester's membership; return the recipient for private chats, null for groups. */
  audience(read: DocumentReader, conversationId: ConversationId, accounts: PlatformAccount[], ctx: Context): Promise<PlatformAccount | null>
}
type Grant = { accounts: PlatformAccount[] } | { error: string }

export function createSandbox(access: SandboxAccess, getHarness: () => Harness, provider: SandboxProvider, idleMs = 300_000) {
  const workspaces = createWorkspaces(provider, idleMs)
  const bash = createBashTool()
  const shell: typeof bash = {
    ...bash,
    description: `${bash.description} Sandbox timeout defaults to 120 seconds and is capped at 600 seconds.`,
    execute: (args, api, ctx) => bash.execute({ ...args, timeout: Math.min(args.timeout ?? 120, 600) }, api, ctx)
  }
  const bind = <T extends ToolRegistration>(tool: T): T => ({
    ...tool,
    replay: 'unsafe',
    executionMode: 'sequential',
    async execute(args, api, ctx) {
      const task = (await api.getTask(api.taskId, ctx))!
      const generation = task.owner === undefined ? undefined : await api.getTask(task.owner, ctx)
      const grant = generation?.memos?.['sandbox.grant'] as Grant | undefined
      if (!grant || 'error' in grant) throw new Error(grant && 'error' in grant ? grant.error : 'No verified sandbox owner for this model round')
      if (!grant.accounts.length) throw new Error('Sandbox access requires a verified requester')
      const recipient = await access.audience(api, api.conversationId, grant.accounts, ctx)
      let owner: SandboxOwner = { kind: 'conversation', id: String(await sourceConversation(api, api.conversationId, ctx)) }
      if (recipient) {
        const id = await findIdentity(api, recipient, ctx)
        if (!id || (await Promise.all(grant.accounts.map(account => findIdentity(api, account, ctx)))).some(author => author !== id)) {
          throw new Error('Private sandbox access requires the verified recipient')
        }
        owner = { kind: 'identity', ...(await getIdentity(api, id, ctx)) }
      }
      const key = ownerKey(owner)
      const delegation = await api.snapshot(Delegation, api.conversationId, ctx)
      const workspace = await api.commit(async tx => {
        const all = await tx.doc(Workspaces)
        const previous = [
          ...new Map(
            (owner.aliases ?? []).flatMap(id => {
              const saved = all[ownerKey({ ...owner, id })]
              return saved ? [[saved.id, saved] as const] : []
            })
          ).values()
        ]
        if (!all[key] && previous.length > 1) throw new Error('Linked identities have multiple workspaces; choose a workspace before continuing')
        const saved = (all[key] ??= previous[0] ?? { id: `clanker-${crypto.randomUUID()}`, provider: provider.name })
        if (saved.provider !== provider.name) throw new Error(`This workspace uses the ${saved.provider} provider`)
        const leases = await tx.doc(WorkspaceJobs)
        const jobs = (await tx.doc(Jobs)).jobs
        const holder = jobs[leases[saved.id]!]
        if (holder && active(holder) && holder.id !== delegation?.jobId) {
          throw new Error(`Sandbox is reserved by background task “${holder.title}”. Steer or cancel it before using this workspace.`)
        }
        if (delegation?.jobId) {
          if (jobs[delegation.jobId]?.status !== 'running') throw new Error('Background task is not running')
          leases[saved.id] = delegation.jobId
        } else delete leases[saved.id]
        return { ...saved }
      }, ctx)
      return workspaces.use({ ...workspace, scope: owner.kind }, ctx, env => tool.execute(args, { ...api, env }, ctx))
    }
  })
  return {
    close: workspaces.close,
    extension: defineExtension({
      name: 'sandbox',
      tools: [
        bind(createReadTool()),
        bind(createWriteTool()),
        bind(createEditTool()),
        bind(shell),
        bind(ImageTool),
        ...(provider.desktop ? [bind(DesktopTool)] : [])
      ],
      hooks: [
        hook(GenerationTask, {
          async beforeRequest(_request, api, ctx) {
            if (await api.memo('sandbox.grant', ctx)) return
            let grant: Grant
            try {
              const actors = await getRequestActors(api, getHarness(), api.conversationId, ctx, true)
              const accounts = [...new Map(actors.map(actor => [JSON.stringify(actor.account), actor.account])).values()]
              grant = { accounts }
            } catch (error) {
              ctx.abortSignal?.throwIfAborted()
              grant = { error: error instanceof Error ? error.message : String(error) }
            }
            await api.memo('sandbox.grant', grant, ctx)
          }
        })
      ],
      sections: [
        section('sandbox', () =>
          [
            'Use read, write, edit, and bash to work in an isolated sandbox. You cannot access the bot host or its credentials.',
            provider.instructions,
            ...(provider.desktop
              ? [
                  'For browser work, call sandbox_desktop with action view to start or reconnect and load the browser skill. Share its watch-only link by default. Use action control only for a user handoff. Browser access follows the same workspace ownership as shell and file access.'
                ]
              : []),
            "Verified private chats share the identity's personal workspace. Shared conversations have their own group-owned workspace: verified members collaborate on the same files and may steer work. Do not transfer private workspace contents into shared conversations.",
            'Snapshots expire after 365 days since last use for private identity workspaces, or 90 days for shared conversation workspaces. A snapshot_not_found error is terminal for the old sandbox filesystem, not a temporary outage. Call a sandbox tool again to recreate the sandbox and rebuild its setup. A private Drive survives independently and is reattached: inspect /data before reporting what was lost. Only files outside the Drive depend on the expired snapshot.',
            'Files persist across requests and restarts. Processes are temporary; do not rely on background services surviving. Use scheduled tasks for future work. Shell commands have a default 120-second timeout and a maximum of 600 seconds.',
            'Interrupted commands may have partially executed. Inspect their effects before retrying anything with side effects. Use read for text and view_image for sandbox screenshots or images. These tools do not upload files to chat.'
          ].join('\n')
        )
      ]
    })
  }
}
