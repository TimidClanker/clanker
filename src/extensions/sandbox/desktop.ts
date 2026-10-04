import { Type } from '@earendil-works/pi-ai'
import { defineTool } from '@earendil-works/pi-durable'
import type { SandboxEnv } from 'extensions/sandbox/providers'

export const DesktopTool = defineTool({
  name: 'sandbox_desktop',
  description:
    'Start or reconnect to the workspace browser desktop. Returns a watch-only link and the browser skill. Use control only when handing mouse/keyboard control to a user. Stop closes the desktop and revokes its links while preserving the workspace and browser profile.',
  parameters: Type.Object({ action: Type.Union([Type.Literal('view'), Type.Literal('control'), Type.Literal('stop')]) }),
  async execute({ action }, api, ctx) {
    const desktop = (api.env as SandboxEnv).desktop
    if (!desktop) throw new Error('This sandbox provider does not support a browser desktop')
    if (action === 'stop') {
      await desktop.stop(ctx)
      return { content: [{ type: 'text', text: 'Desktop stopped. Workspace files and the browser profile are preserved.' }] }
    }
    const url = await desktop.open(action === 'control', ctx)
    const skill = await Bun.file(`${import.meta.dir}/skills/browser/SKILL.md`).text()
    return { content: [{ type: 'text', text: `${JSON.stringify({ mode: action, url })}\n\n${skill}` }] }
  }
})
