// This module deliberately imports no application, database, auth, provider or agent startup code.
import { maxStatusBytes, statusSocket } from 'status/transport'

export async function statusCli(args = process.argv.slice(2)) {
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error('Usage: clanker status [--json] (or bun run status [--json]); CLANKER_STATUS_SOCKET selects the local socket.')
    return 1
  }
  const signal = AbortSignal.timeout(3000)
  try {
    const response = await fetch('http://localhost/status', { unix: statusSocket(), signal, redirect: 'error' })
    if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('application/json')) throw new Error()
    const length = response.headers.get('content-length')
    if (length && (!/^\d+$/.test(length) || Number(length) > maxStatusBytes)) {
      await response.body.cancel()
      throw new Error()
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > maxStatusBytes) throw new Error()
        chunks.push(value)
      }
    } finally {
      await reader.cancel().catch(() => {})
    }
    const status = JSON.parse(Buffer.concat(chunks).toString())
    if (status?.schemaVersion !== 1 || !status.runtime || !status.evidence || !status.build) throw new Error()
    const available = status.evidence.status === 'available' && status.runtime.phase === 'ready' && status.scheduling === 'running'
    if (args[0] === '--json') console.log(JSON.stringify(status, null, 2))
    else {
      console.log(
        `Clanker: ${available ? 'ready (read evidence only)' : 'degraded / unknown'} | runtime ${status.runtime.phase}, epoch ${status.runtime.epoch}`
      )
      console.log(`Build: ${status.build.commit} | Bun ${status.build.bun} | Pi ${status.build.dependencies?.pi ?? 'unknown'}`)
      console.log(`Observed: ${status.observedAt} | read: ${status.evidence.readStartedAt} → ${status.evidence.readFinishedAt}`)
      console.log(`Evidence: ${status.evidence.status}${status.evidence.reason ? ` (${status.evidence.reason})` : ''}; storage not probed`)
      console.log(`Sandbox: ${status.sandbox?.configured ? 'configured' : 'not configured'}; availability unknown; cleanup history not recorded`)
      for (const event of status.runtime.recentEvents ?? []) console.log(`Runtime event: ${event.at} ${event.code}`)
      for (const name of ['jobs', 'schedules']) {
        const section = status[name]
        if (!section) continue
        console.log(`${name}${section.truncated ? ' (bounded, more records omitted)' : ''}: ${section.items.length}`)
        for (const item of section.items) {
          // JSON-escape operator-visible labels: never render embedded terminal controls.
          console.log(
            `  ${item.id} ${JSON.stringify(item.title)}: ${item.status}${item.phase ? ` / ${item.phase}` : ''}${item.nextAt ? `, next ${item.nextAt}` : ''}${item.reservesWorkspace ? ', reserves workspace' : ''}${item.waitingForCoordinator ? ', waiting for coordinator' : ''}${item.outcome ? `, outcome ${item.outcome}` : ''}${item.updatedAt ? `, last change ${item.updatedAt}` : ''}`
          )
        }
      }
      console.log('No heartbeat/stuck detection, causal diagnosis or full cleanup history. No repair actions performed.')
    }
    return available ? 0 : 2
  } catch {
    console.error('Clanker status unreachable or invalid (local socket; no application/database startup attempted).')
    return 1
  }
}

if (import.meta.main) process.exitCode = await statusCli()
