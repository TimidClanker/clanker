import { Type } from '@earendil-works/pi-ai'
import { defineExtension, defineTool } from '@earendil-works/pi-durable'
import type { JobAccess } from 'extensions/jobs/task'
import type { StatusService } from 'status/service'
import { maxStatusBytes } from 'status/transport'

export function createStatus(service: StatusService, chat: Pick<JobAccess, 'privateIdentity' | 'checkScope'>) {
  return defineExtension({
    name: 'status',
    tools: [
      defineTool({
        callers: ['model'],
        name: 'get_operational_status',
        description:
          'Read runtime/build evidence and authorized job, schedule and workspace-reservation metadata. Linked private owners see their work; shared chats only see appropriately visible work here. No worker/report-only access. Bounded records, no raw errors/results, external probes, heartbeat/stuck detection, causal diagnosis or repairs. Missing history is unknown.',
        parameters: Type.Object({}, { additionalProperties: false }),
        replay: 'safe',
        outputLimits: { maxBytes: maxStatusBytes },
        execute: async (_args, api, ctx) => ({ output: [{ type: 'text', text: JSON.stringify(await service.model(api, chat, ctx)) }] })
      })
    ]
  })
}
